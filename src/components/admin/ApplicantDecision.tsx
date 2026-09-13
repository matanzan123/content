"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"]["applicants"];

/** The three states only an administrator can produce. Mirrors ADMIN_DECISIONS. */
type Decision = "approved" | "needs_followup" | "rejected";

/* ==========================================================================
   DECISION CONTROLS.

   THE CLIENT DECIDES NOTHING. This posts a target UID and a verdict to
   `/api/admin/review` and renders whatever comes back. The actor is read
   server-side from the admin session cookie, the verdict is re-validated
   there, the decision is attributed and audited there, and the database
   constraints have the final word. Nothing here touches a database, and there
   is no code path that could.

   A SUCCESSFUL DECISION REFRESHES THE SERVER DATA rather than mutating a local
   copy of the row. The queue is re-read, so the row shows the status the
   database actually holds — not the one this component hoped for.
   ========================================================================== */

export function ApplicantDecision({
  firebaseUid,
  currentStatus,
  t,
}: {
  firebaseUid: string;
  currentStatus: string;
  t: Copy;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Decision | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function decide(decision: Decision) {
    if (busy) return;
    setBusy(decision);
    setResult(null);
    try {
      const response = await fetch("/api/admin/review", {
        method: "POST",
        // Same-origin, so the browser attaches the Origin header the route
        // checks and the httpOnly admin cookie it authenticates with.
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firebase_uid: firebaseUid, decision }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;

      if (!response.ok) {
        const key = body?.error ?? "";
        const errors: Record<string, string> = t.errors;
        setResult({ ok: false, message: errors[key] ?? t.errors.generic });
        setBusy(null);
        return;
      }

      setResult({ ok: true, message: t.decisionSaved });
      // Re-read the queue from the server; the row re-renders from the real
      // stored state and leaves the pending list if it no longer belongs.
      startTransition(() => router.refresh());
    } catch {
      setResult({ ok: false, message: t.errors.network });
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || pending;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <DecisionButton
          label={t.approve}
          tone="positive"
          current={currentStatus === "approved"}
          busy={busy === "approved"}
          disabled={disabled}
          onClick={() => decide("approved")}
        />
        <DecisionButton
          label={t.needsFollowup}
          tone="warning"
          current={currentStatus === "needs_followup"}
          busy={busy === "needs_followup"}
          disabled={disabled}
          onClick={() => decide("needs_followup")}
        />
        <DecisionButton
          label={t.reject}
          tone="negative"
          current={currentStatus === "rejected"}
          busy={busy === "rejected"}
          disabled={disabled}
          onClick={() => decide("rejected")}
        />
      </div>

      {result && (
        <p
          role="status"
          className={[
            "text-[11.5px] font-semibold",
            result.ok ? "text-[color:var(--a-positive)]" : "text-[color:var(--a-negative)]",
          ].join(" ")}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}

/**
 * `current` marks the verdict the account already holds. It stays clickable —
 * re-affirming a decision is harmless and re-stamps the attribution — but it
 * reads as the standing state rather than as an available action.
 */
function DecisionButton({
  label,
  tone,
  current,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  tone: "positive" | "warning" | "negative";
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const tones = {
    positive: "hover:border-[color:var(--a-positive)] hover:text-[color:var(--a-positive)]",
    warning: "hover:border-[color:var(--a-warning)] hover:text-[color:var(--a-warning)]",
    negative: "hover:border-[color:var(--a-negative)] hover:text-[color:var(--a-negative)]",
  } as const;
  const currentTones = {
    positive: "border-[color:var(--a-positive)] text-[color:var(--a-positive)]",
    warning: "border-[color:var(--a-warning)] text-[color:var(--a-warning)]",
    negative: "border-[color:var(--a-negative)] text-[color:var(--a-negative)]",
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
      aria-current={current ? "true" : undefined}
      className={[
        "rounded-md border px-2.5 py-1 text-[11.5px] font-bold transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        current
          ? `bg-[color:var(--a-panel-raised)] ${currentTones[tone]}`
          : `border-[color:var(--a-border-strong)] text-[color:var(--a-text-muted)] ${tones[tone]}`,
      ].join(" ")}
    >
      {busy ? "…" : label}
    </button>
  );
}
