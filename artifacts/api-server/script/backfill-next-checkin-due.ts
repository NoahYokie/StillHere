import { storage } from "../server/storage";
import { pool } from "../server/db";

const batchSize = Math.max(1, Math.min(5000, Number(process.env.CHECKIN_DUE_BACKFILL_BATCH_SIZE) || 2000));

try {
  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (;;) {
    const batch = await storage.backfillNextCheckinDueAt(batchSize);
    totalScanned += batch.scanned;
    totalUpdated += batch.updated;
    totalSkipped += batch.skipped;
    if (batch.scanned < batchSize || batch.updated === 0) break;
  }

  console.log(JSON.stringify({
    event: "NEXT_CHECKIN_BACKFILL_COMPLETE",
    totalScanned,
    totalUpdated,
    totalSkipped,
  }));
} finally {
  await pool.end().catch(() => {});
}
