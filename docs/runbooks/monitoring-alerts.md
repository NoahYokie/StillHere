# Monitoring And Alerts Runbook

## Required alerts

Create Google Cloud alert policies for:

- Cloud Run 5xx response rate above 1% for 5 minutes.
- Cloud Run request latency p95 above 2 seconds for 5 minutes.
- Cloud Run instance count at max scale for 10 minutes.
- Cloud SQL CPU above 80% for 10 minutes.
- Cloud SQL memory above 80% for 10 minutes.
- Cloud SQL connection usage above 80% for 10 minutes.
- Cloud SQL disk usage above 80%.
- Log match: `Error in cron tick`.
- Log match: `Error in safety-state tick`.
- Log match: `TWILIO` and `failed`.
- Log match: `WELLNESS CALL` and `failed`.
- Log match: `PUSH` and `all_subscriptions_failed`.

## Useful log queries

Recent app errors:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="stillhere-web"
severity>=ERROR
```

Cron failures:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="stillhere-web"
("Error in cron tick" OR "Error in safety-state tick")
```

Twilio failures:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="stillhere-web"
("SMS-STATUS" OR "WELLNESS CALL" OR "Twilio") ("failed" OR "undelivered" OR "error")
```

## Launch watch

During paid advertising or press launch, keep these open:

- Cloud Run requests/latency/errors.
- Cloud SQL CPU/memory/connections.
- Twilio Messaging logs.
- Twilio Voice logs.
- StillHere app logs filtered to `ESCALATION`, `CRON`, `SMS`, `WELLNESS CALL`, and `PUSH`.
