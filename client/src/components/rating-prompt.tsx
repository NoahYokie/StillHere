import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Star, X, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const RATING_CHECKIN_THRESHOLD = 5;
const RATING_DISMISS_KEY = "stillhere_rating_dismissed";
const RATING_DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000;

export function RatingPrompt() {
  const [visible, setVisible] = useState(false);
  const [rating, setRating] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: existingRating } = useQuery({
    queryKey: ["/api/ratings/mine"],
  });

  const { data: status } = useQuery<{ lastCheckin: { id: string } | null }>({
    queryKey: ["/api/status"],
  });

  useEffect(() => {
    if (existingRating) return;
    const dismissed = localStorage.getItem(RATING_DISMISS_KEY);
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      if (Date.now() - dismissedAt < RATING_DISMISS_DURATION) return;
    }
    const checkinCount = parseInt(localStorage.getItem("stillhere_checkin_count") || "0", 10);
    if (checkinCount >= RATING_CHECKIN_THRESHOLD) {
      const timer = setTimeout(() => setVisible(true), 3000);
      return () => clearTimeout(timer);
    }
  }, [existingRating]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ratings", { rating, comment: comment.trim() || undefined });
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ["/api/ratings/mine"] });
      toast({ title: "Thank you for your feedback!" });
      setTimeout(() => setVisible(false), 2000);
    },
    onError: () => {
      toast({ title: "Could not submit rating", description: "Please try again later", variant: "destructive" });
    },
  });

  const handleDismiss = () => {
    localStorage.setItem(RATING_DISMISS_KEY, String(Date.now()));
    setVisible(false);
  };

  if (!visible || existingRating) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4" data-testid="rating-prompt-overlay">
      <div className="bg-background rounded-2xl w-full max-w-sm p-6 shadow-xl animate-in slide-in-from-bottom-4">
        {submitted ? (
          <div className="text-center py-4" data-testid="rating-thank-you">
            <div className="text-4xl mb-2">🎉</div>
            <h3 className="text-lg font-semibold">Thank you!</h3>
            <p className="text-sm text-muted-foreground">Your feedback helps us improve.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">How are we doing?</h3>
              <Button variant="ghost" size="icon" onClick={handleDismiss} data-testid="button-dismiss-rating">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Your feedback helps us make StillHere better for everyone.
            </p>
            <div className="flex justify-center gap-2 mb-4" data-testid="rating-stars">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setRating(star)}
                  onMouseEnter={() => setHoveredStar(star)}
                  onMouseLeave={() => setHoveredStar(0)}
                  className="p-1 transition-transform hover:scale-110"
                  data-testid={`button-star-${star}`}
                >
                  <Star
                    className={`h-8 w-8 ${
                      star <= (hoveredStar || rating)
                        ? "fill-yellow-400 text-yellow-400"
                        : "text-muted-foreground"
                    }`}
                  />
                </button>
              ))}
            </div>
            {rating > 0 && (
              <div className="space-y-3 animate-in fade-in">
                <Textarea
                  placeholder="Any thoughts you'd like to share? (optional)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={1000}
                  className="resize-none"
                  rows={3}
                  data-testid="input-rating-comment"
                />
                <Button
                  onClick={() => submitMutation.mutate()}
                  disabled={submitMutation.isPending}
                  className="w-full"
                  data-testid="button-submit-rating"
                >
                  <Send className="h-4 w-4 mr-2" />
                  {submitMutation.isPending ? "Submitting..." : "Submit feedback"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
