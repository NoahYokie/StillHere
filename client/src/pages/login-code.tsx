import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Heart, ArrowLeft } from "lucide-react";

export default function LoginCodePage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  
  const params = new URLSearchParams(search);
  const phone = params.get("phone") || "";

  useEffect(() => {
    if (!phone) {
      setLocation("/login");
    }
  }, [phone, setLocation]);

  const verifyCodeMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/verify-code", { phone, code });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: "Signed in",
        description: "Welcome to StillHere.",
      });
      
      if (data.needsSetup) {
        setLocation("/setup");
      } else {
        setLocation("/");
      }
    },
    onError: () => {
      toast({
        title: "Invalid code",
        description: "Please check the code and try again.",
        variant: "destructive",
      });
      setCode("");
    },
  });

  const resendMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/send-code", { phone });
    },
    onSuccess: () => {
      toast({
        title: "Code resent",
        description: "Check your phone for the new code.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not resend code. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length === 6) {
      verifyCodeMutation.mutate();
    }
  };

  useEffect(() => {
    if (code.length === 6) {
      verifyCodeMutation.mutate();
    }
  }, [code]);

  const formatPhone = (p: string) => {
    if (p.startsWith("+61")) {
      return "0" + p.slice(3);
    }
    return p;
  };

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
              disabled={resendMutation.isPending}
              className="text-sm text-primary hover:underline disabled:opacity-50"
              data-testid="button-resend"
            >
              {resendMutation.isPending ? "Sending..." : "Resend code"}
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
