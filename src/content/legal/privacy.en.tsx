import { Ph, callout, h3, list, p, type Section } from "@/components/legal/content";
import {
  LEGAL_COMPANY_NAME,
  MINIMUM_AGE,
  PRIVACY_EMAIL,
  REGISTERED_ADDRESS,
} from "@/lib/legal-config";


/* ==========================================================================
   PRIVACY POLICY — original draft, written against the product as it exists in
   this codebase today. Nothing here describes a capability the build does not
   have. Specifically, at the time of writing:

     - sign-in is Google via Firebase Authentication (uid, name, email, photo);
     - the onboarding draft is held in the visitor's own browser localStorage,
       keyed by Firebase uid — it is not transmitted to a ClipRewards server;
     - the "connect" toggles on the social step only mark a platform on the
       draft. No social OAuth runs and no social data is read;
     - Whop OAuth (scopes: openid profile email) stores ONLY the returned
       username in an httpOnly cookie; the access token is never persisted;
     - the contact form is validated client-side and not sent anywhere;
     - there is no analytics SDK, no advertising SDK and no payment processor
       integrated in this build.

   If any of those change, this document has to change with them.

   LEGAL REVIEW REQUIRED before production launch — see src/lib/legal-config.ts.
   ========================================================================== */

export function privacySectionsEn(): Section[] {
  return [
    {
      id: "introduction",
      title: "Introduction",
      blocks: [
        p(
          <>
            This Privacy Policy explains how <Ph>{LEGAL_COMPANY_NAME}</Ph> (&ldquo;ClipRewards&rdquo;,
            &ldquo;we&rdquo;, &ldquo;us&rdquo;) handles information when you visit our website or use
            the ClipRewards platform, whether you come to us as a creator, as a brand, or simply as a
            visitor.
          </>,
        ),
        p(
          "We have written it to describe what the platform actually does. Where a practice depends on a service we have not yet switched on, we say so rather than describing something that is not happening.",
        ),
        p(
          "If you do not agree with this policy, please do not use the platform. Using the platform is not a substitute for any consent that applicable law separately requires from us.",
        ),
      ],
    },
    {
      id: "information-we-collect",
      title: "Information We Collect",
      blocks: [
        p(
          "We collect information in three ways: information you give us, information created as you use the platform, and information your device sends automatically.",
        ),
  
        h3("Account information"),
        p(
          "Signing in uses Google as an identity provider through Firebase Authentication. When you sign in we receive a unique account identifier and the basic profile Google returns for you — typically your name, your email address, and your profile picture URL. We do not receive or store your Google password.",
        ),
  
        h3("Profile and creator information"),
        p(
          "During creator onboarding you may provide a display name, a short bio, the languages you create in, the type of creator you consider yourself, and how you heard about us. Your platform username is derived from your sign-in email rather than entered separately.",
        ),
        callout(
          "In the current build, this onboarding draft is stored locally in your own browser so you can leave and come back without losing your progress. It is not uploaded to a ClipRewards server. If a future release saves profiles server-side, this policy will be updated before that change ships.",
        ),
  
        h3("Brand and company information"),
        p(
          "If you contact us as a brand, you may provide your name, a company email address, a company website, the objective you are trying to achieve, and an indicative budget range. You may also tell us whether you would like to work with a verified agency.",
        ),
  
        h3("Connected accounts"),
        p(
          "You can indicate which social platforms you publish on, and you can link a Whop account. Linking Whop uses that provider's standard authorisation flow; we receive your Whop username and store only that username in a secure cookie so the platform can show that the link exists. Marking a social platform on your profile records your selection only — it does not, in this build, read anything from that platform.",
        ),
  
        h3("Campaign activity and submissions"),
        p(
          "Where you take part in campaigns, we handle the information needed to run them: which campaigns you joined, the content you submit, links to published posts, the performance figures reported for those posts, and the review status of each submission.",
        ),
  
        h3("Communications"),
        p(
          "If you write to us, we keep your message and our reply so that we can deal with the matter and keep a record of it.",
        ),
  
        h3("Technical and usage information"),
        p(
          "Like most websites, our hosting and infrastructure providers process technical information sent by your browser as part of delivering pages to you — for example IP address, browser and device type, and the pages requested. We use this for security, abuse prevention and reliability.",
        ),
        h3("Product analytics"),
        p(
          "We run our own first-party product analytics. When you use the platform we record the pages you view and a small set of interactions — for example switching language, switching between the creator and brand views, using a filter, running a search, and clicking a primary call to action.",
        ),
        p("Each of those records may contain:"),
        list([
          "the event type and the page path it happened on;",
          "a session identifier that lasts until you close the browser tab;",
          "a randomly generated visitor identifier stored on your device, used only to tell a returning browser from a new one;",
          "the language you are reading in;",
          "a country, where our hosting provider supplies one;",
          "a broad device category and browser family;",
          "the host name of the site that referred you, if any;",
          "campaign attribution parameters (utm_source and similar) present in the link you arrived through.",
        ]),
        callout(
          "What analytics does not record: your IP address, your full browser user-agent string, the full address of the page that referred you, anything you type into a form, and the text of anything you search for. Searches are recorded only as a length band and a result count, so we can tell whether search is working without keeping what anyone looked for.",
        ),
        p(
          "This is our own system. We do not use Google Analytics, and there is no advertising, social or cross-site tracking pixel on this site — no Meta Pixel, no TikTok pixel, and no equivalent. If that ever changes we will name what we have added and update this policy before it is switched on.",
        ),
      ],
    },
    {
      id: "how-we-use-information",
      title: "How We Use Information",
      blocks: [
        p("We use information for the following purposes:"),
        list([
          "creating and maintaining your account, and keeping you signed in;",
          "operating the creator and brand experiences, including the parts of the product that differ between them;",
          "letting creators find and join campaigns, and letting brands publish and manage them;",
          "reviewing and verifying submissions, and determining whether reported activity is genuine;",
          "detecting, investigating and preventing fraud, artificial engagement and other abuse;",
          "protecting the security and integrity of the platform and of the people using it;",
          "responding to your questions and providing support;",
          "understanding, in aggregate, how the platform is used so that we can improve it;",
          "sending service messages about your account, a campaign, or a change to our terms;",
          "meeting our legal, regulatory, tax and accounting obligations, and establishing, exercising or defending legal claims.",
        ]),
        p(
          "Where applicable law requires a specific legal basis for processing, we will identify it in a jurisdiction-specific supplement to this policy.",
        ),
      ],
    },
    {
      id: "social-platform-connections",
      title: "Social Platform Connections",
      blocks: [
        p(
          "ClipRewards is built around content that is published on third-party social platforms. You may tell us which platforms you publish on, and future releases may allow you to authorise a connection to those platforms.",
        ),
        p(
          "Where you authorise a connection, we will only request the access needed for the feature you are using, and we will describe that access at the point where you grant it. We do not obtain access to your social accounts simply because you named a platform on your profile.",
        ),
        p(
          "Anything you do on a third-party platform remains governed by that platform's own terms and privacy policy. We do not control those platforms, and connecting or disconnecting an account with us does not change your relationship with them.",
        ),
      ],
    },
    {
      id: "payments",
      title: "Payments",
      blocks: [
        p(
          "ClipRewards is designed so that creators are paid for verified activity and brands are billed against campaign budgets.",
        ),
        p(
          "Where money moves, it is handled through a payment or payout provider rather than by us directly, and that provider processes the details needed to make a payment — which typically include identity and payout account information. Those details are handled under that provider's own privacy policy.",
        ),
        callout(
          "In this build, the only payment-adjacent integration is the optional Whop account link described above, and no funds are processed through the platform. We will name every payment or payout provider in this policy before any live payment functionality is enabled.",
        ),
      ],
    },
    {
      id: "how-information-is-shared",
      title: "How Information May Be Shared",
      blocks: [
        p("We share information only in the circumstances set out below."),
        list([
          <>
            <strong className="font-semibold text-ink">Service providers.</strong> Companies that
            provide infrastructure, authentication, hosting, communications, payment or security
            services to us, acting on our instructions and under contract.
          </>,
          <>
            <strong className="font-semibold text-ink">Campaign counterparties.</strong> Where a
            creator takes part in a brand&apos;s campaign, the information reasonably needed to run and
            review that campaign is visible to the brand — for example the creator&apos;s profile,
            submitted content and reported performance figures.
          </>,
          <>
            <strong className="font-semibold text-ink">Legal and regulatory.</strong> Where we are
            required to by law, or where disclosure is reasonably necessary to comply with legal
            process, enforce our terms, or protect rights, property or safety.
          </>,
          <>
            <strong className="font-semibold text-ink">Fraud and security.</strong> With providers who
            help us detect and prevent fraud, artificial engagement and abuse of the platform.
          </>,
          <>
            <strong className="font-semibold text-ink">Business transfers.</strong> In connection with
            a merger, acquisition, financing or sale of assets, subject to the acquirer continuing to
            treat the information in line with this policy.
          </>,
          <>
            <strong className="font-semibold text-ink">At your direction.</strong> Where you ask us to
            share information, or make it public yourself.
          </>,
        ]),
        p(
          "We do not share information for third-party advertising, and we do not disclose personal information to third parties in exchange for money.",
        ),
        callout(
          "Some privacy laws define terms such as “sale” and “sharing” more broadly than everyday usage. The statement above describes our current practice; the wording required by any specific statute will be confirmed in a jurisdiction-specific supplement.",
        ),
      ],
    },
    {
      id: "data-retention",
      title: "Data Retention",
      blocks: [
        p(
          "We keep information for as long as it is reasonably needed for the purpose it was collected for — running your account and the campaigns you take part in, supporting you, keeping the platform secure, and meeting our legal, tax and accounting obligations.",
        ),
        p(
          "Where information relates to a payment, a dispute, an investigation or a legal claim, we may keep it until that matter is resolved and for as long afterwards as the relevant limitation period requires.",
        ),
        p(
          "Information stored only in your own browser, such as an unfinished onboarding draft, remains under your control and is removed when you clear your browser storage.",
        ),
        callout(
          "We have deliberately not published fixed retention periods. They will be set out here once our retention schedule has been reviewed.",
        ),
      ],
    },
    {
      id: "data-security",
      title: "Data Security",
      blocks: [
        p(
          "We take reasonable technical and organisational measures to protect information against loss, misuse and unauthorised access — for example serving the platform over encrypted connections, using an established identity provider for sign-in rather than storing passwords ourselves, and storing session identifiers in cookies that scripts running in your browser cannot read.",
        ),
        p(
          "No website, product or method of transmission is completely secure, and we cannot guarantee absolute security. Keeping your sign-in credentials and your device secure is your responsibility, and you should tell us promptly if you believe your account has been compromised.",
        ),
      ],
    },
    {
      id: "international-users",
      title: "International Users and Transfers",
      blocks: [
        p(
          "The platform and the providers we rely on may process information in countries other than the one you are in, and data protection law in those countries may differ from your own.",
        ),
        p(
          "Where a transfer mechanism or safeguard is legally required for such a transfer, we will put an appropriate one in place and describe it in a jurisdiction-specific supplement to this policy.",
        ),
        callout(
          "Country- and region-specific obligations — including any that apply to residents of the European Economic Area, the United Kingdom, Switzerland, Brazil, or individual US states — are marked for legal review and will be added before launch.",
        ),
      ],
    },
    {
      id: "privacy-rights",
      title: "Your Privacy Rights",
      blocks: [
        p(
          "Depending on where you live, you may have some or all of the following rights in relation to information about you:",
        ),
        list([
          "to ask what information we hold and obtain a copy of it;",
          "to have inaccurate information corrected;",
          "to ask us to delete information, subject to what we are required or permitted to keep;",
          "to object to, or ask us to restrict, certain processing;",
          "to receive certain information in a portable format, or have it sent to another provider;",
          "to withdraw a consent you previously gave, without affecting processing that already took place;",
          "to complain to your local data protection authority.",
        ]),
        p(
          "Not every right applies to every person in every country, and some are subject to conditions and exceptions. We will tell you which apply to your request when you make one.",
        ),
        p(
          <>
            To exercise a right, write to <Ph>{PRIVACY_EMAIL}</Ph>. We may need to verify your identity
            before we act, and we will respond within the time the applicable law allows.
          </>,
        ),
      ],
    },
    {
      id: "cookies",
      title: "Cookies and Similar Technologies",
      blocks: [
        p("The platform uses a small number of storage technologies, all of them functional:"),
        list([
          "a secure, http-only session cookie that records that you have linked a third-party account, so the platform can show the connection on your profile;",
          "a short-lived cookie used during that linking flow to protect it against cross-site request forgery;",
          "your browser's local storage, used to hold an unfinished onboarding draft on your own device, and to hold the randomly generated analytics visitor identifier described above;",
          "your browser's session storage, used to hold the analytics session identifier until you close the tab.",
        ]),
        p(
          "These are functional and analytics storage only. This build sets no advertising, profiling or cross-site tracking cookie, and none of these values is shared with a third party.",
        ),
        callout(
          "Whether analytics storage requires opt-in consent depends on the jurisdictions ClipRewards ends up operating in. That question is marked for legal review and is not resolved here; no consent mechanism is claimed to exist in this build.",
        ),
      ],
    },
    {
      id: "third-party-services",
      title: "Third-Party Services and Links",
      blocks: [
        p(
          "The platform relies on third-party services to function, including an authentication provider for sign-in and an account-linking provider, and it loads some imagery from third-party hosts. Those providers receive the information needed to deliver their service and handle it under their own privacy policies.",
        ),
        p(
          "The platform also links to third-party websites and social platforms. We do not control those destinations and are not responsible for their content or their privacy practices. We would encourage you to read the policy of any site you visit from ours.",
        ),
      ],
    },
    {
      id: "childrens-privacy",
      title: "Children's Privacy",
      blocks: [
        p(
          <>
            The platform is intended for people aged <Ph>{MINIMUM_AGE}</Ph> or over. It is not directed
            at children, and we do not knowingly collect information from anyone below that age.
          </>,
        ),
        p(
          <>
            If you believe a child has provided information to us, please contact{" "}
            <Ph>{PRIVACY_EMAIL}</Ph> and we will take appropriate steps to delete it.
          </>,
        ),
        callout(
          "The minimum age has not been set in the product yet. It must be fixed — and checked against the age thresholds in every market we operate in — before launch.",
        ),
      ],
    },
    {
      id: "changes",
      title: "Changes to This Privacy Policy",
      blocks: [
        p(
          "We may update this policy as the platform develops or as the law requires. When we do, we will change the date shown at the top of this page.",
        ),
        p(
          "If a change materially affects how we handle information about you, we will take reasonable steps to tell you before it takes effect — for example by a notice in the product or a message to your registered email address.",
        ),
      ],
    },
    {
      id: "contact",
      title: "Contact Us",
      blocks: [
        p("For any question about this policy, or about how we handle information, contact us at:"),
        list([
          <>
            Privacy enquiries: <Ph>{PRIVACY_EMAIL}</Ph>
          </>,
          <>
            Legal entity: <Ph>{LEGAL_COMPANY_NAME}</Ph>
          </>,
          <>
            Registered address: <Ph>{REGISTERED_ADDRESS}</Ph>
          </>,
        ]),
        p(
          "Values shown in brackets above are placeholders held in one place in our codebase and will be completed before this policy is published.",
        ),
      ],
    },
  ];
}
