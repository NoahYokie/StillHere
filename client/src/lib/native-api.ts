import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

export const NATIVE_API_ORIGIN =
  (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/, "") ||
  "https://stillhere.health";

const NATIVE_SESSION_KEY = "stillhere_native_session";
let cachedNativeSessionToken: string | null = null;
let hydrationPromise: Promise<string | null> | null = null;

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

export function getNativeSessionToken(): string | null {
  if (!isNativeApp()) return null;
  if (cachedNativeSessionToken) return cachedNativeSessionToken;
  try {
    const token = localStorage.getItem(NATIVE_SESSION_KEY);
    cachedNativeSessionToken = token;
    return token;
  } catch {
    return null;
  }
}

export async function hydrateNativeSessionToken(): Promise<string | null> {
  if (!isNativeApp()) return null;
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const pref = await Preferences.get({ key: NATIVE_SESSION_KEY });
      if (pref.value) {
        cachedNativeSessionToken = pref.value;
        return pref.value;
      }
    } catch {}

    try {
      const legacyToken = localStorage.getItem(NATIVE_SESSION_KEY);
      if (legacyToken) {
        cachedNativeSessionToken = legacyToken;
        Preferences.set({ key: NATIVE_SESSION_KEY, value: legacyToken }).catch(() => {});
        return legacyToken;
      }
    } catch {}

    cachedNativeSessionToken = null;
    return null;
  })();
  return hydrationPromise;
}

export function setNativeSessionToken(token: string | null | undefined): void {
  if (!isNativeApp()) return;
  cachedNativeSessionToken = token || null;
  try {
    if (token) {
      localStorage.setItem(NATIVE_SESSION_KEY, token);
      Preferences.set({ key: NATIVE_SESSION_KEY, value: token }).catch(() => {});
    } else {
      localStorage.removeItem(NATIVE_SESSION_KEY);
      Preferences.remove({ key: NATIVE_SESSION_KEY }).catch(() => {});
    }
  } catch {}
}

export async function clearNativeSessionToken(): Promise<void> {
  if (!isNativeApp()) return;
  cachedNativeSessionToken = null;
  try { localStorage.removeItem(NATIVE_SESSION_KEY); } catch {}
  try { await Preferences.remove({ key: NATIVE_SESSION_KEY }); } catch {}
}

export function nativeAuthLog(event: string, details: Record<string, unknown> = {}): void {
  if (!isNativeApp()) return;
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => !/code|token|session|cookie|phone/i.test(key)),
  );
  console.info(`[StillHere native auth] ${event}`, safeDetails);
}

async function buildNativeInit(url: string, init?: RequestInit): Promise<RequestInit | undefined> {
  if (!url.startsWith(NATIVE_API_ORIGIN)) return init;

  const headers = new Headers(init?.headers);
  headers.set("X-StillHere-Native", "1");

  const token = getNativeSessionToken() || await hydrateNativeSessionToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return { ...init, headers };
}

export function installNativeFetchBridge(): void {
  if (!isNativeApp()) return;
  hydrateNativeSessionToken().catch(() => {});
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      const url = toApiUrl(input);
      const response = await originalFetch(url, await buildNativeInit(url, init));
      if (url.endsWith("/api/auth/logout") && response.ok) clearNativeSessionToken().catch(() => {});
      return response;
    }
    if (input instanceof URL) {
      const url = toApiUrl(input.toString());
      const response = await originalFetch(url, await buildNativeInit(url, init));
      if (url.endsWith("/api/auth/logout") && response.ok) clearNativeSessionToken().catch(() => {});
      return response;
    }
    const url = toApiUrl(input.url);
    const response = await originalFetch(url, await buildNativeInit(url, init));
    if (url.endsWith("/api/auth/logout") && response.ok) clearNativeSessionToken().catch(() => {});
    return response;
  }) as typeof window.fetch;
}
