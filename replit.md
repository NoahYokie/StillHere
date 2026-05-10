### Overview
StillHere is a safety check-in application designed to provide a crucial safety net for vulnerable individuals like the elderly, solo dwellers, and lone workers. It enables users to confirm their safety and automatically notifies pre-selected emergency contacts if check-ins are missed or during emergency situations. The application aims to deliver peace of mind through a user-friendly, timely, and effective personal safety monitoring solution, offering a reliable safety net for those who need it most.

### User Preferences
- I want to interact with the agent in a clear and structured way.
- Please prioritize security and privacy in all development aspects.
- I prefer a transparent development process; please explain major decisions.
- Focus on delivering core features effectively before adding complex enhancements.
- Ensure the user interface remains intuitive and simple.
- No em-dashes in user-facing copy or chat replies.

### Pre-App-Store-Submission Backlog (revisit AFTER Codex audit fixes)
These are App Store risks that Codex did not include in its priority list but
must be resolved before tapping "Submit for Review" in App Store Connect.
Order = my recommended order of attack once Codex items are done.

1. Misleading emergency claims (HIGHEST legal risk).
   - Audit landing page, onboarding, and in-app copy for words like
     "emergency response", "automatic emergency notifications",
     "crash detection", "safety net" that overstate what the app
     guarantees. Apple guideline 1.4.1 + civil liability exposure.
   - Add a "Limitations of Service" screen the user must scroll through
     during signup (SMS is best-effort, not 911, no SLA).
   - Replace "we will notify your contacts" with "we will attempt to
     notify your contacts" everywhere.

2. iOS background "Always" location justification.
   - Re-read the pre-permission education screen wording against
     Apple's current bar for `NSLocationAlwaysAndWhenInUseUsageDescription`.
     Generic wording = automatic rejection.

3. Children / minors (COPPA + Apple Kids category rules).
   - Family Mode can be used to track under-13s. Currently no parental
     consent flow, no age gate. Either add one or explicitly forbid
     under-13 accounts in the ToS and signup.

4. Privacy nutrition label vs actual data retention.
   - `locationDataRetentionDays` defaults to 30. The App Store Connect
     "Data linked to you" section MUST say the same thing exactly.
     Mismatch = rejection.

5. SMS / Twilio honesty pass.
   - Anywhere copy implies guaranteed SMS delivery, soften to
     "best-effort". Carriers drop messages; we have no SLA.

(Codex's own remaining priorities, for reference, in their order:
 location privacy verification → App Store permission strings →
 misleading emergency claims. We will finish those first.)

### System Architecture

**UI/UX Decisions:**
The application features a clean, reassuring UI with a blue primary color scheme, green for positive actions, and red for alerts. Key elements include prominent "I'm OK" and "I Need Help" SOS buttons, a streamlined 3-step registration, in-app banners, haptic feedback, and post-check-in motivational quotes. The Safety Circle UI is a premium, five-screen experience styled like Apple Health. Map markers are animated, color-coded, and support carpool grouping. The landing page redesign features animated phone and watch mockups, a 5-step "How StillHere works" loop, use cases, a 12-feature grid, and transparent pricing.

**Technical Implementations:**
The frontend uses React, TypeScript, Tailwind CSS, and shadcn/ui, while the backend is built with Express.js. PostgreSQL is the database, managed with Drizzle ORM. Authentication uses Passkey (WebAuthn/FIDO2) with phone OTP fallback.

Key architectural features include:
- **Check-in & Emergency System:** Supports manual/scheduled check-ins, SOS alerts, sequential contact escalation (Push → SMS → Call → Contacts), fall detection, and discreet SOS.
- **Multi-channel Notification Engine:** Role-based routing for `SUBJECT` and `WATCHER` with identity-level deduplication.
- **Real-time Communication:** In-app messaging via Socket.IO with optimistic UI and WebRTC voice calling via Twilio TURN relay.
- **Driving Safety Features:** Dashboard with speedometer, live route map, and crash detection with auto-SOS countdown.
- **Watcher System:** Enhanced dashboard for emergency contacts with status overviews and quick actions.
- **Concern Resolution Flow:** A comprehensive safety loop for resolving `concern` states.
- **Heartbeat System:** Clients send regular heartbeats with device telemetry.
- **Reliability Layer:** Enhances watcher cards with device intelligence like battery status.
- **Safety State Engine (V1):** Server-side `safetyState` enum (`active`/`quiet`/`concern`) managed by a background worker.
- **Live Location Sharing:** Real-time GPS sharing with adaptive update frequency, activity detection, Google Maps integration, geofence overlays, nearby emergency places, activity heatmap, and historical timeline.
- **Native Background Location:** Utilizes native plugins for continuous background location tracking.
- **Smart Map Camera:** Intelligent camera system with priority-based focus and velocity-aware zoom.
- **Geofencing:** Allows creating named geofences with real-time zone departure detection and email alerts.
- **Context Layer:** Server-side processor detects dwell and trip starts/ends from location updates.
- **SMS Check-in:** Users can check in or trigger an SOS via SMS replies to a Twilio webhook.
- **In-Chat Live Location Sharing:** Tap-to-share functionality posts a structured "Live Location" card with a static map preview and actions like "Open Live Map" and "Get directions."
- **Chat Presence Layer:** Displays online/offline status and "Last seen" for conversation partners.
- **Compact Chat Quick Actions:** Provides three pill-shaped action buttons for Location, Call, and SOS.
- **Chat Alert Collapsing:** Collapses multiple identical safety alerts into a single expandable card.
- **Permissions & Onboarding Optimization:** Includes pre-permission education screens and a permission health dashboard.
- **Security:** Comprehensive measures including HTTP headers, global API rate limiting, robust input validation, PII-free logs, and bank-level security hardening.
- **PWA Support:** Full Progressive Web App capabilities.
- **Wearable API & Apple Watch Companion App:** Dedicated API and SwiftUI app for quick check-ins, SOS, fall detection, and continuous heart rate monitoring.
- **Watcher Reporting:** Configurable scheduled safety reports via email.
- **Safety Timer (Dead Man's Switch):** Countdown timer for solo activities with GPS tracking and alerts.
- **Safe Walk/Ride:** Destination-based journey tracking with Google-powered route estimates and alerts for late arrivals.
- **Automated Wellness Check Call:** Optional Twilio-powered call for missed check-ins.
- **Unified Resolution Pipeline:** A single `resolveCheckin` function for consistent state updates and notifications.
- **Weekly Safety Report (Receipt of Protection):** Generates a deterministic, human-readable safety summary.
- **Timezone Clarity Layer:** Auto-detects user timezone for aware formatting.
- **Learning Mode (Safe-Start Guard):** 30-day mode for new accounts using only critical safety triggers.
- **Sleep Protection:** User-configurable `sleepStart`/`sleepEnd` for suppressing non-emergency notifications.
- **Your Protection Panel:** Home screen panel showing Safety Circle members and sharing mode.
- **See My Guardian's View:** One-tap preview of what watchers see.
- **Presence-Only Mode:** `sharingMode` enum (`precise`/`area`/`presence`/`paused`) controls location sharing visibility.
- **Adaptive Heartbeat:** Client-side heartbeat adjusts interval based on battery level.
- **Setup Confirmation Handshake:** Confirmation notifications for saved contacts.
- **Safety Circle Roles:** `circleRole` enum (`primary`/`backup`/`support`) defines contact escalation.
- **Incident Claim Flow ("I've got this"):** Allows a watcher to claim an incident.
- **Safety Circle Dry Run (Live Handshake):** Simulates an incident to test readiness.
- **Area Mode (Neighborhood Obfuscation):** Deterministic random offset applied to coordinates for `area` sharing mode.
- **API Location Redaction:** Lat/lng/accuracy fields are `null` for `presence`/`paused` modes, obfuscated for `area`, and full precision for `precise`.
- **Action-First Incident Language:** Concern notifications include clear actions or instructions.
- **Pinpoint Location Precision:** All lat/lng columns use PostgreSQL `doublePrecision`.
- **Guardian Map (Multi-Watched Live View):** Single-screen map showing all monitored users with color-coded markers, activity icons, and smart camera focusing.
- **Family Mode (Map-First Safety Hub):** A map-centric family experience at `/family` with live member pins, shared places, group chat, and scheduled place expectations.
- **Store Submission Readiness:** `shared/billing-products.ts` holds the canonical product/entitlement/offering identifiers (`stillhere_premium_monthly`, `stillhere_premium_yearly`, entitlement `premium`, offering `default`) used by Stripe seed script, RevenueCat client, and the iOS/Android stores. `ios/App/Podfile` includes `RevenuecatPurchasesCapacitor` so `pod install` after `npx cap sync ios` wires StoreKit in. `@capacitor/android` is installed so `npx cap add android` (run on a Mac with Node 22) scaffolds the Android project; the RC plugin auto-adds the `BILLING` permission on `cap sync`. End-to-end submission steps (Apple Developer, Play Console, RevenueCat dashboard, secrets) are documented in `STORE_SUBMISSION.md` at the repo root.
- **Payments / Premium Subscription:** Offers "StillHere Premium" with monthly/yearly billing. Web payments use Stripe Checkout; mobile payments use RevenueCat (`@revenuecat/purchases-capacitor`) for App Store/Google Play. Both funnel into a unified entitlement system based on `users.premiumUntil` and `users.premiumSource`.

### External Dependencies
- **Location Services:** Google Maps Platform (Places API New, Routes API)
- **SMS & Voice:** Twilio
- **Push Notifications:** `web-push`
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
- **Payment Processing (Web):** Stripe
- **Payment Processing (Mobile):** RevenueCat (`@revenuecat/purchases-capacitor`)