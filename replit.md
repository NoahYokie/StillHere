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

## Pages

1. `/` - Home page with check-in buttons and status
2. `/settings` - Check-in schedule, contacts, location, pause alerts
3. `/help` - FAQ explaining how the app works
4. `/c/:token` - Contact status page (no login required)

## API Endpoints

- `GET /api/status` - Get user status, settings, and next check-in time
- `POST /api/checkin` - Record a check-in
- `POST /api/sos` - Trigger SOS alert
- `POST /api/settings` - Update settings
- `POST /api/settings/pause` - Pause alerts temporarily
- `POST /api/contacts` - Save emergency contacts
- `POST /api/test` - Send test notification
- `GET /api/c/:token` - Get contact page data
- `POST /api/c/:token/handle` - Contact takes responsibility
- `POST /api/c/:token/escalate` - Contact escalates alert
- `POST /api/location/update` - Update location
- `GET /api/cron/tick` - Check for overdue users (scheduler)

## Demo Data

On startup, the app creates:
- Demo user "Mum" with phone +61412345678
- Contact 1: "Sarah (Daughter)" +61423456789
- Contact 2: "John (Son)" +61434567890
- Contact tokens printed to console for testing

## Tech Stack

- Frontend: React + TypeScript + Tailwind CSS + shadcn/ui
- Backend: Express.js
- Storage: In-memory (MemStorage)
- Routing: wouter
- Data fetching: TanStack Query

## Color Theme

- Primary: Blue (#0ea5e9) - Trust and safety
- Accent: Green (#22c55e) - Positive "I'm OK" actions
- Destructive: Red (#ef4444) - SOS and alerts

## Running the App

The app runs on port 5000 with `npm run dev`. Check console logs for contact page URLs.
