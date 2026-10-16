import type { Metadata } from "next";
import Link from "next/link";
import { Dashboard, Login } from "@/components/dashboard";
import { PublicFooter, PublicHeader } from "@/components/public-brand";
import { isAdmin } from "@/lib/auth/session";
import { appAccessMode, publicBranding } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata(): Metadata {
  const publicMode = appAccessMode() === "public";
  return { title: publicMode ? publicBranding().name : "ChatBeds × Google Calendar", description: "Connect your ChatBeds property to Google Calendar. Keep reservation creations, changes, and cancellations synchronized.", robots: { index: publicMode, follow: publicMode } };
}

export default async function Page() {
  if (appAccessMode() !== "public") return await isAdmin() ? <Dashboard/> : <Login/>;
  const { name } = publicBranding();
  return <div className="public-site">
    <PublicHeader name={name}/>
    <main className="public-main">
      <section className="public-hero" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <span className="eyebrow">A clearer view of every stay</span>
          <h1 id="hero-heading">Reservations in ChatBeds.<br/><span>Right there in your calendar.</span></h1>
          <p>Continue with Google to sign in and connect your calendar, then authorize your hotel in ChatBeds. New stays, date changes, and cancellations flow into your calendar.</p>
          <div className="hero-actions"><a href="/api/chatbeds/install" className="button primary">Connect your hotel <span aria-hidden="true">→</span></a><Link href="/setup" className="hero-guide">See the hotel guide ↗</Link></div>
          <p className="hero-footnote">Your permission. Your property. Your Google account.</p>
        </div>
        <aside className="hero-flow" aria-label="How reservation synchronization works">
          <div className="hero-flow-header"><span className="eyebrow">The connection</span><span className="quiet-tag">One-way sync</span></div>
          <div className="hero-service"><span className="service-mark hotel-mark" aria-hidden="true">CB</span><div><strong>ChatBeds</strong><span>You manage your reservations here.</span></div></div>
          <div className="flow-connector"><span aria-hidden="true">↓</span><p>Create · Update · Cancel</p></div>
          <div className="hero-service"><span className="service-mark calendar-mark" aria-hidden="true"><span>31</span></span><div><strong>Google Calendar</strong><span>Your stays appear as all-day events.</span></div></div>
          <p className="flow-note">A reservation keeps its matching event. Repeat imports keep one event per reservation.</p>
        </aside>
      </section>

      <section className="public-onboarding" aria-labelledby="onboarding-heading">
        <div className="public-section-intro"><span className="eyebrow">A few steps, then you&apos;re connected</span><h2 id="onboarding-heading">Set it up. Get back to your guests.</h2><p className="muted">No API keys to copy and no software to install.</p></div>
        <ol className="onboarding-steps">
          <li><span className="step-index">01</span><h3>Continue with Google</h3><p>Sign in and grant Calendar event access together. Your account&apos;s primary calendar is connected with the same permission step.</p></li>
          <li><span className="step-index">02</span><h3>Authorize your hotel</h3><p>Choose the property you manage in ChatBeds and allow reservation access. Both services are then connected.</p></li>
          <li><span className="step-index">03</span><h3>Bring your reservations across</h3><p>Import an arrival-date range. Future reservation changes arrive automatically through the connection.</p></li>
        </ol>
      </section>

      <section className="public-details" aria-labelledby="details-heading">
        <div><span className="eyebrow">Built for day-to-day hotel operations</span><h2 id="details-heading">The right details.<br/>A familiar place to find them.</h2><p>Your calendar shows guest names, rooms, stay dates, and reservation references. Phone numbers, email addresses, and payment information stay out of the event.</p><Link href="/privacy">Read about your data →</Link></div>
        <dl className="behavior-list"><div><dt>A new reservation</dt><dd>Creates an all-day event covering the stay.</dd></div><div><dt>A reservation changes</dt><dd>Updates the matching event, including dates and room details.</dd></div><div><dt>A cancellation or no-show</dt><dd>Removes the reservation&apos;s event.</dd></div></dl>
      </section>
      <div className="public-boundary"><strong>ChatBeds stays your source of truth.</strong><p>Calendar edits do not change reservations in ChatBeds. You choose who can view your Google calendar, and you can disconnect either service from your workspace.</p></div>
    </main>
    <PublicFooter name={name}/>
  </div>;
}
