# StillHere Native App Build Guide

This guide walks you through building StillHere as a native Android and iOS app using Capacitor. You do not need a Mac for Android. For iOS, you will need a cloud build service.

## Prerequisites

### For Android (on your Windows/Lenovo laptop)

1. **Node.js 22+**: Download from https://nodejs.org (LTS version)
2. **Android Studio**: Download from https://developer.android.com/studio
   - During install, make sure to include: Android SDK, Android SDK Platform, Android Virtual Device
3. **Java JDK 17**: Android Studio usually installs this, but if not: https://adoptium.net
4. **Git**: https://git-scm.com/downloads

### For iOS (cloud build, no Mac needed)

You have several options:
- **Codemagic** (recommended): https://codemagic.io - Free tier available, builds iOS in the cloud
- **Ionic Appflow**: https://ionic.io/appflow
- **GitHub Actions with macOS runner**: If your code is on GitHub

For iOS you will also need:
- An **Apple Developer Account** ($99/year): https://developer.apple.com
- Provisioning profiles and certificates (Codemagic can manage these for you)

## Step 1: Clone the project

Download or clone your project from Replit to your laptop.

```bash
git clone <your-replit-git-url>
cd stillhere
```

Or use Replit's "Download as ZIP" option from the three-dot menu.

## Step 2: Install dependencies

```bash
npm install
```

## Step 3: Build the web app

```bash
npm run build
```

This creates the `dist/public` folder that Capacitor will bundle into the native app.

## Step 4: Add native platforms

### Android
```bash
npx cap add android
```

### iOS
```bash
npx cap add ios
```

## Step 5: Copy web assets to native projects

```bash
npx cap sync
```

This copies the built web app into the native projects and installs native dependencies.

## Step 6: Configure Android

### Open in Android Studio
```bash
npx cap open android
```

### Set permissions
Open `android/app/src/main/AndroidManifest.xml` and make sure these permissions are present:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
```

### Set app icon
Copy your icon files to the Android resource directories:
- `android/app/src/main/res/mipmap-hdpi/` (72x72)
- `android/app/src/main/res/mipmap-mdpi/` (48x48)
- `android/app/src/main/res/mipmap-xhdpi/` (96x96)
- `android/app/src/main/res/mipmap-xxhdpi/` (144x144)
- `android/app/src/main/res/mipmap-xxxhdpi/` (192x192)

Or use Android Studio's Image Asset tool: right-click `res` > New > Image Asset, and select the 1024x1024 icon from `client/public/icons/icon-1024x1024.png`.

### Set splash screen color
In `android/app/src/main/res/values/styles.xml`, the splash background is already configured via `capacitor.config.json` to use `#0ea5e9` (StillHere blue).

### Run on device or emulator
1. Connect your Android phone via USB (enable Developer Options and USB Debugging first)
2. Or create an emulator in Android Studio: Tools > Device Manager > Create Device
3. Click the green Run button in Android Studio

### Build a release APK
1. In Android Studio: Build > Generate Signed Bundle / APK
2. Choose APK or Android App Bundle (AAB for Play Store)
3. Create a new keystore (save this securely, you need it for updates)
4. Build the release version

## Step 7: Configure iOS

### If using Codemagic (recommended for no-Mac setup)

1. Push your code to GitHub or GitLab
2. Sign up at https://codemagic.io
3. Connect your repository
4. Set up an iOS workflow:
   - Build type: Capacitor
   - Xcode version: Latest
   - Add your Apple Developer certificates and provisioning profiles
5. Codemagic will build the IPA file for you

### iOS-specific setup (done in Xcode or Codemagic config)

Add these to `ios/App/App/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>StillHere uses your location to share it with your emergency contacts when you choose to.</string>

<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>StillHere needs background location access to keep sharing your location with emergency contacts even when the app is in the background.</string>

<key>NSCameraUsageDescription</key>
<string>StillHere uses the camera for video calls with your emergency contacts.</string>

<key>NSMicrophoneUsageDescription</key>
<string>StillHere uses the microphone for voice calls with your emergency contacts.</string>

<key>NSMotionUsageDescription</key>
<string>StillHere uses motion sensors to detect falls and alert your emergency contacts.</string>

<key>UIBackgroundModes</key>
<array>
    <string>location</string>
    <string>fetch</string>
    <string>remote-notification</string>
    <string>audio</string>
    <string>voip</string>
</array>
```

### iOS App Icons
The icon files are already prepared in `client/public/ios-icons/`. Copy them to the Xcode asset catalog:
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/`

## Step 8: Set up push notifications

### Android (Firebase Cloud Messaging)
1. Go to https://console.firebase.google.com
2. Create a new project "StillHere"
3. Add an Android app with package name `com.stillhere.app`
4. Download `google-services.json` and place it in `android/app/`
5. Follow Firebase setup instructions for your Gradle files

### iOS (Apple Push Notification Service)
1. In your Apple Developer account, create an APNs key
2. Upload it to your push notification service
3. Configure the push certificate in Codemagic or your CI system

## Step 9: Connect to your server

The native app loads the web content locally (from the bundled files). API calls go to your deployed Replit server automatically because the app uses relative URLs that are handled by Capacitor's server.

If you want the native app to connect to your live server instead of bundling locally, add this to `capacitor.config.json`:

```json
{
  "server": {
    "url": "https://your-app.replit.app",
    "cleartext": false
  }
}
```

This is useful during development. Remove it for production builds (the bundled version is faster and works offline).

## Step 10: Publish to app stores

### Google Play Store
1. Create a developer account at https://play.google.com/console ($25 one-time fee)
2. Create a new app listing
3. Upload your signed AAB file
4. Fill in the store listing (description, screenshots, etc.)
5. Submit for review

### Apple App Store
1. You need an Apple Developer account ($99/year)
2. Create an app in App Store Connect: https://appstoreconnect.apple.com
3. Upload your IPA via Codemagic (it can upload directly to App Store Connect)
4. Fill in the store listing
5. Submit for review

## Common commands

```bash
# Build web app
npm run build

# Sync web app to native projects
npx cap sync

# Open Android project
npx cap open android

# Open iOS project (requires Mac)
npx cap open ios

# Run on Android device
npx cap run android

# Run on iOS device (requires Mac)
npx cap run ios

# Update native plugins
npx cap update
```

## Updating the app

When you make changes to the web app:

1. Make your changes in the Replit editor
2. Download the updated code
3. Run `npm run build`
4. Run `npx cap sync`
5. Build and deploy through Android Studio or Codemagic

## Troubleshooting

### "JAVA_HOME is not set"
Set the JAVA_HOME environment variable to your JDK installation path. In Windows:
- System Properties > Environment Variables > New System Variable
- Variable name: JAVA_HOME
- Variable value: C:\Program Files\Java\jdk-17 (or wherever your JDK is)

### "SDK location not found"
In the `android/` folder, create a file called `local.properties` with:
```
sdk.dir=C:\\Users\\YourName\\AppData\\Local\\Android\\Sdk
```

### Android emulator is slow
- Enable hardware acceleration (HAXM or Hyper-V) in your BIOS
- Use an x86_64 system image instead of ARM

### Push notifications not working
- Make sure you've added `google-services.json` (Android) or configured APNs (iOS)
- Ensure the app has notification permissions granted on the device

### Background location stops working
- On Android 12+, users must manually grant "Allow all the time" location permission
- On iOS, make sure "Always" location permission is requested and the background modes are configured in Info.plist
