import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Heart,
  MapPin,
  MessageCircle,
  Phone,
  FileText,
  UserPlus,
  Settings as SettingsIcon,
  ShieldCheck,
  AlertTriangle,
  Activity,
  Loader2,
  Trash2,
  PauseCircle,
  PlayCircle,
  Lock,
  Eye,
  StopCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import type { FamilyOverview, FamilyMemberView } from "@shared/schema";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  adult: "Adult",
  teen: "Teen",
  child: "Child",
};

const ROLE_BADGE: Record<string, string> = {
  admin: "bg-primary/15 text-primary",
  adult: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  teen: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  child: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400",
};

const SHARING_LABEL: Record<string, string> = {
  precise: "Precise location",
  area: "Area only",
  presence: "Presence only",
  paused: "Paused",
};

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}

function safetyDisplay(m: FamilyMemberView): { label: string; tone: string; dot: string } {
  if (m.status === "invited") return { label: "Invited", tone: "text-muted-foreground", dot: "bg-muted-foreground/40" };
  if (m.status === "paused") return { label: "Paused", tone: "text-muted-foreground", dot: "bg-muted-foreground/40" };
  if (m.parentalConsentRequired && !m.parentalConsentGranted) {
    return { label: "Parental permission required", tone: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" };
  }
  if (m.hasActiveIncident || m.safetyState === "concern") {
    return { label: "Needs attention", tone: "text-destructive", dot: "bg-destructive animate-pulse" };
  }
  if (m.lastSeenAt) {
    const ageMs = Date.now() - new Date(m.lastSeenAt).getTime();
    const isFresh = ageMs < 5 * 60 * 1000;
    if (m.lastActivity && m.lastActivity !== "stationary" && isFresh) {
      return { label: "Moving", tone: "text-primary", dot: "bg-primary" };
    }
    if (isFresh) return { label: "Safe", tone: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" };
    if (ageMs < 30 * 60 * 1000) return { label: "Stationary", tone: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" };
    return { label: "Quiet", tone: "text-muted-foreground", dot: "bg-muted-foreground/60" };
  }
  return { label: "Not active yet", tone: "text-muted-foreground", dot: "bg-muted-foreground/40" };
}

function humanLastSeen(d: Date | string | null): string {
  if (!d) return "Last seen unknown";
  try {
    return `Last seen ${formatDistanceToNow(new Date(d), { addSuffix: true })}`;
  } catch {
    return "Last seen unknown";
  }
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

  // ---- Mutations ----
  const createFamilyMutation = useMutation({
    mutationFn: async (name: string) => apiRequest("POST", "/api/family", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Family created", description: "You can now invite trusted people." });
      setShowCreate(false);
    },
    onError: () => toast({ title: "Could not create family", variant: "destructive" }),
  });

  const inviteMutation = useMutation({
    mutationFn: async (body: { name: string; phone: string; role: string; parentalConsentRequired: boolean }) =>
      apiRequest("POST", "/api/family/invite", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Invite sent", description: "They'll join your family when they sign up." });
      setShowInvite(false);
      setInviteForm({ name: "", phone: "", role: "adult", parentalConsentRequired: false });
    },
    onError: (e: any) => {
      toast({ title: "Invite failed", description: e?.message || "Try again", variant: "destructive" });
    },
  });

  const updateMemberMutation = useMutation({
    mutationFn: async ({ memberId, updates }: { memberId: string; updates: Record<string, any> }) =>
      apiRequest("PATCH", `/api/family/member/${memberId}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
    },
    onError: (e: any) =>
      toast({ title: "Update failed", description: e?.message || "Try again", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (memberId: string) => apiRequest("DELETE", `/api/family/member/${memberId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      toast({ title: "Member removed" });
    },
    onError: () => toast({ title: "Could not remove member", variant: "destructive" }),
  });

  // "Watch over me while I'm here" — starts a real continuous live-location
  // session for a chosen duration and notifies every family member.
  const [isStartingWatch, setIsStartingWatch] = useState(false);
  const [watchDuration, setWatchDuration] = useState<number>(30);

  // Poll active live-location status so we can show Stop watching when active.
  const { data: liveStatus } = useQuery<{ active: boolean; share: any }>({
    queryKey: ["/api/live-location/status"],
    refetchInterval: 15_000,
  });
  const isWatchActive = !!liveStatus?.active;
  const watchExpiresAt = liveStatus?.share?.expiresAt
    ? new Date(liveStatus.share.expiresAt)
    : null;

  async function handleStartWatch() {
    if (!navigator.geolocation) {
      toast({
        title: "Location unavailable",
        description: "Your device doesn't support GPS.",
        variant: "destructive",
      });
      return;
    }
    setIsStartingWatch(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 30_000,
        }),
      );
      await apiRequest("POST", "/api/family/watch-me/start", {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        durationMinutes: watchDuration,
      });
      // Kick off the continuous GPS pump so the family map keeps updating.
      const { startLiveTracking } = await import("@/lib/live-location");
      startLiveTracking({
        onExpired: () => {
          toast({ title: "Watch session ended", description: "Live location sharing stopped." });
          queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
        },
      });
      toast({
        title: "Family is watching",
        description: `Live location is shared for ${watchDuration} minutes.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
    } catch (err: any) {
      toast({
        title: "Could not start",
        description: err?.code === 1 ? "Location permission denied." : "Try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setIsStartingWatch(false);
    }
  }

  async function handleStopWatch() {
    try {
      const { stopLiveTracking } = await import("@/lib/live-location");
      await stopLiveTracking();
      await apiRequest("POST", "/api/family/watch-me/stop");
      toast({ title: "Stopped sharing", description: "Family no longer sees your live location." });
      queryClient.invalidateQueries({ queryKey: ["/api/family"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
    } catch {
      toast({ title: "Could not stop", variant: "destructive" });
    }
  }

  // ---- Form state ----
  const [showCreate, setShowCreate] = useState(false);
  const [familyName, setFamilyName] = useState("My Family");

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ name: "", phone: "", role: "adult", parentalConsentRequired: false });

  const [manageMember, setManageMember] = useState<FamilyMemberView | null>(null);

  const sharingMembers = members.filter(
    (m) => m.status === "active" && m.sharingMode !== "paused" && m.lastSeenAt,
  );

  // ---- Render ----
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/")}
            data-testid="button-back"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold tracking-tight">Family</h1>
            <p className="text-xs text-muted-foreground truncate">Your trusted safety group.</p>
          </div>
          {isAdmin && family && (
            <Dialog open={showInvite} onOpenChange={setShowInvite}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" data-testid="button-invite-open">
                  <UserPlus className="h-4 w-4 mr-1.5" /> Invite
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Invite a family member</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="invite-name">Name</Label>
                    <Input
                      id="invite-name"
                      value={inviteForm.name}
                      onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })}
                      data-testid="input-invite-name"
                      placeholder="Mum"
                    />
                  </div>
                  <div>
                    <Label htmlFor="invite-phone">Phone</Label>
                    <Input
                      id="invite-phone"
                      value={inviteForm.phone}
                      onChange={(e) => setInviteForm({ ...inviteForm, phone: e.target.value })}
                      data-testid="input-invite-phone"
                      placeholder="+15550001234"
                    />
                  </div>
                  <div>
                    <Label>Role</Label>
                    <Select
                      value={inviteForm.role}
                      onValueChange={(v) =>
                        setInviteForm({
                          ...inviteForm,
                          role: v,
                          parentalConsentRequired: v === "teen" || v === "child",
                        })
                      }
                    >
                      <SelectTrigger data-testid="select-invite-role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="adult">Adult</SelectItem>
                        <SelectItem value="teen">Teen (under 16)</SelectItem>
                        <SelectItem value="child">Child (under 13)</SelectItem>
                      </SelectContent>
                    </Select>
                    {(inviteForm.role === "teen" || inviteForm.role === "child") && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 flex items-start gap-1.5">
                        <Lock className="h-3 w-3 mt-0.5 shrink-0" />
                        Parental permission required before monitoring is enabled.
                      </p>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() =>
                      inviteMutation.mutate({
                        name: inviteForm.name,
                        phone: inviteForm.phone,
                        role: inviteForm.role,
                        parentalConsentRequired: inviteForm.parentalConsentRequired,
                      })
                    }
                    disabled={inviteMutation.isPending || !inviteForm.name || !inviteForm.phone}
                    data-testid="button-invite-submit"
                  >
                    {inviteMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                    Send invite
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </header>

      <main className="max-w-md mx-auto px-5 py-5 space-y-5 pb-24">
        {/* Loading skeleton */}
        {isLoading && (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <Card key={i} className="rounded-2xl">
                <CardContent className="p-4">
                  <div className="animate-pulse flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-1/2 rounded bg-muted" />
                      <div className="h-3 w-1/3 rounded bg-muted" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !family && (
          <section className="text-center py-8" data-testid="section-empty">
            <div className="relative w-28 h-28 mx-auto mb-5">
              <div className="absolute inset-0 rounded-full bg-primary/10 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-primary shadow-lg shadow-primary/30 flex items-center justify-center">
                  <Heart className="h-8 w-8 text-primary-foreground" strokeWidth={2.4} />
                </div>
              </div>
            </div>
            <h2 className="text-xl font-bold tracking-tight" data-testid="text-empty-title">
              Create your Family
            </h2>
            <p className="text-sm text-muted-foreground mt-1.5 px-4">
              Invite the people you trust so everyone can stay safe together.
            </p>
            <Dialog open={showCreate} onOpenChange={setShowCreate}>
              <DialogTrigger asChild>
                <Button className="mt-5" data-testid="button-create-family">
                  <Heart className="h-4 w-4 mr-1.5" /> Create Family
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Name your family</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <Label htmlFor="family-name">Family name</Label>
                  <Input
                    id="family-name"
                    value={familyName}
                    onChange={(e) => setFamilyName(e.target.value)}
                    data-testid="input-family-name"
                  />
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => createFamilyMutation.mutate(familyName)}
                    disabled={createFamilyMutation.isPending || !familyName.trim()}
                    data-testid="button-create-family-submit"
                  >
                    {createFamilyMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                    Create
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </section>
        )}

        {/* Family map preview */}
        {!isLoading && family && (
          <Card className="rounded-2xl overflow-hidden" data-testid="card-map-preview">
            <CardContent className="p-0">
              <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-emerald-100/30 dark:from-primary/20 dark:via-primary/10 dark:to-emerald-950/20 px-4 py-5">
                <div className="flex items-center gap-2 mb-3">
                  <MapPin className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-sm">{family.name}</h3>
                  <span className="ml-auto text-xs text-muted-foreground" data-testid="text-sharing-count">
                    {sharingMembers.length} sharing
                  </span>
                </div>
                {/* "Watch over me while I'm here" — starts a live session */}
                {isWatchActive ? (
                  <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/30 p-3" data-testid="status-watch-active">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                      </span>
                      <p className="text-xs font-medium text-emerald-900 dark:text-emerald-200">
                        Family is watching you live
                        {watchExpiresAt && (
                          <> · ends {formatDistanceToNow(watchExpiresAt, { addSuffix: true })}</>
                        )}
                      </p>
                    </div>
                    <Button
                      onClick={handleStopWatch}
                      size="sm"
                      variant="outline"
                      className="w-full h-9"
                      data-testid="button-stop-watch"
                    >
                      <StopCircle className="h-4 w-4 mr-1.5" />
                      Stop sharing
                    </Button>
                  </div>
                ) : (
                  <div className="mb-3 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Headed somewhere? Ask the family to watch over you while you're there.
                    </p>
                    <div className="flex gap-1.5">
                      {[15, 30, 60].map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setWatchDuration(m)}
                          className={`flex-1 text-xs h-7 rounded-md border transition-colors ${
                            watchDuration === m
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background border-border hover:bg-muted"
                          }`}
                          data-testid={`button-duration-${m}`}
                        >
                          {m >= 60 ? `${m / 60} hr` : `${m} min`}
                        </button>
                      ))}
                    </div>
                    <Button
                      onClick={handleStartWatch}
                      disabled={isStartingWatch}
                      size="sm"
                      className="w-full h-9"
                      data-testid="button-watch-over-me"
                    >
                      {isStartingWatch ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      ) : (
                        <Eye className="h-4 w-4 mr-1.5" />
                      )}
                      Watch over me while I'm here
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {sharingMembers.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-3">
                      No one is sharing location right now.
                    </p>
                  ) : (
                    sharingMembers.map((m) => {
                      const safety = safetyDisplay(m);
                      return (
                        <button
                          key={m.id}
                          onClick={() => m.userId && setLocation(`/live-location/${m.userId}`)}
                          className="flex items-center gap-1.5 bg-card/80 backdrop-blur rounded-full pl-1 pr-3 py-1 hover-elevate"
                          data-testid={`pill-map-member-${m.id}`}
                        >
                          <span className="w-6 h-6 rounded-full bg-primary/15 text-primary text-[10px] font-semibold flex items-center justify-center">
                            {initials(m.name)}
                          </span>
                          <span className="text-xs font-medium truncate max-w-[80px]">{m.name}</span>
                          <span className={`w-1.5 h-1.5 rounded-full ${safety.dot}`} />
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Member cards */}
        {!isLoading && family && (
          <section className="space-y-3" data-testid="section-members">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider px-1">
              Family members
            </h2>
            {members.map((m) => {
              const safety = safetyDisplay(m);
              const isSelf = m.userId === myUserId;
              return (
                <Card key={m.id} className="rounded-2xl" data-testid={`card-member-${m.id}`}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="relative shrink-0">
                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 text-primary text-sm font-semibold flex items-center justify-center">
                          {initials(m.name)}
                        </div>
                        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-card ${safety.dot}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold truncate" data-testid={`text-member-name-${m.id}`}>
                            {m.name}
                          </p>
                          <span
                            className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${ROLE_BADGE[m.role] || ROLE_BADGE.adult}`}
                            data-testid={`badge-member-role-${m.id}`}
                          >
                            {ROLE_LABEL[m.role] || m.role}
                          </span>
                        </div>
                        <p className={`text-xs ${safety.tone} font-medium`} data-testid={`text-member-status-${m.id}`}>
                          {safety.label}
                        </p>
                        {m.status === "invited" ? (
                          <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-member-invited-hint-${m.id}`}>
                            Waiting for them to join
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {humanLastSeen(m.lastSeenAt)} · {SHARING_LABEL[m.sharingMode] || m.sharingMode}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Quick actions */}
                    {m.userId && !isSelf && (
                      <div className="grid grid-cols-4 gap-1.5 pt-1">
                        <button
                          onClick={() => setLocation(`/live-location/${m.userId}`)}
                          className="flex flex-col items-center gap-1 py-2 rounded-lg hover-elevate"
                          data-testid={`button-member-map-${m.id}`}
                        >
                          <MapPin className="h-4 w-4 text-primary" />
                          <span className="text-[10px] font-medium">Map</span>
                        </button>
                        <button
                          onClick={() => setLocation(`/chat/${m.userId}`)}
                          className="flex flex-col items-center gap-1 py-2 rounded-lg hover-elevate"
                          data-testid={`button-member-message-${m.id}`}
                        >
                          <MessageCircle className="h-4 w-4 text-primary" />
                          <span className="text-[10px] font-medium">Message</span>
                        </button>
                        <a
                          href={m.phone ? `tel:${m.phone}` : undefined}
                          className={`flex flex-col items-center gap-1 py-2 rounded-lg hover-elevate ${!m.phone ? "opacity-40 pointer-events-none" : ""}`}
                          data-testid={`button-member-call-${m.id}`}
                        >
                          <Phone className="h-4 w-4 text-emerald-600" />
                          <span className="text-[10px] font-medium">Call</span>
                        </a>
                        <button
                          onClick={() => setLocation(`/report/${m.userId}`)}
                          className="flex flex-col items-center gap-1 py-2 rounded-lg hover-elevate"
                          data-testid={`button-member-report-${m.id}`}
                        >
                          <FileText className="h-4 w-4 text-primary" />
                          <span className="text-[10px] font-medium">Report</span>
                        </button>
                      </div>
                    )}

                    {/* Self: own sharing mode controls */}
                    {isSelf && !m.isAdmin && (
                      <div className="pt-1">
                        <Label className="text-xs text-muted-foreground">Your sharing mode</Label>
                        <Select
                          value={m.sharingMode}
                          onValueChange={(v) =>
                            updateMemberMutation.mutate({ memberId: m.id, updates: { sharingMode: v } })
                          }
                        >
                          <SelectTrigger className="mt-1 h-9" data-testid={`select-self-sharing-${m.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="precise">Precise location</SelectItem>
                            <SelectItem value="area">Area only</SelectItem>
                            <SelectItem value="presence">Presence only</SelectItem>
                            <SelectItem value="paused">Paused</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Admin controls */}
                    {isAdmin && !m.isAdmin && (
                      <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/60 mt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          onClick={() => setManageMember(m)}
                          data-testid={`button-manage-${m.id}`}
                        >
                          <SettingsIcon className="h-3 w-3 mr-1" /> Manage
                        </Button>
                        {m.status === "paused" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() =>
                              updateMemberMutation.mutate({ memberId: m.id, updates: { status: "active" } })
                            }
                            data-testid={`button-resume-${m.id}`}
                          >
                            <PlayCircle className="h-3 w-3 mr-1" /> Resume
                          </Button>
                        ) : m.status === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() =>
                              updateMemberMutation.mutate({ memberId: m.id, updates: { status: "paused" } })
                            }
                            data-testid={`button-pause-${m.id}`}
                          >
                            <PauseCircle className="h-3 w-3 mr-1" /> Pause
                          </Button>
                        ) : null}
                        {m.parentalConsentRequired && !m.parentalConsentGranted && (
                          <Button
                            size="sm"
                            className="h-7 text-[11px]"
                            onClick={() =>
                              updateMemberMutation.mutate({
                                memberId: m.id,
                                updates: { parentalConsentGranted: true },
                              })
                            }
                            data-testid={`button-grant-consent-${m.id}`}
                          >
                            <ShieldCheck className="h-3 w-3 mr-1" /> Grant permission
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-[11px] text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            if (confirm(`Remove ${m.name} from your family?`)) {
                              removeMutation.mutate(m.id);
                            }
                          }}
                          data-testid={`button-remove-${m.id}`}
                        >
                          <Trash2 className="h-3 w-3 mr-1" /> Remove
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </section>
        )}

        {/* Family activity feed */}
        {!isLoading && family && (
          <section className="space-y-3" data-testid="section-activity">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider px-1">
              Family updates
            </h2>
            <Card className="rounded-2xl">
              <CardContent className="p-4 space-y-3">
                {(() => {
                  const updates = members
                    .filter((m) => m.status === "active" && m.lastSeenAt)
                    .map((m) => {
                      const safety = safetyDisplay(m);
                      let icon = <Activity className="h-3.5 w-3.5 text-primary" />;
                      let line = `${m.name} ${safety.label.toLowerCase()}.`;
                      if (safety.label === "Needs attention") {
                        icon = <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
                        line = `${m.name} needs attention.`;
                      } else if (safety.label === "Quiet") {
                        line = `${m.name}'s phone has been quiet.`;
                      } else if (safety.label === "Safe" || safety.label === "Stationary") {
                        line = `${m.name} is safe.`;
                      } else if (safety.label === "Moving") {
                        line = `${m.name} is moving.`;
                      }
                      return { id: m.id, icon, line, when: m.lastSeenAt };
                    });
                  if (updates.length === 0) {
                    return <p className="text-xs text-muted-foreground">No safety updates yet.</p>;
                  }
                  return updates.map((u) => (
                    <div key={u.id} className="flex items-start gap-2.5" data-testid={`activity-${u.id}`}>
                      <div className="mt-0.5">{u.icon}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">{u.line}</p>
                        <p className="text-xs text-muted-foreground">
                          {u.when ? formatDistanceToNow(new Date(u.when), { addSuffix: true }) : ""}
                        </p>
                      </div>
                    </div>
                  ));
                })()}
              </CardContent>
            </Card>
          </section>
        )}

        {/* Privacy reassurance */}
        {!isLoading && family && (
          <Card className="rounded-2xl border-primary/20 bg-primary/5" data-testid="card-privacy">
            <CardContent className="p-4 flex gap-3">
              <ShieldCheck className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="text-xs text-foreground/80 leading-relaxed">
                <p className="font-semibold text-foreground mb-1">Family is for safety, not surveillance.</p>
                <p>
                  StillHere never tracks app usage, browser history, or device activity. Each adult controls their
                  own sharing mode. Under-16 members need a guardian's permission first.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Manage member dialog (admin) */}
      <Dialog open={!!manageMember} onOpenChange={(o) => !o && setManageMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage {manageMember?.name}</DialogTitle>
          </DialogHeader>
          {manageMember && (
            <div className="space-y-4">
              <div>
                <Label>Role</Label>
                <Select
                  value={manageMember.role}
                  onValueChange={(v) => {
                    updateMemberMutation.mutate({ memberId: manageMember.id, updates: { role: v } });
                    setManageMember({ ...manageMember, role: v as any });
                  }}
                >
                  <SelectTrigger data-testid="select-manage-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="adult">Adult</SelectItem>
                    <SelectItem value="teen">Teen (under 16)</SelectItem>
                    <SelectItem value="child">Child (under 13)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(manageMember.role === "teen" || manageMember.role === "child") && (
                <div>
                  <Label>Sharing mode (under-16)</Label>
                  <Select
                    value={manageMember.sharingMode}
                    onValueChange={(v) => {
                      updateMemberMutation.mutate({ memberId: manageMember.id, updates: { sharingMode: v } });
                      setManageMember({ ...manageMember, sharingMode: v as any });
                    }}
                  >
                    <SelectTrigger data-testid="select-manage-sharing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="precise">Precise location</SelectItem>
                      <SelectItem value="area">Area only</SelectItem>
                      <SelectItem value="presence">Presence only</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Adults control their own privacy settings. As admin you cannot override an adult's sharing mode.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setManageMember(null)} data-testid="button-manage-close">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
