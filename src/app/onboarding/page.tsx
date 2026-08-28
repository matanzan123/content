import type { Metadata } from "next";
import { AuthGate } from "@/components/auth/AuthGate";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";

export const metadata: Metadata = {
  title: "Become a Creator — ClipRewards",
  description: "Sign in with Google and set up your creator profile.",
};

export default function OnboardingPage() {
  return (
    <main className="flex-1 px-5 py-16 sm:py-24">
      <div className="mx-auto max-w-[1080px]">
        <AuthGate
          title="Become a Creator"
          subtitle="Sign in with Google to set up your profile — it takes about a minute."
        >
          <OnboardingWizard />
        </AuthGate>
      </div>
    </main>
  );
}
