# Native Push Readiness Runbook

## Current state

- Web push uses VAPID and is configured through Cloud Run secrets.
- Android/iOS call wake-up code can store native VoIP/FCM tokens.
- Production APNs/FCM credentials must be configured before App Store and Play Store testing.

## Required Google secrets

Create these before native push testing:

- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_AUTH_KEY`
- `APNS_BUNDLE_ID`
- `FCM_SERVER_KEY`

Do not add these to Git.

## iOS checks

- Bundle ID matches `APNS_BUNDLE_ID`.
- Push Notifications capability enabled.
- Background Modes enabled for the app features used.
- VoIP push requires the CallKit VoIP plugin and the correct `.voip` APNs topic.
- Test on a real device. Simulators are not enough for final push validation.

## Android checks

- Firebase project is linked to the Android package.
- `google-services.json` is present in the native Android project before building.
- FCM token registration reaches `/api/voip-token`.
- Background notification behavior is tested after force-close, screen lock, and battery saver.

## Pass criteria

- User receives normal safety push.
- User receives missed check-in push.
- Watcher receives Safety Circle request push when registered.
- Incoming call push wakes the app on Android.
- iOS call wake path works on a real device with APNs credentials.
