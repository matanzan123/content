import { KpiCard } from "./KpiCard";
import { BarList, LineChart, StackedBars } from "./Charts";
import { Panel, Resolved } from "./Panel";
import { SourceStatus } from "./DataTable";
import {
  getActiveUsers,
  getCountries,
  getFunnels,
  getHeadline,
  getPages,
  getRecentlyActiveCount,
  getTrafficSeries,
  getVisitorSplitSeries,
} from "@/lib/analytics/dashboard";
import { getLedgerAvailability } from "@/lib/analytics/ledger-source";
import { percentChange, type CompareKey, type RangeKey } from "@/lib/analytics/range";
import { countryName, formatBucket, formatDuration } from "@/lib/admin/format";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/**
 * The overview, assembled from independent queries.
 *
 * Each panel awaits its own query and renders its own state, so one failing
 * request degrades one card rather than blanking the page. They are issued
 * together with Promise.all — sequential awaits here would make the page as
 * slow as the sum of every query.
 */
export async function Charts({
  t,
  locale,
  range,
  compare,
}: {
  t: Copy;
  locale: "en" | "he";
  range: RangeKey;
  compare: CompareKey;
}) {
  const [headline, activeUsers, recentlyActive, traffic, split, countries, pages, funnels] =
    await Promise.all([
      getHeadline(range, compare),
      getActiveUsers(),
      getRecentlyActiveCount(),
      getTrafficSeries(range),
      getVisitorSplitSeries(range),
      getCountries(range, 8),
      getPages(range, 8),
      getFunnels(range),
    ]);

  const h = headline.ok ? headline.data : null;
  const prev = h?.previous ?? null;
  const compUnavailable = h?.comparison_unavailable ?? false;
  const num = (v: number | undefined) => (headline.ok ? (v ?? 0) : null);
  const change = (cur: number | undefined, before: number | undefined) =>
    cur == null || before == null ? null : percentChange(cur, before);

  const financial = getLedgerAvailability();

  return (
    <div className="flex flex-col gap-5">
      {/* --------------------------- headline KPIs --------------------------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          t={t}
          locale={locale}
          label={t.pageviews}
          value={num(h?.current.pageviews)}
          change={change(h?.current.pageviews, prev?.pageviews)}
          changeUnavailable={compUnavailable}
        />
        <KpiCard
          t={t}
          locale={locale}
          label={t.uniqueVisitors}
          hint={t.visitorsHint}
          value={num(h?.current.unique_visitors)}
          change={change(h?.current.unique_visitors, prev?.unique_visitors)}
          changeUnavailable={compUnavailable}
        />
        <KpiCard
          t={t}
          locale={locale}
          label={t.sessions}
          value={num(h?.current.sessions)}
          change={change(h?.current.sessions, prev?.sessions)}
          changeUnavailable={compUnavailable}
        />
        <KpiCard
          t={t}
          locale={locale}
          accent
          label={t.recentlyActive}
          hint={t.recentlyActiveHint}
          value={recentlyActive.ok ? recentlyActive.data : null}
        />
        <KpiCard
          t={t}
          locale={locale}
          label={t.avgSession}
          value={
            headline.ok
              ? h?.current.avg_session_seconds != null
                ? formatDuration(h.current.avg_session_seconds, locale)
                : "—"
              : null
          }
        />
        <KpiCard t={t} locale={locale} label={t.dau} hint={t.activeUsersHint} value={activeUsers.ok ? activeUsers.data.dau : null} />
        <KpiCard t={t} locale={locale} label={t.wau} value={activeUsers.ok ? activeUsers.data.wau : null} />
        <KpiCard t={t} locale={locale} label={t.mau} value={activeUsers.ok ? activeUsers.data.mau : null} />
        <KpiCard
          t={t}
          locale={locale}
          label={t.newVisitors}
          value={num(h?.current.new_visitors)}
          change={change(h?.current.new_visitors, prev?.new_visitors)}
          changeUnavailable={compUnavailable}
        />
        <KpiCard
          t={t}
          locale={locale}
          label={t.returningVisitors}
          value={num(h?.current.returning_visitors)}
          change={change(h?.current.returning_visitors, prev?.returning_visitors)}
          changeUnavailable={compUnavailable}
        />
      </div>

      {/* --------------------------- business KPIs --------------------------- */}
      <SourceStatus label={t.financialSource} status={t.financialStatus} body={t.financialBody} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([
          t.grossVolume,
          t.creatorPayouts,
          t.platformRevenue,
          t.netRevenue,
        ] as const).map((label) => (
          // Value is null, not zero: no payment source is connected, and "$0"
          // would read as a business result rather than a missing input.
          <KpiCard
            key={label}
            t={t}
            locale={locale}
            label={label}
            value={financial.source_available ? 0 : null}
            unavailableLabel={t.sourceNotConnected}
          />
        ))}
      </div>

      {/* ------------------------------- charts ------------------------------ */}
      <Panel title={t.trafficOverTime}>
        <Resolved outcome={traffic} t={t} isEmpty={(d) => d.length === 0}>
          {(data) => (
            <LineChart
              locale={locale}
              t={t}
              points={data.map((d) => ({
                label: formatBucket(d.bucket, range, locale),
                values: { pageviews: d.pageviews, visitors: d.visitors },
              }))}
              series={[
                { key: "pageviews", label: t.pageviews, color: "var(--a-accent)" },
                { key: "visitors", label: t.uniqueVisitors, color: "#60a5fa" },
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

        <Panel title={t.topCountries} hint={t.countryHint}>
          <Resolved outcome={countries} t={t} isEmpty={(d) => d.length === 0}>
            {(data) => (
              <BarList
                locale={locale}
                valueLabel={t.sessions}
                rows={data.map((c) => ({
                  label: countryName(c.country_code, locale, t.unknownCountry),
                  value: c.sessions,
                }))}
              />
            )}
          </Resolved>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t.topPages}>
          <Resolved outcome={pages} t={t} isEmpty={(d) => d.length === 0}>
            {(data) => (
              <BarList
                locale={locale}
                valueLabel={t.pageviews}
                rows={data.map((p) => ({ label: p.path, value: p.pageviews }))}
              />
            )}
          </Resolved>
        </Panel>

        <Panel title={t.creatorFunnel}>
          <Resolved outcome={funnels} t={t}>
            {(data) => (
              <BarList
                locale={locale}
                valueLabel={t.sessions}
                rows={data.creator.map((s) => ({
                  label: t[s.key as keyof Copy] as string,
                  value: s.count ?? 0,
                }))}
              />
            )}
          </Resolved>
        </Panel>
      </div>
    </div>
  );
}
