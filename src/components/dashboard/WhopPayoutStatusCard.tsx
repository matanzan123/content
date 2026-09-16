"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useT } from "@/i18n/provider";

/* ==========================================================================
   WHOP PAYOUT STATUS CARD.

   Shows whether the creator's connected Whop account is capable of receiving
   payouts — independent of KYC/identity status.

   KYC (WhopVerificationCard) and payout readiness (this card) are DIFFERENT
   questions. A creator can be KYC-verified but not payout-ready if they have
   not yet added a bank account or completed the provider's payout setup.

   THE SERVER STAYS THE AUTHORITY. Status always comes from
   GET /api/whop/payout/status, which reads account capabilities live.

   GET /payout_methods?account_id=... is NOT used here — it returned 403 in
   sandbox (scope unavailable with the platform key). This is tracked in the
   server response and shown in the "not_attempted" note if present.
   ========================================================================== */

type PayoutReadiness = "ready" | "pending" | "restricted" | "not_ready" | "unknown";

type Phase =
  | { phase: "loading" }
  | { phase: "not_provisioned" }
  | { phase: "ready"; readiness: PayoutReadiness; canReceive: boolean; pendingReqs: string[]; pastDueReqs: string[] }
  | { phase: "error"; message: string };

export function WhopPayoutStatusCard({ payoutReturn }: { payoutReturn?: boolean }) {
  const t = useT().dashboard.payout;
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
        const res = await fetch("/api/whop/payout/status", {
          headers: { authorization: `Bearer ${idToken}` },
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          provisioned?: boolean;
          readiness?: PayoutReadiness;
          can_receive_payout?: boolean;
          pending_requirements?: string[];
          past_due_requirements?: string[];
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

        setPhase({
          phase: "ready",
          readiness: body.readiness ?? "unknown",
          canReceive: body.can_receive_payout ?? false,
          pendingReqs: body.pending_requirements ?? [],
          pastDueReqs: body.past_due_requirements ?? [],
        });
      } catch {
        if (!cancelled) setPhase({ phase: "error", message: t.errors.network });
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, reloadKey]);

  useEffect(() => {
    if (payoutReturn) setReloadKey((n) => n + 1);
  }, [payoutReturn]);

  async function openPortal() {
    if (!user || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/whop/payout/portal", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}` },
      });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) {
        setActionError(errors[body?.error ?? ""] ?? t.errors.portal);
        setBusy(false);
        return;
      }
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
          <BankIcon />
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
          <PayoutBody
            readiness={phase.readiness}
            pendingReqs={phase.pendingReqs}
            pastDueReqs={phase.pastDueReqs}
            payoutReturn={payoutReturn}
            busy={busy}
            onOpen={openPortal}
            t={t}
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
   Body
   ------------------------------------------------------------------------- */

type Copy = ReturnType<typeof useT>["dashboard"]["payout"];

function PayoutBody({
  readiness,
  pendingReqs,
  pastDueReqs,
  payoutReturn,
  busy,
  onOpen,
  t,
}: {
  readiness: PayoutReadiness;
  pendingReqs: string[];
  pastDueReqs: string[];
  payoutReturn?: boolean;
  busy: boolean;
  onOpen: () => void;
  t: Copy;
}) {
  const bodyText =
    readiness === "ready" ? t.readyBody :
    readiness === "pending" ? t.pendingBody :
    readiness === "restricted" ? t.restrictedBody :
    readiness === "not_ready" ? t.notReadyBody :
    t.unknownBody;

  const blockingReqs = pastDueReqs.length > 0 ? pastDueReqs : pendingReqs;
  const showButton = readiness !== "ready";

  return (
    <>
      {payoutReturn && readiness !== "ready" && (
        <p
          role="status"
          className="mb-4 rounded-[var(--radius-token-md)] bg-amber-50 px-4 py-3 text-[13.5px] font-medium text-amber-900"
        >
          {t.returnNotice}
        </p>
      )}

      <p className="max-w-[58ch] text-[14px] leading-relaxed text-ink-soft">{bodyText}</p>

      {blockingReqs.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {blockingReqs.map((req) => (
            <li key={req} className="flex items-start gap-2 text-[13.5px] font-medium text-ink">
              <span className="mt-0.5 shrink-0 text-amber-500">
                <AlertIcon />
              </span>
              {req}
            </li>
          ))}
        </ul>
      )}

      {readiness === "not_ready" && (
        <p className="mt-4 text-[13px] text-ink-soft">{t.notReadyHint}</p>
      )}

      {showButton && (
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          aria-busy={busy}
          className="mt-5 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] bg-ink px-6 py-3 text-[14px] font-bold text-white shadow-[var(--shadow-card)] transition-all hover:-translate-y-px hover:bg-ink/90 disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-ink-soft/50"
        >
          {busy ? t.manageButtonBusy : t.manageButton}
        </button>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------
   Pill
   ------------------------------------------------------------------------- */

function pillFor(phase: Phase): { className: string; label: string } {
  const base = "shrink-0 rounded-[var(--radius-token-pill)] px-3 py-1 text-[11.5px] font-bold uppercase tracking-[0.06em]";
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const t = useT().dashboard.payout;

  if (phase.phase === "loading" || phase.phase === "error" || phase.phase === "not_provisioned") {
    return { className: `${base} bg-surface-sunken text-ink-soft`, label: t.statusUnknown };
  }
  if (phase.readiness === "ready") {
    return { className: `${base} bg-emerald-100 text-emerald-800`, label: t.statusReady };
  }
  if (phase.readiness === "pending") {
    return { className: `${base} bg-amber-100 text-amber-800`, label: t.statusPending };
  }
  if (phase.readiness === "restricted") {
    return { className: `${base} bg-red-100 text-red-800`, label: t.statusRestricted };
  }
  if (phase.readiness === "not_ready") {
    return { className: `${base} bg-surface-sunken text-ink-soft`, label: t.statusNotReady };
  }
  return { className: `${base} bg-surface-sunken text-ink-soft`, label: t.statusUnknown };
}

/* -------------------------------------------------------------------------
   Icons
   ------------------------------------------------------------------------- */

function BankIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M3 10h18M3 10V8l9-5 9 5v2M3 10v10h18V10M8 14v3M12 14v3M16 14v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
