import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
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
  ExternalLink,
  Navigation,
  StopCircle,
  Loader2,
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import { useToast } from "@/hooks/use-toast";
import type { Message } from "@shared/schema";
import { format, formatDistanceToNow } from "date-fns";
import { startLiveTracking, stopLiveTracking } from "@/lib/live-location";
import { BACKGROUND_LOCATION_UNLICENSED_MESSAGE } from "@/lib/location-service";
import { useBackgroundLocationEscalation } from "@/components/background-location-provider";

interface LocalMessage extends Message {
  sendFailed?: boolean;
  displayContent?: string;
}

type SystemKind = "system_alert" | "system_safe" | "system_info";

interface ConversationSummary {
  partnerId: string;
  activeAlert?: boolean;
}

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

function messageTimeValue(message: Pick<LocalMessage, "createdAt">): number {
  const value = new Date(message.createdAt).getTime();
  return Number.isFinite(value) ? value : Date.now();
}

export default function ChatPage() {
  const { userId: otherUserId } = useParams<{ userId: string }>();
  const [, setLocation] = useLocation();
  const { auth } = useAuth();
  const { toast } = useToast();
  const escalation = useBackgroundLocationEscalation();
  const [newMessage, setNewMessage] = useState("");
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
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

  const { data: conversations = [] } = useQuery<ConversationSummary[]>({
    queryKey: ["/api/conversations"],
    enabled: !!otherUserId,
  });
  const currentConversation = conversations.find((c) => c.partnerId === otherUserId);
  const showEmergencyContactingFooter = !otherIsOnline && currentConversation?.activeAlert === true;

  // Tracks whether the current user has ANY active live-location share, regardless
  // of which conversation it was started from. This drives the "You're sharing
  // your live location" banner so users can always stop sharing, even on cards
  // that have rolled into the "ended" state on the client.
  const { data: liveStatus } = useQuery<{ active: boolean; share: any }>({
    queryKey: ["/api/live-location/status"],
    enabled: !!currentUserId,
    refetchInterval: 30_000,
  });
  const isCurrentlySharing = !!liveStatus?.active;

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
      const merged = new Map<string, LocalMessage>();
      for (const msg of server) merged.set(msg.id, msg);
      for (const msg of prev) {
        if (msg.id.startsWith("optimistic-")) continue;
        if (!merged.has(msg.id)) merged.set(msg.id, msg);
      }
      for (const msg of optimistic) merged.set(msg.id, msg);
      return Array.from(merged.values()).sort((a, b) => messageTimeValue(a) - messageTimeValue(b));
    });
  }, [serverMessages]);

  useEffect(() => {
    if (!otherUserId || !currentUserId) return;
    const socket = getSocket();

    const handleNewMessage = (msg: any) => {
      if (msg.senderId === otherUserId || msg.receiverId === otherUserId) {
        setLocalMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, { ...msg, displayContent: msg.content }]
            .sort((a, b) => messageTimeValue(a) - messageTimeValue(b));
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
          return [...updated, { ...msg, displayContent: plainContent }]
            .sort((a, b) => messageTimeValue(a) - messageTimeValue(b));
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
      if (response?.success && response.message) {
        const saved = response.message;
        setLocalMessages((prev) => {
          const updated = prev.filter((m) => m.id !== optimisticId && m.id !== saved.id);
          return [...updated, { ...saved, displayContent: text }]
            .sort((a, b) => messageTimeValue(a) - messageTimeValue(b));
        });
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
        return;
      }

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
          const outcome = await escalation.requestAlwaysForFeature("share_precise");
          if (!outcome.granted) {
            escalation.setActiveWarning({
              feature: "share_precise",
              message: outcome.unlicensed
                ? BACKGROUND_LOCATION_UNLICENSED_MESSAGE
                : "Live location works while the app is open. Enable Always Location for background sharing.",
            });
          } else {
            escalation.setActiveWarning(null);
          }
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

  async function handleStopSharing(_msg?: LocalMessage) {
    try {
      // Stop the continuous client uploader first so we don't race with the server.
      await stopLiveTracking();
      escalation.setActiveWarning(null);
      await apiRequest("POST", "/api/live-location/stop", {});
      toast({ title: "Stopped sharing", description: "Your live location is no longer visible." });
      queryClient.invalidateQueries({ queryKey: ["/api/messages", otherUserId] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    } catch {
      toast({ title: "Could not stop sharing", variant: "destructive" });
    }
  }

  async function handleMarkSafe() {
    if (!otherUserId) return;
    await postSystemMessage("system_safe", `${auth?.user?.name || "User"} confirmed they are safe.`);
    toast({ title: "Marked safe", description: "We let your circle know." });
  }

  function renderLiveLocationCard(msg: LocalMessage, locMeta: LiveLocationMeta) {
    const isMine = msg.senderId === currentUserId;
    const time = format(new Date(msg.createdAt), "h:mm a");
    const expiresAt = new Date(locMeta.expiresAt);
    const { label: remainingLabel, expired } = formatRemaining(expiresAt);
    const stopped = !!locMeta.stopped || expired;
    const hasCoords =
      typeof locMeta.lat === "number" &&
      typeof locMeta.lng === "number" &&
      locMeta.lat >= -90 && locMeta.lat <= 90 &&
      locMeta.lng >= -180 && locMeta.lng <= 180;
    const directionsUrl = hasCoords
      ? `https://www.google.com/maps/dir/?api=1&destination=${locMeta.lat.toFixed(6)},${locMeta.lng.toFixed(6)}`
      : "";
    const mapImgUrl = hasCoords
      ? `/api/maps/static-map?lat=${locMeta.lat.toFixed(6)}&lng=${locMeta.lng.toFixed(6)}&w=640&h=220&zoom=15`
      : "";
    // The dedicated in-app live map view. For the sender, /live-location is their
    // own broadcast view; for the recipient, /live-location/:senderId is the watcher view.
    const inAppLiveUrl = isMine ? "/live-location" : `/live-location/${msg.senderId}`;
    const openLiveMap = () => setLocation(inAppLiveUrl);

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
                  <span className="text-[11px] font-semibold tracking-wide">Live location</span>
                  {!stopped && (
                    <span className="relative flex h-2 w-2" aria-label="Live">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300" />
                    </span>
                  )}
                </div>
                <p className="text-xs font-medium opacity-90 truncate" data-testid={`text-loc-status-${msg.id}`}>
                  {stopped ? "Sharing ended" : `Location sharing is active · ${remainingLabel}`}
                </p>
              </div>
            </div>
            <span className="text-[10px] opacity-80 shrink-0">{time}</span>
          </div>
        </div>

        {/* Mini map preview (clicking opens the in-app Live Map) */}
        {hasCoords ? (
          <button
            type="button"
            onClick={openLiveMap}
            className="block w-full text-left group"
            aria-label="Open live map"
            data-testid={`button-loc-mini-map-${msg.id}`}
          >
            <div className="relative w-full h-[110px] bg-muted overflow-hidden">
              <img
                src={mapImgUrl}
                alt="Map preview of last shared location"
                loading="lazy"
                className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
                onError={(e) => {
                  // If Google Static Maps fails (quota, no key, etc), hide the image
                  // so the card still looks clean rather than showing a broken-image icon.
                  (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                }}
              />
              {stopped && (
                <div className="absolute inset-0 bg-background/40 backdrop-blur-[1px] flex items-center justify-center">
                  <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-card/90 text-muted-foreground border border-border/60">
                    Ended
                  </span>
                </div>
              )}
            </div>
          </button>
        ) : (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground" data-testid={`text-loc-no-location-${msg.id}`}>
            No location available
          </div>
        )}

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          {hasCoords && (
            <div className="flex items-start gap-2">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="text-[11px] text-muted-foreground leading-relaxed">
                Last shared location
                {locMeta.accuracy ? ` · accurate to about ${Math.round(locMeta.accuracy)}m` : ""}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={openLiveMap}
              disabled={!hasCoords}
              className="h-9 text-xs"
              data-testid={`button-loc-open-live-${msg.id}`}
            >
              <Navigation className="h-3.5 w-3.5 mr-1.5" />
              Open Live Map
            </Button>
            {hasCoords ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open(directionsUrl, "_blank", "noopener,noreferrer")}
                className="h-9 text-xs"
                data-testid={`button-loc-directions-${msg.id}`}
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Get directions
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled className="h-9 text-xs">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Get directions
              </Button>
            )}
          </div>

          {isMine && !stopped && hasCoords && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleStopSharing(msg)}
              className="h-8 w-full text-[11px] text-muted-foreground hover:text-destructive"
              data-testid={`button-loc-stop-${msg.id}`}
            >
              <StopCircle className="h-3.5 w-3.5 mr-1.5" />
              Stop sharing
            </Button>
          )}
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
    // old "Sharing live location: https://..." text format. We render the card
    // even when lat/lng are missing  -  the card itself shows "No location
    // available" and disables the actions in that case.
    if (meta?.kind === "live_location") {
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

  // Group expander state  -  track which collapsed groups have been expanded
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
    <div className="h-[100dvh] min-h-screen bg-background flex flex-col overflow-hidden" data-testid="chat-page">
      {/* Header with presence */}
      <div className="sticky top-0 z-30 shrink-0 border-b border-border/60 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 flex items-center gap-3 bg-card">
        <BackButton
          onClick={() => (window.history.length > 1 ? window.history.back() : setLocation("/"))}
          testId="button-back-chat"
        />
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
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-1 max-w-lg mx-auto w-full">
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

      {/* Active-share banner  -  always visible while a live-location session is
          actually running on the server, so users can stop sharing even when no
          card in this thread is in the "active" state. */}
      {isCurrentlySharing && (
        <div
          className="shrink-0 border-t border-primary/30 bg-primary/5 px-3 py-2 flex items-center gap-2"
          data-testid="banner-sharing-active"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <p className="text-xs text-foreground flex-1 truncate">
            You're sharing your live location
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleStopSharing()}
            className="h-7 text-[11px] px-2.5 border-destructive/40 text-destructive hover:bg-destructive/10"
            data-testid="button-banner-stop-sharing"
          >
            <StopCircle className="h-3.5 w-3.5 mr-1" />
            Stop sharing
          </Button>
        </div>
      )}

      {/* Compact Quick Action Bar  -  pill-style icon+label, smaller and sharper */}
      <div className="shrink-0 border-t border-border/60 bg-card px-3 pt-2 pb-1.5">
        <div className="max-w-lg mx-auto flex items-center justify-center gap-2">
          {/* Location */}
          <button
            type="button"
            onClick={handleShareLocation}
            disabled={sharingLocation}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-primary/25 bg-primary/5 text-primary text-xs font-medium transition-all hover:bg-primary/10 hover:border-primary/40 active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="button-quick-location"
          >
            {sharingLocation ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MapPin className="h-3.5 w-3.5" />
            )}
            <span>{sharingLocation ? "Sharing…" : "Location"}</span>
          </button>

          {/* Call */}
          <button
            type="button"
            onClick={() => setLocation(`/call/${otherUserId}`)}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400 text-xs font-medium transition-all hover:bg-emerald-500/10 hover:border-emerald-500/45 active:scale-[0.97]"
            data-testid="button-quick-call"
          >
            <Phone className="h-3.5 w-3.5" />
            <span>Call</span>
          </button>

          <button
            type="button"
            onClick={() => setLocation("/")}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-destructive/30 bg-destructive/5 text-destructive text-xs font-semibold transition-all hover:bg-destructive/10 hover:border-destructive/50 active:scale-[0.97]"
            data-testid="button-quick-sos-home"
            aria-label="Open Home screen SOS"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Home SOS</span>
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground text-center mt-1.5">
          Need emergency help? Use the SOS button on your Home screen.
        </p>
        {showEmergencyContactingFooter && (
          <p
            className="text-[10px] text-muted-foreground text-center mt-1.5"
            data-testid="text-offline-hint"
          >
            App message pending. If this is an emergency, we are still contacting {otherUserName} by SMS, phone call, and email.
          </p>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border/60 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] bg-card">
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
