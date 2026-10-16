"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { PublicBrand } from "@/components/public-brand";

const signInErrors: Record<string, string> = {
  google_state_invalid: "Your Google sign-in request expired or could not be verified. Please start again.",
  google_denied: "Google authorization was cancelled. Continue again when you are ready.",
  google_permission_missing: "Calendar event access was not granted. Continue with Google again and select permission to view and edit events on your calendars.",
  google_offline_missing: "Google did not provide permission for ongoing synchronization. Continue again and approve access. If this repeats, contact support.",
  google_signin_failed: "Google sign-in could not be completed. Please try again or contact support.",
};

function GoogleMark() {
  return <svg className="google-signin-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.31 2.98-7.36Z"/>
    <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.51c-.9.6-2.04.97-3.38.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/>
    <path fill="#FBBC05" d="M6.41 13.92A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.92V7.49H3.07A10 10 0 0 0 2 12c0 1.61.39 3.14 1.07 4.51l3.34-2.59Z"/>
    <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.86-2.86A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/>
  </svg>;
}

export function HotelLogin({ name, continueInstall = false, notice }: { name: string; continueInstall?: boolean; notice?: string }) {
  const [busy, setBusy] = useState(false);
  const error = notice ? signInErrors[notice] : undefined;

  function submit(event: FormEvent<HTMLFormElement>) {
    if (busy) { event.preventDefault(); return; }
    setBusy(true);
  }

  return <main className="login-shell public-login-shell">
    <section className="login-panel hotel-login-panel" aria-labelledby="login-heading">
      <PublicBrand name={name}/>
      <span className="eyebrow">Your hotel workspace</span>
      <h1 id="login-heading">One Google account.<br/>A connected calendar.</h1>
      <p className="muted">Sign in and connect your primary Google Calendar in one step. On Google&apos;s screen, allow Calendar event access.</p>
      {continueInstall && <p className="login-context"><span className="status-dot"/> Next, you&apos;ll authorize your ChatBeds property.</p>}
      {error && <p className="field-error google-signin-error" role="alert">{error}</p>}
      <form method="POST" action="/api/auth/google" onSubmit={submit} aria-busy={busy}>
        <input type="hidden" name="intent" value={continueInstall ? "install" : "signin"}/>
        <button className="button wide google-signin-button" disabled={busy} type="submit"><GoogleMark/><span>{busy ? "Opening Google…" : "Continue with Google"}</span></button>
        <p className="google-signin-help" role="status">{busy ? "Choose your account and review permissions on Google’s secure screen." : "Use the Google account whose calendar should receive your reservations."}</p>
      </form>
      <div className="login-next-step"><span className="step-index">Next</span><p>{continueInstall ? <>Authorize the hotel you manage in ChatBeds. You&apos;ll return with both services connected, ready to import existing stays.</> : <>New here? You&apos;ll authorize your hotel in ChatBeds next. Returning users can open their existing workspace.</>}</p></div>
      <p className="login-note">Read how your information is handled in our <Link href="/privacy">privacy policy</Link>. Need help? <Link href="/support">Contact support</Link>.</p>
    </section>
    <p className="login-footer"><Link href="/">← Back to home</Link><span>ChatBeds → Google Calendar</span></p>
  </main>;
}
