import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { MessageCircle } from "lucide-react";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/lib/auth";

interface NotificationItem {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  type: "message";
  timestamp: number;
}

const BANNER_DURATION = 4000;
const MAX_PREVIEW_LENGTH = 80;

export function NotificationBanner() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [location, setLocation] = useLocation();
  const { auth } = useAuth();

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  useEffect(() => {
    if (!auth?.authenticated) return;

    const socket = getSocket();
    const currentUserId = auth?.user?.id;

    const handleNewMessage = (msg: any) => {
      if (!msg.senderId || !msg.content || msg.type === "emergency-alert") return;
      if (msg.senderId === currentUserId) return;
      if (location.startsWith(`/chat/${msg.senderId}`)) return;

      const id = msg.id || `msg-${Date.now()}`;
      const senderName = msg.senderName || "Someone";
      const content = msg.content;

      const notification: NotificationItem = {
        id,
        senderId: msg.senderId,
        senderName,
        content: content.length > MAX_PREVIEW_LENGTH
          ? content.substring(0, MAX_PREVIEW_LENGTH) + "..."
          : content,
        type: "message",
        timestamp: Date.now(),
      };

      setNotifications((prev) => {
        const filtered = prev.filter((n) => n.senderId !== msg.senderId);
        return [notification, ...filtered].slice(0, 3);
      });

      setTimeout(() => dismiss(id), BANNER_DURATION);
    };

    socket.on("message:new", handleNewMessage);

    return () => {
      socket.off("message:new", handleNewMessage);
    };
  }, [auth?.authenticated, auth?.user?.id, location, dismiss]);

  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-40 flex flex-col items-center pointer-events-none px-3 pt-3 gap-2" data-testid="notification-banner-container">
      {notifications.map((n) => (
        <div
          key={n.id}
          className="w-full max-w-md bg-card border border-border rounded-2xl shadow-lg px-4 py-3 pointer-events-auto cursor-pointer animate-in slide-in-from-top-2 fade-in duration-300"
          onClick={() => {
            dismiss(n.id);
            setLocation(`/chat/${n.senderId}`);
          }}
          data-testid={`notification-banner-${n.senderId}`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <MessageCircle className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate" data-testid={`notification-sender-${n.senderId}`}>
                {n.senderName}
              </p>
              <p className="text-sm text-muted-foreground truncate" data-testid={`notification-content-${n.senderId}`}>
                {n.content}
              </p>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">now</span>
          </div>
        </div>
      ))}
    </div>
  );
}
