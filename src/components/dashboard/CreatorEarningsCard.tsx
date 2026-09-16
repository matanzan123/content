"use client";

import { useEffect, useState } from "react";
import { useT } from "@/i18n/provider";

/* ==========================================================================
   CREATOR EARNINGS CARD.

   Displays the creator's balance breakdown from the internal ledger.

   SOURCE OF TRUTH: GET /api/creator/earnings
   Amounts are in minor units (cents). All display is in dollars.

   STATES:
     loading       — fetching from API
     zero          — earned_minor === "0" across all non-reversed buckets
     loaded        — balance with one or more amounts to show
     error         — fetch failed
   ========================================================================== */

type Balance = {
  currency: string;
  earnedMinor: bigint;
  pendingMinor: bigint;
  availableMinor: bigint;
  transferredMinor: bigint;
  reversedMinor: bigint;
};

type Phase =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "loaded"; balance: Balance };

function minorToDollars(minor: bigint): string {
  const cents = Number(minor);
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function CreatorEarningsCard() {
  const t = useT();
  const d = t.dashboard.earnings;
  const [state, setState] = useState<Phase>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/creator/earnings", { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setState({ phase: "error" }); return; }
        const json = await res.json() as {
          currency: string;
          earned_minor: string;
          pending_minor: string;
          available_minor: string;
          transferred_minor: string;
          reversed_minor: string;
        };
        setState({
          phase: "loaded",
          balance: {
            currency: json.currency,
            earnedMinor: BigInt(json.earned_minor),
            pendingMinor: BigInt(json.pending_minor),
            availableMinor: BigInt(json.available_minor),
            transferredMinor: BigInt(json.transferred_minor),
            reversedMinor: BigInt(json.reversed_minor),
          },
        });
      })
      .catch(() => { if (!cancelled) setState({ phase: "error" }); });
    return () => { cancelled = true; };
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="rounded-2xl border border-gray-200 dark:border-gray-700 p-6">
        <p className="text-sm text-gray-500">{d.loading}</p>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="rounded-2xl border border-red-200 dark:border-red-800 p-6">
        <p className="text-sm text-red-600 dark:text-red-400">{d.errorLoad}</p>
      </div>
    );
  }

  const { balance } = state;
  const hasAny = balance.earnedMinor > BigInt(0) || balance.reversedMinor > BigInt(0);

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
      <div>
        <h3 className="font-semibold text-gray-900 dark:text-white">{d.title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">{d.subtitle}</p>
      </div>

      {!hasAny ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{d.zeroState}</p>
      ) : (
        <dl className="space-y-2 text-sm">
          <Row label={d.earned} value={minorToDollars(balance.earnedMinor)} highlight />
          <Row label={d.pending} value={minorToDollars(balance.pendingMinor)} muted />
          <Row label={d.available} value={minorToDollars(balance.availableMinor)} green={balance.availableMinor > BigInt(0)} />
          <Row label={d.transferred} value={minorToDollars(balance.transferredMinor)} />
          {balance.reversedMinor > BigInt(0) && (
            <Row label={d.reversed} value={minorToDollars(balance.reversedMinor)} muted />
          )}
        </dl>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
  muted,
  green,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  muted?: boolean;
  green?: boolean;
}) {
  const valueClass = green
    ? "font-semibold text-green-600 dark:text-green-400"
    : highlight
    ? "font-semibold text-gray-900 dark:text-white"
    : muted
    ? "text-gray-400 dark:text-gray-500"
    : "text-gray-700 dark:text-gray-300";

  return (
    <div className="flex justify-between">
      <dt className={muted ? "text-gray-400 dark:text-gray-500" : "text-gray-600 dark:text-gray-400"}>{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
