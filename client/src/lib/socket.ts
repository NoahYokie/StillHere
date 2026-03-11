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
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      console.log("[SOCKET] Connected:", socket?.id);
    });

    socket.on("disconnect", (reason) => {
      console.log("[SOCKET] Disconnected:", reason);
    });

    socket.on("connect_error", (error) => {
      console.error("[SOCKET] Connection error:", error.message);
    });

    socket.on("reconnect", (attemptNumber) => {
      console.log("[SOCKET] Reconnected after", attemptNumber, "attempts");
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
