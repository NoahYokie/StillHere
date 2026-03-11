# StillHere - Safety Check-in App

### Overview
StillHere is a safety check-in application designed to help elderly individuals, solo dwellers, and lone workers maintain connection with their emergency contacts. It provides a simple, reassuring user experience where users confirm their safety with a single tap. If a check-in is missed, pre-selected emergency contacts are notified, enabling them to assess the situation and take appropriate action via a dedicated status page. The project aims to offer a reliable and user-friendly solution for personal safety monitoring, emphasizing ease of use and timely communication during emergencies.

### User Preferences
- I want to interact with the agent in a clear and structured way.
- Please prioritize security and privacy in all development aspects.
- I prefer a transparent development process; please explain major decisions.
- Focus on delivering core features effectively before adding complex enhancements.
- Ensure the user interface remains intuitive and simple.

### System Architecture

**UI/UX Decisions:**
The application features an extremely simple, calm, and reassuring user interface.
- **Color Scheme:** Primary blue (#0ea5e9) for trust/safety, accent green (#22c55e) for positive actions ("I'm OK"), and destructive red (#ef4444) for SOS and alerts.
- **Key Elements:** A large green "I'm OK" button for daily check-ins and a prominent red "I Need Help" button for SOS alerts.
- **Onboarding:** A 4-screen onboarding flow introduces new users to the app's purpose and functionality, followed by a 3-step registration process (name, contacts, preferences).
- **In-App Banners:** Real-time status banners on the home page display alert status, contact handling, and notification progress with dynamic contact names.
- **Haptic Feedback:** Implemented for check-in, SOS, and fall detection actions on supported devices to provide tactile confirmation.
- **Quote of the Day:** After each check-in, a daily motivational quote is displayed in a card below the check-in button (125 quotes, rotates by day-of-year).

**Technical Implementations:**
- **Frontend:** Built with React, TypeScript, Tailwind CSS, and shadcn/ui, utilizing `wouter` for routing and `TanStack Query` for data fetching.
- **Backend:** Powered by Express.js, integrating Helmet for security headers and `express-rate-limit` for API rate limiting.
- **Database:** PostgreSQL managed with Drizzle ORM.
- **Authentication:** Phone OTP (One-Time Password) login via SMS, with sessions lasting 30 days using httpOnly secure cookies. Rate limiting is applied to OTP requests and verification attempts.
- **Check-in Mechanism:** Users can manually check-in or opt for automatic check-ins upon opening the app.
- **Emergency System:** Configurable check-in schedules, grace periods before alerts, and reminders. An SOS alert button provides immediate notification.
- **Escalation System:** Sequential escalation through the top 5 contacts by priority (20 minutes each), then all remaining contacts are notified simultaneously. Re-notification for unaddressed incidents. Tracked via `notifiedContactIds` JSON field on incidents.
- **Fall Detection:** DeviceMotion API-based fall detection — detects high-G impact followed by stillness. Shows 60-second countdown dialog before auto-triggering SOS. Toggle in settings.
- **Premium Contacts:** Free users: 2 contacts max. Premium users (`isPremium` flag): unlimited contacts with top-5 sequential escalation then blast-all remaining.
- **Location Sharing:** Optional, user-controlled location sharing.
- **Push Notifications:** Web push notifications are used for reminders to reduce SMS costs, with an "I'm OK" action button for one-tap check-ins directly from the notification. A service worker handles push events and offline capabilities.
- **Security:** Comprehensive security measures including Helmet.js for HTTP headers, global API rate limiting, cron job security (`x-cron-secret`), and robust input validation.
- **PWA Support:** Full Progressive Web App capabilities, including a manifest, service worker for caching and offline support, and installability.
- **Wearable API:** Dedicated API endpoints for companion watch apps (Apple Watch, Wear OS) using Bearer token authentication (`x-api-token` header) for quick check-ins (`POST /api/checkin/quick`) and minimal status updates (`GET /api/status/simple`).
- **International Phone Normalization:** 28+ countries supported with E.164 normalization (US, UK, AU, CA, NZ, JP, KR, SG, IN, FR, DE, IT, ES, NL, BE, CH, IE, SE, NO, DK, CZ, HU, RO, HR, and more).
- **WebSocket Communication:** Socket.IO for real-time messaging and video call signaling, with cookie-based authentication matching the existing session system.
- **In-App Messaging:** Real-time chat between users and emergency contacts who have the app, with message persistence, read receipts, and push notification fallback for offline users.
- **In-App Video Calling:** WebRTC-based peer-to-peer video calling with Socket.IO signaling. Uses free Google STUN servers for NAT traversal. Features include mute, camera toggle, camera flip, and incoming call notifications.
- **Contact Detection & Watcher System:** Automatic detection of emergency contacts who are also StillHere users (via phone number matching). Contacts with the app get push notifications instead of SMS during incidents. Watcher dashboard shows real-time status of people being monitored.
- **Smart Notification Routing:** When an emergency contact has the app (linked via `linkedUserId`), notifications are sent via push + in-app message instead of SMS, reducing costs and enabling richer communication.

**Feature Specifications:**
- **User Management:** Phone OTP authentication, user profiles, and settings.
- **Check-in Features:** Manual "I'm OK" button, optional auto check-in on app open, configurable schedules (12-48+ hours), grace periods (10-30 min), and configurable reminders (none, one, or two). Quote of the day shown after check-in.
- **Emergency Management:** SOS alert button, dynamic emergency contacts with priority levels (free: 2, premium: unlimited), token-based contact pages for status viewing, responsibility system for contacts to pause escalation, fall detection with countdown, and location sharing.
- **Notifications:** SMS (via Twilio) and web push notifications for reminders and alerts. Smart routing sends push to contacts who have the app, SMS to those who don't.
- **Communication:** In-app messaging with real-time delivery, read receipts, and message history. In-app video calling via WebRTC with camera/mic controls and incoming call overlay.
- **Watcher Dashboard:** Emergency contacts who have the app can see a dashboard of all people they monitor — showing names, last check-in times, status (OK/overdue/alert), with direct message and video call buttons.
- **Account Security:** OTP rate limiting, phone number normalization for 28+ countries, and staging environment whitelisting.

### Key Files
- `shared/schema.ts` — Database schema (users, settings, contacts, incidents, checkins, messages, calls, etc.)
- `server/routes.ts` — All API routes including cron tick escalation logic, messaging, watcher endpoints
- `server/storage.ts` — Storage interface and implementation (IStorage / DatabaseStorage)
- `server/auth.ts` — Phone normalization, OTP generation, session management
- `server/sms.ts` — Twilio SMS integration
- `server/socket.ts` — Socket.IO WebSocket server for real-time messaging and video call signaling
- `server/push.ts` — Web push notification sending
- `client/src/App.tsx` — Frontend routing with all pages including chat, call, watcher
- `client/src/pages/home.tsx` — Main check-in page with escalation banner, fall detection, quote of the day
- `client/src/pages/settings.tsx` — Settings page with dynamic contacts list, fall detection toggle, "On StillHere" badges
- `client/src/pages/watched.tsx` — Watcher dashboard showing monitored users
- `client/src/pages/chat.tsx` — Real-time messaging conversation view
- `client/src/pages/call.tsx` — Video call interface with WebRTC
- `client/src/pages/contact.tsx` — Emergency contact status page with in-app chat/call buttons
- `client/src/pages/setup-contacts.tsx` — Onboarding contacts setup (dynamic list)
- `client/src/components/incoming-call.tsx` — Incoming call overlay (works on any page)
- `client/src/lib/socket.ts` — Socket.IO client singleton
- `client/src/lib/webrtc.ts` — WebRTC peer connection management
- `client/src/lib/fall-detection.ts` — DeviceMotion-based fall detection module
- `client/src/lib/quotes.ts` — 125 daily motivational quotes
- `capacitor.config.json` — Capacitor config with watch companion app stubs

### External Dependencies
- **SMS Gateway:** Twilio (for sending SMS messages)
- **Push Notifications:** `web-push` library (for VAPID-based web push notifications)
- **WebSocket:** `socket.io` / `socket.io-client` (for real-time messaging and video call signaling)
- **Frontend Framework:** React
- **Styling:** Tailwind CSS, shadcn/ui
- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **HTTP Server:** Express.js
- **Security Middleware:** Helmet
- **Rate Limiting Middleware:** `express-rate-limit`
- **Frontend Routing:** `wouter`
- **Data Fetching:** `TanStack Query`
- **Mobile/Desktop App Wrapper:** Capacitor (for native iOS and Android builds)
