import { cookies } from "next/headers";
import { WHOP_SESSION_COOKIE } from "@/lib/whop";

export async function GET() {
  const raw = (await cookies()).get(WHOP_SESSION_COOKIE)?.value;
  if (!raw) return Response.json({ connected: false });
  try {
    const { username } = JSON.parse(raw) as { username?: string };
    return Response.json({ connected: Boolean(username), username });
  } catch {
    return Response.json({ connected: false });
  }
}
