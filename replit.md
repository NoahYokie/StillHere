# StillHere - Safety Check-in App

A safety check-in application similar to the Chinese "Are You Dead?" (死了吗) app. Helps elderly, solo dwellers, and lone workers stay connected with their emergency contacts through simple daily check-ins.

## Overview

StillHere is a calm, reassuring safety app with an extremely simple UX. Users tap a big green "I'm OK" button to confirm they're safe. If they miss a check-in, their emergency contacts are notified with a link to view their status and take action.

## Features

- **Simple Check-in**: Big green "I'm OK" button for daily check-ins
- **SOS Alert**: Red "I Need Help" button for immediate emergency notification
- **Configurable Schedule**: Check-in intervals from 12 hours to 48+ hours
- **Grace Period**: 10-30 minute buffer before alerting contacts
- **Reminders**: Configurable reminders (none, one, or two) sent before alerting contacts
- **Emergency Contacts**: Up to 2 contacts with priority levels
- **Location Sharing**: Optional, user-controlled location sharing
- **Contact Pages**: Token-based pages for contacts to view status and take action
- **Responsibility System**: Contacts can take responsibility, pausing escalation
- **Phone OTP Authentication**: Secure passwordless login via SMS codes
- **Trust & Safety Page**: Comprehensive transparency statement

## Pages

1. `/` - Home page with check-in buttons and status (protected)
2. `/login` - Phone number entry for OTP login
3. `/login/code` - OTP code verification
4. `/setup` - 4-screen onboarding flow for new users
5. `/setup/name` - Name entry to complete setup
6. `/settings` - Check-in schedule, contacts, location, pause alerts (protected)
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
- `POST /api/settings` - Update settings
- `POST /api/settings/pause` - Pause alerts temporarily
- `POST /api/contacts` - Save emergency contacts
- `POST /api/test` - Send test notification
- `POST /api/setup` - Complete user setup (name)
- `POST /api/location/update` - Update location

### Public Routes
- `GET /api/emergency/:token` - Get contact page data
- `POST /api/emergency/:token/handle` - Contact takes responsibility
- `POST /api/emergency/:token/escalate` - Contact escalates alert
- `GET /api/cron/tick` - Check for overdue users (scheduler)

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
- `settings` - Check-in preferences
- `contacts` - Emergency contacts
- `contact_tokens` - Access tokens for contact pages
- `checkins` - Check-in records
- `incidents` - Alert incidents
- `location_sessions` - Location sharing sessions

## Tech Stack

- Frontend: React + TypeScript + Tailwind CSS + shadcn/ui
- Backend: Express.js
- Database: PostgreSQL with Drizzle ORM
- Routing: wouter
- Data fetching: TanStack Query

## Color Theme

- Primary: Blue (#0ea5e9) - Trust and safety
- Accent: Green (#22c55e) - Positive "I'm OK" actions
- Destructive: Red (#ef4444) - SOS and alerts

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret for session signing
- `APP_ENV` - Environment mode (staging/production)
- `WHITELIST_NUMBERS` - Comma-separated E.164 phone numbers for staging
- `TWILIO_ACCOUNT_SID` - Twilio Account SID for SMS
- `TWILIO_AUTH_TOKEN` - Twilio Auth Token for SMS
- `TWILIO_PHONE_NUMBER` - Twilio phone number (E.164 format)

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

## SMS Message Templates

Messages sent to emergency contacts follow these templates:

**Missed Check-in:**
```
StillHere alert:
{Name} hasn't checked in yet.
Tap here to see their status and check on them:
{secure link}
```

**SOS Button Pressed:**
```
StillHere alert:
{Name} has asked for help.
Please check on them now:
{secure link}
```

**Test Message:**
```
StillHere test:
This is a test message from {Name}.
No action is needed.
```

**Reminder (sent to user):**
```
StillHere reminder:
You haven't checked in yet.
Tap below to let us know you're OK:
{link to home page}
```

## Reminder System

Users can configure how many reminders they receive before their emergency contacts are notified:
- **None**: No reminders, contacts are alerted immediately after the grace period
- **One (recommended)**: One reminder during the grace period
- **Two**: Two reminders during the grace period

Reminders are throttled to prevent spamming (minimum 5 minutes between reminders). If the grace period expires, contacts are alerted regardless of how many reminders were sent.

Reminder state (remindersSent, lastReminderAt) is reset when:
- User checks in
- An incident is created

## Escalation System

StillHere uses a sequential escalation system to ensure someone responds to alerts:

### How It Works

1. **Initial Alert (Contact 1 only)**
   - When SOS is pressed or a check-in is missed, only Contact 1 (priority 1) is notified
   - A 20-minute timer starts

2. **Escalation to Contact 2 (if no response)**
   - If Contact 1 doesn't respond within 20 minutes, Contact 2 is automatically notified
   - Another 20-minute timer starts
   - SMS: "{Name} {reason} and the first contact hasn't responded. Please check on them: {link}"

3. **User Notification (if no contacts respond)**
   - If neither contact responds, the user sees an in-app status banner (no SMS)
   - Banner: "No contacts have responded yet"

4. **Handling Timeout (45 minutes)**
   - If a contact clicks "I'm handling this" but doesn't resolve the alert within 45 minutes
   - All contacts are re-notified with a follow-up message
   - SMS: "Follow-up: {Name}'s alert is still active. Please confirm you've reached them: {link}"

### Contact Response Flow

When a contact clicks "I'm handling this":
1. The incident status changes to "paused"
2. The user sees an in-app banner: "{Contact Name} is checking on you" (no SMS)
3. A 45-minute timer starts
4. If resolved within 45 min, escalation ends
5. If not resolved, all contacts are re-notified

When the user clicks "I'm OK now":
1. The incident is resolved
2. All contacts receive an SMS: "{Name} is OK now. No action needed."

### In-App Status Banners

The home page shows real-time escalation status banners (replacing user-facing SMS to reduce costs):
- **Alert active (open)**: Shows which contacts have been notified with step-by-step progress
- **Contact handling (paused)**: Blue banner showing "{Contact Name} is checking on you"
- **No response**: Warning that no contacts have responded yet
- Auto-refreshes every 15 seconds during active incidents (60 seconds otherwise)

SMS is reserved for emergency contact notifications only:
- Initial alerts to contacts (SOS or missed check-in)
- Escalation to Contact 2 (after 20 min)
- Handling timeout re-notifications
- "All clear" when user resolves alert
- Check-in reminders to user (essential - user not in app)

### Database Fields (incidents table)

- `escalationLevel` - Current escalation level (1 or 2)
- `contact1NotifiedAt` - When Contact 1 was notified
- `contact2NotifiedAt` - When Contact 2 was notified (if escalated)
- `userNotifiedNoResponseAt` - When user was notified of no response
- `nextActionAt` - When to check for escalation (used by cron)

## PWA (Progressive Web App)

StillHere is a fully installable PWA with offline support:

- **Manifest**: `/manifest.json` with app metadata and icons
- **Service Worker**: `/sw.js` caches static assets, network-first for API calls
- **Icons**: 8 sizes (72px to 512px) in `/icons/`
- **Install**: Users can add to home screen from browser

### Browser Install
- **iOS Safari**: Share → Add to Home Screen
- **Android Chrome**: Menu → Add to Home Screen
- **Desktop Chrome**: Install icon in address bar

## Native App Build (Capacitor)

StillHere uses Capacitor for native iOS and Android builds.

### Prerequisites
- **iOS**: Mac with Xcode, Apple Developer account ($99/year)
- **Android**: Android Studio, Google Play Developer account ($25 one-time)

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

2. **Build the web app**:
   ```bash
   npm run build
   ```

3. **Initialize platforms**:
   ```bash
   npx cap add ios
   npx cap add android
   ```

4. **Sync web assets**:
   ```bash
   npx cap sync
   ```

5. **Open in IDE**:
   ```bash
   npx cap open ios     # Opens Xcode
   npx cap open android # Opens Android Studio
   ```

6. **Build and submit**:
   - iOS: Archive in Xcode → Upload to App Store Connect
   - Android: Generate signed APK/AAB → Upload to Google Play Console

### App Store Assets Needed
- App icon (1024x1024 for iOS, 512x512 for Android)
- Screenshots (various device sizes)
- App description, privacy policy URL
- Support URL, marketing website

### Capacitor Plugins (optional)
Add these for native features:
```bash
npm install @capacitor/push-notifications
npm install @capacitor/local-notifications
npm install @capacitor/geolocation
npm install @capacitor/haptics
```

## Future Enhancements (planned)

- Biometric unlock (Face ID / fingerprint) after first login
- Push notifications
- Apple Watch / wearable integration
