"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useT } from "@/i18n/provider";

/* ==========================================================================
   WHOP VERIFICATION CARD.

   Shows the creator's KYC / identity-verification state and lets them start
   Whop's hosted onboarding flow.

   THE SERVER STAYS THE AUTHORITY. Status always comes from
   GET /api/whop/kyc/status, which fetches live from Whop. A `?step=kyc_return`
   query param triggers a fresh status read after the creator returns from
   Whop, but it is NEVER treated as proof of verification.

   THE LINK IS MINTED ON CLICK. POST /api/whop/kyc/start returns a URL and
   nothing is cached — Whop links expire quickly.
   ========================================================================== */

type KycUiState =
  | { status: "verified" }
  | { status: "pending" }
  | { status: "action_required"; actions: string[] }
  | { status: "restricted"; actions: string[] }
  | { status: "unknown" };

type Phase =
  | { phase: "loading" }
  | { phase: "not_provisioned" }
  | { phase: "ready"; kyc: KycUiState }
  | { phase: "error"; message: string };

export function WhopVerificationCard({ kycReturn }: { kycReturn?: boolean }) {
  const t = useT().dashboard.verification;
  const { user, loading: authLoading } = useAuth();

  const [phase, setPhase] = useState<Phase>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const errors: Record<string, string> = t.errors;

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;

    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/whop/kyc/status", {
          headers: { authorization: `Bearer ${idToken}` },
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          provisioned?: boolean;
          kyc?: KycUiState;
          error?: string;
        } | null;

        if (cancelled) return;

        if (!res.ok) {
          setPhase({ phase: "error", message: errors[body?.error ?? ""] ?? t.errors.status });
          return;
        }
        if (!body?.provisioned) {
          setPhase({ phase: "not_provisioned" });
          return;
        }
        setPhase({ phase: "ready", kyc: body.kyc ?? { status: "unknown" } });
      } catch {
        if (!cancelled) setPhase({ phase: "error", message: t.errors.network });
      }
    })();

    return () => { cancelled = true; };
  // Re-fetch after the creator returns from Whop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, reloadKey]);

  // When the creator lands back from Whop's flow, refresh once automatically.
  useEffect(() => {
    if (kycReturn) setReloadKey((n) => n + 1);
  }, [kycReturn]);

  async function startVerification() {
    if (!user || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/whop/kyc/start", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}` },
      });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;

      if (!res.ok || !body?.url) {
        setActionError(errors[body?.error ?? ""] ?? t.errors.start);
        setBusy(false);
        return;
      }
      // Navigate away; busy stays set so the button cannot be double-pressed
      // while the tab is loading.
      window.location.assign(body.url);
    } catch {
      setActionError(t.errors.network);
      setBusy(false);
    }
  }

  const pillClass = pillFor(phase);

  return (
    <section className="overflow-hidden rounded-[var(--radius-token-lg)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <header className="flex items-center gap-3.5 border-b border-line px-6 py-5 sm:px-7">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] border border-line bg-surface-sunken text-ink">
          <ShieldIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-[var(--font-display)] text-[16px] font-extrabold tracking-tight text-ink">
            {t.title}
          </h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{t.subtitle}</p>
        </div>
        <span className={pillClass.className}>{pillClass.label}</span>
      </header>

      <div className="px-6 py-6 sm:px-7">
        {phase.phase === "loading" && (
          <p className="text-[13.5px] text-ink-soft" role="status">{t.checking}</p>
        )}

        {phase.phase === "error" && (
          <p role="alert" className="text-[13.5px] font-medium text-red-700">{phase.message}</p>
        )}

        {phase.phase === "not_provisioned" && (
          <p className="text-[13.5px] text-ink-soft">{t.notProvisioned}</p>
        )}

        {phase.phase === "ready" && (
          <VerificationBody
            kyc={phase.kyc}
            t={t}
            busy={busy}
            onStart={startVerification}
            kycReturn={kycReturn}
          />
        )}

        {actionError && (
          <p role="alert" className="mt-4 text-[13px] font-medium text-red-700">{actionError}</p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------
   Pieces
   ------------------------------------------------------------------------- */

type Copy = ReturnType<typeof useT>["dashboard"]["verification"];

function VerificationBody({
  kyc,
  t,
  busy,
  onStart,
  kycReturn,
}: {
  kyc: KycUiState;
  t: Copy;
  busy: boolean;
  onStart: () => void;
  kycReturn?: boolean;
}) {
  const showButton =
    kyc.status === "action_required" ||
    kyc.status === "restricted" ||
    kyc.status === "unknown";

  const bodyText =
    kyc.status === "verified" ? t.verifiedBody :
    kyc.status === "pending" ? t.pendingBody :
    kyc.status === "action_required" ? t.actionRequiredBody :
    kyc.status === "restricted" ? t.restrictedBody :
    t.unknownBody;

  const actions =
    (kyc.status === "action_required" || kyc.status === "restricted") ? kyc.actions : [];

  const actionLabels: Record<string, string> = t.actionLabel;

  return (
    <>
      {kycReturn && kyc.status !== "verified" && (
        <p
          role="status"
          className="mb-4 rounded-[var(--radius-token-md)] bg-amber-50 px-4 py-3 text-[13.5px] font-medium text-amber-900"
        >
          {t.returnNotice}
        </p>
      )}

      <p className="max-w-[58ch] text-[14px] leading-relaxed text-ink-soft">{bodyText}</p>

      {actions.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {actions.map((action) => (
            <li
              key={action}
              className="flex items-start gap-2 text-[13.5px] font-medium text-ink"
            >
              <span className="mt-0.5 shrink-0 text-amber-500">
                <AlertIcon />
              </span>
              {actionLabels[action] ?? t.actionFallback}
              {!actionLabels[action] && (
                <span className="ltr-token font-mono text-[12px] text-ink-soft">({action})</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {showButton && (
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          aria-busy={busy}
          className="mt-5 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] bg-ink px-6 py-3 text-[14px] font-bold text-white shadow-[var(--shadow-card)] transition-all hover:-translate-y-px hover:bg-ink/90 disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-ink-soft/50"
        >
          {busy ? t.startVerificationBusy : t.startVerification}
        </button>
      )}
    </>
  );
}

function pillFor(phase: Phase): { className: string; label: string } {
  const base = "shrink-0 rounded-[var(--radius-token-pill)] px-3 py-1 text-[11.5px] font-bold uppercase tracking-[0.06em]";

  // We need to read from the dictionary lazily so this runs inside a render.
  // The hook is called at the top of WhopVerificationCard; this is just a helper.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const t = useT().dashboard.verification;

  if (phase.phase === "loading" || phase.phase === "error") {
    return { className: `${base} bg-surface-sunken text-ink-soft`, label: t.statusUnknown };
  }
  if (phase.phase === "not_provisioned") {
    return { className: `${base} bg-surface-sunken text-ink-soft`, label: t.statusUnknown };
  }
  const { kyc } = phase;
  if (kyc.status === "verified") {
    return { className: `${base} bg-emerald-100 text-emerald-800`, label: t.statusVerified };
  }
  if (kyc.status === "pending") {
    return { className: `${base} bg-amber-100 text-amber-800`, label: t.statusPending };
  }
  if (kyc.status === "action_required") {
    return { className: `${base} bg-amber-100 text-amber-800`, label: t.statusActionRequired };
  }
  if (kyc.status === "restricted") {
    return { className: `${base} bg-red-100 text-red-800`, label: t.statusRestricted };
  }
  return { className: `${base} bg-surface-sunken text-ink-soft`, label: t.statusUnknown };
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M12 3L4 6v6c0 5.25 3.5 10.15 8 11.25C16.5 22.15 20 17.25 20 12V6l-8-3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
