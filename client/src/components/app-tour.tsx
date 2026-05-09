import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, ArrowRight, ShieldCheck } from "lucide-react";

const TOUR_STORAGE_KEY = "stillhere.tour.v1.completed";

type TourStep = {
  id: string;
  selector?: string;
  title: string;
  body: string;
};

const STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to StillHere",
    body: "A quick 30 second tour of how StillHere keeps you and your people connected. You can skip anytime.",
  },
  {
    id: "checkin",
    selector: "[data-tour='checkin']",
    title: "Tap I'M OK once a day",
    body: "One tap tells your Safety Circle you're okay. That's the whole habit.",
  },
  {
    id: "next",
    selector: "[data-tour='next-checkin']",
    title: "We watch the clock for you",
    body: "If you miss a check in, we try a notification, then SMS, then a phone call before alerting your people.",
  },
  {
    id: "sos",
    selector: "[data-tour='sos']",
    title: "Need help right now?",
    body: "The red SOS sends an immediate alert to your Safety Circle with your location. No waiting.",
  },
  {
    id: "safewalk",
    selector: "[data-tour='safewalk']",
    title: "Share your journey",
    body: "Safe Walk shares your trip and alerts your people if you don't arrive on time.",
  },
  {
    id: "menu",
    selector: "[data-tour='menu']",
    title: "Everything else lives here",
    body: "Open the menu for your Safety Circle, live location, family map, and settings.",
  },
  {
    id: "done",
    title: "You're protected.",
    body: "Add a guardian or two to your Safety Circle and you're set. Welcome to StillHere.",
  },
];

type Rect = { top: number; left: number; width: number; height: number };

function readRect(selector?: string): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function AppTour() {
  const [active, setActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const force = params.get("tour") === "1";
    const seen = window.localStorage.getItem(TOUR_STORAGE_KEY) === "1";
    if (force || !seen) {
      const id = window.setTimeout(() => setActive(true), 600);
      return () => window.clearTimeout(id);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const step = STEPS[stepIdx];
    const update = () => setRect(readRect(step.selector));
    update();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    let frames = 0;
    const loop = () => {
      frames++;
      update();
      if (frames < 30) rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, [active, stepIdx]);

  const finish = () => {
    try {
      window.localStorage.setItem(TOUR_STORAGE_KEY, "1");
    } catch {}
    setActive(false);
    if (typeof window !== "undefined" && window.location.search.includes("tour=1")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("tour");
      window.history.replaceState({}, "", url.toString());
    }
  };

  const next = () => {
    if (stepIdx >= STEPS.length - 1) {
      finish();
    } else {
      setStepIdx(stepIdx + 1);
    }
  };

  if (!active) return null;

  const step = STEPS[stepIdx];
  const padding = 8;
  const hasTarget = !!rect;

  const tooltipStyle: React.CSSProperties = (() => {
    if (typeof window === "undefined" || !rect) {
      return {
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
      };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardWidth = Math.min(340, vw - 24);
    const cardHeightEstimate = 200;
    const spaceBelow = vh - (rect.top + rect.height) - 24;
    const placeAbove = spaceBelow < cardHeightEstimate + 16;
    const top = placeAbove
      ? Math.max(16, rect.top - cardHeightEstimate - 16)
      : rect.top + rect.height + 16;
    const left = Math.min(
      Math.max(12, rect.left + rect.width / 2 - cardWidth / 2),
      vw - cardWidth - 12,
    );
    return { top, left, width: cardWidth };
  })();

  const isFinal = stepIdx >= STEPS.length - 1;
  const isFirst = stepIdx === 0;

  return (
    <div className="fixed inset-0 z-[9999]" data-testid="app-tour-overlay">
      {/* Backdrop with optional spotlight cutout */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-auto"
        aria-hidden
        onClick={() => {}}
      >
        <defs>
          <mask id="tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {hasTarget && rect && (
              <rect
                x={rect.left - padding}
                y={rect.top - padding}
                width={rect.width + padding * 2}
                height={rect.height + padding * 2}
                rx={16}
                ry={16}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(15, 23, 42, 0.62)"
          mask="url(#tour-mask)"
        />
        {hasTarget && rect && (
          <rect
            x={rect.left - padding}
            y={rect.top - padding}
            width={rect.width + padding * 2}
            height={rect.height + padding * 2}
            rx={16}
            ry={16}
            fill="none"
            stroke="rgba(255,255,255,0.9)"
            strokeWidth={2}
          />
        )}
      </svg>

      {/* Tooltip card */}
      <div
        className="absolute bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-5"
        style={tooltipStyle}
        role="dialog"
        aria-label={step.title}
        data-testid={`tour-step-${step.id}`}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Step {stepIdx + 1} of {STEPS.length}
            </div>
          </div>
          <button
            onClick={finish}
            aria-label="Skip tour"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            data-testid="button-tour-skip"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <h3 className="font-semibold text-base leading-snug" data-testid="tour-step-title">
          {step.title}
        </h3>
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
          {step.body}
        </p>
        <div className="flex items-center justify-between gap-3 mt-4">
          <button
            onClick={finish}
            className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            data-testid="button-tour-skip-text"
          >
            {isFirst ? "Skip" : "Skip tour"}
          </button>
          <Button
            size="sm"
            onClick={next}
            className="gap-1.5"
            data-testid="button-tour-next"
          >
            {isFinal ? "Got it" : "Next"}
            {!isFinal && <ArrowRight className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <div className="flex items-center gap-1.5 mt-3 justify-center">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === stepIdx
                  ? "w-6 bg-primary"
                  : "w-1.5 bg-slate-300 dark:bg-slate-700"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
