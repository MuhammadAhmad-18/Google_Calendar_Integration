import Link from "next/link";
import type { Metadata } from "next";
import { PublicFooter, PublicHeader } from "@/components/public-brand";
import { appAccessMode, publicBranding } from "@/lib/config";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata(): Metadata {
  const publicMode = appAccessMode() === "public";
  return { title: publicMode ? `Connection guide · ${publicBranding().name}` : "Connection guide", robots: { index: publicMode, follow: publicMode } };
}
export default function Setup() {
  if (appAccessMode() === "public") return <HotelGuide/>;
  // This public guide contains examples only, never environment or account data.
  return (
    <main className="dashboard-main setup-main">
      <header className="setup-heading">
        <span className="eyebrow">Connection guide · Phase 2</span>
        <h1>Set up your connected calendar</h1>
        <p className="muted">Connect a ChatBeds property, choose its Google Calendar, then bring your reservations across. Start with your own unlisted app and Sandbox Hotel before connecting other properties.</p>
      </header>

      <section className="setup-section">
        <h2>1. Prepare your database</h2>
        <p>Create a Supabase cloud project. Open <strong>SQL Editor</strong> and run these migration files in order:</p>
        <ol>
          <li>For a new database, run <code>supabase/migrations/202610110001_phase1.sql</code>.</li>
          <li>Run <code>supabase/migrations/202610110002_phase2.sql</code> to add app installations. If Phase 1 is already working, run only this second migration.</li>
          <li>Copy the project URL and server-side service role key into your environment configuration.</li>
        </ol>
        <p className="setup-callout">Keep your existing encryption key when upgrading. Your stored Google connection and reservation mappings depend on it.</p>
      </section>

      <section className="setup-section">
        <h2>2. Choose your ChatBeds connection</h2>
        <h3>App OAuth · Phase 2</h3>
        <ol>
          <li>In ChatBeds, open <strong>Developers → New app</strong>. Register your integration and keep the app unlisted while testing.</li>
          <li>Copy its client ID and client secret into the environment variables below. Request only <code>reservations:read</code>.</li>
          <li>Register your app&apos;s install address ending in <code>/api/chatbeds/install</code> and callback address ending in <code>/api/chatbeds/callback</code>.</li>
          <li>Set <code>CHATBEDS_AUTH_MODE=oauth</code>. Restart locally or redeploy on Vercel.</li>
          <li>Sign in to this dashboard and click <strong>Connect ChatBeds</strong>. Choose your Sandbox Hotel and approve access.</li>
        </ol>
        <pre><code>{`CHATBEDS_AUTH_MODE=oauth
CHATBEDS_CLIENT_ID=cba_REPLACE_ME
CHATBEDS_CLIENT_SECRET=cbs_REPLACE_ME
CHATBEDS_REDIRECT_URI=https://YOUR_APP_DOMAIN/api/chatbeds/callback
CHATBEDS_OAUTH_AUTHORIZE_URL=https://app.chatbeds.app/oauth/authorize
CHATBEDS_OAUTH_TOKEN_URL=https://app.chatbeds.app/oauth/token
CHATBEDS_OAUTH_REVOKE_URL=https://app.chatbeds.app/oauth/revoke`}</code></pre>
        <p className="setup-callout">This is a trusted admin workspace. An operator opening your ChatBeds install address must sign in here before continuing. Each property has its own calendar connection, sync jobs, and activity.</p>
        <h3 style={{ marginTop: 22 }}>Sandbox API key · Existing setup</h3>
        <p style={{ marginTop: 8 }}>To keep using Phase 1, set <code>CHATBEDS_AUTH_MODE=api_key</code> and keep your <code>CHATBEDS_API_KEY</code>. Click <strong>Test ChatBeds connection</strong> to verify the key&apos;s property. App OAuth client credentials are not needed in this mode.</p>
      </section>

      <section className="setup-section">
        <h2>3. Configure Google Calendar</h2>
        <ol>
          <li>Create or choose a Google Cloud project and enable <strong>Google Calendar API</strong>.</li>
          <li>Configure the OAuth consent screen. While testing, add your own Google account as a test user.</li>
          <li>Create an OAuth client with the type <strong>Web application</strong>. Register the exact <code>GOOGLE_REDIRECT_URI</code>.</li>
          <li>For local development, use <code>http://localhost:3000/api/google/callback</code>. For Vercel, use <code>https://YOUR_APP_DOMAIN/api/google/callback</code>.</li>
          <li>Add <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, and <code>GOOGLE_CALENDAR_ID=primary</code> to your environment.</li>
          <li>Choose your property in the dashboard, click <strong>Connect Google Calendar</strong>, and grant permission to view and edit calendar events. Repeat for each property you connect.</li>
        </ol>
      </section>

      <section className="setup-section">
        <h2>4. Deploy and receive reservation changes</h2>
        <ol>
          <li>Copy <code>.env.example</code> to <code>.env.local</code> for local work. Fill the required placeholders and generate the independent encryption, session, admin, and cron secrets described there.</li>
          <li>Deploy to Vercel. Add the same server configuration under <strong>Project Settings → Environment Variables</strong>. Set <code>NEXT_PUBLIC_APP_URL</code> to the exact public app origin, update both callback URLs, and redeploy.</li>
          <li>In app OAuth mode, open <strong>ChatBeds Developers → your app → Webhook</strong> and set <code>https://YOUR_APP_DOMAIN/api/webhooks/chatbeds</code>. In API key mode, set that address on the Sandbox key under <strong>Settings → Partner API</strong>.</li>
          <li>Copy the generated signing secret into <code>CHATBEDS_WEBHOOK_SECRET</code>. Set <code>CHATBEDS_WEBHOOK_URL</code> to your webhook address, then restart or redeploy.</li>
        </ol>
        <p className="setup-callout">Local webhook testing needs a public HTTPS tunnel such as ngrok or Cloudflare Tunnel. Use its public address for the webhook. Your Google and ChatBeds callback addresses must exactly match the values registered with each provider.</p>
      </section>

      <section className="setup-section">
        <h2>5. Test the complete flow</h2>
        <ol>
          <li>Check that ChatBeds and Google Calendar show <strong>Connected</strong> for the selected property.</li>
          <li>Run a manual arrival-date sync. Running the same range again should keep one event per reservation.</li>
          <li>Create a Sandbox reservation and check that its all-day event appears in your selected Google Calendar.</li>
          <li>Modify its dates or room. The same calendar event should update.</li>
          <li>Cancel it or mark it no-show. The event should be removed.</li>
          <li>Disconnect and reconnect ChatBeds to test installation recovery. Existing calendar events are retained during disconnection; syncing resumes after reconnecting.</li>
        </ol>
        <p className="setup-callout">Webhooks are acknowledged and then processed from the database queue. The scheduled Vercel recovery sweep runs daily. Use <strong>Process pending / retry errors</strong> in the dashboard to resume work sooner after resolving an error.</p>
      </section>

      <footer className="dashboard-footer"><span>The project README contains the full setup and troubleshooting instructions.</span><Link href="/">Back to dashboard →</Link></footer>
    </main>
  );
}

function HotelGuide() {
  const { name } = publicBranding();
  return <div className="public-site"><PublicHeader name={name}/><main className="document-main setup-main">
    <header className="document-heading"><span className="eyebrow">Your hotel connection guide</span><h1>From reservations to your calendar.</h1><p className="muted">Connect your ChatBeds property and Google account, import existing stays, and let future changes synchronize.</p><a href="/api/chatbeds/install" className="button primary guide-start">Connect your hotel <span aria-hidden="true">→</span></a></header>
    <section className="setup-section"><h2>Before you begin</h2><p>You need access to a ChatBeds property you are authorized to manage, an eligible ChatBeds plan, and a Google account with a calendar you can edit. Keep in mind that guest names and stay details will be visible to anyone with access to that calendar.</p><p className="setup-callout">Your hotel does not need an API key, a Google Cloud project, or its own deployment. App availability can be limited during testing or review.</p></section>
    <section className="setup-section"><h2>1. Continue with Google</h2><ol><li>Choose <strong>Connect your hotel</strong> here, or start from the integration&apos;s ChatBeds Apps entry when available.</li><li>Click <strong>Continue with Google</strong> and choose the Google account intended for hotel operations. This signs you in or creates your workspace account.</li><li>On Google&apos;s permission screen, allow access to view and edit Calendar events. The same authorization connects that account&apos;s primary calendar for reservation synchronization.</li></ol><p className="setup-callout">There is no emailed sign-in code and no separate initial Calendar connection step. Google may still ask you to sign in or complete its own security checks.</p></section>
    <section className="setup-section"><h2>2. Connect your ChatBeds property</h2><ol><li>Sign in to ChatBeds if prompted.</li><li>Choose the property you manage and review reservation-read permission.</li><li>Approve access and return to your workspace.</li><li>Check that the property name is correct and ChatBeds shows <strong>Connected</strong>.</li></ol><p className="setup-callout">Each connection belongs to one property. To connect another property you manage, use <strong>Add property</strong>. You will see only connections associated with your account.</p></section>
    <section className="setup-section"><h2>3. Check your connected calendar</h2><p>Google Calendar is already connected using the account you chose at sign-in. Check the email address and calendar shown in your workspace before importing stays. If you previously disconnected Google or a permission expires, use the Calendar reconnect button to restore access.</p></section>
    <section className="setup-section"><h2>4. Import existing stays</h2><ol><li>Select the arrival dates you want to import, up to 90 days in one request.</li><li>Click <strong>Sync Reservations Now</strong> and keep the workspace open while progress updates.</li><li>Review created, updated, skipped, deleted, and failed counts.</li><li>Open Google Calendar and check the resulting all-day events.</li></ol><p className="setup-callout">You can repeat the same range safely. Checkout is the exclusive end date: a stay arriving on the 15th and departing on the 18th covers the 15th–17th. Review warnings if a search result is incomplete.</p></section>
    <section className="setup-section"><h2>5. Keep working in ChatBeds</h2><p>New active reservations create calendar events. Changes update the matching event. Cancellations and no-shows remove it. Future changes are received automatically; use Recent activity to check synchronization results.</p><p>Calendar edits do not change reservations in ChatBeds. If an error appears, resolve it or reconnect the affected service, then choose <strong>Process pending / retry errors</strong>.</p></section>
    <section className="setup-section"><h2>Disconnecting a connection</h2><p>Use your workspace to disconnect either service. You can also remove the app through ChatBeds&apos; connected Apps settings. Existing Google Calendar events remain.</p><p className="setup-callout">Google revocation applies to the Google account&apos;s permission for this app. Other properties using the same Google account may also need to reconnect.</p></section>
    <div className="support-next"><p>Need a hand with your connection?</p><Link href="/support" className="button secondary">Get support →</Link></div>
  </main><PublicFooter name={name}/></div>;
}
