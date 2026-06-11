import { useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield, Check, Sparkles } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useEntitlement } from "@/hooks/use-entitlement";
import {
  isNativePlatform,
  fetchNativeOfferings,
  purchaseNativePackage,
  restoreNativePurchases,
  type NativeOffering,
} from "@/lib/revenuecat";
import { useState } from "react";

interface Price { id: string; unitAmount: number; currency: string; recurring: { interval: string } | null }
interface Product { id: string; name: string; description: string | null; prices: Price[] }

const FEATURES = [
  "Unlimited Safety Circle contacts",
  "Live location sharing & geofencing",
  "Possible crash alerts & fall sensing with auto-SOS",
  "Watcher dashboard & weekly Safety Record",
  "Family Mode group chat & places",
  "Wellness call + SMS check-in",
];

function formatPrice(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

export default function BillingPage() {
  const { toast } = useToast();
  const { isPremium, premiumUntil, source, hasStripeSubscription, isLoading: entLoading } = useEntitlement();

  const onNative = isNativePlatform();

  const productsQuery = useQuery<{ products: Product[] }>({
    queryKey: ["/api/stripe/products"],
    enabled: !onNative,
  });

  const nativeOfferingsQuery = useQuery<NativeOffering | null>({
    queryKey: ["revenuecat-offerings"],
    queryFn: () => fetchNativeOfferings(),
    enabled: onNative,
    staleTime: 60_000,
  });
  const [nativeBusy, setNativeBusy] = useState(false);

  async function buyNative(packageId: string) {
    setNativeBusy(true);
    try {
      const ok = await purchaseNativePackage(packageId);
      if (ok) {
        toast({ title: "Subscription active", description: "Welcome to StillHere Premium." });
        queryClient.invalidateQueries({ queryKey: ["/api/billing/me"] });
      }
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (!msg.toLowerCase().includes("cancel")) {
        toast({ title: "Purchase failed", description: msg || "Please try again.", variant: "destructive" });
      }
    } finally {
      setNativeBusy(false);
    }
  }

  async function restoreNative() {
    setNativeBusy(true);
    try {
      const ok = await restoreNativePurchases();
      toast({ title: ok ? "Purchases restored" : "Nothing to restore", description: ok ? "Premium is active again." : "We didn't find any active subscriptions." });
      queryClient.invalidateQueries({ queryKey: ["/api/billing/me"] });
    } catch (err: any) {
      toast({ title: "Restore failed", description: String(err?.message || ""), variant: "destructive" });
    } finally {
      setNativeBusy(false);
    }
  }

  // After returning from Stripe Checkout we may land here with ?status=success.
  // Refresh entitlement so the UI flips to "active" without a hard reload.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (status === "success") {
      toast({ title: "Subscription active", description: "Welcome to StillHere Premium." });
      queryClient.invalidateQueries({ queryKey: ["/api/billing/me"] });
    } else if (status === "cancelled") {
      toast({ title: "Checkout cancelled", description: "No charge was made." });
    }
  }, [toast]);

  const checkoutMutation = useMutation({
    mutationFn: async (priceId: string) => {
      const res = await apiRequest("POST", "/api/stripe/checkout", { priceId });
      return (await res.json()) as { url: string };
    },
    onSuccess: ({ url }) => { if (url) window.location.href = url; },
    onError: () => toast({ title: "Could not start checkout", variant: "destructive" }),
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/stripe/portal", {});
      return (await res.json()) as { url: string };
    },
    onSuccess: ({ url }) => { if (url) window.location.href = url; },
    onError: () => toast({ title: "Could not open billing portal", variant: "destructive" }),
  });

  const product = productsQuery.data?.products?.[0];
  const monthlyPrice = useMemo(() => product?.prices.find((p) => p.recurring?.interval === "month"), [product]);
  const yearlyPrice = useMemo(() => product?.prices.find((p) => p.recurring?.interval === "year"), [product]);
  const backTo = typeof window !== "undefined" && sessionStorage.getItem("stillhere:previousRoute")?.startsWith("/settings")
    ? "/settings"
    : "/";

  return (
    <div className="min-h-screen bg-background pb-12">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-2">
          <BackButton to={backTo} />
          <h1 className="text-base font-semibold">Subscription</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-6 space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex w-14 h-14 rounded-full bg-primary/10 items-center justify-center">
            <Shield className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-2xl font-bold">StillHere Premium</h2>
          <p className="text-sm text-muted-foreground">
            Keep the people you love in your safety loop.
          </p>
        </div>

        {entLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : isPremium ? (
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Badge className="bg-primary text-primary-foreground">Active</Badge>
                  <span className="text-sm font-medium" data-testid="text-billing-source">
                    via {source === "stripe" ? "Card" : source === "appstore" ? "App Store" : source === "playstore" ? "Google Play" : "Manual"}
                  </span>
                </div>
                {premiumUntil && (
                  <p className="text-xs text-muted-foreground mt-1" data-testid="text-billing-renewal">
                    Renews {premiumUntil.toLocaleDateString()}
                  </p>
                )}
              </div>
              {hasStripeSubscription && (
                <Button
                  variant="outline"
                  onClick={() => portalMutation.mutate()}
                  disabled={portalMutation.isPending}
                  data-testid="button-manage-subscription"
                >
                  Manage
                </Button>
              )}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" /> What you get
            </h3>
            <ul className="space-y-1.5">
              {FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm">
                  <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {onNative ? (
          nativeOfferingsQuery.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
          ) : !nativeOfferingsQuery.data ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">
              In-app purchases aren't ready yet. Make sure your products are configured in RevenueCat and try again.
            </CardContent></Card>
          ) : (
            <div className="grid gap-3">
              {nativeOfferingsQuery.data.monthly && (
                <PlanCard
                  title="Monthly"
                  priceLabel={`${nativeOfferingsQuery.data.monthly.priceString} / month`}
                  helper="Billed every month, cancel anytime."
                  disabled={isPremium || nativeBusy}
                  onSelect={() => buyNative(nativeOfferingsQuery.data!.monthly!.identifier)}
                  testId="button-buy-monthly"
                />
              )}
              {nativeOfferingsQuery.data.yearly && (
                <PlanCard
                  title="Yearly"
                  priceLabel={`${nativeOfferingsQuery.data.yearly.priceString} / year`}
                  helper="Best value."
                  badge="Best value"
                  disabled={isPremium || nativeBusy}
                  onSelect={() => buyNative(nativeOfferingsQuery.data!.yearly!.identifier)}
                  testId="button-buy-yearly"
                />
              )}
              <Button variant="ghost" size="sm" onClick={restoreNative} disabled={nativeBusy} data-testid="button-restore-purchases">
                Restore purchases
              </Button>
            </div>
          )
        ) : productsQuery.isLoading ? (
          <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        ) : !product ? (
          <Card><CardContent className="p-4 text-sm text-muted-foreground">
            Plans are still loading from Stripe. If this persists, the products may not be seeded yet.
          </CardContent></Card>
        ) : (
          <div className="grid gap-3">
            {monthlyPrice && (
              <PlanCard
                title="Monthly"
                priceLabel={`${formatPrice(monthlyPrice.unitAmount, monthlyPrice.currency)} / month`}
                helper="Billed every month, cancel anytime."
                disabled={isPremium || checkoutMutation.isPending}
                onSelect={() => checkoutMutation.mutate(monthlyPrice.id)}
                testId="button-buy-monthly"
              />
            )}
            {yearlyPrice && (
              <PlanCard
                title="Yearly"
                priceLabel={`${formatPrice(yearlyPrice.unitAmount, yearlyPrice.currency)} / year`}
                helper="Best value. The equivalent of $5/mo."
                badge="Best value"
                disabled={isPremium || checkoutMutation.isPending}
                onSelect={() => checkoutMutation.mutate(yearlyPrice.id)}
                testId="button-buy-yearly"
              />
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground text-center pt-2 px-4 leading-relaxed">
          On the website, billing is handled by Stripe. Inside the iOS and Android apps, purchases go through Apple or Google as required by their store rules. In every case the same Premium features unlock for your account.
        </p>
      </main>
    </div>
  );
}

function PlanCard(props: {
  title: string; priceLabel: string; helper: string; badge?: string;
  disabled?: boolean; onSelect: () => void; testId: string;
}) {
  return (
    <Card className="hover-elevate active-elevate-2 transition">
      <CardContent className="p-4 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{props.title}</span>
            {props.badge && <Badge variant="secondary" className="text-[10px]">{props.badge}</Badge>}
          </div>
          <p className="text-lg font-bold mt-0.5" data-testid={`text-price-${props.title.toLowerCase()}`}>{props.priceLabel}</p>
          <p className="text-xs text-muted-foreground">{props.helper}</p>
        </div>
        <Button onClick={props.onSelect} disabled={props.disabled} data-testid={props.testId}>
          {props.disabled ? "Active" : "Subscribe"}
        </Button>
      </CardContent>
    </Card>
  );
}
