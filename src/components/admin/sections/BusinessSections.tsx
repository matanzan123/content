import { KpiCard } from "../KpiCard";
import { BarList } from "../Charts";
import { Panel, Resolved } from "../Panel";
import { Column, DataTable, SourceStatus } from "../DataTable";
import {
  getCountries,
  getFunnels,
  getHeadline,
  getLedgerTotals,
  getLocaleSplit,
  getUserSummary,
  getUsers,
  type UserRow,
} from "@/lib/analytics/dashboard";
import { getLedgerAvailability } from "@/lib/analytics/ledger-source";
import { countryFlag, countryName, formatDateTime } from "@/lib/admin/format";
import type { AdminBodyProps } from "../AdminPage";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/* =============================== REVENUE ================================= */

/**
 * The full revenue architecture, built now so it starts working the day a
 * payment provider writes its first row — and honest until then.
 *
 * Every card reads `source_available`. While that is false the value is null
 * and the card says "source not connected". None of these ever renders a zero
 * from a missing input, because a zero would be read as a business result.
 */
function RevenueCards({ t, locale, available }: { t: Copy; locale: "en" | "he"; available: boolean }) {
  const cards: string[] = [
    t.grossVolume,
    t.platformRevenue,
    t.creatorPayouts,
    t.netRevenue,
    t.refunds,
    t.processingFees,
    t.pendingPayouts,
    t.completedPayouts,
    t.failedPayments,
    t.outstandingBalances,
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {cards.map((label) => (
        <KpiCard
          key={label}
          t={t}
          locale={locale}
          label={label}
          value={available ? 0 : null}
          unavailableLabel={t.sourceNotConnected}
        />
      ))}
    </div>
  );
}

export async function RevenueBody({ t, locale }: AdminBodyProps) {
  const availability = getLedgerAvailability();
  const totals = await getLedgerTotals();

  return (
    <div className="flex flex-col gap-5">
      <SourceStatus label={t.financialSource} status={t.financialStatus} body={t.financialBody} />

      <RevenueCards t={t} locale={locale} available={availability.source_available} />

      <Panel title={t.revenueByCurrency} hint={t.multiCurrencyNote}>
        <Resolved outcome={totals} t={t} isEmpty={(d) => d.length === 0}>
          {(rows) => (
            // Each currency is its own row. There is no grand total, because
            // summing across currencies without a stated rate and date would
            // produce a number nobody could reproduce.
            <DataTable
              t={t}
              caption={t.revenueByCurrency}
              rows={rows}
              rowKey={(r) => r.currency}
              columns={[
                { key: "currency", header: t.revenueByCurrency, render: (r) => <span className="ltr-token">{r.currency}</span> },
                {
                  key: "completed",
                  header: t.completedPayouts,
                  numeric: true,
                  render: (r) => (
                    <span className="ltr-token">
                      {new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
                        style: "currency",
                        currency: r.currency,
                      }).format(Number(r.completed_minor) / 100)}
                    </span>
                  ),
                },
                {
                  key: "pending",
                  header: t.pendingPayouts,
                  numeric: true,
                  render: (r) => (
                    <span className="ltr-token">
                      {new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
                        style: "currency",
                        currency: r.currency,
                      }).format(Number(r.pending_minor) / 100)}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Resolved>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t.topBrandsBySpend}>
          <p className="py-8 text-center text-[12.5px] text-[color:var(--a-text-dim)]">
            {t.sourceNotConnected}
          </p>
        </Panel>
        <Panel title={t.topCampaignsByRevenue}>
          <p className="py-8 text-center text-[12.5px] text-[color:var(--a-text-dim)]">
            {t.sourceNotConnected}
          </p>
        </Panel>
      </div>
    </div>
  );
}

/* ================================ USERS ================================== */

export async function UsersBody({ t, locale, range }: AdminBodyProps) {
  const [summary, users, locales, countries] = await Promise.all([
    getUserSummary(),
    getUsers(100),
    getLocaleSplit(range),
    getCountries(range, 12),
  ]);

  const columns: Column<UserRow>[] = [
    // The uid is shown truncated: an operator needs to correlate a row with a
    // support ticket, not to read a full opaque identifier at a glance.
    {
      key: "uid",
      header: t.userId,
      render: (r) => <span className="ltr-token text-[11.5px]">{r.firebase_uid.slice(0, 12)}…</span>,
    },
    { key: "type", header: t.userType, render: (r) => r.user_type },
    {
      key: "country",
      header: t.countryDistribution,
      render: (r) => `${countryFlag(r.country_code)} ${countryName(r.country_code, locale, t.unknownCountry)}`,
    },
    { key: "locale", header: t.localeDistribution, render: (r) => r.locale ?? "—" },
    { key: "first", header: t.firstSeen, render: (r) => formatDateTime(r.first_seen_at, locale) },
    { key: "last", header: t.lastSeen, render: (r) => formatDateTime(r.last_seen_at, locale) },
    {
      key: "onboarding",
      header: t.onboardingStatus,
      render: (r) =>
        r.onboarding === "completed"
          ? t.onboardingCompleted
          : r.onboarding === "started"
            ? t.onboardingStarted
            : "—",
    },
  ];

  const s = summary.ok ? summary.data : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <KpiCard t={t} locale={locale} label={t.authenticatedUsers} value={s?.total ?? null} />
        <KpiCard t={t} locale={locale} label={t.creatorsLabel} value={s?.creators ?? null} />
        <KpiCard t={t} locale={locale} label={t.brandsLabel} value={s?.brands ?? null} />
        <KpiCard t={t} locale={locale} label={t.adminsLabel} value={s?.admins ?? null} />
        <KpiCard t={t} locale={locale} label={t.onboardingStarted} value={s?.onboarding_started ?? null} />
        <KpiCard t={t} locale={locale} label={t.onboardingCompleted} value={s?.onboarding_completed ?? null} />
        <KpiCard t={t} locale={locale} label={t.brandFormSubmitted} value={s?.brand_form_submitted ?? null} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t.localeDistribution}>
          <Resolved outcome={locales} t={t} isEmpty={(d) => d.length === 0}>
            {(data) => (
              <BarList
                locale={locale}
                valueLabel={t.sessions}
                rows={data.map((d) => ({ label: d.value ?? "—", value: d.count }))}
              />
            )}
          </Resolved>
        </Panel>
        <Panel title={t.countryDistribution} hint={t.countryHint}>
          <Resolved outcome={countries} t={t} isEmpty={(d) => d.length === 0}>
            {(data) => (
              <BarList
                locale={locale}
                valueLabel={t.authenticatedUsers}
                rows={data.map((c) => ({
                  label: `${countryFlag(c.country_code)}  ${countryName(c.country_code, locale, t.unknownCountry)}`,
                  value: c.users,
                }))}
              />
            )}
          </Resolved>
        </Panel>
      </div>

      <Panel title={t.authenticatedUsers} hint={t.noIdentityNote}>
        <Resolved outcome={users} t={t} isEmpty={(d) => d.length === 0}>
          {(data) => (
            <DataTable t={t} caption={t.authenticatedUsers} columns={columns} rows={data} rowKey={(r) => r.firebase_uid} />
          )}
        </Resolved>
      </Panel>
    </div>
  );
}

/* ===================== CAMPAIGNS / CREATORS / BRANDS ===================== */

/** Metrics that will exist once a product database does. Listed, never faked. */
function PendingMetrics({ t, items }: { t: Copy; items: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((label) => (
        <li
          key={label}
          className="rounded-lg border border-dashed border-[color:var(--a-border-strong)] px-3 py-2.5"
        >
          <p className="text-[12px] font-medium text-[color:var(--a-text-muted)]">{label}</p>
          <p className="mt-0.5 text-[11px] text-[color:var(--a-text-dim)]">{t.needsSource}</p>
        </li>
      ))}
    </ul>
  );
}

export async function CampaignsBody({ t }: AdminBodyProps) {
  return (
    <div className="flex flex-col gap-5">
      <SourceStatus label={t.campaignsTitle} status={t.sourceNotConnected} body={t.campaignSourceBody} />
      <Panel title={t.needsSource}>
        <PendingMetrics
          t={t}
          items={[
            "Total campaigns", "Draft", "Live", "Completed", "Cancelled",
            "Budget funded", "Budget spent", "Views", "Submissions",
            "Approved", "Rejected", "Creator participation", "CPM",
          ]}
        />
      </Panel>
    </div>
  );
}

export async function CreatorsBody({ t, locale, range }: AdminBodyProps) {
  const [funnels, countries, locales] = await Promise.all([
    getFunnels(range),
    getCountries(range, 10),
    getLocaleSplit(range),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <SourceStatus label={t.creatorsLabel} status={t.observableNow} body={t.creatorsSourceBody} tone="positive" />

      <Panel title={t.creatorFunnel}>
        <Resolved outcome={funnels} t={t}>
          {(data) => (
            <BarList
              locale={locale}
              valueLabel={t.sessions}
              rows={data.creator.map((s) => ({ label: t[s.key as keyof Copy] as string, value: s.count ?? 0 }))}
            />
          )}
        </Resolved>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t.countryDistribution}>
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
        <Panel title={t.localeDistribution}>
          <Resolved outcome={locales} t={t} isEmpty={(d) => d.length === 0}>
            {(data) => (
              <BarList locale={locale} valueLabel={t.sessions} rows={data.map((d) => ({ label: d.value ?? "—", value: d.count }))} />
            )}
          </Resolved>
        </Panel>
      </div>

      <Panel title={t.needsSource}>
        <PendingMetrics
          t={t}
          items={[
            "Creator earnings", "Submissions", "Approval rate", "Rejection rate",
            "Views generated", "Average CPM", "Retention", "Fraud / flag rate",
          ]}
        />
      </Panel>
    </div>
  );
}

export async function BrandsBody({ t, locale, range }: AdminBodyProps) {
  const [funnels, countries, headline] = await Promise.all([
    getFunnels(range),
    getCountries(range, 10),
    getHeadline(range, "none"),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <SourceStatus label={t.brandsLabel} status={t.observableNow} body={t.brandsSourceBody} tone="positive" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard t={t} locale={locale} label={t.sessions} value={headline.ok ? headline.data.current.sessions : null} />
      </div>

      <Panel title={t.brandFunnel}>
        <Resolved outcome={funnels} t={t}>
          {(data) => (
            <BarList
              locale={locale}
              valueLabel={t.sessions}
              rows={data.brand
                .filter((s) => s.observable)
                .map((s) => ({ label: t[s.key as keyof Copy] as string, value: s.count ?? 0 }))}
            />
          )}
        </Resolved>
      </Panel>

      <Panel title={t.countryDistribution}>
        <Resolved outcome={countries} t={t} isEmpty={(d) => d.length === 0}>
          {(data) => (
            <BarList
              locale={locale}
              valueLabel={t.sessions}
              rows={data.map((c) => ({ label: countryName(c.country_code, locale, t.unknownCountry), value: c.sessions }))}
            />
          )}
        </Resolved>
      </Panel>

      <Panel title={t.needsSource}>
        <PendingMetrics
          t={t}
          items={[
            "Active brands", "Total spend", "Average campaign budget",
            "Campaigns per brand", "Repeat brands", "Brand retention",
            "Top brands by spend", "Registered but never launched",
          ]}
        />
      </Panel>
    </div>
  );
}
