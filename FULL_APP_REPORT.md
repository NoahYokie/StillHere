# StillHere - Full Application Report

**Generated:** April 2026
**Version:** 1.0.0

---

## 1. Executive Summary

StillHere is a safety check-in application designed for elderly individuals, solo dwellers, and lone workers. Users confirm their safety daily with a single tap. If a check-in is missed, the system automatically alerts emergency contacts through an escalating notification chain. The app includes SOS alerts, fall detection, in-app messaging, video calling, and a watcher dashboard for emergency contacts.

**Codebase:** ~15,700 lines of TypeScript/TSX/CSS across 86 source files
**Stack:** React + Express.js + PostgreSQL + Capacitor (iOS/Android)
**Status:** Web app deployed and operational. iOS App Store submission ready (pending Xcode build on Mac).

---

## 2. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | React + TypeScript | 18.3 |
| Styling | Tailwind CSS + shadcn/ui | 3.4 |
| Routing | wouter | 3.3 |
| Data Fetching | TanStack Query | v5 |
| Backend | Express.js | 5.0 |
| Database | PostgreSQL + Drizzle ORM | - |
| Auth | Passkey (WebAuthn) + Phone OTP | - |
| SMS | Twilio | 5.11 |
| Push | web-push (VAPID) | 3.6 |
| Real-time | Socket.IO | 4.8 |
| Video Calls | WebRTC (with Twilio TURN) | - |
| Mobile | Capacitor v8 | 8.3 |
| Security | Helmet + express-rate-limit | - |

**Total dependencies:** ~105 packages (including dev)

---

## 3. Architecture Overview

```
Browser / Native App (Capacitor)
    |
    +-- React SPA (wouter routing, TanStack Query)
    |       |
    |       +-- Socket.IO client (real-time chat + call signaling)
    |       +-- WebRTC (peer-to-peer video/audio)
    |       +-- Service Worker (push notifications, offline caching)
    |
    +-- Express.js API Server (port 5000)
            |
            +-- PostgreSQL (15 tables, Drizzle ORM)
            +-- Twilio (SMS notifications)
            +-- web-push (browser push notifications)
            +-- Socket.IO server (real-time events)
            +-- Cron scheduler (every 2 minutes)
```

**Build System:**
- Development: Vite dev server proxied through Express
- Production: Vite builds SPA to `dist/public/`, Express serves static files
- Mobile: Capacitor wraps the built SPA for iOS/Android

---

## 4. Database Schema

**15 tables** in PostgreSQL:

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| `users` | User profiles (name, phone, timezone, premium flag) | Central entity |
| `settings` | Check-in preferences per user (1:1 with users) | FK to users |
| `contacts` | Emergency contacts with priority levels | FK to users, optional FK to linked user |
| `contact_tokens` | Unique tokens for emergency contact status pages | FK to contacts |
| `checkins` | Check-in history log | FK to users |
| `incidents` | Active/resolved emergency incidents | FK to users, FK to handling contact |
| `auth_sessions` | Login session tokens (30-day expiry) | FK to users |
| `otp_codes` | One-time password codes (10-min expiry) | Indexed by phone |
| `otp_rate_limits` | OTP request throttling records | Indexed by phone |
| `push_subscriptions` | Web push notification endpoints | FK to users |
| `location_sessions` | GPS location tracking during emergencies | FK to users, FK to incidents |
| `messages` | In-app chat messages | FK sender/receiver to users |
| `calls` | Video/audio call records | FK caller/receiver to users |
| `voip_tokens` | Native VoIP push tokens (iOS/Android) | FK to users |
| `passkeys` | WebAuthn/FIDO2 credential storage | FK to users |

**Custom enums:** location_mode, reminder_mode, incident_status, incident_reason, location_session_type, checkin_method, call_status, call_type

---

## 5. API Endpoints

**35 API endpoints** organized by function:

### Authentication (6 endpoints)
| Method | Path | Auth | Rate Limited |
|--------|------|------|-------------|
| POST | `/api/auth/send-code` | Public | 10/15min |
| POST | `/api/auth/verify-code` | Public | 10/15min + 5 attempts/10min |
| GET | `/api/auth/me` | Session | Global |
| POST | `/api/auth/logout` | Session | Global |
| POST | `/api/auth/passkey/register-options` | Session | Global |
| POST | `/api/auth/passkey/register-verify` | Session | Global |
| POST | `/api/auth/passkey/auth-options` | Public | 10/15min |
| POST | `/api/auth/passkey/auth-verify` | Public | 10/15min |
| GET | `/api/auth/passkeys` | Session | Global |
| DELETE | `/api/auth/passkeys/:id` | Session | Global |

### Core Safety (4 endpoints)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/status` | Session | Current safety status |
| POST | `/api/checkin` | Session | Record check-in |
| POST | `/api/sos` | Session | Trigger SOS alert |
| POST | `/api/resolve-alert` | Session | Resolve active incident |

### Settings & Contacts (5 endpoints)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/settings` | Session | Update preferences |
| GET | `/api/contacts` | Session | List contacts |
| POST | `/api/contacts` | Session | Add contact |
| PUT | `/api/contacts/:id` | Session | Update contact |
| DELETE | `/api/contacts/:id` | Session | Remove contact |

### Emergency (3 endpoints)
| Method | Path | Auth | Rate Limited |
|--------|------|------|-------------|
| GET | `/api/emergency/session/:token` | Token | 30/15min |
| POST | `/api/emergency/respond/:token` | Token | 30/15min |
| POST | `/api/emergency/escalate/:token` | Token | 30/15min |

### Communication (5 endpoints)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/messages/unread/count` | Session | Unread count |
| GET | `/api/messages/:userId` | Session | Chat history |
| POST | `/api/messages/:userId` | Session | Send message |
| POST | `/api/messages/:userId/read` | Session | Mark as read |
| GET | `/api/watched-users` | Session | Monitored users list |

### Push & VoIP (5 endpoints)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/push/vapid-key` | Public | VAPID public key |
| POST | `/api/push/subscribe` | Session | Save push subscription |
| POST | `/api/push/unsubscribe` | Session | Remove subscription |
| POST | `/api/voip-token` | Session | Register VoIP token |
| DELETE | `/api/voip-token` | Session | Remove VoIP token |

### System (3 endpoints)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | Public | Health check |
| GET | `/api/cron/tick` | Secret header | Background processing |
| GET | `/api/turn-credentials` | Session | WebRTC TURN servers |

---

## 6. Frontend Pages

**16 pages** across 4 categories:

### Core App (5 pages)
- **Home** (`/`) - Main check-in dashboard with "I'm OK" button, SOS button, incident banners, quote of the day
- **Settings** (`/settings`) - Full settings: check-in schedule, contacts management, fall detection, passkey management, location sharing
- **Watched** (`/watched`) - Watcher dashboard for monitoring people who listed you as a contact
- **Help** (`/help`) - FAQ and support information
- **Trust** (`/trust`) - Privacy and security commitment page

### Authentication & Onboarding (6 pages)
- **Landing** (`/`) - Marketing page for unauthenticated users
- **Login** (`/login`) - Phone number entry with passkey option
- **Login Code** (`/login/code`) - OTP verification + passkey setup prompt
- **Onboarding** (`/setup`) - 4-screen introductory slider
- **Setup Name** (`/setup/name`) - Enter display name
- **Setup Contacts** (`/setup/contacts`) - Add emergency contacts
- **Setup Preferences** (`/setup/preferences`) - Configure check-in schedule

### Communication (2 pages)
- **Chat** (`/chat/:userId`) - Real-time messaging with read receipts
- **Call** (`/call/:userId`) - WebRTC video calling with camera controls

### Emergency (1 page)
- **Contact** (`/emergency/:token`) - Token-authenticated status page for emergency contacts with "I'm handling this" and "Escalate" actions

---

## 7. Key Features

### 7.1 Check-in System
- Manual "I'm OK" one-tap check-in
- Optional auto check-in when opening the app
- Configurable intervals: 12-48+ hours
- Grace period: 10-30 minutes before alerting
- Configurable reminders: none, one, or two
- Quote of the day displayed after check-in (125 rotating quotes)

### 7.2 Emergency Escalation
- Sequential escalation through top 5 contacts by priority (20 min each)
- After top 5 exhausted, blast-notify all remaining contacts simultaneously
- Contacts can claim "I'm handling this" to pause escalation (45 min)
- Contacts can manually escalate to next person
- Re-notification if nobody responds
- In-app banner shows real-time escalation status

### 7.3 SOS Alert
- Immediate emergency notification to first contact
- Creates emergency location sharing session
- Full escalation chain follows

### 7.4 Fall Detection
- Uses DeviceMotion API (accelerometer)
- Detects high-G impact followed by stillness
- Shows 60-second countdown dialog before auto-triggering SOS
- User can cancel during countdown
- Toggle on/off in settings

### 7.5 Authentication
- **Primary:** Passkey/WebAuthn (Face ID, Touch ID, fingerprint, screen lock)
- **Fallback:** Phone OTP via SMS
- After first OTP login, prompts passkey registration
- Sessions last 30 days (httpOnly secure cookies)
- Passkey challenge bound to server-side cookies (prevents replay attacks)

### 7.6 In-App Messaging
- Real-time chat via Socket.IO
- Message persistence in database
- Read receipts
- Push notification for offline users
- Relationship-gated (only between linked users/contacts)

### 7.7 Video Calling
- WebRTC with relay-first architecture
- Twilio TURN servers for NAT/firewall traversal
- Full ICE gathering (candidates baked into SDP)
- Camera toggle, mute, camera flip
- Incoming call overlay with ringtone
- 45-second ring timeout
- ICE restart on disconnect/network change

### 7.8 Watcher Dashboard
- Emergency contacts who have the app see monitored users
- Shows: name, last check-in time, status (OK/overdue/alert)
- Quick action buttons: message, video call

### 7.9 Smart Notification Routing
- Contacts with the app: push notification + in-app message
- Contacts without the app: SMS via Twilio
- Reduces SMS costs while enabling richer communication

### 7.10 Premium Tier
- Free: 2 emergency contacts max
- Premium (`isPremium` flag): unlimited contacts with full escalation

---

## 8. Security Measures

### Rate Limiting
| Scope | Limit | Window |
|-------|-------|--------|
| Global API | 100 requests | 15 min |
| Auth endpoints | 10 requests | 15 min |
| OTP verification | 5 attempts | 10 min |
| OTP requests | 5 per phone | 1 hour |
| OTP cooldown | 1 per phone | 60 sec |
| Emergency endpoints | 30 requests | 15 min |

### HTTP Security Headers (Helmet)
- Content-Security-Policy with strict directives
- `frame-ancestors: 'none'` (clickjacking prevention)
- `object-src: 'none'`
- `base-uri: 'self'`
- `form-action: 'self'`
- Referrer-Policy: `strict-origin-when-cross-origin`

### Authentication Security
- Cryptographically secure OTP (6-digit, `crypto.randomBytes`)
- 10-minute OTP expiry, single-use enforcement
- Passkey challenge-response with server-side cookie binding
- Authenticator counter tracking (clone detection)
- 30-day session expiry with httpOnly + secure cookies

### Log Security (PII-Free)
- All user names redacted from server logs
- All phone numbers masked to last 4 digits (`***XXXX`)
- Emergency tokens redacted from request path logs
- SMS message bodies never logged
- No OTP codes in logs

### Other
- Cron endpoint protected by `SESSION_SECRET` (no fallback)
- Messaging gated by user relationship verification
- Contact tokens have 30-day expiry + revoke capability
- Phone number normalization (E.164) for 28+ countries
- Trust proxy enabled for deployment behind reverse proxy

---

## 9. Infrastructure & Deployment

### Production
- Deployed on Replit with auto-scaling
- PostgreSQL database (Replit-managed)
- Express server serves both API and static SPA
- Service worker for offline caching and push notifications

### PWA Support
- Web App Manifest (`manifest.json`)
- Service worker with network-first caching strategy
- Installable on mobile devices
- Push notification support with "I'm OK" action button

### iOS App Store Readiness
- Capacitor v8 packages installed and aligned
- Native plugin initialization (StatusBar, SplashScreen, Keyboard, App)
- iOS safe area CSS for notch devices
- All 13 iOS icon sizes generated (20px to 1024px)
- Xcode asset catalog mapping ready
- Complete build guide at `ios-app-store/IOS_BUILD_GUIDE.md`
- Build flow: `npm run build` > `npx cap sync ios` > Xcode Archive > Submit

### Background Processing
- Built-in cron scheduler runs every 2 minutes
- Checks for overdue users
- Sends reminders (throttled)
- Manages escalation chain timing
- Protected by `x-cron-secret` header

---

## 10. External Service Dependencies

| Service | Purpose | Required |
|---------|---------|----------|
| Twilio SMS | Send OTP codes, alert notifications | Yes (for production SMS) |
| Twilio TURN | WebRTC relay servers for video calls | Optional (improves call reliability) |
| PostgreSQL | Primary data store | Yes |
| Web Push (VAPID) | Browser push notifications | Auto-configured |
| APNs (Apple) | iOS native push notifications | For iOS native app |
| FCM (Google) | Android native push notifications | For Android native app |

### Environment Variables Required
| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | Session signing + cron authentication |
| `DATABASE_URL` | PostgreSQL connection string |
| `TWILIO_ACCOUNT_SID` | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | Twilio API authentication |
| `TWILIO_PHONE_NUMBER` | SMS sender phone number |
| `TWILIO_ALPHA_SENDER` | Optional alphanumeric sender ID |

---

## 11. File Structure

```
stillhere/
+-- client/
|   +-- src/
|   |   +-- App.tsx                    (root routing + initialization)
|   |   +-- main.tsx                   (entry point + service worker registration)
|   |   +-- index.css                  (theme + safe areas)
|   |   +-- pages/                     (16 page components)
|   |   +-- components/
|   |   |   +-- incoming-call.tsx      (call overlay)
|   |   |   +-- ui/                    (47 shadcn/ui components)
|   |   +-- lib/
|   |       +-- auth.tsx               (auth context + guards)
|   |       +-- capacitor.ts           (native plugin init)
|   |       +-- fall-detection.ts      (accelerometer fall detection)
|   |       +-- native-call.ts         (CallKit/ConnectionService)
|   |       +-- queryClient.ts         (TanStack Query config)
|   |       +-- quotes.ts             (125 daily quotes)
|   |       +-- ringtone.ts           (Web Audio ringtone synthesis)
|   |       +-- socket.ts             (Socket.IO client)
|   |       +-- webrtc.ts             (WebRTC peer connection)
|   |       +-- utils.ts              (class name utilities)
|   +-- public/
|       +-- manifest.json              (PWA manifest)
|       +-- sw.js                      (service worker)
|       +-- icons/                     (PWA icons)
|       +-- ios-icons/                 (13 iOS icon sizes)
+-- server/
|   +-- index.ts                       (Express server + security middleware)
|   +-- routes.ts                      (all API routes + cron logic)
|   +-- storage.ts                     (database interface + implementation)
|   +-- auth.ts                        (OTP + session management)
|   +-- sms.ts                         (Twilio SMS + TURN credentials)
|   +-- socket.ts                      (Socket.IO server)
|   +-- push.ts                        (web push notifications)
|   +-- voip-push.ts                   (APNs + FCM native push)
|   +-- vite.ts                        (Vite dev server middleware)
|   +-- static.ts                      (production static file serving)
+-- shared/
|   +-- schema.ts                      (Drizzle schema + Zod validators)
+-- ios-app-store/
|   +-- IOS_BUILD_GUIDE.md             (App Store submission guide)
|   +-- AppIcon-Contents.json          (Xcode asset catalog)
+-- capacitor.config.json              (Capacitor mobile config)
+-- package.json
+-- vite.config.ts
+-- drizzle.config.ts
+-- tsconfig.json
+-- tailwind.config.ts
```

---

## 12. Known Limitations & Future Considerations

### Current Limitations
1. **Passkey challenge store is in-memory** - Works for single-instance deployments only; would need Redis/database for multi-instance scaling
2. **No email notifications** - Currently SMS and push only
3. **Premium gating is flag-based** - No payment integration yet (Stripe/RevenueCat ready to add)
4. **Watch companion apps** - Config stubs exist but apps not built
5. **iOS native project not generated** - Requires Mac with Xcode to complete (`npx cap add ios`)

### Phone Number Coverage
International phone normalization supports 28+ countries: US, UK, AU, CA, NZ, JP, KR, SG, IN, FR, DE, IT, ES, NL, BE, CH, IE, SE, NO, DK, CZ, HU, RO, HR, and more.

### Scalability Notes
- Database queries are indexed on common lookups (userId, phone, token)
- Cron processes all overdue users in a single sweep (may need partitioning at scale)
- Socket.IO is single-server; would need Redis adapter for horizontal scaling
- SMS costs scale linearly with users; push notifications reduce this

---

## 13. Summary Statistics

| Metric | Value |
|--------|-------|
| Total source lines | ~15,700 |
| Frontend pages | 16 |
| UI components | 48 |
| Utility modules | 10 |
| Server modules | 11 |
| API endpoints | 35 |
| Database tables | 15 |
| Custom enums | 8 |
| NPM packages | ~105 |
| Supported countries | 28+ |
| Daily quotes | 125 |
| iOS icon sizes | 13 |
