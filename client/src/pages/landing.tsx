import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Heart, Bell, Users, Shield, ChevronDown, Check, Clock, MessageCircle,
  MapPin, HelpCircle, Activity, Watch, AlertTriangle, Phone, Smartphone,
  Server, Navigation, Car, Map, BarChart3, Sparkles, Eye, Lock, Footprints,
  Plane, Stethoscope, Home as HomeIcon, MoonStar, ShieldCheck, Hand,
  EyeOff, Pause, ArrowRight, ChevronUp,
} from "lucide-react";
import logoPath from "@assets/F0BE7587-0A49-40F7-A9A8-E7C53E58260F_1777863919813.png";

type Stage = 0 | 1 | 2 | 3;

const STAGE_DURATION = 4200;

function PhoneScreen({ stage }: { stage: Stage }) {
  if (stage === 0) {
    return (
      <div className="flex-1 flex flex-col bg-slate-50">
        <div className="bg-white px-3.5 md:px-5 pt-5 md:pt-7 pb-2 md:pb-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <img src={logoPath} alt="" className="h-3 md:h-4 w-3 md:w-4 object-contain" />
            <span className="text-[11px] md:text-sm font-semibold text-gray-800">StillHere</span>
          </div>
          <span className="text-[8px] md:text-[10px] text-gray-400">9:41</span>
        </div>
        <div className="flex-1 px-3 md:px-5 py-3 md:py-5 flex flex-col gap-2.5 md:gap-4">
          <div className="bg-white rounded-xl px-3 md:px-4 py-2 md:py-3 shadow-sm border border-gray-100 text-center">
            <div className="flex items-center justify-center gap-1 mb-0.5">
              <ShieldCheck className="h-3 w-3 md:h-3.5 md:w-3.5 text-emerald-500" />
              <p className="text-[9px] md:text-[11px] font-semibold text-emerald-700">Safety Circle ready</p>
            </div>
            <p className="text-[7px] md:text-[9px] text-gray-500">Sharing with 2 Guardians</p>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="w-20 h-20 md:w-28 md:h-28 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/40">
              <Check className="h-10 w-10 md:h-14 md:w-14 text-white" strokeWidth={3} />
            </div>
            <p className="font-bold text-gray-800 text-[14px] md:text-lg mt-2 md:mt-3">I'M OK</p>
            <p className="text-[8px] md:text-[10px] text-gray-500 mt-0.5">Tap anytime to let your guardians know you're okay</p>
          </div>
          <div className="bg-white rounded-xl px-3 py-2 border border-gray-100">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[7px] md:text-[9px] text-gray-400 uppercase tracking-wider">Next check in</p>
                <p className="text-[10px] md:text-[12px] font-semibold text-gray-700">Today at 10:00 PM</p>
              </div>
              <Clock className="h-3.5 w-3.5 md:h-4 md:w-4 text-gray-400" />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { icon: Clock, label: "Timer", color: "text-orange-500 bg-orange-50" },
              { icon: Footprints, label: "Safe Walk", color: "text-cyan-500 bg-cyan-50" },
              { icon: Car, label: "Drive", color: "text-blue-500 bg-blue-50" },
              { icon: AlertTriangle, label: "SOS", color: "text-red-500 bg-red-50" },
            ].map((q) => (
              <div key={q.label} className={`rounded-lg ${q.color} flex flex-col items-center justify-center py-1.5 gap-0.5`}>
                <q.icon className="h-3 w-3 md:h-3.5 md:w-3.5" />
                <span className="text-[6px] md:text-[8px] font-medium">{q.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (stage === 1) {
    return (
      <div className="flex-1 flex flex-col bg-slate-50">
        <div className="bg-white px-3.5 md:px-5 pt-5 md:pt-7 pb-2 md:pb-3 flex items-center gap-1.5">
          <Users className="h-3 md:h-4 w-3 md:w-4 text-primary" />
          <span className="text-[11px] md:text-sm font-semibold text-gray-800">Safety Circle</span>
        </div>
        <div className="flex-1 px-3 md:px-5 py-3 md:py-5 flex flex-col gap-2.5">
          <div className="text-center mb-1">
            <div className="w-12 h-12 md:w-14 md:h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-1.5">
              <ShieldCheck className="h-6 w-6 md:h-7 md:w-7 text-primary" />
            </div>
            <p className="text-[11px] md:text-sm font-bold text-gray-800">Your Safety Circle is Ready</p>
            <p className="text-[8px] md:text-[10px] text-gray-500">2 of 2 Guardians confirmed</p>
          </div>
          {[
            { name: "Mom", role: "Primary", initial: "M", color: "bg-violet-500" },
            { name: "Sam", role: "Backup", initial: "S", color: "bg-amber-500" },
          ].map((g) => (
            <div key={g.name} className="bg-white rounded-xl p-2 md:p-2.5 border border-gray-100 flex items-center gap-2">
              <div className={`w-7 h-7 md:w-8 md:h-8 rounded-full ${g.color} flex items-center justify-center`}>
                <span className="text-[10px] md:text-xs font-bold text-white">{g.initial}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] md:text-xs font-semibold text-gray-800 truncate">{g.name}</p>
                <p className="text-[7px] md:text-[9px] text-gray-500">{g.role} guardian</p>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="text-[7px] md:text-[9px] text-emerald-600 font-medium">Ready</span>
              </div>
            </div>
          ))}
          <div className="mt-auto bg-primary/5 border border-primary/20 rounded-xl p-2 md:p-2.5 text-center">
            <p className="text-[8px] md:text-[10px] text-primary font-medium">All your people are ready to help</p>
          </div>
        </div>
      </div>
    );
  }

  if (stage === 2) {
    return (
      <div className="flex-1 flex flex-col bg-slate-50">
        <div className="bg-amber-500 text-white px-3.5 md:px-5 pt-5 md:pt-7 pb-2 md:pb-3 flex items-center gap-1.5">
          <AlertTriangle className="h-3 md:h-4 w-3 md:w-4" />
          <span className="text-[11px] md:text-sm font-semibold">Missed check in</span>
        </div>
        <div className="flex-1 px-3 md:px-5 py-3 md:py-5 flex flex-col gap-2.5">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 md:p-3 animate-[slideDown_0.5s_ease-out]">
            <p className="text-[10px] md:text-xs font-semibold text-amber-800 mb-0.5">We're trying to reach you</p>
            <p className="text-[8px] md:text-[10px] text-amber-700 leading-relaxed">
              Your scheduled check in was due at 9:00 AM. We're reminding you before alerting your Safety Circle.
            </p>
          </div>
          <div className="space-y-1.5">
            {[
              { label: "App reminder", status: "Sent", done: true },
              { label: "SMS to your phone", status: "Reply YES to check in", done: true, current: true },
              { label: "Phone call", status: "Next step", done: false },
              { label: "Notify Safety Circle", status: "Final step", done: false },
            ].map((s, i) => (
              <div key={i} className="bg-white rounded-lg p-2 border border-gray-100 flex items-center gap-2">
                <div className={`w-5 h-5 md:w-6 md:h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                  s.done ? "bg-emerald-500" : "bg-gray-200"
                }`}>
                  {s.done ? <Check className="h-3 w-3 text-white" /> : <span className="text-[8px] text-gray-500">{i + 1}</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[9px] md:text-[11px] font-medium text-gray-800 truncate">{s.label}</p>
                  <p className="text-[7px] md:text-[9px] text-gray-500 truncate">{s.status}</p>
                </div>
                {s.current && (
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                )}
              </div>
            ))}
          </div>
          <div className="mt-auto bg-emerald-500 rounded-xl py-2 md:py-2.5 text-center shadow-sm">
            <p className="text-[10px] md:text-xs font-bold text-white">I'M OK NOW</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-slate-50">
      <div className="bg-white px-3.5 md:px-5 pt-5 md:pt-7 pb-2 md:pb-3 flex items-center gap-1.5">
        <BarChart3 className="h-3 md:h-4 w-3 md:w-4 text-primary" />
        <span className="text-[11px] md:text-sm font-semibold text-gray-800">Safety Record</span>
      </div>
      <div className="flex-1 px-3 md:px-5 py-3 md:py-5 flex flex-col gap-2.5">
        <div className="text-center mb-1">
          <p className="text-[11px] md:text-sm font-bold text-gray-800">Your Safety Record is ready</p>
          <p className="text-[8px] md:text-[10px] text-gray-500">Week of April 26</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-xl p-2.5 border border-gray-100">
            <p className="text-[7px] md:text-[9px] text-gray-500 uppercase tracking-wider">Check-ins</p>
            <p className="text-base md:text-xl font-bold text-emerald-600">14</p>
            <p className="text-[7px] md:text-[9px] text-gray-500">all on time</p>
          </div>
          <div className="bg-white rounded-xl p-2.5 border border-gray-100">
            <p className="text-[7px] md:text-[9px] text-gray-500 uppercase tracking-wider">Arrivals</p>
            <p className="text-base md:text-xl font-bold text-primary">3</p>
            <p className="text-[7px] md:text-[9px] text-gray-500">confirmed</p>
          </div>
          <div className="bg-white rounded-xl p-2.5 border border-gray-100">
            <p className="text-[7px] md:text-[9px] text-gray-500 uppercase tracking-wider">Alerts</p>
            <p className="text-base md:text-xl font-bold text-amber-600">1</p>
            <p className="text-[7px] md:text-[9px] text-gray-500">resolved</p>
          </div>
          <div className="bg-white rounded-xl p-2.5 border border-gray-100">
            <p className="text-[7px] md:text-[9px] text-gray-500 uppercase tracking-wider">Circle</p>
            <p className="text-base md:text-xl font-bold text-violet-600">100%</p>
            <p className="text-[7px] md:text-[9px] text-gray-500">ready</p>
          </div>
        </div>
        <div className="mt-auto bg-emerald-50 border border-emerald-200 rounded-xl p-2 md:p-2.5">
          <p className="text-[9px] md:text-[11px] font-semibold text-emerald-800">A calm, steady week.</p>
          <p className="text-[7px] md:text-[9px] text-emerald-700 mt-0.5">StillHere watched the schedule. You stayed in control.</p>
        </div>
      </div>
    </div>
  );
}

function WatchScreen({ stage }: { stage: Stage }) {
  return (
    <div className="w-[88px] h-[108px] md:w-[110px] md:h-[135px] bg-gray-900 rounded-[1.75rem] md:rounded-[2.25rem] border-[2.5px] border-gray-700 shadow-2xl shadow-black/40 p-1 flex flex-col relative">
      <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 w-3 h-5 md:w-3.5 md:h-6 bg-gray-700 rounded-sm" />
      <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-3 h-5 md:w-3.5 md:h-6 bg-gray-700 rounded-sm" />
      <div className="absolute top-1/2 -right-[3px] -translate-y-1/2 w-[4px] h-5 bg-gray-600 rounded-r-sm" />
      <div className="flex-1 bg-black rounded-[1.4rem] md:rounded-[1.75rem] overflow-hidden flex flex-col">
        <div className="px-2 pt-2 md:pt-2.5 flex items-center gap-1">
          <img src={logoPath} alt="" className="h-2 w-2 md:h-2.5 md:w-2.5 object-contain" />
          <span className="text-[6px] md:text-[7px] font-semibold text-cyan-400">StillHere</span>
        </div>

        {stage === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center px-1.5 gap-1">
            <div className="w-9 h-9 md:w-11 md:h-11 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg">
              <Check className="h-5 w-5 md:h-6 md:w-6 text-white" strokeWidth={3} />
            </div>
            <p className="text-[7px] md:text-[8px] font-bold text-white">I'M OK</p>
          </div>
        )}

        {stage === 1 && (
          <div className="flex-1 flex flex-col items-center justify-center px-1.5 gap-0.5">
            <Heart className="h-3.5 w-3.5 md:h-4 md:w-4 text-red-500 animate-pulse" />
            <span className="text-[10px] md:text-xs font-bold text-red-400">72</span>
            <span className="text-[5px] md:text-[6px] text-gray-400">BPM</span>
            <p className="text-[5px] md:text-[6px] text-emerald-400 mt-0.5">Healthy</p>
          </div>
        )}

        {stage === 2 && (
          <div className="flex-1 flex flex-col items-center justify-center px-1.5 gap-0.5">
            <div className="w-7 h-7 md:w-9 md:h-9 rounded-full bg-red-500 flex items-center justify-center animate-pulse">
              <AlertTriangle className="h-4 w-4 md:h-5 md:w-5 text-white" />
            </div>
            <p className="text-[6px] md:text-[7px] font-bold text-red-400">SOS</p>
            <p className="text-[5px] md:text-[6px] text-gray-400">Alerting circle</p>
          </div>
        )}

        {stage === 3 && (
          <div className="flex-1 flex flex-col items-center justify-center px-1.5 gap-0.5">
            <div className="w-7 h-7 md:w-9 md:h-9 rounded-full bg-amber-500 flex items-center justify-center animate-pulse">
              <Activity className="h-4 w-4 md:h-5 md:w-5 text-white" />
            </div>
            <p className="text-[6px] md:text-[7px] font-bold text-amber-400">Possible fall sensed</p>
            <p className="text-[5px] md:text-[6px] text-gray-400">Are you okay?</p>
          </div>
        )}

        <div className="px-2 pb-1.5 md:pb-2">
          <div className={`rounded-md py-0.5 text-center ${stage === 2 || stage === 3 ? "bg-amber-500" : "bg-red-500"}`}>
            <span className="text-[6px] md:text-[7px] text-white font-semibold">
              {stage === 2 ? "Sent" : stage === 3 ? "Tap to cancel" : "SOS"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StageDots({ stage }: { stage: Stage }) {
  const labels = ["Daily check in", "Safety Circle", "Missed check in", "Safety Record"];
  return (
    <div className="flex items-center justify-center gap-1 mt-2" data-testid="animation-stage-indicator">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={`h-1 rounded-full transition-all duration-500 ${
            i === stage ? "w-6 md:w-7 bg-white" : "w-1.5 bg-white/30"
          }`}
        />
      ))}
      <span className="text-[8px] md:text-[9px] text-white/60 ml-1.5 font-medium min-w-[90px] md:min-w-[110px]">
        {labels[stage]}
      </span>
    </div>
  );
}

function NavLink({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <button
      onClick={onClick}
      className="text-sm font-medium text-foreground/80 hover:text-foreground transition-colors px-2 py-1"
      data-testid={testId}
    >
      {label}
    </button>
  );
}

function FloatingCard({ icon: Icon, title, body, color, className }: {
  icon: any; title: string; body: string; color: string; className: string;
}) {
  return (
    <div className={`absolute hidden 2xl:block w-[210px] bg-white/95 dark:bg-card backdrop-blur rounded-2xl p-3.5 shadow-xl shadow-black/10 border border-white/40 ${className}`}>
      <div className="flex items-start gap-2.5">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-[12px] font-semibold text-foreground leading-tight">{title}</p>
          <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{body}</p>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [, setLocation] = useLocation();
  const [stage, setStage] = useState<Stage>(0);

  useEffect(() => {
    const t = setTimeout(() => setStage(((stage + 1) % 4) as Stage), STAGE_DURATION);
    return () => clearTimeout(t);
  }, [stage]);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-background overflow-x-hidden">
      {/* NAVIGATION */}
      <header className="hidden md:block bg-background/80 backdrop-blur-md border-b border-border sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-3.5 flex items-center justify-between gap-4">
          <button onClick={() => scrollTo("hero")} className="flex items-center gap-2" data-testid="link-home">
            <img src={logoPath} alt="StillHere" className="h-7 w-7 object-contain" />
            <span className="text-lg font-bold tracking-tight" data-testid="text-landing-title">StillHere</span>
          </button>
          <nav className="flex items-center gap-1">
            <NavLink label="How it works" onClick={() => scrollTo("how-it-works")} testId="nav-how" />
            <NavLink label="Features" onClick={() => scrollTo("features")} testId="nav-features" />
            <NavLink label="Privacy" onClick={() => scrollTo("privacy")} testId="nav-privacy" />
            <NavLink label="Pricing" onClick={() => scrollTo("pricing")} testId="nav-pricing" />
            <NavLink label="Help" onClick={() => setLocation("/help")} testId="nav-help" />
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setLocation("/login")} data-testid="button-sign-in">
              Sign in
            </Button>
            <Button size="sm" onClick={() => setLocation("/login")} data-testid="button-start-trial-nav">
              Start free trial
            </Button>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section
        id="hero"
        className="relative min-h-[100dvh] md:min-h-0 flex flex-col bg-gradient-to-b md:bg-gradient-to-br from-primary via-primary to-primary/80 text-white overflow-hidden"
      >
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <div className="absolute top-16 left-8 md:top-20 md:left-20 w-32 md:w-72 h-32 md:h-72 rounded-full bg-white/20 blur-3xl" />
          <div className="absolute bottom-32 right-4 md:bottom-10 md:right-20 w-48 md:w-96 h-48 md:h-96 rounded-full bg-white/15 blur-3xl" />
        </div>

        <div className="relative flex-1 md:flex-none flex flex-col md:block px-6 pt-12 pb-6 md:py-20 max-w-6xl md:mx-auto w-full min-w-0">
          <div className="flex items-center gap-2 md:hidden mb-6 min-w-0 max-w-full">
            <img src={logoPath} alt="StillHere" className="h-7 w-7 object-contain" />
            <span className="text-lg font-semibold tracking-tight" data-testid="text-landing-title-mobile">StillHere</span>
          </div>

          <div className="md:grid md:grid-cols-2 md:gap-12 md:items-center flex-1 flex flex-col md:flex-none min-w-0">
            {/* COPY */}
            <div className="flex-1 flex flex-col justify-end md:justify-center md:block order-2 md:order-1 pt-2 md:pt-0 min-w-0 max-w-full">
              <div className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/15 rounded-full text-white text-xs font-medium mb-5">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Personal safety, check in, and SOS in one app</span>
              </div>
              <h1
                className="text-[1.65rem] min-[375px]:text-[1.75rem] md:text-5xl lg:text-[3.4rem] leading-[1.1] font-bold tracking-tight mb-3 md:mb-5 text-center md:text-left break-words max-w-[calc(100vw-3rem)] md:max-w-none mx-auto md:mx-0"
                data-testid="text-hero-title"
              >
                <span className="block text-white/85 text-[1.25rem] md:text-2xl lg:text-3xl font-semibold tracking-tight mb-2 md:mb-3">
                  Personal safety check-ins.
                </span>
                When you can't check in,{" "}
                <span className="text-white/90">StillHere checks on you.</span>
              </h1>
              <p className="text-[0.95rem] min-[375px]:text-[1rem] md:text-xl text-white/85 leading-relaxed mb-4 md:mb-5 text-center md:text-left break-words max-w-[calc(100vw-3rem)] md:max-w-none mx-auto md:mx-0">
                One tap tells your people you're okay. If you don't respond, StillHere escalates. Notification, SMS, phone call. Then attempts to reach your Safety Circle.
              </p>
              <p className="hidden md:block text-sm text-white/70 leading-relaxed mb-6 md:mb-8 text-left">
                Built for families, seniors, solo livers, and lone workers. Daily safety check ins, panic SOS button, fall sensing, live GPS location sharing, and a Safety Circle that gets clear next steps.
              </p>

              <div className="space-y-2.5 md:space-y-0 md:flex md:flex-wrap md:gap-3 max-w-[calc(100vw-3rem)] md:max-w-none mx-auto md:mx-0">
                <Button
                  size="lg"
                  className="w-full md:w-auto h-14 md:h-auto md:py-6 md:px-8 px-3 text-base md:text-lg font-semibold bg-white text-primary hover:bg-white/90 rounded-xl shadow-lg shadow-black/10 whitespace-normal leading-tight"
                  onClick={() => setLocation("/login")}
                  data-testid="button-get-started"
                >
                  Start your 14 day free trial
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full md:w-auto h-14 md:h-auto md:py-6 md:px-8 px-3 text-base md:text-lg font-semibold border-white/25 text-white bg-white/10 hover:bg-white/20 rounded-xl whitespace-normal leading-tight"
                  onClick={() => scrollTo("how-it-works")}
                  data-testid="button-see-how"
                >
                  See how it works
                </Button>
                <button
                  onClick={() => setLocation("/login")}
                  className="w-full md:hidden text-center text-white/70 text-sm py-1.5"
                  data-testid="button-sign-in-mobile"
                >
                  Already have an account? Sign in
                </button>
              </div>

              <div className="mt-5 md:mt-6 flex flex-wrap items-center justify-center md:justify-start gap-x-5 gap-y-1.5 text-white/85 text-[12px] md:text-sm">
                {["14 day free trial", "No credit card required", "Cancel anytime"].map((t) => (
                  <div key={t} className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-emerald-300" />
                    <span>{t}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* DEVICE MOCKUPS */}
            <div className="flex flex-col items-center order-1 md:order-2 mb-2 md:mb-0 relative min-w-0 max-w-full">
              <div className="relative flex items-end justify-center gap-2.5 md:gap-4 max-w-full">
                <div
                  className="w-[180px] h-[360px] md:w-[270px] md:h-[540px] bg-gray-900 rounded-[2rem] md:rounded-[3rem] border-[3px] border-gray-700 shadow-2xl shadow-black/40 p-1.5 md:p-2 flex flex-col relative"
                  data-testid="phone-mockup-animated"
                >
                  <div className="w-16 md:w-24 h-3.5 md:h-5 bg-gray-900 rounded-b-lg md:rounded-b-2xl mx-auto relative z-10 -mt-0.5" />
                  <div className="flex-1 bg-slate-50 rounded-[1.5rem] md:rounded-[2.25rem] overflow-hidden flex flex-col">
                    <PhoneScreen stage={stage} />
                  </div>
                </div>

                <div className="mb-6 md:mb-12">
                  <WatchScreen stage={stage} />
                </div>

                {/* Floating side cards (desktop only) */}
                <FloatingCard
                  icon={Bell}
                  title="Smart reminders"
                  body="If you miss a check in, we try notification, SMS, and call. One step at a time."
                  color="bg-primary"
                  className="-left-[230px] top-4"
                />
                <FloatingCard
                  icon={Users}
                  title="Automatic escalation"
                  body="If we still can't reach you, we attempt to reach your Safety Circle."
                  color="bg-violet-500"
                  className="-left-[230px] top-[155px]"
                />
                <FloatingCard
                  icon={MessageCircle}
                  title="Check in your way"
                  body="Use the app, reply by SMS, or confirm by phone call."
                  color="bg-emerald-500"
                  className="-right-[230px] top-4"
                />
                <FloatingCard
                  icon={ShieldCheck}
                  title="People you trust"
                  body="Your Safety Circle knows when action is needed."
                  color="bg-rose-500"
                  className="-right-[230px] top-[155px]"
                />
              </div>
              <StageDots stage={stage} />
            </div>
          </div>
        </div>

        <div className="md:hidden flex justify-center pb-4 motion-safe:animate-bounce">
          <ChevronDown className="h-5 w-5 text-white/40" />
        </div>
      </section>

      {/* HERO FEATURE STRIP (visible up to xl, replaces floating cards on smaller screens) */}
      <section className="2xl:hidden px-6 -mt-6 md:-mt-10 relative z-10 overflow-hidden">
        <div className="max-w-6xl md:mx-auto grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { icon: Bell, title: "Smart reminders", body: "Notification, SMS, and call. One step at a time.", color: "bg-primary" },
            { icon: Users, title: "Automatic escalation", body: "We attempt to reach your Safety Circle if we still can't reach you.", color: "bg-violet-500" },
            { icon: MessageCircle, title: "Check in your way", body: "App, SMS reply, or phone call.", color: "bg-emerald-500" },
            { icon: ShieldCheck, title: "People you trust", body: "Your Safety Circle knows when action is needed.", color: "bg-rose-500" },
          ].map((c) => (
            <div key={c.title} className="rounded-xl bg-card border border-border p-3 md:p-4 shadow-sm">
              <div className={`w-7 h-7 md:w-8 md:h-8 rounded-lg ${c.color} flex items-center justify-center mb-2`}>
                <c.icon className="h-3.5 w-3.5 md:h-4 md:w-4 text-white" />
              </div>
              <p className="text-[12px] md:text-sm font-semibold leading-tight">{c.title}</p>
              <p className="text-[11px] md:text-xs text-muted-foreground mt-0.5 leading-snug">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="px-6 py-16 md:py-24 bg-background">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-16">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 rounded-full text-primary text-xs font-medium mb-4">
              <Activity className="h-3.5 w-3.5" />
              <span>The safety loop</span>
            </div>
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">How StillHere works</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              A complete safety loop that keeps trying before we attempt to reach your people.
            </p>
          </div>

          {/* Mobile vertical */}
          <div className="space-y-6 md:hidden">
            {[
              { num: 1, title: "Daily check in", desc: "Tap I'M OK, reply YES by SMS, or confirm by phone call.", icon: Hand, color: "bg-primary" },
              { num: 2, title: "Missed check in detected", desc: "First, we notify you in the app.", icon: Bell, color: "bg-primary" },
              { num: 3, title: "SMS fallback", desc: "If you don't respond, we text you. Reply YES to check in.", icon: MessageCircle, color: "bg-primary" },
              { num: 4, title: "Phone call check in", desc: "Still no response? We call you. Press 1 to confirm you're okay.", icon: Phone, color: "bg-primary" },
              { num: 5, title: "Safety Circle reached", desc: "If we still can't reach you, we attempt to reach your guardians with clear next steps.", icon: Users, color: "bg-accent" },
            ].map((s, i, arr) => (
              <div key={s.num} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`w-11 h-11 rounded-2xl ${s.color} text-white flex items-center justify-center font-bold text-base flex-shrink-0 shadow-md`}>
                    <s.icon className="h-5 w-5" />
                  </div>
                  {i < arr.length - 1 && <div className="w-0.5 flex-1 bg-primary/20 mt-2" />}
                </div>
                <div className={i === arr.length - 1 ? "" : "pb-4"}>
                  <p className="text-[10px] font-semibold text-primary uppercase tracking-wider mb-0.5">Step {s.num}</p>
                  <h3 className="font-semibold text-base mb-1">{s.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop horizontal */}
          <div className="hidden md:grid md:grid-cols-5 gap-4">
            {[
              { num: 1, title: "Daily check in", desc: "Tap I'M OK, reply YES by SMS, or confirm by phone call.", icon: Hand, color: "bg-primary text-white", ring: "bg-primary/15 text-primary" },
              { num: 2, title: "Missed check in detected", desc: "First, we notify you in the app.", icon: Bell, color: "bg-primary text-white", ring: "bg-primary/15 text-primary" },
              { num: 3, title: "SMS fallback", desc: "If you don't respond, we text you. Reply YES to check in.", icon: MessageCircle, color: "bg-primary text-white", ring: "bg-primary/15 text-primary" },
              { num: 4, title: "Phone call check in", desc: "Still no response? We call you. Press 1 to confirm you're okay.", icon: Phone, color: "bg-primary text-white", ring: "bg-primary/15 text-primary" },
              { num: 5, title: "Safety Circle reached", desc: "If we still can't reach you, we attempt to reach your guardians with clear next steps.", icon: Users, color: "bg-accent text-white", ring: "bg-accent/15 text-accent" },
            ].map((s, i, arr) => (
              <div key={s.num} className="relative">
                <div className="text-center">
                  <div className={`relative w-16 h-16 rounded-2xl ${s.ring} flex items-center justify-center mx-auto mb-4`}>
                    <s.icon className="h-7 w-7" />
                    <div className={`absolute -top-2 -right-2 w-7 h-7 rounded-full ${s.color} text-xs font-bold flex items-center justify-center shadow-md`}>
                      {s.num}
                    </div>
                  </div>
                  <h3 className="font-semibold text-base mb-2">{s.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed px-1">{s.desc}</p>
                </div>
                {i < arr.length - 1 && (
                  <div className="hidden md:block absolute top-8 -right-2 z-10">
                    <ArrowRight className="h-4 w-4 text-muted-foreground/40" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* POSITIONING */}
      <section className="px-6 py-16 md:py-24 bg-gradient-to-b from-muted/40 to-background">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">More than a map. More than a panic button.</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              StillHere combines check ins, reminders, calls, location, and trusted people into one safety loop.
            </p>
          </div>

          <div className="md:grid md:grid-cols-3 md:gap-6 space-y-4 md:space-y-0">
            {[
              { title: "Not just tracking", body: "Location helps, but knowing someone is okay matters more.", icon: MapPin, color: "bg-primary/10 text-primary" },
              { title: "Not just reminders", body: "If you miss one, StillHere keeps trying before escalating.", icon: Bell, color: "bg-violet-100 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400" },
              { title: "Not just SOS", body: "SOS is there when you need it. StillHere also follows up when you forget, lose signal, or can't respond.", icon: ShieldCheck, color: "bg-emerald-100 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400" },
            ].map((c) => (
              <div key={c.title} className="rounded-2xl bg-card border border-border p-6 md:p-7 hover-elevate">
                <div className={`w-12 h-12 rounded-xl ${c.color} flex items-center justify-center mb-4`}>
                  <c.icon className="h-6 w-6" />
                </div>
                <h3 className="font-semibold text-lg mb-2">{c.title}</h3>
                <p className="text-sm md:text-base text-muted-foreground leading-relaxed">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* USE CASES */}
      <section className="px-6 py-16 md:py-24 bg-background">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">Made for real life</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              For the moments when someone should know you're okay.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
            {[
              { icon: Users, title: "Family safety", body: "A family check in app that does more than show a map. Daily check ins, SOS, and shared places.", color: "from-primary/10 to-primary/5 text-primary" },
              { icon: Heart, title: "Seniors and elderly parents", body: "GPS location, fall sensing, and gentle daily check ins. Reassurance without constant phone calls.", color: "from-rose-100 to-rose-50 dark:from-rose-900/20 dark:to-rose-900/10 text-rose-600 dark:text-rose-400" },
              { icon: HomeIcon, title: "Living alone", body: "An extra safety loop for solo livers. If something happens, the alert flow attempts to reach your people automatically.", color: "from-teal-100 to-teal-50 dark:from-teal-900/20 dark:to-teal-900/10 text-teal-600 dark:text-teal-400" },
              { icon: ShieldCheck, title: "Lone worker safety", body: "A check in app for lone workers and field staff. Safety timer, SOS, and shift tracking.", color: "from-indigo-100 to-indigo-50 dark:from-indigo-900/20 dark:to-indigo-900/10 text-indigo-600 dark:text-indigo-400" },
              { icon: MoonStar, title: "Night walks and late commute", body: "Share your walk home and alert your people if you stop or feel unsafe. Personal safety on your phone.", color: "from-violet-100 to-violet-50 dark:from-violet-900/20 dark:to-violet-900/10 text-violet-600 dark:text-violet-400" },
              { icon: Car, title: "Driving safety", body: "Possible crash alerts, live route, and auto SOS countdown. Drive with backup.", color: "from-amber-100 to-amber-50 dark:from-amber-900/20 dark:to-amber-900/10 text-amber-600 dark:text-amber-400" },
              { icon: Plane, title: "Solo travel", body: "Your Safety Circle stays informed when you're away from home.", color: "from-cyan-100 to-cyan-50 dark:from-cyan-900/20 dark:to-cyan-900/10 text-cyan-600 dark:text-cyan-400" },
              { icon: Stethoscope, title: "Recovery and post surgery", body: "Extra support after illness, surgery, or hospital discharge.", color: "from-emerald-100 to-emerald-50 dark:from-emerald-900/20 dark:to-emerald-900/10 text-emerald-600 dark:text-emerald-400" },
              { icon: Shield, title: "Women's safety", body: "Discreet panic SOS, live location share, and a circle of trusted people one tap away.", color: "from-pink-100 to-pink-50 dark:from-pink-900/20 dark:to-pink-900/10 text-pink-600 dark:text-pink-400" },
            ].map((u) => (
              <div key={u.title} className="rounded-2xl bg-card border border-border p-5 md:p-6 hover-elevate">
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${u.color} flex items-center justify-center mb-4`}>
                  <u.icon className="h-6 w-6" />
                </div>
                <h3 className="font-semibold text-base md:text-lg mb-1.5">{u.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{u.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURE GRID */}
      <section id="features" className="px-6 py-16 md:py-24 bg-muted/30">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 rounded-full text-primary text-xs font-medium mb-4">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Features</span>
            </div>
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">Everything you need to stay safe</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Powerful tools. Simple to use. Designed for everyday safety.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Hand, title: "One tap check in", body: "Confirm you're okay in seconds.", color: "bg-primary/10 text-primary" },
              { icon: MessageCircle, title: "SMS check in", body: "Reply YES to check in without opening the app.", color: "bg-emerald-100 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400" },
              { icon: Phone, title: "Phone call check in", body: "Press 1 during a call to confirm you're safe.", color: "bg-violet-100 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400" },
              { icon: AlertTriangle, title: "Panic SOS button", body: "One tap raises an alarm to your Safety Circle with location.", color: "bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400" },
              { icon: Users, title: "Safety Circle", body: "Choose primary, backup, and support guardians who get alerted.", color: "bg-rose-100 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400" },
              { icon: Bell, title: "Smart escalation", body: "Push, SMS, call, then Safety Circle. Each step in order.", color: "bg-amber-100 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400" },
              { icon: MapPin, title: "Live GPS location", body: "Share real time location when it matters and pause when it doesn't.", color: "bg-cyan-100 dark:bg-cyan-900/20 text-cyan-600 dark:text-cyan-400" },
              { icon: Footprints, title: "Safe Walk and Safe Ride", body: "Share your trip and get help if you don't arrive on time.", color: "bg-teal-100 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400" },
              { icon: Clock, title: "Safety Timer", body: "A dead man's switch for solo activities. Cancel before time runs out.", color: "bg-orange-100 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400" },
              { icon: Car, title: "Drive and possible crash alerts", body: "Speedometer, live route, and auto SOS countdown after a possible crash.", color: "bg-blue-100 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400" },
              { icon: Activity, title: "Fall sensing", body: "If a fall is sensed and you don't respond, StillHere starts the alert flow.", color: "bg-orange-100 dark:bg-orange-900/30 text-orange-500" },
              { icon: Map, title: "Geofencing", body: "Get alerts when someone arrives at home, school, or work, or leaves a safe zone.", color: "bg-lime-100 dark:bg-lime-900/20 text-lime-600 dark:text-lime-400" },
              { icon: Users, title: "Family Mode", body: "A map first family hub with live pins, shared places, and group chat.", color: "bg-purple-100 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400" },
              { icon: Eye, title: "Guardian Map", body: "One screen view of every person you watch. Color coded and live.", color: "bg-sky-100 dark:bg-sky-900/20 text-sky-600 dark:text-sky-400" },
              { icon: MoonStar, title: "Quiet hours", body: "Non emergency notifications won't wake you up.", color: "bg-indigo-100 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400" },
              { icon: BarChart3, title: "Weekly Safety Record", body: "A clear receipt of what was handled and what was resolved.", color: "bg-violet-100 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400" },
              { icon: Watch, title: "Smartwatch companion", body: "Check in, SOS, and fall sensing from your wrist. Optional heart rate view if you opt in.", color: "bg-fuchsia-100 dark:bg-fuchsia-900/20 text-fuchsia-600 dark:text-fuchsia-400" },
              { icon: Lock, title: "Privacy controls", body: "Precise, area only, presence only, or paused sharing. You decide.", color: "bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300" },
            ].map((f) => (
              <div key={f.title} className="rounded-xl bg-card border border-border p-5 hover-elevate" data-testid={`feature-${f.title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}>
                <div className={`w-10 h-10 rounded-lg ${f.color} flex items-center justify-center mb-3`}>
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-base mb-1">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SMARTWATCH */}
      <section className="px-6 py-16 md:py-24 bg-background">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-100 dark:bg-rose-900/30 rounded-full text-rose-600 dark:text-rose-400 text-xs font-medium mb-4">
              <Watch className="h-3.5 w-3.5" />
              <span>Smartwatch companion</span>
            </div>
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">Safety that stays with you</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Use StillHere from your phone or smartwatch, wherever you are.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5">
            {[
              { icon: Activity, title: "Fall sensing", body: "If a fall is sensed and you don't respond, StillHere can start the alert flow.", color: "bg-orange-100 dark:bg-orange-900/30 text-orange-500" },
              { icon: Hand, title: "Wrist check in", body: "Check in from your watch without reaching for your phone.", color: "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-500" },
              { icon: AlertTriangle, title: "SOS", body: "Trigger help quickly from your wrist.", color: "bg-red-100 dark:bg-red-900/30 text-red-500" },
              { icon: Heart, title: "Optional heart rate view", body: "Off by default. If you turn it on in Settings, you can view your heart rate in the app. StillHere is not a medical device.", color: "bg-rose-100 dark:bg-rose-900/30 text-rose-500" },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl bg-card border border-border p-5 md:p-6 hover-elevate">
                <div className={`w-11 h-11 rounded-xl ${f.color} flex items-center justify-center mb-3`}>
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-base mb-1.5">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 md:mt-10 bg-card rounded-2xl p-5 md:p-6 border border-border max-w-3xl mx-auto">
            <div className="flex items-start gap-3 md:gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Smartphone className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1 text-sm md:text-base">Phone only? The check in loop still works.</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  The full check in safety loop works without a smartwatch. Wearable features add an extra layer when you have one.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PRIVACY */}
      <section id="privacy" className="px-6 py-16 md:py-24 bg-gradient-to-b from-muted/40 to-background">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 rounded-full text-primary text-xs font-medium mb-4">
              <Lock className="h-3.5 w-3.5" />
              <span>Privacy first</span>
            </div>
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">Your privacy. Your choice.</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              StillHere is built for safety, not surveillance.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
            {[
              { icon: Lock, title: "You control sharing", body: "Choose precise location, general area, presence only, or paused sharing." },
              { icon: Eye, title: "See what they see", body: "Preview exactly what your guardian can see." },
              { icon: ShieldCheck, title: "Precise location during alerts", body: "When a real concern is active, precise location can be shared so your people can help." },
              { icon: EyeOff, title: "No selling your data", body: "Your safety information is not sold." },
              { icon: Users, title: "Only your people", body: "Your Safety Circle sees only what you choose to share." },
              { icon: Pause, title: "Pause anytime", body: "Pause sharing whenever you want with one tap." },
            ].map((p) => (
              <div key={p.title} className="rounded-2xl bg-card border border-border p-5 md:p-6 hover-elevate">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
                  <p.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold text-base mb-1.5">{p.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SERVER-SIDE CHECK-IN TRACKING */}
      <section className="px-6 py-16 md:py-24 bg-background">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-100 dark:bg-emerald-900/30 rounded-full text-emerald-600 dark:text-emerald-400 text-xs font-medium mb-4">
              <Server className="h-3.5 w-3.5" />
              <span>Server side schedule</span>
            </div>
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">StillHere checks your schedule even when your phone goes quiet</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              If your phone dies, loses signal, or you miss a check in, StillHere follows your safety plan from the server.
            </p>
          </div>

          <div className="md:grid md:grid-cols-3 md:gap-5 space-y-4 md:space-y-0">
            {[
              { icon: Server, title: "Server-side check-in tracking", body: "Your check-in schedule is tracked on our servers, so missed check-ins are still detected if your phone is offline.", color: "bg-primary/10 text-primary" },
              { icon: Smartphone, title: "Phone off? We still act.", body: "If you don't check in, StillHere starts the reminder flow automatically.", color: "bg-amber-100 dark:bg-amber-900/30 text-amber-500" },
              { icon: MessageCircle, title: "SMS alerts, not just apps", body: "Your Safety Circle can be reached by text when it matters.", color: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-500" },
            ].map((c) => (
              <div key={c.title} className="rounded-2xl bg-card border border-border p-5 md:p-6 text-center hover-elevate">
                <div className={`w-12 h-12 rounded-2xl ${c.color} flex items-center justify-center mx-auto mb-3`}>
                  <c.icon className="h-6 w-6" />
                </div>
                <h3 className="font-semibold mb-1.5 text-base md:text-lg">{c.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WHAT CONTACTS SEE */}
      <section className="px-6 py-16 md:py-24 bg-muted/30">
        <div className="max-w-6xl md:mx-auto md:grid md:grid-cols-2 md:gap-12 md:items-center">
          <div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 rounded-full text-primary text-xs font-medium mb-4">
              <Users className="h-3.5 w-3.5" />
              <span>Your Safety Circle</span>
            </div>
            <h2 className="text-2xl md:text-3xl font-bold mb-3 tracking-tight">Your people get clear next steps</h2>
            <p className="text-base text-muted-foreground mb-6 leading-relaxed">
              If StillHere can't reach you, your Safety Circle gets the information they need to act calmly.
            </p>

            <div className="space-y-2.5">
              {[
                "Your name and safety status",
                "Last check in time",
                "Location if sharing allows it",
                "What StillHere already tried",
                "Clear next steps",
              ].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
                    <Check className="h-3.5 w-3.5 text-accent" />
                  </div>
                  <span className="text-sm md:text-base">{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card rounded-2xl p-5 md:p-6 border border-border mt-8 md:mt-0 shadow-sm">
            <div className="flex items-center gap-3 pb-3 border-b border-border">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="font-semibold text-sm">StillHere Alert</p>
                <p className="text-xs text-muted-foreground">Sent to your guardians</p>
              </div>
            </div>
            <div className="pt-4 space-y-3 text-sm">
              <p className="font-semibold">Dauda missed a scheduled check in.</p>
              <p className="text-muted-foreground">We tried app reminder, SMS, and phone call.</p>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4 flex-shrink-0" />
                <span>Last known status: Quiet</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="h-4 w-4 flex-shrink-0" />
                <span>Location available</span>
              </div>
            </div>
            <div className="mt-4 bg-muted/50 rounded-xl p-3 md:p-4">
              <p className="text-xs md:text-sm font-semibold mb-2">What to do</p>
              <div className="space-y-1.5 text-xs md:text-sm text-muted-foreground">
                <p>1. Try calling them</p>
                <p>2. Send a message</p>
                <p>3. Check in person if you can</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SAFETY RECORD */}
      <section className="px-6 py-16 md:py-24 bg-background">
        <div className="max-w-6xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-violet-100 dark:bg-violet-900/30 rounded-full text-violet-600 dark:text-violet-400 text-xs font-medium mb-4">
              <BarChart3 className="h-3.5 w-3.5" />
              <span>Weekly safety record</span>
            </div>
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">A weekly Safety Record</h2>
            <p className="text-base md:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              See what StillHere handled, what was resolved, and when your Safety Circle was ready.
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
            {[
              { label: "Check-ins completed", value: "14", color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-900/10" },
              { label: "Arrivals confirmed", value: "3", color: "text-primary", bg: "bg-primary/5" },
              { label: "Alerts resolved", value: "1", color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-900/10" },
              { label: "Safety Circle ready", value: "100%", color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-900/10" },
            ].map((s) => (
              <div key={s.label} className={`rounded-2xl border border-border p-5 md:p-6 ${s.bg}`}>
                <p className={`text-3xl md:text-4xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs md:text-sm text-muted-foreground mt-1.5 leading-tight">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="px-6 py-16 md:py-24 bg-muted/30" data-testid="section-pricing">
        <div className="max-w-4xl md:mx-auto">
          <div className="text-center mb-12 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 rounded-full text-primary text-xs font-medium mb-4">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Simple pricing</span>
            </div>
            <h2 className="text-2xl md:text-4xl font-bold mb-3 tracking-tight">Simple pricing. Built for everyday safety.</h2>
            <p className="text-base md:text-lg text-muted-foreground leading-relaxed">
              Start free. Cancel anytime.
            </p>
          </div>

          <div className="md:grid md:grid-cols-2 md:gap-6 md:max-w-2xl md:mx-auto space-y-4 md:space-y-0">
            <div className="rounded-2xl border border-border bg-card p-6 md:p-8 text-center">
              <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">Monthly</p>
              <div className="mb-5">
                <span className="text-4xl md:text-5xl font-bold">$7.99</span>
                <span className="text-muted-foreground text-sm">/month</span>
              </div>
              <ul className="space-y-2.5 text-sm text-left mb-6">
                {["All core features", "Unlimited check ins", "Smart reminders and alerts", "Safety Circle notifications", "Cancel anytime"].map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-accent flex-shrink-0" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setLocation("/login")}
                data-testid="button-plan-monthly"
              >
                Start 14 day free trial
              </Button>
            </div>

            <div className="rounded-2xl border-2 border-primary bg-primary/5 p-6 md:p-8 text-center relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-xs font-semibold px-3 py-1 rounded-full">
                Best value
              </div>
              <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">Yearly</p>
              <div className="mb-1">
                <span className="text-4xl md:text-5xl font-bold">$59.99</span>
                <span className="text-muted-foreground text-sm">/year</span>
              </div>
              <p className="text-sm text-muted-foreground mb-5">That's about $5.00 per month</p>
              <ul className="space-y-2.5 text-sm text-left mb-6">
                {["All core features", "Everything in Monthly", "Best value for your safety", "Cancel anytime"].map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-accent flex-shrink-0" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Button
                className="w-full"
                onClick={() => setLocation("/login")}
                data-testid="button-plan-yearly"
              >
                Start 14 day free trial
              </Button>
            </div>
          </div>

          <p className="text-center text-xs md:text-sm text-muted-foreground mt-6">
            14 day free trial. No credit card required.
          </p>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="px-6 py-20 md:py-24 bg-gradient-to-br from-primary via-primary to-primary/80 text-white text-center relative overflow-hidden">
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <div className="absolute top-0 left-1/4 w-72 h-72 rounded-full bg-white/30 blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-72 h-72 rounded-full bg-white/20 blur-3xl" />
        </div>
        <div className="relative max-w-3xl md:mx-auto">
          <h2 className="text-2xl md:text-4xl font-bold mb-3 md:mb-4 tracking-tight">Start feeling safer today.</h2>
          <p className="text-white/85 md:text-xl mb-8 leading-relaxed">
            Set up StillHere in minutes and choose the people you trust.
          </p>
          <Button
            size="lg"
            className="w-full md:w-auto md:px-10 py-6 text-lg font-semibold bg-white text-primary hover:bg-white/90 rounded-xl shadow-lg shadow-black/10"
            onClick={() => setLocation("/login")}
            data-testid="button-get-started-bottom"
          >
            Start your 14 day free trial
          </Button>
          <p className="text-white/70 text-sm mt-5">No credit card required. Cancel anytime.</p>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="px-6 py-8 md:py-10 bg-background border-t border-border">
        <div className="max-w-6xl md:mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <img src={logoPath} alt="StillHere" className="h-5 w-5 object-contain" />
              <span className="hidden md:inline">StillHere. A safety check in app.</span>
              <span className="md:hidden">StillHere</span>
            </div>
            <div className="flex flex-wrap justify-center gap-4 md:gap-6">
              <button onClick={() => setLocation("/help")} className="hover:text-foreground" data-testid="link-footer-help">Help</button>
              <button onClick={() => setLocation("/trust")} className="hover:text-foreground" data-testid="link-footer-trust">Trust and Safety</button>
              <button onClick={() => setLocation("/tour")} className="hover:text-foreground" data-testid="link-footer-tour">Tour</button>
              <button onClick={() => setLocation("/privacy")} className="hover:text-foreground" data-testid="link-footer-privacy">Privacy</button>
              <button onClick={() => setLocation("/terms")} className="hover:text-foreground" data-testid="link-footer-terms">Terms</button>
            </div>
            <button
              onClick={() => scrollTo("hero")}
              className="hidden md:flex items-center gap-1 hover:text-foreground"
              data-testid="link-back-to-top"
            >
              <ChevronUp className="h-4 w-4" />
              Back to top
            </button>
          </div>
          <div className="hidden md:block mt-6 px-4 py-3 bg-muted/50 rounded-md text-xs text-muted-foreground text-center">
            <Shield className="h-3.5 w-3.5 inline mr-1" />
            The only messages you'll receive from StillHere are check in reminders and alerts you've set up yourself.
          </div>
        </div>
      </footer>
    </div>
  );
}
