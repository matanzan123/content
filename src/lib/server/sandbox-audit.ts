import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { getWhopEnvironment } from "./whop-payments";

/* ==========================================================================
   SANDBOX AUDIT — pre-production migration data report.

   Reports row counts per environment for every environment-scoped table.
   Read-only. Never deletes or modifies data.
   ========================================================================== */

export type TableAuditRow = {
  table: string;
  sandbox: number;
  production: number;
};

export type SandboxAuditData = {
  currentEnvironment: string | null;
  sandboxCheckoutEnabled: boolean;
  tables: TableAuditRow[];
  staleRateLimitRows: number;
  staleRateLimitThreshold: number;
};

export async function querySandboxAudit(): Promise<SandboxAuditData | null> {
  const db = getDb();

  const currentEnvironment = getWhopEnvironment();
  const sandboxCheckoutEnabled =
    process.env.ENABLE_SANDBOX_CHECKOUT_TEST_UI === "true" &&
    process.env.WHOP_ENV === "sandbox";

  const staleThreshold = Math.floor(Date.now() / 3_600_000) - 24;

  if (!db) {
    return {
      currentEnvironment,
      sandboxCheckoutEnabled,
      tables: [],
      staleRateLimitRows: 0,
      staleRateLimitThreshold: staleThreshold,
    };
  }

  try {
    // Single round-trip for all environment-scoped table counts.
    const countRows = await db.execute(sql`
      SELECT 'whop_accounts'            AS tbl,
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int    AS sandbox,
        COUNT(*) FILTER (WHERE environment = 'production')::int AS production
      FROM whop_accounts
      UNION ALL
      SELECT 'whop_webhook_receipts',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM whop_webhook_receipts
      UNION ALL
      SELECT 'payment_orders',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM payment_orders
      UNION ALL
      SELECT 'creator_earnings',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM creator_earnings
      UNION ALL
      SELECT 'payment_refunds',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM payment_refunds
      UNION ALL
      SELECT 'payment_disputes',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM payment_disputes
      UNION ALL
      SELECT 'dispute_alerts',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM dispute_alerts
      UNION ALL
      SELECT 'resolution_center_cases',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM resolution_center_cases
      UNION ALL
      SELECT 'accounting_transactions',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM accounting_transactions
      UNION ALL
      SELECT 'creator_transfers',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM creator_transfers
      UNION ALL
      SELECT 'creator_withdrawals',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM creator_withdrawals
      UNION ALL
      SELECT 'google_calendar_connections',
        COUNT(*) FILTER (WHERE environment = 'sandbox')::int,
        COUNT(*) FILTER (WHERE environment = 'production')::int
      FROM google_calendar_connections
    `);

    const tables: TableAuditRow[] = (countRows as unknown as { tbl: string; sandbox: number; production: number }[]).map(
      (r) => ({
        table: r.tbl,
        sandbox: Number(r.sandbox),
        production: Number(r.production),
      }),
    );

    const [staleRow] = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM rate_limit_counters WHERE CAST(window_key AS BIGINT) < ${staleThreshold}`,
    );

    return {
      currentEnvironment,
      sandboxCheckoutEnabled,
      tables,
      staleRateLimitRows: Number((staleRow as { n: number } | undefined)?.n ?? 0),
      staleRateLimitThreshold: staleThreshold,
    };
  } catch {
    return null;
  }
}
