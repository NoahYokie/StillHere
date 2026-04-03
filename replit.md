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
- **Check-in Mechanism:** Manual or optional automatic check-ins, with configurable schedules, grace periods, and reminders.
- **Emergency System:** SOS alerts, sequential escalation through prioritized contacts, and fall detection with a countdown.
- **Notifications:** Web push notifications are prioritized to reduce SMS costs, with SMS fallback. Smart routing sends push to app users and SMS to others.
- **Communication:** Socket.IO enables real-time in-app messaging with persistence and read receipts, and WhatsApp-style WebRTC video calling with a relay-first architecture. Native call integration via Capacitor plugins (CallKit/ConnectionService) provides a native incoming call UI.
- **Watcher System:** Automatic detection of emergency contacts who are also StillHere users, enabling push notifications and a watcher dashboard for monitoring.
- **Security:** Comprehensive measures including HTTP headers, global API rate limiting, robust input validation, PII-free server logs, and bank-level security hardening (e.g., HSTS, Permissions-Policy, content-type enforcement, OTP hashing).
- **PWA Support:** Full Progressive Web App capabilities for offline support and installability.
- **Wearable API:** Dedicated API endpoints support companion watch apps (Apple Watch, Wear OS) for quick check-ins and status updates.
- **Internationalization:** E.164 phone number normalization supports 28+ countries.
- **Apple Watch Companion App:** A SwiftUI watchOS app provides one-tap check-in, SOS, and a custom 2-phase fall detection algorithm. It uses WatchConnectivity for iPhone relay and WidgetKit for watch face complications.

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