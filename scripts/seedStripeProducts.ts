// One-shot script to create the StillHere Premium product + monthly/yearly
// prices in Stripe. Idempotent: skips if a product with the same name exists.
//
// Run with:  npx tsx scripts/seedStripeProducts.ts
import { getUncachableStripeClient } from "../server/stripeClient";

const PRODUCT_NAME = "StillHere Premium";
const PRODUCT_DESCRIPTION = "Full StillHere safety monitoring with unlimited contacts, live location, and 24/7 alerts.";
const MONTHLY_AMOUNT = 799;   // $7.99
const YEARLY_AMOUNT = 5999;   // $59.99

async function main() {
  const stripe = await getUncachableStripeClient();

  let product;
  const search = await stripe.products.search({ query: `name:'${PRODUCT_NAME}' AND active:'true'` });
  if (search.data.length > 0) {
    product = search.data[0];
    console.log(`Reusing existing product ${product.id}`);
  } else {
    product = await stripe.products.create({
      name: PRODUCT_NAME,
      description: PRODUCT_DESCRIPTION,
      metadata: { app: "stillhere", tier: "premium" },
    });
    console.log(`Created product ${product.id}`);
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 20 });
  const hasMonthly = prices.data.some((p) => p.recurring?.interval === "month" && p.unit_amount === MONTHLY_AMOUNT);
  const hasYearly = prices.data.some((p) => p.recurring?.interval === "year" && p.unit_amount === YEARLY_AMOUNT);

  if (!hasMonthly) {
    const m = await stripe.prices.create({
      product: product.id,
      unit_amount: MONTHLY_AMOUNT,
      currency: "usd",
      recurring: { interval: "month" },
      nickname: "Monthly",
    });
    console.log(`Created monthly price ${m.id} ($${MONTHLY_AMOUNT / 100}/mo)`);
  } else {
    console.log("Monthly price already exists - skipping");
  }

  if (!hasYearly) {
    const y = await stripe.prices.create({
      product: product.id,
      unit_amount: YEARLY_AMOUNT,
      currency: "usd",
      recurring: { interval: "year" },
      nickname: "Yearly",
    });
    console.log(`Created yearly price ${y.id} ($${YEARLY_AMOUNT / 100}/yr)`);
  } else {
    console.log("Yearly price already exists - skipping");
  }

  console.log("Done. The Stripe webhook will sync these into stripe.products / stripe.prices automatically.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
