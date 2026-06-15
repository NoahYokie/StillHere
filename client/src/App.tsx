import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, RequireAuth, RequireSetup, RedirectIfAuth, useAuth } from "@/lib/auth";
import { IncomingCallOverlay, setPendingIncomingCall } from "@/components/incoming-call";
import { NotificationBanner } from "@/components/notification-banner";
import { initNativeCall, isNativePlatform, setCallCallbacks } from "@/lib/native-call";
import { initCapacitorPlugins, isNative } from "@/lib/capacitor";
import { ErrorBoundary } from "@/components/error-boundary";
import { BackgroundLocationProvider } from "@/components/background-location-provider";
import { RatingPrompt } from "@/components/rating-prompt";
import { initErrorReporter } from "@/lib/error-reporter";
import { resumeLiveTrackingIfNeeded } from "@/lib/live-location";
import { startHeartbeat, stopHeartbeat } from "@/lib/heartbeat";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import LandingPage from "@/pages/landing";
import SettingsPage from "@/pages/settings";
import HelpPage from "@/pages/help";
import ContactPage from "@/pages/contact";
import LoginPage from "@/pages/login";
import LoginCodePage from "@/pages/login-code";
import OnboardingPage from "@/pages/onboarding";
import SetupNamePage from "@/pages/setup-name";
import SetupContactsPage from "@/pages/setup-contacts";
import SetupPreferencesPage from "@/pages/setup-preferences";
import SetupPermissionsPage from "@/pages/setup-permissions";
import TrustPage from "@/pages/trust";
import TourPage from "@/pages/tour";
import WatchedPage from "@/pages/watched";
import GuardianMapPage from "@/pages/guardian-map";
import ChatPage from "@/pages/chat";
import CallPage from "@/pages/call";
import ReportPage from "@/pages/report";
import InboxPage from "@/pages/inbox";
import DrivePage from "@/pages/drive";
import DriveHistoryPage from "@/pages/drive-history";
import DriveReportPage from "@/pages/drive-report";
import SatellitePage from "@/pages/satellite";
import LiveLocationPage from "@/pages/live-location";
import LiveLocationViewPage from "@/pages/live-location-view";
import PrivacyPolicyPage from "@/pages/privacy-policy";
import TermsOfServicePage from "@/pages/terms-of-service";
import SafetyTimerPage from "@/pages/safety-timer";
import SafeWalkPage from "@/pages/safe-walk";
import SavedPlacesPage from "@/pages/saved-places";
import WeeklyReportPage from "@/pages/weekly-report";
import SafetyCirclePage from "@/pages/safety-circle";
import SafetyCircleManagePage from "@/pages/safety-circle-manage";
import SafetyCircleGuardianViewPage from "@/pages/safety-circle-guardian-view";
import SafetyCircleDrillPage from "@/pages/safety-circle-drill";
import FamilyPage from "@/pages/family";
import BillingPage from "@/pages/billing";
import LimitationsPage from "@/pages/limitations";
import { LimitationsGate } from "@/lib/limitations-gate";
import { useLocation } from "wouter";
import { useEffect } from "react";
import logoPath from "@assets/F0BE7587-0A49-40F7-A9A8-E7C53E58260F_1777863919813.png";
import { Button } from "@/components/ui/button";
import { BellRing, CheckCircle2, Users } from "lucide-react";

function NativeWelcome() {
  const [, setLocation] = useLocation();
  const highlights = [
    { icon: CheckCircle2, label: "Daily check-ins" },
    { icon: BellRing, label: "Missed check-in alerts" },
    { icon: Users, label: "Safety Circle support" },
  ];

  return (
    <main className="min-h-screen bg-background px-6 py-8 flex flex-col">
      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        <div className="mb-8 text-center">
          <img src={logoPath} alt="StillHere" className="w-20 h-20 object-contain mb-5 mx-auto" />
          <p className="text-sm font-semibold text-primary mb-3">Personal safety check-ins</p>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground">
            StillHere
          </h1>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Stay connected with the people you trust. Check in on schedule, and StillHere helps alert them if you miss one.
          </p>
        </div>

        <div className="space-y-3 mb-9">
          {highlights.map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-3 text-sm text-foreground">
              <span className="w-9 h-9 rounded-2xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4" aria-hidden="true" />
              </span>
              <span className="font-medium">{label}</span>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <Button
            className="w-full h-14 rounded-2xl text-base font-semibold"
            onClick={() => setLocation("/login?mode=signin")}
            data-testid="button-native-sign-in"
          >
            Sign in
          </Button>
          <Button
            variant="outline"
            className="w-full h-14 rounded-2xl text-base font-semibold"
            onClick={() => setLocation("/login?mode=create")}
            data-testid="button-native-create-account"
          >
            Start setup
          </Button>
        </div>
      </div>

      <p className="text-center text-xs leading-5 text-muted-foreground max-w-xs mx-auto">
        StillHere is not an emergency service. Alerts go to the people you choose.
      </p>
    </main>
  );
}

function LandingOrHome() {
  const { auth, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && auth?.authenticated && auth?.needsSetup) {
      setLocation("/setup");
    }
  }, [auth, isLoading, setLocation]);

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

  if (auth?.authenticated && !auth?.needsSetup) {
    return <Home />;
  }

  if (isNative()) {
    return <NativeWelcome />;
  }

  return <LandingPage />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login">
        <RedirectIfAuth>
          <LoginPage />
        </RedirectIfAuth>
      </Route>
      <Route path="/login/code">
        <RedirectIfAuth>
          <LoginCodePage />
        </RedirectIfAuth>
      </Route>
      <Route path="/setup">
        <RequireAuth>
          <OnboardingPage />
        </RequireAuth>
      </Route>
      <Route path="/setup/name">
        <RequireAuth>
          <SetupNamePage />
        </RequireAuth>
      </Route>
      <Route path="/setup/contacts">
        <RequireAuth>
          <SetupContactsPage />
        </RequireAuth>
      </Route>
      <Route path="/setup/preferences">
        <RequireAuth>
          <SetupPreferencesPage />
        </RequireAuth>
      </Route>
      <Route path="/setup/permissions">
        <RequireAuth>
          <SetupPermissionsPage />
        </RequireAuth>
      </Route>
      <Route path="/">
        <LandingOrHome />
      </Route>
      <Route path="/settings">
        <RequireAuth>
          <RequireSetup>
            <SettingsPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/watched">
        <RequireAuth>
          <RequireSetup>
            <GuardianMapPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/watched/map">
        <RequireAuth>
          <RequireSetup>
            <GuardianMapPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/watched/list">
        <RequireAuth>
          <RequireSetup>
            <WatchedPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/inbox">
        <RequireAuth>
          <RequireSetup>
            <InboxPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/chat/:userId">
        <RequireAuth>
          <RequireSetup>
            <ChatPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/call/:userId">
        <RequireAuth>
          <RequireSetup>
            <CallPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/report/:userId">
        <RequireAuth>
          <RequireSetup>
            <ReportPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/drive">
        <RequireAuth><DrivePage /></RequireAuth>
      </Route>
      <Route path="/drive-history">
        <RequireAuth><DriveHistoryPage /></RequireAuth>
      </Route>
      <Route path="/drive-report/:userId">
        <RequireAuth><DriveReportPage /></RequireAuth>
      </Route>
      <Route path="/drive-report">
        <RequireAuth><DriveReportPage /></RequireAuth>
      </Route>
      <Route path="/satellite">
        <RequireAuth>
          <RequireSetup>
            <SatellitePage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/live-location">
        <RequireAuth>
          <RequireSetup>
            <LiveLocationPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/live-location/:userId">
        <RequireAuth>
          <RequireSetup>
            <LiveLocationViewPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/safety-timer">
        <RequireAuth>
          <RequireSetup>
            <SafetyTimerPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/saved-places">
        <RequireAuth><SavedPlacesPage /></RequireAuth>
      </Route>
      <Route path="/safe-walk">
        <RequireAuth>
          <RequireSetup>
            <SafeWalkPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/weekly-report">
        <RequireAuth><WeeklyReportPage /></RequireAuth>
      </Route>
      <Route path="/safety-circle">
        <RequireAuth>
          <RequireSetup>
            <SafetyCirclePage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/safety-circle/manage">
        <RequireAuth>
          <RequireSetup>
            <SafetyCircleManagePage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/safety-circle/guardian-view">
        <RequireAuth>
          <RequireSetup>
            <SafetyCircleGuardianViewPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/safety-circle/drill">
        <RequireAuth>
          <RequireSetup>
            <SafetyCircleDrillPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/family">
        <RequireAuth>
          <RequireSetup>
            <FamilyPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/billing">
        <RequireAuth>
          <BillingPage />
        </RequireAuth>
      </Route>
      <Route path="/limitations">
        <RequireAuth>
          <LimitationsPage />
        </RequireAuth>
      </Route>
      <Route path="/tour" component={TourPage} />
      <Route path="/help" component={HelpPage} />
      <Route path="/trust" component={TrustPage} />
      <Route path="/privacy" component={PrivacyPolicyPage} />
      <Route path="/terms" component={TermsOfServicePage} />
      <Route path="/emergency/:token" component={ContactPage} />
      <Route path="/e/:token" component={ContactPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function CapacitorInit() {
  const { auth } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (isNative()) {
      initCapacitorPlugins().catch((err) =>
        console.error("[App] Capacitor init failed:", err)
      );
    }
  }, []);

  useEffect(() => {
    if (auth?.authenticated && isNativePlatform()) {
      setCallCallbacks(
        async (callId, callerId) => {
          try {
            const response = await fetch(`/api/calls/${callId}/incoming`, { credentials: "include" });
            if (!response.ok) throw new Error(`status_${response.status}`);
            const call = await response.json();
            setPendingIncomingCall(call);
            setLocation(`/call/${callerId || call.callerId}?mode=answer&source=callkit`);
          } catch (err) {
            console.error("[App] Failed to load native answered call:", err);
            setLocation(callerId ? `/call/${callerId}` : "/watched/map?returnTo=%2F");
          }
        },
        (callId) => {
          console.log("[App] Native call ended:", callId);
        }
      );
      initNativeCall().catch((err) =>
        console.error("[App] Native call init failed:", err)
      );
    }
  }, [auth?.authenticated, setLocation]);

  useEffect(() => {
    const userId = auth?.user?.id;
    if (userId && isNative()) {
      import("@/lib/revenuecat")
        .then(({ configureRevenueCat }) => configureRevenueCat(userId))
        .catch((err) => console.error("[App] RevenueCat init failed:", err));
    }
  }, [auth?.user?.id]);

  useEffect(() => {
    if (auth?.authenticated) {
      resumeLiveTrackingIfNeeded().catch(() => {});
    }
  }, [auth?.authenticated]);

  useEffect(() => {
    if (auth?.authenticated) {
      startHeartbeat();
    } else {
      stopHeartbeat();
    }
    return () => stopHeartbeat();
  }, [auth?.authenticated]);

  return null;
}

function RouteMemory() {
  const [location] = useLocation();

  useEffect(() => {
    if (!location.startsWith("/call/")) {
      const search = typeof window !== "undefined" ? window.location.search : "";
      const currentRoute = `${location}${search}`;
      const lastRoute = sessionStorage.getItem("stillhere:lastNonCallRoute");
      if (lastRoute && lastRoute !== currentRoute) {
        sessionStorage.setItem("stillhere:previousRoute", lastRoute);
      }
      sessionStorage.setItem("stillhere:lastNonCallRoute", currentRoute);
    }
  }, [location]);

  return null;
}

initErrorReporter();

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <BackgroundLocationProvider>
              <Toaster />
              <IncomingCallOverlay />
              <NotificationBanner />
              <RatingPrompt />
              <RouteMemory />
              <CapacitorInit />
              <LimitationsGate />
              <Router />
            </BackgroundLocationProvider>
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
