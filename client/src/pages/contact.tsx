import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Phone, MessageSquare, CheckCircle2, AlertTriangle, MapPin, Clock, User } from "lucide-react";
import type { ContactPageData } from "@shared/schema";
import { format, formatDistanceToNow } from "date-fns";

export default function ContactPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const [showHandleConfirm, setShowHandleConfirm] = useState(false);
  const [showEscalateConfirm, setShowEscalateConfirm] = useState(false);

  const { data, isLoading, error } = useQuery<ContactPageData>({
    queryKey: ["/api/c", token],
  });

  const handleMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/c/${token}/handle`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/c", token] });
      toast({
        title: "You're handling this",
        description: "We've paused further alerts while you check on them.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not update status. Please try again.",
        variant: "destructive",
      });
    },
  });

  const escalateMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/c/${token}/escalate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/c", token] });
      toast({
        title: "Alert escalated",
        description: "We will continue notifying other contacts.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not escalate. Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Invalid or Expired Link</h2>
            <p className="text-muted-foreground">
              This contact link is no longer valid. Please contact the person directly.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { user, contact, lastCheckin, incident, locationSession, handlingContact } = data;
  const hasActiveIncident = incident && incident.status !== "resolved";
  const isBeingHandled = incident?.status === "paused" && handlingContact;
  const isMissedCheckin = incident?.reason === "missed_checkin";
  const isSOS = incident?.reason === "sos";

  const getStatusColor = () => {
    if (isSOS) return "text-destructive";
    if (hasActiveIncident && !isBeingHandled) return "text-yellow-600 dark:text-yellow-500";
    if (isBeingHandled) return "text-primary";
    return "text-accent";
  };

  const getStatusText = () => {
    if (isSOS) return "Help requested";
    if (isBeingHandled) return `${handlingContact?.name} is checking on them`;
    if (hasActiveIncident) return "Pending";
    return "OK";
  };

  return (
    <div className="min-h-screen bg-background pb-12">
      {/* Header */}
      <header className="bg-primary text-primary-foreground px-6 py-4">
        <div className="max-w-md mx-auto">
          <h1 className="text-xl font-semibold" data-testid="text-app-title">StillHere</h1>
          <p className="text-sm opacity-90" data-testid="text-status-for">
            Status for {user.name}
          </p>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-6">
        {/* Status Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <User className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <CardTitle className="text-lg" data-testid="text-user-name">{user.name}</CardTitle>
                <CardDescription>
                  Last check-in:{" "}
                  <span data-testid="text-last-checkin">
                    {lastCheckin
                      ? formatDistanceToNow(new Date(lastCheckin.createdAt), { addSuffix: true })
                      : "Never"}
                  </span>
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Status:</span>
              <span className={`font-medium ${getStatusColor()}`} data-testid="text-status">
                {getStatusText()}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Alert Banner */}
        {hasActiveIncident && !isBeingHandled && (
          <Card className={isSOS ? "bg-destructive/10 border-destructive/30" : "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800"}>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className={`h-5 w-5 flex-shrink-0 mt-0.5 ${isSOS ? "text-destructive" : "text-yellow-600 dark:text-yellow-500"}`} />
                <div>
                  <p className={`font-medium ${isSOS ? "text-destructive" : "text-yellow-700 dark:text-yellow-400"}`}>
                    {isSOS ? "Help has been requested" : "Missed check-in"}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {isSOS
                      ? `${user.name} pressed the emergency button.`
                      : `${user.name} hasn't checked in as expected.`}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Contact Actions */}
        <div className="space-y-3">
          <Button
            variant="outline"
            size="lg"
            className="w-full justify-start gap-3"
            asChild
            data-testid="button-call"
          >
            <a href={`tel:${user.phone || ""}`}>
              <Phone className="h-5 w-5" />
              Call {user.name}
            </a>
          </Button>

          <Button
            variant="outline"
            size="lg"
            className="w-full justify-start gap-3"
            asChild
            data-testid="button-message"
          >
            <a href={`sms:${user.phone || ""}`}>
              <MessageSquare className="h-5 w-5" />
              Message {user.name}
            </a>
          </Button>
        </div>

        {/* Action Buttons */}
        {hasActiveIncident && !isBeingHandled && (
          <div className="space-y-3">
            <Button
              size="lg"
              className="w-full"
              onClick={() => setShowHandleConfirm(true)}
              disabled={handleMutation.isPending}
              data-testid="button-handling"
            >
              <CheckCircle2 className="h-5 w-5 mr-2" />
              I'm handling this
            </Button>

            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => setShowEscalateConfirm(true)}
              disabled={escalateMutation.isPending}
              data-testid="button-escalate"
            >
              I can't reach them
            </Button>
          </div>
        )}

        {/* Already Being Handled */}
        {isBeingHandled && (
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-primary">Being handled</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {handlingContact?.name} is checking on {user.name}.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Location */}
        {locationSession && locationSession.active && locationSession.lastLat && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <MapPin className="h-5 w-5" />
                Last known location
              </CardTitle>
              <CardDescription>
                <Clock className="h-3 w-3 inline mr-1" />
                {locationSession.lastTimestamp
                  ? formatDistanceToNow(new Date(locationSession.lastTimestamp), { addSuffix: true })
                  : "Unknown"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-muted rounded-lg h-48 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <MapPin className="h-8 w-8 mx-auto mb-2" />
                  <p className="text-sm" data-testid="text-location-coords">
                    {locationSession.lastLat.toFixed(4)}, {locationSession.lastLng?.toFixed(4)}
                  </p>
                  <p className="text-xs mt-1">Map view coming soon</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Location sharing is controlled by the user.
              </p>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Handle Confirmation Dialog */}
      <AlertDialog open={showHandleConfirm} onOpenChange={setShowHandleConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>I'm handling this</AlertDialogTitle>
            <AlertDialogDescription>
              We'll pause alerts while you check on them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-handle-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                handleMutation.mutate();
                setShowHandleConfirm(false);
              }}
              data-testid="button-handle-confirm"
            >
              I'm handling this
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Escalate Confirmation Dialog */}
      <AlertDialog open={showEscalateConfirm} onOpenChange={setShowEscalateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>I can't reach them</AlertDialogTitle>
            <AlertDialogDescription>
              We'll continue notifying other contacts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-escalate-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                escalateMutation.mutate();
                setShowEscalateConfirm(false);
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-escalate-confirm"
            >
              Escalate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
