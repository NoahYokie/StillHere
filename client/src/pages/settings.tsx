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
import { ArrowLeft, Clock, AlertCircle, Users, MapPin, Pause, FlaskConical, HelpCircle, Shield, LogOut, Bell, Smartphone, UserPlus, Trash2, GripVertical, Activity } from "lucide-react";
import type { UserStatus, LocationMode, ReminderMode } from "@shared/schema";
import { format, addHours, addDays, startOfTomorrow, setHours } from "date-fns";

interface ContactEntry {
  name: string;
  phone: string;
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
  const [customInterval, setCustomInterval] = useState("");
  const [customPauseHours, setCustomPauseHours] = useState("");
  const [contactEntries, setContactEntries] = useState<ContactEntry[]>([]);
  const [contactsInitialized, setContactsInitialized] = useState(false);

  const { data: status, isLoading } = useQuery<UserStatus>({
    queryKey: ["/api/status"],
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

      if (!contactsInitialized && status.contacts?.length) {
        const sorted = [...status.contacts].sort((a, b) => a.priority - b.priority);
        setContactEntries(sorted.map(c => ({ name: c.name, phone: c.phone })));
        setContactsInitialized(true);
      } else if (!contactsInitialized && (!status.contacts || status.contacts.length === 0)) {
        setContactEntries([{ name: "", phone: "" }]);
        setContactsInitialized(true);
      }
    }
  }, [status, contactsInitialized]);

  const settingsMutation = useMutation({
    mutationFn: async (data: { checkinIntervalHours?: number; graceMinutes?: number; locationMode?: LocationMode; reminderMode?: ReminderMode; preferredCheckinTime?: string; autoCheckin?: boolean; fallDetection?: boolean }) => {
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
      return apiRequest("POST", "/api/test");
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
    setContactEntries([...contactEntries, { name: "", phone: "" }]);
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
        {/* Check-ins Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock className="h-5 w-5" />
              Check-ins
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
              If you miss a check-in
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
            {contactEntries.map((contact, index) => (
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
                {status?.contacts?.find(c => c.priority === index + 1)?.linkedUserId && (
                  <span className="text-xs text-accent font-medium flex items-center gap-1" data-testid={`badge-on-stillhere-${index}`}>
                    <span className="w-1.5 h-1.5 bg-accent rounded-full" />
                    On StillHere
                  </span>
                )}
              </div>
            ))}

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
                <Label htmlFor="loc-shift">During active check-ins</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="both" id="loc-both" data-testid="radio-location-both" />
                <Label htmlFor="loc-both">During emergencies and active check-ins (recommended)</Label>
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

        {/* Auto Check-in Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Smartphone className="h-5 w-5" />
              Auto check-in
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
              Opening StillHere counts as a check-in. No button tap needed.
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
                onCheckedChange={(checked) => {
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
