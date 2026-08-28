import type { Metadata } from "next";
import { DiscoverExperience } from "@/components/discover/DiscoverExperience";

export const metadata: Metadata = {
  title: "Discover — ClipRewards",
  description: "Browse the campaigns brands have published and find one to join.",
};

export default function DiscoverPage() {
  return <DiscoverExperience />;
}
