# StillHere - Safety Check-in App

### Overview
StillHere is a safety check-in application designed to help elderly individuals, solo dwellers, and lone workers stay connected with their emergency contacts. Users confirm their safety with a single tap, and if a check-in is missed, pre-selected emergency contacts are notified via a dedicated status page. The project focuses on providing a reliable, user-friendly solution for personal safety monitoring, ensuring ease of use and timely communication during emergencies. It aims to offer peace of mind through a simple, effective safety net.

### User Preferences
- I want to interact with the agent in a clear and structured way.
- Please prioritize security and privacy in all development aspects.
- I prefer a transparent development process; please explain major decisions.
- Focus on delivering core features effectively before adding complex enhancements.
- Ensure the user interface remains intuitive and simple.

### System Architecture

**UI/UX Decisions:**
The application features a simple, reassuring user interface with a primary blue color scheme, accent green for positive actions, and destructive red for alerts. Key elements include a large "I'm OK" button and a prominent "I Need Help" SOS button. An onboarding flow introduces functionality, followed by a 3-step registration. In-app banners provide real-time status, and haptic feedback is implemented for key actions. A motivational quote is displayed after each check-in.

**Technical Implementations:**
The frontend uses React, TypeScript, Tailwind CSS, and shadcn/ui. The backend is Express.js with Helmet for security and `express-rate-limit`. PostgreSQL is managed with Drizzle ORM. Authentication is primarily Passkey (WebAuthn/FIDO2) with phone OTP as a fallback. Sessions are 30 days via httpOnly secure cookies.

Key features include:
- **Check-in Mechanism:** Manual or optional automatic check-ins, with configurable schedules, grace periods, and reminders. SMS checkin supported (reply YES to reminder text).
- **Emergency System:** SOS alerts, sequential escalation through prioritized contacts, and fall detection with a countdown. Discreet SOS via shake gesture (DeviceMotion API). Configurable escalation timing (5-60 min).
- **Notifications:** SMS is always sent to every emergency contact as the primary channel. Push notifications (VAPID web-push) are sent additionally to contacts who also use the app. Email notifications sent when contact has an email address. This ensures contacts are always reached regardless of app usage.
- **Communication:** Socket.IO enables real-time in-app messaging with persistence and read receipts, and WhatsApp-style WebRTC video calling with a relay-first architecture. Native call integration via Capacitor plugins (CallKit/ConnectionService) provides a native incoming call UI.
- **Watcher System:** Automatic detection of emergency contacts who are also StillHere users, enabling push notifications and an enhanced watcher dashboard with grouped status sections (active alerts, overdue, all clear), quick actions (message/video call), and next-due-time display.
- **Geofencing:** CRUD API for named geofences (home, work, custom). Real-time zone departure detection with transition-based alerting (no spam). Email notifications to contacts on zone departure. DB table: `geofences`. API: `GET/POST /api/geofences`, `PUT/DELETE /api/geofences/:id`, `POST /api/geofences/check`.
- **Location Breadcrumbs:** Trail of location points during active sessions. Watcher-accessible breadcrumb history. DB table: `location_breadcrumbs`. API: `POST /api/location/breadcrumb`, `GET /api/location/breadcrumbs/:userId`.
- **Satellite Device Integration:** API for satellite communicators (Garmin inReach, SPOT). Register/unregister devices, webhook for checkin/SOS from satellite. DB table: `satellite_devices`. API: `GET /api/satellite/devices`, `POST /api/satellite/register`, `DELETE /api/satellite/devices/:id`, `POST /api/satellite/webhook`.
- **SMS Checkin:** Twilio incoming webhook at `POST /api/sms/incoming`. Users can reply YES/OK/SAFE to check in, or HELP for SOS. Requires `smsCheckinEnabled` in settings.
- **Security:** Comprehensive measures including HTTP headers, global API rate limiting, robust input validation, PII-free server logs, and bank-level security hardening (e.g., HSTS, Permissions-Policy, content-type enforcement, OTP hashing).
- **PWA Support:** Full Progressive Web App capabilities for offline support and installability.
- **Wearable API:** Dedicated API endpoints support companion watch apps (Apple Watch, Wear OS) for quick check-ins and status updates.
- **Internationalization:** E.164 phone number normalization supports 28+ countries.
- **Apple Watch Companion App:** A SwiftUI watchOS app (`apple-watch/StillHereWatch/`) provides one-tap checkin, SOS, custom 2-phase fall detection, and continuous heart rate monitoring via HealthKit. Uses WatchConnectivity for iPhone relay, WidgetKit for watch face complications, and Keychain for secure token storage.
- **Heart Rate Monitoring:** HealthKit integration on Apple Watch reads real-time BPM via HKAnchoredObjectQuery. Displays live BPM on watch face. Batches readings locally, syncs to server every 5 minutes. Server-side abnormal BPM alerts: >120 (high) or <40 (low). DB tables: `heart_rate_readings`, `heart_rate_alerts`. API: `POST /api/heartrate`, `GET /api/heartrate/latest`, `GET /api/heartrate/history`.
- **Watcher Reporting:** Configurable scheduled safety reports sent via email to watchers. Daily quick-status panel on watcher dashboard cards shows today's checkins, heart rate, and incident status. Report view page (`/report/:userId`) with printable layout, period selector (day/week/fortnight/month), compliance stats, checkin history, incidents, heart rate summary, and feature status. Report preferences per watched user (frequency, email). User consent via `allowReports` toggle in settings. DB table: `report_preferences`. API: `GET /api/watched-users/:userId/daily`, `GET/PUT /api/reports/preferences`, `GET /api/reports/:watchedUserId`.

### External Dependencies
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