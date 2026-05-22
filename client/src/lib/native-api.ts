import { Capacitor } from "@capacitor/core";

export const NATIVE_API_ORIGIN =
  (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/, "") ||
  "https://stillhere.health";

const NATIVE_SESSION_KEY = "stillhere_native_session";

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
  try {
    return localStorage.getItem(NATIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

export function setNativeSessionToken(token: string | null | undefined): void {
  if (!isNativeApp()) return;
  try {
    if (token) {
      localStorage.setItem(NATIVE_SESSION_KEY, token);
    } else {
      localStorage.removeItem(NATIVE_SESSION_KEY);
    }
  } catch {}
}

export function nativeAuthLog(event: string, details: Record<string, unknown> = {}): void {
  if (!isNativeApp()) return;
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => !/code|token|session|cookie|phone/i.test(key)),
  );
  console.info(`[StillHere native auth] ${event}`, safeDetails);
}

function buildNativeInit(url: string, init?: RequestInit): RequestInit | undefined {
  if (!url.startsWith(NATIVE_API_ORIGIN)) return init;

  const headers = new Headers(init?.headers);
  headers.set("X-StillHere-Native", "1");

  const token = getNativeSessionToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return { ...init, headers };
}

export function installNativeFetchBridge(): void {
  if (!isNativeApp()) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      const url = toApiUrl(input);
      const response = await originalFetch(url, buildNativeInit(url, init));
      if (url.endsWith("/api/auth/logout") && response.ok) setNativeSessionToken(null);
      return response;
    }
    if (input instanceof URL) {
      const url = toApiUrl(input.toString());
      const response = await originalFetch(url, buildNativeInit(url, init));
      if (url.endsWith("/api/auth/logout") && response.ok) setNativeSessionToken(null);
      return response;
    }
    const url = toApiUrl(input.url);
    const response = await originalFetch(url, buildNativeInit(url, init));
    if (url.endsWith("/api/auth/logout") && response.ok) setNativeSessionToken(null);
    return response;
  }) as typeof window.fetch;
}
