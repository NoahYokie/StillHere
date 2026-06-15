import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Menu,
  Home,
  MessageCircle,
  Users,
  Heart,
  Shield,
  MapPin,
  Bookmark,
  FileText,
  Satellite,
  Settings,
  HelpCircle,
  Info,
  Compass,
  AlertTriangle,
  ChevronRight,
  LogOut,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface NavItem {
  label: string;
  icon: typeof Home;
  route: string;
  testid: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const sections: NavSection[] = [
  {
    title: "Main",
    items: [
      { label: "Home", icon: Home, route: "/", testid: "drawer-link-home" },
      { label: "Messages", icon: MessageCircle, route: "/inbox", testid: "drawer-link-messages" },
      { label: "Guardians", icon: Users, route: "/watched", testid: "drawer-link-guardians" },
      { label: "Safety Circle", icon: Shield, route: "/safety-circle", testid: "drawer-link-safety-circle" },
      { label: "Family", icon: Heart, route: "/family", testid: "drawer-link-family" },
    ],
  },
  {
    title: "Safety Tools",
    items: [
      { label: "Location History", icon: MapPin, route: "/live-location", testid: "drawer-link-location" },
      { label: "Saved Places", icon: Bookmark, route: "/saved-places", testid: "drawer-link-saved" },
      { label: "Safety Report", icon: FileText, route: "/weekly-report", testid: "drawer-link-report" },
      { label: "Satellite Devices", icon: Satellite, route: "/satellite", testid: "drawer-link-satellite" },
    ],
  },
  {
    title: "Settings",
    items: [
      { label: "Settings", icon: Settings, route: "/settings", testid: "drawer-link-settings" },
      { label: "Replay tour", icon: Compass, route: "/?tour=1", testid: "drawer-link-replay-tour" },
      { label: "Help & Support", icon: HelpCircle, route: "/help", testid: "drawer-link-help" },
      { label: "About StillHere", icon: Info, route: "/trust", testid: "drawer-link-about" },
    ],
  },
];

interface AppDrawerProps {
  userName?: string;
  onSosTap: () => void;
}

export function AppDrawer({ userName, onSosTap }: AppDrawerProps) {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useLocation();

  const logoutMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/auth/logout"),
    onSuccess: async () => {
      queryClient.clear();
      window.location.href = "/login";
    },
  });

  const go = (route: string) => {
    setOpen(false);
    if (route === "/?tour=1") {
      try {
        window.localStorage.removeItem("stillhere.tour.v1.completed");
      } catch {}
      if (window.location.pathname === "/") {
        window.location.search = "?tour=1";
      } else {
        window.location.href = "/?tour=1";
      }
      return;
    }
    if (route === "/watched") {
      const returnTo = location.startsWith("/watched") ? "/" : location;
      setLocation(`/watched/map?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    setLocation(route);
  };

  const initials = (userName || "U")
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "U";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-foreground"
          data-testid="button-open-drawer"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-[300px] sm:w-[340px] p-0 flex flex-col gap-0"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>StillHere menu</SheetTitle>
        </SheetHeader>

        <div className="px-6 pt-6 pb-5 border-b">
          <button
            onClick={() => go("/settings")}
            className="flex items-center gap-3 w-full text-left rounded-xl -mx-2 px-2 py-1 hover:bg-muted/60 transition-colors"
            data-testid="drawer-link-profile"
          >
            <Avatar className="h-12 w-12">
              <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground truncate" data-testid="text-drawer-username">
                {userName || "Welcome"}
              </p>
              <p className="text-xs text-muted-foreground">View profile</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {sections.map((section) => (
            <div key={section.title} className="mb-5">
              <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    location === item.route ||
                    (item.route !== "/" && location.startsWith(item.route));
                  return (
                    <button
                      key={item.route}
                      onClick={() => go(item.route)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        active
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-muted"
                      }`}
                      data-testid={item.testid}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-4 py-4 border-t space-y-2">
          <button
            onClick={() => {
              setOpen(false);
              onSosTap();
            }}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-red-500 text-red-600 dark:text-red-400 dark:border-red-500 font-semibold text-sm hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            data-testid="drawer-button-sos"
          >
            <AlertTriangle className="h-4 w-4" />
            Emergency SOS
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
            data-testid="drawer-button-logout"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
