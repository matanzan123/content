import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sign in — ClipRewards",
};

/**
 * There is one sign-in surface: the gate in front of onboarding. /login just
 * points at it so the header's "Sign in" link and the creator CTA agree.
 */
export default function LoginPage() {
  redirect("/onboarding");
}
