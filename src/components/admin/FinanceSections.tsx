import "server-only";

import { KpiCard } from "./KpiCard";
import { Panel, EmptyState } from "./Panel";
import { DataTable, type Column } from "./DataTable";
import {
  ledgerTrialBalance,
  reconcileInternal,
  reconcileRefundsInternal,
  reconcileDisputesInternal,
  reconcileFeeDrift,
  type TrialBalanceLine,
  type Discrepancy,
  type RefundDiscrepancy,
  type DisputeDiscrepancy,
  type FeeDriftFinding,
} from "@/lib/server/accounting/reconcile";
import { ACCOUNTS } from "@/lib/server/accounting/accounts";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/* ==========================================================================
   TRIAL BALANCE
   ========================================================================== */

const TRIAL_BALANCE_COLS: (t: Copy) => Column<TrialBalanceLine>[] = (t) => [
  {
    key: "account",
    header: t.finance.accountCol,
    render: (row) => (
      <span className="font-mono text-[11.5px]">{row.account}</span>
    ),
  },
  {
    key: "kind",
    header: t.finance.kindCol,
    render: (row) => {
      const def = ACCOUNTS[row.account as keyof typeof ACCOUNTS];
      return def ? (
        <span className="text-[color:var(--a-text-muted)]">{def.kind}</span>
      ) : (
        <span className="text-[color:var(--a-text-dim)]">—</span>
      );
    },
  },
  {
    key: "normalBalance",
    header: t.finance.normalBalanceCol,
    render: (row) => {
      const def = ACCOUNTS[row.account as keyof typeof ACCOUNTS];
      return def ? (
        <span className="text-[color:var(--a-text-muted)]">{def.normalBalance}</span>
      ) : (
        <span className="text-[color:var(--a-text-dim)]">—</span>
      );
    },
  },
  {
    key: "totalMinor",
    header: t.finance.totalMinorCol,
    numeric: true,
    render: (row) => (
      <span
        className={
          row.totalMinor > BigInt(0)
            ? "text-[color:var(--a-text)]"
            : row.totalMinor < BigInt(0)
              ? "text-[color:var(--a-negative)]"
              : "text-[color:var(--a-text-dim)]"
        }
      >
        {row.totalMinor.toLocaleString()}
      </span>
    ),
  },
  {
    key: "entryCount",
    header: t.finance.entryCount,
    numeric: true,
    render: (row) => <span>{row.entryCount.toLocaleString()}</span>,
  },
];

/* ==========================================================================
   DISCREPANCY TABLES
   ========================================================================== */

const PAYMENT_DISCREPANCY_COLS: (t: Copy) => Column<Discrepancy>[] = (t) => [
  {
    key: "code",
    header: t.finance.codeCol,
    render: (row) => <span className="font-mono text-[11px]">{row.code}</span>,
  },
  {
    key: "paymentId",
    header: t.finance.paymentIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.paymentId ?? "—"}
      </span>
    ),
  },
  {
    key: "orderId",
    header: t.finance.orderIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.orderId ?? "—"}
      </span>
    ),
  },
  {
    key: "transactionId",
    header: t.finance.transactionIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.transactionId ?? "—"}
      </span>
    ),
  },
  {
    key: "detail",
    header: t.finance.detailCol,
    render: (row) => (
      <span className="max-w-[40ch] break-words text-[color:var(--a-text-muted)]">
        {row.detail}
      </span>
    ),
  },
];

const REFUND_DISCREPANCY_COLS: (t: Copy) => Column<RefundDiscrepancy>[] = (t) => [
  {
    key: "code",
    header: t.finance.codeCol,
    render: (row) => <span className="font-mono text-[11px]">{row.code}</span>,
  },
  {
    key: "refundId",
    header: t.finance.refundIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.refundId ?? "—"}
      </span>
    ),
  },
  {
    key: "paymentId",
    header: t.finance.paymentIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.paymentId ?? "—"}
      </span>
    ),
  },
  {
    key: "transactionId",
    header: t.finance.transactionIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.transactionId ?? "—"}
      </span>
    ),
  },
  {
    key: "detail",
    header: t.finance.detailCol,
    render: (row) => (
      <span className="max-w-[40ch] break-words text-[color:var(--a-text-muted)]">{row.detail}</span>
    ),
  },
];

const DISPUTE_DISCREPANCY_COLS: (t: Copy) => Column<DisputeDiscrepancy>[] = (t) => [
  {
    key: "code",
    header: t.finance.codeCol,
    render: (row) => <span className="font-mono text-[11px]">{row.code}</span>,
  },
  {
    key: "disputeId",
    header: t.finance.disputeIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.disputeId ?? "—"}
      </span>
    ),
  },
  {
    key: "paymentId",
    header: t.finance.paymentIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.paymentId ?? "—"}
      </span>
    ),
  },
  {
    key: "transactionId",
    header: t.finance.transactionIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {row.transactionId ?? "—"}
      </span>
    ),
  },
  {
    key: "detail",
    header: t.finance.detailCol,
    render: (row) => (
      <span className="max-w-[40ch] break-words text-[color:var(--a-text-muted)]">{row.detail}</span>
    ),
  },
];

const FEE_DRIFT_COLS: (t: Copy) => Column<FeeDriftFinding>[] = (t) => [
  {
    key: "paymentId",
    header: t.finance.paymentIdCol,
    render: (row) => <span className="font-mono text-[11px]">{row.paymentId}</span>,
  },
  {
    key: "transactionId",
    header: t.finance.transactionIdCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">{row.transactionId}</span>
    ),
  },
  {
    key: "currency",
    header: t.finance.currencyCol,
    render: (row) => <span className="uppercase">{row.currency}</span>,
  },
  {
    key: "grossMinor",
    header: t.finance.grossMinorCol,
    numeric: true,
    render: (row) => <span>{row.grossMinor.toLocaleString()}</span>,
  },
];

/* ==========================================================================
   STATUS BADGE
   ========================================================================== */

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  const color = ok ? "var(--a-positive)" : "var(--a-negative)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold"
      style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/* ==========================================================================
   PROVIDER CHECKS PANEL (static links — no provider calls on page load)
   ========================================================================== */

function ProviderChecksPanel({ t }: { t: Copy }) {
  const checks: { label: string; body: string; endpoint: string; method: "GET" | "POST" }[] = [
    {
      label: t.finance.payoutsCheckLabel,
      body: t.finance.payoutsCheckBody,
      endpoint: "/api/admin/reconciliation/payouts",
      method: "GET",
    },
    {
      label: t.finance.balancesCheckLabel,
      body: t.finance.balancesCheckBody,
      endpoint: "/api/admin/reconciliation/balances",
      method: "GET",
    },
    {
      label: t.finance.repairRefundsLabel,
      body: t.finance.repairRefundsBody,
      endpoint: "/api/admin/reconciliation/repair/refunds",
      method: "POST",
    },
    {
      label: t.finance.repairDisputesLabel,
      body: t.finance.repairDisputesBody,
      endpoint: "/api/admin/reconciliation/repair/disputes",
      method: "POST",
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {checks.map((c) => (
        <div
          key={c.endpoint}
          className="rounded-lg border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] p-3"
        >
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold">{c.label}</p>
              <p className="mt-0.5 text-[11.5px] text-[color:var(--a-text-muted)]">{c.body}</p>
            </div>
            <div className="shrink-0 text-end">
              <span className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-[color:var(--a-text-dim)]">
                {t.finance.apiEndpoint}
              </span>
              <p className="mt-0.5 font-mono text-[11px] text-[color:var(--a-text-muted)]">
                <span className="me-1 rounded px-1 py-0.5 text-[10px] font-bold" style={{ background: "color-mix(in srgb, var(--a-accent) 16%, transparent)", color: "var(--a-accent)" }}>
                  {c.method}
                </span>
                {c.endpoint}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   MAIN BODY
   ========================================================================== */

export async function FinanceBody({ t, locale }: { t: Copy; locale: string }) {
  const [balance, payments, refunds, disputes, feeDrift] = await Promise.all([
    ledgerTrialBalance().catch(() => null),
    reconcileInternal().catch(() => null),
    reconcileRefundsInternal().catch(() => null),
    reconcileDisputesInternal().catch(() => null),
    reconcileFeeDrift().catch(() => null),
  ]);

  const totalDiscrepancies =
    (payments?.discrepancies.length ?? 0) +
    (refunds?.discrepancies.length ?? 0) +
    (disputes?.discrepancies.length ?? 0);

  return (
    <div className="flex flex-col gap-6">

      {/* ---- KPI row ---- */}
      <section aria-label={t.finance.ledgerHealth}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard
            label={t.finance.trialBalance}
            value={balance ? (balance.balanced ? t.finance.balanced : t.finance.unbalanced) : null}
            locale={locale as "en" | "he"}
            t={t}
            accent={balance?.balanced ?? false}
          />
          <KpiCard
            label={t.finance.grandTotal}
            value={balance ? balance.grandTotal.toString() : null}
            hint={t.finance.multiCurrencyNote}
            locale={locale as "en" | "he"}
            t={t}
          />
          <KpiCard
            label={t.finance.discrepancies}
            value={balance ? totalDiscrepancies : null}
            locale={locale as "en" | "he"}
            t={t}
          />
          <KpiCard
            label={t.finance.feeDriftCount}
            value={feeDrift ? feeDrift.driftCandidates.length : null}
            hint={t.finance.feeDriftHint}
            locale={locale as "en" | "he"}
            t={t}
          />
        </div>
      </section>

      {/* ---- Trial Balance table ---- */}
      <Panel
        title={t.finance.trialBalance}
        hint={t.finance.trialBalanceHint}
        action={
          balance ? (
            <StatusBadge
              ok={balance.balanced}
              label={balance.balanced ? t.finance.balanced : t.finance.unbalanced}
            />
          ) : undefined
        }
      >
        {!balance || !balance.configured ? (
          <p className="py-4 text-center text-[12.5px] text-[color:var(--a-text-dim)]">
            {t.dbNotConfigured}
          </p>
        ) : balance.lines.length === 0 ? (
          <EmptyState t={t} />
        ) : (
          <DataTable
            columns={TRIAL_BALANCE_COLS(t)}
            rows={balance.lines}
            caption={t.finance.trialBalance}
            rowKey={(row) => row.account}
            t={t}
            maxHeight="480px"
          />
        )}
      </Panel>

      {/* ---- Reconciliation stats ---- */}
      <Panel title={t.finance.reconciliation} hint={t.finance.reconciliationHint}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] p-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
              {t.finance.paymentsChecked}
            </p>
            <p className="admin-num mt-1.5 text-[20px] font-bold">
              {payments?.ordersChecked ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] p-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
              {t.finance.refundsChecked}
            </p>
            <p className="admin-num mt-1.5 text-[20px] font-bold">
              {refunds?.refundsChecked ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] p-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
              {t.finance.disputesChecked}
            </p>
            <p className="admin-num mt-1.5 text-[20px] font-bold">
              {disputes?.disputesChecked ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] p-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
              {t.finance.settlementsScanned}
            </p>
            <p className="admin-num mt-1.5 text-[20px] font-bold">
              {feeDrift?.settlementsScanned ?? "—"}
            </p>
          </div>
        </div>
      </Panel>

      {/* ---- Discrepancy panels ---- */}
      <Panel
        title={t.finance.paymentDiscrepancies}
        action={
          payments ? (
            <StatusBadge
              ok={payments.discrepancies.length === 0}
              label={
                payments.discrepancies.length === 0
                  ? t.finance.noDiscrepancies
                  : String(payments.discrepancies.length)
              }
            />
          ) : undefined
        }
      >
        {!payments ? (
          <p className="py-4 text-center text-[12.5px] text-[color:var(--a-text-dim)]">{t.unavailable}</p>
        ) : payments.discrepancies.length === 0 ? (
          <EmptyState t={t} />
        ) : (
          <DataTable
            columns={PAYMENT_DISCREPANCY_COLS(t)}
            rows={payments.discrepancies}
            caption={t.finance.paymentDiscrepancies}
            rowKey={(_, i) => String(i)}
            t={t}
          />
        )}
      </Panel>

      <Panel
        title={t.finance.refundDiscrepancies}
        action={
          refunds ? (
            <StatusBadge
              ok={refunds.discrepancies.length === 0}
              label={
                refunds.discrepancies.length === 0
                  ? t.finance.noDiscrepancies
                  : String(refunds.discrepancies.length)
              }
            />
          ) : undefined
        }
      >
        {!refunds ? (
          <p className="py-4 text-center text-[12.5px] text-[color:var(--a-text-dim)]">{t.unavailable}</p>
        ) : refunds.discrepancies.length === 0 ? (
          <EmptyState t={t} />
        ) : (
          <DataTable
            columns={REFUND_DISCREPANCY_COLS(t)}
            rows={refunds.discrepancies}
            caption={t.finance.refundDiscrepancies}
            rowKey={(_, i) => String(i)}
            t={t}
          />
        )}
      </Panel>

      <Panel
        title={t.finance.disputeDiscrepancies}
        action={
          disputes ? (
            <StatusBadge
              ok={disputes.discrepancies.length === 0}
              label={
                disputes.discrepancies.length === 0
                  ? t.finance.noDiscrepancies
                  : String(disputes.discrepancies.length)
              }
            />
          ) : undefined
        }
      >
        {!disputes ? (
          <p className="py-4 text-center text-[12.5px] text-[color:var(--a-text-dim)]">{t.unavailable}</p>
        ) : disputes.discrepancies.length === 0 ? (
          <EmptyState t={t} />
        ) : (
          <DataTable
            columns={DISPUTE_DISCREPANCY_COLS(t)}
            rows={disputes.discrepancies}
            caption={t.finance.disputeDiscrepancies}
            rowKey={(_, i) => String(i)}
            t={t}
          />
        )}
      </Panel>

      <Panel
        title={t.finance.feeDriftCandidates}
        hint={t.finance.feeDriftHint}
        action={
          feeDrift ? (
            <StatusBadge
              ok={feeDrift.driftCandidates.length === 0}
              label={
                feeDrift.driftCandidates.length === 0
                  ? t.finance.noDiscrepancies
                  : String(feeDrift.driftCandidates.length)
              }
            />
          ) : undefined
        }
      >
        {!feeDrift ? (
          <p className="py-4 text-center text-[12.5px] text-[color:var(--a-text-dim)]">{t.unavailable}</p>
        ) : feeDrift.driftCandidates.length === 0 ? (
          <EmptyState t={t} />
        ) : (
          <DataTable
            columns={FEE_DRIFT_COLS(t)}
            rows={feeDrift.driftCandidates}
            caption={t.finance.feeDriftCandidates}
            rowKey={(row) => row.paymentId}
            t={t}
          />
        )}
      </Panel>

      {/* ---- Provider checks (read-only panel with API links) ---- */}
      <Panel title={t.finance.providerChecks} hint={t.finance.providerChecksHint}>
        <ProviderChecksPanel t={t} />
      </Panel>

    </div>
  );
}
