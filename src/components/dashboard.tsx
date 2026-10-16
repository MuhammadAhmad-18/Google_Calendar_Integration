"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PublicBrand } from "@/components/public-brand";
import { useRouter } from "next/navigation";

type Summary = {
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  failed: number;
};
type Job = {
  id: string;
  kind: "manual" | "webhook";
  status: string;
  summary: Summary;
  error: string | null;
  date_from: string | null;
  date_to: string | null;
  created_at: string;
};
type Integration = {
  id: string;
  property_id: string | null;
  property_name: string | null;
  chatbeds_status: string;
  chatbeds_error: string | null;
  google_calendar_id: string | null;
  auth_mode: "api_key" | "oauth";
  installation_id: string | null;
  chatbeds_scope: string | null;
};
type Status = {
  configuration: {
    ready: boolean;
    googleReady: boolean;
    syncReady: boolean;
    missing: string[];
    webhookUrl: string | null;
    authMode: "api_key" | "oauth";
    chatbedsOAuthReady: boolean;
    publicMode?: boolean;
  };
  integration: Integration | null;
  installations: Integration[];
  google: {
    connected: boolean;
    account_email: string | null;
    calendar_id: string | null;
  };
  logs: {
    id: number;
    source: string;
    event_type: string | null;
    reservation_id: string | null;
    reservation_ref: string | null;
    action: string;
    success: boolean;
    message: string;
    created_at: string;
  }[];
  jobs: Job[];
  user?: { email: string };
};

const notices: Record<string, string> = {
  chatbeds_connected: "ChatBeds is connected. Connect Google Calendar for this property to start syncing.",
  chatbeds_disconnected: "ChatBeds has been disconnected. Sync is paused; existing calendar events are retained.",
  chatbeds_denied: "ChatBeds authorization was cancelled. You can connect again when you are ready.",
  chatbeds_oauth_failed: "ChatBeds could not be connected. Check the app OAuth settings and try again.",
  chatbeds_state_invalid: "Your ChatBeds connection request expired or could not be verified. Please connect again.",
  chatbeds_sign_in: "Sign in to this workspace to continue connecting your ChatBeds property.",
  connected:
    "Google Calendar is connected. You can now sync your reservations.",
  disconnected: "Google Calendar has been disconnected.",
  oauth_denied:
    "Google authorization was cancelled. Connect again when you are ready.",
  oauth_failed:
    "Google could not be connected. Check your OAuth settings and try again.",
  oauth_calendar_permission_missing:
    "Google Calendar event permission was not granted. Connect again and select permission to view and edit events on your calendars.",
  oauth_state_invalid:
    "Your connection request expired or could not be verified. Please connect again.",
};

function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      throw new Error(body.error);
    }
    throw new Error(
      response.status === 401
        ? "Your session has expired. Sign in again."
        : "The request could not be completed. Please try again.",
    );
  }
  return body as T;
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        CB
      </span>
      <div>
        <strong>ChatBeds</strong>
        <span>Calendar integration</span>
      </div>
    </div>
  );
}

export function Login() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (new URLSearchParams(window.location.search).get("install") === "chatbeds") {
        window.location.assign(new URL("/api/chatbeds/install", window.location.origin).href);
      } else {
        window.location.reload();
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Sign-in failed. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <Brand />
        <span className="eyebrow">Your hotel workspace</span>
        <h1>
          Your reservations.
          <br />
          Your calendar.
        </h1>
        <p className="muted">
          Sign in to manage your hotel&apos;s Google Calendar connection and
          reservation sync. If you arrived from ChatBeds, your app connection continues after sign-in.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="admin-password">Admin password</label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <button className="button primary wide" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <p className="login-note">
          Use the admin password configured for this installation.
          <br />
          Need to set up? <a href="/setup">Read the setup guide</a>.
        </p>
      </section>
      <p className="login-footer">ChatBeds × Google Calendar · Secure admin workspace</p>
    </main>
  );
}

export function Dashboard({ publicMode = false, appName = "Chatbeds x Google Calendar" }: { publicMode?: boolean; appName?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const actionPending = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++requestGeneration.current;
    try {
      const latest = await request<Status>("/api/status", { signal });
      if (signal?.aborted || generation !== requestGeneration.current) return;
      setStatus(latest);
      setStatusError(null);
      return latest;
    } catch (cause) {
      if (signal?.aborted || generation !== requestGeneration.current) return;
      setStatusError(
        cause instanceof Error
          ? cause.message
          : "Could not load connection status.",
      );
    } finally {
      if (!signal?.aborted && generation === requestGeneration.current) setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const initialLoad = window.setTimeout(() => {
      void refresh(controller.signal).then((latest) => {
        if (!controller.signal.aborted) {
          setFrom((value) => value || localDate());
          setTo((value) => value || localDate(7));
          const code = new URLSearchParams(window.location.search).get(
            "notice",
          );
          if (code && notices[code]) {
            const lastConnection = latest?.logs.find(
              (log) => log.source === (code.startsWith("chatbeds_") ? "chatbeds_oauth" : "oauth") && log.action === "connect",
            );
            const publicFailure = publicMode && (code === "oauth_failed" || code === "chatbeds_oauth_failed")
              ? "The account could not be connected. Try connecting again; contact support if the problem continues."
              : null;
            const connectedNotice = publicMode && code === "chatbeds_connected" && latest?.google.connected
              ? "ChatBeds and Google Calendar are connected. You can now import your reservations."
              : null;
            const message = publicFailure ?? connectedNotice ?? ((code === "oauth_failed" || code === "chatbeds_oauth_failed") && lastConnection && !lastConnection.success
              ? lastConnection.message
              : notices[code]);
            if ((code.startsWith("oauth_") && code !== "oauth_denied") || code === "chatbeds_oauth_failed" || code === "chatbeds_state_invalid") {
              setError(message);
            } else {
              setNotice(message);
            }
          }
        }
      });
    }, 0);
    const interval = window.setInterval(
      () => { if (!actionPending.current) void refresh(controller.signal); },
      8_000,
    );
    return () => {
      controller.abort();
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [refresh, publicMode]);

  async function action(name: string, operation: () => Promise<string | null>) {
    if (actionPending.current) return;
    actionPending.current = true;
    ++requestGeneration.current;
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const message = await operation();
      setNotice(message);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The operation failed. Please try again.",
      );
    } finally {
      actionPending.current = false;
      setBusy(null);
    }
  }

  function sync(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const days =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000 +
      1;
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      setError(
        "Choose a valid arrival date range of 1–90 days, including both dates.",
      );
      return;
    }
    void action("sync", async () => {
      const result = await request<{ jobId: string }>("/api/chatbeds/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      setSelectedJob(result.jobId);
      return "Reservation sync queued. Progress will appear below as reservations are processed.";
    });
  }

  const googleConnected = status?.google.connected ?? false;
  const chatbedsConnected =
    status?.integration?.chatbeds_status === "connected";
  const chatbedsLabel = initialLoading
    ? "Loading…"
    : !status
      ? "Unable to check"
      : chatbedsConnected
        ? "Connected"
        : status.integration?.chatbeds_status === "error"
          ? "Error"
          : status.integration?.chatbeds_status === "disconnected"
            ? "Disconnected"
            : "Not verified";
  const googleLabel = initialLoading
    ? "Loading…"
    : !status
      ? "Unable to check"
      : googleConnected
        ? "Connected"
        : "Not connected";
  const latestJob =
    status?.jobs.find((job) => job.id === selectedJob) ??
    status?.jobs.find((job) => job.kind === "manual");
  const pending =
    status?.jobs.filter(
      (job) => !["completed", "processed", "succeeded"].includes(job.status),
    ).length ?? 0;
  const controlsDisabled = busy !== null || !status;
  const oauthMode = status?.configuration.authMode === "oauth";
  const installations = status?.installations ?? [];

  function selectProperty(integrationId: string) {
    if (integrationId === status?.integration?.id) return;
    void action("select", async () => {
      await request("/api/integrations/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationId }),
      });
      setSelectedJob(null);
      setStatus(null);
      return null;
    });
  }

  return (
    <div className={publicMode ? "workspace public-workspace" : "workspace"}>
      <header className="topbar">
        {publicMode ? <PublicBrand name={appName}/> : <Brand />}
        <div className="header-actions">
          <a className="header-help" href="/setup">{publicMode ? "Hotel guide" : "Setup guide"}</a>
          <span className="phase-tag">{publicMode ? "Hotel workspace" : "Phase 2"}</span>
          <button
            className="text-button"
            disabled={busy !== null}
            onClick={() =>
              void action("logout", async () => {
                await request(publicMode ? "/api/auth/logout" : "/api/admin/logout", { method: "POST" });
                if (publicMode) { router.replace("/login"); router.refresh(); }
                else window.location.reload();
                return null;
              })
            }
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="dashboard-main">
        <div className="page-heading">
          <div>
            <span className="eyebrow">{publicMode ? "Your hotel workspace" : "Reservation operations"}</span>
            <h1>
              ChatBeds <span className="heading-cross">×</span> Google Calendar
            </h1>
            <p className="muted">
              Every reservation, one connected calendar. Manage your properties in one place.
            </p>
          </div>
          <span className="refresh-note">
            <span className="status-dot neutral" />
            Status refreshes every 8 seconds
          </span>
        </div>

        <section className="property-bar" aria-label="Selected property">
          <div className="property-context">
            <span className="property-symbol" aria-hidden="true">⌂</span>
            <div>
              <label htmlFor="property-select">Property workspace</label>
              {installations.length > 0 ? (
                <select id="property-select" value={status?.integration?.id ?? ""} onChange={(event) => selectProperty(event.target.value)} disabled={controlsDisabled}>
                  {installations.map((installation) => <option key={installation.id} value={installation.id}>{installation.property_name ?? (publicMode ? "Connect your first property" : "Unverified property")}{installation.chatbeds_status === "disconnected" ? " · disconnected" : ""}</option>)}
                </select>
              ) : <strong>{initialLoading ? "Loading your workspace…" : "Connect your first property"}</strong>}
              <span className="property-caption">Connections and activity are specific to this property.</span>
            </div>
          </div>
          {oauthMode ? (
            <form method="POST" action="/api/chatbeds/connect">
              <button className="button secondary" type="submit" disabled={controlsDisabled || !status?.configuration.chatbedsOAuthReady}>+ Add property</button>
            </form>
          ) : <span className="quiet-tag">Sandbox API key mode</span>}
        </section>

        <div className="notifications" aria-live="polite">
          {statusError && (
            <div className="banner error" role="alert">
              <strong>Unable to check integration status</strong>
              <span>{statusError}</span>
              <a href="/setup">Open the setup guide</a>
              <button className="text-button" onClick={() => void refresh()}>
                Retry status check
              </button>
            </div>
          )}
          {error && (
            <div className="banner error" role="alert">
              <strong>Something needs attention</strong>
              <span>{error}</span>
              <button className="text-button" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {notice && (
            <div className="banner info">
              <span>{notice}</span>
              <button
                className="text-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          {status && !status.configuration.ready && (
            <div className="banner setup">
              <strong>{publicMode ? "The connection needs attention" : "Finish configuring your integration"}</strong>
              <span>
                {publicMode ? "The service is not fully available yet. Contact support if you cannot connect or synchronize your property." : <>Missing settings:{" "}
                {status.configuration.missing.join(", ") ||
                  "Review your environment configuration"}
                .
                {status.configuration.syncReady &&
                  " You can connect Google Calendar and run a manual sync while finishing webhook and scheduled recovery setup."}</>}
              </span>
              <a href={publicMode ? "/support" : "/setup"}>{publicMode ? "Contact support →" : "Open the setup guide →"}</a>
            </div>
          )}
        </div>

        <section
          className="workflow-strip"
          aria-label="One-way reservation flow"
        >
          <div className="workflow-step">
            <span className="workflow-number" aria-hidden="true">
              01
            </span>
            <div>
              <strong>ChatBeds property</strong>
              <span>{chatbedsLabel}</span>
            </div>
          </div>
          <span className="workflow-arrow" aria-hidden="true">
            →
          </span>
          <div className="workflow-step workflow-middle">
            <span className="workflow-number" aria-hidden="true">
              02
            </span>
            <div>
              <strong>Reservation changes</strong>
              <span>Create · Modify · Cancel</span>
            </div>
          </div>
          <span className="workflow-arrow" aria-hidden="true">
            →
          </span>
          <div className="workflow-step">
            <span className="workflow-number" aria-hidden="true">
              03
            </span>
            <div>
              <strong>Google Calendar</strong>
              <span>{googleLabel}</span>
            </div>
          </div>
        </section>

        <section className="connections" aria-label="Integration connections">
          <article className="connection-panel chatbeds-panel">
            <div className="panel-top">
              <span className="service-mark hotel-mark" aria-hidden="true">
                CB
              </span>
              <span
                className={`status-pill ${chatbedsConnected ? "success" : status?.integration?.chatbeds_status === "error" ? "failure" : "neutral"}`}
              >
                <span className="status-dot" />
                {chatbedsLabel}
              </span>
            </div>
            <h2>ChatBeds</h2>
            <p className="muted">Your hotel&apos;s reservation source.</p>
            <dl className="connection-details">
              <div>
                <dt>Property</dt>
                <dd>
                  {status?.integration?.property_name ??
                    (!status ? "Not available yet" : "Not verified yet")}
                </dd>
              </div>
              <div>
                <dt>Property ID</dt>
                <dd className="identifier">
                  {status?.integration?.property_id ?? "—"}
                </dd>
              </div>
              <div><dt>Connection</dt><dd>{status?.integration?.auth_mode === "oauth" ? "App OAuth · Reservations read only" : oauthMode ? "App OAuth" : "Sandbox Partner API key"}</dd></div>
            </dl>
            {status?.integration?.chatbeds_error && (
              <p className="field-error">{status.integration.chatbeds_error}</p>
            )}
            <div className="connection-actions">
            {oauthMode && (
              <form method="POST" action="/api/chatbeds/connect">
                <button className="button primary" type="submit" disabled={controlsDisabled || !status?.configuration.chatbedsOAuthReady}>
                  {chatbedsConnected ? "Reconnect ChatBeds" : "Connect ChatBeds"} <span aria-hidden="true">↗</span>
                </button>
              </form>
            )}
            <button
              className="button secondary"
              disabled={controlsDisabled || (oauthMode && !status?.integration?.property_id)}
              onClick={() =>
                void action("test", async () => {
                  const result = await request<{
                    property: { id: string; name: string };
                  }>("/api/chatbeds/test", { method: "POST" });
                  return `ChatBeds connection verified for ${result.property.name}.`;
                })
              }
            >
              {busy === "test"
                ? "Testing connection…"
                : "Test ChatBeds connection"}
            </button>
            </div>
            {oauthMode && chatbedsConnected && (
              <button className="text-button disconnect-button" disabled={controlsDisabled} onClick={() => {
                if (!window.confirm("Disconnect ChatBeds for this property? This revokes its app connection and pauses reservation sync. Existing Google Calendar events are retained.")) return;
                void action("chatbeds-disconnect", async () => {
                  const result = await request<{ ok: boolean; revoked: boolean }>("/api/chatbeds/disconnect", { method: "POST" });
                  return result.revoked ? "ChatBeds disconnected. Sync is paused; calendar events are retained." : "ChatBeds disconnected locally. Complete removal in ChatBeds Connected Apps if the remote connection remains.";
                });
              }}>{busy === "chatbeds-disconnect" ? "Disconnecting…" : "Disconnect ChatBeds"}</button>
            )}
            {oauthMode && !status?.configuration.chatbedsOAuthReady && status && <p className="helper">{publicMode ? <>ChatBeds connection is temporarily unavailable. <a href="/support">Contact support</a> for help.</> : "Finish the ChatBeds app settings in the setup guide to enable OAuth connection."}</p>}
          </article>

          <article className="connection-panel google-panel">
            <div className="panel-top">
              <span className="service-mark calendar-mark" aria-hidden="true">
                <span>31</span>
              </span>
              <span
                className={`status-pill ${googleConnected ? "success" : "neutral"}`}
              >
                <span className="status-dot" />
                {googleLabel}
              </span>
            </div>
            <h2>Google Calendar</h2>
            <p className="muted">
              The destination for your reservation events.
            </p>
            <dl className="connection-details">
              <div>
                <dt>Account</dt>
                <dd>
                  {status?.google.account_email ??
                    (!status
                      ? "Not available yet"
                      : googleConnected
                        ? "Connected Google account"
                        : "Connect an account below")}
                </dd>
              </div>
              <div>
                <dt>Calendar</dt>
                <dd>{status?.google.calendar_id ?? "primary (default)"}</dd>
              </div>
            </dl>
            {googleConnected ? (
              <button
                className="button secondary"
                disabled={controlsDisabled}
                onClick={() => {
                  if (!window.confirm("Disconnect this Google account? Google revokes this app's calendar permission for the account, so every property using the same Google account will disconnect. Existing calendar events are retained.")) return;
                  void action("disconnect", async () => {
                    await request("/api/google/disconnect", { method: "POST" });
                    return "Google Calendar disconnected for all properties using this Google account. Existing calendar events are retained.";
                  })
                }}
              >
                {busy === "disconnect"
                  ? "Disconnecting…"
                  : "Disconnect Google Calendar"}
              </button>
            ) : (
              <form method="POST" action="/api/google/connect">
                <button
                className="button primary google-button"
                  type="submit"
                  disabled={
                    controlsDisabled ||
                    !status?.configuration.googleReady ||
                    !status?.integration?.property_id
                  }
                >
                  Connect Google Calendar <span aria-hidden="true">↗</span>
                </button>
              </form>
            )}
            {!googleConnected && (
              <p className="helper">
                On Google&apos;s consent screen, select permission to view and
                edit events on your calendars, then continue.
              </p>
            )}
            {!googleConnected && status && !status.configuration.googleReady && (
              <p className="helper">
                {publicMode ? <>Google connection is temporarily unavailable. <a href="/support">Contact support</a> for help.</> : "Complete the Google, database, and secure sign-in settings to connect your calendar. See the missing settings above."}
              </p>
            )}
            {!googleConnected && status?.configuration.googleReady && !status.integration?.property_id && (
              <p className="helper">{oauthMode ? "Connect your ChatBeds property first." : "Test the ChatBeds connection first."}</p>
            )}
            {googleConnected && <p className="helper">Disconnecting revokes calendar permission for every property using this Google account. Existing events are retained.</p>}
          </article>
        </section>

        <section className="sync-panel" aria-labelledby="sync-heading">
          <div className="section-heading">
            <div>
              <span className="eyebrow">On demand</span>
              <h2 id="sync-heading">Sync reservations now</h2>
              <p className="muted">
                Import or update stays with arrival dates in this range. Maximum
                90 days.
              </p>
            </div>
            <span className="quiet-tag">Safe to run again</span>
          </div>
          <form className="sync-form" onSubmit={sync}>
            <div className="date-field">
              <label htmlFor="date-from">Arrival date from</label>
              <input
                type="date"
                id="date-from"
                required
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                disabled={busy !== null}
              />
            </div>
            <span className="date-arrow" aria-hidden="true">
              →
            </span>
            <div className="date-field">
              <label htmlFor="date-to">Arrival date to</label>
              <input
                type="date"
                id="date-to"
                required
                min={from}
                value={to}
                onChange={(event) => setTo(event.target.value)}
                disabled={busy !== null}
              />
            </div>
            <button
              className="button primary"
              type="submit"
              disabled={
                controlsDisabled ||
                !googleConnected ||
                !chatbedsConnected ||
                !status?.configuration.syncReady
              }
            >
              {busy === "sync" ? "Queuing sync…" : "Sync Reservations Now"}
              <span aria-hidden="true">→</span>
            </button>
          </form>
          {status && (!googleConnected || !chatbedsConnected) && (
            <p className="helper">
              Verify your ChatBeds connection and connect Google Calendar to
              start syncing.
            </p>
          )}

          {latestJob && (
            <div className="sync-result" aria-live="polite">
              <div className="result-heading">
                <strong>Latest manual sync</strong>
                <span
                  className={`status-pill ${latestJob.status === "completed" ? "success" : latestJob.status === "failed" ? "failure" : "neutral"}`}
                >
                  {latestJob.status.replaceAll("_", " ")}
                </span>
                <span className="muted">{timestamp(latestJob.created_at)}</span>
              </div>
              <div className="summary-counts">
                {(
                  [
                    "created",
                    "updated",
                    "skipped",
                    "deleted",
                    "failed",
                  ] as const
                ).map((key) => (
                  <div
                    key={key}
                    className={
                      key === "failed" && latestJob.summary[key] > 0
                        ? "failed-count"
                        : ""
                    }
                  >
                    <strong>{latestJob.summary[key]}</strong>
                    <span>{key}</span>
                  </div>
                ))}
              </div>
              {latestJob.error && (
                <p className="field-error">{latestJob.error}</p>
              )}
              <p className="helper">
                Arrival range: {latestJob.date_from ?? from} to{" "}
                {latestJob.date_to ?? to}
              </p>
            </div>
          )}
          <div className="pending-row">
            <div>
              <strong>Pending deliveries &amp; retries</strong>
              <p className="muted">
                {pending
                  ? `${pending} recent job${pending === 1 ? "" : "s"} awaiting processing or retry.`
                  : "Process queued work or retry a sync after resolving an error."}
              </p>
            </div>
            <button
              className="button secondary compact"
              disabled={
                controlsDisabled || !googleConnected || !chatbedsConnected
              }
              onClick={() =>
                void action("process", async () => {
                  const result = await request<{ processed: number }>(
                    "/api/jobs/process",
                    { method: "POST" },
                  );
                  return `Processed ${result.processed} pending job${result.processed === 1 ? "" : "s"}. Refreshing sync results.`;
                })
              }
            >
              {busy === "process"
                ? "Processing…"
                : "Process pending / retry errors"}
            </button>
          </div>
        </section>

        <section className="activity-panel" aria-labelledby="activity-heading">
          <div className="section-heading">
            <div>
              <h2 id="activity-heading">Recent activity</h2>
              <p className="muted">
                Reservation changes and the corresponding calendar actions.
              </p>
            </div>
            <button
              className="text-button"
              disabled={busy !== null}
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>
          {initialLoading ? (
            <div className="empty-state" role="status">
              <span className="loading-ring" aria-hidden="true" />
              <strong>Loading integration status…</strong>
              <p>Checking connections and recent reservation activity.</p>
            </div>
          ) : !status ? (
            <div className="empty-state">
              <span className="empty-icon unavailable-icon" aria-hidden="true">
                !
              </span>
              <strong>Activity is unavailable</strong>
              <p>
                Check your integration settings, then retry the status check.
              </p>
              <div className="empty-actions">
                <a href="/setup">Open the setup guide</a>
                <button className="text-button" onClick={() => void refresh()}>
                  Retry
                </button>
              </div>
            </div>
          ) : status.logs.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon" aria-hidden="true">
                ↔
              </span>
              <strong>Your sync activity will appear here</strong>
              <p>
                Connect both services, then sync reservations or create a booking in your ChatBeds property.
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Reservation</th>
                    <th scope="col">Calendar action</th>
                    <th scope="col">Source / event</th>
                    <th scope="col">Result</th>
                    <th scope="col">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {status.logs.map((log) => (
                    <tr key={log.id}>
                      <td>
                        <strong>
                          {log.reservation_ref ?? log.reservation_id ?? "—"}
                        </strong>
                      </td>
                      <td>
                        <span className="action-label">{log.action}</span>
                        <span className="log-message">{log.message}</span>
                      </td>
                      <td>
                        <span className="source-label">{log.source}</span>
                        {log.event_type && (
                          <span className="event-name">{log.event_type}</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`status-pill ${log.success ? "success" : "failure"}`}
                        >
                          <span className="status-dot" />
                          {log.success ? "Success" : "Failed"}
                        </span>
                      </td>
                      <td>
                        <time dateTime={log.created_at}>
                          {timestamp(log.created_at)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="dashboard-footer">
          <span>
            ChatBeds → Google Calendar · One-way reservation sync
          </span>
          {publicMode ? <nav className="workspace-footer-links" aria-label="Workspace help"><a href="/setup">Hotel guide</a><a href="/support">Support</a><a href="/privacy">Privacy</a></nav> : <a href="/setup">Setup guide</a>}
        </footer>
      </main>
    </div>
  );
}
