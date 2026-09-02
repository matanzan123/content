import { Panel, Resolved } from "../Panel";
import { Column, DataTable, SourceStatus } from "../DataTable";
import { EventFilters } from "../EventFilters";
import {
  getAuditLog,
  getEventNames,
  getEventStats,
  getEvents,
  getMigrationState,
  type AuditRow,
  type EventRow,
} from "@/lib/analytics/dashboard";
import { getLedgerAvailability } from "@/lib/analytics/ledger-source";
import { isDatabaseConfigured } from "@/lib/db";
import { isAdminSdkConfigured } from "@/lib/server/firebase-admin";
import { isFirebaseConfigured } from "@/lib/firebase";
import { PRESENCE_MODEL } from "@/lib/analytics/sessions";
import { countryFlag, countryName, formatDateTime } from "@/lib/admin/format";
import type { AdminBodyProps } from "../AdminPage";

/* ================================ EVENTS ================================= */

const PAGE_SIZE = 50;

export async function EventsBody({ t, locale, range, search }: AdminBodyProps) {
  const page = Math.max(1, Number(typeof search.page === "string" ? search.page : "1") || 1);
  const filters = {
    name: typeof search.event === "string" ? search.event : undefined,
    country: typeof search.country === "string" ? search.country.toUpperCase() : undefined,
    locale: typeof search.evLocale === "string" ? search.evLocale : undefined,
    path: typeof search.path === "string" ? search.path : undefined,
  };

  const [events, names] = await Promise.all([
    getEvents(range, filters, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    getEventNames(),
  ]);

  const columns: Column<EventRow>[] = [
    { key: "time", header: t.time, render: (r) => formatDateTime(r.occurred_at, locale) },
    {
      key: "name",
      header: t.eventName,
      render: (r) => <span className="ltr-token font-medium">{r.event_name}</span>,
    },
    { key: "path", header: t.page, render: (r) => <span className="ltr-token">{r.path}</span> },
    { key: "locale", header: t.localeDistribution, render: (r) => r.locale },
    {
      key: "country",
      header: t.countryDistribution,
      render: (r) => `${countryFlag(r.country_code)} ${countryName(r.country_code, locale, t.unknownCountry)}`,
    },
    { key: "device", header: t.device, render: (r) => r.device_category },
    { key: "browser", header: t.browser, render: (r) => r.browser_family ?? "—" },
    {
      key: "meta",
      header: t.metadata,
      // Only the allow-listed metadata that was stored. There is no raw request
      // body to show, and no hidden field behind this cell.
      render: (r) =>
        r.metadata && Object.keys(r.metadata).length ? (
          <span className="ltr-token text-[11.5px] text-[color:var(--a-text-muted)]">
            {Object.entries(r.metadata)
              .map(([k, v]) => `${k}=${v}`)
              .join("  ")}
          </span>
        ) : (
          "—"
        ),
    },
  ];

  const total = events.ok ? events.data.total : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-5">
      <Panel title={t.eventsTitle} hint={t.privacyNote}>
        <EventFilters t={t} eventNames={names.ok ? names.data : []} />
      </Panel>

      <Panel
        title={t.eventsTitle}
        action={
          events.ok ? (
            <span className="admin-num text-[11.5px] text-[color:var(--a-text-dim)]">
              {t.rows.replace("{count}", String(total))}
            </span>
          ) : null
        }
      >
        <Resolved outcome={events} t={t} isEmpty={(d) => d.rows.length === 0}>
          {(data) => (
            <>
              <DataTable
                t={t}
                caption={t.eventsTitle}
                columns={columns}
                rows={data.rows}
                rowKey={(r) => r.id}
              />
              <p className="mt-3 text-center text-[11.5px] text-[color:var(--a-text-dim)]">
                {t.pageOf.replace("{current}", String(page)).replace("{total}", String(pages))}
              </p>
            </>
          )}
        </Resolved>
      </Panel>
    </div>
  );
}

/* ============================== AUDIT LOG ================================ */

export async function AuditBody({ t, locale, search }: AdminBodyProps) {
  const page = Math.max(1, Number(typeof search.page === "string" ? search.page : "1") || 1);
  const audit = await getAuditLog(PAGE_SIZE, (page - 1) * PAGE_SIZE);

  const columns: Column<AuditRow>[] = [
    { key: "time", header: t.time, render: (r) => formatDateTime(r.created_at, locale) },
    {
      key: "admin",
      header: t.adminLabel,
      render: (r) => (
        <span className="ltr-token">{r.admin_email_at_time ?? r.admin_uid.slice(0, 12) + "…"}</span>
      ),
    },
    { key: "action", header: t.action, render: (r) => <span className="ltr-token">{r.action}</span> },
    { key: "targetType", header: t.targetType, render: (r) => r.target_type },
    {
      key: "targetId",
      header: t.targetId,
      render: (r) => (r.target_id ? <span className="ltr-token">{r.target_id}</span> : "—"),
    },
    {
      key: "country",
      header: t.countryDistribution,
      render: (r) => countryName(r.country_code, locale, t.unknownCountry),
    },
    {
      key: "meta",
      header: t.metadata,
      render: (r) =>
        r.metadata && Object.keys(r.metadata).length ? (
          <span className="ltr-token text-[11.5px]">
            {Object.entries(r.metadata).map(([k, v]) => `${k}=${v}`).join("  ")}
          </span>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <Panel title={t.auditTitle}>
      <Resolved outcome={audit} t={t}>
        {(data) =>
          data.rows.length === 0 ? (
            // No example rows are invented. An empty audit log is the correct
            // state for a system where no privileged action has been taken.
            <p className="py-10 text-center text-[12.5px] text-[color:var(--a-text-dim)]">
              {t.auditEmpty}
            </p>
          ) : (
            <DataTable t={t} caption={t.auditTitle} columns={columns} rows={data.rows} rowKey={(r) => r.id} />
          )
        }
      </Resolved>
    </Panel>
  );
}

/* =============================== SYSTEM ================================== */

function StatusRow({
  label,
  value,
  ok,
  detail,
}: {
  label: string;
  value: string;
  ok: boolean | null;
  detail?: string;
}) {
  const color = ok === null ? "var(--a-text-dim)" : ok ? "var(--a-positive)" : "var(--a-warning)";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[color:var(--a-border)] py-3 last:border-0">
      <p className="min-w-[180px] text-[12.5px] font-medium">{label}</p>
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold"
        style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        {value}
      </span>
      {detail && (
        <span className="admin-num text-[11.5px] text-[color:var(--a-text-dim)]">{detail}</span>
      )}
    </div>
  );
}

export async function SystemBody({ t, locale }: AdminBodyProps) {
  const [stats, migrations] = await Promise.all([getEventStats(), getMigrationState()]);
  const dbOk = isDatabaseConfigured();
  const financial = getLedgerAvailability();

  return (
    <div className="flex flex-col gap-5">
      {!dbOk && <SourceStatus label={t.svcDatabase} status={t.statusNotConfigured} body={t.dbNotConfiguredBody} />}

      <Panel title={t.systemTitle}>
        <div className="flex flex-col">
          {/* Every row reports what is actually true. No value here is a default. */}
          <StatusRow
            label={t.svcAdminAuth}
            value={isAdminSdkConfigured() ? t.statusConnected : t.statusNotConfigured}
            ok={isAdminSdkConfigured()}
          />
          <StatusRow
            label={t.svcFirebase}
            value={isFirebaseConfigured ? t.statusConnected : t.statusNotConfigured}
            ok={isFirebaseConfigured}
          />
          <StatusRow label={t.svcDatabase} value={dbOk ? t.statusConnected : t.statusNotConfigured} ok={dbOk} />
          <StatusRow
            label={t.svcAnalytics}
            value={dbOk ? t.statusDurable : t.statusDisabled}
            ok={dbOk}
          />
          <StatusRow
            label={t.eventsStored}
            value={stats.ok ? String(stats.data.total) : t.unavailable}
            ok={stats.ok ? true : null}
          />
          <StatusRow
            label={t.lastEvent}
            value={stats.ok ? (stats.data.last ? formatDateTime(stats.data.last, locale) : t.never) : t.unavailable}
            ok={stats.ok ? true : null}
          />
          <StatusRow
            label={t.svcMigrations}
            value={migrations.ok ? `${migrations.data.tables.length}` : t.unavailable}
            ok={migrations.ok ? migrations.data.tables.length >= 5 : null}
            detail={migrations.ok ? migrations.data.tables.join(", ") : undefined}
          />
          <StatusRow label={t.svcFinancial} value={t.statusNotConfigured} ok={false} />
          <StatusRow
            label={t.svcRealtime}
            value={PRESENCE_MODEL.TRUE_REALTIME.available ? t.statusEnabled : t.statusNotEnabled}
            ok={PRESENCE_MODEL.TRUE_REALTIME.available}
          />
          <StatusRow
            label={t.svcWhop}
            value={process.env.WHOP_CLIENT_ID ? t.statusConnected : t.statusNotConfigured}
            ok={Boolean(process.env.WHOP_CLIENT_ID)}
          />
        </div>
      </Panel>

      <Panel title={t.blockedBy}>
        <ul className="flex flex-col gap-2 text-[12.5px] text-[color:var(--a-text-muted)]">
          {[...financial.blocked_by, PRESENCE_MODEL.TRUE_REALTIME.blocked_by].map((reason) => (
            <li key={reason} className="flex gap-2">
              <span aria-hidden="true" className="text-[color:var(--a-warning)]">•</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
