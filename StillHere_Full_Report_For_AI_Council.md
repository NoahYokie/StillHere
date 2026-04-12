# StillHere Health & Safety - Full Technical & Product Report

**Date:** April 12, 2026
**Live URL:** https://stillhere.health
**Platform:** Built on Replit (full-stack JavaScript/TypeScript)
**Bundle ID:** `com.daudabangoura.stillhere.app`
**App Store Name:** "StillHere Health & Safety"

---

## 1. Product Overview

### What StillHere Does
StillHere is a personal safety and wellness check-in platform designed as a direct competitor to Life360 (~$3B valuation). It provides a safety net for elderly individuals, solo dwellers, lone workers, and anyone who wants their loved ones to know they're safe.

### Core Value Proposition
- Users set a check-in schedule (e.g., every 24 hours)
- If they miss a check-in, the system escalates through a configurable pipeline: push notification reminder -> SMS reminder -> automated wellness phone call -> emergency contact alert (SMS + email + push)
- One-tap "I'm OK" check-in + "I Need Help" SOS button
- Real-time location sharing so family/watchers can see where their loved one is
- Driving safety monitoring with crash detection
- Dead man's switch (Safety Timer) for solo activities
- Safe Walk/Ride with ETA-based alerts

### Target Users
- Elderly parents/grandparents living alone
- Solo dwellers and lone workers
- Families wanting Life360-style location sharing with a safety focus
- People doing solo outdoor activities (hiking, cycling)
- Caregivers and family members ("Watchers")

### Business Model
- Freemium with paid subscription: $7.99/month or $59.99/year
- 14-day free trial
- Revenue model comparable to Life360's subscription approach

---

## 2. Features Implemented (Comprehensive List)

### Fully Functional Features

**Authentication & Onboarding:**
- Phone number OTP authentication via Twilio SMS
- Passkey/WebAuthn (FIDO2) registration and authentication
- 30-day httpOnly secure session cookies
- Apple Review demo login bypass (phone `+15550001234`, code `123456`)
- Multi-step onboarding flow: name setup -> emergency contacts -> preferences
- Landing page with feature tour

**Check-in System:**
- Manual one-tap "I'm OK" check-in with haptic feedback
- Configurable check-in intervals (1h to 168h/weekly)
- Configurable grace periods (5-60 minutes)
- SMS check-in (reply to reminder SMS with "OK" or "SOS")
- Auto check-in option
- Post-check-in motivational quotes
- Reminder pipeline: Push -> SMS (with configurable reminder mode: none/one/two)

**Emergency System:**
- SOS button with immediate incident creation
- Sequential contact escalation (Contact 1 -> wait -> Contact 2 -> wait -> Contact 3, up to 5 contacts)
- Configurable escalation intervals (default 20 minutes)
- Emergency contact portal (unique token-based URL for each contact)
- Contact can "Handle" an incident (45-min timeout, then re-alerts if not resolved)
- Incident timeline tracking (every action logged)
- Fall detection with countdown timer
- Discreet SOS via shake gesture
- Automated wellness check phone call (Twilio voice) when check-in is missed

**Live Location Sharing:**
- Real-time GPS tracking with `watchPosition` API
- Activity detection (stationary/walking/running/cycling/driving) based on speed
- Adaptive update frequency (5s moving, 30s stationary)
- Background location persistence (Wake Lock, silent audio, keep-alive loop)
- Native Capacitor background geolocation plugin support
- Animated marker transitions (800ms interpolation, no jumping)
- Custom person markers with first-initial circles + name labels + activity color coding
- Accuracy radius circles around markers (blue for "Me", purple for contacts)
- GPS accuracy filtering (rejects fixes > 500m after initial lock)
- Real-time Socket.IO distribution to all watchers
- "Open in Google Maps" integration
- Stale data warning banner (> 2 minutes old)
- Reverse geocoding via OpenStreetMap Nominatim for readable addresses

**Google Maps Premium Features (9 completed):**
1. Animated marker transitions (smooth position interpolation)
2. Info windows (tap markers to see speed/activity/time)
3. Geofence circle overlays with name labels + departure detection + email alerts
4. Nearby emergency places overlay (hospitals/police/fire stations via Google Places API)
5. Trip replay animation with play/pause/speed controls
6. Activity heatmap layer (visualization)
7. Location history timeline with day scrubber and animated playback
8. ETA sharing for active Safe Walks on watcher maps
9. Auto-switching dark mode map theme

**Map Interaction:**
- `userInteractedRef` + `programmaticMoveRef` guards so auto-centering only fires on initial load
- Re-center button (compass icon) appears when user pans away
- Browser geolocation fallback for initial map center
- Map ID: `f9da6ed7427098cf6c184d26`

**Watcher System:**
- Auto-detects when an emergency contact is also a StillHere user
- Enhanced watcher dashboard with status overview for all watched people
- Quick actions (call, message, view location)
- Opt-out with soft-delete and restore
- Watcher reporting (configurable scheduled safety reports via email)

**Communication:**
- Real-time in-app messaging via Socket.IO
- Optimistic UI with typing indicators and read receipts
- WebRTC audio calling with Twilio TURN relay
- Native call UI support via Capacitor plugins
- VoIP token registration

**Driving Safety:**
- Dedicated driving dashboard with speedometer
- Live route map during drives
- Trip statistics (distance, duration, max speed)
- Crash detection with 60-second auto-SOS countdown
- Speed limit monitoring (configurable)
- Life360-style driving habit reports
- Drive history and trip replay

**Safety Timer (Dead Man's Switch):**
- Countdown timer for solo activities
- GPS tracking throughout
- Alerts contacts if timer expires without dismissal

**Safe Walk/Ride:**
- Set destination with Google Places search
- Google Routes API for route estimation and ETA
- GPS tracking during journey
- Alerts if user doesn't arrive on time
- ETA displayed on watcher's map

**Geofencing:**
- Create named geofences with custom radius
- Real-time zone departure detection
- Email alerts to contacts on departure
- Visual geofence circles on watcher's map

**Notifications (Multi-channel):**
- Web Push (VAPID) notifications
- SMS via Twilio (with Messaging Service SID + fallback to phone number)
- Email notifications for escalations, geofence alerts, and reports
- In-app banners

**Settings:**
- Compact accordion layout with 6 collapsible sections
- Check-in schedule (interval, grace period, preferred time, reminder mode)
- Location settings (off/emergency_only/on_shift/both)
- Safety features (fall detection, discreet SOS, SMS check-in, driving safety, speed limit, wellness call)
- Notification preferences
- Pause alerts (temporary snooze)
- Account & security (passkey management, account deletion)
- Emergency contacts: slim tap-to-edit rows, drag-to-reorder priority, up to 5+ contacts

**Other Features:**
- Satellite device integration API (Garmin inReach, SPOT)
- Wearable/Watch API for companion apps
- Apple Watch companion app (SwiftUI) with one-tap check-in, SOS, 2-phase fall detection, heart rate monitoring via HealthKit
- Heart rate monitoring with abnormal BPM alerts
- App ratings system (1-5 stars + reviews)
- Error tracking (frontend + backend crash reporting)
- PWA with offline support and installability
- E.164 phone number normalization (multi-country)
- Privacy policy and terms of service pages
- Trust/security information page

### Partially Complete / Known Issues
- **Location pinpoint accuracy** - The "Me" pin sometimes shows in the wrong location, far from the user's actual position (ACTIVE BUG - details in Section 5)
- **Automated wellness call** - Code exists but was defaulting to OFF, and the flow was calling AND alerting contacts simultaneously instead of call-first-then-wait (RECENTLY FIXED but not yet deployed)
- **Background location on mobile browsers** - Uses Wake Lock + silent audio hacks which are unreliable on iOS Safari and some Android browsers

---

## 3. Tech Stack & Architecture

### Frontend
- **Framework:** React 18 with TypeScript
- **Routing:** `wouter` (lightweight client-side routing)
- **State/Data:** TanStack Query v5 (React Query)
- **Styling:** Tailwind CSS + Radix UI primitives (shadcn/ui)
- **Icons:** lucide-react
- **Animations:** framer-motion
- **Maps:** Google Maps JavaScript API with libraries: Places, Geometry, Marker (Advanced), Visualization
- **Charts:** Recharts
- **Carousel:** embla-carousel-react
- **Mobile:** Capacitor (iOS/Android wrapper)

### Backend
- **Runtime:** Node.js with Express 5
- **Language:** TypeScript (tsx for execution)
- **ORM:** Drizzle ORM
- **Database:** PostgreSQL
- **Real-time:** Socket.IO
- **Voice/Video:** WebRTC with Twilio TURN servers
- **SMS:** Twilio (Messaging Service + phone number fallback)
- **Voice Calls:** Twilio Programmable Voice
- **Push:** web-push (VAPID)
- **Auth:** Passport.js (custom local strategy), @simplewebauthn/server for WebAuthn
- **Security:** Helmet, express-rate-limit, httpOnly secure cookies

### Key Architectural Decisions
1. **Schema-driven development** - Shared Zod schemas in `shared/schema.ts` ensure type safety across frontend and backend
2. **Session-based auth** - Signed cookies stored in PostgreSQL (not JWT) for better security
3. **Incident escalation engine** - Multi-stage notification system with configurable timing
4. **Hybrid PWA/Native** - Single codebase with Capacitor for native features
5. **Socket.IO for real-time** - Used for chat, location updates, typing indicators, and WebRTC signaling
6. **Public/Private API split** - Emergency contact pages are public (token-based), everything else requires auth

### Database Schema (Key Tables)
- `users` - id, phone, name, createdAt, publicKey (for passkeys)
- `settings` - checkin interval, grace period, location mode, reminder mode, fall detection, wellness call, etc.
- `contacts` - emergency contacts with priority ordering
- `incidents` - active emergencies with escalation level, timeline, contact notification tracking
- `checkins` - check-in history with method (button/auto/sms) and metadata
- `live_location_shares` - active sharing sessions with latest coordinates
- `location_points` - breadcrumb trail of location history
- `geofences` - named zones with lat/lng/radius
- `drive_sessions` / `drive_points` - driving monitoring data
- `messages` - chat messages
- `calls` - voice/video call records
- `safety_timers` / `safe_walks` - active safety sessions
- `contact_tokens` - one-time tokens for emergency contact portal
- `push_subscriptions` - web push subscription data

### External Integrations
- **Google Maps Platform:** Maps JavaScript API, Places API (New), Routes API, Geocoding
- **Twilio:** SMS (Messaging Service), Programmable Voice, TURN servers for WebRTC
- **OpenStreetMap Nominatim:** Reverse geocoding for location timeline
- **Apple HealthKit:** Heart rate data from Apple Watch
- **web-push:** VAPID-based push notifications

---

## 4. UX/UI

### Design Approach
- Clean, reassuring UI with blue primary color scheme
- Green accents for positive actions (check-in, safe)
- Red for alerts and emergencies
- Designed for elderly users: large tap targets, simple flows, minimal cognitive load
- Mobile-first responsive design
- Dark mode support with auto-switching

### User Flow
1. **Landing** -> **Login** (enter phone) -> **OTP verification** -> **Onboarding** (name, contacts, preferences)
2. **Home dashboard** -> Prominent "I'm OK" button + "I Need Help" SOS
3. **Settings** -> 6-section accordion (check-in, location, safety, notifications, pause, account)
4. **Live Location** -> Toggle sharing on/off, see contacts on map
5. **Watcher view** -> See watched person's location, activity, timeline

### Strengths
- Very simple core flow (one tap to check in)
- Onboarding guides through everything needed
- Emergency contact portal requires zero app installation
- Haptic feedback and motivational quotes add warmth

### Weaknesses
- Settings page has many options that could overwhelm elderly users
- Map page has a lot of overlays that could be confusing
- No tutorial/walkthrough for advanced features (geofencing, safe walk)

---

## 5. Performance & Reliability

### THE CRITICAL ACTIVE BUG: Location Pinpoint Accuracy

**Problem:** The "Me" pin on the live location map shows in the wrong location, far from the user's actual position.

**What we've investigated and tried so far:**

1. **Root cause identified:** When location sharing is active, the app was prioritizing stale server-stored coordinates (from `GET /api/live-location/status`) over the phone's fresh GPS position. The server returns `lastLat`/`lastLng` which could be hours old from a completely different location.

2. **Fix attempted (priority swap):** Changed from:
   ```js
   // OLD - prefers stale server data when sharing is active
   const myLat = (sharingActive && currentLat != null) ? currentLat : myGpsLat;
   ```
   To:
   ```js
   // NEW - always prefer fresh GPS
   const myLat = myGpsLat != null ? myGpsLat : currentLat;
   ```

3. **GPS accuracy filtering adjusted:** Initially set a 150m accuracy threshold that was too aggressive (blocked GPS entirely in poor signal areas). Softened to: accept the first position regardless of accuracy, then only filter subsequent fixes worse than 500m.

4. **watchPosition configuration tuned:** Changed from `maximumAge: 0` (no cache, which can cause delays) to `maximumAge: 10000` (accept positions up to 10 seconds old for faster initial display), and increased timeout from 15s to 20s.

5. **Life360-style accuracy techniques implemented:**
   - Accuracy radius circles around markers (visual indicator of GPS precision)
   - `enableHighAccuracy: true` (triggers OS to use GPS + Wi-Fi + cell tower fusion)
   - Continuous `watchPosition` instead of one-shot `getCurrentPosition`

**Despite all these fixes, the user reports the pinpoint is STILL showing in the wrong location.**

**Possible remaining causes we haven't fully addressed:**
- The `currentLat`/`currentLng` state from the `addLocationListener` callback might be overwriting the fresh GPS position when the live tracking module sends an API update (race condition between two position sources)
- The live tracking module (`live-location.ts`) sends updates to the server which then come back via the `addLocationListener` callback, potentially with different coordinates than the GPS watch
- The `watchPosition` in the page component and the `watchPosition` in the live tracking module are TWO SEPARATE GPS watches - they could be reporting different positions
- On mobile browsers, `watchPosition` with `enableHighAccuracy: true` might still return Wi-Fi/cell tower position initially before getting a true GPS lock
- The map's `fitBounds` or auto-centering might be centering on stale data from watched contacts rather than the user's own position

**What we need help with:**
- A robust architecture for determining the "Me" position that eliminates all sources of stale/wrong data
- Best practices for mobile browser GPS that ensure the freshest possible position
- Whether we should eliminate the dual GPS watch (page watchPosition + tracking module watchPosition) and use a single source of truth
- How Life360 handles this in their web/PWA version

### Other Known Issues
- **Background location unreliable in browsers:** Wake Lock + silent audio are hacks; iOS Safari and some Android browsers aggressively kill background tabs
- **WebRTC call quality:** Hardcoded ICE gathering timeouts (3s, 5s) may be too short for slow mobile networks
- **Cron tick timing:** Runs every 2 minutes, so worst case there's a 2-minute delay before alerts fire
- **Server restarts:** Passkey challenge store is in-memory (lost on restart)

### Scalability Considerations
- Single PostgreSQL database, no read replicas
- Socket.IO with no Redis adapter (single-instance only)
- In-memory stores (challenge store, rate limit counters) prevent horizontal scaling
- Location updates every 5s from moving users could create high write volume

---

## 6. Security & Privacy

### Implemented
- **Helmet** for HTTP security headers
- **express-rate-limit** for global API rate limiting
- **httpOnly secure cookies** (30-day expiry) for sessions
- **E.164 phone normalization** for consistent phone storage
- **Token-based emergency access** (unique per contact per incident)
- **Account deletion** with full data cascade
- **Content-Security-Policy** headers
- **PII-free logging** (phone numbers partially masked in logs)
- **Input validation** via Zod schemas on all API endpoints
- **CORS** configuration

### Concerns
- Hardcoded demo bypass for phone `+15550001234` exists in production
- Passkey challenge store is in-memory (not persistent)
- `dev-fallback-secret` hardcoded in auth.ts
- Location data is stored in the database without encryption at rest
- No data retention policy (location points accumulate forever)
- SMS OTP has no brute-force protection beyond rate limiting

---

## 7. Competitive Positioning vs Life360

### Where StillHere is STRONGER than Life360
- **Check-in system:** Life360 doesn't have a scheduled wellness check-in with escalation pipeline
- **Wellness calls:** Automated phone call when check-in is missed (unique feature)
- **Emergency contact portal:** Contacts don't need the app installed - they get a web link
- **Safety Timer (Dead Man's Switch):** Not in Life360
- **Safe Walk with ETA monitoring:** More safety-focused than Life360's location sharing
- **Wearable/Watch integration:** Direct Apple Watch companion with fall detection and heart rate
- **Elderly-focused UX:** Simpler, less cluttered than Life360
- **No ads:** Life360's free tier is ad-heavy

### Where Life360 is STRONGER
- **Location accuracy:** Life360 uses proprietary location fusion algorithms, Wi-Fi fingerprinting databases, and aggressive background tracking that actually works reliably
- **Battery optimization:** Life360 has years of optimization for background location on both iOS and Android
- **Driving detection:** Automatic (StillHere requires manual start)
- **Place alerts:** "Arrived at school" / "Left work" automation is more polished
- **Bubble system:** Life360's "circles" for different groups is more flexible
- **Scale & reliability:** Millions of users, redundant infrastructure
- **Native app quality:** Purpose-built native apps vs PWA wrapper
- **Crash detection:** Uses phone accelerometer data at the native level

### Key Gaps
- StillHere's PWA approach means it will always be at a disadvantage for background location and sensor access compared to Life360's native apps
- Life360 has proprietary algorithms for location accuracy that can't be replicated in a browser
- Life360 has carrier-level integrations in some markets

---

## 8. Missing Pieces (Remaining 20%)

### Critical for Launch
1. **Fix location pinpoint accuracy** (the active bug)
2. **Reliable background location on mobile** (the PWA limitation)
3. **Enable auto wellness call by default** for new users (currently defaults to OFF)
4. **Production deployment stability** (frequent server restarts in logs)
5. **Remove hardcoded demo bypass** or gate it behind an environment variable
6. **Payment integration** (Stripe/RevenueCat for $7.99/month or $59.99/year subscription)

### Important but Not Blocking
7. **Automatic driving detection** (currently manual start)
8. **Place alerts** ("arrived at" / "left from" push notifications for watchers)
9. **Circle/Group system** (like Life360's family circles)
10. **Data retention policy** (auto-delete location points after X days)
11. **Redis for Socket.IO** (for horizontal scaling)
12. **Persistent passkey challenge store** (move from in-memory to database)
13. **App Store screenshots and marketing assets**
14. **User onboarding tutorial** for advanced features
15. **Battery usage optimization** guide/tips for users

### Nice to Have
16. **Android native app** (currently iOS only via Capacitor)
17. **Tablet-optimized layout**
18. **Multi-language support** (i18n)
19. **Accessibility audit** (screen reader, high contrast)
20. **Analytics dashboard** (usage metrics, retention)

---

## 9. Developer Notes

### Technical Debt
- **`server/routes.ts` is 4,135 lines** - Needs to be split into route modules (auth, checkin, location, driving, messaging, etc.)
- **`server/storage.ts` is ~2,000 lines** - Single storage class handles everything
- **`shared/schema.ts` is 882 lines** - Manageable but growing
- **Inconsistent type casting** - Many `(req as any).userId` and `(settings as any).autoWellnessCall` instead of proper TypeScript interfaces
- **Dual GPS watch** - The live-location page creates its own `watchPosition` AND the `live-location.ts` tracking module creates another one. These are two separate GPS sessions competing for the same hardware.
- **Flattened incident columns** - `contact1NotifiedAt`, `contact2NotifiedAt` in the incidents table instead of a proper notification log table
- **Silent catch blocks** - Several `try { ... } catch {}` blocks that swallow errors silently

### Areas Needing Refactoring
1. Split `routes.ts` into modular route files
2. Extract notification logic (SMS, push, email) into a dedicated service
3. Consolidate GPS position sources into a single observable/hook
4. Move in-memory stores (challenges, rate limits) to Redis or database
5. Add proper TypeScript types for request objects (no more `as any`)
6. Add comprehensive error logging (replace empty catch blocks)

### File Structure
```
client/
  src/
    components/
      google-map.tsx          # 850+ lines - Main map component with all overlays
      ui/                     # shadcn/ui components
    hooks/
      use-toast.ts
    lib/
      live-location.ts        # Background location tracking module
      driving-monitor.ts      # Driving detection and crash monitoring
      webrtc.ts               # WebRTC calling logic
      queryClient.ts          # TanStack Query config
    pages/
      home.tsx                # Main dashboard
      settings.tsx            # User settings
      live-location.tsx       # Location sharing (user's view)
      live-location-view.tsx  # Location sharing (watcher's view)
      drive.tsx               # Driving dashboard
      safe-walk.tsx           # Safe Walk feature
      safety-timer.tsx        # Dead Man's Switch
      chat.tsx                # Messaging
      call.tsx                # Voice/video calls
      ... (20+ pages total)
server/
  index.ts                    # Express server setup, middleware, cron
  routes.ts                   # ALL API routes (4,135 lines)
  storage.ts                  # ALL database operations
  auth.ts                     # Session/passport config
  socket.ts                   # Socket.IO setup
  vite.ts                     # Vite dev server integration
shared/
  schema.ts                   # Drizzle ORM schema + Zod types
ios/                          # Capacitor iOS project
  StillHereWatch/             # Apple Watch companion app (SwiftUI)
```

### Environment Variables Required
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Cookie signing + cron auth
- `TWILIO_ACCOUNT_SID` - Twilio account
- `TWILIO_AUTH_TOKEN` - Twilio auth
- `TWILIO_PHONE_NUMBER` - Sender phone number
- `TWILIO_MESSAGING_SERVICE_SID` - Twilio messaging service
- `TWILIO_ALPHA_SENDER` - Alphanumeric sender ID
- `GOOGLE_MAPS_API_KEY` - Google Maps Platform
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` - Web push (auto-generated)

### Production Database
- PostgreSQL on Replit
- Key users: Dauda (`+61405935265`), Ishong
- Emergency contact tokens: `UAMSymxXyH` (Ishong), `RXLkMyttAW` (Dauda)

---

## 10. Specific Help Requested

### Priority 1: Location Pinpoint Accuracy
The "Me" marker on the map shows far from the user's actual location. We need:
- A single-source-of-truth architecture for the user's current position
- Elimination of stale server data contaminating fresh GPS
- Best practices for `navigator.geolocation.watchPosition` on mobile browsers
- Whether to consolidate the two separate GPS watches into one
- How to handle the transition from coarse (cell/Wi-Fi) to fine (GPS) position

### Priority 2: Wellness Call Flow
The automated wellness call should be:
1. Push reminder -> 2. SMS reminder -> 3. (Grace period expires) -> 4. Call the user -> 5. Wait 2 minutes -> 6. If no answer, THEN alert contacts

Currently fixed in code but not yet deployed. Need validation of this flow.

### Priority 3: Background Location Reliability
The PWA approach has fundamental limitations for background location on mobile. Need strategies for:
- Keeping the app alive in the background on iOS Safari
- Fallback mechanisms when background tracking fails
- Whether to push harder toward native (Capacitor) instead of PWA

---

*This report was generated from the live codebase of StillHere on April 12, 2026. All code references, line numbers, and architectural details are current as of this date.*
