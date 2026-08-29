import type { Metadata } from "next";
import { HomeExperience } from "@/components/HomeExperience";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.meta.brandTitle,
    description: t.meta.brandDescription,
    alternates: { languages: alternateLanguages("/brand") },
  };
}

/**
 * Same experience as the home page, entered on the brand side so the header's
 * "For Brands" link lands directly in the dark brand realm. The in-page toggle
 * still switches back to the creator view without a navigation.
 */
export default function BrandPage() {
  return <HomeExperience initialRole="brand" />;
}
