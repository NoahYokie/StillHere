import React, { useState } from "react";
import { Phone, MessageSquare, MapPin, Clock, Bell, Navigation, Shield, ChevronUp, ChevronDown, CheckCircle2, Smartphone, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";

const mockData = {
  user: { name: "Dauda", phone: "+61 405 935 265" },
  contact: { name: "Ishong" },
  status: { text: "Help requested", reason: "sos", since: "2 minutes ago" },
  lastCheckin: "2 hours ago",
  location: {
    lat: -31.9523, lng: 115.8613,
    address: "St Georges Terrace, Perth WA 6000, Australia",
    accuracy: "12 m",
    isLive: true,
    updated: "30 seconds ago",
  },
  escalationTimeline: [
    { type: "push", time: "2:14 PM", detail: "Sent push notification to Dauda's phone" },
    { type: "sms", time: "2:16 PM", detail: "Sent SMS reminder to Dauda" },
    { type: "call", time: "2:18 PM", detail: "Auto-called Dauda — no answer" },
    { type: "contact_alert", time: "2:20 PM", detail: "Notified you (Ishong)" },
  ],
};

export function MapForward() {
  const [timelineOpen, setTimelineOpen] = useState(false);

  const getIcon = (type: string) => {
    switch (type) {
      case "push": return <Bell className="h-3.5 w-3.5" />;
      case "sms": return <MessageSquare className="h-3.5 w-3.5" />;
      case "call": return <Phone className="h-3.5 w-3.5" />;
      case "contact_alert": return <Shield className="h-3.5 w-3.5" />;
      default: return <Clock className="h-3.5 w-3.5" />;
    }
  };

  return (
    <div className="relative w-full h-[100dvh] bg-neutral-900 overflow-hidden font-sans text-neutral-900 select-none">
      {/* Header Overlay */}
      <div className="absolute top-0 inset-x-0 z-20 flex justify-between items-center px-4 py-3 bg-gradient-to-b from-black/60 to-transparent pt-safe">
        <div className="flex items-center gap-2 text-white">
          <ShieldAlert className="h-5 w-5 text-red-500" />
          <span className="font-semibold text-lg tracking-tight">StillHere</span>
        </div>
        <div className="px-2 py-1 rounded-md bg-white/20 backdrop-blur-md text-white text-[10px] uppercase font-bold tracking-wider">
          No Login Required
        </div>
      </div>

      {/* Map Background (70% height) */}
      <div className="absolute inset-0 h-[75vh] w-full bg-neutral-800 pointer-events-none">
        <img
          src={`https://staticmap.openstreetmap.de/staticmap.php?center=${mockData.location.lat},${mockData.location.lng}&zoom=15&size=600x800&markers=${mockData.location.lat},${mockData.location.lng},red-pushpin`}
          alt="Map showing Dauda's location"
          className="w-full h-full object-cover opacity-80 mix-blend-luminosity"
        />
        {/* Dark vignette overlay for better contrast */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-neutral-900/20 to-neutral-900/80" />
      </div>

      {/* Draggable Bottom Sheet */}
      <div className="absolute bottom-0 inset-x-0 z-30 bg-white rounded-t-3xl shadow-[0_-8px_30px_rgba(0,0,0,0.12)] flex flex-col max-h-[85vh]">
        {/* Drag Handle */}
        <div className="w-full flex justify-center py-3 pb-1 cursor-grab active:cursor-grabbing">
          <div className="w-12 h-1.5 rounded-full bg-neutral-200" />
        </div>

        <ScrollArea className="flex-1 w-full px-5 pb-8 pt-2">
          {/* Status Header */}
          <div className="mb-5 flex flex-col items-center text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-50 text-red-600 text-sm font-semibold mb-3">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              </span>
              Help Requested
            </div>
            <h1 className="text-2xl font-bold tracking-tight mb-1">{mockData.user.name}'s Location</h1>
            <p className="text-neutral-500 text-sm flex items-center justify-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Updated {mockData.location.updated} • Last checkin {mockData.lastCheckin}
            </p>
          </div>

          {/* Location details */}
          <div className="bg-neutral-50 rounded-2xl p-4 mb-4 border border-neutral-100">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 bg-neutral-200 text-neutral-600 p-1.5 rounded-full">
                <MapPin className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <p className="text-[15px] font-medium leading-snug">{mockData.location.address}</p>
                <p className="text-sm text-neutral-500 mt-0.5">Accuracy: {mockData.location.accuracy}</p>
              </div>
            </div>
            <Button variant="outline" className="w-full mt-3 rounded-xl bg-white border-neutral-200 text-neutral-700 shadow-sm" asChild>
              <a href={`https://www.google.com/maps/dir/?api=1&destination=${mockData.location.lat},${mockData.location.lng}`} target="_blank" rel="noreferrer">
                <Navigation className="h-4 w-4 mr-2" />
                Get Directions
              </a>
            </Button>
          </div>

          {/* Primary Actions Grid */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Button size="lg" className="rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white shadow-md w-full gap-2">
              <Phone className="h-4 w-4" />
              Call
            </Button>
            <Button size="lg" variant="outline" className="rounded-xl border-neutral-200 bg-white hover:bg-neutral-50 text-neutral-900 shadow-sm w-full gap-2">
              <MessageSquare className="h-4 w-4" />
              Message
            </Button>
          </div>

          {/* Resolution Actions */}
          <div className="space-y-3 mb-6">
            <Button size="lg" className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow-md">
              <CheckCircle2 className="mr-2 h-5 w-5" />
              I'm handling this
            </Button>
            <Button variant="ghost" className="w-full rounded-xl text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 h-12">
              I can't reach them (Escalate)
            </Button>
          </div>

          {/* Timeline Collapsible */}
          <Collapsible open={timelineOpen} onOpenChange={setTimelineOpen} className="bg-neutral-50 rounded-2xl border border-neutral-100 mb-6 overflow-hidden">
            <CollapsibleTrigger asChild>
              <button className="flex items-center justify-between w-full p-4 text-sm font-medium text-neutral-700 hover:bg-neutral-100/50 transition-colors">
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-neutral-500" />
                  What we tried first
                </span>
                {timelineOpen ? <ChevronUp className="h-4 w-4 text-neutral-400" /> : <ChevronDown className="h-4 w-4 text-neutral-400" />}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              <div className="relative pl-4 border-l-2 border-neutral-200 space-y-4 mt-2">
                {mockData.escalationTimeline.map((item, idx) => (
                  <div key={idx} className="relative">
                    <div className="absolute -left-[25px] top-0 bg-white border-2 border-neutral-200 rounded-full p-0.5 text-neutral-400">
                      {getIcon(item.type)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-neutral-800">{item.detail}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">{item.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Subtle Promo Footer */}
          <div className="flex flex-col items-center justify-center pt-2 pb-4">
            <div className="flex items-center gap-2 text-neutral-400">
              <Smartphone className="h-4 w-4" />
              <p className="text-xs font-medium">Want instant alerts?</p>
            </div>
            <a href="#" className="text-xs font-medium text-blue-600 hover:underline mt-1">
              Install the free StillHere app
            </a>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}