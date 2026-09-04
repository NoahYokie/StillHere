// Canonical product / entitlement / offering identifiers shared across web,
// iOS and Android. These MUST match exactly what you set up in:
//   • App Store Connect (in-app purchases)
//   • Google Play Console (subscriptions)
//   • RevenueCat dashboard (products, entitlements, offerings, packages)
//   • Stripe (price ids are dynamic; product is "StillHere Premium")

export const PREMIUM_ENTITLEMENT_ID = "premium";

// RevenueCat offering identifier. Use a single "default" offering with both
// packages in it so the mobile client can ship without needing to know
// experiment/offering names ahead of time.
export const PREMIUM_OFFERING_ID = "default";

// Store-side product identifiers. Keep them identical on Apple and Google
// so RevenueCat's cross-platform mapping is one-to-one.
export const PRODUCT_ID_MONTHLY = "stillhere_premium_monthly";
export const PRODUCT_ID_YEARLY  = "stillhere_premium_yearly";

// Pricing (USD cents). Used by the Stripe seed script and shown to users on
// the web paywall. Apple/Google prices are set per-region in their consoles.
export const PRICE_MONTHLY_CENTS = 799;   // $7.99 / month
export const PRICE_YEARLY_CENTS  = 5999;  // $59.99 / year
