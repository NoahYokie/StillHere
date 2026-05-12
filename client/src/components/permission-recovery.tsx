import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Shield, X, ChevronRight, MapPin, Bell, ExternalLink } from "lucide-react";
import {
  usePermissionHealth,
  isDismissed,
  dismissRecoveryPrompt,
  requestLocationPermission,
  requestNotificationPermission,
} from "@/lib/permissions";

export function PermissionRecoveryCard() {
  const health = usePermissionHealth();
  const [dismissed, setDismissed] = useState(isDismissed());
  const [expanded, setExpanded] = useState(false);
  const [fixing, setFixing] = useState(false);

  if (health.loading || dismissed) return null;

  const locationOk = health.location === "granted" || health.location === "always";
  const notifOk = health.notifications === "granted";

  if (locationOk && notifOk) return null;

  const handleDismiss = () => {
    dismissRecoveryPrompt();
    setDismissed(true);
  };

  const handleFixLocation = async () => {
    setFixing(true);
    await requestLocationPermission();
    health.refresh();
    setFixing(false);
  };

  const handleFixNotifications = async () => {
    setFixing(true);
    await requestNotificationPermission();
    health.refresh();
    setFixing(false);
  };

  if (!expanded) {
    return (
      <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20" data-testid="card-permission-recovery">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300" data-testid="text-recovery-title">
                Some StillHere settings need attention
              </p>
              <p className="text-xs text-amber-700/70 dark:text-amber-400/60 mt-0.5">
                Some permissions are off, which limits what StillHere can do for you.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-amber-700 dark:text-amber-400 h-auto p-0 mt-1 text-xs underline-offset-4 hover:underline"
                onClick={() => setExpanded(true)}
                data-testid="button-learn-more-permissions"
              >
                Tap to learn more <ChevronRight className="h-3 w-3 ml-0.5" />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-amber-600/50 hover:text-amber-600 flex-shrink-0"
              onClick={handleDismiss}
              data-testid="button-dismiss-recovery"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20" data-testid="card-permission-recovery-expanded">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Update your StillHere permissions
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-amber-600/50 hover:text-amber-600"
            onClick={handleDismiss}
            data-testid="button-dismiss-recovery-expanded"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3">
          {!locationOk && (
            <div className="flex items-start gap-3 bg-white/60 dark:bg-white/5 rounded-lg p-3">
              <MapPin className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Location</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  StillHere needs location access to share your position with trusted contacts during emergencies.
                </p>
                {health.location === "denied" ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 flex items-center gap-1">
                    <ExternalLink className="h-3 w-3" />
                    Open your phone's Settings to update this
                  </p>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-7 text-xs"
                    onClick={handleFixLocation}
                    disabled={fixing}
                    data-testid="button-fix-location"
                  >
                    Enable location
                  </Button>
                )}
              </div>
            </div>
          )}

          {!notifOk && (
            <div className="flex items-start gap-3 bg-white/60 dark:bg-white/5 rounded-lg p-3">
              <Bell className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Notifications</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Notifications let StillHere reach you and try to alert your contacts when something needs attention.
                </p>
                {health.notifications === "denied" ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 flex items-center gap-1">
                    <ExternalLink className="h-3 w-3" />
                    Open your phone's Settings to update this
                  </p>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-7 text-xs"
                    onClick={handleFixNotifications}
                    disabled={fixing}
                    data-testid="button-fix-notifications"
                  >
                    Enable notifications
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground mt-3">
          You can update these anytime in your phone's Settings app.
        </p>
      </CardContent>
    </Card>
  );
}
