import type { Metadata } from "next";
import { HomeExperience } from "@/components/HomeExperience";

export const metadata: Metadata = {
  title: "For Brands — ClipRewards",
  description: "Launch creator campaigns and pay only for verified results.",
};

/**
 * Same experience as the home page, entered on the brand side so the header's
 * "For Brands" link lands directly in the dark brand realm. The in-page toggle
 * still switches back to the creator view without a navigation.
 */
export default function BrandPage() {
  return (
    <main className="flex-1">
      <HomeExperience initialRole="brand" />
    </main>
  );
}
