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
- **In-App Banners:** Real-time status banners on the home page display alert status, contact handling, and notification progress.
- **Haptic Feedback:** Implemented for check-in and SOS actions on supported devices to provide tactile confirmation.

**Technical Implementations:**
- **Frontend:** Built with React, TypeScript, Tailwind CSS, and shadcn/ui, utilizing `wouter` for routing and `TanStack Query` for data fetching.
- **Backend:** Powered by Express.js, integrating Helmet for security headers and `express-rate-limit` for API rate limiting.
- **Database:** PostgreSQL managed with Drizzle ORM.
- **Authentication:** Phone OTP (One-Time Password) login via SMS, with sessions lasting 30 days using httpOnly secure cookies. Rate limiting is applied to OTP requests and verification attempts.
- **Check-in Mechanism:** Users can manually check-in or opt for automatic check-ins upon opening the app.
- **Emergency System:** Configurable check-in schedules, grace periods before alerts, and reminders. An SOS alert button provides immediate notification.
- **Escalation System:** A sequential escalation system notifies emergency contacts (priority 1 then 2) and subsequently the user if no response is received, with re-notification for unaddressed incidents.
- **Location Sharing:** Optional, user-controlled location sharing.
- **Push Notifications:** Web push notifications are used for reminders to reduce SMS costs, with an "I'm OK" action button for one-tap check-ins directly from the notification. A service worker handles push events and offline capabilities.
- **Security:** Comprehensive security measures including Helmet.js for HTTP headers, global API rate limiting, cron job security (`x-cron-secret`), and robust input validation.
- **PWA Support:** Full Progressive Web App capabilities, including a manifest, service worker for caching and offline support, and installability.
- **Wearable API:** Dedicated API endpoints for companion watch apps (Apple Watch, Wear OS) using Bearer token authentication for quick check-ins and minimal status updates.

**Feature Specifications:**
- **User Management:** Phone OTP authentication, user profiles, and settings.
- **Check-in Features:** Manual "I'm OK" button, optional auto check-in on app open, configurable schedules (12-48+ hours), grace periods (10-30 min), and configurable reminders (none, one, or two).
- **Emergency Management:** SOS alert button, up to 2 emergency contacts with priority levels, token-based contact pages for status viewing, responsibility system for contacts to pause escalation, and location sharing.
- **Notifications:** SMS and web push notifications for reminders and alerts.
- **Account Security:** OTP rate limiting, phone number normalization for various countries, and staging environment whitelisting.

### External Dependencies
- **SMS Gateway:** Twilio (for sending SMS messages)
- **Push Notifications:** `web-push` library (for VAPID-based web push notifications)
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