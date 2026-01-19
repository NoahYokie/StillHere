# StillHere - Safety Check-in App

A safety check-in application similar to the Chinese "Are You Dead?" (死了吗) app. Helps elderly, solo dwellers, and lone workers stay connected with their emergency contacts through simple daily check-ins.

## Overview

StillHere is a calm, reassuring safety app with an extremely simple UX. Users tap a big green "I'm OK" button to confirm they're safe. If they miss a check-in, their emergency contacts are notified with a link to view their status and take action.

## Features

- **Simple Check-in**: Big green "I'm OK" button for daily check-ins
- **SOS Alert**: Red "I Need Help" button for immediate emergency notification
- **Configurable Schedule**: Check-in intervals from 12 hours to 48+ hours
- **Grace Period**: 10-30 minute buffer before alerting contacts
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
4. `/setup` - New user name entry
5. `/settings` - Check-in schedule, contacts, location, pause alerts (protected)
6. `/help` - FAQ explaining how the app works (public)
7. `/trust` - Trust & Safety statement (public)
8. `/c/:token` - Contact status page (public, no login required)

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
- `GET /api/c/:token` - Get contact page data
- `POST /api/c/:token/handle` - Contact takes responsibility
- `POST /api/c/:token/escalate` - Contact escalates alert
- `GET /api/cron/tick` - Check for overdue users (scheduler)

## Contact Token Security

- Tokens are 64 characters (32 bytes hex)
- Tokens expire after 30 days
- Tokens are rotated when contacts are edited or removed
- Revoked tokens are rejected

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

## Running the App

The app runs on port 5000 with `npm run dev`. 

For testing:
- OTP codes are logged to the console
- Contact page URLs are logged when contacts are saved
- Check server logs for debugging

## Future Enhancements (planned)

- Twilio integration for real SMS delivery
- Push notifications
- Apple Watch / wearable integration
