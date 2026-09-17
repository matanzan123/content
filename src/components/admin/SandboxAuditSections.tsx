import "server-only";

import { Panel } from "./Panel";
import { DataTable, type Column } from "./DataTable";
import { querySandboxAudit, type TableAuditRow } from "@/lib/server/sandbox-audit";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

const TABLE_COLS: (t: Copy) => Column<TableAuditRow>[] = (t) => [
  {
    key: "table",
    header: t.sandbox.tableCol,
    render: (row) => <span className="font-mono text-[11.5px]">{row.table}</span>,
  },
  {
    key: "sandbox",
    header: t.sandbox.sandboxCol,
    numeric: true,
    render: (row) => (
      <span className={row.sandbox > 0 ? "text-[color:var(--a-warning)]" : "text-[color:var(--a-text-dim)]"}>
        {row.sandbox.toLocaleString()}
      </span>
    ),
  },
  {
    key: "production",
    header: t.sandbox.productionCol,
    numeric: true,
    render: (row) => (
      <span className={row.production > 0 ? "text-[color:var(--a-text)]" : "text-[color:var(--a-text-dim)]"}>
        {row.production.toLocaleString()}
      </span>
    ),
  },
];

export async function SandboxAuditBody({ t }: { t: Copy }) {
  const data = await querySandboxAudit();

  if (!data) {
    return (
      <Panel title={t.sandbox.pageTitle}>
        <p className="text-sm text-[color:var(--a-text-muted)]">{t.sandbox.dbUnavailable}</p>
      </Panel>
    );
  }

  const purgeKey = data.staleRateLimitThreshold;
  const purgeCmd = t.sandbox.staleRateLimitsPurge.replace("{key}", String(purgeKey));
  const staleLabel = t.sandbox.staleCount.replace("{count}", String(data.staleRateLimitRows));

  return (
    <div className="space-y-6">
      {/* Environment flags */}
      <Panel title={t.sandbox.envFlagsTitle}>
        <dl className="space-y-3 text-sm">
          <div className="flex items-start gap-3">
            <dt className="w-56 shrink-0 font-mono text-[11.5px] text-[color:var(--a-text-muted)]">
              WHOP_ENV
            </dt>
            <dd>
              <span
                className={
                  data.currentEnvironment === "sandbox"
                    ? "text-[color:var(--a-warning)]"
                    : data.currentEnvironment === "production"
                      ? "text-[color:var(--a-positive)]"
                      : "text-[color:var(--a-text-dim)]"
                }
              >
                {data.currentEnvironment ?? "—"}
              </span>
            </dd>
          </div>
          <div className="flex items-start gap-3">
            <dt className="w-56 shrink-0 font-mono text-[11.5px] text-[color:var(--a-text-muted)]">
              {t.sandbox.sandboxUiFlag}
            </dt>
            <dd>
              <span
                className={
                  data.sandboxCheckoutEnabled
                    ? "text-[color:var(--a-warning)]"
                    : "text-[color:var(--a-text-dim)]"
                }
              >
                {data.sandboxCheckoutEnabled ? "true" : "false"}
              </span>
              {data.sandboxCheckoutEnabled && (
                <span className="ml-2 text-[color:var(--a-text-muted)]">
                  — {t.sandbox.sandboxUiFlagNote}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </Panel>

      {/* Row counts per environment */}
      <Panel title={t.sandbox.rowCountsTitle}>
        <DataTable
          columns={TABLE_COLS(t)}
          rows={data.tables}
          caption={t.sandbox.rowCountsTitle}
          rowKey={(r) => r.table}
          t={t}
        />
      </Panel>

      {/* Constraint gaps — static documentation */}
      <Panel title={t.sandbox.constraintGapsTitle}>
        <p className="text-sm text-[color:var(--a-text-muted)]">{t.sandbox.constraintGapsBody}</p>
        <p className="mt-2 font-mono text-[11.5px] text-[color:var(--a-text)]">
          {t.sandbox.constraintGapsList}
        </p>
      </Panel>

      {/* Stale rate-limit counters */}
      <Panel title={t.sandbox.staleRateLimitsTitle}>
        <p className="text-sm text-[color:var(--a-text-muted)]">{t.sandbox.staleRateLimitsBody}</p>
        <p className="mt-2 text-sm">
          <span
            className={
              data.staleRateLimitRows > 0
                ? "text-[color:var(--a-warning)]"
                : "text-[color:var(--a-positive)]"
            }
          >
            {staleLabel}
          </span>
        </p>
        {data.staleRateLimitRows > 0 && (
          <pre className="mt-3 overflow-x-auto rounded bg-[color:var(--a-panel-raised)] px-3 py-2 font-mono text-[11.5px] text-[color:var(--a-text-muted)]">
            {purgeCmd}
          </pre>
        )}
      </Panel>
    </div>
  );
}
