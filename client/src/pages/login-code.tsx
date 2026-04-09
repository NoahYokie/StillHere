import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Heart, ArrowLeft, Fingerprint, Check } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export default function LoginCodePage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [showPasskeySetup, setShowPasskeySetup] = useState(false);
  const [loginResult, setLoginResult] = useState<any>(null);
  const [resendCooldown, setResendCooldown] = useState(60);

  const params = new URLSearchParams(search);
  const phone = params.get("phone") || "";

  useEffect(() => {
    if (!phone) {
      setLocation("/login");
    }
  }, [phone, setLocation]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const verifyCodeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/verify-code", { phone, code });
      return res.json();
    },
    onSuccess: async (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setLoginResult(data);

      if (browserSupportsWebAuthn()) {
        try {
          const pkRes = await fetch("/api/auth/passkeys", { credentials: "include" });
          const existingPasskeys = await pkRes.json();
          if (Array.isArray(existingPasskeys) && existingPasskeys.length === 0) {
            setShowPasskeySetup(true);
            return;
          }
        } catch {}
      }

      toast({ title: "You're signed in" });
      if (data.needsSetup) {
        setLocation("/setup");
      } else {
        setLocation("/");
      }
    },
    onError: () => {
      toast({
        title: "That code didn't work",
        description: "Try again.",
        variant: "destructive",
      });
      setCode("");
    },
  });

  const registerPasskeyMutation = useMutation({
    mutationFn: async () => {
      const optionsRes = await fetch("/api/auth/passkey/register-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!optionsRes.ok) throw new Error("Failed to get options");
      const options = await optionsRes.json();

      const regResponse = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(regResponse),
      });
      if (!verifyRes.ok) throw new Error("Failed to register passkey");
      return verifyRes.json();
    },
    onSuccess: () => {
      toast({ title: "Biometric sign-in set up", description: "Next time, sign in with just a tap." });
      finishLogin();
    },
    onError: (error: Error) => {
      if (error.name === "NotAllowedError") return;
      toast({ title: "Could not set up biometrics", description: "You can set this up later in Settings.", variant: "destructive" });
    },
  });

  const finishLogin = () => {
    if (loginResult?.needsSetup) {
      setLocation("/setup");
    } else {
      setLocation("/");
    }
  };

  const resendMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/send-code", { phone });
    },
    onSuccess: () => {
      setResendCooldown(30);
      toast({ title: "New code sent", description: "Check your phone." });
    },
    onError: (error: Error) => {
      try {
        const jsonStr = error.message.replace(/^\d+:\s*/, "");
        const parsed = JSON.parse(jsonStr);
        if (parsed.waitSeconds) {
          setResendCooldown(parsed.waitSeconds);
          return;
        }
      } catch {}
      toast({ title: "Could not resend code", description: "Please try again shortly." });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length === 6) {
      verifyCodeMutation.mutate();
    }
  };

  useEffect(() => {
    if (code.length === 6 && !verifyCodeMutation.isPending && !showPasskeySetup) {
      verifyCodeMutation.mutate();
    }
  }, [code]);

  const formatPhone = (p: string) => {
    if (p.startsWith("+61")) {
      return "0" + p.slice(3);
    }
    return p;
  };

  if (showPasskeySetup) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="h-8 w-8 text-white" />
            </div>
            <CardTitle className="text-2xl" data-testid="text-passkey-setup-title">You're signed in!</CardTitle>
            <CardDescription className="text-base mt-2">
              Set up biometric sign-in so next time you can skip the code.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              className="w-full h-14 text-base"
              size="lg"
              onClick={() => registerPasskeyMutation.mutate()}
              disabled={registerPasskeyMutation.isPending}
              data-testid="button-setup-passkey"
            >
              <Fingerprint className="h-5 w-5 mr-2" />
              {registerPasskeyMutation.isPending ? "Setting up..." : "Set up Face ID / fingerprint"}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={finishLogin}
              data-testid="button-skip-passkey"
            >
              Maybe later
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Uses your device's Face ID, Touch ID, fingerprint, or screen lock.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-4">
            <Heart className="h-8 w-8 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-code-title">Enter code</CardTitle>
          <CardDescription>
            We sent a 6-digit code to {formatPhone(phone)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={setCode}
                data-testid="input-otp"
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={code.length !== 6 || verifyCodeMutation.isPending}
              data-testid="button-verify"
            >
              {verifyCodeMutation.isPending ? "Verifying..." : "Continue"}
            </Button>
          </form>
          <div className="mt-6 flex flex-col items-center gap-3">
            <button
              onClick={() => resendMutation.mutate()}
              disabled={resendMutation.isPending || resendCooldown > 0}
              className="text-sm text-primary hover:underline disabled:opacity-50"
              data-testid="button-resend"
            >
              {resendMutation.isPending ? "Sending..." : resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
            </button>
            <button
              onClick={() => setLocation("/login")}
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="button-change-number"
            >
              <ArrowLeft className="h-4 w-4" />
              Change number
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
