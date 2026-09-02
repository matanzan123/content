import "server-only";

import { isDatabaseConfigured } from "@/lib/db";
import { FINANCIAL_DEFINITIONS } from "./ledger";

/**
 * Whether money can be reported at all.
 *
 * The ledger table exists, but a table with no trusted writer is not a source.
 * Reporting `$0` from it would say the business earned nothing, when the truth
 * is that no payment provider is connected. `source_available: false` is the
 * only honest answer until one is.
 */
export function getLedgerAvailability() {
  return {
    source_available: false,
    table_exists: isDatabaseConfigured(),
    blocked_by: [
      "No payment provider is integrated, so no webhook can write a transaction.",
      "No campaign settlement process exists to record platform fees.",
    ],
    definitions: FINANCIAL_DEFINITIONS,
  } as const;
}
