import { io, Socket } from "socket.io-client";
import { getNativeSessionToken, isNativeApp, NATIVE_API_ORIGIN } from "./native-api";

let socket: Socket | null = null;
let lastNativeSessionToken: string | null = null;

function getSocketAuth(): Record<string, string> | undefined {
  if (!isNativeApp()) return undefined;
  const token = getNativeSessionToken();
  return token ? { nativeSessionToken: token } : undefined;
}

export function getSocket(): Socket {
  const nativeSessionToken = isNativeApp() ? getNativeSessionToken() : null;

  if (!socket) {
    lastNativeSessionToken = nativeSessionToken;
    socket = io(isNativeApp() ? NATIVE_API_ORIGIN : undefined, {
      path: "/socket.io",
      withCredentials: true,
      auth: getSocketAuth(),
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      transports: ["websocket", "polling"],
      timeout: 20000,
    });

    socket.on("connect", () => {
      console.log("[SOCKET] Connected:", socket?.id, "transport:", socket?.io?.engine?.transport?.name);
    });

    socket.on("disconnect", (reason) => {
      console.log("[SOCKET] Disconnected:", reason);
    });

    socket.on("connect_error", (error) => {
      console.warn("[SOCKET] Connection error:", error.message);
    });

    socket.on("reconnect", (attemptNumber: number) => {
      console.log("[SOCKET] Reconnected after", attemptNumber, "attempts");
    });

    socket.io.on("reconnect_attempt", (attempt: number) => {
      console.log("[SOCKET] Reconnecting attempt:", attempt);
    });
  }

  if (isNativeApp() && socket && nativeSessionToken !== lastNativeSessionToken) {
    lastNativeSessionToken = nativeSessionToken;
    socket.auth = getSocketAuth() || {};
    socket.disconnect();
  } else if (isNativeApp() && socket) {
    socket.auth = getSocketAuth() || {};
  }

  if (!socket.connected) {
    socket.connect();
  }

  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
