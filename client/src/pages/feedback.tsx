import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { ArrowLeft, Bug, Star, CheckCircle, Clock, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function StarDisplay({ count }: { count: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`h-4 w-4 ${s <= count ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </div>
  );
}

function RatingBar({ star, count, total }: { star: number; count: number; total: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-4 text-right text-muted-foreground">{star}</span>
      <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-yellow-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-muted-foreground">{count}</span>
    </div>
  );
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
          <h1 className="text-lg font-semibold">App Feedback</h1>
        </div>
        <div className="flex border-b">
          <button
            onClick={() => setTab("ratings")}
            className={`flex-1 py-2.5 text-sm font-medium text-center border-b-2 transition-colors ${
              tab === "ratings" ? "border-primary text-primary" : "border-transparent text-muted-foreground"
            }`}
            data-testid="tab-ratings"
          >
            <Star className="h-4 w-4 inline mr-1.5" />
            Ratings
          </button>
          <button
            onClick={() => setTab("errors")}
            className={`flex-1 py-2.5 text-sm font-medium text-center border-b-2 transition-colors ${
              tab === "errors" ? "border-primary text-primary" : "border-transparent text-muted-foreground"
            }`}
            data-testid="tab-errors"
          >
            <Bug className="h-4 w-4 inline mr-1.5" />
            Error Reports
            {errorStats && errorStats.unresolved > 0 && (
              <Badge variant="destructive" className="ml-1.5 text-xs px-1.5 py-0">
                {errorStats.unresolved}
              </Badge>
            )}
          </button>
        </div>
      </div>

      <div className="p-4 max-w-lg mx-auto space-y-4">
        {tab === "ratings" && (
          <>
            {ratingStats && (
              <Card data-testid="card-rating-overview">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Overall Rating</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="text-4xl font-bold">{ratingStats.average.toFixed(1)}</div>
                    <div>
                      <StarDisplay count={Math.round(ratingStats.average)} />
                      <p className="text-sm text-muted-foreground mt-1">
                        {ratingStats.total} {ratingStats.total === 1 ? "rating" : "ratings"}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {[5, 4, 3, 2, 1].map((star) => (
                      <RatingBar
                        key={star}
                        star={star}
                        count={ratingStats.distribution[star] || 0}
                        total={ratingStats.total}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {ratings && ratings.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">Recent feedback</h3>
                {ratings.map((r) => (
                  <Card key={r.id} data-testid={`card-rating-${r.id}`}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <StarDisplay count={r.rating} />
                          <span className="text-sm font-medium">{r.isOwn ? (r.userName || "You") : "User"}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(r.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      {r.comment && (
                        <p className="text-sm text-muted-foreground">{r.comment}</p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground" data-testid="text-no-ratings">
                <Star className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>No ratings yet</p>
              </div>
            )}
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
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">
                            {new Date(err.createdAt).toLocaleString()}
                          </span>
                        </div>
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
                        <pre className="mt-3 p-3 bg-muted rounded text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-48">
                          {err.stack}
                        </pre>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground" data-testid="text-no-errors">
                <CheckCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>No error reports</p>
                <p className="text-sm mt-1">Errors will appear here automatically</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
