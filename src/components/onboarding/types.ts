export const LANGUAGES = [
  { label: "English", flag: "🇺🇸" },
  { label: "Spanish", flag: "🇪🇸" },
  { label: "Portuguese", flag: "🇧🇷" },
  { label: "French", flag: "🇫🇷" },
  { label: "German", flag: "🇩🇪" },
  { label: "Italian", flag: "🇮🇹" },
  { label: "Japanese", flag: "🇯🇵" },
  { label: "Korean", flag: "🇰🇷" },
  { label: "Hindi", flag: "🇮🇳" },
  { label: "Chinese", flag: "🇨🇳" },
  { label: "Russian", flag: "🇷🇺" },
  { label: "Arabic", flag: "🇸🇦" },
  /* Hebrew. ClipRewards ships a full Hebrew UI, yet a creator who publishes in
     Hebrew could not say so — the option was simply missing from this list.
     The locale code is "he"; "iw" is the deprecated ISO-639 form and is not
     used anywhere in this codebase. */
  { label: "Hebrew", flag: "🇮🇱" },
] as const;

export const MAX_LANGUAGES = 5;
export const MAX_BIO = 60;

export const CREATOR_TYPES = [
  "Just getting started",
  "Clipper",
  "UGC Faceless",
  "UGC Face",
] as const;

export const REFERRAL_SOURCES = [
  "TikTok",
  "YouTube",
  "Twitter/X",
  "AI",
  "Word of mouth",
  "Other",
] as const;

export const SOCIAL_PLATFORMS = [
  "YouTube",
  "TikTok",
  "Instagram",
  "X",
  "Facebook",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type OnboardingDraft = {
  step: number;
  fullName: string;
  bio: string;
  photoURL: string | null;
  languages: string[];
  creatorType: string;
  referral: string;
  socials: SocialPlatform[];
};

export const STEP_COUNT = 5;

export function emptyDraft(): OnboardingDraft {
  return {
    step: 0,
    fullName: "",
    bio: "",
    photoURL: null,
    languages: [],
    creatorType: "",
    referral: "",
    socials: [],
  };
}

/** Whop-style handle derived from the Google account until Whop is linked. */
export function handleFromEmail(email: string | null | undefined) {
  if (!email) return "creator";
  return email.split("@")[0].replace(/[^a-z0-9_.]/gi, "").toLowerCase() || "creator";
}
