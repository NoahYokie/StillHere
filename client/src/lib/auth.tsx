import { createContext, useContext, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";

interface AuthUser {
  id: string;
  name: string;
  phone: string;
}

interface AuthState {
  authenticated: boolean;
  userId?: string;
  user?: AuthUser;
  needsSetup?: boolean;
}

interface AuthContextValue {
  auth: AuthState | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  auth: null,
  isLoading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: auth, isLoading } = useQuery<AuthState>({
    queryKey: ["/api/auth/me"],
    retry: false,
    staleTime: 30000,
  });

  return (
    <AuthContext.Provider value={{ auth: auth || null, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { auth, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !auth?.authenticated) {
      setLocation("/login");
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

  if (!auth?.authenticated) {
    return null;
  }

  return <>{children}</>;
}

export function RequireSetup({ children }: { children: React.ReactNode }) {
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

  if (auth?.needsSetup) {
    return null;
  }

  return <>{children}</>;
}

export function RedirectIfAuth({ children }: { children: React.ReactNode }) {
  const { auth, isLoading } = useAuth();
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

  if (auth?.authenticated) {
    return null;
  }

  return <>{children}</>;
}
