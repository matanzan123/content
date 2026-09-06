import { AdminTopBar } from "@/components/admin/AdminTopBar";
import { adminMetadata } from "@/components/admin/AdminPage";
import { CampaignsBody } from "@/components/admin/DashboardSections";
import { getAdminPageContext } from "@/lib/admin/context";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const generateMetadata = adminMetadata("campaigns");
export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: Params) {
  const ctx = await getAdminPageContext(params, searchParams);
  if (!ctx.authorized) return null;

  return (
    <>
      <AdminTopBar
        t={ctx.t.admin}
        title={ctx.t.admin.nav.campaigns}
        email={ctx.admin?.email ?? null}
        timezone={ADMIN_TIMEZONE}
        showRange={false}
      />
      <main id="main-content" className="flex-1 px-4 py-5 sm:px-6">
        <CampaignsBody t={ctx.t.admin} locale={ctx.locale} />
      </main>
    </>
  );
}
