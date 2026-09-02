import { KpiCard } from "../KpiCard";
import { BarList, LineChart, StackedBars } from "../Charts";
import { Panel, Resolved } from "../Panel";
import { Column, DataTable, SourceStatus } from "../DataTable";
import {
  getCountries,
  getDeviceSplit,
  getEntryExit,
  getFunnels,
  getHeadline,
  getLocaleSplit,
  getPages,
  getSources,
  getTrafficSeries,
  getUtm,
  getVisitorSplitSeries,
  type CountryRow,
  type EntryExitRow,
  type FunnelStage,
  type PageRow,
  type SourceRow,
  type UtmRow,
} from "@/lib/analytics/dashboard";
import { countryFlag, countryName, formatBucket, formatDuration, formatPercent } from "@/lib/admin/format";
import type { AdminBodyProps } from "../AdminPage";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/* ============================== TRAFFIC ================================== */

export async function TrafficBody({ t, locale, range, compare }: AdminBodyProps) {
  const [headline, series, split, sources, utmSource, utmMedium, utmCampaign] = await Promise.all([
    getHeadline(range, compare),
    getTrafficSeries(range),
    getVisitorSplitSeries(range),
    getSources(range),
    getUtm("source", range),
    getUtm("medium", range),
    getUtm("campaign", range),
  ]);

  const h = headline.ok ? headline.data.current : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard t={t} locale={locale} label={t.pageviews} value={h?.pageviews ?? null} />
        <KpiCard t={t} locale={locale} label={t.uniqueVisitors} hint={t.visitorsHint} value={h?.unique_visitors ?? null} />
        <KpiCard t={t} locale={locale} label={t.sessions} value={h?.sessions ?? null} />
        <KpiCard
          t={t}
          locale={locale}
          label={t.avgSession}
          value={headline.ok ? (h?.avg_session_seconds != null ? formatDuration(h.avg_session_seconds, locale) : "—") : null}
        />
      </div>

      <Panel title={t.trafficOverTime}>
        <Resolved outcome={series} t={t} isEmpty={(d) => d.length === 0}>
          {(data) => (
            <LineChart
              locale={locale}
              t={t}
              points={data.map((d) => ({
                label: formatBucket(d.bucket, range, locale),
                values: { pageviews: d.pageviews, visitors: d.visitors, sessions: d.sessions },
              }))}
              series={[
                { key: "pageviews", label: t.pageviews, color: "var(--a-accent)" },
                { key: "visitors", label: t.uniqueVisitors, color: "#60a5fa" },
                { key: "sessions", label: t.sessions, color: "#a78bfa" },
              ]}
            />
          )}
        </Resolved>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t.newVsReturning}>
          <Resolved outcome={split} t={t} isEmpty={(d) => d.length === 0}>
            {(data) => (
              <StackedBars
                locale={locale}
                t={t}
                points={data.map((d) => ({
                  label: formatBucket(d.bucket, range, locale),
                  values: { fresh: d.fresh, returning: d.returning },
                }))}
                series={[
                  { key: "fresh", label: t.newVisitors, color: "var(--a-accent)" },
                  { key: "returning", label: t.returningVisitors, color: "#5b6472" },
                ]}
              />
            )}
          </Resolved>
        </Panel>

        <Panel
          title={t.trafficSources}
          hint="Attribution is first-touch: the UTM source of the session, else the referring host, else direct."
        >
          <Resolved outcome={sources} t={t} isEmpty={(d) => d.length === 0}>
            {(data: SourceRow[]) => (
              <BarList
                locale={locale}
                valueLabel={t.sessions}
                rows={data.map((s) => ({
                  label: s.source === "direct" ? t.direct : s.source,
                  value: s.sessions,
                }))}
              />
            )}
          </Resolved>
        </Panel>
      </div>

      <Panel title={t.utmReporting}>
        <div className="grid gap-5 lg:grid-cols-3">
          {([
            [t.source, utmSource],
            [t.medium, utmMedium],
            [t.campaignParam, utmCampaign],
          ] as const).map(([label, outcome]) => (
            <div key={label}>
              <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
                {label}
              </p>
              <Resolved outcome={outcome} t={t} isEmpty={(d) => d.length === 0}>
                {(data: UtmRow[]) => (
                  <BarList
                    locale={locale}
                    valueLabel={t.sessions}
                    rows={data.map((r) => ({ label: r.value, value: r.sessions }))}
                  />
                )}
              </Resolved>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* =============================== PAGES =================================== */

export async function PagesBody({ t, locale, range }: AdminBodyProps) {
  const [pages, entryExit] = await Promise.all([getPages(range, 100), getEntryExit(range, 100)]);

  const entries = new Map<string, EntryExitRow>();
  if (entryExit.ok) for (const row of entryExit.data) entries.set(row.path, row);

  const columns: Column<PageRow>[] = [
    { key: "path", header: t.page, render: (r) => <span className="ltr-token">{r.path}</span> },
    { key: "pv", header: t.pageviews, numeric: true, render: (r) => r.pageviews },
    { key: "uv", header: t.uniqueVisitors, numeric: true, render: (r) => r.visitors },
    { key: "s", header: t.sessions, numeric: true, render: (r) => r.sessions },
    { key: "cta", header: t.ctaClicks, numeric: true, render: (r) => r.cta_clicks },
    {
      key: "entries",
      header: t.entrySessions,
      numeric: true,
      render: (r) => entries.get(r.path)?.entries ?? 0,
    },
    {
      key: "exits",
      header: t.exitSessions,
      numeric: true,
      render: (r) => entries.get(r.path)?.exits ?? 0,
    },
    {
      key: "conv",
      header: t.conversionRate,
      numeric: true,
      // CTA clicks over sessions is a real, defined ratio. Anything needing a
      // completed purchase would be an estimate, so it is not shown.
      render: (r) => (r.sessions ? formatPercent((r.cta_clicks / r.sessions) * 100, locale) : "—"),
    },
  ];

  return (
    <Panel title={t.topPages}>
      <Resolved outcome={pages} t={t} isEmpty={(d) => d.length === 0}>
        {(data) => (
          <DataTable t={t} caption={t.topPages} columns={columns} rows={data} rowKey={(r) => r.path} />
        )}
      </Resolved>
    </Panel>
  );
}

/* ============================== GEOGRAPHY ================================ */

export async function GeographyBody({ t, locale, range }: AdminBodyProps) {
  const countries = await getCountries(range, 60);

  const columns: Column<CountryRow>[] = [
    {
      key: "country",
      header: t.countryDistribution,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span aria-hidden="true">{countryFlag(r.country_code)}</span>
          {countryName(r.country_code, locale, t.unknownCountry)}
        </span>
      ),
    },
    { key: "sessions", header: t.sessions, numeric: true, render: (r) => r.sessions },
    { key: "visitors", header: t.uniqueVisitors, numeric: true, render: (r) => r.visitors },
    { key: "users", header: t.authenticatedUsers, numeric: true, render: (r) => r.users },
    {
      key: "conv",
      header: t.conversionByCountry,
      numeric: true,
      render: (r) => (r.sessions ? formatPercent((r.users / r.sessions) * 100, locale) : "—"),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Panel title={t.visitorsByCountry} hint={t.countryHint}>
        <Resolved outcome={countries} t={t} isEmpty={(d) => d.length === 0}>
          {(data) => (
            <BarList
              locale={locale}
              valueLabel={t.sessions}
              rows={data.slice(0, 12).map((c) => ({
                label: `${countryFlag(c.country_code)}  ${countryName(c.country_code, locale, t.unknownCountry)}`,
                value: c.sessions,
                secondary: `${c.visitors}`,
              }))}
            />
          )}
        </Resolved>
      </Panel>

      <Panel title={t.usersByCountry}>
        <Resolved outcome={countries} t={t} isEmpty={(d) => d.length === 0}>
          {(data) => (
            <DataTable
              t={t}
              caption={t.usersByCountry}
              columns={columns}
              rows={data}
              rowKey={(r) => r.country_code ?? "unknown"}
            />
          )}
        </Resolved>
      </Panel>
    </div>
  );
}

/* =============================== FUNNELS ================================= */

function FunnelView({
  t,
  locale,
  stages,
}: {
  t: Copy;
  locale: "en" | "he";
  stages: FunnelStage[];
}) {
  const first = stages.find((s) => s.count != null)?.count ?? 0;

  return (
    <ol className="flex flex-col gap-2.5">
      {stages.map((stage, i) => {
        const label = t[stage.key as keyof Copy] as string;
        const previous = stages[i - 1]?.count ?? null;
        const width = first > 0 && stage.count != null ? (stage.count / first) * 100 : 0;

        return (
          <li key={stage.key}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate font-medium">{label}</span>

              {stage.observable ? (
                <>
                  <span className="admin-num font-semibold">{stage.count ?? 0}</span>
                  {i > 0 && previous != null && (
                    <span className="admin-num text-[11.5px] text-[color:var(--a-text-dim)]">
                      {t.fromPrevious}{" "}
                      {previous > 0 ? formatPercent(((stage.count ?? 0) / previous) * 100, locale) : "—"}
                    </span>
                  )}
                  {i > 0 && first > 0 && (
                    <span className="admin-num text-[11.5px] text-[color:var(--a-text-dim)]">
                      {t.fromStart} {formatPercent(((stage.count ?? 0) / first) * 100, locale)}
                    </span>
                  )}
                </>
              ) : (
                /* Not zero — nothing can convert through a stage that has no
                   code behind it, and a 0 would read as a conversion failure. */
                <span className="rounded-full bg-[color:var(--a-panel-raised)] px-2 py-0.5 text-[11px] font-semibold text-[color:var(--a-warning)]">
                  {t.notImplemented}
                </span>
              )}
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[color:var(--a-panel-raised)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${stage.observable ? width : 0}%`,
                  background: stage.observable ? "var(--a-accent)" : "transparent",
                }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export async function FunnelsBody({ t, locale, range }: AdminBodyProps) {
  const funnels = await getFunnels(range);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel title={t.creatorFunnel}>
        <Resolved outcome={funnels} t={t}>
          {(data) => <FunnelView t={t} locale={locale} stages={data.creator} />}
        </Resolved>
      </Panel>
      <Panel title={t.brandFunnel}>
        <Resolved outcome={funnels} t={t}>
          {(data) => <FunnelView t={t} locale={locale} stages={data.brand} />}
        </Resolved>
      </Panel>
    </div>
  );
}

/* =============================== ACTIVITY ================================ */

export async function ActivityBody({ t, locale }: AdminBodyProps) {
  const { getActiveSessions, getRecentlyActiveCount } = await import("@/lib/analytics/dashboard");
  const [count, sessions] = await Promise.all([getRecentlyActiveCount(), getActiveSessions(100)]);

  return (
    <div className="flex flex-col gap-5">
      <SourceStatus label={t.svcRealtime} status={t.statusNotEnabled} body={t.realtimeBanner} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          t={t}
          locale={locale}
          accent
          label={t.recentlyActive}
          hint={t.recentlyActiveHint}
          value={count.ok ? count.data : null}
        />
      </div>

      <Panel title={t.activityTitle}>
        <Resolved outcome={sessions} t={t} isEmpty={(d) => d.length === 0}>
          {(data) => (
            <DataTable
              t={t}
              caption={t.activityTitle}
              rows={data}
              rowKey={(r, i) => `${r.last_activity_at}-${i}`}
              columns={[
                { key: "path", header: t.currentPage, render: (r) => <span className="ltr-token">{r.last_path}</span> },
                {
                  key: "country",
                  header: t.countryDistribution,
                  render: (r) => `${countryFlag(r.country_code)} ${countryName(r.country_code, locale, t.unknownCountry)}`,
                },
                { key: "device", header: t.device, render: (r) => r.device_category },
                { key: "browser", header: t.browser, render: (r) => r.browser_family ?? "—" },
                { key: "locale", header: t.localeDistribution, render: (r) => r.locale },
                { key: "pv", header: t.pageviews, numeric: true, render: (r) => r.page_view_count },
                {
                  key: "duration",
                  header: t.duration,
                  numeric: true,
                  render: (r) =>
                    formatDuration(
                      (new Date(r.last_activity_at).getTime() - new Date(r.started_at).getTime()) / 1000,
                      locale,
                    ),
                },
              ]}
            />
          )}
        </Resolved>
      </Panel>
    </div>
  );
}

export { getDeviceSplit, getLocaleSplit };
