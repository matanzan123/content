import "server-only";

import { getAdminAuth, getAdminFirestore, isAdminSdkConfigured } from "@/lib/server/firebase-admin";

export type UserRecord = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  creationTime: string | null;
  lastSignInTime: string | null;
  role: "creator" | "brand" | "unknown";
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
    let admins = 0;

    let nextPageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, nextPageToken);
      totalUsers += page.users.length;
      for (const u of page.users) {
        if (u.customClaims?.admin === true) admins++;
        if (u.customClaims?.role === "brand") brands++;
        else creators++;
      }
      nextPageToken = page.pageToken;
    } while (nextPageToken);

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

    return { totalUsers, creators, brands, admins, totalCampaigns, activeCampaigns, totalRevenue };
  });
}

export async function getUsers(): Promise<Outcome<UserRecord[]>> {
  return attempt(async () => {
    const auth = getAdminAuth()!;
    const users: UserRecord[] = [];

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
          role: u.customClaims?.role === "brand" ? "brand" : "creator",
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
