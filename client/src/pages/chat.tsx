import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Send,
  Phone,
  CheckCheck,
  Check,
  RotateCcw,
  User as UserIcon,
  AlertTriangle,
  CheckCircle2,
  Info,
  MapPin,
  AlertOctagon,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import { useToast } from "@/hooks/use-toast";
import type { Message } from "@shared/schema";
import { format } from "date-fns";

interface LocalMessage extends Message {
  sendFailed?: boolean;
  displayContent?: string;
}

type SystemKind = "system_alert" | "system_safe" | "system_info";

function parseMeta(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function ChatPage() {
  const { userId: otherUserId } = useParams<{ userId: string }>();
  const [, setLocation] = useLocation();
  const { auth } = useAuth();
  const { toast } = useToast();
  const [newMessage, setNewMessage] = useState("");
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  const [sosConfirm, setSosConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentUserId = auth?.user?.id;
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStaleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const lastFetchedRef = useRef<string>("");
  const optimisticCounterRef = useRef(0);

  const { data: userProfile } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/users", otherUserId, "profile"],
    enabled: !!otherUserId,
  });

  const otherUserName = userProfile?.name || "User";

  const { data: serverMessages = [], isLoading } = useQuery<Message[]>({
    queryKey: ["/api/messages", otherUserId],
    enabled: !!otherUserId,
  });

  useEffect(() => {
    const key = JSON.stringify(serverMessages.map((m) => m.id));
    if (key === lastFetchedRef.current) return;
    lastFetchedRef.current = key;

    setLocalMessages((prev) => {
      const optimistic = prev.filter((m) => m.id.startsWith("optimistic-"));
      const server: LocalMessage[] = serverMessages.map((m) => ({
        ...m,
        displayContent: m.content,
      }));
      return [...server, ...optimistic];
    });
  }, [serverMessages]);

  useEffect(() => {
    if (!otherUserId || !currentUserId) return;
    const socket = getSocket();

    const handleNewMessage = (msg: any) => {
      if (msg.senderId === otherUserId || msg.receiverId === otherUserId) {
        setLocalMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, { ...msg, displayContent: msg.content }];
        });
        if (msg.senderId === otherUserId) {
          setIsOtherTyping(false);
          socket.emit("message:read", { senderId: otherUserId });
          queryClient.invalidateQueries({ queryKey: ["/api/messages/unread/count"] });
        }
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      }
    };

    const handleMessageSent = (msg: any) => {
      if (msg.receiverId === otherUserId || msg.senderId === otherUserId) {
        setLocalMessages((prev) => {
          const oldest = prev.find((m) => m.id.startsWith("optimistic-"));
          const plainContent = oldest?.displayContent || msg.content;
          const updated = oldest ? prev.filter((m) => m !== oldest) : prev;
          if (updated.some((m) => m.id === msg.id)) return updated;
          return [...updated, { ...msg, displayContent: plainContent }];
        });
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      }
    };

    const handleTypingStart = (data: { userId: string }) => {
      if (data.userId === otherUserId) {
        setIsOtherTyping(true);
        if (typingStaleRef.current) clearTimeout(typingStaleRef.current);
        typingStaleRef.current = setTimeout(() => setIsOtherTyping(false), 5000);
      }
    };

    const handleTypingStop = (data: { userId: string }) => {
      if (data.userId === otherUserId) {
        setIsOtherTyping(false);
        if (typingStaleRef.current) {
          clearTimeout(typingStaleRef.current);
          typingStaleRef.current = null;
        }
      }
    };

    const handleReadReceipt = (data: { readBy: string }) => {
      if (data.readBy === otherUserId) {
        setLocalMessages((prev) =>
          prev.map((m) => (m.senderId === currentUserId ? { ...m, read: true } : m)),
        );
      }
    };

    socket.on("message:new", handleNewMessage);
    socket.on("message:sent", handleMessageSent);
    socket.on("typing:start", handleTypingStart);
    socket.on("typing:stop", handleTypingStop);
    socket.on("message:read-receipt", handleReadReceipt);

    socket.emit("message:read", { senderId: otherUserId });
    apiRequest("POST", `/api/messages/${otherUserId}/read`, {})
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/messages/unread/count"] });
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      })
      .catch(() => {});

    return () => {
      socket.off("message:new", handleNewMessage);
      socket.off("message:sent", handleMessageSent);
      socket.off("typing:start", handleTypingStart);
      socket.off("typing:stop", handleTypingStop);
      socket.off("message:read-receipt", handleReadReceipt);
      if (isTypingRef.current) {
        socket.emit("typing:stop", { receiverId: otherUserId });
      }
      if (typingStaleRef.current) clearTimeout(typingStaleRef.current);
    };
  }, [otherUserId, currentUserId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localMessages, isOtherTyping]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setNewMessage(e.target.value);
    if (!otherUserId) return;
    const socket = getSocket();

    if (!isTypingRef.current && e.target.value.trim()) {
      isTypingRef.current = true;
      socket.emit("typing:start", { receiverId: otherUserId });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (isTypingRef.current) {
        isTypingRef.current = false;
        socket.emit("typing:stop", { receiverId: otherUserId });
      }
    }, 2000);

    if (!e.target.value.trim() && isTypingRef.current) {
      isTypingRef.current = false;
      socket.emit("typing:stop", { receiverId: otherUserId });
    }
  }

  async function handleSend(retryText?: string) {
    const text = retryText || newMessage.trim();
    if (!text || !otherUserId) return;

    if (!retryText) setNewMessage("");
    if (isTypingRef.current) {
      isTypingRef.current = false;
      getSocket().emit("typing:stop", { receiverId: otherUserId });
    }

    const optimisticId = `optimistic-${++optimisticCounterRef.current}`;
    const optimisticMsg: LocalMessage = {
      id: optimisticId,
      senderId: currentUserId!,
      receiverId: otherUserId,
      content: text,
      read: false,
      encrypted: false,
      iv: null,
      messageType: "user",
      meta: null,
      createdAt: new Date(),
      displayContent: text,
    };
    setLocalMessages((prev) =>
      prev.filter((m) => !(m.sendFailed && m.displayContent === text)).concat([optimisticMsg]),
    );

    const socket = getSocket();
    socket.emit("message:send", { receiverId: otherUserId, content: text }, (response: any) => {
      if (!response?.success) {
        setLocalMessages((prev) =>
          prev.map((m) => (m.id === optimisticId ? { ...m, sendFailed: true } : m)),
        );
      }
    });

    setTimeout(() => {
      setLocalMessages((prev) => {
        const msg = prev.find((m) => m.id === optimisticId);
        if (msg && !msg.sendFailed) {
          return prev.map((m) => (m.id === optimisticId ? { ...m, sendFailed: true } : m));
        }
        return prev;
      });
    }, 10000);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function postSystemMessage(type: "system_safe" | "system_info", content: string) {
    if (!otherUserId) return;
    try {
      await apiRequest("POST", `/api/messages/${otherUserId}/system`, { type, content });
    } catch (err: any) {
      toast({ title: "Could not send", description: "Please try again.", variant: "destructive" });
    }
  }

  async function handleShareLocation() {
    if (!otherUserId) return;
    if (!("geolocation" in navigator)) {
      await postSystemMessage("system_info", `${auth?.user?.name || "I"} shared their location.`);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude.toFixed(5);
        const lng = pos.coords.longitude.toFixed(5);
        await postSystemMessage(
          "system_info",
          `Sharing live location: https://www.google.com/maps?q=${lat},${lng}`,
        );
      },
      async () => {
        await postSystemMessage("system_info", `Could not get a precise location. Please call instead.`);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function handleMarkSafe() {
    if (!otherUserId) return;
    await postSystemMessage("system_safe", `${auth?.user?.name || "User"} confirmed they are safe.`);
    toast({ title: "Marked safe", description: "Your circle has been notified." });
  }

  async function handleTriggerSos() {
    try {
      const res = await apiRequest("POST", "/api/messages/sos", {});
      const data = await res.json();
      toast({
        title: "SOS sent",
        description: `${data.sentCount} circle member${data.sentCount === 1 ? "" : "s"} notified.`,
      });
      setSosConfirm(false);
    } catch (err: any) {
      toast({ title: "SOS failed", description: "Please try again or call directly.", variant: "destructive" });
    }
  }

  function renderSystemCard(msg: LocalMessage) {
    const kind = msg.messageType as SystemKind;
    const isMine = msg.senderId === currentUserId;
    const meta = parseMeta(msg.meta);
    const time = format(new Date(msg.createdAt), "h:mm a");

    if (kind === "system_alert") {
      return (
        <div
          key={msg.id}
          className="my-2 rounded-2xl border-2 border-destructive/30 bg-destructive/5 p-4"
          data-testid={`system-alert-${msg.id}`}
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-destructive/15 flex items-center justify-center shrink-0">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-destructive">
                  Emergency Alert
                </span>
                <span className="text-[10px] text-muted-foreground">{time}</span>
              </div>
              <p className="text-sm font-semibold text-foreground leading-snug">{msg.displayContent || msg.content}</p>
              <p className="text-xs text-muted-foreground mt-1">No response after check in attempts.</p>
              {!isMine && (
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => setLocation(`/call/${otherUserId}`)}
                    className="h-9 text-xs"
                    data-testid={`button-alert-call-${msg.id}`}
                  >
                    <Phone className="h-3.5 w-3.5 mr-1" />
                    Call
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setLocation("/watched")}
                    className="h-9 text-xs"
                    data-testid={`button-alert-location-${msg.id}`}
                  >
                    <MapPin className="h-3.5 w-3.5 mr-1" />
                    Location
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleMarkSafe}
                    className="h-9 text-xs"
                    data-testid={`button-alert-safe-${msg.id}`}
                  >
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Mark safe
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (kind === "system_safe") {
      return (
        <div
          key={msg.id}
          className="my-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4"
          data-testid={`system-safe-${msg.id}`}
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  Safe
                </span>
                <span className="text-[10px] text-muted-foreground">{time}</span>
              </div>
              <p className="text-sm font-semibold text-foreground leading-snug">{msg.displayContent || msg.content}</p>
            </div>
          </div>
        </div>
      );
    }

    // system_info
    return (
      <div
        key={msg.id}
        className="my-2 rounded-2xl border border-border bg-muted/40 p-4"
        data-testid={`system-info-${msg.id}`}
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
            <Info className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Safety Update
              </span>
              <span className="text-[10px] text-muted-foreground">{time}</span>
            </div>
            <p className="text-sm font-medium text-foreground leading-snug whitespace-pre-wrap break-words">
              {msg.displayContent || msg.content}
            </p>
            {meta?.kind === "missed_checkin" && (
              <p className="text-xs text-muted-foreground mt-1">Reminder sent automatically.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col" data-testid="chat-page">
      <div className="border-b border-border/60 px-4 py-3 flex items-center gap-3 bg-card">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => (window.history.length > 1 ? window.history.back() : setLocation("/"))}
          data-testid="button-back-chat"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
          <UserIcon className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold truncate" data-testid="text-chat-user-name">
            {otherUserName}
          </h2>
          {isOtherTyping && (
            <p className="text-xs text-primary animate-pulse" data-testid="text-typing-indicator">
              typing...
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation(`/call/${otherUserId}`)}
          data-testid="button-call"
          aria-label="Call"
        >
          <Phone className="w-5 h-5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 max-w-lg mx-auto w-full">
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && localMessages.length === 0 && (
          <div className="text-center text-muted-foreground py-12 text-sm">
            <p data-testid="text-no-messages">No messages yet. Send a check in or say hello.</p>
          </div>
        )}

        {localMessages.map((msg) => {
          if (msg.messageType && msg.messageType !== "user") {
            return renderSystemCard(msg);
          }

          const isMine = msg.senderId === currentUserId;
          const isOptimistic = msg.id.startsWith("optimistic-");
          const content = msg.displayContent || msg.content;
          return (
            <div
              key={msg.id}
              className={`flex ${isMine ? "justify-end" : "justify-start"}`}
              data-testid={`message-${msg.id}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                  isMine
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted rounded-bl-sm"
                } ${isOptimistic && !msg.sendFailed ? "opacity-70" : ""} ${msg.sendFailed ? "opacity-50" : ""}`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{content}</p>
                <div className={`flex items-center gap-1 mt-1 ${isMine ? "justify-end" : ""}`}>
                  {msg.sendFailed ? (
                    <button
                      onClick={() => {
                        setLocalMessages((prev) => prev.filter((m) => m.id !== msg.id));
                        handleSend(content);
                      }}
                      className={`flex items-center gap-1 text-[10px] underline-offset-2 hover:underline ${
                        isMine ? "text-primary-foreground/90" : "text-destructive"
                      }`}
                      data-testid={`button-retry-${msg.id}`}
                    >
                      <RotateCcw className="w-3 h-3" /> Tap to retry
                    </button>
                  ) : (
                    <>
                      <span
                        className={`text-[10px] ${
                          isMine ? "text-primary-foreground/70" : "text-muted-foreground"
                        }`}
                      >
                        {isOptimistic ? "Sending..." : format(new Date(msg.createdAt), "h:mm a")}
                      </span>
                      {isMine &&
                        !isOptimistic &&
                        (msg.read ? (
                          <CheckCheck className="w-3 h-3 text-primary-foreground/70" />
                        ) : (
                          <Check className="w-3 h-3 text-primary-foreground/70" />
                        ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {isOtherTyping && (
          <div className="flex justify-start" data-testid="typing-bubble">
            <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Action Bar */}
      <div className="border-t border-border/60 bg-card px-4 pt-3 pb-1">
        <div className="max-w-lg mx-auto grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleShareLocation}
            className="h-10 text-xs font-medium"
            data-testid="button-quick-location"
          >
            <MapPin className="h-4 w-4 mr-1.5" />
            Share location
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLocation(`/call/${otherUserId}`)}
            className="h-10 text-xs font-medium"
            data-testid="button-quick-call"
          >
            <Phone className="h-4 w-4 mr-1.5" />
            Call
          </Button>
          {sosConfirm ? (
            <div className="flex gap-1">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleTriggerSos}
                className="h-10 text-xs font-bold flex-1"
                data-testid="button-quick-sos-confirm"
              >
                Send SOS
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSosConfirm(false)}
                className="h-10 text-xs px-2"
                data-testid="button-quick-sos-cancel"
                aria-label="Cancel SOS"
              >
                ✕
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSosConfirm(true)}
              className="h-10 text-xs font-semibold border-destructive/40 text-destructive hover:bg-destructive/5"
              data-testid="button-quick-sos"
            >
              <AlertOctagon className="h-4 w-4 mr-1.5" />
              SOS
            </Button>
          )}
        </div>
      </div>

      <div className="border-t border-border/60 px-4 py-3 bg-card">
        <div className="max-w-lg mx-auto flex gap-2">
          <Input
            ref={inputRef}
            value={newMessage}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="flex-1 rounded-full"
            data-testid="input-message"
          />
          <Button
            onClick={() => handleSend()}
            disabled={!newMessage.trim()}
            size="icon"
            className="rounded-full"
            data-testid="button-send-message"
            aria-label="Send message"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
