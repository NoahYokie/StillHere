# StillHere - Safety Check-in App

### Overview
StillHere is a safety check-in application designed to provide a crucial safety net for vulnerable individuals such as the elderly, solo dwellers, and lone workers. It allows users to easily confirm their safety and automatically notifies pre-selected emergency contacts if check-ins are missed or in emergency situations. The application aims to deliver peace of mind through a user-friendly, timely, and effective personal safety monitoring solution.

### User Preferences
- I want to interact with the agent in a clear and structured way.
- Please prioritize security and privacy in all development aspects.
- I prefer a transparent development process; please explain major decisions.
- Focus on delivering core features effectively before adding complex enhancements.
- Ensure the user interface remains intuitive and simple.

### System Architecture

**UI/UX Decisions:**
The application features a clean, reassuring user interface with a primary blue color scheme, green for positive actions, and red for alerts. Key UI elements include prominent "I'm OK" and "I Need Help" SOS buttons, a streamlined onboarding process, and a 3-step registration. User experience is enhanced with in-app banners, haptic feedback, and post-check-in motivational quotes. The map uses `userInteractedRef` + `programmaticMoveRef` guards for camera control and auto-switches to dark mode.

**Technical Implementations:**
The frontend is built using React, TypeScript, Tailwind CSS, and shadcn/ui. The backend utilizes Express.js, secured with Helmet and `express-rate-limit`. PostgreSQL is the database, managed with Drizzle ORM. Authentication uses Passkey (WebAuthn/FIDO2) with phone OTP as a fallback, employing 30-day httpOnly secure cookies for sessions.

Key architectural features include:
- **Check-in & Emergency System:** Supports manual and scheduled automatic check-ins with configurable grace periods and SMS reminders. Includes SOS alerts, sequential contact escalation, fall detection with a countdown, and discreet SOS via shake gesture. Escalation uses a persisted state machine (Push → SMS → Call → Contacts) with hard timing gaps between steps enforced via `lastEscalationStep`, `pushSentAt`, `smsSentAt`, `callSentAt` fields on the incidents table. No two escalation steps fire in the same cron tick.
- **Multi-channel Notification Engine:** Role-based recipient routing with two roles: `SUBJECT` (protected user) and `WATCHER` (emergency contact/watcher, same person). Protected users receive subject-appropriate confirmations ("You're checked in. Your watchers have been notified you're safe."), watchers receive outward-facing updates ("Good news. [Name] confirmed safe...") via push + SMS. Identity-level dedup via `notifiedIdentities` set + phone normalization prevents duplicate messages to the same watcher. Every sent/suppressed message logs event type, role, recipient, channel, and dedup reason. Watchers can customize arrival notification preferences.
- **Real-time Communication:** In-app messaging via Socket.IO with optimistic UI, typing indicators, and read receipts. WebRTC voice calling is integrated using Twilio TURN relay, supporting native call UI.
- **Driving Safety Features:** A dedicated dashboard for driving with speedometer, live route map, and crash detection with auto-SOS countdown. Generates driving habit reports and offers trip replay animation.
- **Watcher System:** Provides an enhanced dashboard for emergency contacts (StillHere users) with status overviews, quick actions, and a "Trust UX" system that interprets safety data into human-readable insights (safe, watching, worried) with color-coded map markers.
- **Concern Resolution Flow:** A comprehensive safety loop for resolving `concern` states, involving timeline panels, user/watcher resolution actions, and real-time updates to watchers.
- **Heartbeat System:** Clients send regular heartbeats with device telemetry (battery, network) to the server, which tracks `lastHeartbeatAt` and other device statuses.
- **Reliability Layer:** Enhances watcher cards with device intelligence, showing battery status and a "Confidence model" that scores heartbeat, location, GPS accuracy, battery, and network reliability into human-readable bands.
- **Safety State Engine (V1):** Server-side `safetyState` enum (`active`/`quiet`/`concern`) with associated reasons and timestamps. A background worker manages state transitions (e.g., `active` to `quiet` if no heartbeat).
- **Live Location Sharing:** Real-time GPS location sharing with adaptive update frequency, activity detection, and "Open in Google Maps" integration. Uses a central location service for robust background persistence, native plugin support, animated marker transitions, geofence overlays, nearby emergency places, activity heatmap, and a historical timeline with playback.
- **Native Background Location:** Utilizes native plugins (`@transistorsoft/capacitor-background-geolocation`, `@capacitor/geolocation`) for continuous background location tracking, with fallbacks and permission optimization.
- **Smart Map Camera:** Intelligent camera system on the live location map with priority-based focus, velocity-aware zoom, stale/low-accuracy filtering, and safety overrides.
- **Geofencing:** Allows creating named geofences with real-time zone departure detection and email alerts, visualized on watcher maps.
- **Context Layer:** Server-side processor detects dwell and trip starts/ends from location updates, storing events and displaying a "context line" on watcher cards.
- **SMS Check-in:** Users can check in or trigger an SOS via SMS replies to a Twilio webhook.
- **Permissions & Onboarding Optimization:** Pre-permission education screens and a permission health dashboard with one-tap fix actions, primarily for iOS.
- **Security:** Comprehensive measures including HTTP headers, global API rate limiting, robust input validation, PII-free logs, and bank-level security hardening.
- **PWA Support:** Full Progressive Web App capabilities for offline use and installability.
- **Wearable API:** Dedicated API for companion watch apps for quick check-ins and status updates.
- **Apple Watch Companion App:** SwiftUI app for one-tap check-in, SOS, 2-phase fall detection, and continuous heart rate monitoring via HealthKit.
- **Watcher Reporting:** Configurable scheduled safety reports via email for watchers, including daily quick-status panels and detailed incident history.
- **Safety Timer (Dead Man's Switch):** Countdown timer for solo activities, triggering alerts if not dismissed, with GPS tracking.
- **Safe Walk/Ride:** Destination-based journey tracking with Google-powered route estimates, GPS tracking, and alerts for late arrivals.
- **Automated Wellness Check Call:** An optional feature where Twilio calls the user if a check-in is missed, allowing safety confirmation by pressing a key.
- **Unified Resolution Pipeline:** A single `resolveCheckin` function handles all check-in resolution paths (app, SMS, call, watcher, heartbeat), ensuring consistent state updates, notifications, and incident resolution. Accepts `ResolveOptions` for watcher context (`resolvedBy`, `resolverName`) and `skipCreateCheckin` to prevent duplicate records. All entry points (`/api/concern/resolve`, `/api/concern/resolve-watcher`, `/api/heartbeat` auto-recovery, `/api/checkin`, `/api/checkin/quick`, `/api/satellite/webhook`) route through this function. Structured `SAFETY_RESOLVED` and `CALL_FLOW_DIAGNOSTIC` JSON logs emitted for every resolution and wellness call decision. No silent `catch {}` blocks remain in the notification engine or resolution pipeline.
- **Weekly Safety Report (Receipt of Protection):** `GET /api/reports/weekly` generates a deterministic, human-readable safety summary with `summaryTone` (good/mixed/concern), a calm narrative `summary`, and a deduplicated `timeline` merging incidents and context events. Method mapping translates system methods to human phrases. 60-minute deduplication collapses repeated events. Frontend at `/weekly-report` renders a premium summary card + vertical timeline. Server is the sole source of truth — UI performs zero calculations.
- **Timezone Clarity Layer:** Auto-detects user timezone from heartbeat `tz` field (IANA string), stored on `users.timezone` (default `Australia/Melbourne`). `WatchedUser` includes `userTimezone`. Frontend utility `client/src/lib/timezone.ts` provides `formatDualTime`, `formatTimeForViewer`, `shouldShowDualTime`, and `getViewerTimezone`. Watcher dashboard shows dual-time ("3:45 PM your time (1:45 AM in Melbourne)") when watcher and user are in different timezone offsets. All server-to-client timestamps use ISO strings; client-side rendering handles timezone conversion. `getDailyStatus` uses DST-safe `startOfDayInTimezone` for "today's checkins" boundary.

### External Dependencies
- **Location Services:** Google Maps Platform (Places API New, Routes API)
- **SMS & Voice:** Twilio
- **Push Notifications:** `web-push` library
- **WebSockets:** `socket.io` / `socket.io-client`
- **Frontend Framework:** React
- **Styling:** Tailwind CSS, shadcn/ui
- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **Backend Framework:** Express.js
- **Security Middleware:** Helmet
- **Rate Limiting:** `express-rate-limit`
- **Frontend Routing:** `wouter`
- **Data Fetching:** `TanStack Query`
- **Cross-Platform App Wrapper:** Capacitor