import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { LegalDocument } from "@/components/legal/LegalDocument";
import { privacySectionsEn } from "@/content/legal/privacy.en";
import { privacySectionsHe } from "@/content/legal/privacy.he";
import { LEGAL_LAST_UPDATED, formatLegalDate } from "@/lib/legal-config";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: `${t.legal.privacyTitle} | ClipRewards`,
    description: t.legal.privacyMetaDescription,
    alternates: { languages: alternateLanguages("/privacy-policy") },
  };
}

/* ==========================================================================
   PRIVACY POLICY

   The document body lives in src/content/legal/privacy.{en,he}.tsx. The
   developer notes about what this build actually does — and the LEGAL REVIEW
   REQUIRED marker — stay with the English source there, not on the page.
   Section ids are identical across languages so deep links survive a switch.
   ========================================================================== */

export default async function PrivacyPolicyPage({ params }: Params) {
  const { locale, t } = await getI18n(params);
  const sections = locale === "he" ? privacySectionsHe() : privacySectionsEn();

  return (
    <>
      <Header role="creator" />
      <LegalDocument
        label={t.legal.label}
        title={t.legal.privacyTitle}
        intro={t.legal.privacyIntro}
        lastUpdated={formatLegalDate(LEGAL_LAST_UPDATED, locale)}
        sections={sections}
      />
      <Footer role="creator" />
    </>
  );
}
