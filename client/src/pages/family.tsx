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
  ArrowLeft, Heart, MapPin, MessageCircle, UserPlus, Loader2, Send,
  ShieldCheck, Activity, AlertTriangle, Eye, LogOut, Trash2, Users,
  Sparkles, Battery, Car, Settings as SettingsIcon, Crown,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import GoogleMap, { type MapPerson } from "@/components/google-map";
import type { FamilyOverview, FamilyMemberView, FamilyMessage } from "@shared/schema";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin", adult: "Adult", teen: "Teen", child: "Child",
};

function initials(name: string): string {
  return (
    name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || "").join("") || "?"
  );
}

function safetyTone(m: FamilyMemberView): { label: string; dot: string; tone: string } {
  if (m.status === "invited") return { label: "Invited", dot: "bg-muted-foreground/40", tone: "text-muted-foreground" };
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Invite sent", description: "They'll get an SMS to join." });
      setShowInvite(false);
      setInviteForm({ name: "", phone: "", role: "adult" });
    },
    onError: (e: any) =>
      toast({ title: "Invite failed", description: e?.message || "Try again", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (memberId: string) => apiRequest("DELETE", `/api/family/member/${memberId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Removed" });
    },
    onError: () => toast({ title: "Could not remove", variant: "destructive" }),
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
  const mapPeople: MapPerson[] = useMemo(() => {
    return members
      .filter((m) => m.lastLat != null && m.lastLng != null && m.status === "active")
      .map((m) => ({
        id: m.id,
        name: m.name + (m.userId === myUserId ? " (You)" : ""),
        lat: m.lastLat as number,
        lng: m.lastLng as number,
        safetyState: (m.safetyState as any) || "active",
        activity: (m.lastActivity as any) || "stationary",
        isMe: m.userId === myUserId,
      }));
  }, [members, myUserId]);

  // Center on the first person with a location, fall back to a neutral point.
  const mapCenter = useMemo(() => {
    if (mapPeople.length > 0) return { lat: mapPeople[0].lat, lng: mapPeople[0].lng };
    return { lat: 0, lng: 0 };
  }, [mapPeople]);

  // ============ RENDER ============
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // No family yet - simple create screen
  if (!family) {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-10 bg-card/80 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/home")} data-testid="button-back">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-lg font-bold">Family</h1>
        </header>
        <div className="px-4 py-8 max-w-md mx-auto">
          <Card>
            <CardContent className="p-6 space-y-4 text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 mx-auto flex items-center justify-center">
                <Users className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Create your family</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Watch over each other. Map, chat, and one-tap safety pings - all in one place.
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
        <Button variant="ghost" size="icon" onClick={() => setLocation("/home")} data-testid="button-back">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate" data-testid="text-family-name">{family.name}</h1>
          <p className="text-xs text-muted-foreground">
            {members.filter((m) => m.status === "active").length} members
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
                      <SelectItem value="adult">Adult</SelectItem>
                      <SelectItem value="teen">Teen</SelectItem>
                      <SelectItem value="child">Child</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => inviteMutation.mutate({
                    ...inviteForm,
                    parentalConsentRequired: inviteForm.role === "child" || inviteForm.role === "teen",
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

      {/* MAP - hero of the page */}
      <div className="relative" style={{ height: "55vh", minHeight: 320 }}>
        {mapPeople.length > 0 ? (
          <GoogleMap
            center={mapCenter}
            people={mapPeople}
            smartCamera={true}
            darkMode={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/30">
            <div className="text-center px-6">
              <MapPin className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No live locations yet. Tap <strong>Watch Me</strong> to start sharing.
              </p>
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
        <TabsList className="mx-4 mt-3 grid grid-cols-3">
          <TabsTrigger value="members" data-testid="tab-members">
            <Users className="w-4 h-4 mr-1" /> Members
          </TabsTrigger>
          <TabsTrigger value="chat" data-testid="tab-chat">
            <MessageCircle className="w-4 h-4 mr-1" /> Chat
          </TabsTrigger>
          <TabsTrigger value="safety" data-testid="tab-safety">
            <Sparkles className="w-4 h-4 mr-1" /> Safety
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
                        {m.name}{isMe && <span className="text-muted-foreground text-xs"> (You)</span>}
                      </span>
                      {isMemberAdmin && (
                        <Badge variant="secondary" className="text-[10px] h-4 px-1 gap-0.5">
                          <Crown className="w-2.5 h-2.5" /> Admin
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px] h-4 px-1">
                        {ROLE_LABEL[m.role] || m.role}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                      <span className={`text-xs ${tone.tone}`}>{tone.label}</span>
                      {m.lastSeenAt && m.status === "active" && (
                        <span className="text-xs text-muted-foreground">
                          · {formatDistanceToNow(new Date(m.lastSeenAt), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                  </div>
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

          {/* Admin-only: close the entire family */}
          {isAdmin && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="w-full mt-3 text-destructive border-destructive/30 hover:bg-destructive/10"
                  data-testid="button-close-family">
                  <Trash2 className="w-4 h-4 mr-2" /> Close this family
                </Button>
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
                return (
                  <div key={m.id} className="flex justify-center" data-testid={`message-${m.id}`}>
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
                    <p className="text-muted-foreground text-xs">One-tap "I'm OK" - everyone sees it in chat.</p>
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
                    <strong>Crash &amp; Fall detection</strong>
                    <p className="text-muted-foreground text-xs">Auto-alerts the family if a crash or fall is detected on a member's device.</p>
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
                Each adult controls their own sharing mode. Under-16 members need a guardian's permission first.
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
