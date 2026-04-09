import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
import { ArrowLeft, Clock, AlertCircle, Users, MapPin, Pause, FlaskConical, HelpCircle, Shield, LogOut, Bell, Smartphone, UserPlus, Trash2, GripVertical, Activity, Phone, MessageCircle, Video, Fingerprint, Plus, X, FileText, Car, Gauge } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { UserStatus, LocationMode, ReminderMode } from "@shared/schema";
import { requestMotionPermission } from "@/lib/fall-detection";
import { format, addHours, addDays, startOfTomorrow, setHours } from "date-fns";

interface ContactEntry {
  name: string;
  phone: string;
  email: string;
}

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showTestConfirm, setShowTestConfirm] = useState(false);
  const [checkinInterval, setCheckinInterval] = useState(24);
  const [preferredTime, setPreferredTime] = useState("09:00");
  const [graceMinutes, setGraceMinutes] = useState(15);
  const [locationMode, setLocationMode] = useState<LocationMode>("off");
  const [reminderMode, setReminderMode] = useState<ReminderMode>("one");
  const [autoCheckin, setAutoCheckin] = useState(false);
  const [fallDetection, setFallDetection] = useState(false);
  const [discreetSos, setDiscreetSos] = useState(false);
  const [smsCheckinEnabled, setSmsCheckinEnabled] = useState(false);
  const [drivingSafety, setDrivingSafety] = useState(false);
  const [speedLimitKmh, setSpeedLimitKmh] = useState(120);
  const [allowReports, setAllowReports] = useState(true);
  const [escalationMinutes, setEscalationMinutes] = useState(20);
  const [customInterval, setCustomInterval] = useState("");
  const [customPauseHours, setCustomPauseHours] = useState("");
  const [contactEntries, setContactEntries] = useState<ContactEntry[]>([]);
  const [contactsInitialized, setContactsInitialized] = useState(false);

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

  useEffect(() => {
    if (status) {
      setCheckinInterval(status.settings?.checkinIntervalHours || 24);
      setPreferredTime((status.settings as any)?.preferredCheckinTime || "09:00");
      setGraceMinutes(status.settings?.graceMinutes || 15);
      setLocationMode(status.settings?.locationMode || "off");
      setReminderMode((status.settings as any)?.reminderMode || "one");
      setAutoCheckin((status.settings as any)?.autoCheckin || false);
      setFallDetection((status.settings as any)?.fallDetection || false);
      setDiscreetSos((status.settings as any)?.discreetSos || false);
      setSmsCheckinEnabled((status.settings as any)?.smsCheckinEnabled || false);
      setDrivingSafety((status.settings as any)?.drivingSafety || false);
      setSpeedLimitKmh((status.settings as any)?.speedLimitKmh || 120);
      setAllowReports((status.settings as any)?.allowReports !== false);
      setEscalationMinutes((status.settings as any)?.escalationMinutes || 20);

      if (!contactsInitialized && status.contacts?.length) {
        const sorted = [...status.contacts].sort((a, b) => a.priority - b.priority);
        setContactEntries(sorted.map(c => ({ name: c.name, phone: c.phone, email: (c as any).email || "" })));
        setContactsInitialized(true);
      } else if (!contactsInitialized && (!status.contacts || status.contacts.length === 0)) {
        setContactEntries([{ name: "", phone: "", email: "" }]);
        setContactsInitialized(true);
      }
    }
  }, [status, contactsInitialized]);

  const settingsMutation = useMutation({
    mutationFn: async (data: { checkinIntervalHours?: number; graceMinutes?: number; locationMode?: LocationMode; reminderMode?: ReminderMode; preferredCheckinTime?: string; autoCheckin?: boolean; fallDetection?: boolean; discreetSos?: boolean; smsCheckinEnabled?: boolean; drivingSafety?: boolean; speedLimitKmh?: number; escalationMinutes?: number; allowReports?: boolean }) => {
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

  const contactsMutation = useMutation({
    mutationFn: async (contactsList: ContactEntry[]) => {
      return apiRequest("POST", "/api/contacts", {
        contacts: contactsList.map((c, i) => ({
          name: c.name,
          phone: c.phone,
          email: c.email || null,
          priority: i + 1,
        })),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Contacts saved" });
    },
    onError: () => {
      toast({ title: "Error saving contacts", variant: "destructive" });
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
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Test sent" });
    },
    onError: () => {
      toast({ title: "Error sending test", variant: "destructive" });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: async () => {
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      window.location.href = "/login";
    },
    onError: () => {
      toast({ title: "Error logging out", variant: "destructive" });
    },
  });

  const passkeysQuery = useQuery<any[]>({
    queryKey: ["/api/auth/passkeys"],
    enabled: browserSupportsWebAuthn(),
  });

  const registerPasskeyMutation = useMutation({
    mutationFn: async () => {
      const optionsRes = await fetch("/api/auth/passkey/register-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!optionsRes.ok) throw new Error("Failed to get options");
      const options = await optionsRes.json();

      const regResponse = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(regResponse),
      });
      if (!verifyRes.ok) throw new Error("Failed to register passkey");
      return verifyRes.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/passkeys"] });
      toast({ title: "Biometric sign-in added" });
    },
    onError: (error: Error) => {
      if (error.name === "NotAllowedError") return;
      toast({ title: "Could not set up biometrics", variant: "destructive" });
    },
  });

  const deletePasskeyMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/auth/passkeys/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/passkeys"] });
      toast({ title: "Passkey removed" });
    },
    onError: () => {
      toast({ title: "Error removing passkey", variant: "destructive" });
    },
  });

  const handleIntervalChange = (value: string) => {
    const num = parseInt(value);
    if (!isNaN(num)) {
      setCheckinInterval(num);
      settingsMutation.mutate({ checkinIntervalHours: num });
    }
  };

  const handleGraceChange = (value: string) => {
    const num = parseInt(value);
    if (!isNaN(num)) {
      setGraceMinutes(num);
      settingsMutation.mutate({ graceMinutes: num });
    }
  };

  const handleLocationModeChange = (value: LocationMode) => {
    setLocationMode(value);
    settingsMutation.mutate({ locationMode: value });
  };

  const handleReminderModeChange = (value: ReminderMode) => {
    setReminderMode(value);
    settingsMutation.mutate({ reminderMode: value });
  };

  const handlePause = (hours: number | "tomorrow") => {
    let pauseUntil: Date;
    if (hours === "tomorrow") {
      pauseUntil = setHours(startOfTomorrow(), 8);
    } else {
      pauseUntil = addHours(new Date(), hours);
    }
    pauseMutation.mutate(pauseUntil);
  };

  const handleResume = () => {
    pauseMutation.mutate(null);
  };

  const contactLimit = status?.contactLimit ?? 2;

  const addContactEntry = () => {
    if (contactEntries.length >= contactLimit) return;
    setContactEntries([...contactEntries, { name: "", phone: "", email: "" }]);
  };

  const removeContactEntry = (index: number) => {
    if (contactEntries.length <= 1) return;
    setContactEntries(contactEntries.filter((_, i) => i !== index));
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
      {/* Header */}
      <header className="bg-primary text-primary-foreground px-6 py-4 sticky top-0 z-10">
        <div className="max-w-md mx-auto flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            className="text-primary-foreground"
            onClick={() => setLocation("/")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold" data-testid="text-settings-title">Settings</h1>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-6">
        {/* Checkins Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock className="h-5 w-5" />
              Checkins
            </CardTitle>
            <CardDescription>How often should we check in?</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup
              value={checkinInterval.toString()}
              onValueChange={handleIntervalChange}
              className="space-y-2"
            >
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="24" id="daily" data-testid="radio-daily" />
                <Label htmlFor="daily">Once a day</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="48" id="48h" data-testid="radio-48h" />
                <Label htmlFor="48h">Every 2 days</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="168" id="weekly" data-testid="radio-weekly" />
                <Label htmlFor="weekly">Once a week</Label>
              </div>
            </RadioGroup>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Custom hrs"
                value={customInterval}
                onChange={(e) => setCustomInterval(e.target.value)}
                className="w-28"
                data-testid="input-custom-interval"
              />
              <Button
                size="sm"
                onClick={() => handleIntervalChange(customInterval)}
                disabled={!customInterval}
                data-testid="button-set-custom"
              >
                Set
              </Button>
            </div>

            <div className="pt-2">
              <Label className="text-sm text-muted-foreground mb-2 block">Preferred time</Label>
              <Select 
                value={preferredTime} 
                onValueChange={(value) => {
                  setPreferredTime(value);
                  settingsMutation.mutate({ preferredCheckinTime: value });
                }}
              >
                <SelectTrigger className="w-40" data-testid="select-checkin-time">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-2">
                Times shown in your local timezone
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Grace Period Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <AlertCircle className="h-5 w-5" />
              If you miss a checkin
            </CardTitle>
            <CardDescription>How long should we wait before notifying your emergency contacts?</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={graceMinutes.toString()}
              onValueChange={handleGraceChange}
              className="space-y-2"
            >
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="10" id="10min" data-testid="radio-10min" />
                <Label htmlFor="10min">10 minutes</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="15" id="15min" data-testid="radio-15min" />
                <Label htmlFor="15min">15 minutes</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="30" id="30min" data-testid="radio-30min" />
                <Label htmlFor="30min">30 minutes</Label>
              </div>
            </RadioGroup>
            <p className="text-sm text-muted-foreground mt-3">We'll send you a reminder first.</p>
          </CardContent>
        </Card>

        {/* Emergency Contacts Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className="h-5 w-5" />
              Emergency contacts
            </CardTitle>
            <CardDescription>
              We'll notify these people if you don't respond.
              {!status?.isPremium && (
                <span className="block text-xs mt-1">Free plan: up to {contactLimit} contacts</span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {contactEntries.map((contact, index) => {
              const savedContact = status?.contacts?.find(c => c.priority === index + 1);
              const linkedUserId = savedContact?.linkedUserId;
              return (
                <div key={index} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">
                      {index === 0 ? "Primary contact" : `Contact ${index + 1}`}
                    </Label>
                    <div className="flex items-center gap-1">
                      {contactEntries.length > 1 && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => moveContactEntry(index, index - 1)}
                            disabled={index === 0}
                            data-testid={`button-move-up-${index}`}
                          >
                            <GripVertical className="h-3 w-3" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-destructive"
                            onClick={() => removeContactEntry(index)}
                            data-testid={`button-remove-contact-${index}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <Input
                    placeholder="Name"
                    value={contact.name}
                    onChange={(e) => updateContactEntry(index, "name", e.target.value)}
                    data-testid={`input-contact-name-${index}`}
                  />
                  <Input
                    placeholder="Mobile number"
                    type="tel"
                    value={contact.phone}
                    onChange={(e) => updateContactEntry(index, "phone", e.target.value)}
                    data-testid={`input-contact-phone-${index}`}
                  />
                  <Input
                    placeholder="Email (optional)"
                    type="email"
                    value={contact.email}
                    onChange={(e) => updateContactEntry(index, "email", e.target.value)}
                    data-testid={`input-contact-email-${index}`}
                  />
                  {savedContact && contact.name.trim() && contact.phone.trim() && (
                    <div className="flex items-center gap-2">
                      {linkedUserId ? (
                        <>
                          <span className="text-xs text-green-600 font-medium flex items-center gap-1" data-testid={`badge-on-stillhere-${index}`}>
                            <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                            On StillHere
                          </span>
                          <div className="ml-auto flex items-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1.5 text-xs"
                              onClick={() => setLocation(`/chat/${linkedUserId}`)}
                              data-testid={`button-message-contact-${index}`}
                            >
                              <MessageCircle className="h-3.5 w-3.5" />
                              Message
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1.5 text-xs"
                              onClick={() => setLocation(`/call/${linkedUserId}`)}
                              data-testid={`button-video-contact-${index}`}
                            >
                              <Video className="h-3.5 w-3.5" />
                              Call
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`badge-sms-only-${index}`}>
                            SMS only
                          </span>
                          <div className="ml-auto">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1.5 text-xs"
                              onClick={() => window.open(`tel:${contact.phone}`, "_self")}
                              data-testid={`button-call-contact-${index}`}
                            >
                              <Phone className="h-3.5 w-3.5" />
                              Call
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {contactEntries.length < contactLimit && (
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={addContactEntry}
                data-testid="button-add-contact"
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Add another contact
              </Button>
            )}

            <Button
              className="w-full"
              onClick={saveContacts}
              disabled={contactsMutation.isPending}
              data-testid="button-save-contacts"
            >
              {contactsMutation.isPending ? "Saving..." : "Save contacts"}
            </Button>
          </CardContent>
        </Card>

        {removedContacts && removedContacts.length > 0 && (
          <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20">
            <CardContent className="py-4">
              <div className="flex items-start gap-3 mb-3">
                <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-sm" data-testid="text-removed-contacts-alert">
                    {removedContacts.length === 1
                      ? "An emergency contact has removed themselves"
                      : `${removedContacts.length} emergency contacts have removed themselves`}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    You may want to add a replacement. Removed contacts can be restored within 30 days.
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                {removedContacts.map(rc => {
                  const deletedAt = new Date(rc.softDeletedAt);
                  const expiresAt = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
                  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
                  return (
                    <div key={rc.id} className="flex items-center justify-between bg-background rounded-lg px-3 py-2" data-testid={`removed-contact-${rc.id}`}>
                      <div>
                        <p className="text-sm font-medium">{rc.name}</p>
                        <p className="text-xs text-muted-foreground">{daysLeft} {daysLeft === 1 ? "day" : "days"} left to restore</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => restoreContactMutation.mutate(rc.id)}
                        disabled={restoreContactMutation.isPending}
                        data-testid={`button-restore-contact-${rc.id}`}
                      >
                        Restore
                      </Button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Share my Location Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <MapPin className="h-5 w-5" />
              Share my Location
            </CardTitle>
            <CardDescription>You control this. You can turn it off anytime.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={locationMode}
              onValueChange={(value) => handleLocationModeChange(value as LocationMode)}
              className="space-y-2"
            >
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="off" id="loc-off" data-testid="radio-location-off" />
                <Label htmlFor="loc-off">Off</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="emergency_only" id="loc-emergency" data-testid="radio-location-emergency" />
                <Label htmlFor="loc-emergency">Only during emergencies</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="on_shift_only" id="loc-shift" data-testid="radio-location-shift" />
                <Label htmlFor="loc-shift">During active checkins</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="both" id="loc-both" data-testid="radio-location-both" />
                <Label htmlFor="loc-both">During emergencies and active checkins (recommended)</Label>
              </div>
            </RadioGroup>
            <p className="text-sm text-muted-foreground mt-3">
              If location is off, we will not share your location.
            </p>
          </CardContent>
        </Card>

        {/* Reminders Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Bell className="h-5 w-5" />
              Reminders before alerting contacts
            </CardTitle>
            <CardDescription>We'll send you a reminder before notifying your emergency contacts.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={reminderMode}
              onValueChange={(value) => handleReminderModeChange(value as ReminderMode)}
              className="space-y-2"
            >
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="none" id="rem-none" data-testid="radio-reminder-none" />
                <Label htmlFor="rem-none">No reminders</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="one" id="rem-one" data-testid="radio-reminder-one" />
                <Label htmlFor="rem-one">One reminder (recommended)</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="two" id="rem-two" data-testid="radio-reminder-two" />
                <Label htmlFor="rem-two">Two reminders</Label>
              </div>
            </RadioGroup>
          </CardContent>
        </Card>

        {/* Auto Checkin Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Smartphone className="h-5 w-5" />
              Auto checkin
            </CardTitle>
            <CardDescription>Check in automatically when you open the app.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Label htmlFor="auto-checkin">Check in when I open the app</Label>
              <Switch
                id="auto-checkin"
                checked={autoCheckin}
                onCheckedChange={(checked) => {
                  setAutoCheckin(checked);
                  settingsMutation.mutate({ autoCheckin: checked });
                }}
                data-testid="switch-auto-checkin"
              />
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              Opening StillHere counts as a checkin. No button tap needed.
            </p>
          </CardContent>
        </Card>

        {/* Fall Detection Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="h-5 w-5" />
              Fall detection
            </CardTitle>
            <CardDescription>Detect falls and automatically alert your contacts.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Label htmlFor="fall-detection">Enable fall detection</Label>
              <Switch
                id="fall-detection"
                checked={fallDetection}
                onCheckedChange={async (checked) => {
                  if (checked) {
                    const granted = await requestMotionPermission();
                    if (!granted) {
                      toast({ title: "Motion sensor access denied", description: "Please allow motion access in your browser settings to use fall detection.", variant: "destructive" });
                      return;
                    }
                  }
                  setFallDetection(checked);
                  settingsMutation.mutate({ fallDetection: checked });
                }}
                data-testid="switch-fall-detection"
              />
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              Uses your device's motion sensors. If a fall is detected, you'll have 60 seconds to dismiss before an SOS is sent.
            </p>
          </CardContent>
        </Card>

        {/* Discreet SOS Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Shield className="h-5 w-5" />
              Discreet SOS
            </CardTitle>
            <CardDescription>Trigger an SOS silently by shaking your phone.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Label htmlFor="discreet-sos">Enable shake-to-SOS</Label>
              <Switch
                id="discreet-sos"
                checked={discreetSos}
                onCheckedChange={async (checked) => {
                  if (checked) {
                    const granted = await requestMotionPermission();
                    if (!granted) {
                      toast({ title: "Motion sensor access denied", description: "Please allow motion access in your browser settings to use shake-to-SOS.", variant: "destructive" });
                      return;
                    }
                  }
                  setDiscreetSos(checked);
                  settingsMutation.mutate({ discreetSos: checked });
                }}
                data-testid="switch-discreet-sos"
              />
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              Shake your phone 3 times quickly to trigger an SOS without any visible alert on your screen. Useful in situations where you need help discreetly.
            </p>
          </CardContent>
        </Card>

        {/* SMS Checkin Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <MessageCircle className="h-5 w-5" />
              SMS checkin
            </CardTitle>
            <CardDescription>Check in by replying to a text message.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Label htmlFor="sms-checkin">Enable SMS checkin</Label>
              <Switch
                id="sms-checkin"
                checked={smsCheckinEnabled}
                onCheckedChange={(checked) => {
                  setSmsCheckinEnabled(checked);
                  settingsMutation.mutate({ smsCheckinEnabled: checked });
                }}
                data-testid="switch-sms-checkin"
              />
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              When enabled, you can check in by replying YES to your reminder text message. You can also text HELP to trigger an SOS.
            </p>
          </CardContent>
        </Card>

        {/* Driving Safety Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Car className="h-5 w-5" />
              Driving safety
            </CardTitle>
            <CardDescription>Monitor your speed and detect crashes while driving.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="driving-safety">Enable driving safety</Label>
              <Switch
                id="driving-safety"
                checked={drivingSafety}
                onCheckedChange={(checked) => {
                  setDrivingSafety(checked);
                  settingsMutation.mutate({ drivingSafety: checked });
                }}
                data-testid="switch-driving-safety"
              />
            </div>
            {drivingSafety && (
              <div>
                <Label htmlFor="speed-limit" className="flex items-center gap-1.5 mb-2">
                  <Gauge className="h-4 w-4" />
                  Speed limit (km/h)
                </Label>
                <Select
                  value={String(speedLimitKmh)}
                  onValueChange={(val) => {
                    const v = parseInt(val);
                    setSpeedLimitKmh(v);
                    settingsMutation.mutate({ speedLimitKmh: v });
                  }}
                >
                  <SelectTrigger id="speed-limit" data-testid="select-speed-limit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="40">40 km/h - School zone</SelectItem>
                    <SelectItem value="50">50 km/h - Urban</SelectItem>
                    <SelectItem value="60">60 km/h - City</SelectItem>
                    <SelectItem value="80">80 km/h - Suburban</SelectItem>
                    <SelectItem value="100">100 km/h - Highway</SelectItem>
                    <SelectItem value="110">110 km/h - Freeway</SelectItem>
                    <SelectItem value="120">120 km/h - Motorway</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground mt-3">
                  You'll receive alerts when you exceed this speed. Start a drive session from the home screen to activate monitoring.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Report Sharing Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileText className="h-5 w-5" />
              Report sharing
            </CardTitle>
            <CardDescription>Allow your watchers to receive periodic safety reports about your checkins and activity.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <Label htmlFor="allow-reports" className="font-medium">Allow safety reports</Label>
              <Switch
                id="allow-reports"
                checked={allowReports}
                onCheckedChange={(checked) => {
                  setAllowReports(checked);
                  settingsMutation.mutate({ allowReports: checked });
                }}
                data-testid="switch-allow-reports"
              />
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              When enabled, your guardians and emergency contacts can receive reports with your checkin history, incidents, and health data. You can turn this off at any time.
            </p>
          </CardContent>
        </Card>

        {/* Escalation Timing Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock className="h-5 w-5" />
              Escalation timing
            </CardTitle>
            <CardDescription>How long to wait before alerting the next contact.</CardDescription>
          </CardHeader>
          <CardContent>
            <Select
              value={String(escalationMinutes)}
              onValueChange={(val) => {
                const mins = parseInt(val);
                setEscalationMinutes(mins);
                settingsMutation.mutate({ escalationMinutes: mins });
              }}
            >
              <SelectTrigger data-testid="select-escalation-minutes">
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
            <p className="text-sm text-muted-foreground mt-3">
              If your first contact does not respond within this time, the next contact in your list will be alerted.
            </p>
          </CardContent>
        </Card>

        {/* Pause Alerts Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Pause className="h-5 w-5" />
              Pause alerts
            </CardTitle>
            <CardDescription>Use this if you're busy, sleeping, or travelling.</CardDescription>
          </CardHeader>
          <CardContent>
            {isPaused ? (
              <div className="space-y-3">
                <p className="text-sm">
                  Alerts paused until{" "}
                  <span className="font-medium">
                    {format(new Date(status!.settings.pauseUntil!), "h:mm a")}
                  </span>
                </p>
                <Button
                  variant="outline"
                  onClick={handleResume}
                  disabled={pauseMutation.isPending}
                  data-testid="button-resume"
                >
                  Resume now
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePause(2)}
                    disabled={pauseMutation.isPending}
                    data-testid="button-pause-2h"
                  >
                    Pause for 2 hours
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePause(6)}
                    disabled={pauseMutation.isPending}
                    data-testid="button-pause-6h"
                  >
                    Pause for 6 hours
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePause("tomorrow")}
                    disabled={pauseMutation.isPending}
                    data-testid="button-pause-tomorrow"
                  >
                    Pause until tomorrow morning
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="1"
                    max="72"
                    placeholder="Custom hrs"
                    value={customPauseHours}
                    onChange={(e) => setCustomPauseHours(e.target.value)}
                    className="w-28"
                    data-testid="input-custom-pause"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const hours = parseInt(customPauseHours);
                      if (hours >= 1 && hours <= 72) {
                        handlePause(hours);
                        setCustomPauseHours("");
                      }
                    }}
                    disabled={pauseMutation.isPending || !customPauseHours}
                    data-testid="button-pause-custom"
                  >
                    Pause
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Test Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FlaskConical className="h-5 w-5" />
              Test
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => setShowTestConfirm(true)}
              disabled={testMutation.isPending}
              data-testid="button-run-test"
            >
              Run a test now
            </Button>
          </CardContent>
        </Card>

        {/* Help Link */}
        <Card className="hover-elevate cursor-pointer" onClick={() => setLocation("/help")}>
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <HelpCircle className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium" data-testid="link-help">What happens if…</span>
            </div>
          </CardContent>
        </Card>

        {/* Trust & Safety Link */}
        <Card className="hover-elevate cursor-pointer" onClick={() => setLocation("/trust")}>
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Shield className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium" data-testid="link-trust">Trust & Safety</span>
            </div>
          </CardContent>
        </Card>

        {/* Biometric Sign-in */}
        {browserSupportsWebAuthn() && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Fingerprint className="h-5 w-5" />
                Biometric sign-in
              </CardTitle>
              <CardDescription>
                Use Face ID, Touch ID, fingerprint, or screen lock to sign in instantly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {passkeysQuery.data && passkeysQuery.data.length > 0 ? (
                <div className="space-y-2">
                  {passkeysQuery.data.map((pk: any) => (
                    <div key={pk.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg" data-testid={`passkey-item-${pk.id}`}>
                      <div className="flex items-center gap-2">
                        <Fingerprint className="h-4 w-4 text-primary" />
                        <div>
                          <p className="text-sm font-medium">
                            {pk.deviceType === "multiDevice" ? "Synced passkey" : "Device passkey"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Added {new Date(pk.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deletePasskeyMutation.mutate(pk.id)}
                        disabled={deletePasskeyMutation.isPending}
                        data-testid={`button-delete-passkey-${pk.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No passkeys set up yet.</p>
              )}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => registerPasskeyMutation.mutate()}
                disabled={registerPasskeyMutation.isPending}
                data-testid="button-add-passkey"
              >
                <Plus className="h-4 w-4 mr-2" />
                {registerPasskeyMutation.isPending ? "Setting up..." : "Add biometric sign-in"}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Logout */}
        <Card 
          className="hover-elevate cursor-pointer" 
          onClick={() => logoutMutation.mutate()}
        >
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <LogOut className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium" data-testid="button-logout">
                {logoutMutation.isPending ? "Logging out..." : "Log out"}
              </span>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Test Confirmation Dialog */}
      <AlertDialog open={showTestConfirm} onOpenChange={setShowTestConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send a test message?</AlertDialogTitle>
            <AlertDialogDescription>
              We will send a test link to your emergency contacts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-test-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                testMutation.mutate();
                setShowTestConfirm(false);
              }}
              data-testid="button-test-confirm"
            >
              Send Test
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
