import { Capacitor } from "@capacitor/core";
import { apiRequest } from "@/lib/queryClient";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function isIOS(): boolean {
  return Capacitor.getPlatform() === "ios";
}

export async function initCapacitorPlugins() {
  if (!isNative()) return;
  const syncBadge = () => {
    apiRequest("POST", "/api/messages/badge/sync").catch(() => {});
  };
  syncBadge();

  if (isIOS()) {
    document.body.classList.add("capacitor-ios");
  }

  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Light });
    if (!isIOS()) {
      await StatusBar.setBackgroundColor({ color: "#0ea5e9" });
    }
  } catch {}

  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch {}

  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    Keyboard.addListener("keyboardWillShow", () => {
      document.body.classList.add("keyboard-open");
    });
    Keyboard.addListener("keyboardWillHide", () => {
      document.body.classList.remove("keyboard-open");
    });
  } catch {}

  try {
    const { App } = await import("@capacitor/app");
    App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      }
    });
    App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) syncBadge();
    });
  } catch {}

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    PushNotifications.addListener("pushNotificationActionPerformed", (event: any) => {
      const url = event?.notification?.data?.url || event?.notification?.data?.link;
      if (typeof url !== "string" || !url.startsWith("/")) return;
      window.history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  } catch {}
}
