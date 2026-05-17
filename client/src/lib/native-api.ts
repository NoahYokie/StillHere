import { Capacitor } from "@capacitor/core";

export const NATIVE_API_ORIGIN =
  (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/, "") ||
  "https://stillhere.health";

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function toApiUrl(input: string): string {
  if (!isNativeApp()) return input;
  if (input.startsWith("/api/") || input === "/api") return `${NATIVE_API_ORIGIN}${input}`;
  if (input.startsWith("/socket.io")) return `${NATIVE_API_ORIGIN}${input}`;
  return input;
}

export function installNativeFetchBridge(): void {
  if (!isNativeApp()) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      return originalFetch(toApiUrl(input), init);
    }
    if (input instanceof URL) {
      return originalFetch(toApiUrl(input.toString()), init);
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}
