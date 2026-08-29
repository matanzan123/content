import type { Metadata } from "next";
import { AuthGate } from "@/components/auth/AuthGate";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { LanguageSelector } from "@/components/LanguageSelector";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.onboarding.metaTitle,
    description: t.meta.onboardingDescription,
    alternates: { languages: alternateLanguages("/onboarding") },
  };
}

export default async function OnboardingPage({ params }: Params) {
  const { t } = await getI18n(params);
  return (
    <main id="main-content" className="flex-1 px-5 py-16 sm:py-24">
      <div className="mx-auto max-w-[1080px]">
        {/* These pages deliberately have no Header, but someone who lands here
            directly still has to be able to change language. */}
        <div className="mb-6 flex justify-end">
          <LanguageSelector />
        </div>
        <AuthGate title={t.onboarding.gateTitle} subtitle={t.onboarding.gateSubtitle}>
          <OnboardingWizard />
        </AuthGate>
      </div>
    </main>
  );
}
