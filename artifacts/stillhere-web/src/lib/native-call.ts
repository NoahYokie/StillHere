import { PushNotifications } from "@capacitor/push-notifications";
import { registerPlugin } from "@capacitor/core";

type NativeCallPlugin = {
  register: () => Promise<{ value?: string } | void>;
  endCall?: (options: { id: string }) => Promise<void>;
  addListener: (
    eventName: "registration" | "callAnswered" | "callEnded" | "callRejected",
    listenerFunc: (data: any) => void,
  ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
};

const CallKitVoip = registerPlugin<NativeCallPlugin>("CallKitVoip");

let voipToken: string | null = null;
let onCallAnsweredCallback: ((callId: string, callerId: string) => void) | null = null;
let onCallEndedCallback: ((callId: string) => void) | null = null;
let iosListenersRegistered = false;

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
    if (!iosListenersRegistered) {
      iosListenersRegistered = true;

      await CallKitVoip.addListener("registration", (data: { value?: string }) => {
        if (!data.value) return;
        voipToken = data.value;
        console.log("[NativeCall] VoIP token received, length:", voipToken.length);
        registerVoipTokenOnServer(voipToken, "ios");
      });

      await CallKitVoip.addListener("callAnswered", (data: { id?: string; callId?: string; callerId?: string }) => {
        const callId = data.callId || parseCallIdentifier(data.id).callId;
        const callerId = data.callerId || parseCallIdentifier(data.id).callerId;
        console.log("[NativeCall] Call answered via CallKit:", callId);
        if (callId && callerId && onCallAnsweredCallback) {
          onCallAnsweredCallback(callId, callerId);
        }
      });

      await CallKitVoip.addListener("callEnded", (data: { id?: string; callId?: string }) => {
        const callId = data.callId || parseCallIdentifier(data.id).callId;
        console.log("[NativeCall] Call ended via CallKit:", callId);
        if (callId && onCallEndedCallback) {
          onCallEndedCallback(callId);
        }
      });
    }

    const result = await CallKitVoip.register();
    if (result && typeof result.value === "string") {
      voipToken = result.value;
      await registerVoipTokenOnServer(voipToken, "ios");
    }
    console.log("[NativeCall] iOS CallKit registered");
    return voipToken;
  } catch (err) {
    console.error("[NativeCall] iOS CallKit init failed:", err);
    return null;
  }
}

function parseCallIdentifier(id?: string): { callId: string; callerId: string } {
  if (!id) return { callId: "", callerId: "" };
  const parts = id.split("|");
  return { callId: parts[0] || "", callerId: parts[1] || "" };
}

async function initAndroidPush(): Promise<string | null> {
  try {
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
    const response = await fetch("/api/voip-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token, platform }),
    });
    if (!response.ok) throw new Error(`status_${response.status}`);
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

export async function endNativeCall(callId: string): Promise<void> {
  if (!callId || getPlatform() !== "ios") return;
  try {
    await CallKitVoip.endCall?.({ id: callId });
  } catch (err) {
    console.warn("[NativeCall] Failed to end native CallKit call:", err);
  }
}
