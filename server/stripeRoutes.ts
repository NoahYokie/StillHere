// Web payment routes: list of products/prices, create checkout session,
// open billing portal, and read the current user's entitlement.
import type { Express, Request } from "express";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { isPremium } from "./billing";

function getUserId(req: Request): string | undefined {
  return (req as any).user?.id || (req as any).userId;
}

export function registerStripeRoutes(app: Express) {
  // Public Stripe publishable key (safe to expose).
  app.get("/api/stripe/config", async (_req, res) => {
    try {
      const publishableKey = await getStripePublishableKey();
      res.json({ publishableKey });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Stripe not configured" });
    }
  });

  // Active products + prices (synced from Stripe by stripe-replit-sync).
  app.get("/api/stripe/products", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          p.id            AS product_id,
          p.name          AS product_name,
          p.description   AS product_description,
          p.metadata      AS product_metadata,
          pr.id           AS price_id,
          pr.unit_amount  AS unit_amount,
          pr.currency     AS currency,
          pr.recurring    AS recurring
        FROM stripe.products p
        LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
        WHERE p.active = true
        ORDER BY p.id, pr.unit_amount
      `);
      const map = new Map<string, any>();
      for (const row of result.rows as any[]) {
        if (!map.has(row.product_id)) {
          map.set(row.product_id, {
            id: row.product_id,
            name: row.product_name,
            description: row.product_description,
            metadata: row.product_metadata || {},
            prices: [],
          });
        }
        if (row.price_id) {
          map.get(row.product_id).prices.push({
            id: row.price_id,
            unitAmount: Number(row.unit_amount),
            currency: row.currency,
            recurring: row.recurring,
          });
        }
      }
      res.json({ products: Array.from(map.values()) });
    } catch (err: any) {
      console.error("[stripe] list products failed", err);
      res.status(500).json({ error: "Failed to list products" });
    }
  });

  // Current user's entitlement snapshot (used by useEntitlement on the client).
  app.get("/api/billing/me", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) return res.status(404).json({ error: "User not found" });
    res.json({
      premium: isPremium(u as any),
      premiumUntil: u.premiumUntil,
      premiumSource: u.premiumSource,
      hasStripeSubscription: !!u.stripeSubscriptionId,
    });
  });

  // Begin Stripe Checkout for a given priceId.
  app.post("/api/stripe/checkout", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const priceId = (req.body?.priceId || "").toString();
      if (!priceId.startsWith("price_")) return res.status(400).json({ error: "Invalid priceId" });

      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u) return res.status(404).json({ error: "User not found" });

      const stripe = await getUncachableStripeClient();
      let customerId = u.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          metadata: { userId },
          name: u.name || undefined,
          phone: u.phone || undefined,
        });
        customerId = customer.id;
        await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));
      }

      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
      const host = req.get("host");
      const origin = `${proto}://${host}`;

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/billing?status=success`,
        cancel_url: `${origin}/billing?status=cancelled`,
        client_reference_id: userId,
        metadata: { userId },
        subscription_data: { metadata: { userId } },
        allow_promotion_codes: true,
      });

      res.json({ url: session.url });
    } catch (err: any) {
      console.error("[stripe] checkout failed", err?.message || err);
      res.status(500).json({ error: "Could not start checkout" });
    }
  });

  // Open the Stripe-hosted customer portal so users can cancel or change plan.
  app.post("/api/stripe/portal", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u?.stripeCustomerId) return res.status(400).json({ error: "No subscription on file" });

      const stripe = await getUncachableStripeClient();
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
      const host = req.get("host");
      const session = await stripe.billingPortal.sessions.create({
        customer: u.stripeCustomerId,
        return_url: `${proto}://${host}/billing`,
      });
      res.json({ url: session.url });
    } catch (err: any) {
      console.error("[stripe] portal failed", err?.message || err);
      res.status(500).json({ error: "Could not open billing portal" });
    }
  });
}
