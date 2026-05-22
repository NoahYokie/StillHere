import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Heart, ArrowLeft, Fingerprint, Check, ShieldCheck } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { Checkbox } from "@/components/ui/checkbox";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { CapacitorCookies } from "@capacitor/core";
import { isNative } from "@/lib/capacitor";
import { NATIVE_API_ORIGIN, nativeAuthLog, setNativeSessionToken } from "@/lib/native-api";
import logoPath from "@assets/F0BE7587-0A49-40F7-A9A8-E7C53E58260F_1777863919813.png";

export default function LoginCodePage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [showPasskeySetup, setShowPasskeySetup] = useState(false);
  const [loginResult, setLoginResult] = useState<any>(null);
  const [resendCooldown, setResendCooldown] = useState(60);
  // COPPA / age gate (Batch 3, UX-corrected). The age-gate step is shown
  // ONLY when the server tells us this phone is a brand-new account
  // (response: age_gate_required). Returning users never see the checkbox.
  // The server keeps the OTP unused on age_gate_required, so the user can
  // re-submit the same code from the age-gate screen without a re-send.
  const [showAgeGate, setShowAgeGate] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [ageGateRefused, setAgeGateRefused] = useState(false);
  const [nativeAuthStatus, setNativeAuthStatus] = useState("");

  const params = new URLSearchParams(search);
  const phone = params.get("phone") || "";
  const nativeMode = params.get("mode") === "create" ? "create" : "signin";
  const nativeLogin = isNative();
  const formatPhone = (p: string) => {
    if (p.startsWith("+61")) {
      return "0" + p.slice(3);
    }
    return p;
  };
  const nativeCodeCopy = nativeMode === "create"
    ? {
        title: "Confirm your number",
        body: `Enter the 6-digit code sent to ${formatPhone(phone)} to start your StillHere setup.`,
        pending: "Creating account...",
      }
    : {
        title: "Enter your sign-in code",
        body: `We sent a 6-digit code to ${formatPhone(phone)}.`,
        pending: "Signing in...",
      };

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
      // Only send ageConfirmed once the user has actually checked the box on
      // the age-gate screen. For routine logins we omit the field entirely.
      const body: { phone: string; code: string; ageConfirmed?: boolean } = { phone, code };
      if (showAgeGate && ageConfirmed) body.ageConfirmed = true;
      if (nativeLogin) setNativeAuthStatus("Verifying code...");
      nativeAuthLog("otp_verify_started", { endpoint: "/api/auth/verify-code" });
      const res = await apiRequest("POST", "/api/auth/verify-code", body);
      nativeAuthLog("otp_verify_finished", {
        endpoint: "/api/auth/verify-code",
        status: res.status,
        ok: res.ok,
      });
      return res.json();
    },
    onSuccess: async (data: any) => {
      setShowAgeGate(false);
      setAgeGateRefused(false);
      setLoginResult(data);

      if (nativeLogin) {
        if (typeof data?.nativeSessionToken === "string" && data.nativeSessionToken.length > 0) {
          setNativeSessionToken(data.nativeSessionToken);
          nativeAuthLog("native_session_saved");
          setNativeAuthStatus("App session saved. Checking account...");
        } else {
          nativeAuthLog("native_session_missing");
          setNativeAuthStatus("Code accepted, but app session was not returned");
        }

        try {
          const cookieMap = await CapacitorCookies.getCookies({ url: NATIVE_API_ORIGIN });
          const authStoragePresent = Object.prototype.hasOwnProperty.call(cookieMap, "stillhere_session");
          nativeAuthLog("cookie_probe_after_verify", { authStoragePresent });
        } catch {
          nativeAuthLog("cookie_probe_after_verify_failed");
        }

        try {
          const meRes = await fetch("/api/auth/me", { credentials: "include" });
          const me = await meRes.json();
          nativeAuthLog("auth_me_after_verify", {
            status: meRes.status,
            ok: meRes.ok,
            authenticated: me?.authenticated === true,
          });
          if (!me?.authenticated) {
            setNativeAuthStatus("Code accepted, but app is still signed out");
            toast({
              title: "Sign in could not be completed",
              description: "The code was accepted, but the app could not keep your session. Please try again.",
              variant: "destructive",
            });
            return;
          }
        } catch {
          nativeAuthLog("auth_me_after_verify_failed");
          setNativeAuthStatus("Could not confirm signed-in session");
          return;
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });

      if (!nativeLogin && browserSupportsWebAuthn()) {
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
    onError: (error: Error) => {
      // apiRequest serialises non-2xx as "<status>: <body>". Detect the COPPA
      // gate response and switch to the age-gate step. Importantly, we keep
      // the entered code so the user can confirm and resubmit without
      // requesting a new SMS (the server leaves the OTP unused on this
      // response).
      try {
        const jsonStr = error.message.replace(/^\d+:\s*/, "");
        const parsed = JSON.parse(jsonStr);
        if (parsed?.error === "age_gate_required") {
          setShowAgeGate(true);
          setAgeGateRefused(false);
          return;
        }
      } catch {}
      toast({
        title: "That code didn't work",
        description: "Try again.",
        variant: "destructive",
      });
      if (nativeLogin) setNativeAuthStatus("Code verification failed");
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
    if (code.length !== 6) return;
    if (showAgeGate && !ageConfirmed) return;
    verifyCodeMutation.mutate();
  };

  // Auto-submit on the FIRST step only (full 6-digit code entered). On the
  // age-gate step the user must explicitly tap Continue after checking the
  // box, so we do not auto-submit there.
  useEffect(() => {
    if (
      code.length === 6 &&
      !showAgeGate &&
      !verifyCodeMutation.isPending &&
      !showPasskeySetup
    ) {
      verifyCodeMutation.mutate();
    }
  }, [code, showAgeGate]);

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

  if (nativeLogin) {
    return (
      <main className="min-h-screen bg-background px-6 py-8 flex flex-col">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setLocation("/login")}
            className="text-sm font-medium text-muted-foreground"
            data-testid="button-native-code-back"
          >
            Change number
          </button>
          <button
            type="button"
            onClick={() => setLocation("/help")}
            className="text-sm font-medium text-muted-foreground"
            data-testid="button-native-code-help"
          >
            Help
          </button>
        </div>

        <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
          <div className="mb-8 text-center">
            <img src={logoPath} alt="StillHere" className="w-16 h-16 object-contain mb-5 mx-auto" />
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary mb-5">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Secure verification
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              {showAgeGate ? "Before you continue" : nativeCodeCopy.title}
            </h1>
            <p className="mt-3 text-base leading-7 text-muted-foreground">
              {showAgeGate
                ? "Confirm your age to finish creating your StillHere account."
                : nativeCodeCopy.body}
            </p>
          </div>

          {!showAgeGate ? (
            <form onSubmit={handleSubmit} className="mt-9 space-y-6">
              <div className="flex justify-start">
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
                className="w-full h-14 rounded-2xl text-base font-semibold"
                disabled={code.length !== 6 || verifyCodeMutation.isPending}
                data-testid="button-verify"
              >
                {verifyCodeMutation.isPending ? nativeCodeCopy.pending : "Continue"}
              </Button>
              {nativeAuthStatus && (
                <p className="text-xs text-muted-foreground" data-testid="text-native-auth-status">
                  {nativeAuthStatus}
                </p>
              )}
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="mt-9 space-y-6">
              <div className="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/40 p-4">
                <Checkbox
                  id="age-confirm"
                  checked={ageConfirmed}
                  onCheckedChange={(v) => {
                    setAgeConfirmed(v === true);
                    if (v === true) setAgeGateRefused(false);
                  }}
                  className="mt-0.5"
                  data-testid="checkbox-age-confirm"
                />
                <label
                  htmlFor="age-confirm"
                  className="text-sm leading-relaxed text-foreground cursor-pointer select-none"
                >
                  I confirm I am 13 or older.
                </label>
              </div>
              {ageGateRefused && (
                <p className="text-sm text-destructive" data-testid="text-age-gate-error">
                  StillHere is not available for users under 13.
                </p>
              )}
              <Button
                type="submit"
                className="w-full h-14 rounded-2xl text-base font-semibold"
                disabled={!ageConfirmed || verifyCodeMutation.isPending}
                data-testid="button-age-confirm-continue"
              >
                {verifyCodeMutation.isPending ? "Creating account..." : "Continue"}
              </Button>
            </form>
          )}
        </div>

        {!showAgeGate && (
          <button
            onClick={() => resendMutation.mutate()}
            disabled={resendMutation.isPending || resendCooldown > 0}
            className="text-center text-sm font-medium text-primary disabled:text-muted-foreground"
            data-testid="button-resend"
          >
            {resendMutation.isPending ? "Sending..." : resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : "Resend code"}
          </button>
        )}
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-4">
            <Heart className="h-8 w-8 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-code-title">
            {showAgeGate ? "Before you continue" : "Enter code"}
          </CardTitle>
          <CardDescription>
            {showAgeGate
              ? "Confirm your age to finish creating your StillHere account."
              : `We sent a 6-digit code to ${formatPhone(phone)}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!showAgeGate ? (
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
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/40 p-3">
                <Checkbox
                  id="age-confirm"
                  checked={ageConfirmed}
                  onCheckedChange={(v) => {
                    setAgeConfirmed(v === true);
                    if (v === true) setAgeGateRefused(false);
                  }}
                  className="mt-0.5"
                  data-testid="checkbox-age-confirm"
                />
                <label
                  htmlFor="age-confirm"
                  className="text-sm leading-relaxed text-foreground cursor-pointer select-none"
                >
                  I confirm I am 13 or older.
                </label>
              </div>
              {ageGateRefused && (
                <p
                  className="text-sm text-destructive text-center"
                  data-testid="text-age-gate-error"
                >
                  StillHere is not available for users under 13.
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={!ageConfirmed || verifyCodeMutation.isPending}
                data-testid="button-age-confirm-continue"
              >
                {verifyCodeMutation.isPending ? "Creating account..." : "Continue"}
              </Button>
              <button
                type="button"
                onClick={() => setAgeGateRefused(true)}
                className="block w-full text-sm text-muted-foreground hover:underline text-center"
                data-testid="button-age-decline"
              >
                I'm under 13
              </button>
            </form>
          )}
          {!showAgeGate && (
            <div className="mt-6 flex flex-col items-center gap-3">
              <button
                onClick={() => resendMutation.mutate()}
                disabled={resendMutation.isPending || resendCooldown > 0}
                className="text-sm text-primary hover:underline disabled:opacity-50"
                data-testid="button-resend"
              >
                {resendMutation.isPending ? "Sending..." : resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
              </button>
              <BackButton
                to="/login"
                label="Change number"
                testId="button-change-number"
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
