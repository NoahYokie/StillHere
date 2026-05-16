const baseUrl = process.env.LOAD_TEST_BASE_URL || "https://stillhere.health";
const users = Math.max(1, Math.min(500, Number(process.env.LOAD_TEST_USERS || 10)));
const durationMs = Math.max(10_000, Number(process.env.LOAD_TEST_DURATION_MS || 60_000));

type Result = { ok: boolean; status: number; ms: number };

async function hit(path: string): Promise<Result> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, { headers: { "user-agent": "stillhere-load-smoke" } });
    return { ok: res.ok, status: res.status, ms: Date.now() - start };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - start };
  }
}

async function worker(results: Result[]) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    results.push(await hit("/api/health"));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main() {
  const results: Result[] = [];
  await Promise.all(Array.from({ length: users }, () => worker(results)));
  const failures = results.filter((r) => !r.ok).length;
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  console.log(JSON.stringify({ baseUrl, users, requests: results.length, failures, avgMs: Math.round(avg), p95Ms: p95 }, null, 2));
  if (failures > 0 || p95 > 2000) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
