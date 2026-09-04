import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  getAuthorizationLevel,
  requestAlways,
  hasAskedForFeature,
  markFeatureAsked,
  isAlwaysGranted,
  isAtLeastWhenInUse,
  subscribeProviderChange,
  featureLabel,
  type AuthorizationLevel,
  type FeatureKey,
} from "@/lib/escalate-always";
import {
  BACKGROUND_LOCATION_UNLICENSED_MESSAGE,
  isNativeBackgroundLocationLicensed,
  setNativeBackgroundAllowed,
} from "@/lib/location-service";
import { BackgroundLocationSheet } from "./background-location-sheet";
import { BackgroundLocationWarningBanner } from "./background-location-warning-banner";

export type EscalationOutcome = {
  level: AuthorizationLevel;
  granted: boolean;          // user got "always"
  degraded: boolean;         // only "when_in_use"
  blocked: boolean;          // "denied" or "restricted"
  dismissed: boolean;        // user tapped Not now without prompting
  unlicensed?: boolean;      // native background plugin disabled for this build
};

export type BackgroundLocationContextValue = {
  authorizationLevel: AuthorizationLevel;
  refresh: () => Promise<AuthorizationLevel>;
  /**
   * Show the pre-permission sheet for `feature`, then trigger the OS prompt
   * if the user taps Continue. Resolves with the resulting outcome.
   *
   * SAFETY GUARANTEE: this never blocks. Callers decide what to do based on
   * the returned outcome. SOS, missed check-in, and Safety Timer must NOT
   * call this in a way that blocks their primary action.
   */
  requestAlwaysForFeature: (feature: FeatureKey) => Promise<EscalationOutcome>;
  /**
   * Show a persistent degraded-mode warning banner. Pass null to clear.
   * The provider tracks at most one active banner.
   */
  setActiveWarning: (warning: { feature: FeatureKey; message: string } | null) => void;
  /**
   * Open the OS Settings app so the user can switch to Always.
   */
  openSettings: () => Promise<void>;
};

const Ctx = createContext<BackgroundLocationContextValue | null>(null);

type PendingResolver = (outcome: EscalationOutcome) => void;

async function openAppSettings(): Promise<void> {
  try {
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      try {
        const mod: any = await import(/* @vite-ignore */ "@capacitor/app");
        if (mod?.App?.openUrl) {
          await mod.App.openUrl({ url: "app-settings:" });
          return;
        }
      } catch {}
      try {
        const bgMod: any = await import(/* @vite-ignore */ "@transistorsoft/capacitor-background-geolocation");
        const BG = bgMod?.default || bgMod?.BackgroundGeolocation;
        if (BG?.openSettings) {
          await BG.openSettings();
          return;
        }
      } catch {}
    }
  } catch {}
}

export function BackgroundLocationProvider({ children }: { children: React.ReactNode }) {
  const [authLevel, setAuthLevel] = useState<AuthorizationLevel>("unknown");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetFeature, setSheetFeature] = useState<FeatureKey | null>(null);
  const [primaryAction, setPrimaryAction] = useState<"continue" | "open_settings">("continue");
  const [warning, setWarning] = useState<{ feature: FeatureKey; message: string } | null>(null);
  const pendingRef = useRef<PendingResolver | null>(null);

  const refresh = useCallback(async (): Promise<AuthorizationLevel> => {
    const level = await getAuthorizationLevel();
    setAuthLevel(level);
    // Mirror the always-grant into the LocationService gate so any subsequent
    // startWatch is allowed to use native background mode.
    setNativeBackgroundAllowed(isNativeBackgroundLocationLicensed() && isAlwaysGranted(level));
    return level;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for OS-level provider changes (user toggled in iOS Settings) and
  // re-sync the gate. This is the recommended subscription Codex requested.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    subscribeProviderChange((level) => {
      if (cancelled) return;
      setAuthLevel(level);
      setNativeBackgroundAllowed(isNativeBackgroundLocationLicensed() && isAlwaysGranted(level));
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // Re-check on tab visibility change.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [refresh]);

  const finishOutcome = useCallback((level: AuthorizationLevel, dismissed: boolean) => {
    const outcome: EscalationOutcome = {
      level,
      granted: isAlwaysGranted(level),
      degraded: !isAlwaysGranted(level) && isAtLeastWhenInUse(level),
      blocked: level === "denied" || level === "restricted",
      dismissed,
    };
    setNativeBackgroundAllowed(isNativeBackgroundLocationLicensed() && outcome.granted);
    const r = pendingRef.current;
    pendingRef.current = null;
    setSheetOpen(false);
    setSheetFeature(null);
    if (r) r(outcome);
  }, []);

  const handleContinue = useCallback(async () => {
    if (sheetFeature) markFeatureAsked(sheetFeature);
    const level = await requestAlways();
    setAuthLevel(level);
    finishOutcome(level, false);
  }, [sheetFeature, finishOutcome]);

  const handleOpenSettings = useCallback(async () => {
    if (sheetFeature) markFeatureAsked(sheetFeature);
    await openAppSettings();
    // We don't know the new level yet; report what we currently have. The
    // visibility-change handler will refresh once the user returns.
    finishOutcome(authLevel, false);
  }, [sheetFeature, authLevel, finishOutcome]);

  const handleDismiss = useCallback(() => {
    finishOutcome(authLevel, true);
  }, [authLevel, finishOutcome]);

  const requestAlwaysForFeature = useCallback(
    async (feature: FeatureKey): Promise<EscalationOutcome> => {
      const level = await getAuthorizationLevel();
      setAuthLevel(level);

      if (!isNativeBackgroundLocationLicensed()) {
        setNativeBackgroundAllowed(false);
        setWarning({ feature, message: BACKGROUND_LOCATION_UNLICENSED_MESSAGE });
        return {
          level,
          granted: false,
          degraded: isAtLeastWhenInUse(level),
          blocked: false,
          dismissed: false,
          unlicensed: true,
        };
      }

      // Already Always — nothing to do.
      if (isAlwaysGranted(level)) {
        setNativeBackgroundAllowed(true);
        return { level, granted: true, degraded: false, blocked: false, dismissed: false };
      }

      // Restricted means a parental control or MDM blocks it. Cannot escalate.
      if (level === "restricted") {
        return { level, granted: false, degraded: false, blocked: true, dismissed: false };
      }

      // If we've previously been denied at the OS level, the iOS prompt
      // won't show again; the only path is Open Settings.
      const previouslyAsked = hasAskedForFeature(feature);
      const action: "continue" | "open_settings" =
        level === "denied" || (previouslyAsked && level === "when_in_use")
          ? "open_settings"
          : "continue";

      // Sequential resolver: if a sheet is already open, reject the new ask
      // immediately rather than queueing (avoids modal stacking).
      if (sheetOpen) {
        return { level, granted: false, degraded: isAtLeastWhenInUse(level), blocked: false, dismissed: true };
      }

      return new Promise<EscalationOutcome>((resolve) => {
        pendingRef.current = resolve;
        setSheetFeature(feature);
        setPrimaryAction(action);
        setSheetOpen(true);
      });
    },
    [sheetOpen],
  );

  const value = useMemo<BackgroundLocationContextValue>(
    () => ({
      authorizationLevel: authLevel,
      refresh,
      requestAlwaysForFeature,
      setActiveWarning: setWarning,
      openSettings: openAppSettings,
    }),
    [authLevel, refresh, requestAlwaysForFeature],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <BackgroundLocationWarningBanner
        visible={!!warning}
        message={warning?.message || ""}
        onUpgrade={async () => {
          if (warning) await requestAlwaysForFeature(warning.feature);
        }}
        onDismiss={() => setWarning(null)}
      />
      <BackgroundLocationSheet
        open={sheetOpen}
        feature={sheetFeature}
        primaryAction={primaryAction}
        onContinue={handleContinue}
        onOpenSettings={handleOpenSettings}
        onDismiss={handleDismiss}
      />
    </Ctx.Provider>
  );
}

export function useBackgroundLocationEscalation(): BackgroundLocationContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Render-safe fallback so consumers never crash if the provider is missing.
    // Returns a permissive shape that resolves immediately and does nothing,
    // which means feature pages still allow start (we never block safety).
    return {
      authorizationLevel: "unknown",
      refresh: async () => "unknown",
      requestAlwaysForFeature: async () => ({
        level: "unknown",
        granted: false,
        degraded: false,
        blocked: false,
        dismissed: true,
      }),
      setActiveWarning: () => {},
      openSettings: async () => {},
    };
  }
  return ctx;
}

export const __test = { featureLabel };
