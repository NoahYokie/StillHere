import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Heart, MapPin, MessageCircle, UserPlus, Loader2, Send,
  ShieldCheck, Activity, AlertTriangle, Eye, LogOut, Trash2, Users,
  Sparkles, Battery, Car, Settings as SettingsIcon, Crown,
  Home as HomeIcon, GraduationCap, Briefcase, Dumbbell, Trees, Plus, Navigation,
  Phone, Clock, CheckCircle2, X, Pencil,
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import GoogleMap, { type MapPerson } from "@/components/google-map";
import type { FamilyOverview, FamilyMemberView, FamilyMessage, FamilyPlace, FamilyPlaceSchedule } from "@shared/schema";

const PLACE_ICONS: Record<string, any> = {
  home: HomeIcon, school: GraduationCap, work: Briefcase, gym: Dumbbell, park: Trees, pin: MapPin,
};
const PLACE_LABELS: { value: string; label: string }[] = [
  { value: "home", label: "Home" }, { value: "school", label: "School" },
  { value: "work", label: "Work" }, { value: "gym", label: "Gym" },
  { value: "park", label: "Park" }, { value: "pin", label: "Other" },
];

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin", adult: "Member", teen: "Member", child: "Member",
};

// Day-of-week labels (0 = Sunday) used in schedule UI
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDays(csv: string): string {
  const days = csv.split(",").map(d => parseInt(d, 10)).filter(n => Number.isInteger(n)).sort();
  if (days.length === 7) return "Every day";
  if (days.length === 5 && days.join(",") === "1,2,3,4,5") return "Mon to Fri";
  if (days.length === 2 && days.join(",") === "0,6") return "Weekends";
  return days.map(d => DAY_LABELS[d]).join(", ");
}

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function initials(name: string): string {
  return (
    name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || "").join("") || "?"
  );
}

function safetyTone(m: FamilyMemberView): { label: string; dot: string; tone: string } {
  if (m.status === "pending" || m.status === "invited") {
    return { label: "Awaiting accept", dot: "bg-muted-foreground/40", tone: "text-muted-foreground" };
  }
  if (m.status === "declined") {
    return { label: "Declined", dot: "bg-muted-foreground/40", tone: "text-muted-foreground" };
  }
  if (m.status === "paused") return { label: "Paused", dot: "bg-muted-foreground/40", tone: "text-muted-foreground" };
  if (m.hasActiveIncident || m.safetyState === "concern") {
    return { label: "Needs help", dot: "bg-destructive animate-pulse", tone: "text-destructive" };
  }
  if (m.lastSeenAt) {
    const ageMs = Date.now() - new Date(m.lastSeenAt).getTime();
    if (ageMs < 5 * 60 * 1000) {
      if (m.lastActivity === "driving") return { label: "Driving", dot: "bg-primary", tone: "text-primary" };
      if (m.lastActivity && m.lastActivity !== "stationary") return { label: "Moving", dot: "bg-primary", tone: "text-primary" };
      return { label: "Safe", dot: "bg-emerald-500", tone: "text-emerald-600 dark:text-emerald-400" };
    }
    if (ageMs < 30 * 60 * 1000) return { label: "Recent", dot: "bg-emerald-500", tone: "text-emerald-600 dark:text-emerald-400" };
    return { label: "Quiet", dot: "bg-muted-foreground/60", tone: "text-muted-foreground" };
  }
  return { label: "Not active yet", dot: "bg-muted-foreground/40", tone: "text-muted-foreground" };
}

type FamilyMessageWithSender = FamilyMessage & { senderName: string | null };

// Pending invitation surfaced by GET /api/family/invitations. Mirrors the
// PendingFamilyInvitation interface in server/storage.ts (kept inline here to
// avoid leaking server-only types to the client bundle).
interface PendingInvitation {
  memberId: string;
  familyId: string;
  familyName: string;
  inviterUserId: string;
  inviterName: string;
  role: "admin" | "adult" | "teen" | "child";
  invitedAt: string;
  legacyConfirmDeadline: string | null;
  isLegacyReconfirm: boolean;
}

export default function FamilyPage() {
  const [, setLocation] = useLocation();
  const { auth } = useAuth();
  const { toast } = useToast();
  const myUserId = auth?.user?.id;

  const { data, isLoading } = useQuery<FamilyOverview>({
    queryKey: ["/api/family"],
    refetchInterval: 30_000,
  });

  const family = data?.family ?? null;
  const isAdmin = !!data?.isAdmin;
  const members = data?.members ?? [];
  const myMember = members.find((m) => m.userId === myUserId) || null;

  // ---- Mutations ----
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const createFamilyMutation = useMutation({
    mutationFn: async (name: string) => apiRequest("POST", "/api/family", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Family created", description: "Now invite the people you trust." });
      setShowCreate(false);
      setCreateName("");
    },
    onError: () => toast({ title: "Could not create family", variant: "destructive" }),
  });

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ name: "", phone: "", role: "adult" });
  const inviteMutation = useMutation({
    mutationFn: async (body: any) => apiRequest("POST", "/api/family/invite", body),
    onSuccess: (_data, vars: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      const firstName = (vars?.name || "They").split(" ")[0] || "They";
      toast({
        title: "Invite sent",
        description: `${firstName} will need to accept before you can see their safety status or location.`,
      });
      setShowInvite(false);
      setInviteForm({ name: "", phone: "", role: "adult" });
    },
    onError: (e: any) => {
      // The 24h decline cooldown is the most common rejection - show the
      // friendly message rather than a generic failure.
      const msg = e?.message?.includes("decline_cooldown") || e?.message?.includes("recent invite")
        ? "This person declined a recent invite. You can re-invite them after 24 hours."
        : e?.message || "Try again";
      toast({ title: "Invite failed", description: msg, variant: "destructive" });
    },
  });

  // ---- Invitations inbox (consent gate) ----
  const { data: invitationsData } = useQuery<{ invitations: PendingInvitation[] }>({
    queryKey: ["/api/family/invitations"],
    refetchInterval: 60_000,
  });
  const invitations = invitationsData?.invitations ?? [];

  const acceptInviteMutation = useMutation({
    mutationFn: async (memberId: string) =>
      apiRequest("POST", `/api/family/invite/${memberId}/accept`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      queryClient.invalidateQueries({ queryKey: ["/api/family/invitations"] });
      toast({ title: "Joined family", description: "You're now part of the family safety circle." });
    },
    onError: (e: any) =>
      toast({ title: "Could not accept", description: e?.message || "Try again", variant: "destructive" }),
  });

  const declineInviteMutation = useMutation({
    mutationFn: async (memberId: string) =>
      apiRequest("POST", `/api/family/invite/${memberId}/decline`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/invitations"] });
      toast({ title: "Invite declined" });
    },
    onError: (e: any) =>
      toast({ title: "Could not decline", description: e?.message || "Try again", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (memberId: string) => apiRequest("DELETE", `/api/family/member/${memberId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Removed" });
    },
    onError: () => toast({ title: "Could not remove", variant: "destructive" }),
  });

  const [renameTarget, setRenameTarget] = useState<{ id: string; current: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameMutation = useMutation({
    mutationFn: async (vars: { memberId: string; nickname: string }) =>
      apiRequest("PATCH", `/api/family/member/${vars.memberId}`, { nickname: vars.nickname }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Saved" });
      setRenameTarget(null);
      setRenameValue("");
    },
    onError: (e: any) =>
      toast({ title: "Could not rename", description: e?.message || "Try again", variant: "destructive" }),
  });

  const closeFamilyMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", "/api/family"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      queryClient.invalidateQueries({ queryKey: ["/api/family/messages"] });
      toast({ title: "Family closed", description: "All members were detached and chat cleared." });
    },
    onError: () => toast({ title: "Could not close family", variant: "destructive" }),
  });

  // ---- Safety actions ----
  function getCurrentPos(): Promise<GeolocationPosition | null> {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
      );
    });
  }

  const pulseMutation = useMutation({
    mutationFn: async () => {
      const pos = await getCurrentPos();
      return apiRequest("POST", "/api/family/pulse", {
        lat: pos?.coords.latitude, lng: pos?.coords.longitude,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/messages"] });
      toast({ title: "Pulse sent", description: "Your family knows you're OK." });
    },
    onError: () => toast({ title: "Could not send pulse", variant: "destructive" }),
  });

  const [panicNote, setPanicNote] = useState("");
  const [showPanic, setShowPanic] = useState(false);
  const panicMutation = useMutation({
    mutationFn: async () => {
      const pos = await getCurrentPos();
      return apiRequest("POST", "/api/family/panic", {
        lat: pos?.coords.latitude, lng: pos?.coords.longitude, note: panicNote,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/messages"] });
      toast({ title: "Family alerted", description: "Everyone in your family was notified." });
      setShowPanic(false);
      setPanicNote("");
    },
    onError: () => toast({ title: "Could not send alert", variant: "destructive" }),
  });

  // ---- Watch Me (live location) ----
  const { data: liveStatus } = useQuery<{ active: boolean; share: any }>({
    queryKey: ["/api/live-location/status"],
    refetchInterval: 15_000,
    enabled: !!family,
  });
  const isWatchActive = !!liveStatus?.active;
  const [watchDuration, setWatchDuration] = useState(30);
  const [isStartingWatch, setIsStartingWatch] = useState(false);

  async function handleStartWatch() {
    setIsStartingWatch(true);
    try {
      const pos = await getCurrentPos();
      if (!pos) {
        toast({ title: "Location unavailable", description: "Allow location to use Watch Me.", variant: "destructive" });
        return;
      }
      await apiRequest("POST", "/api/family/watch-me/start", {
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy,
        durationMinutes: watchDuration,
      });
      const { startLiveTracking } = await import("@/lib/live-location");
      startLiveTracking({
        onExpired: () => {
          toast({ title: "Watch session ended" });
          queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
        },
      });
      toast({ title: "Family is watching", description: `Live for ${watchDuration} minutes.` });
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
    } catch (e: any) {
      toast({ title: "Could not start", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setIsStartingWatch(false);
    }
  }

  async function handleStopWatch() {
    try {
      const { stopLiveTracking } = await import("@/lib/live-location");
      stopLiveTracking();
      await apiRequest("POST", "/api/family/watch-me/stop", {});
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
      toast({ title: "Stopped sharing" });
    } catch {}
  }

  // ---- Family Chat ----
  const { data: messagesData } = useQuery<{ messages: FamilyMessageWithSender[] }>({
    queryKey: ["/api/family/messages"],
    enabled: !!family,
    refetchInterval: 60_000,
  });
  const [chatInput, setChatInput] = useState("");
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const messages = messagesData?.messages ?? [];

  const sendMessageMutation = useMutation({
    mutationFn: async (body: string) => apiRequest("POST", "/api/family/messages", { body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/messages"] });
      setChatInput("");
    },
  });

  // Real-time inbound messages via socket
  useEffect(() => {
    if (!family) return;
    const sock = getSocket();
    const handler = () => queryClient.invalidateQueries({ queryKey: ["/api/family/messages"] });
    const closedHandler = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Family closed", description: "The admin closed this family group." });
    };
    sock.on("family:message:new", handler);
    sock.on("family:closed", closedHandler);
    return () => {
      sock.off("family:message:new", handler);
      sock.off("family:closed", closedHandler);
    };
  }, [family?.id]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  // ---- Map data ----
  // My device location, used as a fallback so the map always shows something
  // (like Life360) even before any family member has shared live location.
  const [myDeviceLoc, setMyDeviceLoc] = useState<{ lat: number; lng: number; acc?: number } | null>(null);
  // While the family page is open, push the device GPS + IANA timezone to the
  // server every ~60s so OTHER family members see a fresh pin for me on their
  // map and the server can render times in my local zone.
  const lastSentRef = useRef(0);
  useEffect(() => {
    // Only stream device GPS once the user actually has a family — no need to
    // prompt for location on the empty "Create your family" landing state.
    if (!family || !navigator.geolocation) return;
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
    const sendHeartbeat = (lat: number, lng: number, acc?: number) => {
      const now = Date.now();
      if (now - lastSentRef.current < 45_000) return; // throttle to ~45s
      lastSentRef.current = now;
      apiRequest("POST", "/api/heartbeat", {
        lat, lng,
        acc: typeof acc === "number" ? Math.round(acc) : undefined,
        tz,
      }).catch(() => { /* fire-and-forget; UI fallback already covers gaps */ });
    };
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setMyDeviceLoc({ lat, lng, acc: accuracy });
        sendHeartbeat(lat, lng, accuracy);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
    // Also poke immediately so the first pin shows up fast.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setMyDeviceLoc({ lat, lng, acc: accuracy });
        sendHeartbeat(lat, lng, accuracy);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [family?.id]);

  const mapPeople: MapPerson[] = useMemo(() => {
    const fromMembers = members
      .filter((m) => m.lastLat != null && m.lastLng != null && (m.status === "active" || m.status === "active_legacy"))
      .map((m) => ({
        id: m.id,
        name: m.name + (m.userId === myUserId ? " (You)" : ""),
        lat: m.lastLat as number,
        lng: m.lastLng as number,
        accuracy: m.lastAccuracy ?? null,
        safetyState: (m.safetyState as any) || "active",
        activity: (m.lastActivity as any) || "stationary",
        isMe: m.userId === myUserId,
      }));
    // If I have no server-side location yet, drop a "You" pin from the live
    // device GPS so the map opens with at least my own dot, like 360.
    const meAlreadyOnMap = fromMembers.some(p => p.isMe);
    if (!meAlreadyOnMap && myDeviceLoc && myMember) {
      fromMembers.push({
        id: myMember.id,
        name: `${myMember.name} (You)`,
        lat: myDeviceLoc.lat,
        lng: myDeviceLoc.lng,
        accuracy: myDeviceLoc.acc ?? null,
        safetyState: "active" as any,
        activity: "stationary" as any,
        isMe: true,
      });
    }
    return fromMembers;
  }, [members, myUserId, myDeviceLoc, myMember]);

  // ---- Family Places ----
  const { data: placesData } = useQuery<{ places: FamilyPlace[] }>({
    queryKey: ["/api/family/places"],
    enabled: !!family,
  });
  const places = placesData?.places ?? [];

  const [showAddPlace, setShowAddPlace] = useState(false);
  const [newPlace, setNewPlace] = useState({ name: "", icon: "home", radius: 150 });

  const addPlaceMutation = useMutation({
    mutationFn: async () => {
      const pos = await getCurrentPos();
      if (!pos) throw new Error("Allow location to save a place at your current spot.");
      return apiRequest("POST", "/api/family/places", {
        name: newPlace.name, icon: newPlace.icon,
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        radiusMeters: newPlace.radius,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/places"] });
      toast({ title: "Place saved", description: "We'll try to alert the family when anyone arrives or leaves." });
      setShowAddPlace(false);
      setNewPlace({ name: "", icon: "home", radius: 150 });
    },
    onError: (e: any) => toast({ title: "Couldn't save place", description: e?.message, variant: "destructive" }),
  });

  const deletePlaceMutation = useMutation({
    mutationFn: async (placeId: string) => apiRequest("DELETE", `/api/family/places/${placeId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/places"] });
      toast({ title: "Place removed" });
    },
  });

  // "On my way" - starts watch-me + posts a system message in chat with destination.
  async function handleOnMyWay(place: FamilyPlace) {
    try {
      // Post to chat (fire-and-forget, non-blocking)
      apiRequest("POST", "/api/family/messages", {
        body: `On my way to ${place.name}.`,
      }).then(() => queryClient.invalidateQueries({ queryKey: ["/api/family/messages"] }));

      // Start watch-me if not already active
      if (!isWatchActive) {
        const pos = await getCurrentPos();
        if (pos) {
          await apiRequest("POST", "/api/family/watch-me/start", {
            lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy,
            durationMinutes: 60,
          });
          const { startLiveTracking } = await import("@/lib/live-location");
          startLiveTracking({
            onExpired: () => queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] }),
          });
          queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
        }
      }
      toast({ title: `Heading to ${place.name}`, description: "Family can see your location." });
    } catch (e: any) {
      toast({ title: "Could not share", description: e?.message, variant: "destructive" });
    }
  }

  // Tap a member chip (or marker) to zoom in on just them.
  // null = "Show everyone" - smartCamera will fit all to bounds.
  const [focusedMemberId, setFocusedMemberId] = useState<string | null>(null);

  // Drop the focus if the focused member loses their location or leaves the family.
  useEffect(() => {
    if (!focusedMemberId) return;
    const stillThere = mapPeople.some(p => p.id === focusedMemberId);
    if (!stillThere) setFocusedMemberId(null);
  }, [mapPeople, focusedMemberId]);

  // Center on the focused member if any, else first person, else first place.
  const mapCenter = useMemo(() => {
    if (focusedMemberId) {
      const f = mapPeople.find(p => p.id === focusedMemberId);
      if (f) return { lat: f.lat, lng: f.lng };
    }
    if (mapPeople.length > 0) return { lat: mapPeople[0].lat, lng: mapPeople[0].lng };
    if (places.length > 0) return { lat: places[0].lat, lng: places[0].lng };
    return null;
  }, [mapPeople, places, focusedMemberId]);

  const membersWithoutLocation = useMemo(
    () => members.filter((m) =>
      (m.status === "active" || m.status === "active_legacy") &&
      !mapPeople.some((p) => p.id === m.id)
    ),
    [members, mapPeople],
  );

  // ---- Per-member place schedules (parent assigns "Sarah at School Mon-Fri") ----
  const { data: schedulesData } = useQuery<{ schedules: FamilyPlaceSchedule[] }>({
    queryKey: ["/api/family/place-schedules"],
    enabled: !!family,
  });
  const schedules = schedulesData?.schedules ?? [];

  const [scheduleDialog, setScheduleDialog] = useState<{ placeId: string; placeName: string } | null>(null);
  const [newSchedule, setNewSchedule] = useState({
    memberId: "",
    days: [1, 2, 3, 4, 5] as number[], // weekdays default
    startHour: 8, startMin: 30,
    endHour: 15, endMin: 30,
    grace: 15,
  });

  const addScheduleMutation = useMutation({
    mutationFn: async () => {
      if (!scheduleDialog) throw new Error("No place selected");
      return apiRequest("POST", `/api/family/places/${scheduleDialog.placeId}/schedules`, {
        memberId: newSchedule.memberId,
        daysOfWeek: newSchedule.days.join(","),
        expectedStartMinutes: newSchedule.startHour * 60 + newSchedule.startMin,
        expectedEndMinutes: newSchedule.endHour * 60 + newSchedule.endMin,
        graceMinutes: newSchedule.grace,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/place-schedules"] });
      toast({ title: "Schedule saved", description: "We'll alert the family if they're not there in time." });
      setScheduleDialog(null);
      setNewSchedule({ memberId: "", days: [1, 2, 3, 4, 5], startHour: 8, startMin: 30, endHour: 15, endMin: 30, grace: 15 });
    },
    onError: (e: any) => toast({ title: "Couldn't save schedule", description: e?.message, variant: "destructive" }),
  });

  const deleteScheduleMutation = useMutation({
    mutationFn: async (scheduleId: string) =>
      // pass {} so apiRequest attaches the Content-Type:application/json
      // header that the global guard requires on all non-GET /api routes
      apiRequest("DELETE", `/api/family/place-schedules/${scheduleId}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family/place-schedules"] });
      toast({ title: "Schedule removed" });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't remove schedule", description: e?.message, variant: "destructive" }),
  });

  // ---- Panic quick replies ----
  // When someone presses Panic, every other family member sees their message
  // with three one-tap reply pills so the response is fast.
  const [repliedPanicIds, setRepliedPanicIds] = useState<Set<string>>(new Set());
  function sendPanicReply(panicMsgId: string, body: string) {
    setRepliedPanicIds(prev => new Set(prev).add(panicMsgId));
    sendMessageMutation.mutate(body, {
      onError: () => {
        setRepliedPanicIds(prev => {
          const next = new Set(prev);
          next.delete(panicMsgId);
          return next;
        });
        toast({ title: "Couldn't send reply", variant: "destructive" });
      },
    });
  }

  // Toast every TRULY inbound panic. Driven by the socket payload (not by
  // polling the messages list), so multiple back-to-back panics each toast
  // exactly once and historical panics on first load are ignored.
  const toastedPanicIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!family) return;
    const sock = getSocket();
    const onPanic = (payload: any) => {
      if (!payload || payload.kind !== "panic") return;
      if (!payload.id || payload.senderId === myUserId) return;
      if (toastedPanicIdsRef.current.has(payload.id)) return;
      toastedPanicIdsRef.current.add(payload.id);
      toast({
        title: `${payload.senderName || "Family member"} pressed Panic`,
        description: "Open chat to reply.",
        variant: "destructive",
      });
    };
    sock.on("family:message:new", onPanic);
    return () => { sock.off("family:message:new", onPanic); };
  }, [family?.id, myUserId]);

  // Pass family places to the map as geofence circles for visual context.
  const placeGeofences = useMemo(
    () => places.map((p) => ({
      id: p.id, name: p.name, lat: p.lat, lng: p.lng, radiusMeters: p.radiusMeters,
    })),
    [places],
  );

  // ============ RENDER ============
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Reusable invitation cards. Rendered above both the empty-state landing
  // (so a brand-new user with a pending invite sees it immediately on first
  // load) and the in-family header (so multi-family users can accept other
  // invites without leaving the page).
  const renderInvitations = () => {
    if (invitations.length === 0) return null;
    return (
      <div className="space-y-2" data-testid="invitations-banner">
        {invitations.map((inv) => (
          <Card key={inv.memberId} data-testid={`card-invitation-${inv.memberId}`}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <UserPlus className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium" data-testid={`text-invitation-title-${inv.memberId}`}>
                    {inv.isLegacyReconfirm ? "Re-confirm" : "Family invite"}: {inv.familyName}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {inv.inviterName} invited you. They will not see your safety status or location until you accept.
                  </p>
                  {inv.isLegacyReconfirm && inv.legacyConfirmDeadline && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                      Please confirm by {new Date(inv.legacyConfirmDeadline).toLocaleDateString()}.
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={acceptInviteMutation.isPending}
                  onClick={() => acceptInviteMutation.mutate(inv.memberId)}
                  data-testid={`button-accept-invitation-${inv.memberId}`}
                >
                  {acceptInviteMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={declineInviteMutation.isPending}
                  onClick={() => declineInviteMutation.mutate(inv.memberId)}
                  data-testid={`button-decline-invitation-${inv.memberId}`}
                >
                  Decline
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  };

  // No family yet - simple create screen
  if (!family) {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-2">
          <BackButton to="/" />
          <h1 className="text-lg font-bold">Family</h1>
        </header>
        <div className="px-4 py-8 max-w-md mx-auto space-y-4">
          {renderInvitations()}
          <Card>
            <CardContent className="p-6 space-y-4 text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 mx-auto flex items-center justify-center">
                <Users className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Create your family</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Watch over each other. Map, chat, and one-tap safety pings in one place.
                </p>
              </div>
              <Dialog open={showCreate} onOpenChange={setShowCreate}>
                <DialogTrigger asChild>
                  <Button className="w-full" data-testid="button-create-family">Create Family</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Name your family</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <Label htmlFor="fam-name">Family name</Label>
                    <Input
                      id="fam-name"
                      value={createName}
                      onChange={(e) => setCreateName(e.target.value)}
                      placeholder="The Bangouras"
                      data-testid="input-family-name"
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={() => createName.trim() && createFamilyMutation.mutate(createName.trim())}
                      disabled={!createName.trim() || createFamilyMutation.isPending}
                      data-testid="button-create-family-confirm"
                    >
                      {createFamilyMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Create
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // ===== Family exists - the real experience =====
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-card/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-2">
        <BackButton to="/" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate" data-testid="text-family-name">{family.name}</h1>
          <p className="text-xs text-muted-foreground">
            {members.filter((m) => m.status === "active" || m.status === "active_legacy").length} members
            {members.some((m) => m.status === "pending") && (
              <span className="ml-1">
                · {members.filter((m) => m.status === "pending").length} awaiting accept
              </span>
            )}
          </p>
        </div>
        {isAdmin && (
          <Dialog open={showInvite} onOpenChange={setShowInvite}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" data-testid="button-invite">
                <UserPlus className="w-4 h-4 mr-1" /> Invite
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Invite someone you trust</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="inv-name">Name</Label>
                  <Input id="inv-name" value={inviteForm.name}
                    onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })}
                    placeholder="Mom" data-testid="input-invite-name" />
                </div>
                <div>
                  <Label htmlFor="inv-phone">Phone number</Label>
                  <Input id="inv-phone" value={inviteForm.phone}
                    onChange={(e) => setInviteForm({ ...inviteForm, phone: e.target.value })}
                    placeholder="+1 555 000 1234" data-testid="input-invite-phone" />
                </div>
                <div>
                  <Label>Role</Label>
                  <Select value={inviteForm.role}
                    onValueChange={(v) => setInviteForm({ ...inviteForm, role: v })}>
                    <SelectTrigger data-testid="select-invite-role"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="adult">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* Round 3 consent disclosure: make the opt-in explicit at
                    invite time. The same wording is repeated in the SMS body
                    and in the post-send toast for consistency. */}
                <div
                  className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground flex gap-2"
                  data-testid="text-invite-disclosure"
                >
                  <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
                  <span>
                    {(inviteForm.name.trim().split(" ")[0] || "They")} will need to accept before
                    you can see their safety status or location. They can decline at any time.
                  </span>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => inviteMutation.mutate({
                    ...inviteForm,
                    parentalConsentRequired: false,
                  })}
                  disabled={!inviteForm.name.trim() || !inviteForm.phone.trim() || inviteMutation.isPending}
                  data-testid="button-invite-confirm"
                >
                  {inviteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Send invite
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </header>

      {invitations.length > 0 && (
        <div className="px-4 pt-3">{renderInvitations()}</div>
      )}

      {/* Member chip rail - tap to zoom on a member, "All" to see everyone */}
      {mapPeople.length > 0 && (
        <div className="px-3 pt-2 pb-1 overflow-x-auto" data-testid="member-chip-rail">
          <div className="flex items-center gap-2 min-w-min">
            <button
              onClick={() => setFocusedMemberId(null)}
              className={`shrink-0 h-8 px-3 rounded-full text-xs font-medium border transition ${
                focusedMemberId === null
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border text-foreground hover:bg-muted"
              }`}
              data-testid="chip-show-all"
            >
              <Users className="w-3.5 h-3.5 inline mr-1 -mt-0.5" /> Show all
            </button>
            {mapPeople.map((p) => {
              const m = members.find(x => x.id === p.id);
              const tone = m ? safetyTone(m) : null;
              const active = focusedMemberId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setFocusedMemberId(p.id)}
                  className={`shrink-0 h-8 pl-1.5 pr-3 rounded-full text-xs font-medium border flex items-center gap-1.5 transition ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card border-border text-foreground hover:bg-muted"
                  }`}
                  data-testid={`chip-member-${p.id}`}
                >
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                    active ? "bg-primary-foreground/20" : "bg-primary/10 text-primary"
                  }`}>{initials(p.name)}</span>
                  <span className="truncate max-w-[110px]">{p.name}</span>
                  {tone && !active && <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* MAP - hero of the page. Always rendered (Life360-style) so the user
          sees their own dot the moment they open Family, even before anyone
          has started Watch Me. */}
      <div className="relative" style={{ height: "55vh", minHeight: 320 }}>
        {mapCenter ? (
          <GoogleMap
            center={mapCenter}
            people={mapPeople}
            geofences={placeGeofences}
            smartCamera={true}
            darkMode={false}
            focusPersonId={focusedMemberId}
            onPersonTap={(id) => {
              // Marker-cluster taps emit synthetic ids like "group:abc..." which
              // aren't real member ids - ignore those and leave the cluster
              // expansion to the user zooming in manually.
              if (id.startsWith("group:")) return;
              setFocusedMemberId(id);
            }}
          />
        ) : (
          <div className="w-full h-full bg-muted/40 flex items-center justify-center px-5" data-testid="family-map-empty">
            <div className="max-w-sm text-center space-y-3">
              <div className="mx-auto w-14 h-14 rounded-full bg-card border border-border flex items-center justify-center shadow-sm">
                <MapPin className="w-7 h-7 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-foreground">No live location available</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Family locations appear here only when someone shares location or allows StillHere to update it.
                </p>
              </div>
            </div>
          </div>
        )}
        {membersWithoutLocation.length > 0 && (
          <div className="absolute top-3 left-3 right-3 bg-card/95 backdrop-blur border border-border rounded-xl px-3 py-2 shadow-sm text-xs text-muted-foreground" data-testid="family-location-unavailable">
            <div className="flex items-start gap-2">
              <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-foreground">Location not shared</p>
                <p>
                  {membersWithoutLocation.slice(0, 2).map((m) => m.name).join(", ")}
                  {membersWithoutLocation.length > 2 ? ` and ${membersWithoutLocation.length - 2} more` : ""}
                  {" "}may have location sharing paused, phone location off, or have not opened StillHere recently.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Floating safety button rail */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card/95 backdrop-blur rounded-full shadow-lg border border-border px-2 py-1.5">
          <Button
            size="sm"
            className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white h-9 px-3"
            onClick={() => pulseMutation.mutate()}
            disabled={pulseMutation.isPending}
            data-testid="button-family-pulse"
          >
            {pulseMutation.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <><Heart className="w-4 h-4 mr-1" /> I'm OK</>}
          </Button>

          {isWatchActive ? (
            <Button
              size="sm" variant="outline"
              className="rounded-full h-9 px-3 border-primary text-primary"
              onClick={handleStopWatch}
              data-testid="button-stop-watch"
            >
              <Eye className="w-4 h-4 mr-1" /> Stop sharing
            </Button>
          ) : (
            <Button
              size="sm"
              className="rounded-full h-9 px-3 bg-primary hover:bg-primary/90"
              onClick={handleStartWatch}
              disabled={isStartingWatch}
              data-testid="button-watch-me"
            >
              {isStartingWatch
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <><MapPin className="w-4 h-4 mr-1" /> Watch Me</>}
            </Button>
          )}

          <AlertDialog open={showPanic} onOpenChange={setShowPanic}>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                className="rounded-full bg-destructive hover:bg-destructive/90 text-white h-9 px-3"
                data-testid="button-family-panic"
              >
                <AlertTriangle className="w-4 h-4 mr-1" /> Panic
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Alert your family?</AlertDialogTitle>
                <AlertDialogDescription>
                  Everyone in your family will see this in the family chat and get a push notification.
                  In a life-threatening emergency, call 911 (or your local emergency number) first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Input
                value={panicNote}
                onChange={(e) => setPanicNote(e.target.value)}
                placeholder="Optional: what's happening?"
                maxLength={280}
                data-testid="input-panic-note"
              />
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-panic-cancel">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90"
                  onClick={() => panicMutation.mutate()}
                  data-testid="button-panic-confirm"
                >
                  {panicMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Send alert
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* Watch Me duration picker - only shown when not active */}
        {!isWatchActive && (
          <div className="absolute top-3 right-3 bg-card/95 backdrop-blur rounded-lg shadow border border-border px-2 py-1 flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Duration:</span>
            {[15, 30, 60].map((d) => (
              <button
                key={d}
                onClick={() => setWatchDuration(d)}
                className={`px-2 py-0.5 rounded ${
                  watchDuration === d
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                data-testid={`button-duration-${d}`}
              >
                {d}m
              </button>
            ))}
          </div>
        )}
      </div>

      {/* TABS BELOW MAP */}
      <Tabs defaultValue="members" className="flex-1 flex flex-col">
        <TabsList className="mx-4 mt-3 grid grid-cols-4">
          <TabsTrigger value="members" data-testid="tab-members">
            <Users className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Members</span>
          </TabsTrigger>
          <TabsTrigger value="chat" data-testid="tab-chat">
            <MessageCircle className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Chat</span>
          </TabsTrigger>
          <TabsTrigger value="places" data-testid="tab-places">
            <MapPin className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Places</span>
          </TabsTrigger>
          <TabsTrigger value="safety" data-testid="tab-safety">
            <Sparkles className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Safety</span>
          </TabsTrigger>
        </TabsList>

        {/* MEMBERS TAB */}
        <TabsContent value="members" className="flex-1 px-4 py-3 space-y-2">
          {members.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">
              No members yet. Invite the people you trust.
            </p>
          )}
          {members.map((m) => {
            const tone = safetyTone(m);
            const isMe = m.userId === myUserId;
            const isMemberAdmin = m.isAdmin;
            return (
              <Card key={m.id} data-testid={`card-member-${m.id}`}>
                <CardContent className="p-3 flex items-center gap-3">
                  <Avatar className="w-11 h-11">
                    <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                      {initials(m.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium truncate" data-testid={`text-member-name-${m.id}`}>
                        {m.nickname || m.name}{isMe && <span className="text-muted-foreground text-xs"> (You)</span>}
                      </span>
                      {m.nickname && m.nickname !== m.name && (
                        <span
                          className="text-xs text-muted-foreground truncate"
                          data-testid={`text-member-realname-${m.id}`}
                          title={m.name}
                        >
                          ({m.name})
                        </span>
                      )}
                      {isMemberAdmin && (
                        <Badge variant="secondary" className="text-[10px] h-4 px-1 gap-0.5">
                          <Crown className="w-2.5 h-2.5" /> Admin
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px] h-4 px-1">
                        {ROLE_LABEL[m.role] || m.role}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                      <span className={`text-xs ${tone.tone}`}>{tone.label}</span>
                      {m.lastSeenAt && m.status === "active" && (
                        <span className="text-xs text-muted-foreground">
                          · {formatDistanceToNow(new Date(m.lastSeenAt), { addSuffix: true })}
                        </span>
                      )}
                      {(() => {
                        if (isMe || !m.timezone) return null;
                        let myTz: string | undefined;
                        try { myTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
                        if (myTz && myTz === m.timezone) return null;
                        let localTime = "";
                        try {
                          localTime = new Intl.DateTimeFormat(undefined, {
                            hour: "numeric", minute: "2-digit", timeZone: m.timezone,
                          }).format(new Date());
                        } catch { return null; }
                        return (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`text-member-localtime-${m.id}`}
                            title={m.timezone}
                          >
                            · {localTime} their time
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                  {(isMe || isAdmin) && !m.id.startsWith("admin:") && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground"
                      data-testid={`button-rename-member-${m.id}`}
                      onClick={() => {
                        setRenameTarget({ id: m.id, current: m.nickname || "" });
                        setRenameValue(m.nickname || "");
                      }}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                  )}
                  {(isMe || isAdmin) && !isMemberAdmin && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="icon" variant="ghost" className="text-muted-foreground"
                          data-testid={`button-remove-member-${m.id}`}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {isMe ? "Leave this family?" : `Remove ${m.name}?`}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {isMe
                              ? "You'll stop sharing with them and lose access to the family chat."
                              : "They'll lose access to the family map and chat."}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive hover:bg-destructive/90"
                            onClick={() => removeMutation.mutate(m.id)}
                            data-testid={`button-confirm-remove-${m.id}`}
                          >
                            {isMe ? "Leave" : "Remove"}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* Self-leave fallback when admin (admin must close family instead) */}
          {!isAdmin && myMember && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-full mt-3" data-testid="button-leave-family">
                  <LogOut className="w-4 h-4 mr-2" /> Leave family
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Leave {family.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    You'll stop sharing with them and lose access to the family chat. You can be invited back any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive hover:bg-destructive/90"
                    onClick={() => removeMutation.mutate(myMember.id)}
                  >Leave</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {/* Admin-only: close the entire family. Compact text link, not a
              giant red bar - this is a rare, scary action, not a primary CTA. */}
          {isAdmin && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  className="mt-4 mx-auto block text-xs text-muted-foreground hover:text-destructive underline-offset-2 hover:underline transition"
                  data-testid="button-close-family"
                >
                  Delete family
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Close {family.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the family group, removes every member, and clears the chat history.
                    Everyone's personal account stays. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive hover:bg-destructive/90"
                    onClick={() => closeFamilyMutation.mutate()}
                    data-testid="button-confirm-close-family"
                  >
                    {closeFamilyMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Close family
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Dialog open={!!renameTarget} onOpenChange={(o) => { if (!o) { setRenameTarget(null); setRenameValue(""); } }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename in your family</DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="rename-input">Display name</Label>
                <Input
                  id="rename-input"
                  value={renameValue}
                  maxLength={40}
                  placeholder="Dad, Mum, Kid..."
                  onChange={(e) => setRenameValue(e.target.value)}
                  data-testid="input-rename-nickname"
                />
                <p className="text-xs text-muted-foreground">
                  Only your family sees this. Leave blank to use their real name.
                </p>
              </div>
              <DialogFooter className="gap-2">
                {renameTarget?.current && (
                  <Button
                    variant="ghost"
                    onClick={() => renameTarget && renameMutation.mutate({ memberId: renameTarget.id, nickname: "" })}
                    disabled={renameMutation.isPending}
                    data-testid="button-rename-clear"
                  >
                    Clear
                  </Button>
                )}
                <Button
                  onClick={() => renameTarget && renameMutation.mutate({ memberId: renameTarget.id, nickname: renameValue })}
                  disabled={renameMutation.isPending}
                  data-testid="button-rename-save"
                >
                  {renameMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* CHAT TAB */}
        <TabsContent value="chat" className="flex-1 flex flex-col px-0 py-0 mt-0">
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2" style={{ minHeight: 200 }}>
            {messages.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                No messages yet. Say hi.
              </p>
            )}
            {messages.map((m) => {
              const isMe = m.senderId === myUserId;
              const isSystem = m.kind === "pulse" || m.kind === "panic" || m.kind === "system";
              if (isSystem) {
                const isPanic = m.kind === "panic";
                const showQuickReply = isPanic && m.senderId !== myUserId && !repliedPanicIds.has(m.id);
                const senderFirst = (m.senderName || "Family member").split(/\s+/)[0];
                return (
                  <div key={m.id} className="flex flex-col items-center gap-1.5" data-testid={`message-${m.id}`}>
                    <div className={`text-xs px-3 py-1.5 rounded-full max-w-[85%] text-center ${
                      isPanic
                        ? "bg-destructive/10 text-destructive border border-destructive/20"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                    }`}>
                      {isPanic && <AlertTriangle className="w-3 h-3 inline mr-1" />}
                      {!isPanic && <Heart className="w-3 h-3 inline mr-1" />}
                      {m.body}
                      <span className="opacity-60 ml-2">
                        {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    {showQuickReply && (
                      <div className="flex flex-wrap items-center justify-center gap-1.5 max-w-[90%]" data-testid={`panic-quick-reply-${m.id}`}>
                        <button
                          onClick={() => sendPanicReply(m.id, `${senderFirst}, are you OK?`)}
                          className="text-[11px] font-medium h-7 px-2.5 rounded-full bg-card border border-destructive/30 text-destructive hover:bg-destructive/10 transition flex items-center gap-1"
                          data-testid={`button-panic-reply-ok-${m.id}`}
                        >
                          <AlertTriangle className="w-3 h-3" /> Are you OK?
                        </button>
                        <button
                          onClick={() => sendPanicReply(m.id, `I'm coming to help.`)}
                          className="text-[11px] font-medium h-7 px-2.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition flex items-center gap-1"
                          data-testid={`button-panic-reply-coming-${m.id}`}
                        >
                          <Navigation className="w-3 h-3" /> I'm coming
                        </button>
                        <button
                          onClick={() => sendPanicReply(m.id, `Calling you now.`)}
                          className="text-[11px] font-medium h-7 px-2.5 rounded-full bg-emerald-600 text-white hover:bg-emerald-700 transition flex items-center gap-1"
                          data-testid={`button-panic-reply-call-${m.id}`}
                        >
                          <Phone className="w-3 h-3" /> Call me
                        </button>
                      </div>
                    )}
                    {isPanic && repliedPanicIds.has(m.id) && (
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Replied
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div key={m.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`} data-testid={`message-${m.id}`}>
                  <div className={`max-w-[78%] rounded-2xl px-3 py-2 ${
                    isMe
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-muted rounded-bl-sm"
                  }`}>
                    {!isMe && (
                      <div className="text-[11px] font-semibold opacity-70 mb-0.5">{m.senderName || "Family"}</div>
                    )}
                    <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
                    <div className="text-[10px] opacity-60 mt-0.5 text-right">
                      {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-border bg-card px-3 py-2 flex items-center gap-2">
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && chatInput.trim()) {
                  e.preventDefault();
                  sendMessageMutation.mutate(chatInput.trim());
                }
              }}
              placeholder="Message your family"
              data-testid="input-chat"
            />
            <Button
              size="icon"
              onClick={() => chatInput.trim() && sendMessageMutation.mutate(chatInput.trim())}
              disabled={!chatInput.trim() || sendMessageMutation.isPending}
              data-testid="button-send-chat"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </TabsContent>

        {/* PLACES TAB */}
        <TabsContent value="places" className="flex-1 px-4 py-3 space-y-2">
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="p-3 flex items-start gap-2">
              <Navigation className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div className="text-xs text-muted-foreground">
                Saved places like Home, School, or Work. Family chat shows
                <strong className="text-foreground"> "Sarah arrived at School" </strong>
                automatically when anyone enters or leaves. Each place has a circle on the map.
              </div>
            </CardContent>
          </Card>

          {places.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No places yet. Add Home first. It's the most useful one.
            </p>
          )}

          {places.map((p) => {
            const Icon = PLACE_ICONS[p.icon] || MapPin;
            const placeSchedules = schedules.filter(s => s.placeId === p.id);
            return (
              <Card key={p.id} data-testid={`card-place-${p.id}`}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Within {p.radiusMeters}m
                      </div>
                    </div>
                    <Button
                      size="sm" variant="outline"
                      onClick={() => handleOnMyWay(p)}
                      data-testid={`button-on-my-way-${p.id}`}
                    >
                      <Navigation className="w-3.5 h-3.5 mr-1" /> On my way
                    </Button>
                    {isAdmin && (
                      <Button
                        size="icon" variant="ghost" className="text-muted-foreground"
                        onClick={() => deletePlaceMutation.mutate(p.id)}
                        disabled={deletePlaceMutation.isPending}
                        data-testid={`button-delete-place-${p.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>

                  {/* Per-member schedules: "Sarah · Mon-Fri · 8:30-15:30" */}
                  {(placeSchedules.length > 0 || isAdmin) && (
                    <div className="pt-2 border-t border-border space-y-1.5">
                      {placeSchedules.length === 0 && isAdmin && (
                        <p className="text-[11px] text-muted-foreground">
                          No expected times yet. Add one and we'll alert the family if they're not here.
                        </p>
                      )}
                      {placeSchedules.map((s) => {
                        const member = members.find(mm => mm.id === s.memberId);
                        return (
                          <div key={s.id} className="flex items-center gap-2 text-xs bg-muted/50 rounded-md px-2 py-1.5"
                            data-testid={`schedule-${s.id}`}>
                            <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">
                                {member?.name || "Member"} · {formatDays(s.daysOfWeek)}
                              </div>
                              <div className="text-muted-foreground">
                                {formatMinutes(s.expectedStartMinutes)} to {formatMinutes(s.expectedEndMinutes)}
                                {s.graceMinutes > 0 && ` · ${s.graceMinutes}m grace`}
                              </div>
                            </div>
                            {isAdmin && (
                              <button
                                onClick={() => deleteScheduleMutation.mutate(s.id)}
                                disabled={deleteScheduleMutation.isPending}
                                className="text-muted-foreground hover:text-destructive shrink-0"
                                data-testid={`button-delete-schedule-${s.id}`}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {isAdmin && (
                        <Button
                          size="sm" variant="ghost"
                          className="w-full h-7 text-xs text-primary hover:bg-primary/10"
                          onClick={() => {
                            const firstMember = members.find(
                              mm => mm.status === "active" && !mm.id.startsWith("admin:"),
                            );
                            setNewSchedule(prev => ({ ...prev, memberId: firstMember?.id || "" }));
                            setScheduleDialog({ placeId: p.id, placeName: p.name });
                          }}
                          data-testid={`button-add-schedule-${p.id}`}
                        >
                          <Plus className="w-3 h-3 mr-1" /> Expect a member here
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* Schedule dialog - "Sarah at School Mon-Fri 8:30-15:30" */}
          <Dialog open={!!scheduleDialog} onOpenChange={(o) => !o && setScheduleDialog(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Expect someone at {scheduleDialog?.placeName}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Who?</Label>
                  <Select
                    value={newSchedule.memberId}
                    onValueChange={(v) => setNewSchedule({ ...newSchedule, memberId: v })}
                  >
                    <SelectTrigger data-testid="select-schedule-member">
                      <SelectValue placeholder="Pick a family member" />
                    </SelectTrigger>
                    <SelectContent>
                      {members
                        // Only real DB rows have UUID ids - synthetic admin
                        // rows ("admin:<userId>") can't be referenced by FK
                        .filter(mm => mm.status === "active" && !mm.id.startsWith("admin:"))
                        .map((mm) => (
                        <SelectItem key={mm.id} value={mm.id}>
                          {mm.name} ({ROLE_LABEL[mm.role] || mm.role})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Days</Label>
                  <div className="flex gap-1 mt-1.5">
                    {DAY_LABELS.map((d, idx) => {
                      const active = newSchedule.days.includes(idx);
                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => setNewSchedule(prev => ({
                            ...prev,
                            days: active ? prev.days.filter(x => x !== idx) : [...prev.days, idx].sort(),
                          }))}
                          className={`flex-1 h-9 rounded-md text-xs font-medium border transition ${
                            active
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-card border-border text-muted-foreground hover:bg-muted"
                          }`}
                          data-testid={`button-schedule-day-${idx}`}
                        >
                          {d}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Arrives by</Label>
                    <Input
                      type="time"
                      value={`${String(newSchedule.startHour).padStart(2,"0")}:${String(newSchedule.startMin).padStart(2,"0")}`}
                      onChange={(e) => {
                        const [h, m] = e.target.value.split(":").map(Number);
                        setNewSchedule({ ...newSchedule, startHour: h || 0, startMin: m || 0 });
                      }}
                      data-testid="input-schedule-start"
                    />
                  </div>
                  <div>
                    <Label>Leaves by</Label>
                    <Input
                      type="time"
                      value={`${String(newSchedule.endHour).padStart(2,"0")}:${String(newSchedule.endMin).padStart(2,"0")}`}
                      onChange={(e) => {
                        const [h, m] = e.target.value.split(":").map(Number);
                        setNewSchedule({ ...newSchedule, endHour: h || 0, endMin: m || 0 });
                      }}
                      data-testid="input-schedule-end"
                    />
                  </div>
                </div>

                <div>
                  <Label>Grace period</Label>
                  <Select
                    value={String(newSchedule.grace)}
                    onValueChange={(v) => setNewSchedule({ ...newSchedule, grace: parseInt(v) })}
                  >
                    <SelectTrigger data-testid="select-schedule-grace"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">No grace</SelectItem>
                      <SelectItem value="15">15 minutes</SelectItem>
                      <SelectItem value="30">30 minutes</SelectItem>
                      <SelectItem value="60">1 hour</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <p className="text-xs text-muted-foreground">
                  We'll quietly check that they're inside this place on each scheduled day.
                  If they're not there by the end of the window (plus grace), the family chat gets a one-time alert.
                </p>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => addScheduleMutation.mutate()}
                  disabled={!newSchedule.memberId || newSchedule.days.length === 0 || addScheduleMutation.isPending}
                  data-testid="button-save-schedule"
                >
                  {addScheduleMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save expectation
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={showAddPlace} onOpenChange={setShowAddPlace}>
            <DialogTrigger asChild>
              <Button className="w-full mt-2" data-testid="button-add-place">
                <Plus className="w-4 h-4 mr-2" /> Add this spot as a place
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Save your current location</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="place-name">What's it called?</Label>
                  <Input
                    id="place-name" value={newPlace.name}
                    onChange={(e) => setNewPlace({ ...newPlace, name: e.target.value })}
                    placeholder="Home" maxLength={60}
                    data-testid="input-place-name"
                  />
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={newPlace.icon}
                    onValueChange={(v) => setNewPlace({ ...newPlace, icon: v })}>
                    <SelectTrigger data-testid="select-place-icon"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PLACE_LABELS.map((l) => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Detection radius</Label>
                  <Select
                    value={String(newPlace.radius)}
                    onValueChange={(v) => setNewPlace({ ...newPlace, radius: parseInt(v) })}
                  >
                    <SelectTrigger data-testid="select-place-radius"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="100">Tight (100m)</SelectItem>
                      <SelectItem value="150">Standard (150m)</SelectItem>
                      <SelectItem value="300">Wide (300m)</SelectItem>
                      <SelectItem value="500">Very wide (500m)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">
                  Make sure you're physically at this spot. It uses your phone's current GPS.
                </p>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => addPlaceMutation.mutate()}
                  disabled={!newPlace.name.trim() || addPlaceMutation.isPending}
                  data-testid="button-add-place-confirm"
                >
                  {addPlaceMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save place
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* SAFETY TAB - features + privacy reassurance */}
        <TabsContent value="safety" className="flex-1 px-4 py-3 space-y-3">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-primary" />
                <h3 className="font-semibold">Safety features in this family</h3>
              </div>
              <ul className="space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  <Heart className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                  <div>
                    <strong>Family Pulse</strong>
                    <p className="text-muted-foreground text-xs">One-tap "I'm OK". Everyone sees it in chat.</p>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                  <div>
                    <strong>Family Panic</strong>
                    <p className="text-muted-foreground text-xs">Urgent broadcast with push notification to every family member.</p>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <Activity className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div>
                    <strong>Crash &amp; Fall sensing</strong>
                    <p className="text-muted-foreground text-xs">Attempts to alert the family if a possible crash or fall is detected on a member's device.</p>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <Car className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div>
                    <strong>Driving status</strong>
                    <p className="text-muted-foreground text-xs">Map pins show when a family member is driving so you don't text them.</p>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div>
                    <strong>Watch Me</strong>
                    <p className="text-muted-foreground text-xs">Share live location with the family for 15, 30, or 60 minutes.</p>
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <Battery className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div>
                    <strong>Adaptive heartbeat</strong>
                    <p className="text-muted-foreground text-xs">Battery-aware updates so monitoring doesn't drain phones.</p>
                  </div>
                </li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-emerald-600" />
                <h3 className="font-semibold">Family is for safety, not surveillance.</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                StillHere never tracks app usage, browser history, or device activity.
                Each adult controls their own sharing mode.
              </p>
              <div className="text-xs text-muted-foreground pt-2 border-t border-border mt-2">
                StillHere alerts your family. In a life-threatening emergency, call 911 (or your local emergency number) first.
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
