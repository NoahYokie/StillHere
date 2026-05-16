import { useQuery } from "@tanstack/react-query";

export interface EntitlementSnapshot {
  premium: boolean;
  premiumUntil: string | null;
  premiumSource: "stripe" | "appstore" | "playstore" | "manual" | null;
  trialActive?: boolean;
  trialEndsAt?: string | null;
  hasStripeSubscription: boolean;
}

// Single source of truth on the client for "is this user paying". Reads
// `users.premiumUntil` from /api/billing/me, which is fed by Stripe webhooks
// (web) and RevenueCat webhooks (iOS/Android) on the server.
export function useEntitlement() {
  const q = useQuery<EntitlementSnapshot>({
    queryKey: ["/api/billing/me"],
    staleTime: 30_000,
  });
  return {
    isPremium: !!q.data?.premium,
    premiumUntil: q.data?.premiumUntil ? new Date(q.data.premiumUntil) : null,
    source: q.data?.premiumSource || null,
    trialActive: !!q.data?.trialActive,
    trialEndsAt: q.data?.trialEndsAt ? new Date(q.data.trialEndsAt) : null,
    hasStripeSubscription: !!q.data?.hasStripeSubscription,
    isLoading: q.isLoading,
  };
}
