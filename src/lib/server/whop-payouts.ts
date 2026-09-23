import "server-only";

import { WhopError, type Whop } from "@whop/sdk";
import { getWhopPaymentsClient } from "./whop-payments";
import { minorToProviderAmount, providerAmountToMinor } from "./whop-transfers";

/* ==========================================================================
   THE PAYOUT PROVIDER BOUNDARY — server only.

   A PAYOUT IS NOT A TRANSFER, and this module exists because the two were
   conflated.

   `transfers.create` moves money between two Whop balances. That is Task #13:
   the ClipRewards platform balance to the creator's connected Whop balance.
   The money never leaves Whop, so no bank destination and no payout readiness
   are involved.

   `payouts.create` moves money from ONE account's balance to ITS OWN external
   destination — a bank account, a wallet. That is a withdrawal, and it is a
   different resource in every way that matters:

     - ids are `wdrl_`, not transfer ids, in a separate namespace
     - it REQUIRES a saved `potk_` payout method, so readiness is mandatory
     - it has EIGHT statuses, not three
     - it models `completed` → `reversed`, which transfers does not
     - idempotency is an `Idempotency-Key` HEADER, not a body field

   Using the transfer resource for a withdrawal would credit the creator's Whop
   balance and call it a bank payment. Nothing would reach their bank and the
   books would say it had.

   EVERY CALL GOES THROUGH THE TYPED SDK CLIENT. A hand-written `fetch` body is
   not type-checked, which is how a field name drifts from the contract and a
   payout silently does the wrong thing. The client comes from
   `getWhopPaymentsClient`, which sets an explicit environment base URL — the
   SDK's own default is production.

   AMOUNT CONVERSION IS NOT DUPLICATED HERE. `minorToProviderAmount` and
   `providerAmountToMinor` are imported from the transfer module, where they
   were hardened after a bug that sent minor units as the provider amount and
   would have moved 100x the intended sum.
   ========================================================================== */

/* -------------------------------------------------------------------------
   Statuses — the provider's vocabulary, verbatim
   ------------------------------------------------------------------------- */

/**
 * The eight payout statuses, exactly as the installed SDK declares them.
 *
 * NOT `paid`. NOT `succeeded`. Those are not payout statuses, and code that
 * matched them was reading for values the resource never emits.
 */
export const PROVIDER_PAYOUT_STATUSES = [
  "requested",
  "in_review",
  "processing",
  "completed",
  "reversed",
  "canceled",
  "failed",
  "denied",
] as const;

export type ProviderPayoutStatus = (typeof PROVIDER_PAYOUT_STATUSES)[number];

/** Still moving. Not an outcome, and never treated as one. */
export const NONTERMINAL_PAYOUT_STATUSES: ReadonlySet<string> = new Set([
  "requested",
  "in_review",
  "processing",
]);

/** The money arrived. */
export const SUCCESS_PAYOUT_STATUS = "completed" as const;

/** It ended without paying. The obligation must come back. */
export const FAILURE_PAYOUT_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "denied",
  "canceled",
]);

/** It paid, and then the money came back. The obligation returns. */
export const REVERSAL_PAYOUT_STATUS = "reversed" as const;

function isProviderPayoutStatus(value: unknown): value is ProviderPayoutStatus {
  return (
    typeof value === "string" &&
    (PROVIDER_PAYOUT_STATUSES as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------
   Outcome types
   ------------------------------------------------------------------------- */

export type ProviderPayout = {
  /** `wdrl_…` */
  providerPayoutId: string;
  status: ProviderPayoutStatus;
  /** Gross, in minor units. What left the creator's balance. */
  amountMinor: bigint;
  currency: string;
  /**
   * A classified failure code, or null. THE CODE ONLY — never the message,
   * which may be personalised to the destination and is therefore PII.
   */
  failureCode: string | null;
  /**
   * When a reversal put the funds back in the balance, or null. Present only
   * once the return is confirmed in the provider's ledger.
   */
  fundsReturnedAt: string | null;
};

/**
 * A DEFINITE refusal. The payout was not accepted; no money moved.
 *
 * Every one of these is safe to compensate for, because the provider has told
 * us it did nothing.
 */
export type DefinitePayoutFailure =
  /** 403 — our credentials may not pay out from this account. */
  | "payout_permission_denied"
  /** 404 — the account or payout method does not exist for us. */
  | "payout_target_not_found"
  /** 402 — the creator's balance cannot cover it. */
  | "insufficient_balance"
  /** 400/422 — the request was not acceptable. */
  | "payout_rejected"
  /** Any other definite 4xx. */
  | "provider_rejected";

/**
 * An AMBIGUOUS outcome. We do not know whether the payout was accepted.
 *
 * NEVER compensated and never retried with a fresh key. A timeout may mean the
 * provider took the request and answered into a closed socket; reversing the
 * ledger on that assumption and retrying would pay twice. These stay
 * recoverable and are resolved by asking the provider.
 */
export type AmbiguousPayoutFailure =
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rate_limited"
  /** A 409 whose meaning the provider does not expose. May mean it exists. */
  | "provider_conflict"
  | "network_error";

export type PayoutResult =
  | { ok: true; payout: ProviderPayout }
  | { ok: false; outcome: "definite"; reason: DefinitePayoutFailure }
  | { ok: false; outcome: "ambiguous"; reason: AmbiguousPayoutFailure };

/* -------------------------------------------------------------------------
   Classification
   ------------------------------------------------------------------------- */

/**
 * Splits a provider error into DEFINITE and AMBIGUOUS.
 *
 * This split is the whole safety model for outbound money. A definite refusal
 * can be compensated because the provider has said it did nothing; an
 * ambiguous one cannot, because the payout may exist.
 *
 * 429 AND 5xx ARE AMBIGUOUS, not failures. A rate-limited request may have
 * been counted, and a 502 from a gateway says nothing about whether the
 * service behind it acted.
 */
function classify(error: unknown): PayoutResult {
  if (error instanceof WhopError) {
    const status = typeof error.statusCode === "number" ? error.statusCode : null;

    if (status === null) {
      // No response reached us at all: DNS, TLS, a dropped socket. The request
      // may still have been served.
      return { ok: false, outcome: "ambiguous", reason: "network_error" };
    }
    if (status === 429) {
      return { ok: false, outcome: "ambiguous", reason: "provider_rate_limited" };
    }
    /* 409 IS AMBIGUOUS, NOT A REFUSAL, AND THIS IS A DELIBERATE REVERSAL.
     *
     * It was classified definite on the reasoning that a conflict means the
     * request was rejected. The installed SDK does not support that. It
     * declares `ConflictError` on `payouts.create` and never says what
     * produces one; `V1ErrorResponse.error.type` and `.code` are open strings
     * with no catalog, so the cases cannot even be enumerated.
     *
     * One plausible 409 is an IDEMPOTENCY CONFLICT — the key already created a
     * payout. That is the exact answer a retry after a lost response would
     * get, and it means the payout EXISTS. Treating it as definite would mark
     * the withdrawal failed while the creator's money was genuinely on its way.
     *
     * Where the provider gives us no way to tell, money safety decides:
     * ambiguous, recoverable, resolved by asking rather than by assuming. */
    if (status === 409) {
      return { ok: false, outcome: "ambiguous", reason: "provider_conflict" };
    }
    if (status === 408 || status === 504) {
      return { ok: false, outcome: "ambiguous", reason: "provider_timeout" };
    }
    if (status >= 500) {
      return { ok: false, outcome: "ambiguous", reason: "provider_unavailable" };
    }

    // DEFINITE from here down.
    //
    // 403 IS EXPECTED AND IS DEFINITE. Write authorization for a child
    // account's payouts is unproven: read access was verified in sandbox, but
    // `payouts.create` may carry a separate permission. A 403 means no payout
    // was created, so the obligation is restored exactly once and the
    // withdrawal fails closed. It is never retried blindly.
    if (status === 403) {
      return { ok: false, outcome: "definite", reason: "payout_permission_denied" };
    }
    if (status === 404) {
      return { ok: false, outcome: "definite", reason: "payout_target_not_found" };
    }
    if (status === 402) {
      return { ok: false, outcome: "definite", reason: "insufficient_balance" };
    }
    if (status === 400 || status === 422) {
      return { ok: false, outcome: "definite", reason: "payout_rejected" };
    }
    return { ok: false, outcome: "definite", reason: "provider_rejected" };
  }

  // Not a provider answer at all — an abort, a DNS failure, a thrown non-error.
  // Unknowable, therefore ambiguous.
  return { ok: false, outcome: "ambiguous", reason: "network_error" };
}

/* -------------------------------------------------------------------------
   Reading a payout out of a provider answer
   ------------------------------------------------------------------------- */

type RawPayout = {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  failure?: unknown;
};

/**
 * Narrows a provider payout into our own shape, field by field.
 *
 * ALLOWLISTED ON PURPOSE. The response carries `payer_name`, `payout_method`
 * with institution detail, `statement_descriptor`, `trace_code` and a failure
 * `message` that may be personalised to the destination. None of that is
 * needed to run the lifecycle, and anything read here can end up in a log or a
 * response — so only the six fields the lifecycle actually uses cross this
 * boundary.
 *
 * A malformed answer returns null rather than a partially-trusted object. Not
 * knowing is a state worth preserving.
 */
/**
 * A provider decimal STRING in major units, to bigint minor units.
 *
 * THE PAYOUT RESOURCE ANSWERS IN STRINGS. `amount`, `net_amount`,
 * `fee_amount` and `destination_amount` are all documented as decimal
 * strings, while the TRANSFER resource answers in numbers. Feeding a string
 * straight to `providerAmountToMinor` — which requires a number — made every
 * successful payout unreadable, and an unreadable 2xx is treated as ambiguous,
 * so a payout that had actually been created would have been recorded as an
 * unknown outcome.
 *
 * This normalises the string and then DELEGATES. The sub-cent, non-finite and
 * magnitude rules stay in the one hardened place rather than being restated
 * here, which is what keeps this from becoming a second conversion path.
 */
function decimalStringToMinor(
  value: unknown,
): { ok: true; minor: bigint } | { ok: false } {
  if (typeof value === "number") {
    const direct = providerAmountToMinor(value);
    return direct.ok ? { ok: true, minor: direct.minor } : { ok: false };
  }
  if (typeof value !== "string") return { ok: false };

  const trimmed = value.trim();
  // Digits with at most one decimal point. No exponents, no signs, no spaces:
  // a money string that needs any of those is not one we should guess at.
  if (!/^d+(.d+)?$/.test(trimmed)) return { ok: false };

  const asNumber = Number(trimmed);
  if (!Number.isFinite(asNumber)) return { ok: false };

  const converted = providerAmountToMinor(asNumber);
  return converted.ok ? { ok: true, minor: converted.minor } : { ok: false };
}

function readPayout(raw: unknown): ProviderPayout | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as RawPayout;

  if (typeof p.id !== "string" || p.id.length === 0) return null;
  if (!isProviderPayoutStatus(p.status)) return null;

  const amount = decimalStringToMinor(p.amount);
  if (!amount.ok) return null;

  const currency = typeof p.currency === "string" ? p.currency.toLowerCase() : null;
  if (!currency || currency.length !== 3) return null;

  let failureCode: string | null = null;
  let fundsReturnedAt: string | null = null;
  if (p.failure && typeof p.failure === "object") {
    const f = p.failure as { code?: unknown; funds_returned_at?: unknown };
    if (typeof f.code === "string" && f.code.length > 0) failureCode = f.code.slice(0, 120);
    if (typeof f.funds_returned_at === "string") fundsReturnedAt = f.funds_returned_at;
  }

  return {
    providerPayoutId: p.id,
    status: p.status,
    amountMinor: amount.minor,
    currency,
    failureCode,
    fundsReturnedAt,
  };
}

/* -------------------------------------------------------------------------
   Create
   ------------------------------------------------------------------------- */

export type CreatePayoutInput = {
  /** The creator's connected account, `biz_…`. Resolved server-side, never from a request. */
  accountId: string;
  /** The creator's own saved destination, `potk_…`. Proven to belong to `accountId`. */
  payoutMethodId: string;
  amountMinor: bigint;
  currency: "usd";
  /**
   * STABLE ACROSS RETRIES. Sent as the `Idempotency-Key` header. Derived from
   * the withdrawal id, never minted per attempt — a fresh key per attempt is
   * how a retry becomes a second payment.
   */
  idempotencyKey: string;
  /** Required only when the ledger account demands a quote. */
  quoteToken?: string;
  /** Our own withdrawal id, for provider-side traceability. NEVER PII. */
  withdrawalId: string;
};

/**
 * Creates one payout.
 *
 * WHAT IS DELIBERATELY NOT SENT:
 *
 *   - `platform_covers_fees`. Omitting it uses the platform's configured
 *     policy, which is the decision someone already made deliberately.
 *     Passing `true` would move the fee onto ClipRewards on every withdrawal —
 *     a pricing decision this function has no business making.
 *
 *   - `acknowledge_bank_warning`. Omitting it keeps the provider's pre-gate
 *     behaviour. Passing `true` would push a payout through when the
 *     destination bank could not confirm the account holder's name, which is
 *     precisely the case a human should see.
 *
 *   - `speed: "instant"`. Rejected outright when the account is ineligible, so
 *     it would turn a working withdrawal into a failure.
 *
 *   - `statement_descriptor`, `notes`. Nothing to say that is not PII-adjacent.
 *
 * `metadata` carries the withdrawal id ONLY. The SDK is explicit that webhook
 * bodies are retained for delivery inspection, so metadata is durable storage
 * at the provider and must never hold a uid, an email, or an amount.
 */
export async function createPayout(input: CreatePayoutInput): Promise<PayoutResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, outcome: "definite", reason: "provider_rejected" };

  const converted = minorToProviderAmount(input.amountMinor);
  if (!converted.ok) return { ok: false, outcome: "definite", reason: "payout_rejected" };

  const body: Whop.CreatePayoutsRequest = {
    account_id: input.accountId,
    payout_method_id: input.payoutMethodId,
    amount: converted.amount,
    currency: input.currency,
    metadata: { withdrawal_id: input.withdrawalId },
    ...(input.quoteToken ? { quote_token: input.quoteToken } : {}),
  };

  try {
    const response = await client.payouts.create(body, {
      // PER REQUEST, never client-level: a client-level key would attach the
      // same key to every call the process makes.
      idempotencyKey: input.idempotencyKey,
    });
    const payout = readPayout(response);
    if (!payout) {
      // The provider answered 2xx with something we cannot read. The payout
      // may well exist, so this is AMBIGUOUS, not a failure.
      return { ok: false, outcome: "ambiguous", reason: "provider_unavailable" };
    }
    return { ok: true, payout };
  } catch (error) {
    return classify(error);
  }
}

/* -------------------------------------------------------------------------
   Retrieve — the authority
   ------------------------------------------------------------------------- */

/**
 * Reads one payout's truth from the provider.
 *
 * SCOPED BY `account_id`, which is what makes this an ownership proof as well
 * as a read: a payout belonging to another account is not readable with our
 * key against our creator's account, so a webhook naming an id we do not own
 * cannot be made to move our money.
 *
 * This is the ONLY source a money-moving state change may come from. A webhook
 * payload carries a status, but it is a routing hint — Task #13 already learned
 * that trusting payload status writes money state from values the resource
 * never emits.
 */
export async function retrievePayout(
  providerPayoutId: string,
  accountId: string,
): Promise<PayoutResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, outcome: "ambiguous", reason: "provider_unavailable" };

  try {
    const response = await client.payouts.retrieve({
      id: providerPayoutId,
      account_id: accountId,
    });
    const payout = readPayout(response);
    if (!payout) return { ok: false, outcome: "ambiguous", reason: "provider_unavailable" };
    return { ok: true, payout };
  } catch (error) {
    return classify(error);
  }
}

/* -------------------------------------------------------------------------
   Payout methods — the destination
   ------------------------------------------------------------------------- */

/**
 * One eligible destination, reduced to what selection needs.
 *
 * NO `account_reference`, NO `institution_name`, NO `destination.name`. Those
 * are the masked bank number, the bank's name and the account holder's name —
 * they are what makes this list PII, and selection does not need any of them.
 */
export type EligiblePayoutMethod = {
  /** `potk_…` */
  payoutMethodId: string;
  /** The owning company, proven against our own record. */
  companyId: string;
  currency: string;
  /** The provider's own default marker for this payout account. */
  isDefault: boolean;
  /** `crypto` | `rtp` | `next_day_bank` | `bank_wire` | `digital_wallet` | `unknown` */
  category: string;
};

export type PayoutMethodListResult =
  | { ok: true; methods: EligiblePayoutMethod[] }
  | { ok: false; reason: "provider_unavailable" | "provider_rejected" };

const MAX_PAYOUT_METHODS = 25;

/**
 * Lists the creator's ELIGIBLE payout destinations.
 *
 * COMPANY-SCOPED AT THE PROVIDER. `company_id` is a required field on this
 * request, not an optional filter, so the returned list is itself the
 * ownership proof: a `potk_` that appears here belongs to this company. That is
 * what lets a browser-supplied destination be validated by membership rather
 * than trusted.
 *
 * ELIGIBILITY IS THE PROVIDER'S OWN TEST. `destination === null` is documented
 * as "not yet configured" — a token that exists but cannot receive money. The
 * currency filter is ours: Task #15 pays USD only, and a destination that
 * delivers in another currency would silently convert.
 */
export async function listEligiblePayoutMethods(
  companyId: string,
  currency = "usd",
): Promise<PayoutMethodListResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "provider_unavailable" };

  try {
    const page = await client.payoutMethods.listPayoutMethod({
      company_id: companyId,
      first: MAX_PAYOUT_METHODS,
    });

    const items: Whop.PayoutMethodListItem[] = [];
    for await (const item of page) {
      items.push(item);
      if (items.length >= MAX_PAYOUT_METHODS) break;
    }

    const methods: EligiblePayoutMethod[] = [];
    for (const item of items) {
      if (typeof item?.id !== "string" || !item.id) continue;
      // Not yet configured: the provider's own words.
      if (!item.destination) continue;
      if (typeof item.currency !== "string") continue;
      if (item.currency.toLowerCase() !== currency) continue;
      // OWNERSHIP, CHECKED AGAIN ON OUR SIDE. The request was company-scoped,
      // but asserting it against the row we hold means a provider-side change
      // in that scoping cannot silently widen what we accept.
      const owner = item.company?.id;
      if (typeof owner !== "string" || owner !== companyId) continue;

      methods.push({
        payoutMethodId: item.id,
        companyId: owner,
        currency: item.currency.toLowerCase(),
        isDefault: item.is_default === true,
        category:
          typeof item.destination.category === "string" ? item.destination.category : "unknown",
      });
    }

    return { ok: true, methods };
  } catch (error) {
    const classified = classify(error);
    return classified.ok
      ? { ok: false, reason: "provider_unavailable" }
      : {
          ok: false,
          reason: classified.outcome === "ambiguous" ? "provider_unavailable" : "provider_rejected",
        };
  }
}

/* -------------------------------------------------------------------------
   Selection
   ------------------------------------------------------------------------- */

export type MethodSelection =
  | { ok: true; method: EligiblePayoutMethod }
  /** No destination exists yet. The creator must set one up (Task #12 portal). */
  | { ok: false; reason: "payout_destination_required" }
  /** Several, and none is unambiguously default. The creator must choose. */
  | { ok: false; reason: "payout_method_selection_required" }
  /** A supplied id was not among this creator's eligible destinations. */
  | { ok: false; reason: "payout_method_not_owned" };

/**
 * Picks the destination, deterministically.
 *
 * NEVER `methods[0]`. List ordering is undocumented and `PayoutMethodListItem`
 * carries no ordering key, so taking the first result would mean the
 * destination of a creator's money depends on an unspecified provider detail
 * that can change between calls.
 *
 * The rules, in order:
 *   1. A requested id must APPEAR IN THIS LIST. Membership in the
 *      company-scoped eligible set is the ownership proof; a browser-supplied
 *      `potk_` is never trusted on its own.
 *   2. Zero eligible → the creator has no destination yet.
 *   3. Exactly one → use it. No ambiguity to resolve.
 *   4. Several → use the one the PROVIDER marks default, and only if exactly
 *      one is marked. Zero or several defaults is a real ambiguity and the
 *      creator decides, rather than us guessing with their money.
 */
export function selectPayoutMethod(
  methods: EligiblePayoutMethod[],
  requestedId?: string | null,
): MethodSelection {
  if (requestedId) {
    const match = methods.find((m) => m.payoutMethodId === requestedId);
    return match ? { ok: true, method: match } : { ok: false, reason: "payout_method_not_owned" };
  }

  if (methods.length === 0) return { ok: false, reason: "payout_destination_required" };
  if (methods.length === 1) return { ok: true, method: methods[0] };

  const defaults = methods.filter((m) => m.isDefault);
  if (defaults.length === 1) return { ok: true, method: defaults[0] };
  return { ok: false, reason: "payout_method_selection_required" };
}

/* -------------------------------------------------------------------------
   Quote requirement
   ------------------------------------------------------------------------- */

export type QuoteRequirement =
  | { ok: true; required: boolean }
  | { ok: false; reason: "provider_unavailable" };

/**
 * Asks whether this account's payouts must be quoted first.
 *
 * `payout_quote_required` lives on the ledger account. When true, a payout
 * without a `quote_token` is refused with `invalid_payout_quote` — so this is
 * not advisory, it decides whether an extra provider round-trip is mandatory.
 *
 * FAILS CLOSED. An unreadable answer is reported, never defaulted to `false`:
 * assuming no quote is needed would send a payout that the provider refuses,
 * after the ledger has already been debited.
 */
export async function readQuoteRequirement(accountId: string): Promise<QuoteRequirement> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "provider_unavailable" };

  try {
    const account = await client.ledgerAccounts.retrieve({ id: accountId });
    if (typeof account?.payout_quote_required !== "boolean") {
      return { ok: false, reason: "provider_unavailable" };
    }
    return { ok: true, required: account.payout_quote_required };
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
}

export type QuoteResult =
  | { ok: true; quoteToken: string; expiresAt: string }
  | { ok: false; reason: "quote_unavailable" | "quote_rejected" };

/**
 * Mints a payout quote, when the account requires one.
 *
 * NO FUNDS MOVE. The SDK is explicit: nothing moves until the returned
 * `quote_token` is submitted to `POST /payouts`.
 *
 * THE TOKEN IS NEVER PERSISTED. It is a short-lived signed secret with an
 * `expires_at`, used within the same request that mints it. Storing it would
 * create a durable credential for moving money, and a stored token that later
 * expires turns a retry into a confusing provider refusal rather than a clean
 * re-quote.
 *
 * AN EXPIRED OR SPENT QUOTE COMES BACK AS 409, which `classify` reports as the
 * definite `payout_conflict` — so the withdrawal fails closed and is re-quoted
 * on a deliberate retry, rather than being guessed at.
 *
 * The quote is minted OUTSIDE the database transaction. A provider round-trip
 * must never be made while holding a row lock.
 */
export async function createPayoutQuote(input: {
  accountId: string;
  payoutMethodId: string;
  amountMinor: bigint;
  currency: "usd";
  idempotencyKey: string;
}): Promise<QuoteResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "quote_unavailable" };

  const converted = minorToProviderAmount(input.amountMinor);
  if (!converted.ok) return { ok: false, reason: "quote_rejected" };

  try {
    const quote = await client.payouts.createQuote(
      {
        account_id: input.accountId,
        payout_method_id: input.payoutMethodId,
        amount: converted.amount,
        currency: input.currency,
      },
      // The SDK documents an Idempotency-Key header as REQUIRED here — the only
      // payout method where it says so.
      { idempotencyKey: input.idempotencyKey },
    );

    if (typeof quote?.quote_token !== "string" || !quote.quote_token) {
      return { ok: false, reason: "quote_unavailable" };
    }
    return {
      ok: true,
      quoteToken: quote.quote_token,
      expiresAt: typeof quote.expires_at === "string" ? quote.expires_at : "",
    };
  } catch (error) {
    const classified = classify(error);
    return {
      ok: false,
      reason:
        !classified.ok && classified.outcome === "definite" ? "quote_rejected" : "quote_unavailable",
    };
  }
}

/* -------------------------------------------------------------------------
   The creator's withdrawable balance — the ONLY eligibility source
   ------------------------------------------------------------------------- */

export type WithdrawableBalance =
  | { ok: true; withdrawableMinor: bigint; currency: string }
  | { ok: false; reason: "provider_unavailable" | "unsupported_currency" };

/**
 * How much the creator can actually take out of their own Whop account.
 *
 * THIS REPLACED `creator_payable` AS THE WITHDRAWAL CAP, and the distinction
 * is the whole correction.
 *
 * `creator_payable` is what ClipRewards still OWES the creator. A Task #13
 * transfer DISCHARGES it — the money moves into the creator's own Whop
 * account, and from that moment we owe them nothing. A withdrawal then moves
 * THEIR funds to THEIR bank. Capping it against our liability asked the wrong
 * question twice over: the figure is zero exactly when a withdrawal becomes
 * possible, and debiting it again would have driven it negative.
 *
 * `total_withdrawable_balance` IS THE FIELD, chosen over the alternatives on
 * purpose. `balances[].balance` includes money that has not settled, and the
 * per-currency row carries `pending_balance` and `reserve_balance` separately
 * with no withdrawable figure at all. The treasury cache is the only place the
 * provider states what may actually leave, which is the only number a payout
 * can be checked against.
 *
 * ZERO IS A VALID ANSWER, not a failure. A creator with nothing withdrawable
 * gets a clean refusal, not a provider error.
 */
export async function readWithdrawableBalance(
  accountId: string,
  currency = "usd",
): Promise<WithdrawableBalance> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "provider_unavailable" };

  try {
    const account = await client.ledgerAccounts.retrieve({ id: accountId });
    const treasury = account?.treasury_balance;
    if (!treasury) return { ok: false, reason: "provider_unavailable" };

    const treasuryCurrency =
      typeof treasury.currency === "string" ? treasury.currency.toLowerCase() : null;
    if (treasuryCurrency !== currency) return { ok: false, reason: "unsupported_currency" };

    const raw = treasury.total_withdrawable_balance;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, reason: "provider_unavailable" };
    }
    // A zero or negative treasury figure means nothing may leave. Reported as
    // an empty balance rather than pushed through the positive-only converter.
    if (raw <= 0) return { ok: true, withdrawableMinor: BigInt(0), currency };

    const converted = decimalStringToMinor(raw);
    if (!converted.ok) return { ok: false, reason: "provider_unavailable" };

    return { ok: true, withdrawableMinor: converted.minor, currency };
  } catch {
    // FAILS CLOSED. An unreadable balance is never treated as "enough".
    return { ok: false, reason: "provider_unavailable" };
  }
}

/* -------------------------------------------------------------------------
   Orphan discovery — finding a payout whose response we lost
   ------------------------------------------------------------------------- */

export type OrphanSearchResult =
  /** Exactly one payout carries this withdrawal id. Safe to adopt. */
  | { ok: true; found: true; payout: ProviderPayout }
  /** The provider has no payout for this withdrawal. NOT proof one is absent. */
  | { ok: true; found: false }
  /** More than one match. A human decides; nothing is adopted. */
  | { ok: false; reason: "ambiguous_matches" }
  | { ok: false; reason: "provider_unavailable" };

const ORPHAN_SCAN_LIMIT = 100;

/**
 * Looks for a payout we may have created but never got an id for.
 *
 * THE PROBLEM THIS SOLVES. `payouts.create` can reach Whop, create a payout,
 * and have its response lost to a timeout. The withdrawal is then in flight
 * with no `provider_payout_id`, and `payouts.retrieve` needs exactly that id —
 * so without this, the row can never be resolved by any means.
 *
 * THE MATCH IS ON OUR OWN METADATA. `metadata.withdrawal_id` is set at
 * creation and echoed on every read, so it identifies OUR payout precisely.
 * Amount and currency are verified as well, because a metadata match alone
 * would adopt a payout that differs from the one we intended.
 *
 * SCOPED TO THE CREATOR'S ACCOUNT AND A TIME WINDOW. `account_id` is required
 * by the request; `created_after` bounds the scan to the attempt itself rather
 * than the account's whole history.
 *
 * MORE THAN ONE MATCH FAILS CLOSED. Two payouts carrying the same withdrawal
 * id should be impossible, so if it happens the invariant is already broken
 * and picking one would be a guess with the creator's money.
 *
 * FINDING NOTHING IS NOT PROOF OF NOTHING. The provider may be eventually
 * consistent, so a caller must never read an empty result as permission to
 * create the payout again — see `whop-withdrawals`' recovery path.
 */
export async function findPayoutByWithdrawalId(input: {
  accountId: string;
  withdrawalId: string;
  amountMinor: bigint;
  currency: string;
  createdAfter: Date;
  payoutMethodId?: string | null;
}): Promise<OrphanSearchResult> {
  const client = getWhopPaymentsClient();
  if (!client) return { ok: false, reason: "provider_unavailable" };

  try {
    const page = await client.payouts.list({
      account_id: input.accountId,
      created_after: input.createdAfter.toISOString(),
      first: ORPHAN_SCAN_LIMIT,
      ...(input.payoutMethodId ? { payout_method_id: input.payoutMethodId } : {}),
    });

    const matches: ProviderPayout[] = [];
    let scanned = 0;
    for await (const item of page) {
      if (++scanned > ORPHAN_SCAN_LIMIT) break;

      const meta = (item as { metadata?: Record<string, string> }).metadata;
      if (!meta || meta.withdrawal_id !== input.withdrawalId) continue;

      const payout = readPayout(item);
      if (!payout) continue;

      // The metadata says it is ours; these say it is the one we meant.
      if (payout.amountMinor !== input.amountMinor) continue;
      if (payout.currency !== input.currency) continue;

      matches.push(payout);
    }

    if (matches.length === 0) return { ok: true, found: false };
    if (matches.length > 1) return { ok: false, reason: "ambiguous_matches" };
    return { ok: true, found: true, payout: matches[0] };
  } catch {
    return { ok: false, reason: "provider_unavailable" };
  }
}
