import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Shield, MapPin, Heart, Lock, Eye, Users, Mail } from "lucide-react";

export default function TrustPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary text-primary-foreground px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon" className="text-primary-foreground" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-page-title">Trust & Safety</h1>
            <p className="text-sm opacity-90">How StillHere protects you</p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-8">
        <section className="text-center space-y-4">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
            <Shield className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h2 className="text-2xl font-semibold" data-testid="text-intro-title">Safety without tracking</h2>
            <p className="text-muted-foreground mt-2 text-lg">
              Built for people who live alone and the people who care about them.
            </p>
          </div>
          <p className="text-lg font-medium text-primary">
            You stay in control. StillHere only acts when you don't respond.
          </p>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Heart className="h-5 w-5 text-primary" />
              How StillHere works
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>You choose when to check in.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>You tap "I'm OK" to confirm you're fine.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>If you don't respond, we notify your emergency contacts.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Your emergency contacts can check on you before anything else happens.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span><strong>StillHere does not monitor you continuously.</strong></span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              Location sharing (always your choice)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span><strong>Location sharing is OFF by default.</strong></span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>We never track your location unless you turn it on.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>You can turn location sharing off at any time, instantly.</span>
              </li>
            </ul>
            <p className="text-sm text-muted-foreground mt-4">
              If enabled, location is shared only during emergencies or shifts. 
              We do not create long-term location histories by default.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Human-first safety
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Emergency contacts are notified first.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>If a contact confirms they are checking on you, alerts are paused.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>In the current version, StillHere does not automatically contact emergency services.</span>
              </li>
            </ul>
            <p className="text-sm font-medium text-primary mt-4">
              People come before automation.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-primary" />
              What we never do
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-3">StillHere does not:</p>
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-destructive mt-1">✕</span>
                <span>Secretly track your location</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-destructive mt-1">✕</span>
                <span>Monitor your conversations</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-destructive mt-1">✕</span>
                <span>Record audio or video</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-destructive mt-1">✕</span>
                <span>Sell or share your data for advertising</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-destructive mt-1">✕</span>
                <span>Activate features without your consent</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              Minimal data by design
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground">
              We intentionally collect and store very little data:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Your most recent check-in time</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Short-lived alert events</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Location data only if enabled, and only when needed</span>
              </li>
            </ul>
            <p className="text-sm text-muted-foreground mt-4">
              This reduces risk and protects your privacy.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Security & misuse prevention
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-3">We actively protect the service:</p>
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Secure one-time login codes</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Rate limits to prevent spam or abuse</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Secure contact access links</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>Monitoring for unusual activity</span>
              </li>
            </ul>
            <p className="text-sm font-medium text-destructive mt-4">
              Misuse of StillHere is not tolerated.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-primary/5 border-primary/20">
          <CardHeader>
            <CardTitle>Our commitment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground">
              If StillHere ever changes in a meaningful way:
            </p>
            <ul className="space-y-2 text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>We will explain it clearly</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>We will not remove your control</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>We will not enable tracking without consent</span>
              </li>
            </ul>
            <p className="text-lg font-semibold text-primary mt-4">
              Trust is not a feature. It is the product.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              Contact
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Questions or concerns? We want to hear from you.
            </p>
            <p className="text-primary mt-2">
              support@stillhere.app
            </p>
          </CardContent>
        </Card>

        <section className="text-center py-8 border-t">
          <p className="text-sm text-muted-foreground">
            Last updated: {new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </section>
      </main>
    </div>
  );
}
