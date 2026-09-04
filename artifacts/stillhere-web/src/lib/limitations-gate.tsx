import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";

export const LIMITATIONS_ESCAPE_KEY = "limitations_escape_used_at";

// Routes that must NEVER be interrupted by the Limitations gate. Anything
// matching these prefixes (or exact paths) is treated as urgent and the
// redirect is suppressed.
const URGENT_PREFIXES = [
  "/limitations",
  "/login",
  "/setup",
  "/emergency/",
  "/e/",
  "/safe-walk",
  "/safety-timer",
  "/drive",
  "/drive-history",
  "/drive-report",
  "/satellite",
  "/safety-circle/drill",
  "/safety-circle/guardian-view",
  "/live-location",
  "/call/",
  "/chat/",
  "/inbox",
  "/report/",
  // Watcher/Guardian surfaces — incoming Safety Circle alert pages used by
  // contacts during an incident. Must never be interrupted by the gate.
  "/watched",
  "/family",
];

const URGENT_EXACT = new Set([
  "/",
]);

function isUrgentRoute(pathname: string): boolean {
  if (URGENT_EXACT.has(pathname)) {
    // The home route hosts the in-app SOS button and the active-incident
    // banner, so we never redirect away from "/" itself. The gate still
    // fires on every other calm-time screen.
    return true;
  }
  return URGENT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export function LimitationsGate() {
  const { auth, isLoading } = useAuth();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    if (!auth?.authenticated) return;
    if (auth?.needsSetup) return;
    if (auth?.acknowledgedLimitationsAt) return;
    if (auth?.hasActiveSafetyEvent) return;
    if (isUrgentRoute(location)) return;

    // Honour the SOS escape flag for this session so we do not bounce the
    // user back to /limitations while they handle their emergency.
    try {
      const escape = sessionStorage.getItem(LIMITATIONS_ESCAPE_KEY);
      if (escape) return;
    } catch {}

    setLocation("/limitations");
  }, [
    auth?.authenticated,
    auth?.needsSetup,
    auth?.acknowledgedLimitationsAt,
    auth?.hasActiveSafetyEvent,
    isLoading,
    location,
    setLocation,
  ]);

  return null;
}
