"use client";

import { useState } from "react";
import { ActiveCreatorsStrip } from "./ActiveCreatorsStrip";
import { BrandCredibility } from "./BrandCredibility";
import { BrandProtection } from "./BrandProtection";
import { BrandResults } from "./BrandResults";
import { CTASocialProof } from "./CTASocialProof";
import { FAQSection } from "./FAQSection";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { PopularCampaigns } from "./PopularCampaigns";
import { SuccessStories } from "./SuccessStories";
import { TrustSection } from "./TrustSection";
import { WhyVerificationMatters } from "./WhyVerificationMatters";
import type { Role } from "./RoleToggle";

/**
 * Brand realm — review build, assembled section by section.
 *
 * Approved so far: Hero -> Join 200+ Brands -> Why Verification -> Results. Why Verification
 * Matters. `HowItWorks` ("Three Steps To Launch") is deliberately NOT rendered
 * here; its component is untouched and still used by the creator realm, so
 * restoring it is a one-line change once its final position is decided. The
 * sections below are parked the same way.
 */
const PARKED_BRAND_SECTIONS = [BrandProtection] as const;
void PARKED_BRAND_SECTIONS;

export function HomeExperience() {
  const [role, setRole] = useState<Role>("creator");
  const isBrand = role === "brand";

  if (isBrand) {
    return (
      <div className="realm-brand">
        <Header role={role} />
        <Hero role={role} onRoleChange={setRole} />
        <BrandCredibility />
        <WhyVerificationMatters />
        <BrandResults />
      </div>
    );
  }

  // Creator realm — approved light flow, unchanged.
  return (
    <div>
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
    </div>
  );
}
