// Server-side RevenueCat client. Used for occasional admin lookups against
// the RC v2 API (e.g. fetching the current entitlement state for a user).
// Day-to-day entitlement updates flow in via the /api/revenuecat/webhook.
// In production outside Replit, use REVENUECAT_SECRET_API_KEY. The Replit
// connector path remains as a fallback for legacy/dev deployments.
import { createClient } from "@replit/revenuecat-sdk/client";

let connectionSettings: any;

async function getApiKey(): Promise<string> {
  if (process.env.REVENUECAT_SECRET_API_KEY) {
    return process.env.REVENUECAT_SECRET_API_KEY;
  }

  if (
    connectionSettings?.settings?.expires_at &&
    new Date(connectionSettings.settings.expires_at).getTime() > Date.now() &&
    connectionSettings?.settings?.access_token
  ) {
    return connectionSettings.settings.access_token;
  }
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;
  if (!hostname) throw new Error("RevenueCat secret API key not configured");
  if (!xReplitToken) throw new Error("X-Replit-Token not found for repl/depl");

  connectionSettings = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=revenuecat`,
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } },
  )
    .then((r) => r.json())
    .then((d: any) => d.items?.[0]);

  const token =
    connectionSettings?.settings?.access_token ||
    connectionSettings?.settings?.oauth?.credentials?.access_token;
  if (!connectionSettings || !token) throw new Error("RevenueCat not connected");
  return token;
}

export async function getUncachableRevenueCatClient() {
  const apiKey = await getApiKey();
  return createClient({
    baseUrl: "https://api.revenuecat.com/v2",
    headers: { Authorization: "Bearer " + apiKey },
  });
}
