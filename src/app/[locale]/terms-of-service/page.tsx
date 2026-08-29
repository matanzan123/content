import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { LegalDocument } from "@/components/legal/LegalDocument";
import { Ph, callout, h3, list, p, type Section } from "@/components/legal/content";
import {
  GOVERNING_LAW,
  JURISDICTION,
  LEGAL_COMPANY_NAME,
  LEGAL_CONTACT_EMAIL,
  LEGAL_LAST_UPDATED,
  MINIMUM_AGE,
  REGISTERED_ADDRESS,
  formatLegalDate,
} from "@/lib/legal-config";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: `${t.legal.termsTitle} | ClipRewards`,
    description: t.legal.termsMetaDescription,
    alternates: { languages: alternateLanguages("/terms-of-service") },
  };
}

/* ==========================================================================
   TERMS OF SERVICE — original draft.

   One document in three parts: General terms that bind everyone, then the
   additional terms for creators and for brands. The part switcher on the page
   scrolls and highlights; it never hides a part, because a user must not be
   able to accept terms they were never shown.

   Deliberately NOT stated anywhere below, because the product does not define
   them: any fee percentage, any payout schedule, any minimum age, any named
   payment processor, any specific fraud-detection technology, any liability
   cap, and any governing law or venue. Those are placeholders or are described
   as "set out in the applicable campaign or interface".

   LEGAL REVIEW REQUIRED before production launch — see src/lib/legal-config.ts.
   In particular, consider adding jurisdiction-specific advertising and
   endorsement disclosure terms to accompany section 11.
   ========================================================================== */

const PARTS = [
  { key: "general", label: "General", tocLabel: "Part A · General Terms" },
  { key: "creators", label: "Creators", tocLabel: "Part B · Creator Terms" },
  { key: "brands", label: "Brands", tocLabel: "Part C · Brand Terms" },
];

const SECTIONS: Section[] = [
  /* ------------------------------- PART A -------------------------------- */
  {
    id: "acceptance",
    title: "Acceptance of These Terms",
    part: "general",
    blocks: [
      p(
        <>
          These Terms of Service form an agreement between you and{" "}
          <Ph>{LEGAL_COMPANY_NAME}</Ph> (&ldquo;ClipRewards&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo;) and govern your access to and use of the ClipRewards website, platform
          and related services.
        </>,
      ),
      p(
        "By creating an account, joining or publishing a campaign, or otherwise using the platform, you agree to these Terms. If you do not agree to them, do not use the platform.",
      ),
      p(
        "If you are agreeing on behalf of a company or other organisation, you confirm that you have the authority to bind it, and \"you\" means that organisation.",
      ),
      p(
        "Our Privacy Policy explains how we handle information and forms part of your agreement with us.",
      ),
    ],
  },
  {
    id: "eligibility",
    title: "Eligibility and Accounts",
    part: "general",
    blocks: [
      p(
        <>
          You must be at least <Ph>{MINIMUM_AGE}</Ph> years old to hold an account, and you must not
          be barred from using the platform under any applicable law or sanctions regime.
        </>,
      ),
      p(
        "Accounts are created by signing in with a supported identity provider. You must give accurate information, keep it up to date, and keep your sign-in credentials confidential.",
      ),
      p(
        "One person or organisation may hold one account unless we agree otherwise in writing. You are responsible for everything that happens under your account.",
      ),
    ],
  },
  {
    id: "platform-description",
    title: "What the Platform Does",
    part: "general",
    blocks: [
      p(
        "ClipRewards is a marketplace. Brands publish campaigns describing content they want made and promoted; creators browse those campaigns, join the ones they are eligible for, publish content on third-party social platforms, and submit it for review. Where a submission is approved and the activity reported for it is verified, it becomes eligible for payment against that campaign's budget.",
      ),
      p(
        "We provide the platform that connects the two sides and the tooling used to review and verify submissions. We are not a party to the creative relationship between a brand and a creator, we do not employ creators, and we do not act as anyone's agent.",
      ),
      p(
        "We may change, add to or withdraw features of the platform. We will not remove a feature that a live campaign materially depends on without reasonable notice.",
      ),
    ],
  },
  {
    id: "account-responsibilities",
    title: "Your Account Responsibilities",
    part: "general",
    blocks: [
      list([
        "keep your account details accurate and your credentials secure;",
        "do not share, sell or transfer your account, and do not let anyone else use it;",
        "tell us promptly if you suspect unauthorised access to your account;",
        "make sure anyone acting for you complies with these Terms;",
        "comply with the law that applies to you, wherever you are.",
      ]),
      p(
        "We may require additional verification before enabling certain features, and we may decline to enable them if verification is not completed.",
      ),
    ],
  },
  {
    id: "acceptable-use",
    title: "Acceptable Use",
    part: "general",
    blocks: [
      p("You must not, and must not allow anyone else to:"),
      list([
        "use the platform to commit fraud, or misrepresent who you are or who you act for;",
        "use bots, automation, click farms, incentivised traffic, purchased engagement or any other method of generating engagement that is not genuine;",
        "manipulate, inflate or misreport views, impressions, engagement or any other metric;",
        "impersonate another person, brand or organisation, or claim an affiliation you do not have;",
        "submit or promote content that is unlawful, infringing, deceptive, defamatory, hateful, sexually exploitative, or that promotes violence or self-harm;",
        "submit content you do not have the rights to use;",
        "interfere with, disrupt, overload or attempt to gain unauthorised access to the platform, its accounts or its underlying systems;",
        "scrape, harvest or bulk-extract data from the platform except as we expressly permit;",
        "circumvent a suspension, a review decision, or any limit or safeguard we apply;",
        "harass, threaten or abuse other users or our staff.",
      ]),
      p("We may investigate suspected breaches and take the steps described in section 12."),
    ],
  },
  {
    id: "campaign-rules",
    title: "Campaign Rules",
    part: "general",
    blocks: [
      p(
        "Each campaign carries its own brief. A brief may set requirements about the content itself, the platforms it may be published on, the format, the timing, the territories, the accounts that may be used, and what counts as a qualifying submission.",
      ),
      p(
        "Campaign-specific requirements apply in addition to these Terms. Where a brief conflicts with these Terms, these Terms prevail, except where the brief is more restrictive — in which case the brief applies.",
      ),
      p(
        "A brand may change or close a campaign. Changes take effect prospectively and do not retroactively disqualify a submission that already complied with the brief in force when it was made.",
      ),
    ],
  },
  {
    id: "content-and-ip",
    title: "Content and Intellectual Property",
    part: "general",
    blocks: [
      h3("Your content"),
      p(
        "You keep ownership of the content you create and submit. You are responsible for holding all rights necessary for that content, including rights in any music, footage, artwork, trade marks, likenesses or other material appearing in it.",
      ),

      h3("The licence you grant us"),
      p(
        "You grant ClipRewards a non-exclusive, worldwide, royalty-free licence to host, store, reproduce, process, display and transmit your submitted content, for the limited purposes of operating the platform, reviewing and verifying the submission, making it available to the brand whose campaign it was submitted to, and complying with our legal obligations.",
      ),
      p(
        "That licence lasts as long as we need it for those purposes and for any period we are required to retain records. It does not permit us to use your content to advertise ClipRewards, or to license it onward, without your separate permission.",
      ),

      h3("Brand materials"),
      p(
        "Brand names, logos, product imagery and other materials supplied with a campaign remain the property of the brand. They may be used only as that campaign's brief permits, and only while it permits it.",
      ),

      h3("Our materials"),
      p(
        "The platform itself, including its software, design and our own trade marks, belongs to us or our licensors. Nothing in these Terms transfers any of it to you.",
      ),

      h3("Reporting infringement"),
      p(
        <>
          If you believe content on the platform infringes your rights, contact{" "}
          <Ph>{LEGAL_CONTACT_EMAIL}</Ph> with enough detail for us to identify the material and your
          claim. We may remove content and act against repeat infringers.
        </>,
      ),
    ],
  },
  {
    id: "third-party-platforms",
    title: "Third-Party Platforms",
    part: "general",
    blocks: [
      p(
        "The platform depends on content published on third-party services such as TikTok, Instagram, YouTube, X and Facebook. Those services are operated by other companies under their own terms and policies.",
      ),
      p(
        "You must comply with the rules of every platform you publish on. A campaign brief never overrides them, and we cannot authorise anything a platform forbids. If a platform's rules and a brief conflict, follow the platform's rules and tell the brand.",
      ),
      p(
        "We do not control third-party platforms and are not responsible for their availability, their decisions, the figures they report, or any action they take against your account there.",
      ),
    ],
  },
  {
    id: "payments-and-fees",
    title: "Payments and Fees",
    part: "general",
    blocks: [
      p(
        "Commercial terms — the rate paid for qualifying activity, the campaign budget, any platform fee, any minimum threshold, and the payment schedule — are those set out in the applicable campaign and in the platform interface at the time you take part. They are not fixed by this document.",
      ),
      p(
        "Payments are made through a payment or payout provider. You may need to complete that provider's own onboarding, identity and tax steps before you can be paid, and their terms will apply to that relationship.",
      ),
      p(
        "Amounts may be adjusted or withheld where activity is under review, where a submission is found not to qualify, or where a payment was made in error. We may set off amounts you owe us against amounts we owe you.",
      ),
      p(
        "Unless stated otherwise, amounts exclude taxes. Each party is responsible for its own taxes.",
      ),
      callout(
        "No fee percentage, payout schedule or payment provider is fixed in this document, because none is defined in the product yet. These must be confirmed and, where required, stated here before launch.",
      ),
    ],
  },
  {
    id: "fraud-and-verification",
    title: "Fraud, Verification and Invalid Activity",
    part: "general",
    blocks: [
      p(
        "Paying for genuine results is the point of the platform, so we review submissions and the activity reported against them.",
      ),
      p("Activity may be treated as invalid where it appears to involve, among other things:"),
      list([
        "automated, bot-generated or otherwise non-human traffic;",
        "purchased, incentivised or artificially inflated engagement;",
        "engagement patterns inconsistent with genuine audience behaviour;",
        "duplicate, recycled or re-uploaded submissions;",
        "content published from accounts that do not meet the campaign's requirements;",
        "content removed, restricted or demonetised by the platform it was published on;",
        "any attempt to manipulate reporting or the review process.",
      ]),
      p(
        "Where activity requires investigation, we may hold a submission, pause the accrual of amounts against it, withhold payment pending the outcome, reverse amounts already credited but not yet paid out, and share relevant information with the brand concerned.",
      ),
      p(
        "We will use reasonable judgement, and we will tell you the outcome of a review affecting you. Our review decisions are final unless we agree to reconsider them.",
      ),
      p(
        "We do not represent that our review will identify every instance of invalid activity, and we make no promise about the accuracy of figures reported to us by third-party platforms.",
      ),
    ],
  },
  {
    id: "advertising-disclosure",
    title: "Advertising and Sponsorship Disclosure",
    part: "general",
    blocks: [
      p(
        "Content published through the platform is commercial content. Laws and regulator guidance in most countries require that a paid, sponsored or otherwise incentivised relationship is disclosed clearly and prominently to the audience, in a way an ordinary viewer will notice and understand.",
      ),
      p(
        "You are responsible for complying with the advertising, endorsement, consumer-protection and disclosure rules that apply to you, to your audience, and to the platform you publish on. Where the publishing platform provides a paid-partnership or branded-content tool, use it in addition to — not instead of — a disclosure in the content itself.",
      ),
      p(
        "A brand must not ask a creator to omit, obscure, delay or minimise a required disclosure, and a creator must not agree to do so. A brief that appears to require this is not enforceable, and either party should report it to us.",
      ),
      p(
        "Nothing we provide is legal advice, and following a campaign brief does not discharge your own compliance obligations.",
      ),
    ],
  },
  {
    id: "suspension-and-termination",
    title: "Suspension and Termination",
    part: "general",
    blocks: [
      p(
        "You may stop using the platform and close your account at any time. Closing an account does not cancel obligations that arose before it closed.",
      ),
      p(
        "We may suspend or limit access to a feature, a campaign or an account, or terminate an account, where we reasonably believe that these Terms or a campaign brief have been breached, that activity is fraudulent or invalid, that there is a risk to the platform or to other users, or where we are required to by law.",
      ),
      p(
        "Where it is practical and lawful to do so, we will tell you why and give you an opportunity to respond. Where the issue is serious or urgent we may act first.",
      ),
      p(
        "Provisions that by their nature should survive termination — including content licences to the extent needed for records, payment obligations, disclaimers, limitation of liability, indemnities and dispute provisions — survive it.",
      ),
    ],
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    part: "general",
    blocks: [
      p(
        "The platform is provided on an \"as is\" and \"as available\" basis. To the fullest extent permitted by law, we exclude all warranties, conditions and representations that are not expressly set out in these Terms.",
      ),
      p("In particular, we do not promise that:"),
      list([
        "the platform will be uninterrupted, timely, secure or error-free;",
        "any campaign will be available to you, or that any application or submission will be approved;",
        "any particular level of earnings, reach, views, engagement or campaign performance will be achieved;",
        "figures reported by third-party platforms are accurate or complete;",
        "any brand or creator will perform its side of a campaign.",
      ]),
      p(
        "Nothing in these Terms excludes or limits liability that cannot be excluded or limited under the law that applies to you — including, where relevant, statutory consumer rights.",
      ),
    ],
  },
  {
    id: "limitation-of-liability",
    title: "Limitation of Liability",
    part: "general",
    blocks: [
      p(
        "To the fullest extent permitted by law, neither party is liable to the other for indirect, incidental, special, consequential or punitive loss, or for loss of profits, revenue, goodwill, opportunity or data, however caused.",
      ),
      p(
        "To the fullest extent permitted by law, our total aggregate liability arising out of or in connection with these Terms and your use of the platform is limited to the amounts paid to or by you through the platform in the period immediately preceding the event giving rise to the claim.",
      ),
      p(
        "These limitations apply regardless of the form of action and even if a limited remedy fails of its essential purpose. They do not apply to liability that cannot lawfully be limited.",
      ),
      callout(
        "The liability period and any monetary cap are marked for legal review and must be settled with counsel, together with any statutory limits in the jurisdictions ClipRewards operates in.",
      ),
    ],
  },
  {
    id: "indemnification",
    title: "Indemnification",
    part: "general",
    blocks: [
      p(
        "You agree to indemnify and hold harmless ClipRewards and its officers, employees and agents against claims, damages, losses and reasonable costs arising out of your breach of these Terms, your misuse of the platform, content you submit, or your infringement of another person's rights or breach of applicable law.",
      ),
      p(
        "We will notify you of any claim we seek indemnity for, allow you to participate in its defence, and not settle it in a way that imposes an obligation on you without your consent, which you will not unreasonably withhold.",
      ),
      callout(
        "The scope of this indemnity is marked for legal review, including whether it should be mutual for brand-supplied materials.",
      ),
    ],
  },
  {
    id: "changes-to-terms",
    title: "Changes to These Terms",
    part: "general",
    blocks: [
      p(
        "We may update these Terms as the platform develops or as the law requires. The date at the top of this page shows when they last changed.",
      ),
      p(
        "Where a change materially affects your rights or obligations, we will take reasonable steps to tell you before it takes effect. Continuing to use the platform after that point means you accept the updated Terms; if you do not accept them, stop using the platform and close your account.",
      ),
    ],
  },
  {
    id: "governing-law",
    title: "Governing Law and Disputes",
    part: "general",
    blocks: [
      p(
        <>
          These Terms and any dispute arising out of them are governed by{" "}
          <Ph>{GOVERNING_LAW}</Ph>, without regard to its conflict-of-laws rules.
        </>,
      ),
      p(
        <>
          The courts of <Ph>{JURISDICTION}</Ph> have jurisdiction over any dispute, and both parties
          submit to that jurisdiction.
        </>,
      ),
      p(
        "Before starting formal proceedings, please contact us so that we can try to resolve the matter directly. Most issues can be settled that way.",
      ),
      callout(
        "Governing law and venue are unresolved placeholders. Whether disputes should instead be resolved by arbitration, and whether any consumer-protection carve-out or class-action provision is required or permitted, is marked for legal review — no such provision has been drafted here.",
      ),
    ],
  },
  {
    id: "contact",
    title: "Contact",
    part: "general",
    blocks: [
      p("Questions about these Terms can be sent to:"),
      list([
        <>
          Legal enquiries: <Ph>{LEGAL_CONTACT_EMAIL}</Ph>
        </>,
        <>
          Legal entity: <Ph>{LEGAL_COMPANY_NAME}</Ph>
        </>,
        <>
          Registered address: <Ph>{REGISTERED_ADDRESS}</Ph>
        </>,
      ]),
      p(
        "Values shown in brackets are placeholders held in one place in our codebase and will be completed before these Terms are published.",
      ),
    ],
  },

  /* ------------------------------- PART B -------------------------------- */
  {
    id: "creator-accounts",
    title: "Creator Profiles and Eligibility",
    part: "creators",
    blocks: [
      p(
        "This part applies in addition to the General Terms if you use the platform as a creator.",
      ),
      p(
        "Your creator profile must describe you accurately. Do not claim audiences, results or affiliations you do not have.",
      ),
      p(
        "Campaigns may set eligibility requirements — for example the platforms you publish on, the territories you reach, the language you create in, or the state of your account history with us. Meeting the stated requirements does not by itself entitle you to join a campaign, and we and the brand may decline an application.",
      ),
      p(
        "Where you connect an account from another service, you confirm that the account is yours and that you are permitted to connect it. You can disconnect it at any time, though doing so may make you ineligible for campaigns that depend on it.",
      ),
    ],
  },
  {
    id: "creator-campaigns",
    title: "Joining and Following a Campaign",
    part: "creators",
    blocks: [
      p(
        "When you join a campaign you agree to follow its brief. If part of a brief is unclear, ask before publishing — content that does not meet the brief may be rejected.",
      ),
      p(
        "You must publish from the accounts the campaign permits, on the platforms it permits, within any window it sets.",
      ),
      p(
        "You must not take part in a campaign whose content would breach the law, the rules of the platform you publish on, or the acceptable use section of these Terms.",
      ),
    ],
  },
  {
    id: "creator-submissions",
    title: "Submissions, Review and Metrics",
    part: "creators",
    blocks: [
      p(
        "A submission must be your own original content, or content you are otherwise authorised to submit, and it must be the content actually published at the link you provide.",
      ),
      p(
        "The performance figures associated with a submission must be genuine and unaltered. You must not use bots, purchased engagement, incentivised traffic or any other artificial means to affect them, and you must not misrepresent them to us or to a brand.",
      ),
      p(
        "Submissions are reviewed and may be approved, rejected, or held for further investigation. A rejection will come with a reason where we are able to give one. Approval of one submission does not guarantee approval of another.",
      ),
      p(
        "You must not delete, hide, restrict or materially edit published content that a campaign is paying against while it remains eligible for payment, unless a platform, a law or the brand requires it.",
      ),
    ],
  },
  {
    id: "creator-payments",
    title: "Creator Payment Eligibility and Taxes",
    part: "creators",
    blocks: [
      p(
        "Payment is earned only for submissions that are approved and for activity that is verified against the campaign's terms. Joining a campaign, publishing content, or reaching any particular figure does not by itself create an entitlement to payment.",
      ),
      p(
        "To be paid you may need to complete a payout provider's onboarding, identity and tax steps. We cannot pay you until those are complete.",
      ),
      p(
        "Payment may be withheld, reduced or reversed where a submission is found not to qualify, where activity is invalid, or where an amount was credited in error.",
      ),
      p(
        "You are an independent party, not our employee, worker or agent, and nothing here creates a partnership or joint venture. You are solely responsible for your own taxes and for any registration, reporting and social contributions that apply where you live.",
      ),
    ],
  },
  {
    id: "creator-compliance",
    title: "Creator Compliance and Conduct",
    part: "creators",
    blocks: [
      list([
        "make the advertising and sponsorship disclosures described in section 11, clearly and prominently, in every piece of content that is paid or incentivised;",
        "follow the rules of every platform you publish on, including its branded-content and disclosure requirements;",
        "hold the rights to everything in your content, including music, footage and any person appearing in it;",
        "do not use another person's likeness, voice or personal data without their permission;",
        "do not make claims about a product that you have not been given a basis for, and do not make claims a brief tells you to make if you know them to be untrue;",
        "deal honestly with brands and with us.",
      ]),
      p(
        "Breaching this part may lead to a submission being rejected, payment being withheld, or your account being suspended or terminated under section 12.",
      ),
    ],
  },

  /* ------------------------------- PART C -------------------------------- */
  {
    id: "brand-accounts",
    title: "Brand Accounts and Authority",
    part: "brands",
    blocks: [
      p("This part applies in addition to the General Terms if you use the platform as a brand."),
      p(
        "By creating a brand account or publishing a campaign you confirm that you are authorised to act for the company concerned, to commit its budget, and to grant the rights described in this part.",
      ),
      p(
        "You are responsible for everyone you give access to your brand account, including agencies and other third parties acting for you, and their acts and omissions are treated as yours.",
      ),
      p(
        "We may ask you to verify your company details before enabling certain features, and may decline to enable them if verification is not completed.",
      ),
    ],
  },
  {
    id: "brand-campaigns",
    title: "Campaigns, Briefs and Budgets",
    part: "brands",
    blocks: [
      p(
        "You control your campaign: its brief, its requirements, its rate and its budget, within the options the platform makes available.",
      ),
      p(
        "A brief must be accurate, lawful and capable of being followed. It must not require content that is deceptive, that infringes someone's rights, that breaches the rules of the platform it will be published on, or that would put a creator in breach of these Terms.",
      ),
      p(
        "You must not use a brief to require a creator to omit, obscure or delay a disclosure required by section 11, to misstate their own experience of a product, or to make a claim you cannot substantiate.",
      ),
      p(
        "Adding budget to a live campaign extends it on the same terms. Reducing or closing a campaign takes effect prospectively and does not cancel amounts already earned by qualifying submissions.",
      ),
    ],
  },
  {
    id: "brand-review",
    title: "Reviewing Creator Submissions",
    part: "brands",
    blocks: [
      p(
        "You may review submissions against your brief and approve or reject them. Rejections must be based on the brief, applied consistently, and made within any review window the platform sets.",
      ),
      p(
        "You must not reject a submission that meets the brief in order to avoid paying for it, nor use the review process to obtain work without payment.",
      ),
      p(
        "You may flag a submission for investigation where you believe activity is invalid. Flagging is not a substitute for review, and repeated unfounded flagging may be treated as misuse of the platform.",
      ),
      p(
        "Where a submission or its reported activity is under investigation, amounts relating to it may be held until the review concludes.",
      ),
    ],
  },
  {
    id: "brand-content-rights",
    title: "Brand Assets and Use of Creator Content",
    part: "brands",
    blocks: [
      p(
        "You confirm that you hold the rights to every asset you supply with a campaign — including names, logos, imagery, music and product materials — and that creators following your brief may use them for that campaign.",
      ),
      p(
        "You grant ClipRewards the limited licence needed to display those assets on the platform in connection with your campaign.",
      ),
      p(
        "Creators keep ownership of the content they create. Your rights to use a creator's content are only those the campaign expressly grants, for the purposes and the period it specifies. Any wider use — for example paid amplification, use in other channels, or use after the campaign ends — needs a separate agreement with that creator.",
      ),
    ],
  },
  {
    id: "brand-payment-obligations",
    title: "Brand Payment Obligations and Disputes",
    part: "brands",
    blocks: [
      p(
        "You are responsible for funding your campaign budget and for amounts payable for approved submissions and verified activity, in accordance with the commercial terms shown in the platform at the time.",
      ),
      p(
        "If you dispute an amount, raise it with us promptly and in good faith, with the detail needed to investigate. Disputing an amount does not suspend your other obligations.",
      ),
      p(
        "We may suspend a campaign, or the publication of new campaigns, where amounts due are unpaid or where funding fails.",
      ),
    ],
  },
  {
    id: "brand-compliance",
    title: "Brand Advertising Compliance",
    part: "brands",
    blocks: [
      p(
        "You are the advertiser. You are responsible for the legality of your campaign and its claims, including under advertising, consumer-protection, product-safety, financial-promotion and sector-specific rules in every market the campaign reaches.",
      ),
      p(
        "You must be able to substantiate the claims you ask creators to make, and you must tell creators about any restriction that applies to your product or market.",
      ),
      p(
        "You must permit and support the disclosures described in section 11, and must not run campaigns for products or services you are not lawfully permitted to advertise.",
      ),
      callout(
        "Sector-specific and jurisdiction-specific advertising terms — for example for alcohol, gambling, financial services, health claims or content directed at minors — are marked for legal review and are not addressed here.",
      ),
    ],
  },
];

export default function TermsOfServicePage() {
  return (
    <>
      <Header role="creator" />
      <LegalDocument
        label="Legal"
        title="Terms of Service"
        intro="These Terms govern your access to and use of ClipRewards as a creator, a brand, or any other platform user."
        lastUpdated={formatLegalDate(LEGAL_LAST_UPDATED)}
        sections={SECTIONS}
        partLabels={PARTS}
      />
      <Footer role="creator" />
    </>
  );
}
