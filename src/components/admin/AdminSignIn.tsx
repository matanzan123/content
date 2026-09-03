"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import type { Locale } from "@/i18n/config";

/* ==========================================================================
   ADMIN SIGN-IN — the client half of the session exchange.

   `POST /api/admin/session` is the only way to obtain an admin session
   cookie, and it wants a *freshly minted* ID token: the route rejects a
   sign-in older than five minutes, and Firebase bakes custom claims into a
   token when it is issued, so a token minted before the `admin` claim was
   granted does not carry it.

   Both of those are handled by forcing a refresh (`getIdToken(true)`) and, if
   the server still calls the sign-in stale, sending the visitor back through
   Google rather than leaving them on a button that cannot work.
   ========================================================================== */

type Labels = {
  signInTitle: string;
  signInBody: string;
  signInContinueAs: string;
  signInWorking: string;
  signInAnother: string;
  signInStale: string;
  signInForbidden: string;
  signInFailed: string;
};

export function AdminSignIn({ locale, t }: { locale: Locale; t: Labels }) {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exchange() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      // Force refresh so a claim granted after this session started is present.
      const idToken = await user.getIdToken(true);
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });

      if (res.ok) {
        // The cookie is set; re-run the server guard for this route.
        router.refresh();
        return;
      }

      const { error: reason } = (await res.json().catch(() => ({}))) as { error?: string };
      if (reason === "forbidden") setError(t.signInForbidden);
      else if (reason === "stale_login") setError(t.signInStale);
      else setError(t.signInFailed);
    } catch {
      setError(t.signInFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      id="main-content"
      className="flex min-h-[70vh] flex-1 items-center justify-center px-6 py-20"
      lang={locale}
    >
      <div className="w-full max-w-[440px] rounded-[var(--radius-token-lg)] border border-line bg-surface p-8 text-center shadow-[var(--shadow-card)]">
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-ink-soft"
          aria-hidden="true"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="10" width="16" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8 10V7.5a4 4 0 018 0V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>

        <h1 className="mt-5 font-[var(--font-display)] text-[22px] font-extrabold tracking-tight text-ink">
          {t.signInTitle}
        </h1>
        <p className="mt-2.5 text-[14px] leading-relaxed text-ink-soft">{t.signInBody}</p>

        <div className="mt-7">
          {loading ? (
            <span
              className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent"
              role="status"
              aria-label={t.signInWorking}
            />
          ) : user ? (
            <>
              <button
                type="button"
                onClick={exchange}
                disabled={busy}
                className="w-full rounded-[var(--radius-token-pill)] bg-ink px-5 py-3 text-[14px] font-bold text-white transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy
                  ? t.signInWorking
                  : t.signInContinueAs.replace("{email}", user.email ?? "")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  void signOut();
                }}
                className="mt-3 text-[13px] font-medium text-ink-soft underline underline-offset-2 transition-colors hover:text-ink"
              >
                {t.signInAnother}
              </button>
            </>
          ) : (
            <GoogleSignInButton />
          )}
        </div>

        {error && (
          <p role="alert" className="mt-4 text-[13px] font-medium text-red-600">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
