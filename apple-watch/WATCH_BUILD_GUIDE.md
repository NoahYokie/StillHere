# StillHere Apple Watch Companion App — Build Guide

## Overview

The StillHere Watch app provides wrist-level safety features:

- **One-tap checkin** — Large green "I'm OK" button for instant safety confirmation
- **SOS alert** — Emergency button that immediately notifies all contacts
- **Native fall detection** — Custom accelerometer-based algorithm detects falls with 60-second countdown before auto-SOS
- **Watch face complications** — Quick-glance status and one-tap access
- **iPhone connectivity** — Syncs auth and relays actions via WatchConnectivity
- **Background refresh** — Periodic status updates every 15 minutes

## Architecture

```
StillHereWatch/
├── StillHereWatchApp.swift          — App entry point
├── ExtensionDelegate.swift          — Background refresh + WKApplicationDelegate
├── Info.plist                       — Bundle config + motion/fall permissions
├── StillHereWatch.entitlements      — Fall detection entitlement
├── Models/
│   └── Models.swift                 — API response types + local state models
├── Services/
│   ├── SessionManager.swift         — Auth token, API calls (checkin/SOS/status)
│   ├── FallDetectionService.swift   — CMMotionManager fall detection algorithm
│   └── PhoneConnectivityManager.swift — WatchConnectivity to iPhone
└── Views/
    ├── MainView.swift               — Primary checkin + SOS interface
    ├── FallCountdownView.swift      — 60-second countdown after fall detected
    ├── SOSActiveView.swift          — Active incident display
    ├── PairingView.swift            — Pre-auth pairing instructions
    └── ComplicationViews.swift      — Watch face complications (WidgetKit)
```

## Prerequisites

- **macOS** with Xcode 15+
- **Apple Developer Account** (paid, $99/year)
- **Apple Watch** Series 4+ for fall detection
- **watchOS 10+** deployment target

## Fall Detection Entitlement

The app includes the `com.apple.developer.health.fall-detection` entitlement for potential future use of Apple's native `CMFallDetectionManager`. This requires an application to Apple:

1. Go to https://developer.apple.com/contact/request/fall-detection-api/
2. Explain StillHere's safety use case for elderly/lone workers
3. Wait 2-3 business days for approval
4. Once approved, add the entitlement in Xcode Signing & Capabilities

**The app works WITHOUT this entitlement** using the custom CMMotionManager algorithm. The entitlement is optional and enables Apple's native detection as an additional layer.

## Custom Fall Detection Algorithm

The custom algorithm uses a 2-phase detection approach:

### Phase 1: Impact Detection
- Monitors `CMDeviceMotion.userAcceleration` at 50 Hz
- Maintains a 25-sample rolling window of pre-impact readings
- Detects impacts exceeding **3.0g** threshold
- Calculates confidence score from:
  - Impact magnitude (3g = 0.25, 6g+ = 0.4)
  - Pre-impact freefall phase (<0.3g = +0.3)
  - Significant rotation (>200°/s = +0.2)
  - Combined hard impact + freefall (+0.1)
- Requires confidence score ≥ 0.5 to proceed

### Phase 2: Post-Impact Stillness
- Collects 3 seconds of post-impact motion data
- Checks for sustained stillness: acceleration < 0.15g AND rotation < 10°/s
- Requires ≥ 20 stillness samples (out of ~150) to confirm fall
- If stillness confirmed → triggers 60-second countdown
- If movement resumes → resets to monitoring (false positive rejection)

### Countdown
- 60-second countdown with haptic alerts every 10 seconds
- "I'm OK" button cancels (triggers haptic stop feedback)
- "SOS Now" button sends immediately
- Timer expiry auto-triggers SOS to server
- 2-minute cooldown after any triggered SOS

## Server API Endpoints

The watch uses the existing wearable API with Bearer token auth:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/checkin/quick` | POST | Quick one-tap checkin |
| `/api/status/simple` | GET | Minimal status (overdue, incident) |
| `/api/sos` | POST | Trigger SOS alert |

All requests include `Authorization: Bearer <token>` header.

## Xcode Project Setup

### 1. Create the Watch Target

1. Open the existing StillHere iOS project in Xcode
2. File → New → Target → watchOS → App
3. Product Name: `StillHereWatch`
4. Bundle Identifier: `com.stillhere.app.watchkitapp`
5. Interface: SwiftUI
6. Language: Swift
7. Check "Include Complication"

### 2. Add Source Files

Copy all files from the `apple-watch/StillHereWatch/` directory into the Xcode watch target:

```bash
# From the project root
cp -R apple-watch/StillHereWatch/* <xcode-project>/StillHereWatch/
```

### 3. Configure Capabilities

In Xcode, select the StillHereWatch target:

1. **Signing & Capabilities** → Add:
   - Background Modes → Background App Refresh
   - HealthKit (if fall detection entitlement approved)

2. **Info.plist** entries (already in the provided Info.plist):
   - `NSMotionUsageDescription`
   - `NSFallDetectionUsageDescription`

3. **Entitlements** (in StillHereWatch.entitlements):
   - `com.apple.developer.health.fall-detection` (requires Apple approval)

### 4. Configure the Companion iPhone App

Add WatchConnectivity support to the iPhone app to relay auth tokens:

```swift
// In the iPhone app's AppDelegate or equivalent
import WatchConnectivity

class PhoneSessionManager: NSObject, WCSessionDelegate {
    static let shared = PhoneSessionManager()

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func sendAuthToken(_ token: String, baseURL: String) {
        guard WCSession.default.isPaired,
              WCSession.default.isWatchAppInstalled else { return }

        try? WCSession.default.updateApplicationContext([
            "authToken": token,
            "baseURL": baseURL
        ])
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        if let action = message["action"] as? String {
            switch action {
            case "checkin":
                // Call your API, then reply
                replyHandler(["ok": true])
            case "sos":
                // Trigger SOS via API, then reply
                replyHandler(["ok": true])
            default:
                replyHandler([:])
            }
        }
    }
}
```

### 5. Build & Run

1. Select the StillHereWatch scheme in Xcode
2. Choose your Apple Watch simulator or paired device
3. Build and run (Cmd+R)

## Testing

### Simulator Testing
- Checkin and SOS buttons work via HTTP API
- Fall detection does NOT work in simulator (no motion data)

### Device Testing
- Pair a real Apple Watch for fall detection testing
- Simulate falls carefully on a padded surface
- Use wrist rotation to test false positive rejection

### Test Scenarios
1. **Happy path**: Tap "I'm OK" → green checkmark + haptic
2. **SOS flow**: Tap "I Need Help" → confirmation → alert sent
3. **Fall → cancel**: Trigger fall → countdown starts → tap "I'm OK"
4. **Fall → auto-SOS**: Trigger fall → let countdown reach 0 → SOS sent
5. **Offline**: Disconnect phone → checkin via HTTP directly
6. **Auth expiry**: Token invalid → redirected to pairing view

## Watch Face Complications

The app provides WidgetKit complications for:

- **Circular** — Heart icon with "OK" text, changes to SOS/orange when overdue
- **Rectangular** — "StillHere" label with status text
- **Inline** — Single line status text
- **Corner** — Heart icon

## Deployment

1. Archive the watch app alongside the iOS app
2. Submit to App Store Connect as a companion watch app
3. The watch app will be distributed automatically with the iOS app
