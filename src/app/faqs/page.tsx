import type { Metadata } from "next";
import { FAQsExperience } from "@/components/FAQsExperience";

export const metadata: Metadata = {
  title: "FAQs — ClipRewards",
  description:
    "Answers about payouts, campaigns, submissions, and reviews — for creators and for brands.",
};

export default function FAQsPage() {
  return <FAQsExperience />;
}
