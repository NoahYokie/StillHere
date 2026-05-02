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
- **Check-in & Emergency System:** Supports manual and scheduled automatic check-ins with configurable grace periods and SMS reminders. Includes SOS alerts, sequential contact escalation, fall detection, and discreet SOS via shake gesture. Escalation uses a persisted state machine (Push → SMS → Call → Contacts).
- **Multi-channel Notification Engine:** Role-based recipient routing with two roles: `SUBJECT` (protected user) and `WATCHER` (emergency contact/watcher). Protected users receive subject-appropriate confirmations, while watchers receive outward-facing updates via push + SMS. Identity-level dedup prevents duplicate messages.
- **Real-time Communication:** In-app messaging via Socket.IO with optimistic UI, typing indicators, and read receipts. WebRTC voice calling is integrated using Twilio TURN relay.
- **Driving Safety Features:** A dedicated dashboard for driving with speedometer, live route map, and crash detection with auto-SOS countdown.
- **Watcher System:** Provides an enhanced dashboard for emergency contacts with status overviews, quick actions, and a "Trust UX" system that interprets safety data into human-readable insights.
- **Concern Resolution Flow:** A comprehensive safety loop for resolving `concern` states, involving timeline panels, user/watcher resolution actions, and real-time updates.
- **Heartbeat System:** Clients send regular heartbeats with device telemetry to the server, which tracks `lastHeartbeatAt` and other device statuses.
- **Reliability Layer:** Enhances watcher cards with device intelligence, showing battery status and a "Confidence model" that scores heartbeat, location, GPS accuracy, battery, and network reliability.
- **Safety State Engine (V1):** Server-side `safetyState` enum (`active`/`quiet`/`concern`) with associated reasons and timestamps. A background worker manages state transitions.
- **Live Location Sharing:** Real-time GPS location sharing with adaptive update frequency, activity detection, and "Open in Google Maps" integration. Includes a central location service for robust background persistence, animated marker transitions, geofence overlays, nearby emergency places, activity heatmap, and a historical timeline with playback.
- **Native Background Location:** Utilizes native plugins (`@transistorsoft/capacitor-background-geolocation`, `@capacitor/geolocation`) for continuous background location tracking.
- **Smart Map Camera:** Intelligent camera system on the live location map with priority-based focus, velocity-aware zoom, stale/low-accuracy filtering, and safety overrides.
- **Geofencing:** Allows creating named geofences with real-time zone departure detection and email alerts, visualized on watcher maps.
- **Context Layer:** Server-side processor detects dwell and trip starts/ends from location updates, storing events and displaying a "context line" on watcher cards.
- **SMS Check-in:** Users can check in or trigger an SOS via SMS replies to a Twilio webhook.
- **Permissions & Onboarding Optimization:** Pre-permission education screens and a permission health dashboard.
- **Security:** Comprehensive measures including HTTP headers, global API rate limiting, robust input validation, PII-free logs, and bank-level security hardening. All Twilio inbound webhooks (`/api/sms/incoming`, `/api/wellness-call/respond`, `/api/wellness-call/gather`) verify the `X-Twilio-Signature` header against `TWILIO_AUTH_TOKEN`. Satellite device webhook (`/api/satellite/webhook`) requires `x-satellite-secret` matching `SATELLITE_WEBHOOK_SECRET`. Cron endpoints (`/api/cron/tick`, `/api/safety-state/tick`) require `x-cron-secret` matching `SESSION_SECRET`. Google Maps API key endpoint (`/api/maps/config`) requires authentication. User-supplied names are XML-escaped and length-capped (80 chars) before use in TwiML responses. PII (phone numbers, names) is masked or replaced with user IDs in server logs.
- **PWA Support:** Full Progressive Web App capabilities for offline use and installability.
- **Wearable API:** Dedicated API for companion watch apps for quick check-ins and status updates.
- **Apple Watch Companion App:** SwiftUI app for one-tap check-in, SOS, 2-phase fall detection, and continuous heart rate monitoring via HealthKit.
- **Watcher Reporting:** Configurable scheduled safety reports via email for watchers, including daily quick-status panels and detailed incident history.
- **Safety Timer (Dead Man's Switch):** Countdown timer for solo activities, triggering alerts if not dismissed, with GPS tracking.
- **Safe Walk/Ride:** Destination-based journey tracking with Google-powered route estimates, GPS tracking, and alerts for late arrivals.
- **Automated Wellness Check Call:** An optional feature where Twilio calls the user if a check-in is missed, allowing safety confirmation by pressing a key.
- **Unified Resolution Pipeline:** A single `resolveCheckin` function handles all check-in resolution paths (app, SMS, call, watcher, heartbeat), ensuring consistent state updates, notifications, and incident resolution.
- **Weekly Safety Report (Receipt of Protection):** Generates a deterministic, human-readable safety summary with `summaryTone`, a calm narrative `summary`, and a deduplicated `timeline` merging incidents and context events.
- **Timezone Clarity Layer:** Auto-detects user timezone, stored on `users.timezone`. Frontend utility provides timezone-aware formatting. Watcher dashboard shows dual-time when watcher and user are in different timezone offsets.
- **Learning Mode (Safe-Start Guard):** New accounts get a 30-day `learningModeUntil` timestamp. During learning mode, the system only uses critical safety triggers, avoiding pattern-based concern language.
- **Sleep Protection:** User-configurable `sleepStart`/`sleepEnd`. During sleep hours, non-emergency concern notifications are suppressed. SOS and crash detection always fire.
- **Your Protection Panel:** Home screen panel showing who is in the Safety Circle, what they can currently see, and the current sharing mode.
- **See My Guardian's View:** One-tap preview on home screen showing exactly what watchers currently see.
- **Presence-Only Mode:** `sharingMode` enum (`precise`/`area`/`presence`/`paused`) on users table. When mode is `presence` or `paused` and safety state is not `concern`, the `getWatchedUsers` API strips lat/lng. During concern state, location auto-unlocks.
- **Adaptive Heartbeat:** Client-side heartbeat adjusts interval based on battery level.
- **Setup Confirmation Handshake:** When contacts are first saved, protected user and watcher receive confirmation notifications.
- **Safety Circle Roles:** `circleRole` enum (`primary`/`backup`/`support`) on contacts table, defining contact escalation order and notification levels.
- **Incident Claim Flow ("I've got this"):** Allows a watcher to claim an incident, notifying other watchers that it's being handled.
- **Safety Circle Dry Run (Live Handshake):** A test feature that simulates an incident to ensure the safety circle is prepared.
- **Area Mode (Neighborhood Obfuscation):** When `sharingMode === 'area'`, server-side `obfuscateCoord()` applies a deterministic random offset to all lat/lng values.
- **API Location Redaction:** For `presence`/`paused` modes, lat/lng/accuracy fields are set to `null` in the API response. For `area` mode, obfuscated coordinates are sent.
- **Action-First Incident Language:** All concern notifications now include a clear action or instruction to wait.
- **Safety Circle WOW Redesign:** Premium five-screen Safety Circle experience styled like Apple Health. Routes:
  - `/safety-circle` (hero shield, primary guardian card with readiness, How It Works stepper, Guardian View card, Run Safety Drill card, reassurance card)
  - `/safety-circle/manage` (per-guardian cards sorted primary→backup→support with role badge, readiness state, last active)
  - `/safety-circle/guardian-view` (live preview of what watchers see: map or hidden state per `sharingMode`, status rows, privacy note; concern-state location override surfaces an amber note)
  - `/safety-circle/drill` (intro screen, Start Drill button, live polled results with per-guardian response time)
  Backend additions: `incidents.drillResponses` JSON column for multi-watcher acks (atomic via `db.transaction` + `SELECT FOR UPDATE`), `GET /api/safety-drill/:drillId` (live drill state, owner or linked watcher only), `GET /api/safety-circle/readiness` (per-guardian readiness `ready`/`idle`/`needs_attention`/`unknown` based on heartbeat age).

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