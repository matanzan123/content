import { AdminTopBar } from "@/components/admin/AdminTopBar";
import { adminMetadata } from "@/components/admin/AdminPage";
import { Charts } from "@/components/admin/OverviewSections";
import { getAdminPageContext } from "@/lib/admin/context";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const generateMetadata = adminMetadata("overview");

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage({ params, searchParams }: Params) {
  const ctx = await getAdminPageContext(params, searchParams);
  if (!ctx.authorized) return null; // The layout already refused; belt and braces.

  return (
    <>
      <AdminTopBar
        t={ctx.t.admin}
        title={ctx.t.admin.nav.overview}
        email={ctx.admin?.email ?? null}
        timezone={ADMIN_TIMEZONE}
      />
      <main id="main-content" className="flex-1 px-4 py-5 sm:px-6">
        <Charts t={ctx.t.admin} locale={ctx.locale} range={ctx.range} compare={ctx.compare} />
      </main>
    </>
  );
}
