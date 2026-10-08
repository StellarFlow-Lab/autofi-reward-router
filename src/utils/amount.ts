/**
 * Exact amount arithmetic for Stellar values.
 *
 * Stellar amounts have 7 decimal places (1 unit = 10_000_000 stroops) and a
 * max of int64 stroops. Using floats for money silently loses precision, so
 * every calculation here is done in integer stroops with BigInt.
 */

export const STROOPS_PER_UNIT = 10_000_000n;
export const MAX_STROOPS = 9_223_372_036_854_775_807n; // int64 max

const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

/** Parse a decimal string (e.g. "12.5") into stroops. Throws on invalid input. */
export function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!AMOUNT_RE.test(trimmed)) {
    throw new Error(`Invalid Stellar amount: "${amount}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, '0'));
  if (stroops > MAX_STROOPS) {
    throw new Error(`Amount exceeds Stellar maximum: "${amount}"`);
  }
  return stroops;
}

/** Format stroops as a 7-decimal Stellar amount string. */
export function fromStroops(stroops: bigint): string {
  if (stroops < 0n) throw new Error('Negative amounts are not supported');
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = (stroops % STROOPS_PER_UNIT).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

/** amount × pct / 100, rounded down to the nearest stroop. */
export function percentOf(amount: string, pct: number): string {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new Error(`Percentage must be an integer 0-100, got ${pct}`);
  }
  return fromStroops((toStroops(amount) * BigInt(pct)) / 100n);
}

/**
 * Minimum acceptable amount after slippage. `slippageBps` is basis points
 * (100 bps = 1%). Rounded down.
 */
export function applySlippage(amount: string, slippageBps: number): string {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`Slippage must be an integer 0-9999 bps, got ${slippageBps}`);
  }
  return fromStroops((toStroops(amount) * BigInt(10_000 - slippageBps)) / 10_000n);
}

export function isPositiveAmount(amount: string): boolean {
  try {
    return toStroops(amount) > 0n;
  } catch {
    return false;
  }
}

export function addAmounts(a: string, b: string): string {
  return fromStroops(toStroops(a) + toStroops(b));
}
