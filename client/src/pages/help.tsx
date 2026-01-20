import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";

const faqs = [
  {
    question: "What happens if I miss a check-in?",
    answer:
      "We'll remind you first. If you still don't respond after the grace period, we'll gently notify your emergency contacts so they can check on you.",
  },
  {
    question: "What if my phone is off?",
    answer:
      "If we can't reach you, and a check-in is missed, your emergency contacts may be notified so they know to check in on you.",
  },
  {
    question: "Will you share my location?",
    answer:
      "Only if you turn location sharing on. You're always in control and can turn it off anytime.",
  },
  {
    question: "What happens when a contact responds?",
    answer:
      'If a contact responds with "I\'m handling this," we pause further alerts while they check on you, so you\'re not overwhelmed.',
  },
  {
    question: "Can I change my check-in schedule?",
    answer:
      "Yes! Go to Settings and choose how often you'd like to check in - once a day, every 2 days, or set your own schedule.",
  },
  {
    question: "What is the grace period?",
    answer:
      "After your check-in is due, we wait 10-30 minutes before notifying your contacts. This gives you time to respond if you're just running late.",
  },
  {
    question: "How do I add emergency contacts?",
    answer:
      "Go to Settings and scroll to 'Emergency contacts'. You can add up to two people who will be notified if you don't respond.",
  },
  {
    question: "Can I pause check-ins temporarily?",
    answer:
      "Yes. In Settings, you can pause alerts for 2 hours, 6 hours, or until tomorrow morning — perfect for travel, rest, or busy days.",
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
