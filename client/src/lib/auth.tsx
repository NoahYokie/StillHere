import { createContext, useContext, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, isRecoverableAuthError, queryClient, throwIfResNotOk } from "./queryClient";
import { hydrateNativeSessionToken, isNativeApp } from "./native-api";

interface AuthUser {
  id: string;
  name: string;
  phone: string;
  timezone?: string | null;
  acknowledgedLimitationsAt?: string | null;
}

interface AuthState {
  authenticated: boolean;
  userId?: string;
  user?: AuthUser;
  needsSetup?: boolean;
  acknowledgedLimitationsAt?: string | null;
  hasActiveSafetyEvent?: boolean;
}

interface AuthContextValue {
  auth: AuthState | null;
  isLoading: boolean;
  isRecovering: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  auth: null,
  isLoading: true,
  isRecovering: false,
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [lastKnownAuth, setLastKnownAuth] = useState<AuthState | null>(null);
  const { data: auth, isLoading, error } = useQuery<AuthState>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      if (isNativeApp()) {
        await hydrateNativeSessionToken().catch(() => null);
      }
      const res = await fetch("/api/auth/me", { credentials: "include" });
      await throwIfResNotOk(res);
      return await res.json();
    },
    retry: false,
    staleTime: 30000,
  });
  const isRecovering = isRecoverableAuthError(error);
  const effectiveAuth = auth || (isRecovering ? lastKnownAuth : null);

  useEffect(() => {
    if (!isRecovering) return;
    const retry = window.setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    }, 5000);
    return () => window.clearTimeout(retry);
  }, [isRecovering]);

  useEffect(() => {
    if (auth?.authenticated) {
      setLastKnownAuth(auth);
    }
  }, [auth]);

  useEffect(() => {
    if (!effectiveAuth?.authenticated) return;
    let timezone = "";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {}
    if (!timezone || !timezone.includes("/") || effectiveAuth.user?.timezone === timezone) return;
    apiRequest("POST", "/api/settings", { timezone })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
        queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      })
      .catch(() => {});
  }, [effectiveAuth?.authenticated, effectiveAuth?.user?.timezone]);

  return (
    <AuthContext.Provider value={{ auth: effectiveAuth, isLoading, isRecovering }}>
      {children}
    </AuthContext.Provider>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { auth, isLoading, isRecovering } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isRecovering && !auth?.authenticated) {
      setLocation("/login");
    }
  }, [auth, isLoading, isRecovering, setLocation]);

  if (isLoading || isRecovering) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!auth?.authenticated) {
    return null;
  }

  return <>{children}</>;
}

export function RequireSetup({ children }: { children: React.ReactNode }) {
  const { auth, isLoading, isRecovering } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && auth?.authenticated && auth?.needsSetup) {
      setLocation("/setup");
    }
  }, [auth, isLoading, setLocation]);

  if (isLoading || isRecovering) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (auth?.needsSetup) {
    return null;
  }

  return <>{children}</>;
}

export function RedirectIfAuth({ children }: { children: React.ReactNode }) {
  const { auth, isLoading, isRecovering } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && auth?.authenticated) {
      if (auth.needsSetup) {
        setLocation("/setup");
      } else {
        setLocation("/");
      }
    }
  }, [auth, isLoading, setLocation]);

  if (isLoading || isRecovering) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (auth?.authenticated) {
    return null;
  }

  return <>{children}</>;
}
