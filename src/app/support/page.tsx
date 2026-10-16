import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter, PublicHeader } from "@/components/public-brand";
import { publicBranding } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata(): Metadata {
  return { title: `Support · ${publicBranding().name}`, robots: { index: true, follow: true } };
}

export default function SupportPage() {
  const { name, supportEmail } = publicBranding();
  return <div className="public-site"><PublicHeader name={name}/>
    <main className="document-main support-main">
      <header className="document-heading"><span className="eyebrow">We&apos;ll help you get connected</span><h1>Support</h1><p className="muted">Connection questions, synchronization issues, and account or data requests.</p></header>
      <section className="support-contact" aria-labelledby="contact-heading"><div><h2 id="contact-heading">Contact the integration operator</h2>{supportEmail ? <p>Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>. Include your property name, the approximate time of the issue, and the message shown in Recent activity.</p> : <p>A support email has not been configured yet. The operator must add a contact before this service is launched publicly.</p>}<p className="helper">Keep secrets out of support messages. Never send access tokens, API keys, sign-in codes, passwords, or guest payment details.</p></div>{supportEmail && <a href={`mailto:${supportEmail}`} className="button primary">Email support <span aria-hidden="true">↗</span></a>}</section>
      <section className="support-questions" aria-labelledby="questions-heading"><h2 id="questions-heading">Start with these checks</h2>
        <details open><summary>Google sign-in or Calendar permission failed</summary><p>Start again using <strong>Continue with Google</strong>. Choose the account whose calendar should receive reservations, then explicitly allow permission to view and edit Calendar events. Sign-in and Calendar connection use this one authorization. If the request expired, start a new one. Google may require its own account security checks. Contact support if the problem persists.</p></details>
        <details><summary>ChatBeds or Google will not connect</summary><p>Start the connection from your workspace. Use an account authorized to manage the ChatBeds property, and approve Calendar event access on Google&apos;s consent screen. If a connection request expires, start again. During app review or testing, access may be restricted to eligible properties or test accounts.</p></details>
        <details><summary>A new reservation is missing from Calendar</summary><p>Check that both services show <strong>Connected</strong> for the correct property. Review <strong>Recent activity</strong> for an error. Reconnect a service if requested, then use <strong>Process pending / retry errors</strong>. A manual import for the reservation&apos;s arrival date can also recover the event.</p></details>
        <details><summary>How do I import existing reservations?</summary><p>Choose an arrival-date range and click <strong>Sync Reservations Now</strong>. Each request supports up to 90 days. Import longer periods in several runs. Repeating an import keeps one event per reservation. Review any warnings about an incomplete result.</p></details>
        <details><summary>I disconnected a service, but events remain</summary><p>Disconnection pauses synchronization and removes the applicable stored credentials. Existing calendar events remain. You can remove them in Google Calendar. Disconnecting Google revokes this app&apos;s permission for that account, which can also affect other properties using the same account.</p></details>
        <details><summary>Can I edit a reservation from Google Calendar?</summary><p>Manage reservations in ChatBeds. Synchronization runs from ChatBeds to Google Calendar; Calendar edits do not update ChatBeds and may be overwritten by the next reservation synchronization.</p></details>
        <details><summary>How do I delete my account or integration data?</summary><p>Contact support from your sign-in email address and specify the account or property you want removed. Identity verification may be needed. There is no self-service account deletion button at present.</p></details>
      </section><div className="support-next"><p>Setting up your first property?</p><Link className="button secondary" href="/setup">Read the hotel guide →</Link></div>
    </main><PublicFooter name={name}/></div>;
}
