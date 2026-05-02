import React, { useState } from "react";
import { 
  Phone, 
  MessageSquare, 
  MapPin, 
  Navigation, 
  Clock, 
  CheckCircle2, 
  Bell, 
  Shield, 
  MessageCircleMore, 
  PhoneCall, 
  Smartphone,
  ChevronDown,
  ChevronUp,
  User,
  Info
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

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

export function CalmHero() {
  const [showHandleConfirm, setShowHandleConfirm] = useState(false);
  const [showEscalateConfirm, setShowEscalateConfirm] = useState(false);
  const [isHandled, setIsHandled] = useState(false);
  const [isEscalated, setIsEscalated] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 pb-12 flex flex-col items-center">
      <style>{`
        :root {
          --calm-primary: 215 25% 27%;
          --calm-muted: 210 40% 96%;
          --calm-border: 214 32% 91%;
          --calm-action: 212 100% 48%;
        }
      `}</style>
      
      {/* Top Navigation */}
      <div className="w-full max-w-[390px] px-6 py-4 flex items-center justify-between bg-white/80 backdrop-blur-md sticky top-0 z-50 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-slate-400" />
          <span className="font-semibold tracking-tight text-slate-700">StillHere</span>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-medium text-slate-500 bg-slate-100 px-2 py-1 rounded-full">
          No Login Required
        </span>
      </div>

      <div className="w-full max-w-[390px] flex-1 flex flex-col bg-white shadow-sm overflow-hidden">
        
        {/* Full-bleed Hero Map Area */}
        <div className="relative w-full h-64 bg-slate-200">
          <img
            src="https://staticmap.openstreetmap.de/staticmap.php?center=-31.9523,115.8613&zoom=15&size=600x400&markers=-31.9523,115.8613,red-pushpin"
            alt="Map showing Dauda's location"
            className="w-full h-full object-cover"
          />
          {/* Gradient overlay for text legibility */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
          
          <div className="absolute bottom-6 left-6 right-6 flex flex-col text-white">
            <div className="flex items-center gap-3 mb-2">
              <Avatar className="h-12 w-12 border-2 border-white/20">
                <AvatarFallback className="bg-slate-300 text-slate-700">D</AvatarFallback>
              </Avatar>
              <div>
                <h1 className="text-2xl font-medium tracking-tight shadow-sm leading-tight">
                  {mockData.user.name}
                </h1>
                <div className="flex items-center gap-1.5 text-white/90 text-sm">
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                  <span className="font-medium drop-shadow-sm">{mockData.status.text}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="px-6 py-6 bg-white -mt-2 rounded-t-2xl relative z-10 space-y-8">
          
          {/* Primary Action */}
          <div className="text-center space-y-4">
            <p className="text-[15px] text-slate-600">
              Dauda requested help {mockData.status.since}. Their live location is sharing.
            </p>
            
            <Button 
              size="lg" 
              className="w-full h-14 text-base font-medium rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-600/20"
              asChild
            >
              <a href={`tel:${mockData.user.phone}`}>
                <Phone className="w-5 h-5 mr-2" />
                Call Dauda Now
              </a>
            </Button>
          </div>

          {/* Location Details */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Current Status</h3>
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 space-y-4">
              <div className="flex gap-3">
                <MapPin className="w-5 h-5 text-slate-400 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-slate-700 leading-snug">{mockData.location.address}</p>
                  <p className="text-slate-500 mt-1">Accurate to {mockData.location.accuracy} • Updated {mockData.location.updated}</p>
                  <a 
                    href={`https://www.google.com/maps/dir/?api=1&destination=${mockData.location.lat},${mockData.location.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-blue-600 font-medium mt-2"
                  >
                    <Navigation className="w-4 h-4" />
                    Get Directions
                  </a>
                </div>
              </div>
              <div className="h-px bg-slate-200" />
              <div className="flex gap-3">
                <Clock className="w-5 h-5 text-slate-400 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-slate-700">Last check-in</p>
                  <p className="text-slate-500 mt-0.5">{mockData.lastCheckin}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Additional Actions */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Other Actions</h3>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" className="h-12 bg-white rounded-xl border-slate-200 text-slate-700 font-medium" asChild>
                <a href={`sms:${mockData.user.phone}`}>
                  <MessageSquare className="w-4 h-4 mr-2" />
                  Text
                </a>
              </Button>
              <Button 
                variant="outline" 
                className="h-12 bg-white rounded-xl border-slate-200 text-slate-700 font-medium"
                onClick={() => setShowHandleConfirm(true)}
                disabled={isHandled}
              >
                <CheckCircle2 className={`w-4 h-4 mr-2 ${isHandled ? 'text-green-500' : ''}`} />
                {isHandled ? "Handled" : "I'm handling this"}
              </Button>
            </div>
            
            {!isHandled && (
              <Button 
                variant="ghost" 
                className="w-full text-slate-500 hover:text-slate-700 font-medium text-sm mt-2"
                onClick={() => setShowEscalateConfirm(true)}
                disabled={isEscalated}
              >
                I can't reach them — Escalate Alert
              </Button>
            )}
          </div>

          {/* Timeline */}
          <div className="space-y-4 pt-4 border-t border-slate-100">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-2">Before contacting you</h3>
            <div className="space-y-4">
              {mockData.escalationTimeline.map((item, index) => (
                <div key={index} className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                    <Info className="w-3 h-3 text-slate-400" />
                  </div>
                  <div className="text-sm">
                    <p className="text-slate-700">{item.detail}</p>
                    <p className="text-slate-400 text-xs mt-0.5">{item.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          
        </div>
        
        {/* Footer Promo */}
        <div className="mt-auto bg-slate-50 p-6 border-t border-slate-100">
          <div className="flex items-center gap-3">
            <Smartphone className="w-8 h-8 text-slate-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-slate-700">Get the StillHere App</p>
              <p className="text-xs text-slate-500 mt-0.5">Receive faster alerts and more detailed tracking.</p>
            </div>
          </div>
        </div>

      </div>

      {/* Dialogs */}
      <AlertDialog open={showHandleConfirm} onOpenChange={setShowHandleConfirm}>
        <AlertDialogContent className="rounded-2xl max-w-[340px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl">I'm handling this</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-slate-600">
              We'll pause further alerts while you check on {mockData.user.name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4 flex-col gap-2 sm:flex-col">
            <AlertDialogAction
              className="h-12 w-full rounded-xl bg-blue-600 text-base"
              onClick={() => {
                setIsHandled(true);
                setShowHandleConfirm(false);
              }}
            >
              Confirm
            </AlertDialogAction>
            <AlertDialogCancel className="h-12 w-full rounded-xl mt-0 text-base border-slate-200">
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showEscalateConfirm} onOpenChange={setShowEscalateConfirm}>
        <AlertDialogContent className="rounded-2xl max-w-[340px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl">Escalate Alert</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-slate-600">
              We'll immediately contact the next person on {mockData.user.name}'s emergency list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4 flex-col gap-2 sm:flex-col">
            <AlertDialogAction
              className="h-12 w-full rounded-xl bg-red-600 hover:bg-red-700 text-base"
              onClick={() => {
                setIsEscalated(true);
                setShowEscalateConfirm(false);
              }}
            >
              Escalate Now
            </AlertDialogAction>
            <AlertDialogCancel className="h-12 w-full rounded-xl mt-0 text-base border-slate-200">
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
