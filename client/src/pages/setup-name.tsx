import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Heart } from "lucide-react";

export default function SetupNamePage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [name, setName] = useState("");

  const setupMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/setup", { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      setLocation("/setup/contacts");
    },
    onError: (error: any) => {
      if (error?.requiresLogin) {
        setLocation("/login");
        return;
      }
      toast({
        title: "Error",
        description: "Could not save your name. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      setupMutation.mutate();
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-4">
            <Heart className="h-8 w-8 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-setup-title">Almost there!</CardTitle>
          <CardDescription>
            What should we call you?
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                placeholder="e.g., Mum, Dad, Grandma"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                data-testid="input-name"
              />
              <p className="text-sm text-muted-foreground">
                This is how you'll appear to your emergency contacts.
              </p>
            </div>
            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={!name.trim() || setupMutation.isPending}
              data-testid="button-continue"
            >
              {setupMutation.isPending ? "Saving..." : "Continue"}
            </Button>
          </form>

          <div className="flex justify-center gap-2 mt-6">
            <div className="w-2 h-2 rounded-full bg-primary" />
            <div className="w-2 h-2 rounded-full bg-muted" />
            <div className="w-2 h-2 rounded-full bg-muted" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
