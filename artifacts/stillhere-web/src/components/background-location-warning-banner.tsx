import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type BackgroundLocationWarningBannerProps = {
  visible: boolean;
  message: string;
  onUpgrade?: () => void;
  onDismiss?: () => void;
};

export function BackgroundLocationWarningBanner({
  visible,
  message,
  onUpgrade,
  onDismiss,
}: BackgroundLocationWarningBannerProps) {
  if (!visible) return null;

  return (
    <div
      className="fixed left-0 right-0 z-40 px-3 pt-[max(env(safe-area-inset-top),0.5rem)]"
      style={{ top: 0 }}
      data-testid="banner-background-location"
    >
      <div className="mx-auto max-w-md flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-3 py-2 shadow-sm">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
        <p className="flex-1 text-xs leading-snug text-amber-800 dark:text-amber-200" data-testid="text-banner-message">
          {message}
        </p>
        <div className="flex items-center gap-1">
          {onUpgrade && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-amber-900 dark:text-amber-100 hover:bg-amber-100 dark:hover:bg-amber-900/40"
              onClick={onUpgrade}
              data-testid="button-banner-upgrade"
            >
              Upgrade
            </Button>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="h-6 w-6 flex items-center justify-center rounded text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
              aria-label="Dismiss"
              data-testid="button-banner-dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
