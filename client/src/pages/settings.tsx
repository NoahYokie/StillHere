import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { usePermissionHealth, requestLocationPermission, requestNotificationPermission, requestMotionPermissionWrapper, getLocationLabel, isLocationFullyGranted, isPermissionMarkedEnabled, clearPermissionIntent } from "@/lib/permissions";
import { useBackgroundLocationEscalation } from "@/components/background-location-provider";

const timeOptions = [
  { value: "06:00", label: "6:00 AM" },
  { value: "07:00", label: "7:00 AM" },
  { value: "08:00", label: "8:00 AM" },
  { value: "09:00", label: "9:00 AM" },
  { value: "10:00", label: "10:00 AM" },
  { value: "11:00", label: "11:00 AM" },
  { value: "12:00", label: "12:00 PM" },
  { value: "13:00", label: "1:00 PM" },
  { value: "14:00", label: "2:00 PM" },
  { value: "15:00", label: "3:00 PM" },
  { value: "16:00", label: "4:00 PM" },
  { value: "17:00", label: "5:00 PM" },
  { value: "18:00", label: "6:00 PM" },
  { value: "19:00", label: "7:00 PM" },
  { value: "20:00", label: "8:00 PM" },
  { value: "21:00", label: "9:00 PM" },
];
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Clock, AlertCircle, Users, MapPin, Pause, FlaskConical, HelpCircle, Shield, LogOut, Bell, Smartphone, UserPlus, Trash2, GripVertical, Activity, Phone, MessageCircle, Video, Fingerprint, Plus, X, FileText, Car, Gauge, ChevronRight, ChevronUp, ChevronDown, User, CheckCircle2, PhoneOff } from "lucide-react";
import logoPath from "@assets/F0BE7587-0A49-40F7-A9A8-E7C53E58260F_1777863919813.png";
import { BackButton } from "@/components/back-button";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { UserStatus, LocationMode } from "@shared/schema";
import { requestMotionPermission } from "@/lib/fall-detection";
import { format, addHours, addDays, startOfTomorrow, setHours } from "date-fns";

interface ContactEntry {
  id?: string;
  name: string;
  phone: string;
  email: string;
  pausedUntil?: string | Date | null;
  pausedBy?: string | null;
  linkedUserId?: string | null;
}

function SafetyHealthCard() {
  const health = usePermissionHealth();
  const [fixing, setFixing] = useState(false);
  const { toast } = useToast();
  const escalation = useBackgroundLocationEscalation();

  // Phase 1.2: when location is at WhenInUse only, expose a one-tap path
  // to upgrade to Always. Uses the escalation provider so the same modal
  // copy/path is used everywhere.
  const upgradeToAlways = async () => {
    setFixing(true);
    const outcome = await escalation.requestAlwaysForFeature("share_precise");
    health.refresh();
    setFixing(false);
    if (outcome.granted) {
      toast({ title: "Background location enabled" });
    } else if (outcome.blocked) {
      toast({
        title: "Open Settings to allow Always",
        description: "iOS will not show the prompt again. Open Settings > StillHere > Location and choose Always.",
        variant: "destructive",
      });
    }
  };

  const disablePermission = (key: "location" | "notifications" | "motion", label: string) => {
    clearPermissionIntent(key);
    health.refresh();
    toast({
      title: `${label} turned off in StillHere`,
      description: "We've stopped using it. To fully revoke at the OS level, open your phone Settings > StillHere.",
    });
  };

  if (health.loading) return null;

  // Sticky display: if the user has previously enabled a permission through
  // our flow, keep showing it as Enabled even if the OS reports `prompt` on
  // this visit (common on iOS Safari and after page reloads). The display
  // only reverts when the OS explicitly reports `denied` (Blocked).
  const locationOsOk = isLocationFullyGranted(health.location);
  const locationPartial = health.location === "when_in_use";
  const locationStickyOk = (locationOsOk || isPermissionMarkedEnabled("location")) && health.location !== "denied";
  const notifOsOk = health.notifications === "granted";
  const notifStickyOk = (notifOsOk || isPermissionMarkedEnabled("notifications")) && health.notifications !== "denied";
  const motionOsOk = health.motion === "granted";
  const motionStickyOk = (motionOsOk || isPermissionMarkedEnabled("motion")) && health.motion !== "denied";

  const items = [
    {
      key: "location",
      label: "Location",
      ok: locationStickyOk && !locationPartial,
      partial: locationPartial,
      denied: health.location === "denied",
      unknown: health.location === "unknown" && !isPermissionMarkedEnabled("location"),
      description: locationStickyOk && !locationPartial ? "Enabled" : getLocationLabel(health.location),
      fix: async () => { setFixing(true); await requestLocationPermission(); health.refresh(); setFixing(false); },
    },
    {
      key: "notifications",
      label: "Notifications",
      ok: notifStickyOk,
      partial: false,
      denied: health.notifications === "denied",
      unknown: health.notifications === "unknown" && !isPermissionMarkedEnabled("notifications"),
      description: notifStickyOk ? "Enabled" : health.notifications === "denied" ? "Blocked. Update in phone Settings" : "Not enabled",
      fix: async () => { setFixing(true); await requestNotificationPermission(); health.refresh(); setFixing(false); },
    },
    {
      key: "motion",
      label: "Motion detection",
      ok: motionStickyOk,
      partial: false,
      denied: health.motion === "denied",
      unknown: health.motion === "unknown" && !isPermissionMarkedEnabled("motion"),
      description: motionStickyOk ? "Enabled" : health.motion === "unknown" ? "Not available" : "Not enabled",
      fix: async () => { setFixing(true); await requestMotionPermissionWrapper(); health.refresh(); setFixing(false); },
    },
  ];

  return (
    <Card data-testid="card-safety-health">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-sm">Safety Health</h2>
        </div>
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.key} className="flex items-center justify-between py-1.5" data-testid={`health-${item.key}`}>
              <div className="flex items-center gap-2">
                {item.ok ? (
                  <div className="h-5 w-5 flex items-center justify-center">
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  </div>
                ) : item.partial ? (
                  <div className="h-5 w-5 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                    <AlertCircle className="h-3 w-3 text-amber-500" />
                  </div>
                ) : item.unknown ? (
                  <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center">
                    <HelpCircle className="h-3 w-3 text-muted-foreground" />
                  </div>
                ) : (
                  <div className="h-5 w-5 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                    <AlertCircle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className={`text-[11px] ${item.ok ? "text-green-600 dark:text-green-400" : item.unknown ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>
                    {item.description}
                  </p>
                </div>
              </div>
              {(!item.ok || item.partial) && !item.denied && !item.unknown && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={item.partial && item.key === "location" ? upgradeToAlways : item.fix}
                  disabled={fixing}
                  data-testid={`button-fix-${item.key}`}
                >
                  {item.partial ? (item.key === "location" ? "Upgrade to Always" : "Update") : "Enable"}
                </Button>
              )}
              {item.ok && !item.partial && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => disablePermission(item.key as any, item.label)}
                  data-testid={`button-disable-${item.key}`}
                >
                  Disable
                </Button>
              )}
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          Once enabled, your permissions stay on until you change them in your phone Settings.
        </p>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showTestConfirm, setShowTestConfirm] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [checkinInterval, setCheckinInterval] = useState(24);
  const [preferredTime, setPreferredTime] = useState("09:00");
  const [graceMinutes, setGraceMinutes] = useState(15);
  const [locationMode, setLocationMode] = useState<LocationMode>("off");
  const [autoCheckin, setAutoCheckin] = useState(false);
  const [fallDetection, setFallDetection] = useState(false);
  const [discreetSos, setDiscreetSos] = useState(false);
  const [smsCheckinEnabled, setSmsCheckinEnabled] = useState(false);
  const [drivingSafety, setDrivingSafety] = useState(false);
  const [speedLimitKmh, setSpeedLimitKmh] = useState(120);
  const [allowReports, setAllowReports] = useState(true);
  const [autoWellnessCall, setAutoWellnessCall] = useState(false);
  const [escalationMinutes, setEscalationMinutes] = useState(20);
  const [heartRateMonitoring, setHeartRateMonitoring] = useState(false);
  const [heartRateAlerts, setHeartRateAlerts] = useState(false);
  const [customInterval, setCustomInterval] = useState("");
  const [showCustomInterval, setShowCustomInterval] = useState(false);
  const [customPauseHours, setCustomPauseHours] = useState("");
  const [contactEntries, setContactEntries] = useState<ContactEntry[]>([]);
  const [contactsInitialized, setContactsInitialized] = useState(false);
  const [editingContactIndex, setEditingContactIndex] = useState<number | null>(null);

  const { data: status, isLoading } = useQuery<UserStatus>({
    queryKey: ["/api/status"],
  });

  const { data: removedContacts } = useQuery<{ id: string; name: string; phone: string; softDeletedAt: string }[]>({
    queryKey: ["/api/contacts/removed"],
  });

  const restoreContactMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/restore`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/removed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Contact restored" });
    },
    onError: () => {
      toast({ title: "Failed to restore contact", variant: "destructive" });
    },
  });

  const pauseContactMutation = useMutation({
    mutationFn: async ({ contactId, pauseUntil }: { contactId: string; pauseUntil: Date | null }) => {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/pause`, { pauseUntil });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      if (data?.contact?.id) {
        setContactEntries((entries) => entries.map((entry) => (
          entry.id === data.contact.id
            ? { ...entry, pausedUntil: data.contact.pausedUntil || null, pausedBy: data.contact.pausedBy || null }
            : entry
        )));
      }
      toast({ title: "Contact updated" });
    },
    onError: () => {
      toast({ title: "Could not update contact", variant: "destructive" });
    },
  });

  const removeContactMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/remove`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/removed"] });
      toast({ title: "Contact removed" });
      setEditingContactIndex(null);
    },
    onError: () => {
      toast({ title: "Could not remove contact", variant: "destructive" });
    },
  });

  const resendContactRequestMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/resend-request`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Request link sent" });
    },
    onError: (error: any) => {
      let message = "Please try again.";
      try {
        const jsonStr = error.message.replace(/^\d+:\s*/, "");
        const parsed = JSON.parse(jsonStr);
        if (parsed?.error) message = parsed.error;
      } catch {}
      toast({ title: "Could not resend link", description: message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (status) {
      setCheckinInterval(status.settings?.checkinIntervalHours || 24);
      setPreferredTime((status.settings as any)?.preferredCheckinTime || "09:00");
      setGraceMinutes(status.settings?.graceMinutes || 15);
      setLocationMode(status.settings?.locationMode || "off");
      setAutoCheckin((status.settings as any)?.autoCheckin || false);
      setFallDetection((status.settings as any)?.fallDetection || false);
      setDiscreetSos((status.settings as any)?.discreetSos || false);
      setSmsCheckinEnabled((status.settings as any)?.smsCheckinEnabled || false);
      setDrivingSafety((status.settings as any)?.drivingSafety || false);
      setSpeedLimitKmh((status.settings as any)?.speedLimitKmh || 120);
      setAllowReports((status.settings as any)?.allowReports !== false);
      setAutoWellnessCall((status.settings as any)?.autoWellnessCall || false);
      setEscalationMinutes((status.settings as any)?.escalationMinutes || 20);
      setHeartRateMonitoring((status.user as any)?.heartRateMonitoringEnabled || false);
      setHeartRateAlerts((status.user as any)?.heartRateAlertsEnabled || false);

      if (!contactsInitialized && status.contacts?.length) {
        const sorted = [...status.contacts].sort((a, b) => a.priority - b.priority);
        setContactEntries(sorted.map(c => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          email: (c as any).email || "",
          pausedUntil: (c as any).pausedUntil || null,
          pausedBy: (c as any).pausedBy || null,
          linkedUserId: (c as any).linkedUserId || null,
        })));
        setContactsInitialized(true);
      } else if (!contactsInitialized && (!status.contacts || status.contacts.length === 0)) {
        setContactEntries([{ name: "", phone: "", email: "" }]);
        setContactsInitialized(true);
      }
    }
  }, [status, contactsInitialized]);

  const settingsMutation = useMutation({
    mutationFn: async (data: { checkinIntervalHours?: number; graceMinutes?: number; locationMode?: LocationMode; preferredCheckinTime?: string; autoCheckin?: boolean; fallDetection?: boolean; discreetSos?: boolean; smsCheckinEnabled?: boolean; drivingSafety?: boolean; speedLimitKmh?: number; escalationMinutes?: number; allowReports?: boolean; autoWellnessCall?: boolean }) => {
      return apiRequest("POST", "/api/settings", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Settings saved" });
    },
    onError: () => {
      toast({ title: "Error saving settings", variant: "destructive" });
    },
  });

  // Heart-rate opt-in mutation. Lives separate from settingsMutation because
  // the flags live on the `users` table (not `settings`) for App Store
  // Privacy Nutrition Label clarity, and because flipping monitoring off
  // must server-side also force alerts off (handled in storage).
  const heartRateConfigMutation = useMutation({
    mutationFn: async (data: { monitoring?: boolean; alerts?: boolean }) => {
      return apiRequest("POST", "/api/heartrate/config", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Heart rate settings saved" });
    },
    onError: () => {
      toast({ title: "Could not save heart rate settings", variant: "destructive" });
    },
  });

  const contactsMutation = useMutation({
    mutationFn: async (contactsList: ContactEntry[]) => {
      const res = await apiRequest("POST", "/api/contacts", {
        contacts: contactsList.map((c, i) => ({
          name: c.name,
          phone: c.phone,
          email: c.email || null,
          priority: i + 1,
        })),
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      if (Array.isArray(data?.contacts)) {
        const sorted = [...data.contacts].sort((a, b) => a.priority - b.priority);
        setContactEntries(sorted.map((c: any) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          email: c.email || "",
          pausedUntil: c.pausedUntil || null,
          pausedBy: c.pausedBy || null,
          linkedUserId: c.linkedUserId || null,
        })));
      }
      toast({ title: "Contacts saved" });
      setEditingContactIndex(null);
    },
    onError: async (error: any) => {
      let message = "Please try again.";
      try {
        if (error?.response && typeof error.response.json === "function") {
          const body = await error.response.json();
          if (body?.error) message = body.error;
        } else if (typeof error?.message === "string") {
          const m = error.message.match(/\{.*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            if (parsed?.error) message = parsed.error;
          } else if (error.message) {
            message = error.message;
          }
        }
      } catch {}
      toast({ title: "Couldn't save contacts", description: message, variant: "destructive" });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async (pauseUntil: Date | null) => {
      return apiRequest("POST", "/api/settings/pause", { pauseUntil });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Alerts paused" });
    },
    onError: () => {
      toast({ title: "Error", variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/test", {});
    },
    onSuccess: () => {
      toast({ title: "Test sent! Your contacts will receive a test notification." });
    },
    onError: () => {
      toast({ title: "Error", variant: "destructive" });
    },
  });

  const rotateTokensMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/safety-circle/rotate-tokens", {});
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Watcher links refreshed",
        description: `${data?.rotated ?? 0} fresh links will reach your circle on the next alert. Old links no longer work.`,
      });
    },
    onError: () => {
      toast({ title: "Could not refresh links", variant: "destructive" });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.clear();
      setLocation("/auth");
    },
  });

  const deleteAccountMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/account");
      return res.json() as Promise<{ success: boolean; processorWarnings?: string[] }>;
    },
    onSuccess: (data) => {
      queryClient.clear();
      const warnings = data?.processorWarnings ?? [];
      if (warnings.length > 0) {
        toast({
          title: "Account deleted",
          description: `We will keep retrying cleanup for: ${warnings.join(", ")}.`,
        });
      } else {
        toast({ title: "Account deleted" });
      }
      setLocation("/auth");
    },
    onError: () => {
      toast({
        title: "Could not delete account",
        description: "Something went wrong. Please try again or contact support.",
        variant: "destructive",
      });
    },
  });

  const passkeysQuery = useQuery<any[]>({
    queryKey: ["/api/auth/passkeys"],
    queryFn: async () => {
      const res = await fetch("/api/auth/passkeys", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const registerPasskeyMutation = useMutation({
    mutationFn: async () => {
      const optionsRes = await fetch("/api/auth/passkey/register-options", {
        method: "POST",
        credentials: "include",
      });
      const options = await optionsRes.json();
      const credential = await startRegistration(options);
      await apiRequest("POST", "/api/auth/passkey/register-verify", credential);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/passkeys"] });
      toast({ title: "Biometric sign-in added!" });
    },
    onError: (error: any) => {
      if (error?.name !== "NotAllowedError") {
        toast({ title: "Failed to set up biometric sign-in", variant: "destructive" });
      }
    },
  });

  const deletePasskeyMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/auth/passkey/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/passkeys"] });
      toast({ title: "Passkey removed" });
    },
  });

  const handleIntervalChange = (value: string) => {
    const hours = parseInt(value);
    if (isNaN(hours) || hours < 24) return;
    setCheckinInterval(hours);
    settingsMutation.mutate({ checkinIntervalHours: hours });
  };

  const handleGraceChange = (value: string) => {
    const mins = parseInt(value);
    setGraceMinutes(mins);
    settingsMutation.mutate({ graceMinutes: mins });
  };

  const handleLocationModeChange = (mode: LocationMode) => {
    setLocationMode(mode);
    settingsMutation.mutate({ locationMode: mode });
  };

  const handlePause = (hoursOrLabel: number | "tomorrow") => {
    let pauseUntil: Date;
    if (hoursOrLabel === "tomorrow") {
      pauseUntil = setHours(startOfTomorrow(), 7);
    } else {
      pauseUntil = addHours(new Date(), hoursOrLabel);
    }
    pauseMutation.mutate(pauseUntil);
  };

  const handleResume = () => {
    pauseMutation.mutate(null);
  };

  const contactLimit = status?.contactLimit ?? 2;
  const hasUnlimitedContacts = contactLimit >= 999;
  const trialEndsAt = status?.trialEndsAt ? new Date(status.trialEndsAt) : null;
  const isContactPaused = (contact: ContactEntry) =>
    !!contact.pausedUntil && new Date(contact.pausedUntil).getTime() > Date.now();
  const pauseContact = (contact: ContactEntry, pauseUntil: Date | null) => {
    if (!contact.id) {
      toast({ title: "Save this contact first", description: "Pause is available after the contact is saved." });
      return;
    }
    pauseContactMutation.mutate({ contactId: contact.id, pauseUntil });
  };

  const addContactEntry = () => {
    if (contactEntries.length >= contactLimit) return;
    const newEntries = [...contactEntries, { name: "", phone: "", email: "", pausedUntil: null, pausedBy: null }];
    setContactEntries(newEntries);
    setEditingContactIndex(newEntries.length - 1);
  };

  const removeContactEntry = (index: number) => {
    const contact = contactEntries[index];
    if (contactEntries.length <= 1 && !contact.id) return;
    if (contact.id) {
      removeContactMutation.mutate(contact.id);
    }
    const nextEntries = contactEntries.filter((_, i) => i !== index);
    setContactEntries(nextEntries.length > 0 ? nextEntries : [{ name: "", phone: "", email: "", pausedUntil: null, pausedBy: null }]);
    setEditingContactIndex(null);
  };

  const updateContactEntry = (index: number, field: keyof ContactEntry, value: string) => {
    const updated = [...contactEntries];
    updated[index] = { ...updated[index], [field]: value };
    setContactEntries(updated);
  };

  const moveContactEntry = (from: number, to: number) => {
    if (to < 0 || to >= contactEntries.length) return;
    const updated = [...contactEntries];
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    setContactEntries(updated);
  };

  const saveContacts = () => {
    const valid = contactEntries.filter(c => c.name.trim() && c.phone.trim());
    if (valid.length === 0) {
      toast({ title: "Error", description: "At least one contact is required.", variant: "destructive" });
      return;
    }
    contactsMutation.mutate(valid);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  const isPaused = status?.settings?.pauseUntil && new Date(status.settings.pauseUntil) > new Date();

  return (
    <div className="min-h-screen bg-background pb-12">
      <header className="bg-primary text-primary-foreground px-6 py-4 sticky top-0 z-10">
        <div className="max-w-md mx-auto flex items-center gap-4">
          <BackButton to="/" tone="onPrimary" />
          <div className="flex items-center gap-2">
            <img src={logoPath} alt="StillHere" className="h-7 w-7 object-contain" />
            <h1 className="text-xl font-semibold" data-testid="text-settings-title">Settings</h1>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-4 space-y-3">
        {/* Emergency Contacts  -  Always visible, compact */}
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                <h2 className="font-semibold">Emergency Contacts</h2>
              </div>
              <span className="text-xs text-muted-foreground">
                {contactEntries.filter(c => c.name.trim()).length}/{hasUnlimitedContacts ? "unlimited" : contactLimit}
              </span>
            </div>
            {status?.isTrialActive ? (
              <p className="text-xs text-muted-foreground mb-2">
                14-day trial active{trialEndsAt ? ` until ${trialEndsAt.toLocaleDateString()}` : ""}. Unlimited contacts while you test StillHere.
              </p>
            ) : status?.isPremium ? (
              <p className="text-xs text-muted-foreground mb-2">Subscription active. Unlimited Safety Circle contacts.</p>
            ) : (
              <p className="text-xs text-muted-foreground mb-2">
                Trial ended. Choose monthly or yearly to add more than {contactLimit} contacts.
              </p>
            )}
            <div className="space-y-2">
              {contactEntries.map((contact, index) => {
                const savedContact = status?.contacts?.find(c => c.priority === index + 1);
                const linkedUserId = contact.linkedUserId || savedContact?.linkedUserId;
                const isEditing = editingContactIndex === index;
                const hasData = contact.name.trim() || contact.phone.trim();
                const paused = isContactPaused(contact);
                const pausedUntil = paused ? new Date(contact.pausedUntil!) : null;

                return (
                  <div key={index} className="rounded-lg border bg-card" data-testid={`contact-row-${index}`}>
                    {!isEditing && hasData ? (
                      <div className="flex items-center gap-2 px-3 py-2.5" data-testid={`row-contact-${index}`}>
                        <div className="flex flex-col items-center shrink-0">
                          {index > 0 && (
                            <button
                              type="button"
                              className="h-4 w-5 flex items-center justify-center text-muted-foreground hover:text-primary"
                              onClick={(e) => { e.stopPropagation(); moveContactEntry(index, index - 1); }}
                              aria-label="Move up"
                              data-testid={`button-move-up-collapsed-${index}`}
                            >
                              <ChevronUp className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {index < contactEntries.length - 1 && (
                            <button
                              type="button"
                              className="h-4 w-5 flex items-center justify-center text-muted-foreground hover:text-primary"
                              onClick={(e) => { e.stopPropagation(); moveContactEntry(index, index + 1); }}
                              aria-label="Move down"
                              data-testid={`button-move-down-collapsed-${index}`}
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <div
                          className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
                          onClick={() => setEditingContactIndex(index)}
                          data-testid={`button-edit-contact-${index}`}
                        >
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <span className="text-xs font-bold text-primary">{index + 1}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{contact.name || "Unnamed"}</p>
                            <p className="text-xs text-muted-foreground truncate">{contact.phone}</p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[10px] bg-primary/10 text-primary rounded-full px-2 py-0.5 capitalize" data-testid={`badge-role-${index}`}>
                              {index === 0 ? "Primary" : index === 1 ? "Backup" : "Support"}
                            </span>
                            {paused && (
                              <span className="text-[10px] bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full px-2 py-0.5" data-testid={`badge-contact-paused-${index}`}>
                                Paused
                              </span>
                            )}
                            {linkedUserId ? (
                              <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full px-2 py-0.5" data-testid={`badge-on-stillhere-${index}`}>
                                On StillHere
                              </span>
                            ) : savedContact ? (
                              <span className="text-[10px] bg-muted text-muted-foreground rounded-full px-2 py-0.5" data-testid={`badge-sms-only-${index}`}>
                                SMS only
                              </span>
                            ) : null}
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-medium text-muted-foreground">
                            {index === 0 ? "Primary Guardian" : index === 1 ? "Backup Guardian" : "Support"}
                          </Label>
                          <div className="flex items-center gap-1">
                            {contactEntries.length > 1 && index > 0 && (
                              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => moveContactEntry(index, index - 1)} data-testid={`button-move-up-${index}`}>
                                <ChevronUp className="h-3 w-3" />
                              </Button>
                            )}
                            {contactEntries.length > 1 && index < contactEntries.length - 1 && (
                              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => moveContactEntry(index, index + 1)} data-testid={`button-move-down-${index}`}>
                                <ChevronDown className="h-3 w-3" />
                              </Button>
                            )}
                            {contactEntries.length > 1 && (
                              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => removeContactEntry(index)} data-testid={`button-remove-contact-${index}`}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                            {hasData && (
                              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setEditingContactIndex(null)} data-testid={`button-collapse-contact-${index}`}>
                                <X className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        </div>
                        <Input placeholder="Name" value={contact.name} onChange={(e) => updateContactEntry(index, "name", e.target.value)} className="h-9 text-sm" data-testid={`input-contact-name-${index}`} />
                        <Input placeholder="Mobile number" type="tel" value={contact.phone} onChange={(e) => updateContactEntry(index, "phone", e.target.value)} className="h-9 text-sm" data-testid={`input-contact-phone-${index}`} />
                        <Input placeholder="Email (optional)" type="email" value={contact.email} onChange={(e) => updateContactEntry(index, "email", e.target.value)} className="h-9 text-sm" data-testid={`input-contact-email-${index}`} />
                        {savedContact && (
                          <div className="rounded-lg border bg-muted/30 p-2.5 space-y-2" data-testid={`contact-state-${index}`}>
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-xs font-medium">{paused ? "Paused" : "Active"}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  {pausedUntil
                                    ? `Skipped during alerts until ${format(pausedUntil, "MMM d, h:mm a")}`
                                    : "Will receive Safety Circle alerts when needed"}
                                </p>
                              </div>
                              {paused ? (
                                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => pauseContact(contact, null)} disabled={pauseContactMutation.isPending} data-testid={`button-resume-contact-${index}`}>
                                  Resume alerts
                                </Button>
                              ) : (
                                <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full px-2 py-0.5">Active</span>
                              )}
                            </div>
                            {!paused && (
                              <div className="grid grid-cols-2 gap-1.5">
                                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => pauseContact(contact, addHours(new Date(), 2))} disabled={pauseContactMutation.isPending} data-testid={`button-pause-contact-2h-${index}`}>
                                  Pause for 2 hours
                                </Button>
                                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => pauseContact(contact, setHours(startOfTomorrow(), 7))} disabled={pauseContactMutation.isPending} data-testid={`button-pause-contact-tomorrow-${index}`}>
                                  Pause until morning
                                </Button>
                              </div>
                            )}
                            <Button type="button" variant="ghost" size="sm" className="h-7 w-full text-xs justify-start text-destructive hover:text-destructive" onClick={() => removeContactEntry(index)} disabled={removeContactMutation.isPending} data-testid={`button-remove-saved-contact-${index}`}>
                              <Trash2 className="h-3 w-3 mr-1.5" /> Remove from Safety Circle
                            </Button>
                            <Button type="button" variant="outline" size="sm" className="h-7 w-full text-xs justify-start" onClick={() => savedContact?.id && resendContactRequestMutation.mutate(savedContact.id)} disabled={resendContactRequestMutation.isPending} data-testid={`button-resend-contact-link-${index}`}>
                              <MessageCircle className="h-3 w-3 mr-1.5" /> Resend request link
                            </Button>
                          </div>
                        )}
                        {savedContact && linkedUserId && (
                          <div className="flex gap-2 pt-1">
                            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs flex-1" onClick={() => setLocation(`/chat/${linkedUserId}`)} data-testid={`button-message-contact-${index}`}>
                              <MessageCircle className="h-3 w-3" /> Message
                            </Button>
                            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs flex-1" onClick={() => setLocation(`/call/${linkedUserId}`)} data-testid={`button-video-contact-${index}`}>
                              <Video className="h-3 w-3" /> Call
                            </Button>
                          </div>
                        )}
                        {savedContact && !linkedUserId && (
                          <div className="pt-1">
                            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => window.open(`tel:${contact.phone}`, "_self")} data-testid={`button-call-contact-${index}`}>
                              <Phone className="h-3 w-3" /> Call
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2 mt-3">
              {contactEntries.length < contactLimit && (
                <Button type="button" variant="outline" size="sm" className="flex-1 h-8 text-xs" onClick={addContactEntry} data-testid="button-add-contact">
                  <UserPlus className="h-3.5 w-3.5 mr-1.5" /> Add contact
                </Button>
              )}
              <Button size="sm" className="flex-1 h-8 text-xs" onClick={saveContacts} disabled={contactsMutation.isPending} data-testid="button-save-contacts">
                {contactsMutation.isPending ? "Saving..." : "Save contacts"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {removedContacts && removedContacts.length > 0 && (
          <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20">
            <CardContent className="py-3">
              <div className="flex items-start gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs font-medium" data-testid="text-removed-contacts-alert">
                  {removedContacts.length === 1 ? "A contact removed themselves" : `${removedContacts.length} contacts removed themselves`}
                </p>
              </div>
              <div className="space-y-1.5">
                {removedContacts.map(rc => {
                  const deletedAt = new Date(rc.softDeletedAt);
                  const expiresAt = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
                  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
                  return (
                    <div key={rc.id} className="flex items-center justify-between bg-background rounded-md px-2.5 py-1.5" data-testid={`removed-contact-${rc.id}`}>
                      <div>
                        <p className="text-xs font-medium">{rc.name}</p>
                        <p className="text-[10px] text-muted-foreground">{daysLeft}d left</p>
                      </div>
                      <Button variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => restoreContactMutation.mutate(rc.id)} disabled={restoreContactMutation.isPending} data-testid={`button-restore-contact-${rc.id}`}>
                        Restore
                      </Button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        <SafetyHealthCard />

        <Card>
          <Accordion type="multiple" defaultValue={["checkin"]} className="px-4">
            {/* Check-in Schedule */}
            <AccordionItem value="checkin" data-testid="section-checkin">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Check-in Schedule</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-5 pt-1">
                {/* Live summary so the user always sees the result of their settings in plain English */}
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3" data-testid="schedule-summary">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                    <div className="text-sm leading-relaxed">
                      <span className="font-medium text-foreground">
                        {checkinInterval === 24 ? "Every day" :
                         checkinInterval === 48 ? "Every 2 days" :
                         checkinInterval === 168 ? "Every week" :
                         `Every ${checkinInterval} hours`}
                      </span>
                      {checkinInterval === 24 && timeOptions.find(t => t.value === preferredTime) && (
                        <span className="text-muted-foreground"> around <span className="font-medium text-foreground">{timeOptions.find(t => t.value === preferredTime)?.label}</span></span>
                      )}
                      <span className="text-muted-foreground">. If you miss it, your safety circle is alerted after </span>
                      <span className="font-medium text-foreground">{graceMinutes} minutes</span>
                      <span className="text-muted-foreground">.</span>
                    </div>
                  </div>
                </div>

                {/* Step 1 — Frequency */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold">1</span>
                    <Label className="text-sm font-semibold text-foreground">How often should we check on you?</Label>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3 ml-7">Pick a rhythm that fits your routine.</p>
                  <RadioGroup
                    value={showCustomInterval || ![24, 48, 168].includes(checkinInterval) ? "custom" : checkinInterval.toString()}
                    onValueChange={(v) => {
                      if (v === "custom") {
                        setShowCustomInterval(true);
                      } else {
                        setShowCustomInterval(false);
                        setCustomInterval("");
                        handleIntervalChange(v);
                      }
                    }}
                    className="space-y-2 ml-7"
                  >
                    <Label htmlFor="daily" className={`flex items-center justify-between rounded-md border p-3 cursor-pointer transition ${checkinInterval === 24 ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`} data-testid="card-frequency-daily">
                      <div className="flex items-center gap-3">
                        <RadioGroupItem value="24" id="daily" data-testid="radio-daily" />
                        <div>
                          <div className="text-sm font-medium">Once a day</div>
                          <div className="text-xs text-muted-foreground">Recommended for most people</div>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">24h</span>
                    </Label>
                    <Label htmlFor="48h" className={`flex items-center justify-between rounded-md border p-3 cursor-pointer transition ${checkinInterval === 48 ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`} data-testid="card-frequency-48h">
                      <div className="flex items-center gap-3">
                        <RadioGroupItem value="48" id="48h" data-testid="radio-48h" />
                        <div>
                          <div className="text-sm font-medium">Every 2 days</div>
                          <div className="text-xs text-muted-foreground">For low-risk routines</div>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">48h</span>
                    </Label>
                    <Label htmlFor="weekly" className={`flex items-center justify-between rounded-md border p-3 cursor-pointer transition ${checkinInterval === 168 ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`} data-testid="card-frequency-weekly">
                      <div className="flex items-center gap-3">
                        <RadioGroupItem value="168" id="weekly" data-testid="radio-weekly" />
                        <div>
                          <div className="text-sm font-medium">Once a week</div>
                          <div className="text-xs text-muted-foreground">Long trips or steady routines</div>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">168h</span>
                    </Label>
                    <Label htmlFor="custom" className={`flex items-center justify-between rounded-md border p-3 cursor-pointer transition ${(showCustomInterval || ![24, 48, 168].includes(checkinInterval)) ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`} data-testid="card-frequency-custom">
                      <div className="flex items-center gap-3">
                        <RadioGroupItem value="custom" id="custom" data-testid="radio-custom" />
                        <div>
                          <div className="text-sm font-medium">Custom</div>
                          <div className="text-xs text-muted-foreground">
                            {![24, 48, 168].includes(checkinInterval) ? `Currently every ${checkinInterval} hours` : "Set your own interval in hours"}
                          </div>
                        </div>
                      </div>
                    </Label>
                  </RadioGroup>
                  {/* Custom input only shows when Custom is selected */}
                  {(showCustomInterval || ![24, 48, 168].includes(checkinInterval)) && (
                    <div className="flex items-center gap-2 mt-2 ml-7" data-testid="custom-interval-input">
                      <Input
                        type="number"
                        min={24}
                        max={720}
                        placeholder={![24, 48, 168].includes(checkinInterval) ? checkinInterval.toString() : "Hours"}
                        value={customInterval}
                        onChange={(e) => setCustomInterval(e.target.value)}
                        className="w-28 h-9 text-sm"
                        data-testid="input-custom-interval"
                      />
                      <Button
                        size="sm"
                        className="h-9"
                        onClick={() => {
                          const hrs = parseInt(customInterval);
                          if (isNaN(hrs) || hrs < 24) return;
                          handleIntervalChange(customInterval);
                          setCustomInterval("");
                          setShowCustomInterval(false);
                        }}
                        disabled={!customInterval || parseInt(customInterval) < 24}
                        data-testid="button-set-custom"
                      >
                        Apply
                      </Button>
                      <span className="text-xs text-muted-foreground">hours between check-ins (minimum 24)</span>
                    </div>
                  )}
                </div>

                {/* Step 2 — Preferred time (only meaningful for daily cadence) */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold">2</span>
                    <Label className="text-sm font-semibold text-foreground">What time of day works best?</Label>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3 ml-7">We'll send your check-in reminder around this time.</p>
                  <div className="ml-7">
                    <Select value={preferredTime} onValueChange={(value) => { setPreferredTime(value); settingsMutation.mutate({ preferredCheckinTime: value }); }}>
                      <SelectTrigger className="w-44 h-9 text-sm" data-testid="select-checkin-time">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {timeOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Step 3 — Grace period */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold">3</span>
                    <Label className="text-sm font-semibold text-foreground">How long should we wait before alerting your circle?</Label>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3 ml-7">If you miss your check-in, we'll wait this long before reaching out to your contacts.</p>
                  <RadioGroup value={graceMinutes.toString()} onValueChange={handleGraceChange} className="grid grid-cols-3 gap-2 ml-7">
                    {[
                      { v: "10", label: "10 min", hint: "Strict" },
                      { v: "15", label: "15 min", hint: "Balanced" },
                      { v: "30", label: "30 min", hint: "Relaxed" },
                    ].map((opt) => (
                      <Label
                        key={opt.v}
                        htmlFor={`grace-${opt.v}`}
                        className={`flex flex-col items-center justify-center rounded-md border p-3 cursor-pointer transition ${graceMinutes.toString() === opt.v ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
                        data-testid={`card-grace-${opt.v}`}
                      >
                        <RadioGroupItem value={opt.v} id={`grace-${opt.v}`} className="sr-only" data-testid={`radio-${opt.v}min`} />
                        <span className="text-sm font-semibold">{opt.label}</span>
                        <span className="text-xs text-muted-foreground mt-0.5">{opt.hint}</span>
                      </Label>
                    ))}
                  </RadioGroup>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Location */}
            <AccordionItem value="location" data-testid="section-location">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Location Sharing</span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <RadioGroup value={locationMode} onValueChange={(value) => handleLocationModeChange(value as LocationMode)} className="space-y-1.5">
                  <div className="flex items-center space-x-3">
                    <RadioGroupItem value="off" id="loc-off" data-testid="radio-location-off" />
                    <Label htmlFor="loc-off" className="text-sm">Off</Label>
                  </div>
                  <div className="flex items-center space-x-3">
                    <RadioGroupItem value="emergency_only" id="loc-emergency" data-testid="radio-location-emergency" />
                    <Label htmlFor="loc-emergency" className="text-sm">Only during emergencies</Label>
                  </div>
                  <div className="flex items-center space-x-3">
                    <RadioGroupItem value="on_shift_only" id="loc-shift" data-testid="radio-location-shift" />
                    <Label htmlFor="loc-shift" className="text-sm">During active checkins</Label>
                  </div>
                  <div className="flex items-center space-x-3">
                    <RadioGroupItem value="both" id="loc-both" data-testid="radio-location-both" />
                    <Label htmlFor="loc-both" className="text-sm">Emergencies and active checkins</Label>
                  </div>
                </RadioGroup>
              </AccordionContent>
            </AccordionItem>

            {/* Safety Features */}
            <AccordionItem value="safety" data-testid="section-safety">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Safety Features</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="auto-checkin" className="text-sm font-medium">Auto check-in</Label>
                    <p className="text-[11px] text-muted-foreground">Check in when you open the app</p>
                  </div>
                  <Switch id="auto-checkin" checked={autoCheckin} onCheckedChange={(checked) => { setAutoCheckin(checked); settingsMutation.mutate({ autoCheckin: checked }); }} data-testid="switch-auto-checkin" />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="fall-detection" className="text-sm font-medium">Fall sensing</Label>
                    <p className="text-[11px] text-muted-foreground">60s countdown before SOS</p>
                  </div>
                  <Switch id="fall-detection" checked={fallDetection} onCheckedChange={async (checked) => {
                    if (checked) {
                      const granted = await requestMotionPermission();
                      if (!granted) { toast({ title: "Motion sensor access denied", variant: "destructive" }); return; }
                    }
                    setFallDetection(checked); settingsMutation.mutate({ fallDetection: checked });
                  }} data-testid="switch-fall-detection" />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="discreet-sos" className="text-sm font-medium">Shake-to-SOS</Label>
                    <p className="text-[11px] text-muted-foreground">Shake phone 3x for silent SOS</p>
                  </div>
                  <Switch id="discreet-sos" checked={discreetSos} onCheckedChange={async (checked) => {
                    if (checked) {
                      const granted = await requestMotionPermission();
                      if (!granted) { toast({ title: "Motion sensor access denied", variant: "destructive" }); return; }
                    }
                    setDiscreetSos(checked); settingsMutation.mutate({ discreetSos: checked });
                  }} data-testid="switch-discreet-sos" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="driving-safety" className="text-sm font-medium">Driving safety</Label>
                      <p className="text-[11px] text-muted-foreground">Speed alerts and possible crash alerts</p>
                    </div>
                    <Switch id="driving-safety" checked={drivingSafety} onCheckedChange={(checked) => { setDrivingSafety(checked); settingsMutation.mutate({ drivingSafety: checked }); }} data-testid="switch-driving-safety" />
                  </div>
                  {drivingSafety && (
                    <div className="ml-1 pl-3 border-l-2 border-primary/20">
                      <Label className="text-xs text-muted-foreground mb-1.5 block">Speed limit</Label>
                      <Select value={String(speedLimitKmh)} onValueChange={(val) => { const v = parseInt(val); setSpeedLimitKmh(v); settingsMutation.mutate({ speedLimitKmh: v }); }}>
                        <SelectTrigger className="w-44 h-8 text-sm" data-testid="select-speed-limit">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="40">40 km/h, school zone</SelectItem>
                          <SelectItem value="50">50 km/h, urban</SelectItem>
                          <SelectItem value="60">60 km/h, city</SelectItem>
                          <SelectItem value="80">80 km/h, suburban</SelectItem>
                          <SelectItem value="100">100 km/h, highway</SelectItem>
                          <SelectItem value="110">110 km/h, freeway</SelectItem>
                          <SelectItem value="120">120 km/h, motorway</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Heart rate (top-level, opt-in for App Store Privacy Nutrition Label) */}
            <AccordionItem value="heart-rate" data-testid="section-heart-rate">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Heart rate</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="pr-3">
                    <Label htmlFor="hr-monitoring" className="text-sm font-medium">Read heart rate from my Apple Watch</Label>
                    <p className="text-[11px] text-muted-foreground">When off, the Watch does not request HealthKit and no readings are saved.</p>
                  </div>
                  <Switch
                    id="hr-monitoring"
                    checked={heartRateMonitoring}
                    disabled={heartRateConfigMutation.isPending}
                    onCheckedChange={(checked) => {
                      setHeartRateMonitoring(checked);
                      if (!checked) setHeartRateAlerts(false);
                      heartRateConfigMutation.mutate({ monitoring: checked });
                    }}
                    data-testid="switch-hr-monitoring"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="pr-3">
                    <Label htmlFor="hr-alerts" className={`text-sm font-medium ${!heartRateMonitoring ? "text-muted-foreground" : ""}`}>Notify my Safety Circle of unusual readings</Label>
                    <p className="text-[11px] text-muted-foreground">Sends an alert above 120 BPM or below 40 BPM.</p>
                  </div>
                  <Switch
                    id="hr-alerts"
                    checked={heartRateAlerts && heartRateMonitoring}
                    disabled={!heartRateMonitoring || heartRateConfigMutation.isPending}
                    onCheckedChange={(checked) => {
                      setHeartRateAlerts(checked);
                      heartRateConfigMutation.mutate({ alerts: checked });
                    }}
                    data-testid="switch-hr-alerts"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed" data-testid="text-hr-disclosure">
                  StillHere is not a medical device, does not diagnose, and does not detect health emergencies. The 120 BPM high and 40 BPM low values are StillHere alert thresholds, not medical thresholds.
                </p>
              </AccordionContent>
            </AccordionItem>

            {/* Notifications & Alerts */}
            <AccordionItem value="notifications" data-testid="section-notifications">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <Bell className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Notifications & Alerts</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4">
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <Label className="text-sm font-medium">Missed check-in flow</Label>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                    If you miss your scheduled check-in, StillHere starts one clear flow: push notification, SMS, wellness call, then your Safety Circle if you still do not respond.
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="sms-checkin" className="text-sm font-medium">SMS check-in</Label>
                    <p className="text-[11px] text-muted-foreground">Reply YES to StillHere texts to check in</p>
                  </div>
                  <Switch id="sms-checkin" checked={smsCheckinEnabled} onCheckedChange={(checked) => { setSmsCheckinEnabled(checked); settingsMutation.mutate({ smsCheckinEnabled: checked }); }} data-testid="switch-sms-checkin" />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="auto-wellness-call" className="text-sm font-medium">Wellness call</Label>
                    <p className="text-[11px] text-muted-foreground">Auto-call if you miss a check-in</p>
                  </div>
                  <Switch id="auto-wellness-call" checked={autoWellnessCall} onCheckedChange={(checked) => { setAutoWellnessCall(checked); settingsMutation.mutate({ autoWellnessCall: checked }); }} data-testid="switch-auto-wellness-call" />
                </div>
                {!autoWellnessCall && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-2.5" data-testid="warning-wellness-call-off">
                    <PhoneOff className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-amber-800 dark:text-amber-300">Phone call escalation is off</p>
                      <p className="text-[11px] text-amber-700/70 dark:text-amber-400/60 mt-0.5">
                        StillHere won't call you if a check-in is missed. Your emergency contacts may still be notified by text and push notification.
                      </p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="allow-reports" className="text-sm font-medium">Safety reports</Label>
                    <p className="text-[11px] text-muted-foreground">Allow watchers to receive reports</p>
                  </div>
                  <Switch id="allow-reports" checked={allowReports} onCheckedChange={(checked) => { setAllowReports(checked); settingsMutation.mutate({ allowReports: checked }); }} data-testid="switch-allow-reports" />
                </div>
                <div>
                  <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Escalation timing</Label>
                  <Select value={String(escalationMinutes)} onValueChange={(val) => { const mins = parseInt(val); setEscalationMinutes(mins); settingsMutation.mutate({ escalationMinutes: mins }); }}>
                    <SelectTrigger className="w-48 h-8 text-sm" data-testid="select-escalation-minutes">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5 minutes</SelectItem>
                      <SelectItem value="10">10 minutes</SelectItem>
                      <SelectItem value="15">15 minutes</SelectItem>
                      <SelectItem value="20">20 minutes (default)</SelectItem>
                      <SelectItem value="30">30 minutes</SelectItem>
                      <SelectItem value="45">45 minutes</SelectItem>
                      <SelectItem value="60">60 minutes</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground mt-1">Wait time before alerting the next contact</p>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Pause Alerts */}
            <AccordionItem value="pause" data-testid="section-pause">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <Pause className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Pause Alerts</span>
                  {isPaused && <span className="text-[10px] bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full px-2 py-0.5 ml-1">Paused</span>}
                </div>
              </AccordionTrigger>
              <AccordionContent>
                {isPaused ? (
                  <div className="space-y-2">
                    <p className="text-sm">Paused until <span className="font-medium">{format(new Date(status!.settings.pauseUntil!), "h:mm a")}</span></p>
                    <Button variant="outline" size="sm" onClick={handleResume} disabled={pauseMutation.isPending} data-testid="button-resume">Resume now</Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handlePause(2)} disabled={pauseMutation.isPending} data-testid="button-pause-2h">2 hours</Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handlePause(6)} disabled={pauseMutation.isPending} data-testid="button-pause-6h">6 hours</Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handlePause("tomorrow")} disabled={pauseMutation.isPending} data-testid="button-pause-tomorrow">Until tomorrow morning</Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input type="number" min="1" max="72" placeholder="Custom hrs" value={customPauseHours} onChange={(e) => setCustomPauseHours(e.target.value)} className="w-24 h-7 text-xs" data-testid="input-custom-pause" />
                      <Button size="sm" className="h-7 text-xs" onClick={() => { const h = parseInt(customPauseHours); if (h >= 1 && h <= 72) { handlePause(h); setCustomPauseHours(""); } }} disabled={pauseMutation.isPending || !customPauseHours} data-testid="button-pause-custom">Pause</Button>
                    </div>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>

            {/* Account & Security */}
            <AccordionItem value="account" className="border-b-0" data-testid="section-account">
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">Account & Security</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {browserSupportsWebAuthn() && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">Biometric sign-in</Label>
                    {passkeysQuery.data && passkeysQuery.data.length > 0 && (
                      <div className="space-y-1.5">
                        {passkeysQuery.data.map((pk: any) => (
                          <div key={pk.id} className="flex items-center justify-between p-2 bg-muted/50 rounded-md" data-testid={`passkey-item-${pk.id}`}>
                            <div className="flex items-center gap-2">
                              <Fingerprint className="h-3.5 w-3.5 text-primary" />
                              <div>
                                <p className="text-xs font-medium">{pk.deviceType === "multiDevice" ? "Synced passkey" : "Device passkey"}</p>
                                <p className="text-[10px] text-muted-foreground">Added {new Date(pk.createdAt).toLocaleDateString()}</p>
                              </div>
                            </div>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => deletePasskeyMutation.mutate(pk.id)} disabled={deletePasskeyMutation.isPending} data-testid={`button-delete-passkey-${pk.id}`}>
                              <Trash2 className="h-3 w-3 text-muted-foreground" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={() => registerPasskeyMutation.mutate()} disabled={registerPasskeyMutation.isPending} data-testid="button-add-passkey">
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                      {registerPasskeyMutation.isPending ? "Setting up..." : "Add biometric sign-in"}
                    </Button>
                  </div>
                )}
                <Button variant="outline" size="sm" className="w-full h-8 text-xs justify-start" onClick={() => setShowTestConfirm(true)} disabled={testMutation.isPending} data-testid="button-run-test">
                  <FlaskConical className="h-3.5 w-3.5 mr-1.5" /> Run a test notification
                </Button>
                <Button variant="outline" size="sm" className="w-full h-8 text-xs justify-start" onClick={() => setShowRotateConfirm(true)} disabled={rotateTokensMutation.isPending} data-testid="button-rotate-watcher-links">
                  <Shield className="h-3.5 w-3.5 mr-1.5" /> {rotateTokensMutation.isPending ? "Refreshing..." : "Refresh all watcher links"}
                </Button>
                <div className="space-y-1.5">
                  <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-start" onClick={() => setLocation("/help")} data-testid="link-help">
                    <HelpCircle className="h-3.5 w-3.5 mr-1.5" /> What happens if...
                  </Button>
                  <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-start" onClick={() => setLocation("/trust")} data-testid="link-trust">
                    <Shield className="h-3.5 w-3.5 mr-1.5" /> Trust & Safety
                  </Button>
                  <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-start" onClick={() => setLocation("/privacy")} data-testid="link-privacy-policy">
                    <FileText className="h-3.5 w-3.5 mr-1.5" /> Privacy Policy
                  </Button>
                  <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-start" onClick={() => setLocation("/terms")} data-testid="link-terms-of-service">
                    <FileText className="h-3.5 w-3.5 mr-1.5" /> Terms of Service
                  </Button>
                </div>
                <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-start text-muted-foreground" onClick={() => logoutMutation.mutate()} data-testid="button-logout">
                  <LogOut className="h-3.5 w-3.5 mr-1.5" /> {logoutMutation.isPending ? "Logging out..." : "Log out"}
                </Button>
                <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-start text-destructive hover:text-destructive" onClick={() => setShowDeleteAccount(true)} data-testid="button-delete-account">
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete Account
                </Button>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </Card>
      </main>

      <AlertDialog open={showRotateConfirm} onOpenChange={setShowRotateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refresh all watcher links?</AlertDialogTitle>
            <AlertDialogDescription>
              Any old links sitting in your watchers' SMS history will stop working. New links go out automatically with your next safety alert. Use this if a phone was lost, a contact left, or you just want a clean slate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-rotate-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { rotateTokensMutation.mutate(); setShowRotateConfirm(false); }} data-testid="button-rotate-confirm">Refresh links</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showTestConfirm} onOpenChange={setShowTestConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send a test message?</AlertDialogTitle>
            <AlertDialogDescription>We will send a test link to your emergency contacts.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-test-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { testMutation.mutate(); setShowTestConfirm(false); }} data-testid="button-test-confirm">Send Test</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showDeleteAccount}
        onOpenChange={(open) => {
          if (deleteAccountMutation.isPending) return;
          setShowDeleteAccount(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your StillHere account?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-left">
              <span className="block">
                This permanently deletes your profile, Safety Circle, check-in history,
                location history, messages, and settings. We will also attempt to cancel
                your StillHere Premium subscription and remove your billing profile from
                our payment processors.
              </span>
              <span className="block">
                Apple, Google, Stripe, RevenueCat, and your bank may keep records of past
                transactions for tax and legal reasons. This is outside our control.
              </span>
              <span className="block">
                You will be signed out of all devices. This cannot be undone.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={deleteAccountMutation.isPending}
              data-testid="button-delete-account-cancel"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAccountMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                deleteAccountMutation.mutate(undefined, {
                  onSettled: () => setShowDeleteAccount(false),
                });
              }}
              data-testid="button-delete-account-confirm"
            >
              {deleteAccountMutation.isPending ? "Deleting account..." : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
