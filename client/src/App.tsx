import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, RequireAuth, RequireSetup, RedirectIfAuth, useAuth } from "@/lib/auth";
import { IncomingCallOverlay } from "@/components/incoming-call";
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
import WatchedPage from "@/pages/watched";
import ChatPage from "@/pages/chat";
import CallPage from "@/pages/call";
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
      <Route path="/help" component={HelpPage} />
      <Route path="/trust" component={TrustPage} />
      <Route path="/emergency/:token" component={ContactPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <Toaster />
          <IncomingCallOverlay />
          <Router />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
