import { useState, useEffect, useRef, useMemo } from "react";
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
  ExternalLink,
  Navigation,
  StopCircle,
  Loader2,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import { useToast } from "@/hooks/use-toast";
import type { Message } from "@shared/schema";
import { format, formatDistanceToNow } from "date-fns";
import { startLiveTracking, stopLiveTracking } from "@/lib/live-location";

interface LocalMessage extends Message {
  sendFailed?: boolean;
  displayContent?: string;
}

type SystemKind = "system_alert" | "system_safe" | "system_info";

interface LiveLocationMeta {
  kind: "live_location";
  lat: number;
  lng: number;
  accuracy: number | null;
  shareId: string | null;
  expiresAt: string;
  durationMinutes: number;
  stopped?: boolean;
}

function parseMeta(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Backward compatibility: detect old-style "Sharing live location: https://...maps?q=lat,lng"
// messages (sent before the structured meta payload existed) and render them as
// a live location card with no expiry instead of an ugly raw URL.
function extractLegacyLocation(content: string): { lat: number; lng: number } | null {
  const m = content.match(/maps\?q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function buildMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

// Live, ticking countdown of how much time remains in a live-location share.
function useTicker(intervalMs = 15_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

function formatRemaining(expiresAt: Date): { label: string; expired: boolean } {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return { label: "Sharing ended", expired: true };
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return { label: "Less than a minute left", expired: false };
  if (mins < 60) return { label: `${mins} min left`, expired: false };
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return { label: remMins ? `${hrs}h ${remMins}m left` : `${hrs}h left`, expired: false };
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
  const [sharingLocation, setSharingLocation] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentUserId = auth?.user?.id;
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStaleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const lastFetchedRef = useRef<string>("");
  const optimisticCounterRef = useRef(0);

  // Re-render every 15s so countdowns stay fresh
  useTicker(15_000);

  const { data: userProfile } = useQuery<{ id: string; name: string }>({
    queryKey: ["/api/users", otherUserId, "profile"],
    enabled: !!otherUserId,
  });

  const { data: presence } = useQuery<{ online: boolean; lastSeenAt: string | null }>({
    queryKey: ["/api/users", otherUserId, "presence"],
    enabled: !!otherUserId,
    refetchInterval: 30_000,
  });

  const otherUserName = userProfile?.name || "User";
  const otherIsOnline = !!presence?.online;

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

  // Group consecutive identical safety alerts so the chat doesn't become a wall of repeats.
  // From the user's screenshot: 5 stacked "has not completed safety checkin" cards from
  // the SAME source flooded the conversation. We collapse 3+ adjacent same-content alerts
  // into a single card with a "Show N earlier" expander.
  const collapsedMessages = useMemo(() => {
    const groups: Array<{ key: string; type: "single"; msg: LocalMessage } | { key: string; type: "group"; latest: LocalMessage; older: LocalMessage[] }> = [];
    let i = 0;
    while (i < localMessages.length) {
      const m = localMessages[i];
      const isSystem = m.messageType && m.messageType !== "user";
      if (!isSystem) {
        groups.push({ key: m.id, type: "single", msg: m });
        i++;
        continue;
      }
      // Look ahead for consecutive same-type, same-content messages
      let j = i;
      const sameRun: LocalMessage[] = [];
      while (
        j < localMessages.length &&
        localMessages[j].messageType === m.messageType &&
        (localMessages[j].displayContent || localMessages[j].content) ===
          (m.displayContent || m.content)
      ) {
        sameRun.push(localMessages[j]);
        j++;
      }
      if (sameRun.length >= 3) {
        const latest = sameRun[sameRun.length - 1];
        const older = sameRun.slice(0, -1);
        groups.push({ key: `group-${latest.id}`, type: "group", latest, older });
      } else {
        for (const s of sameRun) groups.push({ key: s.id, type: "single", msg: s });
      }
      i = j;
    }
    return groups;
  }, [localMessages]);

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
    } catch {
      toast({ title: "Could not send", description: "Please try again.", variant: "destructive" });
    }
  }

  async function handleShareLocation() {
    if (!otherUserId || sharingLocation) return;
    if (!("geolocation" in navigator)) {
      toast({
        title: "Location unavailable",
        description: "This device cannot share location.",
        variant: "destructive",
      });
      return;
    }
    setSharingLocation(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await apiRequest("POST", `/api/messages/${otherUserId}/share-location`, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? null,
            durationMinutes: 30,
          });
          const saved: any = await res.json().catch(() => ({}));
          const savedMeta = parseMeta(saved?.meta) as LiveLocationMeta | null;
          const isLive = savedMeta?.kind === "live_location" && !savedMeta?.stopped;

          // Kick off real continuous live tracking so the card isn't lying about
          // streaming. The same uploader the dedicated /live-location page uses.
          if (isLive) {
            startLiveTracking({
              onError: (msg) => {
                if (/denied|permission/i.test(msg)) {
                  stopLiveTracking();
                }
              },
              onExpired: () => {
                queryClient.invalidateQueries({ queryKey: ["/api/messages", otherUserId] });
              },
            });
          }

          toast({
            title: isLive ? "Live location shared" : "Location shared",
            description: !isLive
              ? `Sent ${otherUserName} a location snapshot.`
              : otherIsOnline
                ? `${otherUserName} can see your live location for 30 minutes.`
                : `Saved for ${otherUserName}. They'll see it when they're back online.`,
          });
        } catch {
          toast({
            title: "Could not share location",
            description: "Please try again.",
            variant: "destructive",
          });
        } finally {
          setSharingLocation(false);
        }
      },
      () => {
        setSharingLocation(false);
        toast({
          title: "Location permission denied",
          description: "Enable location access to share your position.",
          variant: "destructive",
        });
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function handleStopSharing(_msg: LocalMessage) {
    try {
      // Stop the continuous client uploader first so we don't race with the server.
      await stopLiveTracking();
      await apiRequest("POST", "/api/live-location/stop", {});
      toast({ title: "Stopped sharing", description: "Your live location is no longer visible." });
      queryClient.invalidateQueries({ queryKey: ["/api/messages", otherUserId] });
    } catch {
      toast({ title: "Could not stop sharing", variant: "destructive" });
    }
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
    } catch {
      toast({
        title: "SOS failed",
        description: "Please try again or call directly.",
        variant: "destructive",
      });
    }
  }

  function renderLiveLocationCard(msg: LocalMessage, locMeta: LiveLocationMeta) {
    const isMine = msg.senderId === currentUserId;
    const time = format(new Date(msg.createdAt), "h:mm a");
    const expiresAt = new Date(locMeta.expiresAt);
    const { label: remainingLabel, expired } = formatRemaining(expiresAt);
    const stopped = !!locMeta.stopped || expired;
    const mapsUrl = buildMapsUrl(locMeta.lat, locMeta.lng);

    return (
      <div
        key={msg.id}
        className="my-2 overflow-hidden rounded-2xl border border-primary/30 bg-card shadow-sm"
        data-testid={`live-location-${msg.id}`}
      >
        {/* Gradient header with live indicator */}
        <div className="bg-gradient-to-br from-primary to-primary/70 px-4 py-3 text-primary-foreground">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
                <Navigation className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider">
                    Live Location
                  </span>
                  {!stopped && (
                    <span className="relative flex h-2 w-2" aria-label="Live">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300" />
                    </span>
                  )}
                </div>
                <p className="text-xs font-medium opacity-90 truncate">
                  {stopped ? "Sharing ended" : remainingLabel}
                </p>
              </div>
            </div>
            <span className="text-[10px] opacity-80 shrink-0">{time}</span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground leading-relaxed">
              {isMine ? "You're sharing" : `${otherUserName} is sharing`} live location
              {!stopped && ` for ${locMeta.durationMinutes} minutes`}.
              {locMeta.accuracy ? ` Accurate to about ${Math.round(locMeta.accuracy)}m.` : ""}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={() => window.open(mapsUrl, "_blank", "noopener,noreferrer")}
              className="h-9 text-xs"
              data-testid={`button-loc-open-maps-${msg.id}`}
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Open in Maps
            </Button>
            {isMine && !stopped ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleStopSharing(msg)}
                className="h-9 text-xs"
                data-testid={`button-loc-stop-${msg.id}`}
              >
                <StopCircle className="h-3.5 w-3.5 mr-1.5" />
                Stop sharing
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLocation("/watched")}
                className="h-9 text-xs"
                data-testid={`button-loc-view-live-${msg.id}`}
                disabled={stopped}
              >
                <Navigation className="h-3.5 w-3.5 mr-1.5" />
                {stopped ? "Ended" : "View live"}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderSystemCard(msg: LocalMessage) {
    const kind = msg.messageType as SystemKind;
    const isMine = msg.senderId === currentUserId;
    const meta = parseMeta(msg.meta) as Record<string, any> | null;
    const time = format(new Date(msg.createdAt), "h:mm a");
    const content = msg.displayContent || msg.content;

    // === LIVE LOCATION CARD ===
    // Either via structured meta (new flow) OR backward-compat detection of the
    // old "Sharing live location: https://..." text format.
    if (meta?.kind === "live_location" && typeof meta.lat === "number" && typeof meta.lng === "number") {
      return renderLiveLocationCard(msg, meta as LiveLocationMeta);
    }
    if (kind === "system_info") {
      const legacy = extractLegacyLocation(content);
      if (legacy) {
        const fallbackMeta: LiveLocationMeta = {
          kind: "live_location",
          lat: legacy.lat,
          lng: legacy.lng,
          accuracy: null,
          shareId: null,
          // Old messages had no expiry; treat as already ended so we don't show a fake countdown.
          expiresAt: new Date(0).toISOString(),
          durationMinutes: 0,
          stopped: true,
        };
        return renderLiveLocationCard(msg, fallbackMeta);
      }
    }

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
              <p className="text-sm font-semibold text-foreground leading-snug">{content}</p>
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
              <p className="text-sm font-semibold text-foreground leading-snug">{content}</p>
            </div>
          </div>
        </div>
      );
    }

    // system_info (default)
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
              {content}
            </p>
            {meta?.kind === "missed_checkin" && (
              <p className="text-xs text-muted-foreground mt-1">Reminder sent automatically.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderUserMessage(msg: LocalMessage) {
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
  }

  // Group expander state — track which collapsed groups have been expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  function presenceLabel(): string {
    if (isOtherTyping) return "typing...";
    if (otherIsOnline) return "Active now";
    if (presence?.lastSeenAt) {
      try {
        return `Last seen ${formatDistanceToNow(new Date(presence.lastSeenAt), { addSuffix: true })}`;
      } catch {
        return "Offline";
      }
    }
    return "Offline";
  }

  return (
    <div className="min-h-screen bg-background flex flex-col" data-testid="chat-page">
      {/* Header with presence */}
      <div className="border-b border-border/60 px-4 py-3 flex items-center gap-3 bg-card">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => (window.history.length > 1 ? window.history.back() : setLocation("/"))}
          data-testid="button-back-chat"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="relative shrink-0">
          <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center">
            <UserIcon className="h-4 w-4 text-primary" />
          </div>
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-card ${
              otherIsOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
            }`}
            data-testid="indicator-presence"
            aria-label={otherIsOnline ? "Online" : "Offline"}
          />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold truncate" data-testid="text-chat-user-name">
            {otherUserName}
          </h2>
          <p
            className={`text-xs truncate ${
              isOtherTyping
                ? "text-primary animate-pulse"
                : otherIsOnline
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
            }`}
            data-testid="text-presence-status"
          >
            {presenceLabel()}
          </p>
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

      {/* Messages */}
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

        {collapsedMessages.map((entry) => {
          if (entry.type === "single") {
            const msg = entry.msg;
            if (msg.messageType && msg.messageType !== "user") return renderSystemCard(msg);
            return renderUserMessage(msg);
          }
          // Collapsed group of 3+ identical safety alerts
          const expanded = expandedGroups.has(entry.key);
          return (
            <div key={entry.key} className="space-y-1" data-testid={`group-${entry.key}`}>
              {expanded && entry.older.map((m) => renderSystemCard(m))}
              {renderSystemCard(entry.latest)}
              <button
                type="button"
                onClick={() =>
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(entry.key)) next.delete(entry.key);
                    else next.add(entry.key);
                    return next;
                  })
                }
                className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-1 underline-offset-2 hover:underline"
                data-testid={`button-toggle-group-${entry.key}`}
              >
                {expanded
                  ? "Hide earlier identical alerts"
                  : `Show ${entry.older.length} earlier identical alert${entry.older.length === 1 ? "" : "s"}`}
              </button>
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

      {/* Premium Quick Action Bar */}
      <div className="border-t border-border/60 bg-card px-3 pt-3 pb-2">
        <div className="max-w-lg mx-auto grid grid-cols-3 gap-2">
          {/* Share Location */}
          <button
            type="button"
            onClick={handleShareLocation}
            disabled={sharingLocation}
            className="group relative flex flex-col items-center justify-center gap-1 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 to-primary/5 px-2 py-2.5 transition-all hover:border-primary/40 hover:shadow-sm hover:from-primary/15 hover:to-primary/10 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="button-quick-location"
          >
            <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center group-hover:bg-primary/25 transition-colors">
              {sharingLocation ? (
                <Loader2 className="h-4 w-4 text-primary animate-spin" />
              ) : (
                <MapPin className="h-4 w-4 text-primary" />
              )}
            </div>
            <span className="text-[11px] font-semibold text-foreground leading-tight">
              {sharingLocation ? "Sharing..." : "Share location"}
            </span>
          </button>

          {/* Call */}
          <button
            type="button"
            onClick={() => setLocation(`/call/${otherUserId}`)}
            className="group relative flex flex-col items-center justify-center gap-1 rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 px-2 py-2.5 transition-all hover:border-emerald-500/45 hover:shadow-sm hover:from-emerald-500/15 hover:to-emerald-500/10 active:scale-[0.98]"
            data-testid="button-quick-call"
          >
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center group-hover:bg-emerald-500/30 transition-colors">
              <Phone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <span className="text-[11px] font-semibold text-foreground leading-tight">Call</span>
          </button>

          {/* SOS */}
          {sosConfirm ? (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={handleTriggerSos}
                className="flex-1 flex flex-col items-center justify-center gap-0.5 rounded-xl bg-destructive text-destructive-foreground px-2 py-2.5 font-bold shadow-sm hover:shadow-md active:scale-[0.98] transition-all"
                data-testid="button-quick-sos-confirm"
              >
                <AlertOctagon className="h-4 w-4" />
                <span className="text-[11px] uppercase tracking-wide">Send SOS</span>
              </button>
              <button
                type="button"
                onClick={() => setSosConfirm(false)}
                className="px-3 rounded-xl border border-border bg-card text-muted-foreground hover-elevate"
                data-testid="button-quick-sos-cancel"
                aria-label="Cancel SOS"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSosConfirm(true)}
              className="group relative flex flex-col items-center justify-center gap-1 rounded-xl border border-destructive/30 bg-gradient-to-br from-destructive/10 to-destructive/5 px-2 py-2.5 transition-all hover:border-destructive/50 hover:shadow-sm hover:from-destructive/15 hover:to-destructive/10 active:scale-[0.98]"
              data-testid="button-quick-sos"
            >
              <div className="w-8 h-8 rounded-full bg-destructive/15 flex items-center justify-center group-hover:bg-destructive/25 transition-colors">
                <AlertOctagon className="h-4 w-4 text-destructive" />
              </div>
              <span className="text-[11px] font-semibold text-destructive leading-tight">SOS</span>
            </button>
          )}
        </div>
        {!otherIsOnline && (
          <p
            className="text-[10px] text-muted-foreground text-center mt-2"
            data-testid="text-offline-hint"
          >
            {otherUserName} is offline. Messages and shares will be delivered when they're back.
          </p>
        )}
      </div>

      {/* Composer */}
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
