# StillHere - Safety Check-in App

A safety check-in application similar to the Chinese "Are You Dead?" (死了吗) app. Helps elderly, solo dwellers, and lone workers stay connected with their emergency contacts through simple daily check-ins.

## Overview

StillHere is a calm, reassuring safety app with an extremely simple UX. Users tap a big green "I'm OK" button to confirm they're safe. If they miss a check-in, their emergency contacts are notified with a link to view their status and take action.

## Features

- **Simple Check-in**: Big green "I'm OK" button for daily check-ins
- **Auto Check-in**: Optional - opening the app counts as a check-in (toggle in settings)
- **SOS Alert**: Red "I Need Help" button for immediate emergency notification
- **Configurable Schedule**: Check-in intervals from 12 hours to 48+ hours
- **Grace Period**: 10-30 minute buffer before alerting contacts
- **Reminders**: Configurable reminders (none, one, or two) sent before alerting contacts
- **Emergency Contacts**: Up to 2 contacts with priority levels
- **Location Sharing**: Optional, user-controlled location sharing
- **Contact Pages**: Token-based pages for contacts to view status and take action
- **Responsibility System**: Contacts can take responsibility, pausing escalation
- **Phone OTP Authentication**: Secure passwordless login via SMS codes
- **Push Notifications**: Web push reminders (reduces SMS costs)
- **Haptic Feedback**: Vibration on check-in and SOS actions (supported devices)
- **Trust & Safety Page**: Comprehensive transparency statement

## Security

### Helmet Security Headers
Express Helmet middleware provides:
- Content Security Policy (CSP)
- HTTP Strict Transport Security (HSTS)
- X-Content-Type-Options
- X-Frame-Options
- X-XSS-Protection
- Referrer Policy

### Global API Rate Limiting
- 100 requests per 15 minutes per IP on all `/api/` routes
- Health check endpoint is exempt from rate limiting
- OTP send rate limiting: 1/60s, 5/hour per phone number
- OTP verify rate limiting: 5 attempts per 10 minutes per phone (brute-force protection)

### Cron Security
- `/api/cron/tick` requires `x-cron-secret` header matching `SESSION_SECRET`
- External calls without the secret receive 403 Forbidden
- Only the built-in internal scheduler has the secret

### Input Validation
- Settings: range checks on intervals (12-48h), grace (10-30min), enum validation
- SOS: duplicate incident prevention (returns existing if active)
- Contacts: Contact 1 required, phone normalization applied

## Pages

1. `/` - Home page with check-in buttons and status (protected)
2. `/login` - Phone number entry for OTP login
3. `/login/code` - OTP code verification
4. `/setup` - 4-screen onboarding flow for new users
5. `/setup/name` - Name entry to complete setup
6. `/settings` - Check-in schedule, contacts, location, pause alerts, auto check-in (protected)
7. `/help` - FAQ explaining how the app works (public)
8. `/trust` - Trust & Safety statement (public)
9. `/emergency/:token` - Contact status page (public, no login required)

## Onboarding Flow

New users see a 4-screen onboarding before setup:
1. **Welcome**: "StillHere helps your family know you're okay"
2. **How it works**: Check in, notify contacts, human-first escalation
3. **You stay in control**: Location OFF by default, you choose contacts
4. **Let's get started**: Begins name entry setup

After onboarding, users complete a 3-step registration:
1. `/setup/name` - Enter their name (how they appear to contacts)
2. `/setup/contacts` - Add at least one emergency contact (required)
3. `/setup/preferences` - Choose check-in frequency and location sharing

Users cannot access the home page until all three steps are completed.

## Authentication

### Phone OTP Login
- Users enter their phone number on `/login`
- 6-digit OTP code is sent (currently logged to console for development)
- OTP expires in 10 minutes, marked as used after verification
- Sessions last 30 days with httpOnly secure cookies

### Rate Limiting
- 1 OTP request per 60 seconds per phone number
- Maximum 5 OTP requests per hour per phone number
- Stored in `otp_rate_limits` table

### Staging Environment
- `APP_ENV` variable controls environment (staging/production)
- `WHITELIST_NUMBERS` (comma-separated E.164) limits who can sign in during staging
- Non-whitelisted numbers see "This version is in private testing" message

### Phone Normalization
- Australian numbers: `0412345678` becomes `+61412345678`
- Numbers starting with 0 get +61 prefix

## API Endpoints

### Auth Routes (public)
- `POST /api/auth/send-code` - Send OTP to phone
- `POST /api/auth/verify-code` - Verify OTP and create session
- `GET /api/auth/me` - Get current auth status
- `POST /api/auth/logout` - End session

### Protected Routes (require auth)
- `GET /api/status` - Get user status, settings, and next check-in time
- `POST /api/checkin` - Record a check-in
- `POST /api/sos` - Trigger SOS alert
- `POST /api/settings` - Update settings (including autoCheckin)
- `POST /api/settings/pause` - Pause alerts temporarily
- `POST /api/contacts` - Save emergency contacts
- `POST /api/test` - Send test notification
- `POST /api/setup` - Complete user setup (name)
- `POST /api/location/update` - Update location
- `POST /api/push/subscribe` - Save push notification subscription
- `POST /api/push/unsubscribe` - Remove push subscription

### Public Routes
- `GET /api/emergency/:token` - Get contact page data
- `POST /api/emergency/:token/handle` - Contact takes responsibility
- `POST /api/emergency/:token/escalate` - Contact escalates alert
- `GET /api/cron/tick` - Check for overdue users (also called by built-in scheduler)
- `GET /api/push/vapid-key` - Get VAPID public key for push subscriptions
- `GET /api/health` - Health check

## Contact Token Security

- Tokens are 10 characters (mixed case alphanumeric, URL-safe)
- Tokens expire after 30 days
- Tokens are rotated when contacts are edited or removed
- Revoked tokens are rejected
- Example URL: `https://stillhere.health/emergency/9FkaP2Lm8Q`

## Database Tables

### Auth Tables
- `auth_sessions` - Session tokens with expiry
- `otp_codes` - Phone verification codes
- `otp_rate_limits` - Rate limiting records

### App Tables
- `users` - User profiles
- `settings` - Check-in preferences (includes `auto_checkin` boolean)
- `contacts` - Emergency contacts
- `contact_tokens` - Access tokens for contact pages
- `checkins` - Check-in records (method: "button" or "auto")
- `incidents` - Alert incidents
- `location_sessions` - Location sharing sessions
- `push_subscriptions` - Web push notification subscriptions

## Tech Stack

- Frontend: React + TypeScript + Tailwind CSS + shadcn/ui
- Backend: Express.js + Helmet + express-rate-limit
- Database: PostgreSQL with Drizzle ORM
- Routing: wouter
- Data fetching: TanStack Query
- Push: web-push (VAPID)
- SMS: Twilio

## Color Theme

- Primary: Blue (#0ea5e9) - Trust and safety
- Accent: Green (#22c55e) - Positive "I'm OK" actions
- Destructive: Red (#ef4444) - SOS and alerts

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret for session signing
- `BASE_URL` - Base URL for SMS links (default: `https://stillhere.health`)
- `APP_ENV` - Environment mode (staging/production)
- `WHITELIST_NUMBERS` - Comma-separated E.164 phone numbers for staging
- `TWILIO_ACCOUNT_SID` - Twilio Account SID for SMS
- `TWILIO_AUTH_TOKEN` - Twilio Auth Token for SMS
- `TWILIO_PHONE_NUMBER` - Twilio phone number (E.164 format)
- `TWILIO_ALPHA_SENDER` - Alpha sender ID (e.g., "StillHere")
- `VAPID_PUBLIC_KEY` - VAPID public key for web push
- `VAPID_PRIVATE_KEY` - VAPID private key for web push
- `VAPID_SUBJECT` - VAPID subject (default: `mailto:support@stillhere.health`)

## Built-in Cron Scheduler

The server runs a built-in cron scheduler that calls `/api/cron/tick` every 2 minutes via `setInterval`. No external scheduler is needed. The endpoint is also available for manual triggering.

The cron handles:
- Sending reminders to overdue users (SMS + push notifications)
- Creating incidents for users past their grace period
- Escalation: Contact 1 → Contact 2 (after 20 min) → user banner (after 20 min)
- Handling timeout re-notifications (after 45 min)

## Push Notifications

Web push notifications reduce SMS costs by sending check-in reminders via the browser:
- Users see a prompt on the home page to enable notifications
- Notifications include an "I'm OK" action button for one-tap check-in
- VAPID keys required (generate with `npx web-push generate-vapid-keys`)
- Falls back gracefully when not configured

### Service Worker
- Handles push events with native notification display
- "I'm OK" action from notification auto-triggers check-in via API
- Click opens the app to the relevant page

## Haptic Feedback

- Check-in button: 50ms vibration on success
- SOS button: Pattern vibration (100-50-100-50-200ms) on alert sent
- Auto check-in: 30ms subtle vibration
- Graceful no-op on devices without vibration support

## Auto Check-in

Users can enable "Check in when I open the app" in settings:
- Opening the home page automatically triggers a check-in
- Uses "auto" method in the checkins table (vs "button" for manual)
- Includes subtle haptic feedback
- Only triggers once per page load (ref-guarded)
- Skipped if there's an active incident

## SMS Configuration

StillHere uses Twilio for sending SMS messages. If Twilio credentials are not configured, messages are logged to the console instead.

### Supported Countries
- Australia (+61)
- USA/Canada (+1)
- UK (+44)
- France (+33), Germany (+49), Italy (+39), Spain (+34)
- Netherlands (+31), Belgium (+32), Austria (+43), Switzerland (+41)
- Ireland (+353), Poland (+48), Sweden (+46), Norway (+47), Denmark (+45)
- Finland (+358), Portugal (+351), Greece (+30)

### Phone Number Normalization
Local formats are auto-normalized for these countries:
- Australian mobile: `0412345678` → `+61412345678`
- Australian landline: `02/03/07/08 XXXX XXXX` → `+61...`
- UK mobile: `07123456789` → `+447123456789`
- US/Canada: `4155551234` (10 digits) → `+14155551234`
- US/Canada: `14155551234` (11 digits) → `+14155551234`

For EU countries, users must enter the full international format with `+` prefix (e.g., `+33 6 12 34 56 78` for France).

## Running the App

The app runs on port 5000 with `npm run dev`. 

For testing:
- If Twilio is not configured, OTP codes are logged to the console
- Contact page URLs are logged when contacts are saved
- Check server logs for debugging

## Escalation System

StillHere uses a sequential escalation system to ensure someone responds to alerts:

### How It Works

1. **Initial Alert (Contact 1 only)**
   - When SOS is pressed or a check-in is missed, only Contact 1 (priority 1) is notified
   - A 20-minute timer starts

2. **Escalation to Contact 2 (if no response)**
   - If Contact 1 doesn't respond within 20 minutes, Contact 2 is automatically notified
   - Another 20-minute timer starts

3. **User Notification (if no contacts respond)**
   - If neither contact responds, the user sees an in-app status banner (no SMS)
   - Banner: "No contacts have responded yet"

4. **Handling Timeout (45 minutes)**
   - If a contact clicks "I'm handling this" but doesn't resolve within 45 minutes
   - All contacts are re-notified with a follow-up message

### In-App Status Banners

The home page shows real-time escalation status banners:
- **Alert active (open)**: Amber banner with step-by-step contact notification progress
- **Contact handling (paused)**: Blue banner showing "{Contact Name} is checking on you"
- **No response**: Warning that no contacts have responded yet
- Auto-refreshes every 15 seconds during active incidents (60 seconds otherwise)

## Reminder System

Users can configure how many reminders they receive before their emergency contacts are notified:
- **None**: No reminders, contacts are alerted immediately after the grace period
- **One (recommended)**: One reminder during the grace period
- **Two**: Two reminders during the grace period

Reminders are sent via both SMS and push notifications (if enabled). Throttled to 5 minutes minimum between reminders.

## PWA (Progressive Web App)

StillHere is a fully installable PWA with offline support:

- **Manifest**: `/manifest.json` with app metadata and icons
- **Service Worker**: `/sw.js` caches static assets, handles push notifications, network-first for API calls
- **Icons**: 8 sizes (72px to 512px) in `/icons/`
- **Install**: Users can add to home screen from browser

## Native App Build (Capacitor)

StillHere uses Capacitor for native iOS and Android builds.

### Configuration
- `capacitor.config.json` - App ID: `com.stillhere.app`
- Web directory: `dist/public`
- Splash screen: Blue (#0ea5e9) with 2s duration

### Build Steps

1. **Install Capacitor** (on your local machine, not Replit):
   ```bash
   npm install @capacitor/core @capacitor/cli
   npm install @capacitor/ios @capacitor/android
   ```

2. **Build the web app**: `npm run build`
3. **Initialize platforms**: `npx cap add ios && npx cap add android`
4. **Sync web assets**: `npx cap sync`
5. **Open in IDE**: `npx cap open ios` or `npx cap open android`

## Future Enhancements (planned)

- Biometric unlock (Face ID / fingerprint) after first login
- Apple Watch / wearable integration
- Fall detection via device sensors
- Professional dispatcher/monitoring service
