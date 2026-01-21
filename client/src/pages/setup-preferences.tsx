import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Settings, Clock, MapPin } from "lucide-react";
import type { LocationMode, ReminderMode } from "@shared/schema";
import { Bell } from "lucide-react";

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

export default function SetupPreferencesPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [checkinInterval, setCheckinInterval] = useState(24);
  const [preferredTime, setPreferredTime] = useState("09:00");
  const [locationMode, setLocationMode] = useState<LocationMode>("off");
  const [reminderMode, setReminderMode] = useState<ReminderMode>("one");
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimezone(detectedTimezone);
  }, []);

  const settingsMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/settings", {
        checkinIntervalHours: checkinInterval,
        preferredCheckinTime: preferredTime,
        locationMode: locationMode,
        reminderMode: reminderMode,
        timezone: timezone,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: "Setup complete",
      });
      setLocation("/");
    },
    onError: (error: any) => {
      if (error?.requiresLogin) {
        setLocation("/login");
        return;
      }
      toast({
        title: "Error",
        description: "Could not save preferences. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleComplete = () => {
    settingsMutation.mutate();
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-4">
            <Settings className="h-8 w-8 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-setup-preferences-title">
            Your preferences
          </CardTitle>
          <CardDescription className="text-base mt-2">
            You can change these anytime in settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <Label className="text-base font-medium">How often should we check in?</Label>
            </div>
            <RadioGroup
              value={checkinInterval.toString()}
              onValueChange={(value) => setCheckinInterval(parseInt(value))}
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

            <div className="pt-3">
              <Label className="text-sm text-muted-foreground mb-2 block">Preferred time</Label>
              <Select value={preferredTime} onValueChange={setPreferredTime}>
                <SelectTrigger data-testid="select-checkin-time">
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
              {timezone && (
                <p className="text-xs text-muted-foreground mt-2">
                  Times shown in {timezone.replace(/_/g, " ")}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-muted-foreground" />
              <Label className="text-base font-medium">Share my Location</Label>
            </div>
            <RadioGroup
              value={locationMode}
              onValueChange={(value) => setLocationMode(value as LocationMode)}
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
                <RadioGroupItem value="on_shift_only" id="loc-checkin" data-testid="radio-location-checkin" />
                <Label htmlFor="loc-checkin">During active check-ins</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="both" id="loc-both" data-testid="radio-location-both" />
                <Label htmlFor="loc-both">During emergencies and active check-ins (recommended)</Label>
              </div>
            </RadioGroup>
            <p className="text-sm text-muted-foreground">
              You control this. You can turn it off anytime.
            </p>
            <p className="text-sm text-muted-foreground">
              If location is off, we will not share your location.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-muted-foreground" />
              <Label className="text-base font-medium">Reminders before alerting contacts</Label>
            </div>
            <RadioGroup
              value={reminderMode}
              onValueChange={(value) => setReminderMode(value as ReminderMode)}
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
            <p className="text-sm text-muted-foreground">
              We'll send you a reminder before notifying your contacts.
            </p>
          </div>

          <Button
            onClick={handleComplete}
            className="w-full"
            size="lg"
            disabled={settingsMutation.isPending}
            data-testid="button-complete"
          >
            {settingsMutation.isPending ? "Setting up..." : "Complete setup"}
          </Button>

          <div className="flex justify-center gap-2">
            <div className="w-2 h-2 rounded-full bg-primary" />
            <div className="w-2 h-2 rounded-full bg-primary" />
            <div className="w-2 h-2 rounded-full bg-primary" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
