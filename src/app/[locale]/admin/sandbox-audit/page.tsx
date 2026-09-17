import { AdminTopBar } from "@/components/admin/AdminTopBar";
import { adminMetadata } from "@/components/admin/AdminPage";
import { SandboxAuditBody } from "@/components/admin/SandboxAuditSections";
import { getAdminPageContext } from "@/lib/admin/context";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const generateMetadata = adminMetadata("sandbox");

export const dynamic = "force-dynamic";

/**
 * Admin sandbox audit page — read-only pre-migration checklist.
 * Authorization: layout + page double-lock (same pattern as finance page).
 */
export default async function AdminSandboxAuditPage({ params, searchParams }: Params) {
  const ctx = await getAdminPageContext(params, searchParams);
  if (!ctx.authorized) return null;

  return (
    <>
      <AdminTopBar
        t={ctx.t.admin}
        title={ctx.t.admin.sandbox.pageTitle}
        email={ctx.admin?.email ?? null}
        timezone={ADMIN_TIMEZONE}
        showRange={false}
      />
      <main id="main-content" className="flex-1 px-4 py-5 sm:px-6">
        <SandboxAuditBody t={ctx.t.admin} />
      </main>
    </>
  );
}
