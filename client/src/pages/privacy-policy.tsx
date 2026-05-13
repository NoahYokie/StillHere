import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useDocumentMeta } from "@/hooks/use-document-meta";

export default function PrivacyPolicyPage() {
  const [, setLocation] = useLocation();
  useDocumentMeta({
    title: "Privacy Policy — StillHere",
    description: "How StillHere collects, uses, and protects your personal and location data.",
  });

  return (
    <div className="min-h-screen bg-background" data-testid="page-privacy-policy">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-3 flex items-center gap-3">
        <BackButton />
        <h1 className="text-lg font-semibold">Privacy Policy</h1>
      </header>

      <main className="px-4 py-6 max-w-2xl mx-auto space-y-6 text-sm text-muted-foreground leading-relaxed">
        <p className="text-xs">Last updated: April 2026</p>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Introduction</h2>
          <p>StillHere Health ("we", "our", "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your personal information when you use our safety checkin application.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Information We Collect</h2>
          <ul className="list-disc pl-5 space-y-2">
            <li><strong className="text-foreground">Phone Number:</strong> Used for account authentication via one-time codes sent by SMS.</li>
            <li><strong className="text-foreground">Name:</strong> Your display name within the app, visible to your emergency contacts.</li>
            <li><strong className="text-foreground">Email Addresses:</strong> Emergency contact email addresses for sending safety notifications.</li>
            <li><strong className="text-foreground">Location Data:</strong> GPS coordinates collected when you use live location sharing, geofencing, driving safety, or checkin location features. Location data is only collected when you actively use these features.</li>
            <li><strong className="text-foreground">Health Data:</strong> Heart rate readings from Apple Watch via HealthKit, used to monitor for abnormal readings and send alerts to your contacts.</li>
            <li><strong className="text-foreground">Usage Data:</strong> Checkin history, app interactions, and feature usage to provide the safety monitoring service.</li>
            <li><strong className="text-foreground">Crash Data:</strong> Anonymous crash reports and error logs to improve app stability.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">How We Use Your Information</h2>
          <ul className="list-disc pl-5 space-y-2">
            <li>To authenticate your identity and maintain your account.</li>
            <li>To send safety checkin reminders and notifications.</li>
            <li>To notify your emergency contacts when you miss a checkin or trigger an SOS alert.</li>
            <li>To provide live location sharing, geofencing, and driving safety features.</li>
            <li>To monitor heart rate data and alert contacts of abnormal readings.</li>
            <li>To improve app performance and fix bugs.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Data Sharing</h2>
          <p>We do not sell your personal information to third parties. We share data only in the following cases:</p>
          <ul className="list-disc pl-5 space-y-2 mt-2">
            <li><strong className="text-foreground">Emergency Contacts:</strong> Your safety status, location (when shared), and alerts are shared with your designated emergency contacts.</li>
            <li><strong className="text-foreground">SMS Provider:</strong> We use Twilio to send text messages. Your phone number is shared with Twilio solely for message delivery.</li>
            <li><strong className="text-foreground">Legal Requirements:</strong> We may disclose information if required by law or to protect the safety of our users.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Data Security</h2>
          <p>We implement industry-standard security measures including HTTPS encryption for all data in transit, secure session management with httpOnly cookies, hashed one-time codes, and rate limiting to prevent abuse. We follow bank-level security practices to protect your data.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Data Retention</h2>
          <p>Your account data is retained as long as your account is active.</p>
          <p className="mt-2">StillHere stores location data only when location sharing or a safety feature is active. Location history is retained according to your location retention setting, with 30 days as the default. Location tied to an open safety incident may be kept while the incident is active. Deleting your account removes your StillHere location history from our active database.</p>
          <p className="mt-2">If you delete your account, all personal data is permanently removed within 30 days.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Your Rights</h2>
          <ul className="list-disc pl-5 space-y-2">
            <li>You can view and update your personal information in the app settings.</li>
            <li>You can delete your account at any time from the app settings, which permanently removes all your data.</li>
            <li>You can control location sharing and heart rate monitoring by disabling those features.</li>
            <li>You can contact us at support@stillhere.health for any privacy-related requests.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Children's Privacy</h2>
          <p>StillHere is intended for users 13 and older. We do not knowingly collect personal information from children under 13. If we learn we have, we will delete the account and associated data.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Changes to This Policy</h2>
          <p>We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new policy within the app. Continued use of the app after changes constitutes acceptance of the updated policy.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">Contact Us</h2>
          <p>If you have questions about this Privacy Policy, please contact us at:</p>
          <p className="mt-1 text-foreground">support@stillhere.health</p>
        </section>
      </main>
    </div>
  );
}
