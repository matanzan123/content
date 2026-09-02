import { AdminPage, adminMetadata, type AdminPageProps } from "@/components/admin/AdminPage";
import { GeographyBody } from "@/components/admin/sections/AnalyticsSections";

export const generateMetadata = adminMetadata("geography");

/** Authorization runs in the admin layout and again in AdminPage. */
export const dynamic = "force-dynamic";

export default function Page(props: AdminPageProps) {
  return <AdminPage {...props} titleKey="geography" showRange={true} body={GeographyBody} />;
}
