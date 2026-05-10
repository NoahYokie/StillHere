/**
 * Client-side cache of the server's tracking policy decision.
 *
 * Source of truth lives on the server in `server/tracking-policy.ts`
 * (`getTrackingPolicyForUser`). This module is a thin cache that:
 *
 *   - Stores the most recent server-approved decision (with timestamp).
 *   - Tracks consecutive failed polls.
 *   - Exposes `isNativeTrackingAllowed()` and `isHeartbeatAllowed()` for
 *     other modules (live-location, heartbeat) to read without needing
 *     to make their own network calls.
 *
 * Grace rule (matches server agreement):
 *   - 5-minute max staleness OR 3 consecutive failed polls → fail closed.
 *   - 401/403 → fail closed immediately.
 *   - No cached approval → fail closed.
 */

const GRACE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILED_POLLS = 3;

export type CachedPolicy = {
  nativeTrackingAllowed: boolean;
  heartbeatAllowed: boolean;
  reason: string;
  graceWindowSeconds: number;
  cachedAt: number;
};

let cached: CachedPolicy | null = null;
let consecutiveFailures = 0;
let lastFlipFalseToTrue: number | null = null;

type Listener = (next: CachedPolicy | null) => void;
const listeners = new Set<Listener>();

export function subscribePolicy(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  listeners.forEach((fn) => {
    try { fn(cached); } catch {}
  });
}

function isFresh(p: CachedPolicy): boolean {
  return Date.now() - p.cachedAt <= GRACE_WINDOW_MS;
}

export function getCachedPolicy(): CachedPolicy | null {
  if (!cached) return null;
  if (!isFresh(cached)) return null;
  return cached;
}

export function isNativeTrackingAllowed(): boolean {
  const p = getCachedPolicy();
  return p?.nativeTrackingAllowed === true;
}

export function isHeartbeatAllowed(): boolean {
  const p = getCachedPolicy();
  // If no fresh cache, assume heartbeat OK so we keep the safety-state engine alive.
  // (Heartbeat without coords is already privacy-safe.)
  if (!p) return true;
  return p.heartbeatAllowed === true;
}

/**
 * Fetch and cache the latest policy from the server.
 *
 * Returns true if native tracking is currently allowed, false otherwise.
 * On 401/403, clears the cache and returns false (fail closed).
 * On network errors, increments the failure counter; if cache is fresh
 * AND we haven't exceeded MAX_FAILED_POLLS, returns the cached decision.
 */
export async function refreshPolicy(): Promise<CachedPolicy | null> {
  try {
    const res = await fetch("/api/live-location/status", { credentials: "include" });
    if (res.status === 401 || res.status === 403) {
      cached = null;
      consecutiveFailures = 0;
      notify();
      return null;
    }
    if (!res.ok) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILED_POLLS || !cached || !isFresh(cached)) {
        cached = null;
        notify();
      }
      return cached;
    }
    const data = await res.json();
    const next: CachedPolicy = {
      nativeTrackingAllowed: !!data.nativeTrackingAllowed,
      heartbeatAllowed: data.heartbeatAllowed !== false,
      reason: data.reason || "ok",
      graceWindowSeconds: typeof data.graceWindowSeconds === "number" ? data.graceWindowSeconds : 300,
      cachedAt: Date.now(),
    };
    const wasFalse = !cached?.nativeTrackingAllowed;
    if (wasFalse && next.nativeTrackingAllowed) {
      lastFlipFalseToTrue = Date.now();
    }
    cached = next;
    consecutiveFailures = 0;
    notify();
    return next;
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILED_POLLS || !cached || !isFresh(cached)) {
      cached = null;
      notify();
    }
    return cached;
  }
}

/**
 * Apply a policy decision pushed via Socket.IO (tracking-policy:changed).
 * The payload from the server is the lightweight version (no sessions),
 * which is enough for the client's allow/deny decision.
 */
export function applyPushedPolicy(payload: {
  nativeTrackingAllowed: boolean;
  heartbeatAllowed?: boolean;
  reason?: string;
}): CachedPolicy {
  const wasFalse = !cached?.nativeTrackingAllowed;
  const next: CachedPolicy = {
    nativeTrackingAllowed: !!payload.nativeTrackingAllowed,
    heartbeatAllowed: payload.heartbeatAllowed !== false,
    reason: payload.reason || "ok",
    graceWindowSeconds: cached?.graceWindowSeconds ?? 300,
    cachedAt: Date.now(),
  };
  if (wasFalse && next.nativeTrackingAllowed) {
    lastFlipFalseToTrue = Date.now();
  }
  cached = next;
  consecutiveFailures = 0;
  notify();
  return next;
}

export function clearCachedPolicy(): void {
  cached = null;
  consecutiveFailures = 0;
  lastFlipFalseToTrue = null;
  notify();
}

/**
 * Returns true if the policy just flipped from false→true within the last
 * `windowMs` milliseconds. Used by live-location.ts to decide whether to fire
 * the one-shot getCurrentPosition() mitigation.
 */
export function didJustFlipToAllowed(windowMs = 3000): boolean {
  if (!lastFlipFalseToTrue) return false;
  return Date.now() - lastFlipFalseToTrue <= windowMs;
}

export function consumeFlipMarker(): void {
  lastFlipFalseToTrue = null;
}
