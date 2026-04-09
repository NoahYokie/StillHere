import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { ArrowLeft, Bug, Star, CheckCircle, Clock, AlertTriangle, ChevronDown, ChevronUp, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

interface ErrorReport {
  id: string;
  userId: string | null;
  type: string;
  message: string;
  stack: string | null;
  url: string | null;
  userAgent: string | null;
  metadata: string | null;
  resolved: boolean;
  createdAt: string;
}

interface RatingWithUser {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  isOwn?: boolean;
  userName?: string;
}

interface RatingStats {
  average: number;
  total: number;
  distribution: Record<number, number>;
}

interface ErrorStats {
  total: number;
  unresolved: number;
  today: number;
}

function StarRow({ count, size = "sm" }: { count: number; size?: "sm" | "md" | "lg" }) {
  const sizeClass = size === "lg" ? "h-5 w-5" : size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`${sizeClass} ${s <= count ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/20"}`}
        />
      ))}
    </div>
  );
}

function RatingBar({ star, count, total }: { star: number; count: number; total: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-xs text-muted-foreground w-3 text-right">{star}</span>
      <div className="flex-1 h-2.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-yellow-400 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function formatRelativeTime(dateStr: string) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffWeek < 5) return `${diffWeek}w ago`;
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${diffYear}y ago`;
}

function getInitials(name: string) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

const AVATAR_COLORS = [
  "bg-blue-500", "bg-emerald-500", "bg-purple-500", "bg-orange-500",
  "bg-pink-500", "bg-teal-500", "bg-indigo-500", "bg-rose-500",
];

function getAvatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function FeedbackPage() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"ratings" | "errors">("ratings");
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: ratingStats } = useQuery<RatingStats>({ queryKey: ["/api/ratings/stats"] });
  const { data: ratings } = useQuery<RatingWithUser[]>({ queryKey: ["/api/ratings"] });
  const { data: errorStats } = useQuery<ErrorStats>({ queryKey: ["/api/errors/stats"] });
  const { data: errors } = useQuery<ErrorReport[]>({ queryKey: ["/api/errors"] });

  const resolveMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/errors/${id}/resolve`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/errors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/errors/stats"] });
      toast({ title: "Error marked as resolved" });
    },
    onError: () => {
      toast({ title: "Could not resolve error", variant: "destructive" });
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back-feedback">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">Feedback</h1>
        </div>
        <div className="flex border-b">
          <button
            onClick={() => setTab("ratings")}
            className={`flex-1 py-2.5 text-sm font-medium text-center border-b-2 transition-colors ${
              tab === "ratings" ? "border-primary text-primary" : "border-transparent text-muted-foreground"
            }`}
            data-testid="tab-ratings"
          >
            Ratings & Reviews
          </button>
          <button
            onClick={() => setTab("errors")}
            className={`flex-1 py-2.5 text-sm font-medium text-center border-b-2 transition-colors ${
              tab === "errors" ? "border-primary text-primary" : "border-transparent text-muted-foreground"
            }`}
            data-testid="tab-errors"
          >
            Error Reports
            {errorStats && errorStats.unresolved > 0 && (
              <Badge variant="destructive" className="ml-1.5 text-xs px-1.5 py-0">
                {errorStats.unresolved}
              </Badge>
            )}
          </button>
        </div>
      </div>

      <div className="p-4 max-w-lg mx-auto space-y-6">
        {tab === "ratings" && (
          <>
            {ratingStats && (
              <div className="py-4" data-testid="card-rating-overview">
                <div className="flex items-start gap-6">
                  <div className="text-center">
                    <div className="text-6xl font-bold tracking-tight leading-none">{ratingStats.average.toFixed(1)}</div>
                    <div className="mt-2">
                      <StarRow count={Math.round(ratingStats.average)} size="md" />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {ratingStats.total.toLocaleString()} {ratingStats.total === 1 ? "rating" : "ratings"}
                    </p>
                  </div>
                  <div className="flex-1 space-y-1.5 pt-1.5">
                    {[5, 4, 3, 2, 1].map((star) => (
                      <RatingBar
                        key={star}
                        star={star}
                        count={ratingStats.distribution[star] || 0}
                        total={ratingStats.total}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="border-t pt-4">
              {ratings && ratings.length > 0 ? (
                <div className="space-y-0">
                  {ratings.map((r, i) => {
                    const displayName = r.isOwn ? (r.userName || "You") : `User`;
                    const initials = r.isOwn ? getInitials(r.userName || "You") : "U";
                    return (
                      <div key={r.id} data-testid={`card-rating-${r.id}`}>
                        {i > 0 && <div className="border-t my-4" />}
                        <div className="py-1">
                          <div className="flex items-center gap-3 mb-2">
                            <div className={`w-9 h-9 rounded-full ${getAvatarColor(r.id)} flex items-center justify-center text-white text-xs font-bold`}>
                              {initials}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold truncate">{displayName}</p>
                              <div className="flex items-center gap-2">
                                <StarRow count={r.rating} size="sm" />
                                <span className="text-xs text-muted-foreground">{formatRelativeTime(r.createdAt)}</span>
                              </div>
                            </div>
                          </div>
                          {r.comment && (
                            <p className="text-sm text-foreground/80 leading-relaxed pl-12">{r.comment}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-16 text-muted-foreground" data-testid="text-no-ratings">
                  <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
                    <Star className="h-8 w-8 text-muted-foreground/30" />
                  </div>
                  <p className="font-medium">No ratings yet</p>
                  <p className="text-sm mt-1">Be the first to rate StillHere</p>
                </div>
              )}
            </div>
          </>
        )}

        {tab === "errors" && (
          <>
            {errorStats && (
              <div className="grid grid-cols-3 gap-3">
                <Card data-testid="card-error-total">
                  <CardContent className="p-3 text-center">
                    <div className="text-2xl font-bold">{errorStats.total}</div>
                    <div className="text-xs text-muted-foreground">Total</div>
                  </CardContent>
                </Card>
                <Card data-testid="card-error-unresolved">
                  <CardContent className="p-3 text-center">
                    <div className="text-2xl font-bold text-destructive">{errorStats.unresolved}</div>
                    <div className="text-xs text-muted-foreground">Unresolved</div>
                  </CardContent>
                </Card>
                <Card data-testid="card-error-today">
                  <CardContent className="p-3 text-center">
                    <div className="text-2xl font-bold">{errorStats.today}</div>
                    <div className="text-xs text-muted-foreground">Today</div>
                  </CardContent>
                </Card>
              </div>
            )}

            {errors && errors.length > 0 ? (
              <div className="space-y-3">
                {errors.map((err) => (
                  <Card
                    key={err.id}
                    className={err.resolved ? "opacity-60" : ""}
                    data-testid={`card-error-${err.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          {err.resolved ? (
                            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                          )}
                          <Badge variant="outline" className="text-xs">
                            {err.type.replace(/_/g, " ")}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatRelativeTime(err.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm font-medium break-all line-clamp-2 mb-2">{err.message}</p>
                      {err.url && (
                        <p className="text-xs text-muted-foreground break-all mb-2">{err.url}</p>
                      )}
                      <div className="flex items-center gap-2">
                        {!err.resolved && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => resolveMutation.mutate(err.id)}
                            disabled={resolveMutation.isPending}
                            data-testid={`button-resolve-${err.id}`}
                          >
                            <CheckCircle className="h-3.5 w-3.5 mr-1" />
                            Resolve
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setExpandedError(expandedError === err.id ? null : err.id)}
                          data-testid={`button-expand-${err.id}`}
                        >
                          {expandedError === err.id ? (
                            <ChevronUp className="h-3.5 w-3.5 mr-1" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 mr-1" />
                          )}
                          Details
                        </Button>
                      </div>
                      {expandedError === err.id && err.stack && (
                        <pre className="mt-3 p-3 bg-muted rounded-lg text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-48">
                          {err.stack}
                        </pre>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-16 text-muted-foreground" data-testid="text-no-errors">
                <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="h-8 w-8 text-muted-foreground/30" />
                </div>
                <p className="font-medium">No error reports</p>
                <p className="text-sm mt-1">Errors will appear here automatically</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
