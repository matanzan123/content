import type { Metadata } from "next";
import { HomeExperience } from "@/components/HomeExperience";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.meta.homeTitle,
    description: t.meta.homeDescription,
    alternates: { languages: alternateLanguages("/") },
  };
}

export default function Home() {
  return <HomeExperience />;
}
