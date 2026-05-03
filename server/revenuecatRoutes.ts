// RevenueCat routes:
//   POST /api/revenuecat/webhook   — RC server-to-server events; updates
//                                    users.premiumUntil for App Store / Play
//                                    Store purchases. Verified by shared
//                                    secret in Authorization header.
//   GET  /api/revenuecat/config    — Returns the public mobile API keys so
//                                    the Capacitor client can configure RC
//                                    without baking keys into the JS bundle.
import type { Express, Request } from "express";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { setPremiumUntil } from "./billing";

function getUserId(req: Request): string | undefined {
  return (req as any).user?.id || (req as any).userId;
}

// We never revoke on CANCELLATION alone (the user keeps access until the
// period ends) and we don't revoke on BILLING_ISSUE either (RevenueCat is
// still in its retry/grace window). Only EXPIRATION (paid period actually
// ended) and explicit refund/transfer events terminate access immediately.
const GRANTING_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "TRIAL_STARTED",
  "TRIAL_CONVERTED",
  "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_EXTENDED",
  "TEMPORARY_ENTITLEMENT_GRANT",
]);
const TERMINATING_EVENTS = new Set([
  "EXPIRATION",
  "REFUND",
  "SUBSCRIPTION_PAUSED",
  "TRANSFER",
]);
const ENTITLEMENT_ID = "premium";

function eventTouchesPremium(event: any): boolean {
  const ids: string[] | undefined = event?.entitlement_ids;
  if (Array.isArray(ids) && ids.length > 0) return ids.includes(ENTITLEMENT_ID);
  // Older RC events fall back to entitlement_id (singular) or no field at all.
  if (typeof event?.entitlement_id === "string") return event.entitlement_id === ENTITLEMENT_ID;
  return true; // no scope provided -> assume it's our only entitlement
}

export function registerRevenueCatRoutes(app: Express) {
  // Tell the mobile client which platform key to use. These keys are public-
  // safe (RC's "App Public API Keys") and platform-specific.
  app.get("/api/revenuecat/config", (_req, res) => {
    res.json({
      appleApiKey: process.env.REVENUECAT_APPLE_API_KEY || null,
      googleApiKey: process.env.REVENUECAT_GOOGLE_API_KEY || null,
      entitlementId: "premium",
    });
  });

  // RevenueCat -> our server. Configured in the RC dashboard with a shared
  // secret in the Authorization header (Settings -> Webhooks -> Authorization).
  app.post("/api/revenuecat/webhook", async (req, res) => {
    try {
      const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
      if (!expected) return res.status(503).json({ error: "Webhook not configured" });
      const auth = req.headers["authorization"];
      if (auth !== expected && auth !== `Bearer ${expected}`) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const event = req.body?.event;
      if (!event?.type) return res.status(400).json({ error: "Missing event" });

      const appUserId: string | undefined = event.app_user_id || event.original_app_user_id;
      if (!appUserId) return res.status(200).json({ ok: true, skipped: "no app_user_id" });

      // We use our internal user id as the RevenueCat app_user_id, so this
      // is a direct lookup. Anonymous RC ids ("$RCAnonymousID:…") are ignored.
      if (appUserId.startsWith("$RCAnonymousID")) {
        return res.status(200).json({ ok: true, skipped: "anonymous" });
      }
      const [u] = await db.select().from(users).where(eq(users.id, appUserId));
      if (!u) return res.status(200).json({ ok: true, skipped: "user not found" });

      if (!eventTouchesPremium(event)) {
        return res.json({ ok: true, skipped: "entitlement scope" });
      }

      const store = (event.store || "").toLowerCase();
      const source: "appstore" | "playstore" | null =
        store === "app_store" ? "appstore" : store === "play_store" ? "playstore" : null;

      // Idempotency / out-of-order protection: drop events older than the
      // current `premiumUntil` we already have. RC sends `event_timestamp_ms`
      // for the moment the event happened on their servers.
      const eventTs: number | null = typeof event.event_timestamp_ms === "number" ? event.event_timestamp_ms : null;
      const expirationMs: number | null = typeof event.expiration_at_ms === "number" ? event.expiration_at_ms : null;

      let premiumUntil: Date | null | undefined;
      if (TERMINATING_EVENTS.has(event.type)) {
        // Hard terminate: revoke now even if expiration was in the future.
        premiumUntil = null;
      } else if (GRANTING_EVENTS.has(event.type) && expirationMs !== null) {
        premiumUntil = new Date(expirationMs);
      } else if (expirationMs !== null) {
        // Unknown/intermediate event types (CANCELLATION, BILLING_ISSUE,
        // PRODUCT_CHANGE follow-ups, etc.) — trust expiration_at_ms so the
        // user keeps access for the period they already paid for.
        premiumUntil = new Date(expirationMs);
      }

      if (premiumUntil !== undefined) {
        const currentUntil = (u as any).premiumUntil ? new Date((u as any).premiumUntil).getTime() : 0;
        const newUntil = premiumUntil ? premiumUntil.getTime() : 0;
        // Skip if event is older than what we already have for this user, but
        // allow explicit terminations through (which carry no expiration).
        if (
          eventTs !== null &&
          currentUntil > 0 &&
          newUntil > 0 &&
          newUntil < currentUntil &&
          eventTs < currentUntil
        ) {
          return res.json({ ok: true, skipped: "stale event" });
        }
        await setPremiumUntil(appUserId, premiumUntil, source || (u as any).premiumSource || "appstore");
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[revenuecat] webhook error", err?.message || err);
      res.status(400).json({ error: "Webhook processing error" });
    }
  });

  // Mobile clients call this once per launch so the server can record the
  // user's RC app_user_id (always == users.id in our setup) and confirm the
  // mapping. We don't need a separate column — just acknowledge.
  app.post("/api/revenuecat/identify", (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    res.json({ appUserId: userId });
  });
}
