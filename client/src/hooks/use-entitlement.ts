import { useQuery } from "@tanstack/react-query";

export interface EntitlementSnapshot {
  premium: boolean;
  premiumUntil: string | null;
  premiumSource: "stripe" | "appstore" | "playstore" | "manual" | null;
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
    hasStripeSubscription: !!q.data?.hasStripeSubscription,
    isLoading: q.isLoading,
  };
}
