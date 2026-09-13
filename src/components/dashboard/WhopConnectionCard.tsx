"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useT } from "@/i18n/provider";

/* ==========================================================================
   WHOP CONNECTION.

   THE TOKEN IS FETCHED PER REQUEST AND NEVER KEPT. `getIdToken()` is called
   at the moment of each call and the value goes into an Authorization header
   and nowhere else — not a URL, not localStorage, not a log, not a
   server-rendered prop, not React state. It expires on its own and is minted
   again next time.

   THE SERVER STAYS THE AUTHORITY. This component renders status it was told,
   never status it assumed: `?whop=connected` in the URL produces a message,
   but the connected state itself always comes from `GET /api/whop/connection`.
   A query string is something anyone can type.

   NO OAUTH LOGIC LIVES HERE. No PKCE, no state, no nonce, no redirect URI —
   `POST /api/whop/connect` mints all of that server-side and hands back one
   URL to navigate to.
   ========================================================================== */

type Status =
  | { phase: "loading" }
  | { phase: "disconnected" }
  | { phase: "connected"; username: string | null; scopes: string | null; connectedAt: string | null }
  | { phase: "error"; message: string };

type ConnectionBody = {
  connected?: boolean;
  username?: string | null;
  scopes?: string | null;
  connected_at?: string | null;
  error?: string;
};

export function WhopConnectionCard({ locale, notice }: { locale: string; notice: string | null }) {
  const dict = useT();
  const t = dict.dashboard.whop;
  const { user, loading: authLoading } = useAuth();

  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [busy, setBusy] = useState<null | "connect" | "disconnect">(null);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Bumped to ask the effect for a fresh read of the authoritative status. */
  const [reloadKey, setReloadKey] = useState(0);

  const errors: Record<string, string> = t.errors;

  /**
   * Reads the authoritative status.
   *
   * The whole read lives inside the effect, and every `setStatus` happens
   * after an await and behind a `cancelled` check — so a card unmounted
   * mid-request (or a second read started by a disconnect) cannot write a
   * stale answer over a fresh one. `reloadKey` is how an action asks for
   * another read rather than mutating a local copy of the truth.
   */
  useEffect(() => {
    // "Signed out" is derived at render time instead of discovered here: it is
    // a fact about the current props, not something to go and fetch.
    if (authLoading || !user) return;
    let cancelled = false;

    (async () => {
      try {
        const idToken = await user.getIdToken();
        const response = await fetch("/api/whop/connection", {
          headers: { authorization: `Bearer ${idToken}` },
          cache: "no-store",
        });
        const body = (await response.json().catch(() => null)) as ConnectionBody | null;
        if (cancelled) return;

        if (!response.ok) {
          setStatus({ phase: "error", message: errors[body?.error ?? ""] ?? t.errors.status });
          return;
        }
        setStatus(
          body?.connected
            ? {
                phase: "connected",
                username: body.username ?? null,
                scopes: body.scopes ?? null,
                connectedAt: body.connected_at ?? null,
              }
            : { phase: "disconnected" },
        );
      } catch {
        if (!cancelled) setStatus({ phase: "error", message: t.errors.network });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, user, reloadKey, errors, t.errors.status, t.errors.network]);

  const shown: Status = authLoading
    ? { phase: "loading" }
    : user
      ? status
      : { phase: "error", message: t.errors.signedOut };

  async function connect() {
    if (!user || busy) return;
    setBusy("connect");
    setActionError(null);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/whop/connect", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
        // Which page to come back to, and in which language. Both are matched
        // against closed sets on the server; neither is a URL.
        body: JSON.stringify({ return_to: "dashboard", locale }),
      });
      const body = (await response.json().catch(() => null)) as
        | { authorize_url?: string; error?: string }
        | null;

      if (!response.ok || !body?.authorize_url) {
        setActionError(errors[body?.error ?? ""] ?? t.errors.connect);
        setBusy(null);
        return;
      }
      // Leaving the app entirely; `busy` stays set so the button cannot be
      // pressed twice while the navigation is in flight.
      window.location.assign(body.authorize_url);
    } catch {
      setActionError(t.errors.network);
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!user || busy) return;
    setBusy("disconnect");
    setActionError(null);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/whop/disconnect", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}` },
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setActionError(errors[body?.error ?? ""] ?? t.errors.disconnect);
        setBusy(null);
        return;
      }
      setConfirming(false);
      setBusy(null);
      // Re-read rather than assume: the server decides what the state is now.
      setStatus({ phase: "loading" });
      setReloadKey((n) => n + 1);
    } catch {
      setActionError(t.errors.network);
      setBusy(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-token-lg)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <header className="flex items-center gap-3.5 border-b border-line px-6 py-5 sm:px-7">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] border border-line bg-surface-sunken text-ink">
          <WhopMark />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-[var(--font-display)] text-[16px] font-extrabold tracking-tight text-ink">
            {t.title}
          </h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{t.subtitle}</p>
        </div>
        <StatusPill status={shown} t={t} />
      </header>

      <div className="px-6 py-6 sm:px-7">
        {notice && <Notice notice={notice} t={t} />}

        {shown.phase === "loading" && (
          <p className="text-[13.5px] text-ink-soft" role="status">
            {t.checking}
          </p>
        )}

        {shown.phase === "error" && (
          <p role="alert" className="text-[13.5px] font-medium text-red-700">
            {shown.message}
          </p>
        )}

        {shown.phase === "disconnected" && (
          <>
            <p className="max-w-[58ch] text-[14px] leading-relaxed text-ink-soft">
              {t.disconnectedBody}
            </p>
            <button
              type="button"
              onClick={connect}
              disabled={busy !== null}
              aria-busy={busy === "connect"}
              className="mt-5 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] bg-ink px-6 py-3 text-[14px] font-bold text-white shadow-[var(--shadow-card)] transition-all hover:-translate-y-px hover:bg-ink/90 disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-ink-soft/50"
            >
              {busy === "connect" ? t.connecting : t.connect}
            </button>
          </>
        )}

        {shown.phase === "connected" && (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Fact label={t.accountLabel}>
                {shown.username ? (
                  <span className="ltr-token">@{shown.username}</span>
                ) : (
                  t.accountUnknown
                )}
              </Fact>
              {shown.connectedAt && (
                <Fact label={t.connectedAtLabel}>{formatDate(shown.connectedAt, locale)}</Fact>
              )}
              {shown.scopes && (
                <Fact label={t.scopesLabel}>
                  <span className="ltr-token font-mono text-[12.5px]">{shown.scopes}</span>
                </Fact>
              )}
            </dl>

            {confirming ? (
              <div className="mt-6 rounded-[var(--radius-token-md)] border border-line bg-surface-sunken px-5 py-4">
                <p className="text-[13.5px] font-semibold text-ink">{t.confirmTitle}</p>
                <p className="mt-1 max-w-[54ch] text-[13px] leading-relaxed text-ink-soft">
                  {t.confirmBody}
                </p>
                <div className="mt-4 flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    onClick={disconnect}
                    disabled={busy !== null}
                    aria-busy={busy === "disconnect"}
                    className="rounded-[var(--radius-token-pill)] bg-red-600 px-5 py-2.5 text-[13.5px] font-bold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy === "disconnect" ? t.disconnecting : t.confirmDisconnect}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={busy !== null}
                    className="rounded-[var(--radius-token-pill)] border border-line bg-surface px-5 py-2.5 text-[13.5px] font-semibold text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {dict.common.close}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="mt-6 rounded-[var(--radius-token-pill)] border border-line bg-surface px-5 py-2.5 text-[13.5px] font-semibold text-ink transition-colors hover:bg-surface-sunken"
              >
                {t.disconnect}
              </button>
            )}
          </>
        )}

        {actionError && (
          <p role="alert" className="mt-4 text-[13px] font-medium text-red-700">
            {actionError}
          </p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------
   Pieces
   ------------------------------------------------------------------------- */

/**
 * The banner the callback's `?whop=` value produces.
 *
 * It reports what the ROUND TRIP did, which is not the same as the connection
 * state — that is fetched separately and always wins. A closed set of words,
 * mapped to copy; anything unrecognised reads as a generic failure, so no
 * provider text can ever reach the page through this.
 */
function Notice({ notice, t }: { notice: string; t: Copy }) {
  const ok = notice === "connected";
  const messages: Record<string, string> = t.notices;
  return (
    <p
      role="status"
      className={[
        "mb-5 rounded-[var(--radius-token-md)] px-4 py-3 text-[13.5px] font-medium",
        ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900",
      ].join(" ")}
    >
      {messages[notice] ?? t.notices.error}
    </p>
  );
}

type Copy = ReturnType<typeof useT>["dashboard"]["whop"];

function StatusPill({ status, t }: { status: Status; t: Copy }) {
  const connected = status.phase === "connected";
  const unknown = status.phase === "loading" || status.phase === "error";
  return (
    <span
      className={[
        "shrink-0 rounded-[var(--radius-token-pill)] px-3 py-1 text-[11.5px] font-bold uppercase tracking-[0.06em]",
        unknown
          ? "bg-surface-sunken text-ink-soft"
          : connected
            ? "bg-emerald-100 text-emerald-800"
            : "bg-surface-sunken text-ink-soft",
      ].join(" ")}
    >
      {unknown ? t.statusUnknown : connected ? t.statusConnected : t.statusDisconnected}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-soft">
        {label}
      </dt>
      <dd className="mt-1 text-[14.5px] font-bold text-ink">{children}</dd>
    </div>
  );
}

function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "medium",
  }).format(date);
}

function WhopMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M4 7.5h4.2L10 15l1.9-7.5h4.2L18 15l1.8-7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
