import { AdminTopBar } from "@/components/admin/AdminTopBar";
import { adminMetadata } from "@/components/admin/AdminPage";
import { ApplicantsBody } from "@/components/admin/sections/ApplicantsSection";
import { getAdminPageContext } from "@/lib/admin/context";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const generateMetadata = adminMetadata("applicants");

/**
 * The applicant review queue.
 *
 * AUTHORIZATION IS THE EXISTING ONE, TWICE. The admin layout refuses
 * unauthorised callers, and `getAdminPageContext` re-runs `getAdminCheck`
 * here — the same pattern every other admin page uses, so moving this page
 * cannot silently unprotect it. No second admin mechanism is introduced.
 *
 * There is no reporting range: a review queue is a live list, not a window
 * over time, so the range control is hidden exactly as on /admin/users.
 */
export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: Params) {
  const ctx = await getAdminPageContext(params, searchParams);
  if (!ctx.authorized) return null;

  return (
    <>
      <AdminTopBar
        t={ctx.t.admin}
        title={ctx.t.admin.nav.applicants}
        email={ctx.admin?.email ?? null}
        timezone={ADMIN_TIMEZONE}
        showRange={false}
      />
      <main id="main-content" className="flex-1 px-4 py-5 sm:px-6">
        <ApplicantsBody t={ctx.t.admin} locale={ctx.locale} />
      </main>
    </>
  );
}
