import React, { useState } from "react";
import { Phone, MessageSquare, CheckCircle2, AlertTriangle, MapPin, Clock, Bell, Navigation, Shield, Smartphone, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

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

export function TriageFirst() {
  const [isHandling, setIsHandling] = useState(false);

  const getIcon = (type: string) => {
    switch (type) {
      case "push": return <Bell className="h-4 w-4" />;
      case "sms": return <MessageSquare className="h-4 w-4" />;
      case "call": return <Phone className="h-4 w-4" />;
      case "contact_alert": return <Shield className="h-4 w-4" />;
      default: return <Clock className="h-4 w-4" />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 pb-16 flex flex-col relative w-full max-w-[390px] mx-auto overflow-x-hidden shadow-2xl">
      
      {/* PINNED TOP ACTION BAR - The "Triage First" Hypothesis */}
      <div className="sticky top-0 z-50 bg-white border-b border-slate-200 shadow-sm px-4 py-3 flex gap-2 w-full">
        <Button 
          variant="outline" 
          className="flex-1 flex flex-col items-center justify-center h-16 gap-1 border-slate-300 hover:bg-slate-50 rounded-xl"
          asChild
        >
          <a href={`tel:${mockData.user.phone}`}>
             <Phone className="h-5 w-5 text-slate-700" />
             <span className="text-[10px] uppercase font-semibold text-slate-600 tracking-wide">Call</span>
          </a>
        </Button>
        <Button 
          variant="outline" 
          className="flex-1 flex flex-col items-center justify-center h-16 gap-1 border-slate-300 hover:bg-slate-50 rounded-xl"
          asChild
        >
          <a href={`sms:${mockData.user.phone}`}>
             <MessageSquare className="h-5 w-5 text-slate-700" />
             <span className="text-[10px] uppercase font-semibold text-slate-600 tracking-wide">Text</span>
          </a>
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button 
              className={`flex-[1.5] flex flex-col items-center justify-center h-16 gap-1 rounded-xl transition-colors ${
                isHandling 
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white" 
                  : "bg-red-600 hover:bg-red-700 text-white"
              }`}
            >
              <CheckCircle2 className="h-5 w-5" />
              <span className="text-[10px] uppercase font-bold tracking-wide">
                {isHandling ? "Handling It" : "I've Got This"}
              </span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="w-[90%] rounded-xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Take ownership of this alert?</AlertDialogTitle>
              <AlertDialogDescription>
                We will notify other contacts that you are checking on {mockData.user.name} and pause further escalations.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
              <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => setIsHandling(true)} className="bg-red-600 hover:bg-red-700">
                Yes, I'm handling this
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="px-4 py-3 flex justify-between items-center bg-slate-50">
         <div className="font-bold text-slate-800 tracking-tight flex items-center gap-1.5">
           <Shield className="h-4 w-4 text-slate-400" />
           StillHere
         </div>
         <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 bg-slate-200/50 px-2 py-1 rounded-sm">
           No Login Required
         </div>
      </div>

      {/* COMPACT STATUS STRIP */}
      <div className="px-4 pt-1 pb-4">
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex flex-col gap-3">
          <div className="flex justify-between items-start">
             <div>
               <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{mockData.user.name}</h1>
               <div className="flex items-center gap-1.5 mt-1">
                 <AlertTriangle className="h-4 w-4 text-red-500" />
                 <span className="font-semibold text-red-600 uppercase text-xs tracking-wide">{mockData.status.text}</span>
                 <span className="text-slate-400 text-xs tracking-tight">• {mockData.status.since}</span>
               </div>
             </div>
             <div className="text-right">
                <div className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide mb-0.5">Last Check-in</div>
                <div className="text-sm font-medium text-slate-700">{mockData.lastCheckin}</div>
             </div>
          </div>
        </div>
      </div>

      {/* LOCATION MAP MODULE */}
      <div className="px-4 pb-4">
         <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-100">
           <div className="p-4 border-b border-slate-50 flex items-center justify-between bg-slate-50/50">
             <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-slate-500" />
                <span className="font-semibold text-sm text-slate-700">Location</span>
             </div>
             {mockData.location.isLive && (
               <div className="flex items-center gap-1.5">
                 <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="text-xs font-semibold text-emerald-600 uppercase tracking-wide">Live</span>
               </div>
             )}
           </div>
           
           <div className="relative h-[200px] w-full bg-slate-100">
             <img
                src={`https://staticmap.openstreetmap.de/staticmap.php?center=${mockData.location.lat},${mockData.location.lng}&zoom=15&size=600x400&markers=${mockData.location.lat},${mockData.location.lng},red-pushpin`}
                alt={`Map showing ${mockData.user.name}'s location`}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                  (e.target as HTMLImageElement).parentElement!.classList.add('flex', 'items-center', 'justify-center', 'bg-slate-200');
                  (e.target as HTMLImageElement).parentElement!.innerHTML = '<span class="text-slate-400 text-sm font-medium flex items-center gap-2"><MapPin class="h-4 w-4"/> Map unavailable</span>';
                }}
              />
           </div>

           <div className="p-4 bg-white">
             <p className="text-sm text-slate-800 font-medium leading-snug">{mockData.location.address}</p>
             <div className="flex items-center gap-2 mt-1.5 mb-4">
               <span className="text-xs text-slate-500">Accuracy: {mockData.location.accuracy}</span>
               <span className="text-slate-300">•</span>
               <span className="text-xs text-slate-500">Updated {mockData.location.updated}</span>
             </div>
             
             <Button variant="default" className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-xl gap-2 h-12" asChild>
                <a href={`https://www.google.com/maps/dir/?api=1&destination=${mockData.location.lat},${mockData.location.lng}`} target="_blank" rel="noreferrer">
                  <Navigation className="h-4 w-4" />
                  Get Directions
                </a>
             </Button>
           </div>
         </div>
      </div>

      {/* ESCALATION TIMELINE */}
      <div className="px-4 pb-6">
        <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-3 px-1">System Timeline</h3>
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <div className="relative border-l-2 border-slate-100 ml-3 space-y-6 pb-2">
             {mockData.escalationTimeline.map((event, idx) => (
               <div key={idx} className="relative pl-6">
                 <div className="absolute -left-[13px] bg-white p-1 rounded-full">
                    <div className="bg-slate-100 rounded-full p-1.5 text-slate-500">
                      {getIcon(event.type)}
                    </div>
                 </div>
                 <div className="flex flex-col pt-1">
                   <span className="text-xs font-bold text-slate-400 mb-0.5">{event.time}</span>
                   <span className="text-sm font-medium text-slate-700">{event.detail}</span>
                 </div>
               </div>
             ))}
             
             <div className="relative pl-6">
                <div className="absolute -left-[13px] bg-white p-1 rounded-full">
                    <div className="bg-red-50 border border-red-100 rounded-full p-1.5 text-red-500">
                      <AlertTriangle className="h-4 w-4" />
                    </div>
                 </div>
                 <div className="flex flex-col pt-1">
                   <span className="text-sm font-bold text-red-600">Action Required</span>
                   <span className="text-sm text-slate-600 mt-0.5">Awaiting your response.</span>
                 </div>
             </div>
          </div>
        </div>
      </div>

      {/* ESCALATE ACTION */}
      <div className="px-4 pb-8">
        <AlertDialog>
          <AlertDialogTrigger asChild>
             <Button variant="ghost" className="w-full text-slate-500 hover:text-slate-800 hover:bg-slate-200/50 h-12 rounded-xl text-sm font-semibold">
               I can't reach them — Escalate further
             </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="w-[90%] rounded-xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Escalate this alert?</AlertDialogTitle>
              <AlertDialogDescription>
                We will contact the next person on {mockData.user.name}'s emergency list.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
              <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-slate-900">Escalate Alert</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* INSTALL APP PROMO */}
      <div className="px-4 mt-auto">
        <div className="bg-slate-100 rounded-2xl p-4 flex items-center justify-between group cursor-pointer hover:bg-slate-200/70 transition-colors">
           <div className="flex items-center gap-3">
              <div className="bg-white p-2 rounded-xl shadow-sm">
                 <Smartphone className="h-5 w-5 text-slate-600" />
              </div>
              <div>
                <div className="text-sm font-bold text-slate-800">Get StillHere App</div>
                <div className="text-xs text-slate-500 mt-0.5">Faster alerts & live tracking</div>
              </div>
           </div>
           <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-slate-600 transition-colors" />
        </div>
      </div>

    </div>
  );
}
