### Overview
StillHere is a safety check-in application designed to provide a crucial safety net for vulnerable individuals like the elderly, solo dwellers, and lone workers. It enables users to confirm their safety and automatically notifies pre-selected emergency contacts if check-ins are missed or during emergency situations. The application aims to deliver peace of mind through a user-friendly, timely, and effective personal safety monitoring solution, offering a reliable safety net for those who need it most.

### User Preferences
- I want to interact with the agent in a clear and structured way.
- Please prioritize security and privacy in all development aspects.
- I prefer a transparent development process; please explain major decisions.
- Focus on delivering core features effectively before adding complex enhancements.
- Ensure the user interface remains intuitive and simple.

### System Architecture

**UI/UX Decisions:**
The application employs a clean, reassuring UI with a primary blue color scheme, green for positive actions, and red for alerts. Key UI elements include prominent "I'm OK" and "I Need Help" SOS buttons, a streamlined onboarding process, and a 3-step registration. User experience is enhanced with in-app banners, haptic feedback, and post-check-in motivational quotes. The map features guarded camera control and auto-switches to dark mode. The Safety Circle UI is a premium, five-screen experience styled like Apple Health, providing a comprehensive overview and management of emergency contacts. Map markers are animated pills with mode glyphs, color-coded by safety state, and support carpool grouping.

**Technical Implementations:**
The frontend is built with React, TypeScript, Tailwind CSS, and shadcn/ui. The backend uses Express.js, secured with Helmet and `express-rate-limit`. PostgreSQL is the database, managed with Drizzle ORM. Authentication relies on Passkey (WebAuthn/FIDO2) with phone OTP fallback, using 30-day httpOnly secure cookies for sessions.

Key architectural features include:
- **Check-in & Emergency System:** Supports manual and scheduled check-ins, SOS alerts, sequential contact escalation (Push → SMS → Call → Contacts), fall detection, and discreet SOS.
- **Multi-channel Notification Engine:** Role-based routing for `SUBJECT` (user) and `WATCHER` (emergency contact) with identity-level deduplication.
- **Real-time Communication:** In-app messaging via Socket.IO with optimistic UI and WebRTC voice calling via Twilio TURN relay.
- **Driving Safety Features:** Dashboard with speedometer, live route map, and crash detection with auto-SOS countdown.
- **Watcher System:** Enhanced dashboard for emergency contacts with status overviews, quick actions, and a "Trust UX" system.
- **Concern Resolution Flow:** A comprehensive safety loop for resolving `concern` states with timeline panels and real-time updates.
- **Heartbeat System:** Clients send regular heartbeats with device telemetry for tracking `lastHeartbeatAt` and other statuses.
- **Reliability Layer:** Enhances watcher cards with device intelligence, including battery status and a "Confidence model."
- **Safety State Engine (V1):** Server-side `safetyState` enum (`active`/`quiet`/`concern`) managed by a background worker.
- **Live Location Sharing:** Real-time GPS sharing with adaptive update frequency, activity detection, "Open in Google Maps" integration, geofence overlays, nearby emergency places, activity heatmap, and historical timeline with playback.
- **Native Background Location:** Utilizes native plugins for continuous background location tracking.
- **Smart Map Camera:** Intelligent camera system with priority-based focus and velocity-aware zoom.
- **Geofencing:** Allows creating named geofences with real-time zone departure detection and email alerts.
- **Context Layer:** Server-side processor detects dwell and trip starts/ends from location updates.
- **SMS Check-in:** Users can check in or trigger an SOS via SMS replies to a Twilio webhook.
- **Permissions & Onboarding Optimization:** Pre-permission education screens and a permission health dashboard.
- **Security:** Comprehensive measures including HTTP headers, global API rate limiting, robust input validation, PII-free logs, and bank-level security hardening. All Twilio inbound webhooks and satellite/cron endpoints require signature/secret verification. Google Maps API key endpoint requires authentication. PII is masked or replaced with user IDs in server logs.
- **PWA Support:** Full Progressive Web App capabilities.
- **Wearable API & Apple Watch Companion App:** Dedicated API and SwiftUI app for quick check-ins, SOS, fall detection, and continuous heart rate monitoring.
- **Watcher Reporting:** Configurable scheduled safety reports via email.
- **Safety Timer (Dead Man's Switch):** Countdown timer for solo activities with GPS tracking and alerts.
- **Safe Walk/Ride:** Destination-based journey tracking with Google-powered route estimates and alerts for late arrivals.
- **Automated Wellness Check Call:** Optional Twilio-powered call for missed check-ins, allowing user confirmation.
- **Unified Resolution Pipeline:** A single `resolveCheckin` function for consistent state updates and notifications.
- **Weekly Safety Report (Receipt of Protection):** Generates a deterministic, human-readable safety summary.
- **Timezone Clarity Layer:** Auto-detects user timezone and provides timezone-aware formatting.
- **Learning Mode (Safe-Start Guard):** 30-day mode for new accounts, using only critical safety triggers.
- **Sleep Protection:** User-configurable `sleepStart`/`sleepEnd` for suppressing non-emergency notifications.
- **Your Protection Panel:** Home screen panel showing Safety Circle members and sharing mode.
- **See My Guardian's View:** One-tap preview of what watchers see.
- **Presence-Only Mode:** `sharingMode` enum (`precise`/`area`/`presence`/`paused`) controls location sharing visibility, with location auto-unlocking during `concern` state.
- **Adaptive Heartbeat:** Client-side heartbeat adjusts interval based on battery level.
- **Setup Confirmation Handshake:** Confirmation notifications for saved contacts.
- **Safety Circle Roles:** `circleRole` enum (`primary`/`backup`/`support`) defines contact escalation.
- **Incident Claim Flow ("I've got this"):** Allows a watcher to claim an incident.
- **Safety Circle Dry Run (Live Handshake):** Simulates an incident to test readiness.
- **Area Mode (Neighborhood Obfuscation):** Deterministic random offset applied to coordinates for `area` sharing mode.
- **API Location Redaction:** Lat/lng/accuracy fields are `null` for `presence`/`paused` modes, obfuscated for `area`, and full precision for `precise`.
- **Action-First Incident Language:** Concern notifications include clear actions or instructions.
- **Pinpoint Location Precision:** All lat/lng columns use PostgreSQL `doublePrecision` for sub-millimeter precision.
- **Guardian Map (Multi-Watched Live View):** Single-screen map showing all monitored users with color-coded markers, activity icons, and smart camera focusing.
- **Safety Circle WOW Redesign:** Premium five-screen Safety Circle experience with detailed management, guardian view, and drill features, including backend additions for multi-watcher acknowledgments and guardian readiness checks.
- **Landing Page Redesign (Public Marketing Site):** Premium public landing at `/` with hero ("When you can't check in, StillHere checks on you."), animated phone+watch mockups cycling through 4 screens each (home/circle/missed/record and ok/heart/sos/fall), 5-step "How StillHere works" loop, positioning, use cases, 12-feature grid, smartwatch, privacy, server monitoring, what-contacts-see, weekly Safety Record, simple pricing ($7.99/mo or $59.99/yr with "Best value" badge, no fake savings), and final CTA. Original primary/accent/destructive brand colors preserved. No fake ratings or testimonials.

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