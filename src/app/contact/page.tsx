import type { Metadata } from "next";
import { ContactExperience } from "@/components/ContactExperience";

export const metadata: Metadata = {
  title: "Contact — ClipRewards",
  description: "Talk directly with our team about launching a creator campaign.",
};

export default function ContactPage() {
  return (
    <main className="flex-1">
      <ContactExperience />
    </main>
  );
}
