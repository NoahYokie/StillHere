# Load Testing Runbook

## Goal

Prove capacity before advertising. Do not claim 100,000-user readiness until these tests pass.

## Stages

1. Smoke: 10 virtual users for 5 minutes.
2. Small: 100 virtual users for 15 minutes.
3. Medium: 1,000 virtual users for 30 minutes.
4. Launch rehearsal: realistic traffic shape based on expected advertising spend.
5. Soak: steady traffic for 8 hours.

## Scenarios to simulate

- Login code request rate.
- Authenticated `/api/status` polling.
- Manual check-in.
- Settings update.
- Safety Circle contact add and resend request.
- Public emergency link open.
- Missed check-in cron tick with many due users.
- SMS webhook replies: YES, NO, STOP.
- Wellness call status webhooks.
- Weekly report generation.

## Pass criteria

- Cloud Run 5xx below 1%.
- p95 API latency under 2 seconds for normal app actions.
- Cron tick completes before the next scheduled tick.
- No duplicate incident SMS/calls for the same incident.
- Cloud SQL connections below 80% of limit.
- Twilio delivery failure rate understood and not caused by app bugs.

## Do not run heavy tests against production users

Use a staging project or isolated test users. Heavy tests can trigger real SMS/calls and create cost.
