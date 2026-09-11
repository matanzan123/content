import { KpiCard } from "./KpiCard";
import { Panel, EmptyState } from "./Panel";
import { getStats, getUsers, getCampaigns, type Outcome, type UserRecord, type CampaignRecord, type DashboardStats } from "@/lib/admin/firebase-queries";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];
type Locale = "en" | "he";

function Resolved<T>({
  outcome,
  t,
  isEmpty,
  children,
}: {
  outcome: Outcome<T>;
  t: Copy;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
}) {
  if (!outcome.ok) {
    if (outcome.reason === "unconfigured") {
      return (
        <div className="flex min-h-[120px] flex-col items-center justify-center gap-1.5 text-center">
          <p className="text-[13px] font-semibold text-[color:var(--a-warning)]">{t.unconfiguredTitle}</p>
          <p className="max-w-[46ch] text-[12px] text-[color:var(--a-text-dim)]">{t.unconfiguredBody}</p>
        </div>
      );
    }
    return (
      <div className="flex min-h-[120px] flex-col items-center justify-center gap-1.5 text-center">
        <p className="text-[13px] font-semibold text-[color:var(--a-negative)]">{t.errorTitle}</p>
        <p className="max-w-[40ch] text-[12px] text-[color:var(--a-text-dim)]">{t.errorBody}</p>
      </div>
    );
  }
  if (isEmpty?.(outcome.data)) return <EmptyState t={t} />;
  return <>{children(outcome.data)}</>;
}

function money(n: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(iso: string | null, locale: Locale) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

/* =========================================================================
   OVERVIEW
   ========================================================================= */

export async function OverviewBody({ t, locale }: { t: Copy; locale: Locale }) {
  const stats = await getStats();

  return (
    <Resolved outcome={stats} t={t}>
      {(data) => (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label={t.authenticatedUsers} value={data.totalUsers} locale={locale} t={t} accent />
            <KpiCard label={t.creatorsLabel} value={data.creators} locale={locale} t={t} />
            <KpiCard label={t.brandsLabel} value={data.brands} locale={locale} t={t} />
            <KpiCard label={t.adminsLabel} value={data.admins} locale={locale} t={t} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KpiCard label={t.campaignsTitle} value={data.totalCampaigns} locale={locale} t={t} />
            <KpiCard label={t.nav.campaigns + " (Active)"} value={data.activeCampaigns} locale={locale} t={t} />
            <KpiCard label={t.platformRevenue} value={money(data.totalRevenue, locale)} locale={locale} t={t} accent />
          </div>
        </div>
      )}
    </Resolved>
  );
}

/* =========================================================================
   USERS
   ========================================================================= */

export async function UsersBody({ t, locale }: { t: Copy; locale: Locale }) {
  const result = await getUsers();

  return (
    <Resolved outcome={result} t={t} isEmpty={(u) => u.length === 0}>
      {(users) => (
        <Panel title={t.authenticatedUsers} hint={`${users.length} ${t.rows.replace("{count}", String(users.length))}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[color:var(--a-border)] text-start text-[11.5px] font-bold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
                  <th className="py-2 pe-4 text-start">{t.adminLabel}</th>
                  <th className="py-2 pe-4 text-start">{t.userType}</th>
                  <th className="py-2 pe-4 text-start">{t.firstSeen}</th>
                  <th className="py-2 pe-4 text-start">{t.lastSeen}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.uid} user={u} locale={locale} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </Resolved>
  );
}

function UserRow({ user, locale, t }: { user: UserRecord; locale: Locale; t: Copy }) {
  return (
    <tr className="border-b border-[color:var(--a-border)] last:border-0">
      <td className="py-2.5 pe-4">
        <div className="flex items-center gap-2.5">
          {user.photoURL ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.photoURL} alt="" className="h-7 w-7 rounded-full" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--a-accent-soft)] text-[11px] font-bold text-[color:var(--a-accent)]">
              {(user.displayName ?? user.email ?? "?").charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-medium text-[color:var(--a-text)]">
              {user.displayName ?? "—"}
              {user.isAdmin && (
                <span className="ms-1.5 rounded bg-[color:var(--a-accent-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[color:var(--a-accent)]">
                  Admin
                </span>
              )}
            </p>
            <p className="truncate text-[12px] text-[color:var(--a-text-dim)] ltr-token">{user.email ?? "—"}</p>
          </div>
        </div>
      </td>
      <td className="py-2.5 pe-4">
        {/* THREE STATES, not two. A null role means the user has never
            chosen; rendering them as a creator — which this did — reports a
            fact nobody established. */}
        <span className={[
          "rounded-full px-2 py-0.5 text-[11px] font-bold",
          user.role === "brand"
            ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
            : user.role === "creator"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
        ].join(" ")}>
          {user.role === "brand"
            ? t.brandsLabel
            : user.role === "creator"
              ? t.creatorsLabel
              : t.unassignedLabel}
        </span>
      </td>
      <td className="py-2.5 pe-4 text-[color:var(--a-text-muted)]">{fmtDate(user.creationTime, locale)}</td>
      <td className="py-2.5 pe-4 text-[color:var(--a-text-muted)]">{fmtDate(user.lastSignInTime, locale)}</td>
    </tr>
  );
}

/* =========================================================================
   CAMPAIGNS
   ========================================================================= */

export async function CampaignsBody({ t, locale }: { t: Copy; locale: Locale }) {
  const result = await getCampaigns();

  return (
    <Resolved outcome={result} t={t} isEmpty={(c) => c.length === 0}>
      {(campaigns) => (
        <Panel title={t.campaignsTitle}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[color:var(--a-border)] text-start text-[11.5px] font-bold uppercase tracking-[0.08em] text-[color:var(--a-text-dim)]">
                  <th className="py-2 pe-4 text-start">Campaign</th>
                  <th className="py-2 pe-4 text-start">Brand</th>
                  <th className="py-2 pe-4 text-start">Status</th>
                  <th className="py-2 pe-4 text-end">Budget</th>
                  <th className="py-2 pe-4 text-end">Paid</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-[color:var(--a-border)] last:border-0">
                    <td className="py-2.5 pe-4 font-medium text-[color:var(--a-text)]">{c.title}</td>
                    <td className="py-2.5 pe-4 text-[color:var(--a-text-muted)]">{c.brandName}</td>
                    <td className="py-2.5 pe-4">
                      <span className={[
                        "rounded-full px-2 py-0.5 text-[11px] font-bold",
                        c.status === "active"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
                      ].join(" ")}>
                        {c.status}
                      </span>
                    </td>
                    <td className="py-2.5 pe-4 text-end text-[color:var(--a-text)] ltr-token">{money(c.budget, locale)}</td>
                    <td className="py-2.5 pe-4 text-end text-[color:var(--a-text-muted)] ltr-token">{money(c.paidOut, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </Resolved>
  );
}

/* =========================================================================
   REVENUE
   ========================================================================= */

export async function RevenueBody({ t, locale }: { t: Copy; locale: Locale }) {
  const stats = await getStats();

  return (
    <Resolved outcome={stats} t={t}>
      {(data) => (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KpiCard label={t.platformRevenue} value={money(data.totalRevenue, locale)} locale={locale} t={t} accent />
            <KpiCard label={t.campaignsTitle} value={data.totalCampaigns} locale={locale} t={t} />
            <KpiCard label={t.nav.campaigns + " (Active)"} value={data.activeCampaigns} locale={locale} t={t} />
          </div>
          {data.totalRevenue === 0 && data.totalCampaigns === 0 && (
            <Panel>
              <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 text-center">
                <span aria-hidden="true" className="text-[color:var(--a-text-dim)]">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
                    <path d="M12 3v18M16.5 7.5c0-1.7-2-2.5-4.5-2.5s-4.5.9-4.5 2.6S9.3 10 12 10.5s4.5 1 4.5 2.9-2 2.6-4.5 2.6-4.5-.8-4.5-2.5" />
                  </svg>
                </span>
                <p className="text-[13px] font-semibold">{t.noData}</p>
                <p className="max-w-[40ch] text-[12px] text-[color:var(--a-text-dim)]">{t.financialBody}</p>
              </div>
            </Panel>
          )}
        </div>
      )}
    </Resolved>
  );
}
