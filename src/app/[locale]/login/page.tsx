import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { alternateLanguages, localePath } from "@/i18n/config";
import { coerceLocale } from "@/i18n/server";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.meta.signInTitle,
    alternates: { languages: alternateLanguages("/login") },
  };
}

/**
 * There is one sign-in surface: the gate in front of onboarding. /login just
 * points at it, staying inside the visitor's language.
 */
export default async function LoginPage({ params }: Params) {
  const { locale } = await params;
  redirect(localePath(coerceLocale(locale), "/onboarding"));
}
