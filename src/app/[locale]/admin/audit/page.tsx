import { AdminPage, adminMetadata, type AdminPageProps } from "@/components/admin/AdminPage";
import { AuditBody } from "@/components/admin/sections/OpsSections";

export const generateMetadata = adminMetadata("audit");

/** Authorization runs in the admin layout and again in AdminPage. */
export const dynamic = "force-dynamic";

export default function Page(props: AdminPageProps) {
  return <AdminPage {...props} titleKey="audit" showRange={false} body={AuditBody} />;
}
