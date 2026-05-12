# StillHere - iOS App Store Build Guide

## Prerequisites

- macOS with Xcode 15+ installed
- Apple Developer Program membership ($99/year)
- Node.js 18+ and npm
- CocoaPods (`sudo gem install cocoapods`)

## Step 1: Clone and Setup

```bash
git clone <your-repo-url> stillhere
cd stillhere
npm install
```

## Step 2: Build the Web App

```bash
npm run build
```

This outputs the production frontend to `dist/public/`.

## Step 3: Add iOS Platform

```bash
npx cap add ios
npx cap sync ios
```

This creates the `ios/` directory with the Xcode project.

## Step 4: Set Up App Icons

Copy the generated icons into the Xcode asset catalog:

```bash
cp client/public/ios-icons/*.png ios/App/App/Assets.xcassets/AppIcon.appiconset/
cp ios-app-store/AppIcon-Contents.json ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json
```

## Step 5: Configure Info.plist Privacy Descriptions

Open `ios/App/App/Info.plist` in Xcode and add these required privacy descriptions:

**Source of truth:** these strings are defined in `capacitor.config.json` under `ios.infoPlist` and merged into `ios/App/App/Info.plist` automatically by `npx cap sync ios`. Do not edit `Info.plist` by hand — edit `capacitor.config.json` instead.

| Key | Value |
|-----|-------|
| NSLocationWhenInUseUsageDescription | StillHere uses your location only when you choose to share it or when you start a safety feature like a check-in, Safe Walk, Safety Timer, Drive Safety, or SOS. Location sharing is off by default. |
| NSLocationAlwaysAndWhenInUseUsageDescription | StillHere uses background location only when you turn on a feature that needs it, such as Safe Walk, Safety Timer, Drive Safety, active sharing with your Safety Circle, or an SOS in progress. If a check-in is missed or you trigger help, we will attempt to share your location with the contacts you chose so they can reach you. StillHere is not a continuous tracking app and does not collect location during calm time when you are in Presence mode or have sharing paused. |
| NSMotionUsageDescription | StillHere uses motion sensors to look for possible fall or vehicle-crash signals during Drive Safety and Safe Walk. These are best-effort sensor signals, not medical-grade detection. If a possible event is detected we will attempt to notify your Safety Circle. |
| NSMicrophoneUsageDescription | StillHere uses the microphone only for voice calls you start or answer inside the app with your Safety Circle. |

Notes:
- **NSLocationAlwaysUsageDescription:** deprecated by Apple (iOS 11+). Intentionally not set. Do not re-add it. `NSLocationAlwaysAndWhenInUseUsageDescription` is the correct key for background location.
- **Camera:** not requested. StillHere voice calls are audio-only (no video). Do not add `NSCameraUsageDescription` unless a video calling feature ships, otherwise Apple will flag the unused permission.
- **Contacts:** not requested. Emergency contacts are entered manually inside the app; iOS Contacts are never imported. Do not add `NSContactsUsageDescription`.
- **Notifications:** there is no `NSUserNotificationsUsageDescription` key. The system push prompt is not customizable. The in-app pre-permission education screen is what Apple recommends, and it is already implemented.
- **HealthKit (Watch):** `NSHealthShareUsageDescription` lives in the watchOS target (`apple-watch/StillHereWatch/Info.plist`), not in the iOS app. It is gated behind the user opting in to "Read heart rate from my Apple Watch" in Settings.

## Step 6: Configure Xcode Project

Open the project in Xcode:

```bash
npx cap open ios
```

In Xcode, configure:

1. **Signing & Capabilities**:
   - Select your Apple Developer Team
   - Set the Bundle Identifier to `com.stillhere.app`
   - Enable "Automatically manage signing"

2. **Add Capabilities** (click + Capability):
   - **Push Notifications** (required for check-in reminders)
   - **Background Modes**: Enable "Background fetch" and "Remote notifications"

3. **Deployment Target**: Set to iOS 16.0 minimum

4. **Device Orientation**: Portrait only (recommended for this app)

## Step 7: Configure the Server URL

The app needs to know where your backend server is. Edit `capacitor.config.json` before syncing:

```json
{
  "server": {
    "url": "https://your-deployed-app-url.replit.app",
    "iosScheme": "capacitor"
  }
}
```

Then sync again:
```bash
npx cap sync ios
```

**Important**: For App Store submission, the server URL must point to your production deployment, not a development server.

## Step 8: Build and Test

1. Connect an iPhone or select a simulator in Xcode
2. Press Cmd+R to build and run
3. Test the following flows:
   - Phone login with OTP
   - Passkey registration and login
   - "I'm OK" check-in
   - SOS alert
   - Push notification permissions
   - Video calling (camera/microphone permissions)
   - Fall detection (motion permissions)
   - Settings page
   - Emergency contact management

## Step 9: App Store Connect Setup

1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. Create a new app:
   - **Platform**: iOS
   - **Name**: StillHere
   - **Bundle ID**: com.stillhere.app
   - **SKU**: com-stillhere-app
   - **Primary Language**: English (U.S.)

3. Fill in required metadata:
   - **Subtitle**: Safety Check-in for Peace of Mind
   - **Category**: Health & Fitness (Primary), Lifestyle (Secondary)
   - **Age Rating**: 4+ (no objectionable content)
   - **Price**: Free (or your pricing choice)

4. **App Privacy** (required):
   - Phone Number: collected for account authentication
   - Location: collected with user permission for emergency sharing
   - Device Motion: used for fall detection, not shared

5. **Description** (suggested):
   ```
   StillHere is a simple daily check-in app designed for people who live alone,
   elderly individuals, and solo workers. With just one tap, let your loved ones
   know you're safe.

   Features:
   - One-tap daily check-in with "I'm OK" button
   - Emergency SOS button for immediate help
   - Automatic fall detection alerts
   - Video calling with emergency contacts
   - Secure passkey login (Face ID / Touch ID)
   - Customizable check-in schedules
   - Push notification reminders
   - Real-time messaging with contacts
   ```

6. **Keywords**: safety, check-in, elderly, alone, emergency, fall detection, SOS, wellness

## Step 10: Screenshots

You need screenshots for these device sizes:
- 6.7" (iPhone 15 Pro Max) - required
- 6.5" (iPhone 14 Plus) - optional
- 5.5" (iPhone 8 Plus) - optional

Capture at least 3 screenshots showing:
1. The "I'm OK" check-in home screen
2. The SOS / emergency button
3. The settings/contacts page

## Step 11: Archive and Submit

1. In Xcode: Product > Archive
2. In the Organizer, click "Distribute App"
3. Select "App Store Connect"
4. Upload the build
5. In App Store Connect, select the build for review
6. Submit for review

## Post-Submission Notes

- Apple review typically takes 1-3 days
- Ensure your production server is running and accessible
- Push notification certificates must be configured in Apple Developer Portal
- Test the production URL works before submitting

## Server Configuration for Production

Your deployed Replit app serves as the backend. Ensure these environment variables are set:
- `SESSION_SECRET` - Required for authentication
- `TWILIO_ACCOUNT_SID` - For SMS notifications
- `TWILIO_AUTH_TOKEN` - For SMS notifications
- `TWILIO_PHONE_NUMBER` - SMS sender number
- `DATABASE_URL` - PostgreSQL connection string

## Updating the App

When you make changes:

```bash
npm run build
npx cap sync ios
npx cap open ios
```

Then archive and submit the new version in Xcode.
