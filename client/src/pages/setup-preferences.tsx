import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Settings, Clock, MapPin } from "lucide-react";
import type { LocationMode } from "@shared/schema";

export default function SetupPreferencesPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [checkinInterval, setCheckinInterval] = useState(24);
  const [locationMode, setLocationMode] = useState<LocationMode>("off");

  const settingsMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/settings", {
        checkinIntervalHours: checkinInterval,
        locationMode: locationMode,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: "Welcome to StillHere!",
        description: "Your account is ready.",
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
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-muted-foreground" />
              <Label className="text-base font-medium">Location sharing</Label>
            </div>
            <RadioGroup
              value={locationMode}
              onValueChange={(value) => setLocationMode(value as LocationMode)}
              className="space-y-2"
            >
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="off" id="loc-off" data-testid="radio-location-off" />
                <Label htmlFor="loc-off">Off (recommended for privacy)</Label>
              </div>
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="emergency_only" id="loc-emergency" data-testid="radio-location-emergency" />
                <Label htmlFor="loc-emergency">Only during emergencies</Label>
              </div>
            </RadioGroup>
            <p className="text-sm text-muted-foreground">
              You stay in control. Change this anytime.
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
