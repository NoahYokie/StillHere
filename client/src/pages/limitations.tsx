import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Shield } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

export const LIMITATIONS_ESCAPE_KEY = "limitations_escape_used_at";

export default function LimitationsPage() {
  const [, setLocation] = useLocation();
  const { auth } = useAuth();
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [reachedBottom, setReachedBottom] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Re-read mode: opened from Trust page after the user has already
  // acknowledged. Show "Done" instead of the scroll-gated Continue button.
  const search = typeof window !== "undefined" ? window.location.search : "";
  const isReread =
    /[?&]reread=1/.test(search) || Boolean(auth?.acknowledgedLimitationsAt);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isReread) {
      if (isReread) setReachedBottom(true);
      return;
    }
    const handler = () => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Tolerance for sub-pixel rounding on mobile browsers.
      if (remaining < 24) {
        setReachedBottom(true);
      }
    };
    // Initial check: if content is so short it already fits, allow Continue.
    if (el.scrollHeight - el.clientHeight < 24) {
      setReachedBottom(true);
    }
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [isReread]);

  async function handleContinue() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/limitations/acknowledge", {});
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      try {
        sessionStorage.removeItem(LIMITATIONS_ESCAPE_KEY);
      } catch {}
      setLocation("/");
    } catch (err: any) {
      toast({
        title: "Could not save",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
      setSubmitting(false);
    }
  }

  function handleDone() {
    setLocation("/trust");
  }

  function handleSosEscape() {
    // SOS escape: do NOT mark limitations as acknowledged. Set a sessionStorage
    // flag so the gate does not bounce the user back here while they handle
    // their emergency on the home screen.
    try {
      sessionStorage.setItem(LIMITATIONS_ESCAPE_KEY, String(Date.now()));
    } catch {}
    setLocation("/");
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="bg-primary text-primary-foreground px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <Shield className="h-6 w-6" />
          <h1
            className="text-lg font-semibold"
            data-testid="text-limitations-title"
          >
            What StillHere is, and what it isn't
          </h1>
        </div>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-6 flex flex-col gap-4 min-h-0">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto rounded-md border bg-card p-6 text-sm leading-relaxed text-foreground space-y-4"
          data-testid="content-limitations"
          style={{ minHeight: 0 }}
        >
          <p>Before you finish setting up, please read this carefully.</p>
          <p>
            StillHere is a safety check-in app. It helps your Safety Circle
            notice when you miss a check-in or send an SOS, so they can decide
            what to do.
          </p>
          <p>
            StillHere is not an emergency service. We do not contact 911, 999,
            112, 000, or any local emergency number for you. We do not dispatch
            police, ambulance, or rescue services.
          </p>
          <p>
            StillHere is not a medical device. Fall sensing and possible-crash
            alerts use your phone and watch sensors. They are best-effort and
            may not detect every event. They are not a replacement for a
            medical alert pendant or hospital monitoring.
          </p>
          <p>
            Alerts are best-effort. When StillHere starts an alert flow, we
            attempt to reach your contacts through available channels such as
            push notifications, SMS, email, or phone calls, depending on what
            is enabled. Delivery depends on:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Your phone having signal, battery, and permissions enabled</li>
            <li>Your contacts' phones being on and reachable</li>
            <li>
              Carrier networks and third-party services such as Apple, Google,
              and Twilio
            </li>
          </ul>
          <p>
            We cannot guarantee that every alert will be received, or how
            quickly.
          </p>
          <p>
            If you are in immediate danger and can safely do so, call your
            local emergency number first. StillHere is a layer on top of, not a
            replacement for, calling for help yourself.
          </p>
          <p>
            By tapping Continue, you confirm you understand the limits of this
            service.
          </p>
          <div data-testid="marker-limitations-bottom" className="h-1" />
        </div>

        {isReread ? (
          <Button
            size="lg"
            className="w-full"
            onClick={handleDone}
            data-testid="button-limitations-done"
          >
            Done
          </Button>
        ) : (
          <Button
            size="lg"
            className="w-full"
            disabled={!reachedBottom || submitting}
            onClick={handleContinue}
            data-testid="button-limitations-continue"
          >
            {submitting ? "Saving..." : "I understand. Continue"}
          </Button>
        )}

        {!isReread && (
          <button
            type="button"
            onClick={handleSosEscape}
            className="text-center text-sm text-muted-foreground underline hover:text-foreground"
            data-testid="link-limitations-sos-escape"
          >
            If you need help right now, use SOS instead.
          </button>
        )}
      </main>
    </div>
  );
}
