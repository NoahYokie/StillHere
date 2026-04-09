import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Heart, ChevronLeft, ChevronDown } from "lucide-react";
import { useState } from "react";

const faqs = [
  {
    category: "Getting Started",
    questions: [
      {
        q: "What is StillHere?",
        a: "StillHere is a safety checkin app designed for people who live alone, elderly individuals, and lone workers. You check in once a day to let your emergency contacts know you're okay. If you miss a checkin, your contacts are automatically notified so someone can check on you.",
      },
      {
        q: "Is StillHere free?",
        a: "Yes. StillHere is completely free to use. There are no subscriptions, hidden fees, or premium tiers.",
      },
      {
        q: "How do I sign up?",
        a: "Tap \"Get started\" on the home page and enter your phone number. You'll receive a one-time code via text message to verify your identity. After that, you'll set up your name, checkin schedule, and add your emergency contacts.",
      },
      {
        q: "Do my emergency contacts need the app?",
        a: "No. Your contacts are notified by text message (SMS). They don't need a smartphone, the app, or even internet access. If they do have the app, they also get push notifications and access to a watcher dashboard with more details.",
      },
    ],
  },
  {
    category: "Daily Checkins",
    questions: [
      {
        q: "How does the checkin work?",
        a: "Open the app and tap the green \"I'm OK\" button. That's it. Your contacts are notified that you're safe, and the system resets for the next day.",
      },
      {
        q: "What happens if I forget to check in?",
        a: "First, you'll get a reminder notification. If you still don't check in after a grace period, your emergency contacts are contacted one by one via SMS until someone responds.",
      },
      {
        q: "Can I check in by text message?",
        a: "Yes. If SMS checkin is enabled in your settings, you can reply YES, OK, or SAFE to a reminder text message. This is great for situations where you can't open the app.",
      },
      {
        q: "Can I change my checkin time?",
        a: "Yes. Go to Settings and adjust your checkin schedule. You can set any time that works for your routine. Your timezone is automatically detected.",
      },
      {
        q: "Can I pause checkins?",
        a: "Yes. You can pause alerts anytime from Settings. Choose 2 hours, 6 hours, or until tomorrow morning. While paused, we won't send reminders or notify your contacts if you miss a checkin.",
      },
      {
        q: "What is the grace period?",
        a: "After your checkin is due, we wait 10 to 30 minutes (you choose) before notifying your emergency contacts. This gives you extra time to respond if you're busy.",
      },
      {
        q: "How many reminders can I get?",
        a: "You can choose none, one, or two reminders in Settings. We recommend at least one reminder so you have a chance to respond before your contacts are notified.",
      },
    ],
  },
  {
    category: "Emergency Features",
    questions: [
      {
        q: "What is the SOS button?",
        a: "The red \"I Need Help\" button on the home screen sends an immediate alert to all your emergency contacts. It asks for confirmation first to prevent accidental triggers.",
      },
      {
        q: "What is the discreet SOS?",
        a: "If you're in a situation where you can't draw attention to what you're doing, hold the discreet SOS button for 3 seconds. It sends an alert silently with no confirmation dialog and no sound. Enable it in Settings.",
      },
      {
        q: "How does fall detection work?",
        a: "Fall detection uses your phone or smartwatch sensors to detect a sudden freefall followed by a hard impact, then stillness. If detected, a 60-second countdown starts. If you don't cancel it, an SOS is automatically sent to your contacts.",
      },
      {
        q: "Does fall detection work without a smartwatch?",
        a: "Fall detection works on your phone using its accelerometer. However, a smartwatch provides more reliable detection because it's always on your body, even when your phone is across the room.",
      },
    ],
  },
  {
    category: "Location Features",
    questions: [
      {
        q: "Is my location tracked?",
        a: "No. Location sharing is completely off by default. You choose when to share your location and with whom. When you stop sharing, your location data stops being collected.",
      },
      {
        q: "What is live location sharing?",
        a: "You can share your real-time position with your emergency contacts during walks, trips, or any time you want extra safety. Your contacts see your position, speed, and activity on a live map. You can stop sharing at any time.",
      },
      {
        q: "What is geofencing?",
        a: "You can set up safe zones (like home or work). If you leave a safe zone, your contacts are automatically notified. This is useful for people with memory concerns or caregivers monitoring loved ones.",
      },
      {
        q: "Can my contacts see my location during an alert?",
        a: "Only if you've enabled location sharing in your settings. If it's turned on, your emergency contacts can see your location on a map when they receive an alert.",
      },
    ],
  },
  {
    category: "Driving Safety",
    questions: [
      {
        q: "How does driving safety work?",
        a: "When enabled, StillHere monitors your speed using GPS during drive sessions. If it detects a sudden stop consistent with a crash, a 60-second countdown begins. If you don't cancel, all your contacts are alerted via SMS, push notifications, and email.",
      },
      {
        q: "Can I set a speed limit?",
        a: "Yes. You can configure a speed limit (40 to 120 km/h) in Settings. You'll receive an alert if you exceed it while a drive session is active.",
      },
      {
        q: "Does driving safety track my journeys?",
        a: "Drive sessions record max speed, average speed, and distance for your reference. You can view your drive history in the app. This data is only visible to you.",
      },
    ],
  },
  {
    category: "Communication",
    questions: [
      {
        q: "Can I message my contacts in the app?",
        a: "Yes. StillHere has built-in messaging with real-time delivery, typing indicators, and read receipts. Your messages are kept private within the app.",
      },
      {
        q: "Can I make voice calls?",
        a: "Yes. You can call your contacts directly through the app using voice over internet. No phone numbers are exchanged. Everything stays within StillHere.",
      },
      {
        q: "What do my emergency contacts see when notified?",
        a: "They receive a text message with a link to a status page showing your name, when you last checked in, and your location on a map if you've enabled sharing. They also see clear steps on what to do: try calling you, send a text, or visit.",
      },
    ],
  },
  {
    category: "Smartwatch & Devices",
    questions: [
      {
        q: "Which smartwatches are supported?",
        a: "StillHere has a companion app for Apple Watch with one-tap checkin, SOS, fall detection, and heart rate monitoring. Wear OS support is planned.",
      },
      {
        q: "What about heart rate monitoring?",
        a: "If you use an Apple Watch, StillHere reads your heart rate via HealthKit. If your heart rate goes unusually high (above 120 BPM) or low (below 40 BPM), you and your contacts are alerted.",
      },
      {
        q: "Can I use a satellite communicator?",
        a: "Yes. You can connect Garmin inReach or SPOT devices. Checkins and SOS alerts from your satellite device are processed just like in-app actions. This is great for hiking or remote areas with no phone signal.",
      },
    ],
  },
  {
    category: "Watcher Dashboard",
    questions: [
      {
        q: "What is the watcher dashboard?",
        a: "If you're an emergency contact for someone who also uses StillHere, you get a watcher dashboard. It shows the status of everyone you watch, whether they've checked in, if there are any alerts, and when their next checkin is due.",
      },
      {
        q: "Can I get safety reports?",
        a: "Yes. As a watcher, you can receive scheduled email reports with checkin history, heart rate summaries, and incident logs. The person you're watching must enable reports in their settings.",
      },
      {
        q: "Can I stop watching someone?",
        a: "Yes. You can opt out of watching someone from the watcher dashboard. Your opt-out is kept for 30 days so it can be restored if needed.",
      },
    ],
  },
  {
    category: "Privacy & Security",
    questions: [
      {
        q: "Is my data secure?",
        a: "Yes. All communication is encrypted. We use secure HTTP headers, rate limiting, and input validation. Your session is stored in a secure, httpOnly cookie. We don't track you and we don't sell your data.",
      },
      {
        q: "What data do you store?",
        a: "We store your phone number, name, checkin history, and emergency contacts. Location data is only stored when you actively share your location. Heart rate data is only stored if you connect a smartwatch.",
      },
      {
        q: "What messages will I receive from StillHere?",
        a: "The only messages you'll receive are checkin reminders and alerts you've set up yourself. We keep communication simple and focused on your safety.",
      },
    ],
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        className="w-full flex items-center justify-between py-4 text-left gap-3"
        onClick={() => setOpen(!open)}
        data-testid="button-faq-toggle"
      >
        <span className="font-medium text-sm md:text-base">{q}</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="pb-4 pr-8">
          <p className="text-sm text-muted-foreground leading-relaxed">{a}</p>
        </div>
      )}
    </div>
  );
}

export default function HelpPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary text-primary-foreground px-6 py-4 sticky top-0 z-50">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => window.history.back()} className="p-1 -ml-1 hover:bg-white/10 rounded-lg" data-testid="button-back">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2">
              <Heart className="h-5 w-5" />
              <span className="font-semibold">Help & FAQ</span>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLocation("/login")}
            data-testid="button-sign-in"
          >
            Sign in
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 md:py-14">
        <div className="text-center mb-10">
          <h1 className="text-2xl md:text-3xl font-bold mb-3" data-testid="text-faq-title">Frequently Asked Questions</h1>
          <p className="text-muted-foreground">Everything you need to know about StillHere.</p>
        </div>

        <div className="space-y-8">
          {faqs.map((section) => (
            <div key={section.category}>
              <h2 className="text-lg font-semibold mb-3 text-primary" data-testid={`text-faq-category-${section.category.replace(/\s+/g, "-").toLowerCase()}`}>
                {section.category}
              </h2>
              <div className="bg-muted/30 rounded-xl border border-border px-5">
                {section.questions.map((item) => (
                  <FaqItem key={item.q} q={item.q} a={item.a} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center bg-muted/30 rounded-xl border border-border p-6 md:p-8">
          <h2 className="text-lg font-semibold mb-2">Still have questions?</h2>
          <p className="text-sm text-muted-foreground mb-1">We're here to help.</p>
          <p className="text-sm text-muted-foreground mb-4">
            Contact us at{" "}
            <a href="mailto:support@stillhere.health" className="text-primary underline">
              support@stillhere.health
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
