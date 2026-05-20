import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { HelpCircle, ArrowLeft, Fingerprint, Smartphone } from "lucide-react";
import logoPath from "@assets/F0BE7587-0A49-40F7-A9A8-E7C53E58260F_1777863919813.png";
import { BackButton } from "@/components/back-button";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [phone, setPhone] = useState("");
  const [showPhoneLogin, setShowPhoneLogin] = useState(false);
  const [supportsPasskey, setSupportsPasskey] = useState(false);
  const [sendError, setSendError] = useState("");
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  useEffect(() => {
    setSupportsPasskey(browserSupportsWebAuthn());
  }, []);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setCooldownSeconds((s) => {
        if (s <= 1) { clearInterval(timer); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownSeconds]);

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
      setSendError("");
      const response = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
        credentials: "include",
      });
      if (!response.ok) {
        const errBody = await response.json();
        if (errBody.waitSeconds) {
          setCooldownSeconds(errBody.waitSeconds);
        }
        throw new Error(errBody.error || "Failed to send code");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      setSendError("");
      setCooldownSeconds(0);
      const normalizedPhone = data.phone || phone;
      setLocation(`/login/code?phone=${encodeURIComponent(normalizedPhone)}`);
    },
    onError: (error: Error) => {
      setSendError(error.message);
    },
  });

  const handlePhoneSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.trim()) {
      sendCodeMutation.mutate();
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-6 sm:p-6 overflow-x-hidden">
      <Card className="login-card overflow-hidden shadow-md shadow-primary/5 border-border/60">
        <CardHeader className="text-center pt-8 pb-2">
          <div className="relative mx-auto mb-5">
            <div className="absolute inset-0 rounded-full bg-primary/15 blur-xl" aria-hidden="true" />
            <img src={logoPath} alt="StillHere" className="relative w-20 h-20 object-contain mx-auto" />
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight" data-testid="text-login-title">
            StillHere
          </CardTitle>
          <CardDescription className="text-base mt-1.5" data-testid="text-login-subtitle">
            {showPhoneLogin ? "Your safety starts here" : "Fast, secure access"}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 pb-8 px-5 sm:px-6">
          {!showPhoneLogin ? (
            <div className="space-y-5">
              {supportsPasskey && (
                <div className="space-y-2">
                  <Button
                    className="w-full h-14 px-3 sm:px-8 text-base font-semibold rounded-xl shadow-sm shadow-primary/20 active:scale-[0.99] transition-transform whitespace-normal leading-tight"
                    size="lg"
                    onClick={() => passkeyLoginMutation.mutate()}
                    disabled={passkeyLoginMutation.isPending}
                    data-testid="button-passkey-login"
                    aria-label="Unlock with Face ID or fingerprint"
                  >
                    <Fingerprint className="h-5 w-5 mr-2" />
                    {passkeyLoginMutation.isPending ? "Authenticating..." : "Unlock with Face ID / Fingerprint"}
                  </Button>
                  <p className="text-xs text-center text-muted-foreground px-4">
                    Quick and secure. Only you can access your account.
                  </p>
                </div>
              )}

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border/60" />
                </div>
                <div className="relative flex justify-center text-xs uppercase tracking-wider">
                  <span className="bg-card px-3 text-muted-foreground">
                    {supportsPasskey ? "or" : "sign in with"}
                  </span>
                </div>
              </div>

              <Button
                variant="outline"
                className="w-full h-12 px-3 sm:px-8 rounded-xl font-medium whitespace-normal leading-tight"
                size="lg"
                onClick={() => setShowPhoneLogin(true)}
                data-testid="button-phone-login"
                aria-label="Use phone number to sign in instead"
              >
                <Smartphone className="h-5 w-5 mr-2" />
                Use phone number instead
              </Button>
            </div>
          ) : (
            <div>
              <form onSubmit={handlePhoneSubmit} className="space-y-5">
                <div className="space-y-2.5">
                  <Label htmlFor="phone" className="text-sm font-medium">Your mobile number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="e.g. 0412 345 678 (AU) or +1 555 123 4567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    autoFocus
                    className="h-12 rounded-xl text-base focus-visible:ring-primary min-w-0"
                    data-testid="input-phone"
                  />
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    We'll send a secure code to verify it's you. No passwords needed.
                  </p>
                </div>
                {sendError && (
                  <p className="text-sm text-destructive" data-testid="text-send-error">
                    {cooldownSeconds > 0
                      ? `Please wait ${cooldownSeconds}s before requesting another code.`
                      : sendError}
                  </p>
                )}
                <Button
                  type="submit"
                  className="w-full h-14 px-3 sm:px-8 text-base font-semibold rounded-xl shadow-sm shadow-primary/20 active:scale-[0.99] transition-transform whitespace-normal leading-tight"
                  size="lg"
                  disabled={!phone.trim() || sendCodeMutation.isPending || cooldownSeconds > 0}
                  data-testid="button-send-code"
                >
                  {sendCodeMutation.isPending
                    ? "Sending..."
                    : cooldownSeconds > 0
                      ? `Wait ${cooldownSeconds}s`
                      : "Continue securely"}
                </Button>
              </form>
              <div className="mt-5 flex justify-center">
                <BackButton
                  onClick={() => setShowPhoneLogin(false)}
                  label="Back to sign in options"
                  testId="button-back-to-options"
                />
              </div>
            </div>
          )}

          <div className="mt-7 flex flex-col items-center gap-3">
            {!showPhoneLogin && (
              <BackButton to="/" testId="link-back" />
            )}
            <button
              onClick={() => setLocation("/help")}
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="link-help"
            >
              <HelpCircle className="h-4 w-4" />
              Need help?
            </button>
          </div>

          <div className="mt-7 p-4 bg-muted/50 rounded-xl border border-border/40">
            {showPhoneLogin ? (
              <p className="text-xs text-muted-foreground text-center leading-relaxed" data-testid="text-security-notice">
                We only contact you for check ins and alerts you control. Never spam.
              </p>
            ) : (
              <div className="text-center space-y-1">
                <p className="text-xs font-semibold text-foreground" data-testid="text-privacy-title">
                  Your privacy comes first
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed" data-testid="text-privacy-body">
                  We never share your data. Alerts only go to people you choose.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
