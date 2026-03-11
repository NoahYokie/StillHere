# StillHere - Complete Technical Briefing for AI Team

## What Is StillHere?

StillHere (stillhere.health) is a safety check-in app for elderly people, solo dwellers, and lone workers. Users tap one button ("I'm OK") daily to confirm they're safe. If they miss a check-in, their emergency contacts get notified via SMS and push notifications. If someone needs immediate help, they press an SOS button. The app also supports in-app messaging, video calling, fall detection, and a watcher dashboard.

The goal is to be as simple and reliable as WhatsApp for communication, but focused on safety monitoring.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + TypeScript + Tailwind CSS + shadcn/ui |
| Routing | wouter |
| Data Fetching | TanStack Query v5 |
| Backend | Express.js + TypeScript |
| Database | PostgreSQL + Drizzle ORM |
| Real-time | Socket.IO (WebSocket + polling fallback) |
| Video Calls | WebRTC (peer-to-peer) |
| TURN Servers | Twilio Network Traversal Service |
| SMS | Twilio |
| Push Notifications | Web Push (VAPID) |
| Security | Helmet.js, express-rate-limit, httpOnly cookies |
| Hosting | Replit (deployment + PostgreSQL) |
| Domain | stillhere.health |

---

## Complete Feature List

### Core Safety Features
- **Daily Check-in**: Large green "I'm OK" button. Configurable intervals (12-48+ hours).
- **SOS Alert**: Red "I Need Help" button sends immediate alerts to all emergency contacts.
- **Grace Period**: 10-30 minutes before missed check-in triggers alerts.
- **Reminders**: Configurable (none, one, or two) via push notification and SMS.
- **Auto Check-in**: Optional — checking in just by opening the app.
- **Fall Detection**: Uses DeviceMotion API to detect high-G impact + stillness. Shows 60-second countdown before auto-triggering SOS. Toggle in settings.
- **Quote of the Day**: 125 motivational quotes shown after each check-in, rotating by day-of-year.

### Emergency Contact System
- **Dynamic Contacts List**: Free users get 2 contacts, premium users get unlimited.
- **Sequential Escalation**: Top 5 contacts notified one at a time (20 min each), then all remaining contacts notified simultaneously.
- **Smart Notification Routing**: Contacts who have the app get push notifications + in-app messages. Contacts without the app get SMS.
- **Contact Pages**: Token-based public pages where contacts can view user status, see location, and take responsibility.
- **Responsibility System**: A contact can "take responsibility" which pauses escalation.
- **Re-notification**: If nobody responds, contacts get re-notified.

### Communication Features
- **In-App Messaging**: Real-time chat via Socket.IO between users and their emergency contacts who also have the app. Message persistence, read receipts, push notification fallback.
- **In-App Video Calling**: WebRTC peer-to-peer video calls with Socket.IO signaling. TURN servers via Twilio for NAT traversal. Features: mute, camera toggle, camera flip, incoming call overlay.
- **Watcher Dashboard**: Emergency contacts who have the app see a dashboard of everyone they monitor — showing names, last check-in times, status (OK/overdue/alert), with direct message and video call buttons.

### Authentication & Security
- **Phone OTP Login**: SMS-based one-time password. Sessions last 30 days via httpOnly secure cookies.
- **28+ Country Phone Normalization**: E.164 format normalization for US, UK, AU, CA, NZ, JP, KR, SG, IN, FR, DE, IT, ES, NL, BE, CH, IE, SE, NO, DK, CZ, HU, RO, HR, and more.
- **Rate Limiting**: 100 requests per 15 min on /api/. OTP rate limiting per phone number.
- **Helmet.js**: Comprehensive HTTP security headers.

### Other Features
- **PWA**: Full Progressive Web App with service worker, offline support, installability.
- **Location Sharing**: Optional, user-controlled. Shared with emergency contacts during incidents.
- **Wearable API**: Bearer token auth endpoints for Apple Watch / Wear OS companion apps.
- **Onboarding**: 4-screen introduction flow + 3-step registration (name, contacts, preferences).
- **Haptic Feedback**: On check-in, SOS, and fall detection actions.

---

## File Structure

### Server Files
```
server/
  index.ts        — Express app setup, Helmet, rate limiting, session config
  routes.ts       — All API routes (~1000+ lines), cron tick, escalation logic
  storage.ts      — IStorage interface + DatabaseStorage implementation
  socket.ts       — Socket.IO server: messaging, video call signaling, ICE relay
  auth.ts         — Phone normalization, OTP generation, session management
  sms.ts          — Twilio SMS integration + TURN credential fetching
  push.ts         — Web push notification sending
  db.ts           — Drizzle PostgreSQL connection
  vite.ts         — Vite dev server integration
  static.ts       — Static file serving for production
```

### Client Files
```
client/src/
  App.tsx           — Frontend routing (all pages registered here)
  pages/
    home.tsx        — Main check-in page with escalation banner, fall detection, quote
    settings.tsx    — User settings, contacts list, fall detection toggle
    watched.tsx     — Watcher dashboard (monitor people you're contact for)
    chat.tsx        — Real-time messaging conversation view
    call.tsx        — Video call interface with WebRTC
    contact.tsx     — Emergency contact status page (public, token-based)
    login.tsx       — Phone number entry
    login-code.tsx  — OTP code verification
    onboarding.tsx  — 4-screen intro flow
    setup-name.tsx  — Registration step 1
    setup-contacts.tsx — Registration step 2 (add emergency contacts)
    setup-preferences.tsx — Registration step 3
    landing.tsx     — Public landing page
    help.tsx        — Help/FAQ page
    trust.tsx       — Trust & safety page
    not-found.tsx   — 404 page
  lib/
    socket.ts       — Socket.IO client singleton with auto-reconnection
    webrtc.ts       — WebRTCConnection class (peer connection management)
    ringtone.ts     — Web Audio API ringtone system (incoming/outgoing tones)
    fall-detection.ts — DeviceMotion API fall detection module
    quotes.ts       — 125 daily motivational quotes
    auth.tsx        — Auth context provider
    queryClient.ts  — TanStack Query client with apiRequest helper
    utils.ts        — Utility functions
  components/
    incoming-call.tsx — Global incoming call overlay (renders on all pages)
    ui/             — shadcn/ui components
```

### Shared Files
```
shared/
  schema.ts — Database schema (Drizzle ORM), insert schemas (Zod), TypeScript types
```

### Database Tables
- **users** — id (uuid), name, phone, timezone, isPremium
- **settings** — 1:1 with users. checkinIntervalHours, graceMinutes, locationMode, reminderMode, autoCheckin, fallDetection, etc.
- **contacts** — userId, name, phone, priority, canViewLocation, linkedUserId (references users.id if contact is also a StillHere user)
- **contact_tokens** — token-based access for emergency contact status pages
- **checkins** — userId, method (button/auto), createdAt
- **incidents** — userId, status (open/paused/resolved), reason (missed_checkin/sos/test), escalation tracking fields
- **auth_sessions** — userId, token, expiresAt
- **otp_codes** — phone, code, expiresAt, used
- **otp_rate_limits** — phone, createdAt
- **push_subscriptions** — userId, endpoint, p256dh, auth
- **location_sessions** — userId, incidentId, type, active, lat/lng/accuracy
- **messages** — senderId, receiverId, content, read, createdAt
- **calls** — callerId, receiverId, status, callType, startedAt, answeredAt, endedAt

---

## Current Architecture Decisions

### Contact Linking System
When User A adds User B's phone number as an emergency contact, the system checks if that phone number belongs to a registered StillHere user. If yes, `contact.linkedUserId` is set to User B's ID. This enables:
- In-app messaging instead of SMS
- Video calling between them
- User B seeing User A on their watcher dashboard
- Push notifications instead of SMS during incidents

Linking is checked:
1. When contacts are saved/updated
2. When a new user registers (backfill: finds all contacts with matching phone number)

### Escalation Flow
1. Grace period expires → first reminder (push notification)
2. Second reminder if configured
3. Open incident → notify contact #1 by priority (SMS or push based on linkedUserId)
4. Wait 20 minutes. If no response, notify contact #2.
5. Continue through top 5 contacts sequentially.
6. After top 5, notify all remaining contacts simultaneously.
7. Re-notify if still unresolved.
8. Contact can "take responsibility" via their token-based page, which pauses escalation.

### Socket.IO Communication
- Server uses `io.to(\`user:${userId}\`).emit(...)` to broadcast to all of a user's sockets (they may have multiple tabs/reconnections)
- Each socket joins room `user:${userId}` on connection
- Cookie-based authentication matching the existing session system
- Transports: websocket first, polling fallback

---

## Environment Variables (Secrets)
- `DATABASE_URL` — PostgreSQL connection string
- `SESSION_SECRET` — Express session signing key
- `TWILIO_ACCOUNT_SID` — Twilio account ID
- `TWILIO_AUTH_TOKEN` — Twilio auth token
- `TWILIO_PHONE_NUMBER` — Twilio phone number for sending SMS
- `TWILIO_ALPHA_SENDER` — Alphanumeric sender ID (for non-US/CA countries)
- VAPID keys are auto-generated and stored in the database

---

## Problems We've Encountered and Fixed

### 1. Socket.IO CORS Rejection (FIXED)
**Problem**: Server had `cors: { origin: "*", credentials: true }` which browsers reject (can't use wildcard origin with credentials).
**Fix**: Removed CORS config entirely since Socket.IO connects to the same origin.

### 2. Chat Page Name Resolution (FIXED)
**Problem**: Chat and call pages used `/api/watched-users` to look up the other user's name, but this only returns users you're monitoring — not all contacts.
**Fix**: Added `GET /api/users/:userId/profile` endpoint that returns `{ id, name }` for any authenticated user.

### 3. Socket Disconnecting on Page Navigation (FIXED)
**Problem**: When navigating to the call page, the old socket disconnected and a new one took time to connect. Call events sent before reconnection were lost.
**Fix**: Added `waitForSocket()` that waits for the socket to be connected before starting the call flow. Also set socket reconnection to be faster (500ms delay).

### 4. Audio Tracks Being Dropped (FIXED)
**Problem**: WebRTC `ontrack` handler only captured the first track (usually video). When audio arrived separately, it was ignored.
**Fix**: Create a single `MediaStream` and add all tracks to it individually, calling `onRemoteStream` callback whenever new tracks arrive.

### 5. ICE Candidates Silently Dropped (FIXED)
**Problem**: Every ICE candidate triggered 2 database queries for permission checks. ICE candidates fire rapidly (10-20+ per call). If any query was slow or failed, candidates were silently dropped, preventing the WebRTC connection from establishing.
**Fix**: Removed permission checks from ICE candidate relay (permission is already verified during `call:initiate`). Added permission caching with 60-second TTL.

### 6. Cross-Calling (Glare) Creating Duplicate Calls (FIXED)
**Problem**: When both users tried to call each other simultaneously, the server created two independent calls. Neither connected because both sides were trying to be the caller.
**Fix**: Added `activeCallPairs` Map on the server. If a call between two users is already active, the second call is rejected.

### 7. Caller/Callee Flow Confusion (FIXED)
**Problem**: Original code used `isInitiator` flag which was wrong for the callee who navigates to the call page via the incoming call overlay.
**Fix**: Separated the flow: callee navigates to `/call/:callerId?mode=answer`, reads pending call data from module-level variable via `getPendingIncomingCall()`.

### 8. Server Using `socket.to()` Instead of `io.to()` (FIXED)
**Problem**: `socket.to(room)` broadcasts to the room EXCLUDING the sending socket. When users had multiple sockets (reconnections), events could miss the right one.
**Fix**: Changed all call events to use `io.to(room)` which sends to ALL sockets in the room.

### 9. No Ringtone/Audio Feedback (FIXED)
**Problem**: No audio indication when calling or receiving a call.
**Fix**: Added Web Audio API ringtone system with distinct tones for outgoing calls, incoming calls, call connected, and call ended. All tones are properly cleaned up (timeouts cleared, oscillators stopped).

### 10. ICE Restart on Network Change (ADDED)
Added WhatsApp-style ICE restart: when connection drops for 3+ seconds or the phone goes offline/online, ICE is automatically restarted. Guarded to only fire after the call is established (not during initial negotiation).

### 11. Mobile Autoplay Blocking (FIXED)
**Problem**: Mobile browsers can block unmuted autoplay on video elements.
**Fix**: If play() fails, video plays muted with a "Tap anywhere to hear audio" banner. Tapping unmutes.

---

## CURRENT OUTSTANDING ISSUE: Video Calls Still Not Working

### The Symptom
User A calls User B. User B picks up. The answer SDP is successfully sent back to User A (confirmed in server logs). But:
- Neither user can see the other's video
- Neither user can hear the other's audio
- After ~30 seconds of nothing, one user ends the call

### What the Server Logs Show
```
[CALL] UserA initiating video call to UserB
[CALL] Call abc123 created. Receiver online: true
[CALL] UserB answering call abc123 from UserA
[CALL] Answer SDP type: answer, SDP length: ~3000
[CALL] Sending answer to caller UserA. Caller online: true
[CALL] Answer event emitted to user:UserA
[CALL] UserB ending call abc123 (30 seconds later)
```

### What We Know
1. Both users connect to Socket.IO successfully
2. The call:initiate event reaches UserB (they see the incoming call overlay)
3. UserB accepts and the answer SDP is sent back
4. The answer event is emitted to UserA
5. TURN credentials are fetched successfully (Twilio STUN + TURN servers)
6. But ICE candidates are NOT appearing in logs (we just added logging for this)
7. After 30 seconds, no media flows and someone hangs up

### What We Suspect
The SDP offer/answer exchange appears to work, but the actual peer-to-peer media connection never establishes. Possible causes:
1. **ICE candidates not being generated or sent** — the `onicecandidate` callback might not fire
2. **SDP serialization issue through Socket.IO** — the SDP object might get mangled during Socket.IO transmission (unlikely but possible)
3. **Browser permission issue on mobile** — camera/mic might not actually be captured despite no error being thrown
4. **The RTCPeerConnection might be in a bad state** — if any step in the offer/answer flow fails silently
5. **The remote description might not be set properly on the caller side** — the `call:answered` event might not arrive or arrive too late

### Key Test Users
- **Dauda** (15dae507-b5eb-4482-8c68-d8d7b44cb3df) — the developer/tester
- **Ishong** (e77b786c-6c8d-4d21-81af-3e1d7891ca5d) — the test partner

### What We Need Help With
1. **Debug why WebRTC media doesn't flow** even though SDP exchange succeeds
2. **Test if SDP is being correctly serialized/deserialized** through Socket.IO
3. **Determine if this is a browser/mobile-specific issue** or a code logic issue
4. **Consider alternative approaches** if browser WebRTC is too unreliable for mobile web

---

## WebRTC Call Flow (Current Implementation)

### Caller Side (initiateOutgoingCall)
```
1. getSocket() — get Socket.IO connection
2. waitForSocket() — ensure socket is connected
3. fetchIceServers() — GET /api/turn-credentials (Twilio STUN/TURN)
4. new WebRTCConnection(iceServers) — create RTCPeerConnection
5. rtc.getLocalStream() — getUserMedia({ video, audio })
6. rtc.createOffer() — createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
7. socket.emit("call:initiate", { receiverId, callType, offer })
8. Server creates call record, emits "call:incoming" to receiver
9. Wait for "call:answered" event with answer SDP
10. rtc.handleAnswer(answer) — setRemoteDescription
11. ICE candidates flow via socket relay
12. ontrack fires with remote stream → show video
```

### Callee Side (answerIncomingCall)
```
1. IncomingCallOverlay receives "call:incoming" event
2. User taps "Accept" → store offer in module variable
3. Navigate to /call/:callerId?mode=answer
4. getSocket() + waitForSocket()
5. fetchIceServers()
6. new WebRTCConnection(iceServers)
7. rtc.getLocalStream() — getUserMedia({ video, audio })
8. getPendingIncomingCall() — retrieve stored offer
9. rtc.handleOffer(offer) — setRemoteDescription + createAnswer + setLocalDescription
10. socket.emit("call:answer", { callId, callerId, answer })
11. ICE candidates flow via socket relay
12. ontrack fires with remote stream → show video
```

### Server Relay (socket.ts)
```
call:initiate → checkPermission → createCall → emit call:incoming to receiver
call:answer → updateCall(active) → emit call:answered to caller
call:ice-candidate → emit to target (NO permission check — already verified)
call:end → updateCall(ended) → emit call:ended to target
call:reject → updateCall(missed) → emit call:rejected to caller
call:ice-restart → emit to target (for ICE restart during call)
call:ice-restart-answer → emit to target
```

---

## How to Test Changes

The app runs on Replit. The workflow `Start application` runs `npm run dev` which starts both the Express backend and Vite frontend on port 5000. The app is deployed to stillhere.health.

To test video calls, you need two devices/browsers with camera and microphone access, both logged in with different accounts.

---

## Relevant Code Files for Video Call Debugging

If you need to look at specific code:
- **`client/src/lib/webrtc.ts`** — WebRTCConnection class, ICE handling, stream management
- **`client/src/pages/call.tsx`** — Call page UI and signaling logic
- **`client/src/components/incoming-call.tsx`** — Incoming call overlay
- **`client/src/lib/socket.ts`** — Socket.IO client configuration
- **`server/socket.ts`** — Server-side signaling relay
- **`server/sms.ts`** — Contains `getTurnCredentials()` for Twilio TURN

---

## Ideas for Improvement (Beyond Current Bug Fix)

1. **Media server approach** — Instead of peer-to-peer WebRTC, use a media server (like LiveKit, Janus, or mediasoup) as a relay. This is more reliable than P2P, especially on mobile networks, and is what WhatsApp actually does (relay-first).
2. **Audio-only fallback** — If video can't connect, automatically fall back to audio-only call.
3. **Connection quality indicator** — Show connection quality (like WhatsApp's encryption lock icon).
4. **Call history page** — Show missed calls, call duration, etc.
5. **Group calls** — For families monitoring an elderly parent.
6. **End-to-end encryption** — For messages and calls.
7. **Native mobile app** — Using Capacitor (config already exists) for better camera/mic access and background operation.
