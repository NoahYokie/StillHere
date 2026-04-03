import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Heart,
  Check,
  AlertTriangle,
  Bell,
  Users,
  Settings,
  Shield,
  ArrowLeft,
  ArrowRight,
  Phone,
  MessageCircle,
  Eye,
  X,
} from "lucide-react";

const tourSteps = [
  {
    id: "checkin",
    title: "Tap to check in",
    description: "Once a day, just tap the green button to let your contacts know you're safe. That's it!",
    mockup: "checkin",
  },
  {
    id: "reminder",
    title: "We remind you first",
    description: "If you forget, we'll send you a friendly reminder. No panic, you'll have extra time to respond.",
    mockup: "reminder",
  },
  {
    id: "alert",
    title: "Contacts get notified",
    description: "If you still don't respond after the grace period, we send a message to your emergency contacts so they can check on you.",
    mockup: "alert",
  },
  {
    id: "sos",
    title: "Need help right now?",
    description: "Tap the red \"I Need Help\" button anytime for an immediate alert to your contacts. No waiting.",
    mockup: "sos",
  },
  {
    id: "contacts",
    title: "Choose who gets notified",
    description: "Add your trusted people: family, friends, neighbours. They'll only hear from us if something's wrong.",
    mockup: "contacts",
  },
  {
    id: "contact-page",
    title: "Your contacts can respond",
    description: "Each contact gets their own page to see your status, take responsibility, and communicate with you.",
    mockup: "contactpage",
  },
  {
    id: "settings",
    title: "You're in control",
    description: "Set your own schedule, choose how long to wait, turn location sharing on or off. Everything is up to you.",
    mockup: "settings",
  },
];

function PhoneMockup({ step }: { step: string }) {
  return (
    <div className="w-[220px] h-[420px] bg-gray-900 rounded-[2.5rem] border-[3px] border-gray-700 shadow-2xl shadow-black/40 p-1.5 flex flex-col mx-auto">
      <div className="w-20 h-4 bg-gray-900 rounded-b-xl mx-auto relative z-10 -mt-0.5" />
      <div className="flex-1 bg-slate-50 rounded-[2rem] overflow-hidden flex flex-col">
        {step === "checkin" && <CheckinScreen />}
        {step === "reminder" && <ReminderScreen />}
        {step === "alert" && <AlertScreen />}
        {step === "sos" && <SOSScreen />}
        {step === "contacts" && <ContactsScreen />}
        {step === "contactpage" && <ContactPageScreen />}
        {step === "settings" && <SettingsScreen />}
      </div>
    </div>
  );
}

function CheckinScreen() {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-sky-500 text-white px-4 pt-5 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Heart className="h-3.5 w-3.5" />
          <span className="text-xs font-semibold">StillHere</span>
        </div>
        <p className="text-[10px] text-white/70">Good morning, Sarah</p>
      </div>
      <div className="flex-1 px-4 py-3 flex flex-col gap-3">
        <div className="bg-white rounded-lg px-3 py-2 shadow-sm border border-gray-100 text-center">
          <p className="text-[8px] text-gray-400 uppercase tracking-wide mb-0.5">Next checkin</p>
          <p className="text-xs font-medium text-gray-800">9:00 AM tomorrow</p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="relative">
            <div className="w-20 h-20 rounded-full bg-green-500 flex items-center justify-center shadow-lg animate-pulse">
              <Check className="h-10 w-10 text-white" />
            </div>
            <div className="absolute -top-2 -right-8 bg-sky-500 text-white text-[8px] px-2 py-1 rounded-full font-medium whitespace-nowrap animate-bounce">
              Tap here!
            </div>
          </div>
          <p className="font-bold text-gray-800 text-sm mt-2">I'm OK</p>
          <p className="text-[9px] text-gray-400 mt-0.5">Tap once a day</p>
        </div>
        <div className="bg-red-500 rounded-lg py-2 text-center text-white text-xs font-semibold shadow-sm opacity-60">
          I Need Help
        </div>
      </div>
    </div>
  );
}

function ReminderScreen() {
  return (
    <div className="flex flex-col h-full bg-gray-100">
      <div className="bg-gray-800 text-white px-4 pt-6 pb-2">
        <p className="text-[10px] text-gray-400">9:15 AM</p>
      </div>
      <div className="flex-1 px-3 pt-4 space-y-2">
        <div className="bg-white rounded-xl p-3 shadow-sm border border-gray-200">
          <div className="flex items-start gap-2">
            <div className="w-8 h-8 rounded-full bg-sky-500 flex items-center justify-center flex-shrink-0">
              <Heart className="h-4 w-4 text-white" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-gray-800">StillHere</p>
                <p className="text-[8px] text-gray-400">now</p>
              </div>
              <p className="text-[10px] text-gray-600 mt-0.5">
                Hey Sarah! Time to check in. Tap the button to let your family know you're okay.
              </p>
              <div className="mt-2 bg-green-500 rounded-md py-1.5 text-center">
                <p className="text-[9px] text-white font-semibold">I'm OK ✓</p>
              </div>
            </div>
          </div>
        </div>
        <div className="text-center pt-2">
          <div className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 px-3 py-1.5 rounded-full">
            <Bell className="h-3 w-3" />
            <p className="text-[9px] font-medium">Friendly reminder</p>
          </div>
        </div>
        <p className="text-[9px] text-gray-400 text-center px-4">
          You can check in right from this notification, one tap and done!
        </p>
      </div>
    </div>
  );
}

function AlertScreen() {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-sky-500 text-white px-4 pt-5 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Heart className="h-3.5 w-3.5" />
          <span className="text-xs font-semibold">StillHere</span>
        </div>
      </div>
      <div className="flex-1 px-3 py-3 space-y-2">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[10px] font-semibold text-amber-800">Missed checkin alert</p>
              <p className="text-[9px] text-amber-600 mt-0.5">
                Contacting John (1 of 2)...
              </p>
              <div className="mt-1.5 flex gap-1">
                <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
                  <Check className="h-2.5 w-2.5 text-white" />
                </div>
                <div className="w-4 h-4 rounded-full bg-gray-200 flex items-center justify-center">
                  <span className="text-[7px] text-gray-500">2</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-gray-100">
          <p className="text-[9px] text-gray-500 text-center">
            Your contacts receive a message with a link to check your status
          </p>
          <div className="mt-2 bg-gray-50 rounded-md p-2 border border-gray-100">
            <p className="text-[8px] text-gray-600">
              📱 "Hi John, Sarah hasn't checked in on StillHere. Please check on her."
            </p>
          </div>
        </div>
        <div className="text-center">
          <p className="text-[8px] text-gray-400">Contacts are notified one by one</p>
          <p className="text-[8px] text-gray-400">giving each time to respond</p>
        </div>
      </div>
    </div>
  );
}

function SOSScreen() {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-sky-500 text-white px-4 pt-5 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Heart className="h-3.5 w-3.5" />
          <span className="text-xs font-semibold">StillHere</span>
        </div>
        <p className="text-[10px] text-white/70">Welcome, Sarah</p>
      </div>
      <div className="flex-1 px-4 py-3 flex flex-col gap-3">
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-green-500/30 flex items-center justify-center">
            <Check className="h-8 w-8 text-green-500/50" />
          </div>
          <p className="text-sm text-gray-400 mt-2">I'm OK</p>
        </div>
        <div className="relative">
          <div className="bg-red-500 rounded-lg py-3 text-center text-white text-sm font-semibold shadow-lg animate-pulse">
            <div className="flex items-center justify-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              I Need Help
            </div>
          </div>
          <div className="absolute -top-3 -right-2 bg-red-600 text-white text-[8px] px-2 py-1 rounded-full font-medium whitespace-nowrap animate-bounce">
            Emergency!
          </div>
        </div>
        <p className="text-[9px] text-gray-400 text-center">
          Sends an immediate alert to all your contacts right away
        </p>
      </div>
    </div>
  );
}

function ContactsScreen() {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-sky-500 text-white px-4 pt-5 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Users className="h-3.5 w-3.5" />
          <span className="text-xs font-semibold">Emergency Contacts</span>
        </div>
      </div>
      <div className="flex-1 px-3 py-3 space-y-2">
        <div className="bg-white rounded-lg p-3 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-sky-100 flex items-center justify-center">
              <span className="text-xs font-semibold text-sky-600">J</span>
            </div>
            <div className="flex-1">
              <p className="text-[11px] font-semibold text-gray-800">John Smith</p>
              <p className="text-[9px] text-gray-400">Son • Priority 1</p>
            </div>
            <div className="flex gap-1">
              <div className="w-6 h-6 rounded-full bg-sky-50 flex items-center justify-center">
                <MessageCircle className="h-3 w-3 text-sky-500" />
              </div>
              <div className="w-6 h-6 rounded-full bg-sky-50 flex items-center justify-center">
                <Phone className="h-3 w-3 text-sky-500" />
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
              <span className="text-xs font-semibold text-green-600">M</span>
            </div>
            <div className="flex-1">
              <p className="text-[11px] font-semibold text-gray-800">Mary Jones</p>
              <p className="text-[9px] text-gray-400">Neighbour • Priority 2</p>
            </div>
            <div className="flex gap-1">
              <div className="w-6 h-6 rounded-full bg-gray-50 flex items-center justify-center">
                <Phone className="h-3 w-3 text-gray-400" />
              </div>
            </div>
          </div>
        </div>
        <div className="border-2 border-dashed border-gray-200 rounded-lg p-3 text-center">
          <p className="text-[10px] text-gray-400">+ Add another contact</p>
        </div>
        <p className="text-[9px] text-gray-400 text-center mt-1">
          Contacts with StillHere get in-app messages instead of SMS
        </p>
      </div>
    </div>
  );
}

function ContactPageScreen() {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-amber-500 text-white px-4 pt-5 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="text-xs font-semibold">Alert for Sarah</span>
        </div>
        <p className="text-[10px] text-white/80">You're listed as an emergency contact</p>
      </div>
      <div className="flex-1 px-3 py-3 space-y-2">
        <div className="bg-white rounded-lg p-3 border border-gray-200 text-center">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-2">
            <span className="text-sm font-bold text-amber-600">S</span>
          </div>
          <p className="text-[11px] font-semibold text-gray-800">Sarah hasn't checked in</p>
          <p className="text-[9px] text-gray-400 mt-0.5">Last seen: 9:15 AM yesterday</p>
        </div>
        <div className="bg-green-500 rounded-lg py-2 text-center text-white text-[11px] font-semibold shadow-sm">
          I'll handle this
        </div>
        <div className="flex gap-2">
          <div className="flex-1 bg-sky-50 rounded-lg py-2 text-center">
            <MessageCircle className="h-3.5 w-3.5 text-sky-500 mx-auto mb-0.5" />
            <p className="text-[8px] text-sky-600 font-medium">Message</p>
          </div>
          <div className="flex-1 bg-sky-50 rounded-lg py-2 text-center">
            <Phone className="h-3.5 w-3.5 text-sky-500 mx-auto mb-0.5" />
            <p className="text-[8px] text-sky-600 font-medium">Video call</p>
          </div>
        </div>
        <p className="text-[8px] text-gray-400 text-center">
          Once you take responsibility, other contacts are paused
        </p>
      </div>
    </div>
  );
}

function SettingsScreen() {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-sky-500 text-white px-4 pt-5 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Settings className="h-3.5 w-3.5" />
          <span className="text-xs font-semibold">Settings</span>
        </div>
      </div>
      <div className="flex-1 px-3 py-2 space-y-2 overflow-hidden">
        <div className="bg-white rounded-lg p-2.5 border border-gray-200">
          <p className="text-[9px] font-semibold text-gray-600 mb-1.5">How often to check in</p>
          <div className="flex gap-1">
            <div className="flex-1 bg-sky-500 rounded-md py-1 text-center">
              <p className="text-[8px] text-white font-medium">Daily</p>
            </div>
            <div className="flex-1 bg-gray-100 rounded-md py-1 text-center">
              <p className="text-[8px] text-gray-500">2 days</p>
            </div>
            <div className="flex-1 bg-gray-100 rounded-md py-1 text-center">
              <p className="text-[8px] text-gray-500">Weekly</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg p-2.5 border border-gray-200">
          <p className="text-[9px] font-semibold text-gray-600 mb-1.5">Grace period</p>
          <div className="flex gap-1">
            <div className="flex-1 bg-gray-100 rounded-md py-1 text-center">
              <p className="text-[8px] text-gray-500">10 min</p>
            </div>
            <div className="flex-1 bg-sky-500 rounded-md py-1 text-center">
              <p className="text-[8px] text-white font-medium">15 min</p>
            </div>
            <div className="flex-1 bg-gray-100 rounded-md py-1 text-center">
              <p className="text-[8px] text-gray-500">30 min</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg p-2.5 border border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Shield className="h-3 w-3 text-sky-500" />
              <p className="text-[9px] font-semibold text-gray-600">Location sharing</p>
            </div>
            <div className="w-7 h-4 bg-gray-200 rounded-full flex items-center px-0.5">
              <div className="w-3 h-3 bg-white rounded-full shadow-sm" />
            </div>
          </div>
          <p className="text-[8px] text-gray-400 mt-1">Off by default. You decide.</p>
        </div>
        <div className="bg-white rounded-lg p-2.5 border border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Eye className="h-3 w-3 text-sky-500" />
              <p className="text-[9px] font-semibold text-gray-600">Auto checkin</p>
            </div>
            <div className="w-7 h-4 bg-green-500 rounded-full flex items-center justify-end px-0.5">
              <div className="w-3 h-3 bg-white rounded-full shadow-sm" />
            </div>
          </div>
          <p className="text-[8px] text-gray-400 mt-1">Opening the app counts as a checkin</p>
        </div>
      </div>
    </div>
  );
}

export default function TourPage() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(0);

  const current = tourSteps[step];
  const isFirst = step === 0;
  const isLast = step === tourSteps.length - 1;

  const handleNext = () => {
    if (isLast) {
      setLocation("/login");
    } else {
      setStep(step + 1);
    }
  };

  const handlePrev = () => {
    if (!isFirst) {
      setStep(step - 1);
    }
  };

  const handleClose = () => {
    window.history.length > 1 ? window.history.back() : setLocation("/");
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-white flex flex-col">
      <div className="flex items-center justify-between px-4 pt-4">
        <button
          onClick={handleClose}
          className="w-8 h-8 rounded-full bg-white shadow-sm border border-gray-200 flex items-center justify-center"
          data-testid="button-tour-close"
        >
          <X className="h-4 w-4 text-gray-500" />
        </button>
        <p className="text-xs text-gray-400 font-medium">
          {step + 1} of {tourSteps.length}
        </p>
        <button
          onClick={() => setLocation("/login")}
          className="text-xs text-sky-500 font-medium"
          data-testid="button-tour-skip"
        >
          Skip
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-6">
        <div className="mb-6">
          <PhoneMockup step={current.mockup} />
        </div>

        <h2
          className="text-xl font-bold text-gray-900 text-center mb-2"
          data-testid="text-tour-title"
        >
          {current.title}
        </h2>
        <p
          className="text-sm text-gray-500 text-center max-w-xs leading-relaxed"
          data-testid="text-tour-description"
        >
          {current.description}
        </p>
      </div>

      <div className="px-6 pb-8 space-y-4">
        <div className="flex justify-center gap-1.5">
          {tourSteps.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step ? "w-6 bg-sky-500" : "w-1.5 bg-gray-300"
              }`}
              data-testid={`button-tour-dot-${i}`}
            />
          ))}
        </div>

        <div className="flex gap-3">
          {!isFirst && (
            <Button
              variant="outline"
              onClick={handlePrev}
              className="flex-1"
              size="lg"
              data-testid="button-tour-prev"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          )}
          <Button
            onClick={handleNext}
            className="flex-1"
            size="lg"
            data-testid="button-tour-next"
          >
            {isLast ? "Get started" : "Next"}
            {!isLast && <ArrowRight className="h-4 w-4 ml-1" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
