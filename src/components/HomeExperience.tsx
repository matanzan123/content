"use client";

import { useState } from "react";
import { ActiveCreatorsStrip } from "./ActiveCreatorsStrip";
import { CTASocialProof } from "./CTASocialProof";
import { FAQSection } from "./FAQSection";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { PopularCampaigns } from "./PopularCampaigns";
import { SuccessStories } from "./SuccessStories";
import { TrustSection } from "./TrustSection";
import type { Role } from "./RoleToggle";

export function HomeExperience() {
  const [role, setRole] = useState<Role>("creator");

  return (
    <>
      <Header role={role} />
      <Hero role={role} onRoleChange={setRole} />
      <HowItWorks role={role} />
      <TrustSection role={role} />
      <ActiveCreatorsStrip role={role} />
      <CTASocialProof role={role} variant="first" />
      <PopularCampaigns role={role} />
      <SuccessStories role={role} />
      <CTASocialProof role={role} variant="second" />
      <FAQSection role={role} />
      <Footer role={role} />
    </>
  );
}
