// Capacitor RevenueCat helper. Only does work on native platforms. On web
// every function returns a no-op so the rest of the app can call them
// unconditionally.
import { Capacitor } from "@capacitor/core";

let configured = false;

interface Config {
  appleApiKey: string | null;
  googleApiKey: string | null;
  entitlementId: string;
}

async function loadConfig(): Promise<Config | null> {
  try {
    const r = await fetch("/api/revenuecat/config", { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()) as Config;
  } catch {
    return null;
  }
}

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export async function configureRevenueCat(userId: string): Promise<boolean> {
  if (!isNativePlatform() || configured) return configured;
  const cfg = await loadConfig();
  if (!cfg) return false;
  const platform = Capacitor.getPlatform();
  const apiKey = platform === "ios" ? cfg.appleApiKey : cfg.googleApiKey;
  if (!apiKey) return false;

  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  await Purchases.configure({ apiKey, appUserID: userId });
  configured = true;

  // Tell the server which app_user_id we're using (always == our user id).
  fetch("/api/revenuecat/identify", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});

  return true;
}

export interface NativeOffering {
  monthly: { identifier: string; priceString: string } | null;
  yearly:  { identifier: string; priceString: string } | null;
  rawPackages: any[];
}

export async function fetchNativeOfferings(): Promise<NativeOffering | null> {
  if (!isNativePlatform() || !configured) return null;
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  const offerings = await Purchases.getOfferings();
  const current: any = offerings?.current;
  if (!current) return null;
  const monthly = current.monthly
    ? { identifier: current.monthly.identifier, priceString: current.monthly.product?.priceString || "" }
    : null;
  const yearly = current.annual
    ? { identifier: current.annual.identifier, priceString: current.annual.product?.priceString || "" }
    : null;
  return { monthly, yearly, rawPackages: current.availablePackages || [] };
}

export async function purchaseNativePackage(packageIdentifier: string): Promise<boolean> {
  if (!isNativePlatform() || !configured) return false;
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  const offerings = await Purchases.getOfferings();
  const current: any = offerings?.current;
  const pkg = current?.availablePackages?.find((p: any) => p.identifier === packageIdentifier);
  if (!pkg) throw new Error("Package not available");
  const result = await Purchases.purchasePackage({ aPackage: pkg });
  const ent = (result as any)?.customerInfo?.entitlements?.active?.premium;
  return !!ent;
}

export async function restoreNativePurchases(): Promise<boolean> {
  if (!isNativePlatform() || !configured) return false;
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  const info = await Purchases.restorePurchases();
  return !!(info as any)?.customerInfo?.entitlements?.active?.premium;
}
