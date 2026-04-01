import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { db } from "./db";
import { authSessions, users } from "@shared/schema";
import { eq, and, gt } from "drizzle-orm";
import { storage } from "./storage";
import { sendPushNotification } from "./push";
import { sendVoipPush } from "./voip-push";
import cookie from "cookie";

let io: SocketServer | null = null;
const onlineUsers = new Map<string, Set<string>>();
const permissionCache = new Map<string, { result: boolean; timestamp: number }>();
const PERMISSION_CACHE_TTL = 60000;

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
  const cacheKey = [userId, targetUserId].sort().join(":");
  const cached = permissionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PERMISSION_CACHE_TTL) {
    return cached.result;
  }

  try {
    const userContacts = await storage.getContacts(userId);
    const hasAsContact = userContacts.some(c => c.linkedUserId === targetUserId);
    if (hasAsContact) {
      permissionCache.set(cacheKey, { result: true, timestamp: Date.now() });
      return true;
    }

    const targetContacts = await storage.getContacts(targetUserId);
    const isContactOf = targetContacts.some(c => c.linkedUserId === userId);
    permissionCache.set(cacheKey, { result: isContactOf, timestamp: Date.now() });
    return isContactOf;
  } catch (err) {
    console.error("[SOCKET] Permission check failed:", err);
    return false;
  }
}

const activeCallPairs = new Map<string, string>();

function getCallPairKey(userA: string, userB: string): string {
  return [userA, userB].sort().join(":");
}

export function setupSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    pingTimeout: 30000,
    pingInterval: 15000,
    maxHttpBufferSize: 1e6,
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

    console.log(`[SOCKET] User ${userId} connected (socket: ${socket.id}, total: ${onlineUsers.get(userId)!.size})`);

    socket.on("message:send", async (data: { receiverId: string; content: string }, callback?: Function) => {
      try {
        const canCommunicate = await checkCommunicationPermission(userId, data.receiverId);
        if (!canCommunicate) {
          if (callback) callback({ success: false, error: "Not authorized" });
          return;
        }
        const msg = await storage.saveMessage(userId, data.receiverId, data.content);
        io!.to(`user:${data.receiverId}`).emit("message:new", msg);
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
        console.error("[SOCKET] message:send error:", error);
        if (callback) callback({ success: false, error: "Failed" });
      }
    });

    socket.on("message:read", async (data: { senderId: string }) => {
      try {
        await storage.markMessagesRead(data.senderId, userId);
        io!.to(`user:${data.senderId}`).emit("message:read-receipt", { readBy: userId });
      } catch {}
    });

    socket.on("call:initiate", async (data: { receiverId: string; callType: "video" | "audio"; offer: any }, callback?: Function) => {
      console.log(`[CALL] ${userId} initiating ${data.callType} call to ${data.receiverId}`);
      try {
        const canCall = await checkCommunicationPermission(userId, data.receiverId);
        if (!canCall) {
          console.log(`[CALL] Permission denied`);
          if (callback) callback({ success: false, error: "Not authorized" });
          return;
        }

        const pairKey = getCallPairKey(userId, data.receiverId);
        if (activeCallPairs.has(pairKey)) {
          console.log(`[CALL] Call already active between these users, rejecting`);
          if (callback) callback({ success: false, error: "Call already in progress" });
          return;
        }

        const call = await storage.createCall(userId, data.receiverId, data.callType);
        activeCallPairs.set(pairKey, call.id);

        const caller = await storage.getUser(userId);
        const receiverOnline = isUserOnline(data.receiverId);
        console.log(`[CALL] Call ${call.id} created. Receiver online: ${receiverOnline}`);

        io!.to(`user:${data.receiverId}`).emit("call:incoming", {
          callId: call.id,
          callerId: userId,
          callerName: caller?.name || "Unknown",
          callType: data.callType,
          offer: data.offer,
        });

        if (callback) callback({ success: true, callId: call.id });

        if (!receiverOnline) {
          const voipTokens = await storage.getVoipTokens(data.receiverId);
          if (voipTokens.length > 0) {
            console.log(`[CALL] Receiver has ${voipTokens.length} VoIP token(s), sending VoIP push`);
            for (const vt of voipTokens) {
              await sendVoipPush(vt.token, vt.platform, {
                callId: call.id,
                callerId: userId,
                callerName: caller?.name || "Someone",
                callType: data.callType,
              });
            }
          }

          await sendPushNotification(data.receiverId, {
            title: `${data.callType === "video" ? "Video" : "Audio"} call from ${caller?.name || "Someone"}`,
            body: "Tap to answer",
            url: `/call/${userId}`,
            tag: "incoming-call",
          });
        }
      } catch (error) {
        console.error("[CALL] initiate error:", error);
        if (callback) callback({ success: false, error: "Failed" });
      }
    });

    socket.on("call:answer", async (data: { callId: string; callerId: string; answer: any }) => {
      console.log(`[CALL] ${userId} answering call ${data.callId} from ${data.callerId}`);
      console.log(`[CALL] Answer SDP type: ${data.answer?.type}, SDP length: ${data.answer?.sdp?.length || 0}`);
      try {
        await storage.updateCall(data.callId, { status: "active", answeredAt: new Date() });

        const callerOnline = isUserOnline(data.callerId);
        const callerSockets = onlineUsers.get(data.callerId);
        console.log(`[CALL] Caller ${data.callerId} online: ${callerOnline}, sockets: ${callerSockets?.size || 0}`);

        io!.to(`user:${data.callerId}`).emit("call:answered", {
          callId: data.callId,
          answer: data.answer,
        });

        console.log(`[CALL] Answer event emitted to user:${data.callerId}`);
      } catch (error) {
        console.error("[CALL] answer error:", error);
      }
    });

    socket.on("call:ice-candidate", (data: { targetUserId: string; candidate: any }) => {
      const targetOnline = isUserOnline(data.targetUserId);
      const targetSockets = onlineUsers.get(data.targetUserId);
      console.log(`[CALL] ICE candidate ${userId} -> ${data.targetUserId} (target online: ${targetOnline}, sockets: ${targetSockets?.size || 0}, candidate: ${data.candidate?.candidate?.substring(0, 50) || 'null'})`);
      io!.to(`user:${data.targetUserId}`).emit("call:ice-candidate", {
        candidate: data.candidate,
        fromUserId: userId,
      });
    });

    socket.on("call:end", async (data: { callId: string; targetUserId: string }) => {
      console.log(`[CALL] ${userId} ending call ${data.callId}`);
      try {
        const pairKey = getCallPairKey(userId, data.targetUserId);
        activeCallPairs.delete(pairKey);
        await storage.updateCall(data.callId, { status: "ended", endedAt: new Date() });
        io!.to(`user:${data.targetUserId}`).emit("call:ended", { callId: data.callId });
      } catch {}
    });

    socket.on("call:ice-restart", (data: { targetUserId: string; offer: any }) => {
      console.log(`[CALL] ICE restart ${userId} -> ${data.targetUserId}`);
      io!.to(`user:${data.targetUserId}`).emit("call:ice-restart", {
        offer: data.offer,
        fromUserId: userId,
      });
    });

    socket.on("call:ice-restart-answer", (data: { targetUserId: string; answer: any }) => {
      console.log(`[CALL] ICE restart answer ${userId} -> ${data.targetUserId}`);
      io!.to(`user:${data.targetUserId}`).emit("call:ice-restart-answer", {
        answer: data.answer,
        fromUserId: userId,
      });
    });

    socket.on("call:reject", async (data: { callId: string; callerId: string }) => {
      console.log(`[CALL] ${userId} rejecting call ${data.callId}`);
      try {
        const pairKey = getCallPairKey(userId, data.callerId);
        activeCallPairs.delete(pairKey);
        await storage.updateCall(data.callId, { status: "missed", endedAt: new Date() });
        io!.to(`user:${data.callerId}`).emit("call:rejected", { callId: data.callId });
      } catch {}
    });

    socket.on("disconnect", (reason) => {
      console.log(`[SOCKET] User ${userId} disconnected (socket: ${socket.id}, reason: ${reason})`);
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
