// Web payment routes: list of products/prices, create checkout session,
// open billing portal, and read the current user's entitlement.
import type { Express, Request } from "express";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { isPremium } from "./billing";

const TRIAL_DAYS = 14;

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

  // Active products + prices fetched live from Stripe (cached in-memory for
  // 60s). We only have one product so this is cheap; querying Stripe directly
  // avoids depending on the products table being backfilled.
  let productsCache: { at: number; data: any } | null = null;
  app.get("/api/stripe/products", async (_req, res) => {
    try {
      if (productsCache && Date.now() - productsCache.at < 60_000) {
        return res.json(productsCache.data);
      }
      const stripe = await getUncachableStripeClient();
      const productList = await stripe.products.list({ active: true, limit: 20 });
      const out: any[] = [];
      for (const p of productList.data) {
        const prices = await stripe.prices.list({ product: p.id, active: true, limit: 10 });
        out.push({
          id: p.id,
          name: p.name,
          description: p.description,
          metadata: p.metadata || {},
          prices: prices.data.map((pr) => ({
            id: pr.id,
            unitAmount: pr.unit_amount,
            currency: pr.currency,
            recurring: pr.recurring ? { interval: pr.recurring.interval } : null,
          })),
        });
      }
      const payload = { products: out };
      productsCache = { at: Date.now(), data: payload };
      res.json(payload);
    } catch (err: any) {
      console.error("[stripe] list products failed", err?.message || err);
      res.status(500).json({ error: "Failed to list products" });
    }
  });

  // Current user's entitlement snapshot (used by useEntitlement on the client).
  app.get("/api/billing/me", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) return res.status(404).json({ error: "User not found" });
    const trialEndsAt = u.createdAt ? new Date(new Date(u.createdAt).getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000) : null;
    const trialActive = !!trialEndsAt && trialEndsAt.getTime() > Date.now();
    const subscriptionActive = isPremium(u as any);
    res.json({
      premium: subscriptionActive || trialActive,
      premiumUntil: u.premiumUntil,
      premiumSource: u.premiumSource,
      trialActive,
      trialEndsAt,
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
