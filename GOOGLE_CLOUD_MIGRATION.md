# StillHere Google Cloud Migration

This app is a full-stack Node/Express + React/Vite + Postgres app. The
production web/API service should run on Cloud Run, with Cloud SQL for
PostgreSQL and Secret Manager replacing Replit Secrets.

## Target Architecture

- Cloud Run: `stillhere-web`
- Cloud SQL for PostgreSQL: production database
- Secret Manager: all API keys and sensitive environment variables
- Artifact Registry: container images
- Cloud Build: build and deploy the container
- Codemagic: iOS build and App Store Connect upload

For launch, run Cloud Run with:

- `min-instances=1`
- `max-instances=1`
- CPU allocated while idle if enabled in the console

StillHere currently runs in-process background workers for check-ins and safety
state. Keeping one warm instance avoids duplicate worker ticks and avoids safety
timers stopping when the service scales to zero.

## Repo Changes For Google

Added:

- `Dockerfile`
- `.dockerignore`
- `cloudbuild.yaml`

Updated:

- `server/stripeClient.ts` now prefers `STRIPE_SECRET_KEY` and
  `STRIPE_PUBLISHABLE_KEY` before the Replit connector fallback.
- `server/revenuecatClient.ts` now prefers `REVENUECAT_SECRET_API_KEY` before
  the Replit connector fallback.
- `server/index.ts` now uses `BASE_URL` or `BRAND_BASE_URL` for the Stripe
  webhook URL before trying Replit domains.

## Required Production Secrets

Move these from Replit Secrets to Google Secret Manager or Cloud Run secret
environment variables.

Core:

- `DATABASE_URL`
- `SESSION_SECRET`
- `OUTBOUND_LOG_SECRET`
- `BASE_URL=https://stillhere.health`
- `BRAND_BASE_URL=https://stillhere.health`
- `NODE_ENV=production`

Twilio:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_MESSAGING_SERVICE_SID`
- `TWILIO_PHONE_NUMBER`
- `TWILIO_ALPHA_SENDER` if used

Email:

- `RESEND_API_KEY`
- `EMAIL_FROM`

Stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`

RevenueCat:

- `REVENUECAT_APPLE_API_KEY`
- `REVENUECAT_GOOGLE_API_KEY`
- `REVENUECAT_PROJECT_ID`
- `REVENUECAT_SECRET_API_KEY`
- `REVENUECAT_WEBHOOK_SECRET`

Google Maps:

- `GOOGLE_MAPS_API_KEY`

Push / web push:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

Apple push / VoIP if enabled:

- `APNS_AUTH_KEY`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `ENABLE_VOIP_PUSH=false` for launch unless explicitly enabled

Other:

- `SATELLITE_WEBHOOK_SECRET` if satellite endpoints are used
- `APPLE_REVIEW_PHONE`
- `APPLE_REVIEW_CODE`
- `ENABLE_APPLE_REVIEW_LOGIN`
- `WHITELIST_NUMBERS` if used
- `FCM_SERVER_KEY` only if Android FCM is enabled

Do not set Replit-only variables on Google unless you intentionally keep a
Replit fallback:

- `REPLIT_CONNECTORS_HOSTNAME`
- `REPL_IDENTITY`
- `WEB_REPL_RENEWAL`
- `REPLIT_DEPLOYMENT`
- `REPLIT_DEV_DOMAIN`
- `REPLIT_DOMAINS`

## Google Cloud Setup

Use one Google Cloud project for production.

```powershell
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Create an Artifact Registry repo:

```powershell
gcloud artifacts repositories create stillhere --repository-format=docker --location=australia-southeast1
```

Create Cloud SQL Postgres:

```powershell
gcloud sql instances create stillhere-prod --database-version=POSTGRES_16 --region=australia-southeast1 --tier=db-g1-small --storage-size=20GB
gcloud sql databases create stillhere --instance=stillhere-prod
gcloud sql users create stillhere_app --instance=stillhere-prod --password="REPLACE_WITH_STRONG_PASSWORD"
```

Recommended `DATABASE_URL` for Cloud SQL Unix socket:

```text
postgresql://stillhere_app:PASSWORD@/stillhere?host=/cloudsql/PROJECT_ID:australia-southeast1:stillhere-prod
```

When deploying to Cloud Run, attach the Cloud SQL instance:

```powershell
gcloud run services update stillhere-web --region=australia-southeast1 --add-cloudsql-instances=PROJECT_ID:australia-southeast1:stillhere-prod
```

## Secret Manager

Create each secret, then mount it as an environment variable on Cloud Run.

Example:

```powershell
echo "secret-value" | gcloud secrets create SESSION_SECRET --data-file=-
gcloud secrets add-iam-policy-binding SESSION_SECRET --member="serviceAccount:YOUR_RUNTIME_SERVICE_ACCOUNT" --role="roles/secretmanager.secretAccessor"
```

For the first deploy, it is acceptable to set environment variables in the Cloud
Run console, then move them into Secret Manager once the service boots.

## Build And Deploy

From the repo root:

```powershell
npm ci
npm run build
npx tsc --noEmit
```

Submit to Cloud Build:

```powershell
gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=australia-southeast1,_SERVICE=stillhere-web,_ARTIFACT_REPO=stillhere
```

After the first deployment, update Cloud Run manually or with `gcloud run
services update` to add:

- all secret environment variables
- Cloud SQL instance attachment
- min instances = 1
- max instances = 1

## Database Migration From Replit

Export Replit Postgres:

```bash
pg_dump "$REPLIT_DATABASE_URL" --no-owner --no-acl --format=custom --file=stillhere.dump
```

Import to Cloud SQL:

```bash
pg_restore --no-owner --no-acl --dbname="$GOOGLE_DATABASE_URL" stillhere.dump
```

Then run:

```powershell
npm run db:push
```

Run this only after confirming the Cloud SQL database is the intended target.

## Domain Cutover

When Cloud Run is healthy:

1. Add `stillhere.health` as a Cloud Run custom domain.
2. Update DNS records where the domain is hosted.
3. Set `BASE_URL=https://stillhere.health`.
4. Set `BRAND_BASE_URL=https://stillhere.health`.
5. Update provider webhooks:
   - Stripe: `https://stillhere.health/api/stripe/webhook`
   - RevenueCat: `https://stillhere.health/api/revenuecat/webhook`
   - Twilio inbound SMS/status URLs
   - any satellite webhook URLs

## Native App

Keep Capacitor. Do not rebuild in native Swift/Kotlin for launch.

Codemagic already has an iOS workflow. After the web/API service is on Google:

1. Confirm `BASE_URL` / production API URL points to `https://stillhere.health`.
2. Confirm `capacitor.config.json` production values.
3. Run Codemagic iOS build.
4. Upload to App Store Connect/TestFlight.

## Smoke Test Checklist

After Google deployment:

- Open `https://stillhere.health`
- `/api/health` if present, or login page loads
- OTP send
- login
- app check-in
- SMS check-in
- missed check-in escalation
- SOS link opens in browser without app
- resolved link shows no location
- all-clear link shows minimal page
- email alert CTA
- Stripe checkout
- Stripe portal
- RevenueCat webhook
- account deletion cleanup
- privacy pages and SEO metadata
- robots.txt and sitemap.xml

## Known Follow-Ups

- Move background workers to a dedicated worker service or Cloud Scheduler after
  launch if traffic grows or Cloud Run scaling changes.
- Add a 1200x630 OG image before public marketing.
- Add uptime monitoring and alerting.
- Add Cloud Logging metric filters for SMS failures and account deletion cleanup
  dead-letter rows.
