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
- **Watcher System:** Automatically detects and provides an enhanced dashboard for emergency contacts who are also StillHere users, offering status overviews and quick actions. Watchers can opt-out with soft-delete and restore options.
- **Live Location Sharing:** Real-time GPS location sharing with adaptive update frequency, activity detection, and "Open in Google Maps" integration. Includes robust background persistence mechanisms and native Capacitor plugin support. Enhanced with smooth animated marker transitions, info windows (tap markers to see speed/activity/time), geofence circle overlays, nearby emergency places overlay (hospitals/police/fire stations via Google Places API), activity heatmap layer, location history timeline with day scrubber and animated playback, ETA sharing for active Safe Walks on watcher maps, and auto-switching dark mode map theme.
- **Geofencing:** Allows creation of named geofences with real-time zone departure detection and email alerts to contacts. Geofence circles are visualized on the watcher's live location map with name labels.
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