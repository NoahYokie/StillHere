import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function TermsOfServicePage() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background" data-testid="page-terms-of-service">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => window.history.back()} data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold">Terms of Service</h1>
      </header>

      <main className="px-4 py-6 max-w-2xl mx-auto space-y-6 text-sm text-muted-foreground leading-relaxed">
        <p className="text-xs">Last updated: April 2026</p>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">1. Acceptance of Terms</h2>
          <p>By downloading, installing, or using StillHere Health & Safety ("the App"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the App.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">2. Description of Service</h2>
          <p>StillHere is a personal safety checkin application that allows users to confirm their wellbeing on a daily schedule. If a checkin is missed, the App notifies designated emergency contacts. Additional features include SOS alerts, live location sharing, driving safety monitoring, fall detection, and heart rate monitoring.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">3. Not an Emergency Service</h2>
          <p>StillHere is not a replacement for emergency services such as 000, 911, 112, or other local emergency numbers. In a life-threatening emergency, always contact your local emergency services first. The App is designed as an additional safety net and does not guarantee emergency response.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">4. Account Registration</h2>
          <p>You must provide a valid phone number to create an account. You are responsible for maintaining the confidentiality of your account and for all activities that occur under your account. You must provide accurate and complete information when registering.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">5. Subscription and Payments</h2>
          <p>StillHere offers a free trial period of 14 days. After the trial, continued access requires a paid subscription. Subscriptions are billed through the Apple App Store or Google Play Store. By subscribing, you agree to the pricing and payment terms presented at the time of purchase. Subscriptions automatically renew unless cancelled at least 24 hours before the end of the current billing period.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">6. User Responsibilities</h2>
          <ul className="list-disc pl-5 space-y-2 mt-2">
            <li>You are responsible for ensuring your emergency contacts have consented to receive notifications from the App.</li>
            <li>You must not use the App for any unlawful purpose or in any way that could harm others.</li>
            <li>You are responsible for maintaining accurate and up-to-date contact information.</li>
            <li>You acknowledge that SMS delivery depends on your carrier and network conditions and may not always be instant.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">7. Limitation of Liability</h2>
          <p>To the maximum extent permitted by law, StillHere Health and its affiliates shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of life, personal injury, or property damage arising from the use of or inability to use the App. The App is provided "as is" without warranties of any kind.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">8. SMS and Notifications</h2>
          <p>By using the App, you consent to receiving SMS messages and push notifications related to your safety checkins, alerts, and account activity. Standard messaging rates from your carrier may apply.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">9. Account Deletion</h2>
          <p>You may delete your account at any time through the App settings. Upon deletion, all personal data associated with your account will be permanently removed within 30 days. Active subscriptions should be cancelled through the App Store or Google Play Store before deleting your account.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">10. Modifications to Terms</h2>
          <p>We reserve the right to modify these Terms of Service at any time. We will notify users of significant changes through the App. Continued use of the App after changes constitutes acceptance of the modified terms.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">11. Governing Law</h2>
          <p>These Terms of Service shall be governed by and construed in accordance with the laws of Australia, without regard to its conflict of law provisions.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">12. Contact Us</h2>
          <p>If you have questions about these Terms of Service, please contact us at:</p>
          <p className="mt-1 text-foreground">support@stillhere.health</p>
        </section>
      </main>
    </div>
  );
}
