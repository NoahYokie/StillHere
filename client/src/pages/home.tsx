import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Settings, MapPin, Check, AlertTriangle, Clock, LogOut } from "lucide-react";
import type { UserStatus } from "@shared/schema";
import { format } from "date-fns";

export default function Home() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showSosConfirm, setShowSosConfirm] = useState(false);
  const [locationEnabled, setLocationEnabled] = useState(false);

  const { data: status, isLoading } = useQuery<UserStatus>({
    queryKey: ["/api/status"],
  });

  const checkinMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/checkin");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({
        title: "Checked in",
        description: "Thank you. Your family knows you're okay.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not check in. Please try again.",
        variant: "destructive",
      });
    },
  });

  const sosMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/sos");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({
        title: "Help alert sent",
        description: "Your emergency contacts have been notified.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not send alert. Please try again.",
        variant: "destructive",
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.clear();
      setLocation("/login");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not log out. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleLocationToggle = () => {
    if (!locationEnabled) {
      navigator.geolocation.getCurrentPosition(
        () => {
          setLocationEnabled(true);
          toast({
            title: "Location enabled",
            description: "Your location can now be shared during emergencies.",
          });
        },
        () => {
          toast({
            title: "Location access denied",
            description: "Please enable location in your browser settings.",
            variant: "destructive",
          });
        }
      );
    } else {
      setLocationEnabled(false);
      toast({
        title: "Location disabled",
        description: "Your location will not be shared.",
      });
    }
  };

  const formatNextCheckin = (date: Date) => {
    const d = new Date(date);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 24) {
      return format(d, "h:mm a 'today'");
    } else if (diffHours < 48) {
      return format(d, "h:mm a 'tomorrow'");
    } else {
      return format(d, "EEEE 'at' h:mm a");
    }
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
  const hasOpenIncident = status?.openIncident && status.openIncident.status !== "resolved";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-primary text-primary-foreground px-6 py-4">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-app-title">StillHere</h1>
            <p className="text-sm opacity-90" data-testid="text-welcome">
              Welcome, {status?.user?.name || "User"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground"
              onClick={() => setLocation("/settings")}
              data-testid="button-settings"
            >
              <Settings className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              data-testid="button-logout"
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-8 space-y-8">
        {/* Next Check-in */}
        <Card>
          <CardContent className="pt-6 text-center">
            <div className="flex items-center justify-center gap-2 text-muted-foreground mb-2">
              <Clock className="h-4 w-4" />
              <span className="text-sm">Next check-in</span>
            </div>
            <p className="text-lg font-medium" data-testid="text-next-checkin">
              {status?.nextCheckinDue
                ? formatNextCheckin(status.nextCheckinDue)
                : "No schedule set"}
            </p>
            {isPaused && (
              <p className="text-sm text-muted-foreground mt-2">
                Alerts paused until {format(new Date(status.settings.pauseUntil!), "h:mm a")}
              </p>
            )}
          </CardContent>
        </Card>

        {/* I'm OK Button */}
        <div className="text-center">
          <button
            onClick={() => checkinMutation.mutate()}
            disabled={checkinMutation.isPending}
            className="w-44 h-44 rounded-full bg-accent text-accent-foreground font-bold text-2xl shadow-lg transition-all duration-200 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 flex flex-col items-center justify-center mx-auto"
            data-testid="button-im-ok"
          >
            <Check className="h-12 w-12 mb-2" />
            <span>I'm OK</span>
          </button>
          <p className="text-sm text-muted-foreground mt-4">
            Tap "I'm OK" anytime
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            This lets your family know you're okay.
          </p>
        </div>

        {/* SOS Button */}
        <Card className="bg-destructive/5 border-destructive/20">
          <CardContent className="pt-6">
            <Button
              variant="destructive"
              size="lg"
              className="w-full py-6 text-lg font-semibold"
              onClick={() => setShowSosConfirm(true)}
              disabled={sosMutation.isPending}
              data-testid="button-sos"
            >
              <AlertTriangle className="h-5 w-5 mr-2" />
              I Need Help
            </Button>
          </CardContent>
        </Card>

        {/* Location Status */}
        <div className="flex items-center justify-center gap-2 text-sm">
          <MapPin className={`h-4 w-4 ${locationEnabled ? "text-accent" : "text-destructive"}`} />
          <span className="text-muted-foreground">
            Location Sharing {locationEnabled ? "ON" : "OFF"}
          </span>
          <span className="text-muted-foreground">|</span>
          <button
            onClick={handleLocationToggle}
            className="text-primary underline hover:no-underline"
            data-testid="button-location-toggle"
          >
            {locationEnabled ? "Turn off" : "Enable Location"}
          </button>
        </div>

        {/* Open Incident Warning */}
        {hasOpenIncident && (
          <Card className="bg-destructive/10 border-destructive/30">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-destructive">
                    {status.openIncident?.reason === "sos"
                      ? "Help alert active"
                      : "Missed check-in alert"}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Your emergency contacts have been notified.
                    {status.openIncident?.status === "paused" && " Someone is checking on you."}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* SOS Confirmation Dialog */}
      <AlertDialog open={showSosConfirm} onOpenChange={setShowSosConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send help alert?</AlertDialogTitle>
            <AlertDialogDescription>
              We will notify your emergency contacts now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-sos-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                sosMutation.mutate();
                setShowSosConfirm(false);
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-sos-confirm"
            >
              Send Alert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
