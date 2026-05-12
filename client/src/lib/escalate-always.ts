/**
 * Phase 1.2 — Always Location escalation utility.
 *
 * Pure utility module. NO React, NO UI side effects. The visible modal/banner
 * is owned by `BackgroundLocationProvider`. This file only:
 *
 *   - Reads the current iOS location authorization level (always / when in use
 *     / denied / not determined) via the @transistorsoft BackgroundGeolocation
 *     plugin when running natively, with safe fallbacks for web.
 *   - Triggers the OS request for Always authorization.
 *   - Maintains local "we already asked" / "we already escalated" flags so we
 *     don't re-pester the user.
 *
 * No server-side authorization storage. Per-feature behavior decisions live
 * in the React hook, not here.
 */

export type AuthorizationLevel =
  | "always"
  | "when_in_use"
  | "denied"
  | "restricted"
  | "not_determined"
  | "unknown";

export type FeatureKey =
  | "drive"
  | "safe_walk"
  | "safety_timer"
  | "share_precise"
  | "share_area";

const ASKED_KEY = (f: FeatureKey) => `stillhere_always_asked_${f}`;
const ESCALATED_ANY_KEY = "stillhere_always_escalated_any";

function isNativePlatform(): boolean {
  try {
    const cap = (window as any).Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

async function loadBgPlugin(): Promise<any | null> {
  if (!isNativePlatform()) return null;
  try {
    const pluginId = "@transistorsoft/capacitor-background-geolocation";
    const mod = await import(/* @vite-ignore */ pluginId);
    return mod?.default || mod?.BackgroundGeolocation || mod;
  } catch {
    return null;
  }
}

/**
 * Returns the current iOS authorization level.
 *
 * Mapping (transistorsoft AUTHORIZATION_STATUS_*):
 *   0 NOT_DETERMINED, 1 RESTRICTED, 2 DENIED, 3 ALWAYS, 4 WHEN_IN_USE.
 *
 * On web or when the plugin is unavailable, falls back to navigator.permissions
 * for geolocation, which cannot distinguish Always vs WhenInUse so it returns
 * "when_in_use" when granted to keep the gate honest.
 */
export async function getAuthorizationLevel(): Promise<AuthorizationLevel> {
  const BG = await loadBgPlugin();
  if (BG?.getProviderState) {
    try {
      const state = await BG.getProviderState();
      switch (state?.status) {
        case 3: return "always";
        case 4: return "when_in_use";
        case 2: return "denied";
        case 1: return "restricted";
        case 0: return "not_determined";
        default: return "unknown";
      }
    } catch {}
  }

  try {
    if ("permissions" in navigator) {
      const result = await navigator.permissions.query({ name: "geolocation" as PermissionName });
      if (result.state === "granted") return "when_in_use";
      if (result.state === "denied") return "denied";
      return "not_determined";
    }
  } catch {}

  return "unknown";
}

/**
 * Trigger the OS request for the highest authorization (Always on iOS).
 *
 * Returns the authorization level after the user responds. iOS only allows
 * one prompt per install. If the user previously denied Always, this resolves
 * to whatever the system reports without re-prompting; the caller should then
 * route the user to Settings via the provider's modal.
 */
export async function requestAlways(): Promise<AuthorizationLevel> {
  const BG = await loadBgPlugin();
  if (BG?.requestPermission) {
    try {
      const status = await BG.requestPermission();
      switch (status) {
        case 3: return "always";
        case 4: return "when_in_use";
        case 2: return "denied";
        case 1: return "restricted";
        case 0: return "not_determined";
        default: return "unknown";
      }
    } catch {
      return await getAuthorizationLevel();
    }
  }

  try {
    if (navigator?.geolocation) {
      await new Promise<void>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve(),
          () => resolve(),
          { enableHighAccuracy: true, timeout: 8000 },
        );
      });
    }
  } catch {}

  return await getAuthorizationLevel();
}

export function markFeatureAsked(feature: FeatureKey): void {
  try { localStorage.setItem(ASKED_KEY(feature), String(Date.now())); } catch {}
  try { localStorage.setItem(ESCALATED_ANY_KEY, "1"); } catch {}
}

export function hasAskedForFeature(feature: FeatureKey): boolean {
  try { return !!localStorage.getItem(ASKED_KEY(feature)); } catch { return false; }
}

export function hasEverEscalated(): boolean {
  try { return !!localStorage.getItem(ESCALATED_ANY_KEY); } catch { return false; }
}

export function clearEscalationFlags(): void {
  const features: FeatureKey[] = ["drive", "safe_walk", "safety_timer", "share_precise", "share_area"];
  try {
    features.forEach((f) => localStorage.removeItem(ASKED_KEY(f)));
    localStorage.removeItem(ESCALATED_ANY_KEY);
  } catch {}
}

export function isAlwaysGranted(level: AuthorizationLevel): boolean {
  return level === "always";
}

export function isAtLeastWhenInUse(level: AuthorizationLevel): boolean {
  return level === "always" || level === "when_in_use";
}

/**
 * Subscribe to provider-state changes from the native plugin.
 * Fires when the user toggles authorization in iOS Settings while the app
 * is open or returns to the app after changing it.
 *
 * Returns an unsubscribe function. No-op on web.
 */
export async function subscribeProviderChange(
  fn: (level: AuthorizationLevel) => void,
): Promise<() => void> {
  const BG = await loadBgPlugin();
  if (!BG?.onProviderChange) return () => {};

  try {
    const sub = BG.onProviderChange(async () => {
      try {
        const level = await getAuthorizationLevel();
        fn(level);
      } catch {}
    });
    return () => {
      try { sub?.remove?.(); } catch {}
    };
  } catch {
    return () => {};
  }
}

export function featureLabel(feature: FeatureKey): string {
  switch (feature) {
    case "drive": return "Drive Safety";
    case "safe_walk": return "Safe Walk";
    case "safety_timer": return "Safety Timer";
    case "share_precise": return "Precise sharing";
    case "share_area": return "Area sharing";
  }
}
