import { apiRequest } from "@/lib/queryClient";

type NativeNotificationResult =
  | { ok: true; status: "registered" }
  | { ok: false; status: "denied" | "unsupported" | "registration_failed"; message?: string };

function isPermissionGranted(value: unknown): boolean {
  return value === "granted";
}

export async function registerNativeNotifications(): Promise<NativeNotificationResult> {
  try {
    const pushPkg = "@capacitor/push-notifications";
    const Push = await import(/* @vite-ignore */ pushPkg);
    const PushNotifications = Push.PushNotifications;
    if (!PushNotifications?.requestPermissions || !PushNotifications?.register) {
      return { ok: false, status: "unsupported", message: "Native push plugin unavailable" };
    }

    const permission = await PushNotifications.requestPermissions();
    if (!isPermissionGranted(permission?.receive)) {
      return { ok: false, status: "denied" };
    }

    return await new Promise<NativeNotificationResult>(async (resolve) => {
      let settled = false;
      let registrationHandle: { remove?: () => Promise<void> } | undefined;
      let errorHandle: { remove?: () => Promise<void> } | undefined;

      const finish = async (result: NativeNotificationResult) => {
        if (settled) return;
        settled = true;
        try { await registrationHandle?.remove?.(); } catch {}
        try { await errorHandle?.remove?.(); } catch {}
        resolve(result);
      };

      registrationHandle = await PushNotifications.addListener("registration", async (token: { value?: string }) => {
        if (!token?.value) {
          await finish({ ok: false, status: "registration_failed", message: "No device token returned" });
          return;
        }

        try {
          await apiRequest("POST", "/api/push/native-token", {
            platform: "ios",
            token: token.value,
          });
          await finish({ ok: true, status: "registered" });
        } catch (error: any) {
          await finish({
            ok: false,
            status: "registration_failed",
            message: error?.message || "Could not save device token",
          });
        }
      });

      errorHandle = await PushNotifications.addListener("registrationError", async (error: any) => {
        await finish({
          ok: false,
          status: "registration_failed",
          message: error?.error || error?.message || "APNs registration failed",
        });
      });

      try {
        await PushNotifications.register();
      } catch (error: any) {
        await finish({
          ok: false,
          status: "registration_failed",
          message: error?.message || "APNs registration failed",
        });
      }

      window.setTimeout(() => {
        void finish({
          ok: false,
          status: "registration_failed",
          message: "Timed out waiting for iPhone notification registration",
        });
      }, 12000);
    });
  } catch (error: any) {
    return {
      ok: false,
      status: "registration_failed",
      message: error?.message || "Could not enable notifications",
    };
  }
}

export async function openNativeAppSettings(): Promise<void> {
  try {
    const appPkg = "@capacitor/app";
    const App = await import(/* @vite-ignore */ appPkg);
    await (App.App as any)?.openUrl?.({ url: "app-settings:" });
  } catch {
    try { window.location.href = "app-settings:"; } catch {}
  }
}
