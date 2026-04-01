interface VoipPushPayload {
  callId: string;
  callerId: string;
  callerName: string;
  callType: "video" | "audio";
}

export async function sendVoipPush(
  token: string,
  platform: string,
  payload: VoipPushPayload
): Promise<boolean> {
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
  const bundleId = "com.stillhere.app";

  if (!apnsKeyId || !apnsTeamId || !apnsKey) {
    console.log("[VOIP-PUSH] APNs not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY required). Skipping VoIP push.");
    return false;
  }

  try {
    const jwt = await generateAPNsJWT(apnsKeyId, apnsTeamId, apnsKey);

    const isProduction = process.env.NODE_ENV === "production";
    const host = isProduction
      ? "api.push.apple.com"
      : "api.sandbox.push.apple.com";

    const url = `https://${host}/3/device/${deviceToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "authorization": `bearer ${jwt}`,
        "apns-topic": `${bundleId}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: {},
        type: "incoming_call",
        callId: payload.callId,
        callerId: payload.callerId,
        callerName: payload.callerName,
        callType: payload.callType,
        uuid: payload.callId,
        handle: payload.callerName,
      }),
    });

    if (response.ok) {
      console.log(`[VOIP-PUSH] APNs VoIP push sent successfully to ${deviceToken.substring(0, 10)}...`);
      return true;
    } else {
      const body = await response.text();
      console.error(`[VOIP-PUSH] APNs error ${response.status}: ${body}`);
      return false;
    }
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
    key: key.includes("BEGIN") ? key : `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`,
    format: "pem",
  });

  const signature = crypto.sign("sha256", Buffer.from(unsignedToken), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${unsignedToken}.${signature.toString("base64url")}`;
}
