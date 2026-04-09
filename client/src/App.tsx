import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, RequireAuth, RequireSetup, RedirectIfAuth, useAuth } from "@/lib/auth";
import { IncomingCallOverlay } from "@/components/incoming-call";
import { NotificationBanner } from "@/components/notification-banner";
import { initNativeCall, isNativePlatform } from "@/lib/native-call";
import { initCapacitorPlugins, isNative } from "@/lib/capacitor";
import { ErrorBoundary } from "@/components/error-boundary";
import { RatingPrompt } from "@/components/rating-prompt";
import { initErrorReporter } from "@/lib/error-reporter";
import { resumeLiveTrackingIfNeeded } from "@/lib/live-location";
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
import TrustPage from "@/pages/trust";
import TourPage from "@/pages/tour";
import WatchedPage from "@/pages/watched";
import ChatPage from "@/pages/chat";
import CallPage from "@/pages/call";
import ReportPage from "@/pages/report";
import InboxPage from "@/pages/inbox";
import DriveHistoryPage from "@/pages/drive-history";
import SatellitePage from "@/pages/satellite";
import LiveLocationPage from "@/pages/live-location";
import LiveLocationViewPage from "@/pages/live-location-view";
import { useLocation } from "wouter";
import { useEffect } from "react";

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
      <Route path="/drive-history">
        <RequireAuth><DriveHistoryPage /></RequireAuth>
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
      <Route path="/tour" component={TourPage} />
      <Route path="/help" component={HelpPage} />
      <Route path="/trust" component={TrustPage} />
      <Route path="/emergency/:token" component={ContactPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function CapacitorInit() {
  const { auth } = useAuth();

  useEffect(() => {
    if (isNative()) {
      initCapacitorPlugins().catch((err) =>
        console.error("[App] Capacitor init failed:", err)
      );
    }
  }, []);

  useEffect(() => {
    if (auth?.authenticated && isNativePlatform()) {
      initNativeCall().catch((err) =>
        console.error("[App] Native call init failed:", err)
      );
    }
  }, [auth?.authenticated]);

  useEffect(() => {
    if (auth?.authenticated) {
      resumeLiveTrackingIfNeeded().catch(() => {});
    }
  }, [auth?.authenticated]);

  return null;
}

initErrorReporter();

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <Toaster />
            <IncomingCallOverlay />
            <NotificationBanner />
            <RatingPrompt />
            <CapacitorInit />
            <Router />
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
