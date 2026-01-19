import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Heart, HelpCircle } from "lucide-react";

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [phone, setPhone] = useState("");

  const sendCodeMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/send-code", { phone });
    },
    onSuccess: (data: any) => {
      const normalizedPhone = data.phone || phone;
      setLocation(`/login/code?phone=${encodeURIComponent(normalizedPhone)}`);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not send code. Please check your number.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
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
          <CardDescription>Sign in to check in.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Mobile number</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="e.g. 0412 345 678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                data-testid="input-phone"
              />
              <p className="text-sm text-muted-foreground">
                We'll send a 6-digit code by SMS.
              </p>
            </div>
            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={!phone.trim() || sendCodeMutation.isPending}
              data-testid="button-send-code"
            >
              {sendCodeMutation.isPending ? "Sending..." : "Send code"}
            </Button>
          </form>
          <div className="mt-6 text-center">
            <button
              onClick={() => setLocation("/help")}
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="link-help"
            >
              <HelpCircle className="h-4 w-4" />
              Need help?
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
