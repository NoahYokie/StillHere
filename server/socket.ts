import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { db } from "./db";
import { authSessions, users } from "@shared/schema";
import { eq, and, gt } from "drizzle-orm";
import { storage } from "./storage";
import { sendPushNotification } from "./push";
import cookie from "cookie";

let io: SocketServer | null = null;
const onlineUsers = new Map<string, Set<string>>();

export function getIO(): SocketServer | null {
  return io;
}

export function isUserOnline(userId: string): boolean {
  const sockets = onlineUsers.get(userId);
  return !!sockets && sockets.size > 0;
}

export function emitToUser(userId: string, event: string, data: any): boolean {
  if (!io) return false;
  io.to(`user:${userId}`).emit(event, data);
  return true;
}

async function authenticateSocket(socket: Socket): Promise<string | null> {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || "");
    const token = cookies["stillhere_session"];
    if (!token) return null;

    const [session] = await db.select().from(authSessions).where(
      and(eq(authSessions.token, token), gt(authSessions.expiresAt, new Date()))
    );
    if (!session) return null;

    const [user] = await db.select().from(users).where(eq(users.id, session.userId));
    if (!user) return null;

    return user.id;
  } catch {
    return null;
  }
}

async function checkCommunicationPermission(userId: string, targetUserId: string): Promise<boolean> {
  try {
    const userContacts = await storage.getContacts(userId);
    const hasAsContact = userContacts.some(c => c.linkedUserId === targetUserId);
    if (hasAsContact) return true;

    const targetContacts = await storage.getContacts(targetUserId);
    const isContactOf = targetContacts.some(c => c.linkedUserId === userId);
    if (isContactOf) return true;

    return false;
  } catch {
    return false;
  }
}

export function setupSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: "*", credentials: true },
    path: "/socket.io",
  });

  io.on("connection", async (socket: Socket) => {
    const userId = await authenticateSocket(socket);
    if (!userId) {
      socket.disconnect();
      return;
    }

    (socket as any).userId = userId;
    socket.join(`user:${userId}`);

    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId)!.add(socket.id);

    socket.on("message:send", async (data: { receiverId: string; content: string }, callback?: Function) => {
      try {
        const canCommunicate = await checkCommunicationPermission(userId, data.receiverId);
        if (!canCommunicate) {
          if (callback) callback({ success: false, error: "Not authorized to message this user" });
          return;
        }

        const msg = await storage.saveMessage(userId, data.receiverId, data.content);
        socket.to(`user:${data.receiverId}`).emit("message:new", msg);
        if (callback) callback({ success: true, message: msg });

        if (!isUserOnline(data.receiverId)) {
          const sender = await storage.getUser(userId);
          await sendPushNotification(data.receiverId, {
            title: `Message from ${sender?.name || "Someone"}`,
            body: data.content.substring(0, 100),
            url: `/chat/${userId}`,
            tag: "new-message",
          });
        }
      } catch (error) {
        if (callback) callback({ success: false, error: "Failed to send message" });
      }
    });

    socket.on("message:read", async (data: { senderId: string }) => {
      try {
        await storage.markMessagesRead(data.senderId, userId);
        socket.to(`user:${data.senderId}`).emit("message:read-receipt", { readBy: userId });
      } catch {}
    });

    socket.on("call:initiate", async (data: { receiverId: string; callType: "video" | "audio"; offer: any }, callback?: Function) => {
      try {
        const canCall = await checkCommunicationPermission(userId, data.receiverId);
        if (!canCall) {
          if (callback) callback({ success: false, error: "Not authorized to call this user" });
          return;
        }

        const call = await storage.createCall(userId, data.receiverId, data.callType);
        const caller = await storage.getUser(userId);

        socket.to(`user:${data.receiverId}`).emit("call:incoming", {
          callId: call.id,
          callerId: userId,
          callerName: caller?.name || "Unknown",
          callType: data.callType,
          offer: data.offer,
        });

        if (callback) callback({ success: true, callId: call.id });

        if (!isUserOnline(data.receiverId)) {
          await sendPushNotification(data.receiverId, {
            title: `${data.callType === "video" ? "Video" : "Audio"} call from ${caller?.name || "Someone"}`,
            body: "Tap to answer",
            url: `/call/${userId}`,
            tag: "incoming-call",
          });
        }
      } catch (error) {
        if (callback) callback({ success: false, error: "Failed to initiate call" });
      }
    });

    socket.on("call:answer", async (data: { callId: string; callerId: string; answer: any }) => {
      try {
        const canCall = await checkCommunicationPermission(userId, data.callerId);
        if (!canCall) return;
        await storage.updateCall(data.callId, { status: "active", answeredAt: new Date() });
        socket.to(`user:${data.callerId}`).emit("call:answered", {
          callId: data.callId,
          answer: data.answer,
        });
      } catch {}
    });

    socket.on("call:ice-candidate", async (data: { targetUserId: string; candidate: any }) => {
      const canCall = await checkCommunicationPermission(userId, data.targetUserId);
      if (!canCall) return;
      socket.to(`user:${data.targetUserId}`).emit("call:ice-candidate", {
        candidate: data.candidate,
        fromUserId: userId,
      });
    });

    socket.on("call:end", async (data: { callId: string; targetUserId: string }) => {
      try {
        const canCall = await checkCommunicationPermission(userId, data.targetUserId);
        if (!canCall) return;
        await storage.updateCall(data.callId, { status: "ended", endedAt: new Date() });
        socket.to(`user:${data.targetUserId}`).emit("call:ended", { callId: data.callId });
      } catch {}
    });

    socket.on("call:reject", async (data: { callId: string; callerId: string }) => {
      try {
        const canCall = await checkCommunicationPermission(userId, data.callerId);
        if (!canCall) return;
        await storage.updateCall(data.callId, { status: "missed", endedAt: new Date() });
        socket.to(`user:${data.callerId}`).emit("call:rejected", { callId: data.callId });
      } catch {}
    });

    socket.on("disconnect", () => {
      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
        }
      }
    });
  });

  console.log("[SOCKET] WebSocket server initialized");
  return io;
}
