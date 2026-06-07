import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MessageCircle, Users, AlertTriangle, CheckCircle2, Info, MapPin } from "lucide-react";
import { MobilePageShell } from "@/components/mobile-page-shell";
import { formatDistanceToNow } from "date-fns";
import { getSocket } from "@/lib/socket";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";

type LastMessageType = "user" | "system_alert" | "system_safe" | "system_info";

interface Conversation {
  partnerId: string;
  partnerName: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  lastMessageType: LastMessageType;
  activeAlert?: boolean;
}

function isLiveLocationPreview(raw: string | null | undefined): boolean {
  const text = raw || "";
  return (
    /Sharing live location\b/i.test(text) ||
    /\bis sharing their live location\b/i.test(text) ||
    /\bshared a snapshot of their location\b/i.test(text) ||
    /maps\?q=-?\d+\.?\d*,-?\d+\.?\d*/i.test(text)
  );
}

function StatusDot({ type, isLiveLoc, activeAlert }: { type: LastMessageType; isLiveLoc?: boolean; activeAlert?: boolean }) {
  if (isLiveLoc) {
    return (
      <span
        className="inline-block w-2.5 h-2.5 rounded-full bg-primary ring-2 ring-primary/20"
        aria-label="Live location share"
        data-testid="dot-location"
      />
    );
  }
  if (activeAlert) {
    return (
      <span
        className="inline-block w-2.5 h-2.5 rounded-full bg-destructive ring-2 ring-destructive/20 animate-pulse"
        aria-label="Emergency alert"
        data-testid="dot-alert"
      />
    );
  }
  if (type === "system_alert") {
    return (
      <span
        className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-amber-500/20"
        aria-label="Previous safety alert"
        data-testid="dot-past-alert"
      />
    );
  }
  if (type === "system_info") {
    return (
      <span
        className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-amber-500/20"
        aria-label="Missed check in"
        data-testid="dot-info"
      />
    );
  }
  if (type === "system_safe") {
    return (
      <span
        className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20"
        aria-label="Safe"
        data-testid="dot-safe"
      />
    );
  }
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full bg-muted-foreground/40"
      aria-label="No safety event"
      data-testid="dot-normal"
    />
  );
}

function statusLabel(type: LastMessageType, activeAlert?: boolean): string | null {
  switch (type) {
    case "system_alert":
      return activeAlert ? "Emergency" : "Past alert";
    case "system_info":
      return "Safety event";
    case "system_safe":
      return "Marked safe";
    default:
      return null;
  }
}

export default function InboxPage() {
  const [, setLocation] = useLocation();
  const { auth } = useAuth();
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());

  const { data: conversations, isLoading } = useQuery<Conversation[]>({
    queryKey: ["/api/conversations"],
  });

  const totalUnread = conversations?.reduce((sum, c) => sum + c.unreadCount, 0) || 0;
  const activeAlerts = conversations?.filter((c) => c.activeAlert).length || 0;

  useEffect(() => {
    if (!auth?.authenticated) return;
    const socket = getSocket();

    const handleNewMessage = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/messages/unread/count"] });
    };

    const handleMessageSent = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    };

    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const handleTypingStart = (data: { userId: string }) => {
      setTypingUsers((prev) => new Set(prev).add(data.userId));
      if (typingTimers.has(data.userId)) clearTimeout(typingTimers.get(data.userId)!);
      typingTimers.set(
        data.userId,
        setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Set(prev);
            next.delete(data.userId);
            return next;
          });
          typingTimers.delete(data.userId);
        }, 5000),
      );
    };

    const handleTypingStop = (data: { userId: string }) => {
      if (typingTimers.has(data.userId)) {
        clearTimeout(typingTimers.get(data.userId)!);
        typingTimers.delete(data.userId);
      }
      setTypingUsers((prev) => {
        const next = new Set(prev);
        next.delete(data.userId);
        return next;
      });
    };

    socket.on("message:new", handleNewMessage);
    socket.on("message:sent", handleMessageSent);
    socket.on("typing:start", handleTypingStart);
    socket.on("typing:stop", handleTypingStop);
    return () => {
      socket.off("message:new", handleNewMessage);
      socket.off("message:sent", handleMessageSent);
      socket.off("typing:start", handleTypingStart);
      socket.off("typing:stop", handleTypingStop);
      typingTimers.forEach((t) => clearTimeout(t));
      typingTimers.clear();
    };
  }, [auth?.authenticated]);

  const subtitle = activeAlerts > 0
    ? `${activeAlerts} active alert${activeAlerts !== 1 ? "s" : ""}`
    : totalUnread > 0
      ? `${totalUnread} new message${totalUnread !== 1 ? "s" : ""}`
      : "Safety alerts and messages from your circle";

  return (
    <MobilePageShell
      title={<span className="inline-flex items-center gap-2"><MessageCircle className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />Messages</span>}
      subtitle={<span className={activeAlerts > 0 ? "text-destructive font-medium" : totalUnread > 0 ? "text-primary" : undefined}>{subtitle}</span>}
    >

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && (!conversations || conversations.length === 0) && (
          <Card className="border-border/60">
            <CardContent className="py-12 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Users className="w-7 h-7 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-2" data-testid="text-empty-state">
                No messages yet
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed max-w-xs mx-auto">
                Messages and safety alerts from your contacts will appear here.
              </p>
            </CardContent>
          </Card>
        )}

        {conversations && conversations.length > 0 && (
          <div className="space-y-2">
            {conversations.map((convo) => {
              const isTyping = typingUsers.has(convo.partnerId);
              const isLiveLoc = isLiveLocationPreview(convo.lastMessage);
              // A live-location share is informational, not a safety alert,
              // even though the underlying messageType is system_info. We
              // re-classify it locally so the row doesn't masquerade as an
              // emergency badge.
              const isAlert = !isLiveLoc && !!convo.activeAlert;
              const label = isLiveLoc ? "Location" : statusLabel(convo.lastMessageType, convo.activeAlert);
              return (
                <Card
                  key={convo.partnerId}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open conversation with ${convo.partnerName}${
                    isAlert ? ", emergency alert" : convo.unreadCount > 0 ? `, ${convo.unreadCount} unread` : ""
                  }`}
                  className={`cursor-pointer transition-colors hover-elevate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    isAlert
                      ? "border-destructive/40 bg-destructive/5"
                      : convo.unreadCount > 0
                        ? "border-primary/30 bg-primary/5"
                        : "border-border/60"
                  }`}
                  onClick={() => setLocation(`/chat/${convo.partnerId}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setLocation(`/chat/${convo.partnerId}`);
                    }
                  }}
                  data-testid={`conversation-${convo.partnerId}`}
                >
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div className="relative shrink-0">
                        <div
                          className={`w-11 h-11 rounded-full flex items-center justify-center font-semibold text-sm ${
                            isAlert
                              ? "bg-destructive/15 text-destructive"
                              : convo.unreadCount > 0
                                ? "bg-primary/15 text-primary"
                                : "bg-muted text-muted-foreground"
                          }`}
                          aria-hidden="true"
                        >
                          {convo.partnerName.charAt(0).toUpperCase()}
                        </div>
                        <span className="absolute -bottom-0.5 -right-0.5 bg-card rounded-full p-0.5">
                          <StatusDot type={convo.lastMessageType} isLiveLoc={isLiveLoc} activeAlert={convo.activeAlert} />
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`text-sm truncate ${
                              isAlert || convo.unreadCount > 0 ? "font-semibold" : "font-medium"
                            }`}
                            data-testid={`text-partner-name-${convo.partnerId}`}
                          >
                            {convo.partnerName}
                          </span>
                          <span
                            className="text-xs text-muted-foreground shrink-0"
                            data-testid={`text-time-${convo.partnerId}`}
                          >
                            {formatDistanceToNow(new Date(convo.lastMessageAt), { addSuffix: true })}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-0.5 gap-2">
                          {isTyping ? (
                            <p
                              className="text-sm text-primary animate-pulse"
                              data-testid={`text-typing-${convo.partnerId}`}
                            >
                              typing...
                            </p>
                          ) : (
                            <p
                              className={`text-sm truncate ${
                                isAlert
                                  ? "text-destructive font-medium"
                                  : convo.unreadCount > 0
                                    ? "text-foreground"
                                    : "text-muted-foreground"
                              }`}
                              data-testid={`text-preview-${convo.partnerId}`}
                            >
                              {label && (
                                <span
                                  className={`inline-flex items-center gap-1 mr-1.5 text-[10px] font-bold uppercase tracking-wider ${
                                    isAlert
                                      ? "text-destructive"
                                      : isLiveLoc
                                        ? "text-primary"
                                        : convo.lastMessageType === "system_safe"
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : "text-amber-600 dark:text-amber-400"
                                  }`}
                                >
                                  {isLiveLoc ? (
                                    <MapPin className="w-3 h-3" />
                                  ) : (
                                    <>
                                      {convo.lastMessageType === "system_alert" && <AlertTriangle className="w-3 h-3" />}
                                      {convo.lastMessageType === "system_safe" && <CheckCircle2 className="w-3 h-3" />}
                                      {convo.lastMessageType === "system_info" && <Info className="w-3 h-3" />}
                                    </>
                                  )}
                                  {label}
                                </span>
                              )}
                              {(() => {
                                const raw = convo.lastMessage || "";
                                const display = isLiveLoc ? "Live location shared" : raw;
                                return display.length > 60
                                  ? display.substring(0, 60) + "..."
                                  : display;
                              })()}
                            </p>
                          )}
                          {convo.unreadCount > 0 && (
                            <Badge
                              className={`shrink-0 text-xs min-w-[20px] h-5 flex items-center justify-center rounded-full ${
                                isAlert
                                  ? "bg-destructive text-destructive-foreground"
                                  : "bg-primary text-primary-foreground"
                              }`}
                              data-testid={`badge-unread-${convo.partnerId}`}
                            >
                              {convo.unreadCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
    </MobilePageShell>
  );
}
