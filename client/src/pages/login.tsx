import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Heart, HelpCircle, ArrowLeft, Fingerprint, Smartphone } from "lucide-react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [phone, setPhone] = useState("");
  const [showPhoneLogin, setShowPhoneLogin] = useState(false);
  const [supportsPasskey, setSupportsPasskey] = useState(false);

  useEffect(() => {
    setSupportsPasskey(browserSupportsWebAuthn());
  }, []);

  const passkeyLoginMutation = useMutation({
    mutationFn: async () => {
      const optionsRes = await fetch("/api/auth/passkey/auth-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!optionsRes.ok) throw new Error("Failed to get options");
      const options = await optionsRes.json();

      const authResponse = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/auth-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(authResponse),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || "Authentication failed");
      }
      return verifyRes.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "You're signed in" });
      if (data.needsSetup) {
        setLocation("/setup");
      } else {
        setLocation("/");
      }
    },
    onError: (error: Error) => {
      if (error.name === "NotAllowedError") return;
      toast({
        title: "Could not sign in",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const sendCodeMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
        credentials: "include",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to send code");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      const normalizedPhone = data.phone || phone;
      setLocation(`/login/code?phone=${encodeURIComponent(normalizedPhone)}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Could not send code",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handlePhoneSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.trim()) {
      sendCodeMutation.mutate();
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-4">
            <Heart className="h-8 w-8 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-login-title">StillHere</CardTitle>
          <CardDescription>Sign in to stay connected.</CardDescription>
        </CardHeader>
        <CardContent>
          {!showPhoneLogin ? (
            <div className="space-y-4">
              {supportsPasskey && (
                <Button
                  className="w-full h-14 text-base"
                  size="lg"
                  onClick={() => passkeyLoginMutation.mutate()}
                  disabled={passkeyLoginMutation.isPending}
                  data-testid="button-passkey-login"
                >
                  <Fingerprint className="h-5 w-5 mr-2" />
                  {passkeyLoginMutation.isPending ? "Authenticating..." : "Sign in with biometrics"}
                </Button>
              )}

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    {supportsPasskey ? "or" : "sign in with"}
                  </span>
                </div>
              </div>

              <Button
                variant="outline"
                className="w-full h-12"
                size="lg"
                onClick={() => setShowPhoneLogin(true)}
                data-testid="button-phone-login"
              >
                <Smartphone className="h-5 w-5 mr-2" />
                Use mobile number
              </Button>

              {supportsPasskey && (
                <p className="text-xs text-center text-muted-foreground">
                  Face ID, Touch ID, fingerprint, or screen lock
                </p>
              )}
            </div>
          ) : (
            <div>
              <form onSubmit={handlePhoneSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="phone">Mobile number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="e.g. 0412 345 678 (AU) or +1 555 123 4567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    autoFocus
                    data-testid="input-phone"
                  />
                  <p className="text-sm text-muted-foreground">
                    We'll send a one time code. No passwords needed.
                  </p>
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={!phone.trim() || sendCodeMutation.isPending}
                  data-testid="button-send-code"
                >
                  {sendCodeMutation.isPending ? "Sending..." : "Send secure code"}
                </Button>
              </form>
              <div className="mt-4 text-center">
                <button
                  onClick={() => setShowPhoneLogin(false)}
                  className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  data-testid="button-back-to-options"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to sign-in options
                </button>
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-col items-center gap-3">
            <button
              onClick={() => setLocation("/")}
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="link-back"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={() => setLocation("/help")}
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="link-help"
            >
              <HelpCircle className="h-4 w-4" />
              Need help?
            </button>
          </div>
          <div className="mt-6 p-3 bg-muted/50 rounded-md">
            <p className="text-xs text-muted-foreground text-center" data-testid="text-security-notice">
              The only messages you'll receive from StillHere are checkin reminders and alerts you've set up yourself.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
