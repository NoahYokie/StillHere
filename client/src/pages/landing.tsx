import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Heart, Bell, Users, Shield, ChevronDown, Check, Clock, MessageCircle, MapPin, HelpCircle } from "lucide-react";

export default function LandingPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <header className="hidden md:block bg-primary text-primary-foreground px-6 py-4 sticky top-0 z-50">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Heart className="h-6 w-6" />
            <span className="text-xl font-semibold" data-testid="text-landing-title">StillHere</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-primary-foreground"
              onClick={() => setLocation("/help")}
              data-testid="link-help"
            >
              <HelpCircle className="h-4 w-4 mr-1" />
              Help
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLocation("/login")}
              data-testid="button-sign-in"
            >
              Sign in
            </Button>
          </div>
        </div>
      </header>

      <section className="relative min-h-[100dvh] md:min-h-0 flex flex-col bg-gradient-to-b md:bg-gradient-to-br from-primary via-primary to-primary/80 text-white overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-16 left-8 md:top-20 md:left-20 w-32 md:w-64 h-32 md:h-64 rounded-full bg-white/20 blur-3xl" />
          <div className="absolute bottom-32 right-4 md:bottom-10 md:right-20 w-48 md:w-80 h-48 md:h-80 rounded-full bg-white/15 blur-3xl" />
        </div>

        <div className="relative flex-1 md:flex-none flex flex-col md:block px-6 pt-14 pb-8 md:py-24 max-w-5xl md:mx-auto md:w-full">
          <div className="flex items-center gap-2 md:hidden">
            <Heart className="h-7 w-7" />
            <span className="text-xl font-semibold" data-testid="text-landing-title-mobile">StillHere</span>
          </div>

          <div className="md:grid md:grid-cols-2 md:gap-12 md:items-center flex-1 flex flex-col md:flex-none">
            <div className="flex-1 flex flex-col justify-center md:block -mt-8 md:mt-0 order-2 md:order-1">
              <h1 className="text-[2rem] md:text-4xl lg:text-5xl leading-tight font-bold mb-4 md:mb-6 text-center md:text-left" data-testid="text-hero-title">
                Your family will always know you're okay.
              </h1>
              <p className="text-lg md:text-xl text-white/85 leading-relaxed mb-8 text-center md:text-left">
                One tap a day. That's all it takes to give your loved ones peace of mind.
              </p>

              <div className="space-y-3 md:space-y-0 md:flex md:flex-wrap md:gap-3">
                <Button
                  size="lg"
                  className="w-full md:w-auto py-6 md:px-8 text-lg font-semibold bg-white text-primary hover:bg-white/90"
                  onClick={() => setLocation("/login")}
                  data-testid="button-get-started"
                >
                  Get started — it's free
                </Button>
                <button
                  onClick={() => setLocation("/login")}
                  className="w-full md:hidden text-center text-white/70 text-sm py-2"
                  data-testid="button-sign-in-mobile"
                >
                  Already have an account? Sign in
                </button>
              </div>
            </div>

            <div className="flex justify-center order-1 md:order-2 mb-6 md:mb-0">
              <div className="relative">
                <div className="w-[200px] h-[400px] md:w-[270px] md:h-[540px] bg-gray-900 rounded-[2.25rem] md:rounded-[3rem] border-[3px] border-gray-700 shadow-2xl shadow-black/40 p-1.5 md:p-2 flex flex-col">
                  <div className="w-20 md:w-24 h-4 md:h-5 bg-gray-900 rounded-b-xl md:rounded-b-2xl mx-auto relative z-10 -mt-0.5" />
                  <div className="flex-1 bg-slate-50 dark:bg-slate-100 rounded-[1.75rem] md:rounded-[2.25rem] overflow-hidden flex flex-col">
                    <div className="bg-primary text-white px-4 md:px-5 pt-6 md:pt-8 pb-3 md:pb-4">
                      <div className="flex items-center gap-1.5 mb-0.5 md:mb-1">
                        <Heart className="h-3.5 md:h-4 w-3.5 md:w-4" />
                        <span className="text-xs md:text-sm font-semibold">StillHere</span>
                      </div>
                      <p className="text-[10px] md:text-xs text-white/70">Welcome, Sarah</p>
                    </div>
                    <div className="flex-1 px-3.5 md:px-5 py-3 md:py-4 flex flex-col gap-3 md:gap-4">
                      <div className="bg-white rounded-lg md:rounded-xl px-3 md:px-4 py-2 md:py-3 shadow-sm border border-gray-100 text-center">
                        <p className="text-[8px] md:text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Next check-in</p>
                        <p className="text-xs md:text-sm font-medium text-gray-800">9:00 AM tomorrow</p>
                      </div>
                      <div className="flex-1 flex flex-col items-center justify-center">
                        <div className="w-[4.5rem] h-[4.5rem] md:w-24 md:h-24 rounded-full bg-green-500 flex items-center justify-center shadow-lg">
                          <Check className="h-9 w-9 md:h-12 md:w-12 text-white" />
                        </div>
                        <p className="font-bold text-gray-800 text-sm md:text-base mt-2 md:mt-3">I'm OK</p>
                        <p className="text-[9px] md:text-[11px] text-gray-400 mt-0.5 md:mt-1">Tap once a day</p>
                      </div>
                      <div className="bg-red-500 rounded-lg md:rounded-xl py-2 md:py-2.5 text-center text-white text-xs md:text-sm font-semibold shadow-sm">
                        I Need Help
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="md:hidden flex justify-center pb-6 motion-safe:animate-bounce">
          <ChevronDown className="h-5 w-5 text-white/50" />
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-background max-w-5xl md:mx-auto">
        <p className="text-center text-sm font-medium text-muted-foreground uppercase tracking-wider mb-8 md:mb-12">
          For people who live alone
        </p>

        <div className="space-y-6 md:space-y-0 md:grid md:grid-cols-3 md:gap-8">
          <div className="flex items-start gap-4 p-4 rounded-xl bg-muted/50 md:flex-col md:items-center md:text-center md:bg-transparent md:p-6">
            <div className="w-10 h-10 md:w-14 md:h-14 rounded-full md:rounded-2xl bg-accent/15 flex items-center justify-center flex-shrink-0 md:mb-4">
              <Bell className="h-5 w-5 md:h-7 md:w-7 text-accent" />
            </div>
            <div>
              <h2 className="font-semibold mb-1 md:text-lg md:mb-2">One tap check-in</h2>
              <p className="text-sm md:text-base text-muted-foreground leading-relaxed">
                Tap the green button once a day. We'll remind you if you forget.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 p-4 rounded-xl bg-muted/50 md:flex-col md:items-center md:text-center md:bg-transparent md:p-6">
            <div className="w-10 h-10 md:w-14 md:h-14 rounded-full md:rounded-2xl bg-primary/15 flex items-center justify-center flex-shrink-0 md:mb-4">
              <Users className="h-5 w-5 md:h-7 md:w-7 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold mb-1 md:text-lg md:mb-2">Your people get notified</h2>
              <p className="text-sm md:text-base text-muted-foreground leading-relaxed">
                Choose up to 2 emergency contacts. They get a text if you don't check in.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 p-4 rounded-xl bg-muted/50 md:flex-col md:items-center md:text-center md:bg-transparent md:p-6">
            <div className="w-10 h-10 md:w-14 md:h-14 rounded-full md:rounded-2xl bg-destructive/15 flex items-center justify-center flex-shrink-0 md:mb-4">
              <Shield className="h-5 w-5 md:h-7 md:w-7 text-destructive" />
            </div>
            <div>
              <h2 className="font-semibold mb-1 md:text-lg md:mb-2">You stay in control</h2>
              <p className="text-sm md:text-base text-muted-foreground leading-relaxed">
                Location sharing is off by default. Pause alerts anytime. No tracking, ever.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-muted/30">
        <div className="max-w-5xl md:mx-auto">
          <h2 className="text-xl md:text-2xl font-bold mb-8 md:mb-12 text-center">How it works</h2>

          <div className="space-y-8 md:hidden">
            {[
              { num: "1", title: "Check in each day", desc: "Open the app and tap \"I'm OK\". Takes less than 2 seconds.", last: false, accent: false },
              { num: "2", title: "Miss a check-in?", desc: "We'll send you a reminder first. No panic, no rush.", last: false, accent: false },
              { num: "3", title: "Your contacts are notified", desc: "They receive a text message with a link to check on you. No app needed on their end.", last: false, accent: false },
              { num: "4", title: "Someone checks on you", desc: "Your family or friends can call, visit, or confirm they're on their way.", last: true, accent: true },
            ].map((step) => (
              <div key={step.num} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`w-9 h-9 rounded-full ${step.accent ? "bg-accent" : "bg-primary"} text-white flex items-center justify-center font-bold text-sm flex-shrink-0`}>
                    {step.num}
                  </div>
                  {!step.last && <div className="w-0.5 flex-1 bg-primary/20 mt-2" />}
                </div>
                <div className={step.last ? "" : "pb-2"}>
                  <h3 className="font-semibold mb-1">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden md:grid md:grid-cols-4 gap-8">
            {[
              { num: "1", title: "Check in each day", desc: "Open the app and tap \"I'm OK\". Takes 2 seconds.", accent: false },
              { num: "2", title: "Miss a check-in?", desc: "We send you a friendly reminder first. No panic.", accent: false },
              { num: "3", title: "Contacts notified", desc: "They get a text with a link to check on you.", accent: false },
              { num: "4", title: "Someone checks on you", desc: "They can call, visit, or confirm they're handling it.", accent: true },
            ].map((step) => (
              <div key={step.num} className="text-center">
                <div className={`w-12 h-12 rounded-full ${step.accent ? "bg-accent" : "bg-primary"} text-white flex items-center justify-center font-bold text-lg mx-auto mb-4`}>
                  {step.num}
                </div>
                <h3 className="font-semibold mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-background">
        <div className="max-w-5xl md:mx-auto md:grid md:grid-cols-2 md:gap-12 md:items-center">
          <div className="md:block">
            <h2 className="text-xl md:text-2xl font-bold mb-3 text-center md:text-left">What your contacts see</h2>
            <p className="text-sm text-muted-foreground text-center md:text-left mb-8 md:mb-6">They don't need the app. Just a text message.</p>

            <div className="hidden md:block space-y-3 mb-0">
              {[
                "Your name and current status",
                "When you last checked in",
                "Your location on a map (if enabled)",
                "Clear steps on what to do next",
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
                    <Check className="h-3 w-3 text-accent" />
                  </div>
                  <span className="text-sm">{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-muted/50 rounded-2xl p-5 md:p-6 space-y-4 border border-border">
            <div className="flex items-center gap-3 pb-3 border-b border-border">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center">
                <MessageCircle className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">StillHere Alert</p>
                <p className="text-xs text-muted-foreground">Text message received</p>
              </div>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4 flex-shrink-0" />
                <span>Last check-in: 9:15 AM yesterday</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="h-4 w-4 flex-shrink-0" />
                <span>Location shared (if enabled)</span>
              </div>
            </div>
            <div className="bg-background rounded-lg p-3 md:p-4">
              <p className="text-xs md:text-sm font-medium mb-2">What to do:</p>
              <div className="space-y-1 md:space-y-1.5 text-xs md:text-sm text-muted-foreground">
                <p>1. Try calling them</p>
                <p>2. Send a text message</p>
                <p>3. Visit or call emergency services</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-muted/30">
        <div className="max-w-3xl md:mx-auto text-center">
          <div className="inline-flex items-center gap-1 md:gap-1.5 px-3 md:px-4 py-1.5 md:py-2 bg-primary/10 rounded-full text-primary text-xs md:text-sm font-medium mb-4 md:mb-6">
            <Shield className="h-3.5 md:h-4 w-3.5 md:w-4" />
            <span>Private & Secure</span>
          </div>
          <h2 className="text-xl md:text-2xl font-bold mb-3 md:mb-4">Built for trust</h2>
          <p className="text-sm md:text-base text-muted-foreground leading-relaxed mb-8 md:mb-10 max-w-xl mx-auto">
            We don't track you. We don't sell your data. Location sharing is always your choice.
          </p>

          <div className="bg-background rounded-2xl p-5 md:p-8 border border-border max-w-lg mx-auto">
            <p className="text-base md:text-lg leading-relaxed mb-3 font-medium">
              "I live alone and this gives me real peace of mind knowing someone will check on me."
            </p>
            <p className="text-sm text-muted-foreground">— Solo dweller</p>
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20 bg-gradient-to-b md:bg-gradient-to-br from-primary to-primary/80 text-white text-center">
        <div className="max-w-3xl md:mx-auto">
          <h2 className="text-2xl md:text-3xl font-bold mb-3 md:mb-4">Ready to get started?</h2>
          <p className="text-white/80 md:text-xl mb-8">
            Set up in under 2 minutes. Free forever.
          </p>
          <Button
            size="lg"
            className="w-full md:w-auto md:px-10 py-6 text-lg font-semibold bg-white text-primary hover:bg-white/90"
            onClick={() => setLocation("/login")}
            data-testid="button-get-started-bottom"
          >
            Create your account
          </Button>
        </div>
      </section>

      <footer className="px-6 py-6 md:py-8 bg-background border-t border-border">
        <div className="max-w-5xl md:mx-auto">
          <div className="flex items-center justify-between text-sm text-muted-foreground md:flex-row">
            <div className="flex items-center gap-1.5 md:gap-2">
              <Heart className="h-4 w-4 text-primary" />
              <span className="hidden md:inline">StillHere — A safety check-in app</span>
              <span className="md:hidden">StillHere</span>
            </div>
            <div className="flex gap-4 md:gap-6">
              <button onClick={() => setLocation("/help")} className="hover:text-foreground" data-testid="link-footer-help">
                Help
              </button>
              <button onClick={() => setLocation("/trust")} className="hover:text-foreground" data-testid="link-footer-trust">
                Trust & Safety
              </button>
            </div>
          </div>
          <div className="hidden md:block mt-4 px-4 py-3 bg-muted/50 rounded-md text-xs text-muted-foreground text-center">
            <Shield className="h-3.5 w-3.5 inline mr-1" />
            The only messages you'll receive from StillHere are check-in reminders and alerts you've set up yourself.
          </div>
        </div>
      </footer>
    </div>
  );
}
