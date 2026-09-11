import "server-only";

import { getAdminAuth, getAdminFirestore, isAdminSdkConfigured } from "@/lib/server/firebase-admin";
import { getUserCounts, listApplicants } from "@/lib/server/users";

export type UserRecord = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  creationTime: string | null;
  lastSignInTime: string | null;
  /** From Postgres. `null` means the user has not chosen yet. */
  role: "creator" | "brand" | null;
  isAdmin: boolean;
};

export type CampaignRecord = {
  id: string;
  title: string;
  brandName: string;
  budget: number;
  paidOut: number;
  status: string;
  createdAt: string;
  platforms: string[];
};

export type DashboardStats = {
  totalUsers: number;
  creators: number;
  brands: number;
  /** Signed in but has never chosen a role. A real state, not a rounding error. */
  unassigned: number;
  admins: number;
  totalCampaigns: number;
  activeCampaigns: number;
  totalRevenue: number;
};

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; reason: "unconfigured" | "error" };
export type Outcome<T> = Ok<T> | Err;

async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  if (!isAdminSdkConfigured()) return { ok: false, reason: "unconfigured" };
  try {
    return { ok: true, data: await fn() };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function getStats(): Promise<Outcome<DashboardStats>> {
  return attempt(async () => {
    const auth = getAdminAuth()!;
    const db = getAdminFirestore();

    let totalUsers = 0;
    let creators = 0;
    let brands = 0;
    let unassigned = 0;
    let admins = 0;

    let nextPageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, nextPageToken);
      totalUsers += page.users.length;
      for (const u of page.users) {
        if (u.customClaims?.admin === true) admins++;
      }
      nextPageToken = page.pageToken;
    } while (nextPageToken);

    // ROLES COME FROM POSTGRES, NOT FROM A FIREBASE CLAIM.
    //
    // This previously counted `role === "brand"` as a brand and EVERYONE ELSE
    // as a creator — so every user without a claim, including every user who
    // had never chosen at all, was reported as a creator. Nothing writes that
    // claim, so the figure was fiction.
    //
    // `users.role` is the canonical store and is nullable on purpose:
    // "unassigned" is a real state the dashboard must be able to show.
    const counts = await getUserCounts();
    creators = counts.creators;
    brands = counts.brands;
    unassigned = counts.unassigned;

    let totalCampaigns = 0;
    let activeCampaigns = 0;
    let totalRevenue = 0;

    if (db) {
      try {
        const campaignsSnap = await db.collection("campaigns").get();
        totalCampaigns = campaignsSnap.size;
        for (const doc of campaignsSnap.docs) {
          const data = doc.data();
          if (data.status === "active") activeCampaigns++;
          totalRevenue += data.platformFee ?? 0;
        }
      } catch {
        // Firestore collection may not exist yet — that's fine
      }
    }

    return { totalUsers, creators, brands, unassigned, admins, totalCampaigns, activeCampaigns, totalRevenue };
  });
}

export async function getUsers(): Promise<Outcome<UserRecord[]>> {
  return attempt(async () => {
    const auth = getAdminAuth()!;
    const users: UserRecord[] = [];

    // THE ROLE COMES FROM POSTGRES. This previously read
    // `customClaims?.role === "brand" ? "brand" : "creator"`, which labelled
    // every user without that claim — including everyone who had never chosen
    // — as a creator. Nothing writes that claim, so the column was fiction.
    // `users.role` is the canonical store and is null until a choice is made.
    const applicants = await listApplicants(1000);
    const roleByUid = new Map(applicants.map((a) => [a.firebaseUid, a.role]));

    let nextPageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, nextPageToken);
      for (const u of page.users) {
        users.push({
          uid: u.uid,
          email: u.email ?? null,
          displayName: u.displayName ?? null,
          photoURL: u.photoURL ?? null,
          creationTime: u.metadata.creationTime ?? null,
          lastSignInTime: u.metadata.lastSignInTime ?? null,
          // `null` when unknown — never a guess, and never a default.
          role: roleByUid.get(u.uid) ?? null,
          isAdmin: u.customClaims?.admin === true,
        });
      }
      nextPageToken = page.pageToken;
    } while (nextPageToken);

    users.sort((a, b) => {
      const da = a.creationTime ? new Date(a.creationTime).getTime() : 0;
      const db = b.creationTime ? new Date(b.creationTime).getTime() : 0;
      return db - da;
    });

    return users;
  });
}

export async function getCampaigns(): Promise<Outcome<CampaignRecord[]>> {
  return attempt(async () => {
    const db = getAdminFirestore();
    if (!db) return [];

    try {
      const snap = await db.collection("campaigns").orderBy("createdAt", "desc").get();
      return snap.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          title: d.title ?? "Untitled",
          brandName: d.brandName ?? "Unknown",
          budget: d.budget ?? 0,
          paidOut: d.paidOut ?? 0,
          status: d.status ?? "draft",
          createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? "",
          platforms: d.platforms ?? [],
        };
      });
    } catch {
      return [];
    }
  });
}
