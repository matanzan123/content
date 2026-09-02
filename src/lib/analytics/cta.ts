/* ==========================================================================
   CTA IDENTIFIERS

   Stable ids, not button text.

   The site is bilingual: "Start Earning" and "להתחיל להרוויח" are the same
   conversion action. Keying on the label would split one funnel into two and
   make every future translation change look like a traffic drop. The id is the
   canonical name; the label is presentation.

   Ids are `realm.surface.action`, lowercase with underscores, and match the
   collector's `^[a-z0-9_]{1,48}$` allow-list.
   ========================================================================== */

export const CTA_IDS = {
  // Creator realm
  creatorHeroStartEarning: "creator_hero_start_earning",
  creatorHeroBrowseCampaigns: "creator_hero_browse_campaigns",
  creatorStepsStartEarning: "creator_steps_start_earning",
  creatorCtaFirst: "creator_cta_first_start_earning",
  creatorCtaSecond: "creator_cta_second_create_account",
  creatorCampaignsSeeAll: "creator_campaigns_see_all",
  creatorFaqSeeAll: "creator_faq_see_all",
  headerBecomeCreator: "header_become_creator",

  // Brand realm
  brandHeroLaunchCampaign: "brand_hero_launch_campaign",
  brandHeroSeeVerified: "brand_hero_see_verified_brands",
  brandCredibilityLaunch: "brand_credibility_launch_my_campaign",
  brandVerificationLaunch: "brand_verification_launch_my_campaign",
  brandResultsLaunch: "brand_results_launch_my_campaign",
  brandProtectionLaunch: "brand_protection_launch_my_campaign",
  brandFaqSeeAll: "brand_faq_see_all",
  headerLaunchCampaign: "header_launch_campaign",

  // Shared
  footerBecomeCreator: "footer_become_creator",
  footerLaunchCampaign: "footer_launch_campaign",
  faqsContactTeam: "faqs_contact_team",
  faqsBecomeCreator: "faqs_become_creator",
  faqsLaunchCampaign: "faqs_launch_campaign",
} as const;

export type CtaId = (typeof CTA_IDS)[keyof typeof CTA_IDS];
