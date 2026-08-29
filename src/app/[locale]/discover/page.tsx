import type { Metadata } from "next";
import { DiscoverExperience } from "@/components/discover/DiscoverExperience";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.discover.metaTitle,
    description: t.meta.discoverDescription,
    alternates: { languages: alternateLanguages("/discover") },
  };
}

export default function DiscoverPage() {
  return <DiscoverExperience />;
}
