/**
 * Campaigns published to the platform.
 *
 * This is the Discover feed's only source. It is intentionally EMPTY: nothing
 * has been launched on the platform yet, so `/discover` renders its empty
 * states. Push `Campaign` objects in here (or swap `getCampaigns` for a real
 * fetch) and the page fills itself — the hero carousel, the filters, and the
 * grid all derive from this array.
 */

export const PLATFORMS = ["YouTube", "TikTok", "Instagram", "X", "Facebook"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CATEGORIES = [
  "Gaming",
  "Music",
  "Entertainment",
  "Sports",
  "Tech",
  "Fashion",
  "Finance",
  "Education",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["Live", "Ending soon", "Closed"] as const;
export type Status = (typeof STATUSES)[number];

export const CONTENT_TYPES = ["Clipping", "UGC Face", "UGC Faceless", "Reposting"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export type Campaign = {
  /** URL-safe id, used for the campaign route. */
  id: string;
  title: string;
  /** The brand or agency running it. */
  owner: string;
  ownerVerified: boolean;
  category: Category;
  contentType: ContentType;
  status: Status;
  platforms: Platform[];
  /** Cover artwork. Remote hosts must be allowed in next.config images. */
  image: string;
  /** Payout per 1,000 verified views, in whole currency units. */
  cpm: number;
  /** Total campaign budget. */
  budget: number;
  /** Budget already paid out. */
  paidOut: number;
  /** Relative label such as "3d" — kept as a string so the feed stays static. */
  posted: string;
  /** Surfaced in the hero carousel at the top of Discover. */
  featured?: boolean;
};

export const CAMPAIGNS: Campaign[] = [];

export function getCampaigns(): Campaign[] {
  return CAMPAIGNS;
}
