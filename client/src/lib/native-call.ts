let voipToken: string | null = null;
let onCallAnsweredCallback: ((callId: string, callerId: string) => void) | null = null;
let onCallEndedCallback: ((callId: string) => void) | null = null;

export function isNativePlatform(): boolean {
  try {
    if (typeof (window as any)?.Capacitor !== "undefined") {
      return (window as any).Capacitor.isNativePlatform();
    }
  } catch {}
  return false;
}

export function getPlatform(): "ios" | "android" | "web" {
  try {
    if (typeof (window as any)?.Capacitor !== "undefined") {
      const p = (window as any).Capacitor.getPlatform();
      if (p === "ios") return "ios";
      if (p === "android") return "android";
    }
  } catch {}
  return "web";
}

export async function initNativeCall(): Promise<string | null> {
  if (!isNativePlatform()) {
    console.log("[NativeCall] Not a native platform, skipping");
    return null;
  }

  const platform = getPlatform();
  console.log("[NativeCall] Initializing on", platform);

  try {
    if (platform === "ios") {
      return await initIOSCallKit();
    }
    if (platform === "android") {
      return await initAndroidPush();
    }
  } catch (err) {
    console.error("[NativeCall] Init failed:", err);
  }

  return null;
}

async function initIOSCallKit(): Promise<string | null> {
  try {
    const mod = await new Function('return import("capacitor-plugin-callkit-voip")')();
    const CallKitVoip = mod.CallKitVoip;

    CallKitVoip.addListener("registration", (data: { value: string }) => {
      voipToken = data.value;
      console.log("[NativeCall] VoIP token received, length:", voipToken.length);
      registerVoipTokenOnServer(voipToken, "ios");
    });

    CallKitVoip.addListener("callAnswered", (data: { id: string }) => {
      console.log("[NativeCall] Call answered via CallKit:", data.id);
      if (onCallAnsweredCallback) {
        const parts = data.id.split("|");
        onCallAnsweredCallback(parts[0], parts[1] || "");
      }
    });

    CallKitVoip.addListener("callEnded", (data: { id: string }) => {
      console.log("[NativeCall] Call ended via CallKit:", data.id);
      if (onCallEndedCallback) {
        onCallEndedCallback(data.id.split("|")[0]);
      }
    });

    await CallKitVoip.register();
    console.log("[NativeCall] iOS CallKit registered");
    return voipToken;
  } catch (err) {
    console.error("[NativeCall] iOS CallKit init failed:", err);
    return null;
  }
}

async function initAndroidPush(): Promise<string | null> {
  try {
    const mod = await new Function('return import("@capacitor/push-notifications")')();
    const PushNotifications = mod.PushNotifications;

    const result = await PushNotifications.requestPermissions();
    if (result.receive !== "granted") {
      console.warn("[NativeCall] Android push permission denied");
      return null;
    }

    await PushNotifications.register();

    return new Promise((resolve) => {
      PushNotifications.addListener("registration", (token: { value: string }) => {
        voipToken = token.value;
        console.log("[NativeCall] FCM token, length:", voipToken.length);
        registerVoipTokenOnServer(voipToken, "android");
        resolve(voipToken);
      });

      PushNotifications.addListener("registrationError", (err: any) => {
        console.error("[NativeCall] Android registration error:", err);
        resolve(null);
      });

      PushNotifications.addListener("pushNotificationReceived", (notification: any) => {
        if (notification.data?.type === "incoming_call" && onCallAnsweredCallback) {
          onCallAnsweredCallback(notification.data.callId, notification.data.callerId);
        }
      });

      setTimeout(() => resolve(null), 10000);
    });
  } catch (err) {
    console.error("[NativeCall] Android init failed:", err);
    return null;
  }
}

async function registerVoipTokenOnServer(token: string, platform: string): Promise<void> {
  try {
    await fetch("/api/voip-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token, platform }),
    });
    console.log("[NativeCall] VoIP token registered on server");
  } catch (err) {
    console.error("[NativeCall] Failed to register VoIP token:", err);
  }
}

export function setCallCallbacks(
  onAnswered: (callId: string, callerId: string) => void,
  onEnded: (callId: string) => void
): void {
  onCallAnsweredCallback = onAnswered;
  onCallEndedCallback = onEnded;
}

export function getVoipToken(): string | null {
  return voipToken;
}
