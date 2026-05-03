# StillHere — App Store & Google Play Submission Checklist

Everything in this repo is wired up for in-app purchases on iOS and Android. This file is the one-stop checklist for the work you have to do *outside* the codebase before you can submit.

App identifier: **`com.daudabangoura.stillhere.app`**
Product (single, two cadences): **StillHere Premium** — $7.99/mo, $59.99/yr
Entitlement id used everywhere: **`premium`**

---

## 0. One-time prep on your Mac

```bash
# Use Node 22 LTS (Capacitor 8 requires it)
nvm install 22 && nvm use 22

git pull
npm install
npm run build           # builds dist/public

npx cap add android     # only if android/ folder doesn't exist yet
npx cap sync ios        # copies web build + native plugins (incl. RevenueCat) into Xcode project
npx cap sync android    # same for Android Studio project
```

`cap sync` automatically:
- adds `RevenuecatPurchasesCapacitor` to the iOS Podfile (already wired)
- adds the `com.android.vending.BILLING` permission to AndroidManifest.xml
- merges the `infoPlist` block from `capacitor.config.json` into iOS Info.plist

---

## 1. Apple — App Store Connect

### 1a. Create the app
1. https://appstoreconnect.apple.com → **My Apps → +**
2. Bundle ID: `com.daudabangoura.stillhere.app` (must match `capacitor.config.json` and Xcode signing)
3. SKU: `stillhere`
4. Primary language: English

### 1b. Create the auto-renewable subscription
1. **App Store Connect → your app → Monetization → Subscriptions**
2. Create a new **Subscription Group**: `StillHere Premium`
3. Add subscription **Monthly**:
   - Product ID: **`stillhere_premium_monthly`**  ← exact string, lowercase, used in code
   - Reference name: `StillHere Premium Monthly`
   - Duration: 1 month
   - Price: $7.99 (US tier 8) — tiers in other regions can stay default
4. Add subscription **Yearly** *(same group)*:
   - Product ID: **`stillhere_premium_yearly`**
   - Reference name: `StillHere Premium Yearly`
   - Duration: 1 year
   - Price: $59.99
5. Localised display name + description for each (Apple requires it):
   - Display: `Premium Monthly` / `Premium Yearly`
   - Description: `Unlock full StillHere safety monitoring, live location, and 24/7 alerts.`
6. Subscription **Privacy URL** + **Terms URL** — point these at `/privacy` and `/terms` on your deployed domain.
7. Add the **Review Information** screenshot (a 1284×2778 PNG of `/billing` works) and reviewer notes: *"Premium unlocks live location sharing, geofencing, and crash detection. Tap Subscribe to test in sandbox."*

### 1c. Generate the App Store Connect API key (RevenueCat needs this)
1. **Users and Access → Integrations → App Store Connect API → +**
2. Name: `RevenueCat`. Access: **App Manager**.
3. Download the `.p8` file (one-time). Note the **Issuer ID** and **Key ID**.

### 1d. Xcode signing
1. Open `ios/App/App.xcworkspace`.
2. Select target **App → Signing & Capabilities**.
3. Team: your Apple Dev team. Bundle ID: `com.daudabangoura.stillhere.app`.
4. Capabilities (+ button) — make sure these are added:
   - **In-App Purchase**  ← required
   - **Push Notifications**
   - **Background Modes**: Location updates, Background fetch, Remote notifications, Background processing
5. Increment build number → **Product → Archive → Distribute → App Store Connect**.

### 1e. Sandbox testers
**App Store Connect → Users and Access → Sandbox Testers → +**. Create one with a fake email; sign in to that account on a real device under **Settings → App Store → Sandbox Account** before testing purchases.

---

## 2. Google — Play Console

### 2a. Create the app
1. https://play.google.com/console → **All apps → Create app**
2. Default language: English. App or game: App. Free or paid: Free (purchases are in-app).
3. Package name: `com.daudabangoura.stillhere.app`

### 2b. Create the subscription
1. **Monetize → Products → Subscriptions → Create subscription**
2. Product ID: **`stillhere_premium_monthly`**, Name: `StillHere Premium Monthly`
3. Add a base plan: **Auto-renewing**, Billing period: 1 month, Price: $7.99
4. Repeat for **`stillhere_premium_yearly`** (1 year, $59.99) — same backing entitlement, different product
5. Activate both

### 2c. Service account for RevenueCat
1. **Setup → API access → Choose a project → Link an existing project** (or create one in Google Cloud Console)
2. Create a service account in Google Cloud Console with role **Pub/Sub Admin** (for real-time notifications)
3. Back in Play Console → **API access → Grant access** to that service account, give it **View financial data**, **Manage orders and subscriptions**, **Manage store presence**.
4. Download the service account JSON key.
5. Enable **real-time developer notifications** (Monetize → Monetization setup → Real-time developer notifications) and paste the Pub/Sub topic name from RevenueCat's dashboard *(filled in below)*.

### 2d. Signing
Use Play App Signing — Google manages the upload key for you. Just generate an upload key locally:
```bash
cd android
./gradlew bundleRelease   # output at android/app/build/outputs/bundle/release/app-release.aab
```
Upload the `.aab` to Play Console → **Production / Internal testing → Create release**.

---

## 3. RevenueCat dashboard — connects everything

### 3a. Apps
1. https://app.revenuecat.com → your project → **Project Settings → Apps**
2. **+ New** → **App Store** — Bundle ID `com.daudabangoura.stillhere.app`
   - Upload the `.p8` from step 1c, paste Issuer ID + Key ID
3. **+ New** → **Play Store** — Package name `com.daudabangoura.stillhere.app`
   - Upload the service account JSON from step 2c

### 3b. Products
**Project Settings → Products → + New**
- Identifier: `stillhere_premium_monthly` — link to both the App Store product and the Play Store product of the same id
- Identifier: `stillhere_premium_yearly` — same

### 3c. Entitlement
**Entitlements → + New** → identifier **`premium`** → attach both products to it.

### 3d. Offering
**Offerings → + New**
- Identifier: **`default`** *(must match `PREMIUM_OFFERING_ID` in `shared/billing-products.ts`)*
- Mark as **Current**
- Add packages:
  - **Monthly** package → product `stillhere_premium_monthly`
  - **Annual** package → product `stillhere_premium_yearly`

### 3e. Public API keys → paste into Replit Secrets
**Project Settings → API keys → Public app-specific API keys**
- iOS key → Replit Secret **`REVENUECAT_APPLE_API_KEY`**
- Android key → Replit Secret **`REVENUECAT_GOOGLE_API_KEY`**

### 3f. Webhook → server-to-server entitlement updates
**Project Settings → Integrations → Webhooks → + Add**
- URL: `https://<your-deployed-domain>/api/revenuecat/webhook`
- Authorization header value: any random string → also save it as Replit Secret **`REVENUECAT_WEBHOOK_SECRET`**
- Send all event types
- Save → click **Send test event** to confirm the server returns 200

After this, every renewal/refund/cancellation on iOS or Android will update `users.premiumUntil` automatically — same field the web Stripe path writes to.

---

## 4. Replit Secrets — final list

Already configured:
- `STRIPE_*` (handled by the Stripe connector, no manual action)

Add these three for mobile:
- `REVENUECAT_APPLE_API_KEY`
- `REVENUECAT_GOOGLE_API_KEY`
- `REVENUECAT_WEBHOOK_SECRET`

---

## 5. What the codebase already does for you

- `capacitor.config.json` already has the right `appId`, location-permission rationales, background modes, push notifications config and `iosScheme`.
- `ios/App/Podfile` includes `RevenuecatPurchasesCapacitor` (just `pod install` after `cap sync ios`).
- `client/src/lib/revenuecat.ts` configures RC with the user's id as `appUserID`, fetches the **`default`** offering, exposes `purchase` and `restore`.
- `/billing` page automatically hides Stripe and shows native pricing on iOS/Android, including a **Restore purchases** button (Apple requires this — already there).
- `/api/revenuecat/webhook` verifies the shared secret, scopes events to the **`premium`** entitlement, drops stale/out-of-order events, and respects expiration timestamps so cancelled users keep paid time.
- `shared/billing-products.ts` is the single place that knows the product IDs — change them once, both web and mobile follow.
- The Stripe webhook is already registered with the right middleware ordering (`express.raw` before `express.json`, signature-verified, exempt from rate limiting).

---

## 6. Submission order

1. Add the three Replit secrets → redeploy
2. Apple: create app + 2 subscriptions (status: **Ready to Submit**)
3. Google: create app + 2 subscriptions (status: **Active**)
4. RevenueCat: link both apps, products, entitlement, offering, webhook
5. Sandbox-test on a real iPhone *(Sandbox tester signed in)* — buy monthly, confirm `/billing` flips to Active and `users.premiumUntil` updates in your DB
6. Internal-test on Android the same way (License testers in Play Console)
7. Submit your **first build** to TestFlight + Play Internal Testing
8. Once Apple + Google approve the IAPs (often same day), submit the production release
