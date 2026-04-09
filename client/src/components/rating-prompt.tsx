import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const RATING_CHECKIN_THRESHOLD = 5;
const RATING_DISMISS_KEY = "stillhere_rating_dismissed";
const RATING_DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000;

const RATING_LABELS = ["", "Terrible", "Poor", "Okay", "Good", "Excellent"];
const RATING_EMOJIS = ["", "😞", "😕", "😐", "😊", "🤩"];

export function RatingPrompt() {
  const [visible, setVisible] = useState(false);
  const [rating, setRating] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [showComment, setShowComment] = useState(false);
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
      queryClient.invalidateQueries({ queryKey: ["/api/ratings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ratings/stats"] });
      toast({ title: "Thank you for your feedback!" });
      setTimeout(() => setVisible(false), 2500);
    },
    onError: () => {
      toast({ title: "Could not submit rating", description: "Please try again later", variant: "destructive" });
    },
  });

  const handleDismiss = () => {
    localStorage.setItem(RATING_DISMISS_KEY, String(Date.now()));
    setVisible(false);
  };

  const handleStarClick = (star: number) => {
    setRating(star);
    setShowComment(true);
  };

  const activeRating = hoveredStar || rating;

  if (!visible || existingRating) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" data-testid="rating-prompt-overlay">
      <div className="bg-background rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl animate-in zoom-in-95 fade-in duration-300">
        {submitted ? (
          <div className="text-center py-12 px-6" data-testid="rating-thank-you">
            <div className="text-6xl mb-4 animate-in zoom-in duration-300">🎉</div>
            <h3 className="text-xl font-bold mb-1">Thank you!</h3>
            <p className="text-sm text-muted-foreground">Your feedback helps us improve StillHere.</p>
          </div>
        ) : (
          <>
            <div className="relative pt-8 pb-4 px-6 text-center">
              <button
                onClick={handleDismiss}
                className="absolute top-3 right-3 p-2 rounded-full hover:bg-muted transition-colors"
                data-testid="button-dismiss-rating"
              >
                <X className="h-5 w-5 text-muted-foreground" />
              </button>

              <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Star className="h-7 w-7 text-primary" />
              </div>
              <h3 className="text-xl font-bold mb-1">Enjoying StillHere?</h3>
              <p className="text-sm text-muted-foreground">Tap a star to rate your experience</p>
            </div>

            <div className="px-6 pb-2">
              <div className="flex justify-center gap-3 py-4" data-testid="rating-stars">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => handleStarClick(star)}
                    onMouseEnter={() => setHoveredStar(star)}
                    onMouseLeave={() => setHoveredStar(0)}
                    className="group p-1 transition-all duration-200 active:scale-90"
                    data-testid={`button-star-${star}`}
                  >
                    <Star
                      className={`h-10 w-10 transition-all duration-200 ${
                        star <= activeRating
                          ? "fill-yellow-400 text-yellow-400 scale-110"
                          : "text-muted-foreground/30 group-hover:text-muted-foreground/50"
                      }`}
                    />
                  </button>
                ))}
              </div>

              <div className={`text-center h-8 transition-opacity duration-200 ${activeRating > 0 ? "opacity-100" : "opacity-0"}`}>
                <span className="text-2xl mr-1.5">{RATING_EMOJIS[activeRating]}</span>
                <span className="text-sm font-medium text-muted-foreground">{RATING_LABELS[activeRating]}</span>
              </div>
            </div>

            {showComment && (
              <div className="px-6 pb-6 space-y-3 animate-in slide-in-from-bottom-2 fade-in duration-300">
                <Textarea
                  placeholder="Tell us more (optional)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={1000}
                  className="resize-none rounded-xl border-muted bg-muted/30 focus:bg-background transition-colors"
                  rows={3}
                  data-testid="input-rating-comment"
                />
                <Button
                  onClick={() => submitMutation.mutate()}
                  disabled={submitMutation.isPending}
                  className="w-full h-12 rounded-xl text-base font-semibold"
                  data-testid="button-submit-rating"
                >
                  {submitMutation.isPending ? "Submitting..." : "Submit"}
                </Button>
                <button
                  onClick={handleDismiss}
                  className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
                  data-testid="button-not-now"
                >
                  Not now
                </button>
              </div>
            )}

            {!showComment && <div className="h-6" />}
          </>
        )}
      </div>
    </div>
  );
}
