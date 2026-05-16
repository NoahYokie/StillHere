# Backup And Restore Runbook

## Goal

StillHere must survive laptop loss and production database failure. Source code is in GitHub; production data is in Google Cloud SQL.

## Daily backup requirements

- Enable automated Cloud SQL backups.
- Enable point-in-time recovery.
- Keep at least 7 days of backups for normal recovery.
- Keep a monthly export for long-term disaster recovery.

## Verify backup settings

```powershell
& 'C:\Users\dd124\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' sql instances describe stillhere-prod --project stillhere-492915 --format='yaml(settings.backupConfiguration)'
```

Required result:

- `enabled: true`
- `pointInTimeRecoveryEnabled: true`
- a real backup start time

## Restore drill

Do this before a large public launch.

1. Create a temporary restore instance from the latest backup.
2. Run `npm run db:push` against the restored database.
3. Start a temporary Cloud Run service pointed at the restored database.
4. Confirm login, check-in, Safety Circle, watcher links, SMS webhook, and reports load correctly.
5. Delete the temporary service and restore instance.

## Failure response

If production database is damaged:

1. Stop deploys.
2. Disable cron processing if duplicate alerts are possible.
3. Restore Cloud SQL to a new instance.
4. update `DATABASE_URL` secret to the restored instance.
5. Deploy Cloud Run.
6. Verify `/api/health`.
7. Re-enable cron.
