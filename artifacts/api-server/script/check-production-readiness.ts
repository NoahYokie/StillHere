type Check = { name: string; ok: boolean; detail: string };

function present(name: string): boolean {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

function envCheck(name: string, required = true): Check {
  const ok = present(name);
  return { name, ok: required ? ok : true, detail: ok ? "set" : required ? "missing" : "optional" };
}

const checks: Check[] = [
  envCheck("DATABASE_URL"),
  envCheck("SESSION_SECRET"),
  envCheck("OUTBOUND_LOG_SECRET"),
  envCheck("BASE_URL"),
  envCheck("TWILIO_ACCOUNT_SID"),
  envCheck("TWILIO_AUTH_TOKEN"),
  envCheck("TWILIO_MESSAGING_SERVICE_SID"),
  envCheck("TWILIO_PHONE_NUMBER"),
  envCheck("TWILIO_VOICE_PHONE_NUMBER"),
  envCheck("VAPID_PUBLIC_KEY"),
  envCheck("VAPID_PRIVATE_KEY"),
  envCheck("RESEND_API_KEY"),
  envCheck("EMAIL_FROM"),
  envCheck("GOOGLE_MAPS_API_KEY"),
  envCheck("APNS_KEY_ID", false),
  envCheck("APNS_TEAM_ID", false),
  envCheck("APNS_AUTH_KEY", false),
  envCheck("APNS_BUNDLE_ID", false),
  envCheck("FCM_SERVER_KEY", false),
];

for (const name of ["DB_POOL_MAX", "DB_POOL_CONNECTION_TIMEOUT_MS", "DB_POOL_IDLE_TIMEOUT_MS", "DB_STATEMENT_TIMEOUT_MS", "TWILIO_SMS_MAX_CONCURRENT", "TWILIO_VOICE_MAX_CONCURRENT"]) {
  const raw = process.env[name];
  const n = Number(raw);
  checks.push({
    name,
    ok: Number.isFinite(n) && n > 0,
    detail: raw ? String(raw) : "missing",
  });
}

let failed = 0;
for (const check of checks) {
  const mark = check.ok ? "OK" : "FAIL";
  console.log(`${mark} ${check.name}: ${check.detail}`);
  if (!check.ok) failed++;
}

if (failed > 0) {
  console.error(`Production readiness check failed: ${failed} issue(s).`);
  process.exit(1);
}

console.log("Production readiness environment check passed.");
