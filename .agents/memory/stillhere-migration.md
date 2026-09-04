---
name: StillHere Migration to Replit
description: Key decisions and wiring notes for the StillHere monorepo migration from Google Cloud to Replit
---

## Architecture
- **api-server** (`artifacts/api-server`) — StillHere Express 5 backend; runs with `NODE_ENV=development DISABLE_FRONTEND=1 tsx server/index.ts`
- **stillhere-web** (`artifacts/stillhere-web`) — StillHere React/Vite frontend; Tailwind v3 (NOT v4), PostCSS via `postcss.config.cjs`
- **lib/stillhere-shared** — Shared types/schema; declared as a pnpm workspace package with its own drizzle-orm/zod deps so tsx can resolve them across the package boundary

## Critical: DISABLE_FRONTEND
Server's `server/index.ts` is guarded: when `DISABLE_FRONTEND=1`, neither `serveStatic` nor `setupVite` runs. This env var is set in the dev script and in the shared env vars.

**Why:** On Replit, the frontend is a separate Vite process (stillhere-web artifact). The original StillHere served frontend from the same Express process.

## Critical: @shared/* path alias
Both api-server and stillhere-web have `"@shared/*": ["../../lib/stillhere-shared/src/*"]` in their tsconfig paths. Vite alias for stillhere-web also set to the same resolved path.

**Why:** StillHere's server and client both import from `@shared/schema` and `@shared/billing-products`. The alias bridges the package boundary without changing source imports.

## Critical: pnpm isolation for shared lib
`lib/stillhere-shared/package.json` MUST declare drizzle-orm, drizzle-zod, pg, zod as dependencies. Without them, tsx fails resolving drizzle-orm when processing the shared schema file (pnpm isolates node_modules per package).

## Tailwind v3 (NOT v4)
stillhere-web uses Tailwind v3 (`tailwindcss: ^3.4.17`). The scaffold was v4 but StillHere uses v3 syntax (`@tailwind base/components/utilities`) and `tailwind.config.ts`. Do NOT upgrade to v4 without migrating the CSS and config.

## DB Setup
`artifacts/api-server/drizzle.config.ts` manages the schema. Run `pnpm --filter @workspace/api-server run db:push` to sync schema. Migrations are in `artifacts/api-server/migrations/` (10 SQL files from original StillHere).

## Build Script Gap (known issue)
`build.mjs` still targets `src/index.ts` (old scaffold). Production build needs to be updated to target `server/index.ts`. Dev works fine with tsx.

## Source of Truth
Original StillHere repo: https://github.com/NoahYokie/StillHere.git (branch: build/release-candidate)
Cloned to /tmp/stillhere during migration (ephemeral — re-clone if needed)

## Secrets Required (not yet configured)
SESSION_SECRET ✓ (already in workspace)
DATABASE_URL ✓ (Replit-managed, auto-set)
Still needed: TWILIO_*, STRIPE_*, REVENUECAT_*, GOOGLE_MAPS_API_KEY, VAPID_*, RESEND_API_KEY, APNS_*
