import React, { useState } from "react";
import { 
  Phone, 
  MessageSquare, 
  CheckCircle2, 
  MapPin, 
  Clock, 
  Bell, 
  Navigation, 
  Shield, 
  Smartphone,
  PhoneCall,
  MessageCircleMore
} from "lucide-react";
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
    { type: "push", time: "2:14 PM", detail: "Dauda's phone received a notification." },
    { type: "sms", time: "2:16 PM", detail: "A reminder text was sent." },
    { type: "call", time: "2:18 PM", detail: "We tried calling, no answer." },
    { type: "contact_alert", time: "2:20 PM", detail: "We reached out to you." },
  ],
};

export function EditorialTimeline() {
  const [handling, setHandling] = useState(false);
  const [escalating, setEscalating] = useState(false);

  const getTimelineIcon = (type: string) => {
    switch (type) {
      case "push": return <Bell className="h-4 w-4" />;
      case "sms": return <MessageCircleMore className="h-4 w-4" />;
      case "call": return <PhoneCall className="h-4 w-4" />;
      case "contact_alert": return <Shield className="h-4 w-4" />;
      case "location": return <MapPin className="h-4 w-4" />;
      default: return <Clock className="h-4 w-4" />;
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7] text-[#2C2A25] font-sans antialiased pb-48">
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap');
        .font-editorial { font-family: 'Crimson Pro', serif; }
        .font-ui { font-family: 'Inter', sans-serif; }
      `}} />

      {/* Header */}
      <header className="px-6 py-6 flex justify-between items-center border-b border-[#EBE7DF]">
        <div className="font-ui text-sm font-semibold tracking-wide uppercase text-[#6B665A]">
          StillHere
        </div>
        <div className="font-ui text-xs text-[#8A8578] border border-[#EBE7DF] rounded-full px-2 py-1 bg-white/50">
          No login required
        </div>
      </header>

      {/* Main Narrative */}
      <main className="max-w-md mx-auto">
        <div className="px-6 py-10">
          <h1 className="font-editorial text-4xl leading-[1.15] text-[#1A1916] mb-6">
            Help requested for {mockData.user.name}.
          </h1>
          <p className="font-editorial text-xl leading-relaxed text-[#4A473E] mb-10">
            {mockData.user.name} initiated an SOS {mockData.status.since}. Here is what has happened so far.
          </p>

          {/* Timeline */}
          <div className="relative ml-2 space-y-10 border-l border-[#D6D2C9] pl-8">
            
            {mockData.escalationTimeline.map((event, idx) => (
              <div key={idx} className="relative">
                <div className="absolute -left-[45px] top-0 w-6 h-6 rounded-full bg-[#FDFBF7] border border-[#D6D2C9] flex items-center justify-center text-[#8A8578]">
                  {getTimelineIcon(event.type)}
                </div>
                <div className="font-ui text-sm font-medium text-[#8A8578] mb-1">
                  {event.time}
                </div>
                <div className="font-editorial text-xl text-[#2C2A25]">
                  {event.detail}
                </div>
              </div>
            ))}

            {/* Map integrated into timeline */}
            <div className="relative pt-2">
              <div className="absolute -left-[45px] top-2 w-6 h-6 rounded-full bg-[#1A1916] flex items-center justify-center text-[#FDFBF7]">
                <MapPin className="h-4 w-4" />
              </div>
              <div className="font-ui text-sm font-medium text-[#1A1916] mb-1">
                Now — {mockData.location.updated}
              </div>
              <div className="font-editorial text-xl text-[#2C2A25] mb-4">
                Last seen at {mockData.location.address}.
              </div>
              
              <div className="rounded-xl overflow-hidden shadow-sm border border-[#EBE7DF] bg-white">
                <div className="aspect-[4/3] bg-[#EBE7DF] relative">
                  <img
                    src={`https://staticmap.openstreetmap.de/staticmap.php?center=${mockData.location.lat},${mockData.location.lng}&zoom=15&size=600x400&markers=${mockData.location.lat},${mockData.location.lng},red-pushpin`}
                    alt="Map showing Dauda's location"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
                <div className="p-4 flex items-center justify-between bg-white">
                  <div className="font-ui text-sm text-[#6B665A]">
                    Accuracy: {mockData.location.accuracy}
                  </div>
                  <Button variant="outline" size="sm" className="font-ui h-8 text-xs border-[#D6D2C9] text-[#2C2A25] bg-white hover:bg-[#FDFBF7]" asChild>
                    <a href={`https://www.google.com/maps/dir/?api=1&destination=${mockData.location.lat},${mockData.location.lng}`} target="_blank" rel="noopener noreferrer">
                      <Navigation className="h-3 w-3 mr-2" />
                      Get Directions
                    </a>
                  </Button>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* Footer Promo */}
        <div className="px-6 py-12 text-center border-t border-[#EBE7DF]/50 mt-4">
          <Smartphone className="h-6 w-6 text-[#8A8578] mx-auto mb-3" />
          <p className="font-ui text-sm text-[#6B665A] mb-2">
            Get instant alerts for {mockData.user.name}.
          </p>
          <a href="#" className="font-ui text-sm font-medium text-[#1A1916] underline underline-offset-4 decoration-[#D6D2C9]">
            Install the StillHere app
          </a>
        </div>
      </main>

      {/* Sticky Action Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-md border-t border-[#EBE7DF] px-4 py-4 z-10 shadow-[0_-4px_24px_rgba(0,0,0,0.02)]">
        <div className="max-w-md mx-auto space-y-3 font-ui">
          
          <div className="flex gap-3">
            <Button 
              variant="outline" 
              className="flex-1 h-12 bg-white border-[#D6D2C9] text-[#2C2A25] hover:bg-[#FDFBF7] shadow-sm rounded-xl font-medium"
              asChild
            >
              <a href={`tel:${mockData.user.phone}`}>
                <Phone className="h-4 w-4 mr-2 text-[#6B665A]" />
                Call
              </a>
            </Button>
            <Button 
              variant="outline" 
              className="flex-1 h-12 bg-white border-[#D6D2C9] text-[#2C2A25] hover:bg-[#FDFBF7] shadow-sm rounded-xl font-medium"
              asChild
            >
              <a href={`sms:${mockData.user.phone}`}>
                <MessageSquare className="h-4 w-4 mr-2 text-[#6B665A]" />
                Message
              </a>
            </Button>
          </div>

          {!handling ? (
            <div className="space-y-2">
              <Button 
                className="w-full h-14 bg-[#1A1916] hover:bg-[#2C2A25] text-white rounded-xl shadow-md font-medium text-[15px]"
                onClick={() => setHandling(true)}
              >
                <CheckCircle2 className="h-5 w-5 mr-2 opacity-80" />
                I'm handling this
              </Button>
              <button 
                className="w-full h-10 text-sm font-medium text-[#6B665A] active:text-[#1A1916]"
                onClick={() => setEscalating(true)}
              >
                I can't reach them
              </button>
            </div>
          ) : (
            <div className="w-full h-14 bg-[#F0EFEA] border border-[#D6D2C9] rounded-xl flex items-center justify-center text-[#2C2A25] font-medium shadow-sm">
              <CheckCircle2 className="h-5 w-5 mr-2 text-[#6B665A]" />
              You are handling this
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
