"use client";

import { useEffect, useState, useRef } from "react";
import { useT } from "@/i18n/provider";

/* ==========================================================================
   CREATOR WITHDRAW CARD.

   Lets creators request a partial withdrawal of their available balance.

   FLOW:
     1. Loads balance from GET /api/creator/earnings
     2. Loads active withdrawal from GET /api/creator/withdraw
     3. If no active withdrawal: shows amount input + submit
     4. If active withdrawal: shows status + cancel button (when cancellable)

   AMOUNT: creator enters a dollar amount; we convert to minor units (cents)
   before sending. The server enforces the ≤ available balance constraint.
   ========================================================================== */

type ActiveWithdrawal = {
  withdrawal_id: string;
  amount_minor: string;
  status: string;
  failure_reason: string | null;
  cancel_reason: string | null;
  requested_at: string;
  paid_at: string | null;
  failed_at: string | null;
  canceled_at: string | null;
};

type Phase =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "no_balance" }
  | { phase: "idle"; availableMinor: bigint }
  | { phase: "active"; withdrawal: ActiveWithdrawal; availableMinor: bigint };

const CANCELLABLE = new Set(["requested", "eligible"]);

const STATUS_LABEL_KEYS: Record<string, keyof ReturnType<typeof useStatusLabels>> = {
  requested: "statusRequested",
  eligible: "statusEligible",
  processing: "statusProcessing",
  provider_pending: "statusProviderPending",
  paid: "statusPaid",
  failed: "statusFailed",
  canceled: "statusCanceled",
  reversed: "statusReversed",
};

function useStatusLabels() {
  const t = useT();
  return t.dashboard.withdraw;
}

function minorToDisplay(minor: bigint): string {
  return (Number(minor) / 100).toFixed(2);
}

function dollarsToMinor(dollars: string): bigint | null {
  const n = parseFloat(dollars);
  if (isNaN(n) || n <= 0) return null;
  return BigInt(Math.round(n * 100));
}

export function CreatorWithdrawCard() {
  const t = useT();
  const d = t.dashboard.withdraw;
  const [state, setState] = useState<Phase>({ phase: "loading" });
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [earningsRes, withdrawRes] = await Promise.all([
        fetch("/api/creator/earnings", { credentials: "include" }),
        fetch("/api/creator/withdraw", { credentials: "include" }),
      ]);

      if (!earningsRes.ok || !withdrawRes.ok) {
        setState({ phase: "error", message: d.errors.load });
        return;
      }

      const earnings = await earningsRes.json() as { available_minor: string };
      const withdrawData = await withdrawRes.json() as { active: ActiveWithdrawal | null };

      const availableMinor = BigInt(earnings.available_minor);

      if (withdrawData.active) {
        setState({ phase: "active", withdrawal: withdrawData.active, availableMinor });
      } else if (availableMinor === BigInt(0)) {
        setState({ phase: "no_balance" });
      } else {
        setState({ phase: "idle", availableMinor });
        setAmountInput(minorToDisplay(availableMinor));
      }
    } catch {
      setState({ phase: "error", message: d.errors.load });
    }
  };

  useEffect(() => { void load(); }, []);

  const handleSubmit = async () => {
    if (state.phase !== "idle") return;
    setFieldError(null);

    const amountMinor = dollarsToMinor(amountInput);
    if (!amountMinor) {
      setFieldError(d.errors.amount_zero);
      return;
    }
    if (amountMinor > state.availableMinor) {
      setFieldError(d.errors.amount_exceeds_balance);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/creator/withdraw", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_minor: Number(amountMinor) }),
      });
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!json.ok) {
        const key = json.error ?? "db_unavailable";
        setFieldError((d.errors as Record<string, string>)[key] ?? key);
        return;
      }
      await load();
    } catch {
      setFieldError(d.errors.db_unavailable);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (state.phase !== "active") return;
    setCanceling(true);
    try {
      const res = await fetch("/api/creator/withdraw", {
        method: "DELETE",
        credentials: "include",
      });
      const json = await res.json() as { ok?: boolean };
      if (json.ok) await load();
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
      <div>
        <h3 className="font-semibold text-gray-900 dark:text-white">{d.title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">{d.subtitle}</p>
      </div>

      {state.phase === "loading" && (
        <p className="text-sm text-gray-400">Loading…</p>
      )}

      {state.phase === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">{state.message}</p>
      )}

      {state.phase === "no_balance" && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{d.nothingAvailable}</p>
      )}

      {state.phase === "idle" && (
        <div className="space-y-3">
          <div className="text-xs text-gray-500">
            {d.available}: <span className="font-medium text-gray-800 dark:text-gray-200">${minorToDisplay(state.availableMinor)}</span>
          </div>
          <div>
            <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">
              {d.amountLabel}
            </label>
            <input
              ref={inputRef}
              type="number"
              step="0.01"
              min="0.01"
              max={minorToDisplay(state.availableMinor)}
              value={amountInput}
              onChange={(e) => { setAmountInput(e.target.value); setFieldError(null); }}
              placeholder={d.amountPlaceholder}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={submitting}
            />
            {fieldError && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldError}</p>
            )}
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 px-4 transition-colors"
          >
            {submitting ? d.submitBusy : d.submitButton}
          </button>
        </div>
      )}

      {state.phase === "active" && (
        <div className="space-y-3">
          <p className="text-xs text-amber-600 dark:text-amber-400">{d.activeNotice}</p>
          <dl className="text-sm space-y-1">
            <div className="flex justify-between">
              <dt className="text-gray-500">Amount</dt>
              <dd className="font-medium text-gray-900 dark:text-white">
                ${minorToDisplay(BigInt(state.withdrawal.amount_minor))}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Status</dt>
              <dd className="font-medium">
                <StatusBadge status={state.withdrawal.status} />
              </dd>
            </div>
            {state.withdrawal.failure_reason && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Reason</dt>
                <dd className="text-red-600">{state.withdrawal.failure_reason}</dd>
              </div>
            )}
          </dl>
          {CANCELLABLE.has(state.withdrawal.status) && (
            <button
              onClick={handleCancel}
              disabled={canceling}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 text-sm py-2 px-4 transition-colors"
            >
              {canceling ? d.cancelBusy : d.cancelButton}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    requested: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    eligible: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    processing: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    provider_pending: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400",
    paid: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    canceled: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    reversed: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  };
  const cls = colors[status] ?? colors.canceled;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}
