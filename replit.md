# StillHere - Safety Check-in App

### Overview
StillHere is a safety check-in application providing a crucial safety net for elderly individuals, solo dwellers, and lone workers. It enables users to easily confirm their safety, and in case of missed check-ins or emergencies, it automatically notifies pre-selected emergency contacts. The application prioritizes user-friendliness, timely communication, and peace of mind through a simple yet effective personal safety monitoring solution.

### User Preferences
- I want to interact with the agent in a clear and structured way.
- Please prioritize security and privacy in all development aspects.
- I prefer a transparent development process; please explain major decisions.
- Focus on delivering core features effectively before adding complex enhancements.
- Ensure the user interface remains intuitive and simple.

### System Architecture

**UI/UX Decisions:**
The application utilizes a clean, reassuring UI with a blue primary scheme, green accents for positive actions, and red for alerts. It features prominent "I'm OK" and "I Need Help" SOS buttons, an onboarding flow, and a 3-step registration. In-app banners, haptic feedback, and post-check-in motivational quotes enhance the user experience.

**Technical Implementations:**
The frontend is built with React, TypeScript, Tailwind CSS, and shadcn/ui. The backend uses Express.js with Helmet for security and `express-rate-limit`. PostgreSQL is managed with Drizzle ORM. Authentication relies on Passkey (WebAuthn/FIDO2) with phone OTP fallback, using 30-day httpOnly secure cookies for sessions.

Key features include:
- **Check-in Mechanism:** Supports manual and scheduled automatic check-ins with configurable grace periods and SMS reminders. Location and timezone are auto-detected.
- **Emergency System:** SOS alerts, sequential contact escalation, fall detection with countdown, and discreet SOS via shake gesture.
- **Notifications:** Multi-channel notification system using SMS, push notifications (VAPID web-push), and email to ensure emergency contacts are always reached.
- **Communication:** Real-time in-app messaging via Socket.IO with optimistic UI, typing indicators, and read receipts. WebRTC voice calling with Twilio TURN relay is integrated, supporting native call UI via Capacitor plugins.
- **Driving Safety:** A dedicated driving dashboard includes a speedometer, live route map, stats, and crash detection with a 60-second auto-SOS countdown. It also generates Life360-style driving habit reports for users and emergency contacts. Trip replay animation with play/pause/speed controls allows reviewing past drives on the map.
- **Watcher System:** Automatically detects and provides an enhanced dashboard for emergency contacts who are also StillHere users, offering status overviews and quick actions. Watchers can opt-out with soft-delete and restore options. Features a **Trust UX** system (`client/src/components/watcher-status.tsx`) that interprets raw safety data (heartbeat, safety state, location, incidents) into human-readable insights with three trust levels: `safe` (green), `watching` (amber), `worried` (red). Cards show connection status (phone online/offline), location status (live/stale/unavailable), calm headlines ("Everything looks good", "Quiet for the last X minutes"), and recovery messages ("Back online just now"). Map markers color-code by safety state with animated pulse for concern/incident states. Live location sharing API and socket events include `safetyState` and `hasSafetyEvent` fields for real-time map marker updates.
- **Concern Resolution Flow:** Complete safety loop for the `concern` state. When concern triggers: concern timeline panel (`client/src/components/concern-resolution.tsx`) shows what happened (state change, push sent, SMS sent, call attempted), resolution actions (user "I'm OK" button, watcher "Mark as safe" button), resolution feedback ("[Name] is safe now" with timestamp), and recovery UX (red → green with "Connection restored — no further action needed"). Concern never disappears silently — must be explicitly acknowledged. APIs: `POST /api/concern/resolve` (user self), `POST /api/concern/resolve-watcher/:userId` (watcher), `GET /api/concern/timeline/:userId`. Socket event `concern:resolved` broadcasts resolution to all watchers in real-time.
- **Heartbeat System:** Client sends heartbeat POST every 60s with optional cached GPS snapshot (omitted if >5min stale). Server stores `lastHeartbeatAt` on users table. Consecutive failure counting with console warnings. No new GPS calls — reads from location-service cache only.
- **Safety State Engine (V1):** Server-side `safetyState` enum (`active`/`quiet`/`concern`) on users table with `safetyStateReason` and `safetyStateChangedAt`. Background worker runs every 30s: `active → quiet` after 180s without heartbeat. Heartbeat endpoint auto-restores `quiet → active`. `concern` state is never auto-cleared. Monitoring guard: only users with non-null `lastHeartbeatAt` are evaluated.
- **Live Location Sharing:** Real-time GPS location sharing with adaptive update frequency, activity detection, and "Open in Google Maps" integration. Uses a **central location service** (`client/src/lib/location-service.ts`) as the single source of truth for GPS — ONE `watchPosition`, ONE state store, observer pattern, adaptive mode support (`normal`/`high_accuracy` with reference counting). The tracking module and UI pages subscribe to this service. Server data is storage/distribution only, never overrides device GPS for the user's own "Me" marker. Includes robust background persistence mechanisms and native Capacitor plugin support. Enhanced with smooth animated marker transitions, info windows (tap markers to see speed/activity/time), geofence circle overlays, nearby emergency places overlay (hospitals/police/fire stations via Google Places API), activity heatmap layer, location history timeline with day scrubber and animated playback, ETA sharing for active Safe Walks on watcher maps, and auto-switching dark mode map theme. Map uses `userInteractedRef` + `programmaticMoveRef` guards so auto-centering only fires on initial load (not every 15s refresh), with a re-center button appearing when user pans away.
- **Native Background Location (Phase 1):** Location-service is the single GPS source for all features (native + web). On native iOS: tries `@transistorsoft/capacitor-background-geolocation` first (continuous background, stopOnTerminate=false, startOnBoot, heartbeat every 60s), falls back to `@capacitor/geolocation`, then browser API. Session-guarded async start/stop prevents race conditions. `live-location.ts` no longer runs its own native plugin — it subscribes to location-service like all other features. iOS Info.plist configured with Always location permission, background modes (location, fetch, remote-notification, processing). `getTrackingSource()` exposes which source is active ("native-bg" | "capacitor" | "browser" | "none").
- **Smart Map Camera:** Intelligent camera system on the live location map with priority-based focus (concern > safety event > selected > moving > self), velocity-aware zoom (driving=14, walking=16, stationary=17), stale/low-accuracy filtering (>180s or >500m excluded from camera calc), zoom limits (min 14, max 18), locating guard, manual override detection with re-center button, and safety override that forces camera to prioritize concern-state users.
- **Geofencing:** Allows creation of named geofences with real-time zone departure detection and email alerts to contacts. Geofence circles are visualized on the watcher's live location map with name labels.
- **Context Layer (Trip + Dwell Detection):** Server-side context processor (`server/context-processor.ts`) detects dwell starts/ends and trip starts/ends from live location updates. Uses cumulative distance thresholds (200m) with speed gates for trip detection, and multi-sample hysteresis (3 slow samples) for trip end to avoid false positives. Per-user mutex serialization prevents race conditions. State TTL eviction (30min) prevents memory leaks. `contextEvents` table stores events with type/lat/lng/placeName. API: `GET /api/context/:userId` returns current state + recent timeline. Watcher cards show a context line ("At this location for 15 minutes", "On the move for 8 minutes") replacing the subtext, with a collapsible timeline in expanded view showing color-coded event dots. Socket events include `contextLine` field for real-time updates.
- **Location Breadcrumbs:** Stores a trail of location points during active sessions, accessible to watchers. Supports historical day-by-day replay via time scrubber.
- **Satellite Device Integration:** API for registering, unregistering, and receiving webhooks from satellite communicators (e.g., Garmin inReach, SPOT).
- **SMS Checkin:** Enables users to check in or trigger an SOS via SMS replies to a Twilio incoming webhook.
- **Security:** Implements comprehensive measures including HTTP headers, global API rate limiting, robust input validation, PII-free logs, and bank-level security hardening.
- **PWA Support:** Full Progressive Web App capabilities for offline use and installability.
- **Wearable API:** Dedicated API for companion watch apps for quick check-ins and status updates.
- **Internationalization:** E.164 phone number normalization supports multiple countries.
- **Apple Watch Companion App:** A SwiftUI app for one-tap check-in, SOS, custom 2-phase fall detection, and continuous heart rate monitoring via HealthKit, utilizing WatchConnectivity and WidgetKit.
- **Heart Rate Monitoring:** Integrates HealthKit to read and display live heart rates from Apple Watch, with server-side alerts for abnormal BPM.
- **Watcher Reporting:** Provides configurable scheduled safety reports via email to watchers, including daily quick-status panels and detailed report views with compliance stats and incident history.
- **Error Tracking:** Automatic crash/error reporting for frontend and backend, with a user-scoped error view.
- **App Ratings:** In-app 1-5 star rating prompt and feedback page displaying overall rating stats and anonymized reviews.
- **Safety Timer (Dead Man's Switch):** A countdown timer for solo activities, triggering alerts to contacts if not dismissed, with GPS tracking throughout.
- **Safe Walk/Ride:** Destination-based journey tracking with Google-powered route estimates, GPS tracking, and alerts if the user doesn't arrive on time.
- **Automated Wellness Check Call:** An optional feature where Twilio calls the user if a check-in is missed, allowing them to confirm safety by pressing a key.

### External Dependencies
- **Location Search & Directions:** Google Maps Platform (Places API New, Routes API)
- **SMS Gateway:** Twilio
- **Push Notifications:** `web-push` library
- **WebSocket:** `socket.io` / `socket.io-client`
- **Frontend Framework:** React
- **Styling:** Tailwind CSS, shadcn/ui
- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **HTTP Server:** Express.js
- **Security Middleware:** Helmet
- **Rate Limiting Middleware:** `express-rate-limit`
- **Frontend Routing:** `wouter`
- **Data Fetching:** `TanStack Query`
- **Mobile/Desktop App Wrapper:** Capacitor