import React from "react";
import { Phone, MessageSquare, MapPin, Clock, Navigation, CheckCircle2, AlertTriangle, Shield, Smartphone, Battery, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";

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

export function StatusCard() {
  const mapUrl = "https://staticmap.openstreetmap.de/staticmap.php?center=-31.9523,115.8613&zoom=15&size=600x400&markers=-31.9523,115.8613,red-pushpin";

  return (
    <div className="min-h-screen bg-gray-50/50 pb-12 font-sans selection:bg-red-100">
      {/* Header / Brand */}
      <div className="pt-6 pb-2 px-4 flex justify-between items-center max-w-[390px] mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center">
            <span className="text-white text-[10px] font-bold">SH</span>
          </div>
          <span className="font-semibold text-gray-900 tracking-tight">StillHere</span>
        </div>
        <div className="bg-gray-200/60 text-gray-600 px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wider">
          No Login Required
        </div>
      </div>

      <div className="max-w-[390px] mx-auto px-4 space-y-3">
        {/* Main User Card */}
        <div className="bg-white rounded-3xl p-5 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.1)] border border-gray-100/50">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-red-100 to-red-50 flex items-center justify-center border-2 border-white shadow-sm text-xl font-medium text-red-600">
                {mockData.user.name[0]}
              </div>
              <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-red-500 rounded-full border-2 border-white flex items-center justify-center">
                <AlertTriangle className="w-3 h-3 text-white" />
              </div>
            </div>
            <div className="flex-1">
              <h1 className="text-xl font-bold text-gray-900">{mockData.user.name}</h1>
              <div className="mt-1 inline-flex items-center bg-red-50 text-red-700 px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide">
                {mockData.status.text}
              </div>
            </div>
          </div>
        </div>

        {/* 2-Column Metrics Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-gradient-to-br from-blue-50 to-white rounded-3xl p-4 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.05)] border border-blue-100/30">
            <div className="flex items-center gap-2 mb-1.5 text-blue-600">
              <Activity className="w-4 h-4" />
              <span className="text-[11px] font-semibold uppercase tracking-wider">Last Seen</span>
            </div>
            <div className="text-base font-bold text-gray-900">{mockData.location.updated}</div>
          </div>
          <div className="bg-gradient-to-br from-purple-50 to-white rounded-3xl p-4 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.05)] border border-purple-100/30">
            <div className="flex items-center gap-2 mb-1.5 text-purple-600">
              <Clock className="w-4 h-4" />
              <span className="text-[11px] font-semibold uppercase tracking-wider">Check-in</span>
            </div>
            <div className="text-base font-bold text-gray-900">{mockData.lastCheckin}</div>
          </div>
          <div className="bg-gradient-to-br from-emerald-50 to-white rounded-3xl p-4 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.05)] border border-emerald-100/30">
            <div className="flex items-center gap-2 mb-1.5 text-emerald-600">
              <MapPin className="w-4 h-4" />
              <span className="text-[11px] font-semibold uppercase tracking-wider">Accuracy</span>
            </div>
            <div className="text-base font-bold text-gray-900">{mockData.location.accuracy}</div>
          </div>
          <div className="bg-gradient-to-br from-amber-50 to-white rounded-3xl p-4 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.05)] border border-amber-100/30">
            <div className="flex items-center gap-2 mb-1.5 text-amber-600">
              <Battery className="w-4 h-4" />
              <span className="text-[11px] font-semibold uppercase tracking-wider">Battery</span>
            </div>
            <div className="text-base font-bold text-gray-900">42%</div>
          </div>
        </div>

        {/* Map Tile */}
        <div className="bg-white rounded-3xl overflow-hidden shadow-[0_2px_10px_-4px_rgba(0,0,0,0.1)] border border-gray-100/50">
          <div className="h-[180px] w-full relative bg-gray-100">
            <img src={mapUrl} alt="Map" className="w-full h-full object-cover" />
            <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-sm px-2.5 py-1 rounded-full shadow-sm flex items-center gap-1.5 border border-white/50">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[10px] font-bold text-green-700 uppercase tracking-wider">Live</span>
            </div>
          </div>
          <div className="p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-gray-400"><MapPin className="w-5 h-5" /></div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900 leading-tight">{mockData.location.address}</p>
                <Button variant="link" className="h-auto p-0 text-blue-600 font-semibold text-sm mt-1.5" asChild>
                  <a href={`https://www.google.com/maps/dir/?api=1&destination=${mockData.location.lat},${mockData.location.lng}`} target="_blank" rel="noreferrer">
                    <Navigation className="w-3.5 h-3.5 mr-1" />
                    Get Directions in Google Maps
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Action Tiles Grid */}
        <div className="grid grid-cols-2 gap-3 mt-2">
          <Button variant="outline" className="h-auto py-4 rounded-3xl flex-col gap-2 border-gray-200 hover:bg-gray-50 shadow-sm" asChild>
            <a href={`tel:${mockData.user.phone}`}>
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-600 mb-1">
                <Phone className="w-5 h-5 fill-current" />
              </div>
              <span className="font-semibold text-gray-900">Call</span>
            </a>
          </Button>
          <Button variant="outline" className="h-auto py-4 rounded-3xl flex-col gap-2 border-gray-200 hover:bg-gray-50 shadow-sm" asChild>
            <a href={`sms:${mockData.user.phone}`}>
              <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center text-green-600 mb-1">
                <MessageSquare className="w-5 h-5 fill-current" />
              </div>
              <span className="font-semibold text-gray-900">Message</span>
            </a>
          </Button>
          <Button className="h-auto py-4 rounded-3xl flex-col gap-2 bg-gray-900 hover:bg-gray-800 text-white shadow-sm shadow-gray-900/20 col-span-2">
            <div className="flex items-center justify-center gap-2 w-full">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-semibold text-base">I'm handling this</span>
            </div>
          </Button>
          <Button variant="outline" className="h-auto py-3.5 rounded-3xl gap-2 border-gray-200 hover:bg-gray-50 text-gray-600 font-medium shadow-sm col-span-2">
            <span className="font-semibold">I can't reach them</span>
          </Button>
        </div>

        {/* Timeline Tile */}
        <div className="bg-white rounded-3xl p-5 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.1)] border border-gray-100/50 mt-2">
          <h3 className="text-sm font-bold text-gray-900 mb-4 flex items-center gap-2">
            <Shield className="w-4 h-4 text-gray-400" />
            System Actions
          </h3>
          <div className="space-y-4">
            {mockData.escalationTimeline.map((evt, idx) => (
              <div key={idx} className="flex gap-3 relative">
                {idx !== mockData.escalationTimeline.length - 1 && (
                  <div className="absolute left-[9px] top-6 bottom-[-16px] w-[2px] bg-gray-100" />
                )}
                <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center z-10 shrink-0 mt-0.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                </div>
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">{evt.time}</span>
                  </div>
                  <p className="text-sm text-gray-700 leading-snug mt-0.5 font-medium">{evt.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer Promo */}
        <div className="pt-6 pb-4">
          <div className="bg-gray-100/70 rounded-3xl p-5 flex items-center gap-4 text-left border border-gray-200/50">
            <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm shrink-0">
              <Smartphone className="w-6 h-6 text-gray-900" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900 leading-tight mb-1">Get the StillHere App</p>
              <p className="text-xs text-gray-500 font-medium">Instant alerts, live tracking, and one-tap calling.</p>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
