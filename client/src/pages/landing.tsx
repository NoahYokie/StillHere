import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Heart, Bell, Shield, Users, HelpCircle } from "lucide-react";

export default function LandingPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary text-primary-foreground px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Heart className="h-6 w-6" />
            <h1 className="text-xl font-semibold" data-testid="text-landing-title">StillHere</h1>
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

      <main className="max-w-2xl mx-auto px-6 py-12">
        <section className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4" data-testid="text-hero-title">
            Let your family know you're okay
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            A simple daily check-in for people who live alone.
            <br />
            No tracking. No fuss. Just peace of mind.
          </p>
          <Button
            size="lg"
            className="px-8"
            onClick={() => setLocation("/login")}
            data-testid="button-get-started"
          >
            Get started
          </Button>
        </section>

        <section className="grid gap-6 md:grid-cols-3 mb-12">
          <Card>
            <CardContent className="pt-6 text-center">
              <div className="w-12 h-12 bg-accent/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Bell className="h-6 w-6 text-accent" />
              </div>
              <h3 className="font-semibold mb-2">Simple check-in</h3>
              <p className="text-sm text-muted-foreground">
                Tap "I'm OK" once a day. That's it.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 text-center">
              <div className="w-12 h-12 bg-primary/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold mb-2">Your emergency contacts</h3>
              <p className="text-sm text-muted-foreground">
                Choose who gets notified if you don't respond.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 text-center">
              <div className="w-12 h-12 bg-destructive/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Shield className="h-6 w-6 text-destructive" />
              </div>
              <h3 className="font-semibold mb-2">You stay in control</h3>
              <p className="text-sm text-muted-foreground">
                Location sharing is off by default. Pause anytime.
              </p>
            </CardContent>
          </Card>
        </section>

        <section className="mb-12">
          <h3 className="text-xl font-semibold mb-6 text-center">How it works</h3>
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 font-semibold">
                1
              </div>
              <div>
                <p className="font-medium">You check in each day</p>
                <p className="text-sm text-muted-foreground">
                  Just tap the green button to let us know you're okay.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 font-semibold">
                2
              </div>
              <div>
                <p className="font-medium">We send you a reminder first</p>
                <p className="text-sm text-muted-foreground">
                  If you miss your check-in, we'll remind you before alerting anyone.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 font-semibold">
                3
              </div>
              <div>
                <p className="font-medium">Your emergency contacts are notified</p>
                <p className="text-sm text-muted-foreground">
                  They receive a message with a link to check on you. No app needed on their end.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 font-semibold">
                4
              </div>
              <div>
                <p className="font-medium">They check on you first</p>
                <p className="text-sm text-muted-foreground">
                  Your family or friends can call, visit, or let us know they're handling it.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="text-center mb-12">
          <Card className="bg-muted/50">
            <CardContent className="pt-6">
              <p className="text-lg font-medium mb-2">
                "I don't want to be found weeks later. This gives me peace of mind."
              </p>
              <p className="text-sm text-muted-foreground">
                Someone who lives alone
              </p>
            </CardContent>
          </Card>
        </section>

        <section className="text-center">
          <h3 className="text-xl font-semibold mb-4">Ready to get started?</h3>
          <p className="text-muted-foreground mb-6">
            It takes less than 2 minutes to set up.
          </p>
          <Button
            size="lg"
            className="px-8"
            onClick={() => setLocation("/login")}
            data-testid="button-get-started-bottom"
          >
            Get started
          </Button>
        </section>
      </main>

      <footer className="border-t mt-12 py-6 px-6">
        <div className="max-w-2xl mx-auto flex flex-col items-center gap-4 text-sm text-muted-foreground">
          <p className="text-center px-4 py-3 bg-muted/50 rounded-md" data-testid="text-security-notice">
            <Shield className="h-4 w-4 inline mr-1" />
            StillHere will never call, text, or email you asking for personal information, passwords, or payment. If someone contacts you claiming to be from StillHere and asks for this information, do not respond as this is likely a fraudulent attempt.
          </p>
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 w-full">
            <p>StillHere — A safety check-in app</p>
            <div className="flex gap-4">
              <button
                onClick={() => setLocation("/help")}
                className="hover:text-foreground"
                data-testid="link-footer-help"
              >
                Help
              </button>
              <button
                onClick={() => setLocation("/trust")}
                className="hover:text-foreground"
                data-testid="link-footer-trust"
              >
                Trust & Safety
              </button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
