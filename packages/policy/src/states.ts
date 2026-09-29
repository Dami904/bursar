/**
 * Authorization states and how each one counts against a job's budget (PLAN.md §8.3, §8.11.2).
 *
 * Every state belongs to one budget bucket. A transition moves the amount from the old state's
 * bucket to the new one's, so counters change only through this table.
 */

export const authorizationStates = [
  "PENDING_APPROVAL",
  "RESERVED",
  "RELEASING",
  "FUNDED_WALLET",
  "SIGNING",
  "UNRESOLVED",
  "SETTLED",
  "RELEASED",
  "REJECTED",
] as const;

export type AuthorizationState = (typeof authorizationStates)[number];

export type Bucket = "pending" | "reserved" | "unresolved" | "settled";

export const bucketOf: Record<AuthorizationState, Bucket | null> = {
  PENDING_APPROVAL: "pending",
  RESERVED: "reserved",
  RELEASING: "reserved",
  FUNDED_WALLET: "reserved",
  SIGNING: "reserved",
  UNRESOLVED: "unresolved",
  SETTLED: "settled",
  RELEASED: null,
  REJECTED: null,
};

const legal: Readonly<Record<AuthorizationState, readonly AuthorizationState[]>> = {
  PENDING_APPROVAL: ["RESERVED", "REJECTED"],
  // RESERVED -> SIGNING is the Gateway rail: a sub-cent payment signed against the job's Gateway
  // balance, with no vault release of its own (the vault released that balance as a float).
  RESERVED: ["RELEASING", "SIGNING", "RELEASED"],
  // RELEASING -> SETTLED is the direct-payee path (invoice paid straight from the vault).
  RELEASING: ["FUNDED_WALLET", "SETTLED", "UNRESOLVED", "RELEASED"],
  FUNDED_WALLET: ["SIGNING", "RELEASED"],
  SIGNING: ["SETTLED", "UNRESOLVED", "RELEASED"],
  UNRESOLVED: ["SETTLED", "RELEASED"],
  SETTLED: [],
  RELEASED: [],
  REJECTED: [],
};

export function isLegalTransition(from: AuthorizationState, to: AuthorizationState): boolean {
  return legal[from].includes(to);
}

export type BucketDelta = Readonly<Record<Bucket, bigint>>;

const zero: BucketDelta = { pending: 0n, reserved: 0n, unresolved: 0n, settled: 0n };

/** The change to each job counter when an authorization of `amount` moves from `from` to `to`. */
export function transitionDelta(
  from: AuthorizationState,
  to: AuthorizationState,
  amount: bigint,
): BucketDelta {
  if (!isLegalTransition(from, to)) {
    throw new RangeError(`Illegal authorization transition ${from} -> ${to}`);
  }
  const delta = { ...zero };
  const leaving = bucketOf[from];
  const entering = bucketOf[to];
  if (leaving !== null) delta[leaving] -= amount;
  if (entering !== null) delta[entering] += amount;
  return delta;
}

/** Whether a state is final: nothing more can happen to the authorization. */
export function isTerminal(state: AuthorizationState): boolean {
  return legal[state].length === 0;
}
