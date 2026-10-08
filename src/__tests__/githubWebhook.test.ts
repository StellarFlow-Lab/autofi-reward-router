import { createHmac } from 'crypto';
import { parseBountyEvent, parseBountyLabel, verifyGitHubSignature } from '../server/githubWebhook';

describe('GitHub webhook', () => {
  test('verifies HMAC signatures', () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyGitHubSignature(body, sig, 's3cret')).toBe(true);
    expect(verifyGitHubSignature(body, sig, 'wrong')).toBe(false);
    expect(verifyGitHubSignature(body, undefined, 's3cret')).toBe(false);
    expect(verifyGitHubSignature(body, 'sha256=abc', 's3cret')).toBe(false);
  });

  test('parses bounty labels', () => {
    expect(parseBountyLabel([{ name: 'bug' }])).toBeNull();
    expect(parseBountyLabel([{ name: 'bounty: 150 USDC' }])).toEqual({ amount: '150', asset: 'USDC' });
    expect(parseBountyLabel([{ name: '💰 Bounty $50' }])).toEqual({ amount: '50', asset: 'USDC' });
    expect(parseBountyLabel([{ name: 'bounty' }])).toEqual({});
  });

  test('turns closed bounty issues and merged bounty PRs into notices', () => {
    const issue = { action: 'closed', repository: { full_name: 'o/r' }, issue: { number: 7, title: 'Fix', labels: [{ name: 'bounty 25 XLM' }], assignee: { login: 'nuel' } } };
    expect(parseBountyEvent('issues', issue)).toMatchObject({ repo: 'o/r', number: 7, developer: 'nuel', amount: '25', asset: 'XLM' });
    expect(parseBountyEvent('issues', { ...issue, action: 'opened' })).toBeNull();

    const pr = { action: 'closed', pull_request: { number: 9, title: 'PR', merged: true, labels: [{ name: 'Bounty: 10 USDC' }], user: { login: 'dev' } } };
    expect(parseBountyEvent('pull_request', pr)).toMatchObject({ number: 9, developer: 'dev', amount: '10' });
    expect(parseBountyEvent('pull_request', { ...pr, pull_request: { ...pr.pull_request, merged: false } })).toBeNull();
  });
});
