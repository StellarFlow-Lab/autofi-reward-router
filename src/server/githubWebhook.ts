import { createHmac, timingSafeEqual } from 'crypto';

/** Verify GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body). */
export function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(signatureHeader);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface BountyNotice {
  repo?: string;
  number: number;
  title: string;
  developer?: string;
  amount?: string;
  asset?: string;
  url?: string;
}

interface Label { name: string }
interface GitHubPayload {
  action?: string;
  repository?: { full_name?: string };
  issue?: { number: number; title: string; html_url?: string; labels?: Label[]; assignee?: { login: string } | null };
  pull_request?: { number: number; title: string; html_url?: string; merged?: boolean; labels?: Label[]; user?: { login: string } };
}

const BOUNTY_RE = /bounty/i;
const AMOUNT_RE = /(?:\$\s*)?(\d+(?:\.\d{1,7})?)\s*([A-Za-z]{3,12})?/;

/** Pull an amount + asset out of labels like "bounty: 150 USDC", "💰 Bounty $50". */
export function parseBountyLabel(labels: Label[]): { amount?: string; asset?: string } | null {
  const label = labels.find((l) => BOUNTY_RE.test(l.name));
  if (!label) return null;
  const m = label.name.replace(BOUNTY_RE, '').match(AMOUNT_RE);
  if (!m) return {};
  const asset = m[2]?.toUpperCase();
  return { amount: m[1], asset: asset && asset !== 'BOUNTY' ? asset : label.name.includes('$') ? 'USDC' : undefined };
}

/**
 * Turn a GitHub `issues` / `pull_request` webhook into a bounty notice when a
 * bounty-labelled issue is closed or a bounty-labelled PR is merged.
 *
 * GitHub doesn't move money: the actual payout still arrives on-chain and is
 * routed by the payment listener. This just tells you one is on its way.
 */
export function parseBountyEvent(event: string | undefined, payload: GitHubPayload): BountyNotice | null {
  const repo = payload.repository?.full_name;
  if (event === 'issues' && payload.action === 'closed' && payload.issue) {
    const b = parseBountyLabel(payload.issue.labels ?? []);
    if (!b) return null;
    return { repo, number: payload.issue.number, title: payload.issue.title, developer: payload.issue.assignee?.login, url: payload.issue.html_url, ...b };
  }
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged) {
    const pr = payload.pull_request;
    const b = parseBountyLabel(pr.labels ?? []);
    if (!b) return null;
    return { repo, number: pr.number, title: pr.title, developer: pr.user?.login, url: pr.html_url, ...b };
  }
  return null;
}
