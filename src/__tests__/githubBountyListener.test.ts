import { verifyGitHubSignature } from '../../services/githubBountyListener';

describe('verifyGitHubSignature', () => {
  const secret = 'test-secret';
  const body = '{"action":"opened"}';

  it('returns true for a valid signature', () => {
    const crypto = require('crypto');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf-8').digest('hex');
    expect(verifyGitHubSignature(body, expected, secret)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    expect(verifyGitHubSignature(body, 'sha256=deadbeef', secret)).toBe(false);
  });

  it('returns false for a missing signature header', () => {
    expect(verifyGitHubSignature(body, '', secret)).toBe(false);
  });

  it('returns true when secret is empty (skip validation)', () => {
    expect(verifyGitHubSignature(body, 'sha256=anything', '')).toBe(true);
  });

  it('returns false for wrong prefix', () => {
    expect(verifyGitHubSignature(body, 'sha1=abcd', secret)).toBe(false);
  });
});
