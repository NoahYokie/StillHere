import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, RequireAuth, RequireSetup, RedirectIfAuth } from "@/lib/auth";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import SettingsPage from "@/pages/settings";
import HelpPage from "@/pages/help";
import ContactPage from "@/pages/contact";
import LoginPage from "@/pages/login";
import LoginCodePage from "@/pages/login-code";
import OnboardingPage from "@/pages/onboarding";
import SetupNamePage from "@/pages/setup-name";
import TrustPage from "@/pages/trust";

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
      <Route path="/">
        <RequireAuth>
          <RequireSetup>
            <Home />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/settings">
        <RequireAuth>
          <RequireSetup>
            <SettingsPage />
          </RequireSetup>
        </RequireAuth>
      </Route>
      <Route path="/help" component={HelpPage} />
      <Route path="/trust" component={TrustPage} />
      <Route path="/c/:token" component={ContactPage} />
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
          <Router />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
