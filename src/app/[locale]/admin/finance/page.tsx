import { AdminTopBar } from "@/components/admin/AdminTopBar";
import { adminMetadata } from "@/components/admin/AdminPage";
import { FinanceBody } from "@/components/admin/FinanceSections";
import { getAdminPageContext } from "@/lib/admin/context";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const generateMetadata = adminMetadata("finance");

export const dynamic = "force-dynamic";

/**
 * Admin finance dashboard.
 *
 * Authorization is double-locked:
 *   1. The parent layout refuses non-admin sessions before this renders.
 *   2. `getAdminPageContext` re-checks independently — moving the page cannot
 *      accidentally ship it unprotected.
 * All data fetching happens in FinanceBody (a server component), which calls
 * the accounting functions directly — no HTTP, no client-side exposure.
 */
export default async function AdminFinancePage({ params, searchParams }: Params) {
  const ctx = await getAdminPageContext(params, searchParams);
  if (!ctx.authorized) return null;

  return (
    <>
      <AdminTopBar
        t={ctx.t.admin}
        title={ctx.t.admin.finance.pageTitle}
        email={ctx.admin?.email ?? null}
        timezone={ADMIN_TIMEZONE}
        showRange={false}
      />
      <main id="main-content" className="flex-1 px-4 py-5 sm:px-6">
        <FinanceBody t={ctx.t.admin} locale={ctx.locale} />
      </main>
    </>
  );
}
