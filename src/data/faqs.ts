import type { Role } from "@/components/RoleToggle";

export type FAQCategory = {
  id: string;
  title: string;
  items: { q: string; a: string }[];
};

/**
 * Full help-centre content. Topics mirror the questions creators and brands
 * actually ask on a clipping marketplace; the wording is our own, in the same
 * placeholder voice as the rest of this build.
 */
export const FAQ_CATEGORIES: Record<Role, FAQCategory[]> = {
  creator: [
    {
      id: "earnings",
      title: "Earnings & Payouts",
      items: [
        {
          q: "Does the platform take a cut of my earnings?",
          a: "Yes — a flat platform fee is deducted from each creator payout. It's shown on every campaign card before you join, so the rate you see is the rate you're paid on.",
        },
        {
          q: "How often do I get paid?",
          a: "Payouts run on a weekly cycle. Each approved submission enters a short verification window, and once that window closes the earnings are released on the next run.",
        },
        {
          q: "Where does the money actually land?",
          a: "Into the balance of the payout account you linked during onboarding. Once it's there you withdraw on your own schedule — we don't hold it for you.",
        },
        {
          q: "My payout hasn't arrived. What now?",
          a: "Two things usually explain it: your balance is still under the minimum withdrawal threshold, or the verification window on your most recent submissions hasn't closed yet. Your dashboard shows which one applies.",
        },
        {
          q: "Do I still get paid after a campaign ends?",
          a: "Yes. Views that accrued while the campaign was live are still counted and paid out, even if the campaign closes before the payout run.",
        },
        {
          q: "Is there a maximum I can earn per video?",
          a: "Most campaigns set a per-video cap so one viral clip can't drain the whole budget. The cap is listed in the campaign brief.",
        },
        {
          q: "Is there a minimum before a clip earns anything?",
          a: "Some campaigns set a view floor a clip has to clear before it qualifies. Anything below it isn't paid, so check the brief before you post.",
        },
      ],
    },
    {
      id: "accounts",
      title: "Account Linking & Requirements",
      items: [
        {
          q: "How do I link a social account?",
          a: "Open your profile, go to Linked Accounts, and add the account you plan to post from. You can do this before or after joining a campaign, but a submission won't verify until the account is linked.",
        },
        {
          q: "Why do you need my accounts linked at all?",
          a: "It's how we confirm a submitted video is genuinely yours and read its view count. Without the link there's no way to verify a clip, so there's nothing to pay against.",
        },
        {
          q: "Can I submit from more than one account?",
          a: "Yes. Link each account separately and you can submit from all of them, including across different platforms.",
        },
        {
          q: "Can I post from a private account?",
          a: "No. Views on private accounts can't be independently verified, so submissions from them aren't accepted.",
        },
      ],
    },
    {
      id: "campaigns",
      title: "Campaign Participation",
      items: [
        {
          q: "How does a campaign work, start to finish?",
          a: "Join the campaign, read its rules, post your clip to a linked account, submit the link, and wait for review. Approved clips accrue verified views and are paid on the next cycle.",
        },
        {
          q: "Who can join?",
          a: "Anyone. There's no follower requirement and no prior experience needed — plenty of campaigns are aimed squarely at new creators.",
        },
        {
          q: "Does my follower count change what I earn?",
          a: "No. Payouts are calculated from verified views on the clip itself, not from the size of the account that posted it.",
        },
        {
          q: "Are some campaigns restricted by country?",
          a: "Some are. Any geographic limits are stated in the campaign brief before you join.",
        },
        {
          q: "Where do I find campaigns to join?",
          a: "On the Discover page, which lists everything currently open along with its rate, budget, and rules.",
        },
        {
          q: "What does CPM mean here?",
          a: "It's what you earn per one thousand verified views. A campaign paying a $2 CPM pays $2 for every 1,000 views a clip is credited with.",
        },
      ],
    },
    {
      id: "submissions",
      title: "Video Submission Rules",
      items: [
        {
          q: "How do I submit a video?",
          a: "Join the campaign, make sure the posting account is linked, then use Submit Video and paste the link to your post.",
        },
        {
          q: "Is there a limit on how many clips I can submit?",
          a: "No cap on quantity — submit as many as you like, as long as each one follows the campaign's rules.",
        },
        {
          q: "Can I submit a video I posted before joining?",
          a: "No. Only clips posted after you joined the campaign are eligible.",
        },
        {
          q: "Can the same video go to two campaigns?",
          a: "No — each video can be submitted once. Post a separate clip for each campaign you want to enter.",
        },
        {
          q: "I submitted the wrong link. Can I fix it?",
          a: "Yes. Submit the correct link as a new entry; the incorrect one is dismissed at review and won't count against you.",
        },
      ],
    },
    {
      id: "review",
      title: "Review Process & Status",
      items: [
        {
          q: "Why was my submission rejected?",
          a: "Almost always one of three reasons: it broke a rule in the campaign brief, the view activity looked automated, or the content wasn't appropriate for the brand. The reason appears in your dashboard.",
        },
        {
          q: "What does a flagged video mean?",
          a: "Something in the view pattern looked unusual, so the clip was routed to a person instead of being approved automatically. Flagged isn't rejected — it just takes longer.",
        },
        {
          q: "My clip says 'Submitted'. Is something wrong?",
          a: "No — that's the normal waiting state. It means the campaign owner has it in their queue and hasn't reviewed it yet.",
        },
        {
          q: "How long does review take?",
          a: "Most submissions are reviewed within a few days. Flagged ones take longer because a person looks at them individually.",
        },
      ],
    },
    {
      id: "platforms",
      title: "Posting Platforms",
      items: [
        {
          q: "Which platforms can I post on?",
          a: "It depends on the campaign — each brief lists the platforms it accepts, typically some combination of TikTok, Instagram, YouTube, and X.",
        },
        {
          q: "Can I cross-post the same clip to several platforms?",
          a: "Only if the campaign allows it, and each post counts as its own submission from its own linked account.",
        },
      ],
    },
  ],

  brand: [
    {
      id: "launching",
      title: "Launching a Campaign",
      items: [
        {
          q: "How quickly can a campaign go live?",
          a: "Usually within minutes. Once your brief and budget are submitted, the campaign appears on Discover and creators can start joining immediately.",
        },
        {
          q: "What belongs in the brief?",
          a: "The assets creators can use, what they may and may not say, which platforms you accept, and any geographic limits. The tighter the brief, the less you reject later.",
        },
        {
          q: "Can I set my own rate?",
          a: "Yes. You choose the total budget and the rate per thousand verified views, and you can set a per-video cap so a single clip can't consume the budget.",
        },
        {
          q: "Can I target specific countries?",
          a: "Yes — geographic restrictions are set on the campaign and shown to creators before they join.",
        },
      ],
    },
    {
      id: "billing",
      title: "Budget & Billing",
      items: [
        {
          q: "What am I actually paying for?",
          a: "Verified views on submissions you approved. Rejected and flagged clips are never billed against your budget.",
        },
        {
          q: "Can I add budget to a live campaign?",
          a: "Yes, top up at any time without creating a new campaign. Creators keep submitting against the same brief.",
        },
        {
          q: "What happens to budget I don't spend?",
          a: "It stays yours. Close the campaign and the unspent balance is released back rather than being consumed.",
        },
        {
          q: "Are there fees on top of my budget?",
          a: "The platform fee is taken from the creator payout side, so the budget you set is the budget that goes to distribution.",
        },
      ],
    },
    {
      id: "creators",
      title: "Creators & Quality",
      items: [
        {
          q: "How do I know creators are legitimate?",
          a: "Every creator carries a trust score built from their verified submission history, and consistent performers earn a verified badge.",
        },
        {
          q: "Can I limit who joins my campaign?",
          a: "Yes — you can gate a campaign by trust score, verification status, or region, depending on how selective you want to be.",
        },
        {
          q: "Do creators need a big following?",
          a: "No, and that's deliberate. You pay on verified views, so a small account that produces a clip that travels is worth exactly what it delivers.",
        },
      ],
    },
    {
      id: "reviewing",
      title: "Reviewing Submissions",
      items: [
        {
          q: "How do I review what creators submit?",
          a: "Everything lands in your dashboard queue with the clip, the account it was posted from, and its current view count. You approve or reject from there.",
        },
        {
          q: "What happens to a suspicious submission?",
          a: "It's held automatically for manual review before any payout is issued, so inflated view activity never reaches your budget.",
        },
        {
          q: "Is there a deadline to review?",
          a: "Submissions left unreviewed past the campaign's review window are handled by the default you set on the campaign — approve or reject — so creators aren't left waiting indefinitely.",
        },
      ],
    },
    {
      id: "agencies",
      title: "Agencies & Teams",
      items: [
        {
          q: "Can an agency run campaigns for us?",
          a: "Yes. Verified agencies manage multiple brand campaigns from one account, and you keep visibility into everything they run on your behalf.",
        },
        {
          q: "Can several people from my team have access?",
          a: "Yes — a brand account supports multiple seats so briefing, review, and billing don't have to sit with one person.",
        },
      ],
    },
  ],
};
