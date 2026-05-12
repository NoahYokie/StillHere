import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Shield } from "lucide-react";
import type { FeatureKey } from "@/lib/escalate-always";
import { featureLabel } from "@/lib/escalate-always";

export type BackgroundLocationSheetProps = {
  open: boolean;
  feature: FeatureKey | null;
  primaryAction: "continue" | "open_settings";
  onContinue: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
};

export function BackgroundLocationSheet({
  open,
  feature,
  primaryAction,
  onContinue,
  onOpenSettings,
  onDismiss,
}: BackgroundLocationSheetProps) {
  const name = feature ? featureLabel(feature) : "this safety feature";

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl"
        data-testid="sheet-background-location"
      >
        <SheetHeader className="text-left">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
            <Shield className="h-5 w-5 text-primary" />
          </div>
          <SheetTitle data-testid="text-sheet-title">
            Background location for {name}
          </SheetTitle>
          <SheetDescription className="text-sm leading-relaxed">
            StillHere needs background location while {name} is running so your
            Safety Circle can still receive updates if your phone locks or you
            switch apps.
            <br /><br />
            StillHere only uses background location while a safety feature you
            started is active. You can pause or turn it off at any time in
            Settings.
          </SheetDescription>
        </SheetHeader>

        <SheetFooter className="mt-4 flex flex-col gap-2 sm:flex-col">
          {primaryAction === "continue" ? (
            <Button
              onClick={onContinue}
              className="w-full"
              data-testid="button-sheet-continue"
            >
              Continue
            </Button>
          ) : (
            <Button
              onClick={onOpenSettings}
              className="w-full"
              data-testid="button-sheet-open-settings"
            >
              Open Settings
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={onDismiss}
            className="w-full"
            data-testid="button-sheet-not-now"
          >
            Not now
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
