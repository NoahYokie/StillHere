interface VoipPushPayload {
  callId: string;
  callerId: string;
  callerName: string;
  callType: "video" | "audio";
}

const VOIP_PUSH_ENABLED = process.env.ENABLE_VOIP_PUSH !== "false";
const IOS_BUNDLE_ID = "com.daudabangoura.stillhere.safety";

export function buildAPNsVoipPayload(payload: VoipPushPayload): Record<string, any> {
  return {
    aps: {},
    type: "incoming_call",
    callId: payload.callId,
    callerId: payload.callerId,
    callerName: payload.callerName,
    callType: payload.callType,
    uuid: payload.callId,
    handle: payload.callerName,
    id: `${payload.callId}|${payload.callerId}`,
  };
}

export async function sendVoipPush(
  token: string,
  platform: string,
  payload: VoipPushPayload
): Promise<boolean> {
  if (!VOIP_PUSH_ENABLED) {
    console.log("[VOIP-PUSH] Disabled (ENABLE_VOIP_PUSH=false). Normal call alert push will still be sent.");
    return false;
  }
  if (platform === "ios") {
    return sendAPNsVoipPush(token, payload);
  }
  if (platform === "android") {
    return sendFCMDataPush(token, payload);
  }
  console.warn(`[VOIP-PUSH] Unknown platform: ${platform}`);
  return false;
}

async function sendAPNsVoipPush(
  deviceToken: string,
  payload: VoipPushPayload
): Promise<boolean> {
  const apnsKeyId = process.env.APNS_KEY_ID;
  const apnsTeamId = process.env.APNS_TEAM_ID;
  const apnsKey = process.env.APNS_AUTH_KEY;

  if (!apnsKeyId || !apnsTeamId || !apnsKey) {
    console.log("[VOIP-PUSH] APNs not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY required). Skipping VoIP push.");
    return false;
  }

  try {
    const jwt = await generateAPNsJWT(apnsKeyId, apnsTeamId, apnsKey);
    const host = process.env.APNS_ENV === "sandbox" || process.env.NODE_ENV !== "production"
      ? "api.sandbox.push.apple.com"
      : "api.push.apple.com";

    const http2 = await import("http2");
    const body = JSON.stringify(buildAPNsVoipPayload(payload));
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const client = http2.connect(`https://${host}`);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try { client.close(); } catch {}
        fn();
      };

      client.setTimeout(10_000, () => finish(() => reject(new Error("apns_voip_timeout"))));
      client.on("error", (error) => finish(() => reject(error)));

      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": `${IOS_BUNDLE_ID}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
      });

      let status = 0;
      let chunks = "";
      req.setEncoding("utf8");
      req.on("response", (headers) => {
        const rawStatus = headers[":status"];
        status = typeof rawStatus === "number" ? rawStatus : parseInt(String(rawStatus || "0"), 10);
      });
      req.on("data", (chunk) => { chunks += chunk; });
      req.on("end", () => finish(() => resolve({ status, body: chunks })));
      req.on("error", (error) => finish(() => reject(error)));
      req.end(body);
    });

    if (response.status >= 200 && response.status < 300) {
      console.log(`[VOIP-PUSH] APNs VoIP push sent successfully to ${deviceToken.substring(0, 10)}...`);
      return true;
    }

    console.error(`[VOIP-PUSH] APNs error ${response.status}: ${response.body}`);
    return false;
  } catch (err) {
    console.error("[VOIP-PUSH] APNs push failed:", err);
    return false;
  }
}

async function sendFCMDataPush(
  fcmToken: string,
  payload: VoipPushPayload
): Promise<boolean> {
  const fcmServerKey = process.env.FCM_SERVER_KEY;

  if (!fcmServerKey) {
    console.log("[VOIP-PUSH] FCM not configured (FCM_SERVER_KEY required). Skipping data push.");
    return false;
  }

  try {
    const response = await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        "Authorization": `key=${fcmServerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: fcmToken,
        priority: "high",
        data: {
          type: "incoming_call",
          callId: payload.callId,
          callerId: payload.callerId,
          callerName: payload.callerName,
          callType: payload.callType,
        },
      }),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.success === 1) {
        console.log(`[VOIP-PUSH] FCM data push sent to ${fcmToken.substring(0, 10)}...`);
        return true;
      }
      console.error("[VOIP-PUSH] FCM delivery failed:", result);
      return false;
    } else {
      console.error(`[VOIP-PUSH] FCM error ${response.status}`);
      return false;
    }
  } catch (err) {
    console.error("[VOIP-PUSH] FCM push failed:", err);
    return false;
  }
}

async function generateAPNsJWT(keyId: string, teamId: string, key: string): Promise<string> {
  const crypto = await import("crypto");
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString("base64url");
  const unsignedToken = `${header}.${claims}`;

  const privateKey = crypto.createPrivateKey({
    key: normalizeAPNsPrivateKey(key),
    format: "pem",
  });

  const signature = crypto.sign("sha256", Buffer.from(unsignedToken), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${unsignedToken}.${signature.toString("base64url")}`;
}

function normalizeAPNsPrivateKey(key: string): string {
  const trimmed = key.trim().replace(/\\n/g, "\n");
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;
}
