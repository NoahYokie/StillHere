# Council Report: Task 1 — Single Source of Truth Location Refactor

**Status:** COMPLETE
**Date:** April 12, 2026
**Build:** Compiles cleanly, no errors

---

## What Was Done

### 1. Which GPS watcher was removed

**REMOVED:** The standalone `navigator.geolocation.watchPosition` in `live-location.tsx` (the page component). This was the second, competing GPS stream that created a separate set of state variables (`myGpsLat`, `myGpsLng`, `myGpsAccuracy`) that fought with the tracking module's position data.

**REMOVED:** The `navigator.geolocation.watchPosition` inside `live-location.ts` (the tracking module). The functions `restartGpsWatch()` and `startGpsWatch()` which directly called `navigator.geolocation.watchPosition` were replaced with `startGpsSubscription()` which subscribes to the central location service.

**KEPT:** ONE single GPS watch inside the new `client/src/lib/location-service.ts`. This is the only `navigator.geolocation.watchPosition` in the entire location pipeline.

### 2. How location-service.ts works

The new central service (`client/src/lib/location-service.ts`) is a lightweight observer-pattern module:

- **Single GPS watch:** Uses `navigator.geolocation.watchPosition` with `enableHighAccuracy: true`, `maximumAge: 10000`, `timeout: 20000`
- **Reference counting:** The GPS watch starts when the first subscriber registers, stops when the last subscriber unsubscribes. No wasted battery.
- **Validation rules:**
  - First fix: Always accepted (no matter accuracy) — ensures the map shows SOMETHING immediately
  - Subsequent fixes: Rejected if accuracy > 500m
  - Timestamp check: Rejected if older than current state
- **Debug logging:** Every accepted and rejected position is logged to console with `[GPS]` prefix:
  ```
  [GPS] New position: -31.950000, 115.860000, accuracy 15m
  [GPS] Rejected position: accuracy 650m > 500m
  ```
- **API:**
  - `subscribe(fn)` — returns unsubscribe function. Immediately fires current position if available.
  - `subscribeError(fn)` — error notifications (permission denied, etc.)
  - `getCurrentPosition()` — returns current state snapshot (or null)
  - `forceRefresh()` — triggers a one-shot `getCurrentPosition` for stale recovery
  - `isWatching()` — check if GPS is active

### 3. How components now subscribe to location

**Data flow (clean, unidirectional):**
```
location-service.ts (SINGLE GPS watch)
  ├── live-location.tsx (page) subscribes → gets lat/lng/accuracy for "Me" marker
  └── live-location.ts (tracking module) subscribes → converts to GeolocationPosition → sends to server API → notifies its own listeners for activity data
```

**live-location.tsx (page):**
- Subscribes to `location-service` via `useEffect` on mount
- Sets `myLat`, `myLng`, `myAccuracy` state directly from the service
- The "Me" marker uses ONLY these values — never server data, never socket data
- Removed: `myGpsLat`, `myGpsLng`, `myGpsAccuracy`, `currentLat`, `currentLng` states
- Removed: The `addLocationListener` effect that was the second contamination vector
- Removed: The `myStatus` effect that set `currentLat`/`currentLng` from stale server data
- The `myStatus` effect now only reads `lastActivity` from the server (for display purposes, not position)

**live-location.ts (tracking module):**
- Subscribes to `location-service` via `subscribeGps()` when tracking starts
- Converts the service's `LocationState` into a `GeolocationPosition` object
- Sends to server via `POST /api/live-location/update` (with throttling)
- The keep-alive mechanism now calls `forceGpsRefresh()` instead of `restartGpsWatch()`
- Unsubscribes cleanly on `stopLiveTracking()`

**Server's role (unchanged but clarified):**
- Server receives position from the tracking module → stores it → broadcasts via Socket.IO to watchers
- Server data is NEVER used to position the "Me" marker
- Server data is ONLY used for watched contacts' positions (which is correct — we can't have their GPS locally)

### 4. What was specifically eliminated

| Before (Bug Sources) | After (Clean) |
|---|---|
| `watchPosition` in `live-location.tsx` (page) | REMOVED — subscribes to `location-service` |
| `watchPosition` in `live-location.ts` (tracking module) | REMOVED — subscribes to `location-service` |
| `currentLat`/`currentLng` state set from server `lastLat`/`lastLng` | REMOVED — server never touches "Me" position |
| `addLocationListener` callback overwriting position from tracking module | REMOVED — page gets position directly from `location-service` |
| `myGpsLat`/`myGpsLng`/`myGpsAccuracy` separate state | REPLACED — single `myLat`/`myLng`/`myAccuracy` from service |
| Priority logic `(sharingActive && currentLat) ? currentLat : myGpsLat` | REMOVED — only ONE source now |

### 5. Edge cases remaining

1. **home.tsx has its own `watchPosition`** — This is for emergency location sessions during active incidents (different purpose). It sends location breadcrumbs to the server during SOS events. It does NOT affect the "Me" marker on the live location map. Left untouched per council instructions.

2. **Native Capacitor plugin** — When the app runs as a native iOS app, the tracking module uses `@transistorsoft/capacitor-background-geolocation` instead of the location service. This is correct — the native plugin provides GPS directly and bypasses the browser API. The central service is used ONLY for the browser/PWA path.

3. **First fix accuracy** — The first GPS position is always accepted regardless of accuracy. On some devices, the first fix might come from cell towers (~300-1000m accuracy). This means the pin might briefly appear in the approximate area before snapping to the precise GPS position within a few seconds. This is intentional — showing something immediately is better than showing nothing while waiting for a perfect fix.

4. **Multiple page visits** — The location service uses reference counting. If the user navigates away from the live location page and back, the GPS watch stops (0 subscribers) and restarts (1 subscriber). There's a brief gap but the service fires the current position immediately to new subscribers if available.

### 6. Suggestions for the council

1. **Testing needed:** This refactor changes the fundamental location data flow. The user should test on their actual mobile device by:
   - Opening the live location page
   - Checking if the "Me" pin matches their actual location
   - Watching the browser console for `[GPS]` log messages to verify coordinates
   - Walking around to verify the pin follows them

2. **Future consideration:** The `home.tsx` emergency location watch could also be migrated to use the central service for consistency. However, this is a separate concern and should be a separate task.

3. **The live-location.ts tracking module still has its own `sendLocationUpdate` throttling** (5s moving, 30s stationary). This is correct — the central service fires every GPS update to subscribers, and the tracking module decides when to send to the server. The UI always gets the latest position, the server gets throttled updates.

---

**Files modified:**
- `client/src/lib/location-service.ts` — NEW (central GPS service)
- `client/src/lib/live-location.ts` — Refactored (removed internal GPS watch, subscribes to location-service)
- `client/src/pages/live-location.tsx` — Refactored (removed all direct GPS calls and stale server data, subscribes to location-service)

**Files NOT modified (intentionally):**
- `client/src/components/google-map.tsx` — No changes needed, already receives position via props
- `client/src/pages/live-location-view.tsx` — Watcher view, doesn't use local GPS
- `client/src/pages/home.tsx` — Emergency location (different purpose)
- `server/routes.ts` — Server-side unchanged
