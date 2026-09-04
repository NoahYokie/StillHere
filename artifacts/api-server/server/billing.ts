// Server-side billing helpers. Maps Stripe subscription state and RevenueCat
// webhook events into a single `users.premiumUntil` field that the rest of
// the app uses as the source of truth for "is this user a paying customer".
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getUncachableStripeClient } from "./stripeClient";

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function setPremiumUntil(
  userId: string,
  premiumUntil: Date | null,
  source: "stripe" | "appstore" | "playstore" | "manual" | null,
  extra?: { stripeCustomerId?: string | null; stripeSubscriptionId?: string | null },
) {
  const patch: any = { premiumUntil, premiumSource: source };
  if (extra?.stripeCustomerId !== undefined) patch.stripeCustomerId = extra.stripeCustomerId;
  if (extra?.stripeSubscriptionId !== undefined) patch.stripeSubscriptionId = extra.stripeSubscriptionId;
  await db.update(users).set(patch).where(eq(users.id, userId));
}

// Reflect a Stripe webhook (raw body Buffer) into our user table. We only
// care about subscription lifecycle and the initial checkout completion;
// everything else stripe-replit-sync already mirrors into the stripe.* schema.
export async function reconcileEntitlementFromWebhook(payload: Buffer): Promise<void> {
  let event: any;
  try { event = JSON.parse(payload.toString("utf8")); } catch { return; }
  const type: string = event?.type || "";
  if (!type.startsWith("customer.subscription.") && type !== "checkout.session.completed") return;

  const stripe = await getUncachableStripeClient();

  if (type === "checkout.session.completed") {
    const session = event.data?.object;
    const customerId = session?.customer as string | undefined;
    const subscriptionId = session?.subscription as string | undefined;
    const userId = session?.metadata?.userId as string | undefined;
    if (!userId || !customerId) return;
    let until: Date | null = null;
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      until = subscriptionEndDate(sub);
    }
    await setPremiumUntil(userId, until, "stripe", {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId || null,
    });
    return;
  }

  // customer.subscription.{created,updated,deleted}
  const sub = event.data?.object;
  if (!sub) return;
  const customerId = sub.customer as string;
  // Look up the user by stripe_customer_id; fall back to subscription metadata.userId.
  let userId: string | undefined = sub.metadata?.userId;
  if (!userId) {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.stripeCustomerId, customerId)).limit(1);
    userId = rows[0]?.id;
  }
  if (!userId) return;

  const status = sub.status as string;
  const until = ACTIVE_STATUSES.has(status) ? subscriptionEndDate(sub) : null;
  await setPremiumUntil(userId, until, "stripe", {
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
  });
}

function subscriptionEndDate(sub: any): Date | null {
  const cpe = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  if (typeof cpe !== "number") return null;
  return new Date(cpe * 1000);
}

export function isPremium(user: { premiumUntil: Date | null } | null | undefined): boolean {
  if (!user?.premiumUntil) return false;
  return new Date(user.premiumUntil).getTime() > Date.now();
}
