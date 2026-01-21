import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";

const faqs = [
  {
    question: "What happens if I miss a check-in?",
    answer:
      "We send you a reminder first. If you still don't respond after the grace period, we send a message to your emergency contacts so they can check on you.",
  },
  {
    question: "What if my phone is off?",
    answer:
      "StillHere works by waiting for you to tap the green button. If your phone is off and you miss your check-in time, we'll send a message to your emergency contacts so they can check on you.",
  },
  {
    question: "Will you share my location?",
    answer:
      "Location sharing is off by default. You choose whether to share it. If you turn it on, your emergency contacts can see where you are when they need to check on you. You can change this anytime in Settings.",
  },
  {
    question: "What happens when an emergency contact responds?",
    answer:
      "When your emergency contact receives a message, they can tap a link to see your status. If they say \"I'm handling this\", we stop sending more alerts while they check on you. If they can't reach you, they can ask us to notify your other emergency contact.",
  },
  {
    question: "Can I change my check-in schedule?",
    answer:
      "Yes. Go to Settings and choose how often to check in.",
  },
  {
    question: "What is the grace period?",
    answer:
      "After your check-in is due, we wait 10-30 minutes before notifying your emergency contacts. This gives you extra time to respond.",
  },
  {
    question: "How do I add emergency contacts?",
    answer:
      "Go to Settings and scroll to 'Emergency contacts'. You can add up to two people who will be notified if you don't respond.",
  },
  {
    question: "Can I pause check-ins temporarily?",
    answer:
      "Yes. If you're busy or going somewhere without your phone, you can pause alerts in Settings. Choose 2 hours, 6 hours, or until tomorrow morning. While paused, we won't send reminders or notify your emergency contacts if you miss a check-in.",
  },
  {
    question: "What are reminders?",
    answer:
      "Reminders are messages we send to you before notifying your emergency contacts. They give you a chance to check in if you forgot.",
  },
  {
    question: "How many reminders can I get?",
    answer:
      "You can choose none, one, or two reminders in Settings. We recommend one reminder.",
  },
  {
    question: "What if I don't respond to reminders?",
    answer:
      "If the grace period ends and you haven't checked in, we notify your emergency contacts regardless of how many reminders were sent.",
  },
];

export default function HelpPage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background pb-12">
      {/* Header */}
      <header className="bg-primary text-primary-foreground px-6 py-4 sticky top-0 z-10">
        <div className="max-w-md mx-auto flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            className="text-primary-foreground"
            onClick={() => setLocation("/settings")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold" data-testid="text-help-title">What happens if…</h1>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-4">
        <p className="text-center text-muted-foreground text-sm pb-2">
          StillHere is designed to support you, not rush or alarm you.
        </p>
        {faqs.map((faq, index) => (
          <Card key={index}>
            <CardContent className="pt-6">
              <h3 className="font-semibold text-foreground mb-2" data-testid={`text-question-${index}`}>
                {faq.question}
              </h3>
              <p className="text-muted-foreground text-sm" data-testid={`text-answer-${index}`}>
                {faq.answer}
              </p>
            </CardContent>
          </Card>
        ))}

        <div className="text-center pt-4">
          <p className="text-sm text-muted-foreground">
            Still have questions? Contact us at{" "}
            <a href="mailto:support@stillhere.app" className="text-primary underline">
              support@stillhere.app
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
