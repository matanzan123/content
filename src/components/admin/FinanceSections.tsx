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
  reconcileAllocationInternal,
  type TrialBalanceLine,
  type Discrepancy,
  type RefundDiscrepancy,
  type DisputeDiscrepancy,
  type FeeDriftFinding,
  type AllocationDiscrepancy,
} from "@/lib/server/accounting/reconcile";
import {
  reconcileCreatorEarnings,
  type ReconciliationFinding,
} from "@/lib/server/creator-earnings-reconcile";
import { getWhopEnvironment } from "@/lib/server/whop-payments";
import { ACCOUNTS } from "@/lib/server/accounting/accounts";
import {
  formatLedgerAmount,
  formatPerCurrencyTotals,
  sumAvailableCounts,
} from "@/lib/admin/finance-format";
import { RepairActions } from "./RepairActions";
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
    /* THE DENOMINATION. One account can hold a balance in several currencies,
     * and the trial balance now reports one line per (account, currency) — so
     * without this column two rows for the same account would be
     * indistinguishable. */
    key: "currency",
    header: t.finance.currencyCol,
    render: (row) => (
      <span className="font-mono text-[11.5px] text-[color:var(--a-text-muted)]">
        {row.currency.toUpperCase()}
      </span>
    ),
  },
  {
    /* THE AMOUNT, IN MAJOR UNITS. It was rendered as raw minor units, so a
     * balance of $2.04 read as "204" — every figure on the ledger's own health
     * screen overstated by the currency's scale. `formatLedgerAmount` takes the
     * scale from the currency, so a zero-decimal currency is not divided at all,
     * and an unresolvable currency is shown as unavailable rather than guessed. */
    key: "totalMinor",
    header: t.finance.totalMinorCol,
    numeric: true,
    render: (row) => {
      const f = formatLedgerAmount(row.totalMinor, row.currency);
      return (
        <span
          className={
            row.totalMinor > BigInt(0)
              ? "text-[color:var(--a-text)]"
              : row.totalMinor < BigInt(0)
                ? "text-[color:var(--a-negative)]"
                : "text-[color:var(--a-text-dim)]"
          }
          title={`${row.totalMinor.toString()} minor units`}
        >
          {f.unresolved ? `${f.minor} ${t.finance.unknownCurrency}` : f.display}
        </span>
      );
    },
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
    render: (row) => <span>{formatLedgerAmount(row.grossMinor, row.currency).display ?? "—"}</span>,
  },
  {
    /* THE FEE DRIFT ITSELF — the reason the row exists. The table used to show
     * the payment, the transaction, the currency and the gross, and NOT what had
     * drifted or by how much: a finding an operator could see but not act on. */
    key: "feeDelta",
    header: t.finance.feeDeltaCol,
    numeric: true,
    render: (row) => (
      <span
        className={row.deltaMinor === BigInt(0) ? "text-[color:var(--a-text-dim)]" : undefined}
        title={`${t.finance.postedCol} ${row.postedFeeMinor.toString()} · ${t.finance.actualCol} ${row.actualFeeMinor.toString()}`}
      >
        {formatLedgerAmount(row.deltaMinor, row.currency).display ?? "—"}
      </span>
    ),
  },
  {
    /* TAX PRINCIPAL, SEPARATELY. Task #20 made this scan report a settlement
     * whose FEES agree but whose sales tax has just been remitted — a finding
     * with a zero fee delta. Without its own column such a row would look
     * identical to a no-op, which is how the previous blindness felt. */
    key: "taxDelta",
    header: t.finance.taxDeltaCol,
    numeric: true,
    render: (row) => (
      <span
        className={
          row.taxRemittanceDeltaMinor === BigInt(0) ? "text-[color:var(--a-text-dim)]" : undefined
        }
        title={`${t.finance.postedCol} ${row.taxRemittancePostedMinor.toString()} · ${t.finance.actualCol} ${row.taxRemittanceActualMinor.toString()}`}
      >
        {formatLedgerAmount(row.taxRemittanceDeltaMinor, row.currency).display ?? "—"}
      </span>
    ),
  },
];

/* ==========================================================================
   TASK #20 FINDINGS — allocation and creator earnings.

   Both reconcilers existed and neither reached this page. Their findings are
   rendered with the code as a plain string beside its own detail, exactly as the
   older tables do, so a code this build has never heard of still appears instead
   of vanishing through a lookup that has no entry for it.
   ========================================================================== */

const ALLOCATION_COLS: (t: Copy) => Column<AllocationDiscrepancy>[] = (t) => [
  {
    key: "code",
    header: t.finance.codeCol,
    render: (row) => <span className="font-mono text-[11px]">{row.code}</span>,
  },
  {
    key: "paymentId",
    header: t.finance.paymentIdCol,
    render: (row) => <span className="font-mono text-[11px]">{row.paymentId}</span>,
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
      <span className="max-w-[46ch] break-words text-[color:var(--a-text-muted)]">{row.detail}</span>
    ),
  },
];

const EARNINGS_COLS: (t: Copy) => Column<ReconciliationFinding>[] = (t) => [
  {
    key: "check",
    header: t.finance.codeCol,
    render: (row) => <span className="font-mono text-[11px]">{row.check}</span>,
  },
  {
    key: "subject",
    header: t.finance.subjectCol,
    render: (row) => (
      <span className="font-mono text-[11px] text-[color:var(--a-text-muted)]">
        {"firebaseUid" in row && row.firebaseUid
          ? row.firebaseUid
          : "counterpartyId" in row && row.counterpartyId
            ? row.counterpartyId
            : "transferId" in row && row.transferId
              ? row.transferId
              : "—"}
      </span>
    ),
  },
  {
    /* EVERY REMAINING FIELD, WHATEVER THE VARIANT CARRIES. These findings are a
     * discriminated union whose members hold different figures, and a future
     * member will hold different ones again. Rendering the leftover fields
     * generically means a new variant arrives readable rather than blank. */
    key: "detail",
    header: t.finance.detailCol,
    render: (row) => {
      const rest = Object.entries(row as Record<string, unknown>)
        .filter(([k]) => k !== "check" && k !== "firebaseUid" && k !== "counterpartyId" && k !== "transferId")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" · ");
      return (
        <span className="max-w-[46ch] break-words text-[color:var(--a-text-muted)]">
          {rest || "—"}
        </span>
      );
    },
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
    /* THE REPAIR ENDPOINTS ARE NOT LISTED HERE ANY MORE. They used to appear as
     * prose an operator could read but not run; they are now real buttons in the
     * repair panel above, and describing them twice — once as documentation and
     * once as an action — invites someone to reach for the wrong one. What
     * remains here is the read-only provider checks, which have no action. */
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
  /* THE ENVIRONMENT COMES FROM SERVER CONFIGURATION, and is displayed so an
   * operator always knows which books they are reading. Nothing on this page
   * accepts it from the URL or the browser. */
  const environment = getWhopEnvironment();

  const [balance, payments, refunds, disputes, feeDrift, allocation, earnings] =
    await Promise.all([
      ledgerTrialBalance().catch(() => null),
      reconcileInternal().catch(() => null),
      reconcileRefundsInternal().catch(() => null),
      reconcileDisputesInternal().catch(() => null),
      reconcileFeeDrift().catch(() => null),
      /* TASK #20's TWO RECONCILERS, which this page did not call at all — so the
       * allocation invariants (a double revenue split, a split moving more than
       * its settlement made allocatable, suspense stranded by a reversal) and
       * every creator-earnings finding were invisible here. */
      reconcileAllocationInternal().catch(() => null),
      environment ? reconcileCreatorEarnings(environment).catch(() => null) : Promise.resolve(null),
    ]);

  const earningsFindings = earnings?.ok ? earnings.report.findings : null;

  /* A COUNT THAT KNOWS WHAT IT DOES NOT KNOW.
   *
   * This summed the three reconcilers with `?? 0`, so a reconciler that threw
   * contributed zero and the KPI rendered a confident `0` — an outage displayed
   * as a clean bill of health on the one screen whose job is to say whether the
   * books are sound. `sumAvailableCounts` returns null if any part is unknown,
   * and the card renders null as "—". */
  const totalDiscrepancies = sumAvailableCounts([
    payments ? payments.discrepancies.length : null,
    refunds ? refunds.discrepancies.length : null,
    disputes ? disputes.discrepancies.length : null,
    allocation ? allocation.discrepancies.length : null,
    earningsFindings ? earningsFindings.length : null,
  ]);

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
            /* ONE FIGURE PER CURRENCY, never a sum of them. `formatPerCurrencyTotals`
             * has no code path that adds two denominations together. */
            label={t.finance.grandTotal}
            value={
              balance && balance.configured
                ? balance.grandTotals.length === 0
                  ? "—"
                  : formatPerCurrencyTotals(balance.grandTotals).join(" · ")
                : null
            }
            hint={t.finance.multiCurrencyNote}
            locale={locale as "en" | "he"}
            t={t}
          />
          <KpiCard
            /* NOT GATED ON THE TRIAL BALANCE. This used to render "—" whenever
             * the balance query failed, even though the reconcilers had answered,
             * and rendered "0" when the reconcilers failed but the balance had
             * not. Both were the wrong way round. */
            label={t.finance.discrepancies}
            value={totalDiscrepancies}
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
          <KpiCard
            /* WHICH BOOKS THESE FIGURES DESCRIBE. Every reconciler on this page
             * is environment-scoped, so a reader who does not know which
             * environment they are looking at cannot interpret a single number
             * here. It comes from server configuration — the URL and the browser
             * have no say — and renders as unavailable when it cannot be
             * resolved, which is also when every figure above is unavailable. */
            label={t.finance.environmentLabel}
            value={environment}
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
            /* ACCOUNT AND CURRENCY. One account can now hold a balance in
             * several currencies, so the account alone is no longer unique and
             * React would reuse a row's identity across two denominations. */
            rowKey={(row) => `${row.account}:${row.currency}`}
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

      {/* ---- Allocation and reversal findings (Task #20) ----
           DETECTION ONLY, and the hint says so. A duplicate revenue split cannot
           be un-posted in an append-only journal, and deciding which of two
           splits is the correct one is a judgement, not an operation — so this
           panel deliberately offers no repair button. */}
      <Panel
        title={t.finance.allocationFindings}
        hint={t.finance.allocationFindingsHint}
        action={
          allocation ? (
            <StatusBadge
              ok={allocation.discrepancies.length === 0}
              label={
                allocation.discrepancies.length === 0
                  ? t.finance.noDiscrepancies
                  : String(allocation.discrepancies.length)
              }
            />
          ) : undefined
        }
      >
        {!allocation || !allocation.configured ? (
          <p className="py-4 text-center text-[12.5px] text-[color:var(--a-text-dim)]">
            {t.unavailable}
          </p>
        ) : allocation.discrepancies.length === 0 ? (
          <EmptyState t={t} />
        ) : (
          <DataTable
            columns={ALLOCATION_COLS(t)}
            rows={allocation.discrepancies}
            caption={t.finance.allocationFindings}
            rowKey={(row, i) => `${row.paymentId}:${row.code}:${i}`}
            t={t}
            maxHeight="420px"
          />
        )}
      </Panel>

      {/* ---- Creator earnings and payables (Task #20) ---- */}
      <Panel
        title={t.finance.earningsFindings}
        hint={t.finance.earningsFindingsHint}
        action={
          earningsFindings ? (
            <StatusBadge
              ok={earningsFindings.length === 0}
              label={
                earningsFindings.length === 0
                  ? t.finance.noDiscrepancies
                  : String(earningsFindings.length)
              }
            />
          ) : undefined
        }
      >
        {!earningsFindings ? (
          <p className="py-4 text-center text-[12.5px] text-[color:var(--a-text-dim)]">
            {t.unavailable}
          </p>
        ) : earningsFindings.length === 0 ? (
          <EmptyState t={t} />
        ) : (
          <DataTable
            columns={EARNINGS_COLS(t)}
            rows={earningsFindings}
            caption={t.finance.earningsFindings}
            rowKey={(row, i) => `${row.check}:${i}`}
            t={t}
            maxHeight="420px"
          />
        )}
      </Panel>

      {/* ---- Repair actions ----
           The three repair endpoints were reachable only from a terminal; this
           panel is the missing half. Dry run is the default and a live run is
           confirmed — see RepairActions for why both ends assert that. */}
      <Panel title={t.finance.repairTitle} hint={t.finance.repairHint}>
        <RepairActions
          targets={[
            {
              id: "refunds",
              label: t.finance.repairRefundsLabel,
              body: t.finance.repairRefundsBody,
              endpoint: "/api/admin/reconciliation/repair/refunds",
            },
            {
              id: "disputes",
              label: t.finance.repairDisputesLabel,
              body: t.finance.repairDisputesBody,
              endpoint: "/api/admin/reconciliation/repair/disputes",
            },
            {
              /* THE FEE REPAIR RUNNER, which the dashboard did not mention at
               * all — built in Task #18 and absent from the one screen an
               * operator would look for it on. */
              id: "fees",
              label: t.finance.repairFeesLabel,
              body: t.finance.repairFeesBody,
              endpoint: "/api/admin/reconciliation/repair/fees",
            },
          ]}
          copy={{
            dryRun: t.finance.repairDryRun,
            live: t.finance.repairLive,
            running: t.finance.repairRunning,
            confirmLive: t.finance.repairConfirmLive,
            examined: t.finance.repairExamined,
            wouldChange: t.finance.repairWouldChange,
            changed: t.finance.repairChanged,
            failed: t.finance.repairFailed,
            dryRunBadge: t.finance.repairDryRunBadge,
            liveBadge: t.finance.repairLiveBadge,
            endpointLabel: t.finance.apiEndpoint,
          }}
        />
      </Panel>

      {/* ---- Provider checks (read-only panel with API links) ---- */}
      <Panel title={t.finance.providerChecks} hint={t.finance.providerChecksHint}>
        <ProviderChecksPanel t={t} />
      </Panel>

    </div>
  );
}
