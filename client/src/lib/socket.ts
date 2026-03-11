import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: "/socket.io",
      withCredentials: true,
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
