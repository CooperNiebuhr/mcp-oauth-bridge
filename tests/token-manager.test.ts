import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { ApiClientConfig } from '../src/client/types.js';

const mockFetch = vi.fn();
const realFetch = globalThis.fetch;

const config: ApiClientConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rt-123',
  tokenUrl: 'https://provider.test/token',
  apiBaseUrl: 'https://api.provider.test',
};

function mockTokenResponse(accessToken: string, expiresIn: number) {
  return new Response(
    JSON.stringify({ access_token: accessToken, expires_in: expiresIn, token_type: 'bearer' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('token-manager', () => {
  // Re-import fresh module for each test to clear module-level cache
  let getAccessToken: typeof import('../src/client/token-manager.js').getAccessToken;
  let forceRefresh: typeof import('../src/client/token-manager.js').forceRefresh;

  beforeEach(async () => {
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();

    // Reset module to clear token cache
    vi.resetModules();
    const mod = await import('../src/client/token-manager.js');
    getAccessToken = mod.getAccessToken;
    forceRefresh = mod.forceRefresh;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fetches and caches a token', async () => {
    mockFetch.mockResolvedValue(mockTokenResponse('tok-1', 3600));

    const token = await getAccessToken(config);
    expect(token).toBe('tok-1');

    // Second call should use cache (no additional fetch)
    const token2 = await getAccessToken(config);
    expect(token2).toBe('tok-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes when within 5 minutes of expiry', async () => {
    // First token expires in 4 minutes (within 5-minute buffer)
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse('tok-short', 240))
      .mockResolvedValueOnce(mockTokenResponse('tok-fresh', 3600));

    const token1 = await getAccessToken(config);
    expect(token1).toBe('tok-short');

    // Second call should trigger refresh because 240s < 300s buffer
    const token2 = await getAccessToken(config);
    expect(token2).toBe('tok-fresh');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh always fetches new token', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse('tok-1', 3600))
      .mockResolvedValueOnce(mockTokenResponse('tok-2', 3600));

    await getAccessToken(config);
    const refreshed = await forceRefresh(config);
    expect(refreshed).toBe('tok-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refresh calls', async () => {
    let resolveToken: (v: Response) => void;
    mockFetch.mockReturnValue(new Promise<Response>((r) => { resolveToken = r; }));

    // Start 3 concurrent requests
    const p1 = getAccessToken(config);
    const p2 = getAccessToken(config);
    const p3 = getAccessToken(config);

    // Resolve the single fetch
    resolveToken!(mockTokenResponse('tok-shared', 3600));

    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect(t1).toBe('tok-shared');
    expect(t2).toBe('tok-shared');
    expect(t3).toBe('tok-shared');

    // Only one fetch should have been made
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws ProviderAuthError on refresh failure', async () => {
    mockFetch.mockResolvedValue(new Response('invalid_grant', { status: 400 }));

    await expect(getAccessToken(config)).rejects.toThrow('Token refresh failed');
  });

  it('throws ProviderAuthError on token response with error field', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_grant', access_token: '', expires_in: 0, token_type: '' }),
        { status: 200 },
      ),
    );

    await expect(getAccessToken(config)).rejects.toThrow('Token refresh error');
  });

  it('throws ProviderAuthError on network error', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(getAccessToken(config)).rejects.toThrow('Token refresh network error');
  });

  describe('tokenNeverExpires', () => {
    const staticConfig: ApiClientConfig = {
      ...config,
      refreshToken: 'static-access-token',
      tokenNeverExpires: true,
    };

    it('returns the static token without fetching', async () => {
      const token = await getAccessToken(staticConfig);
      expect(token).toBe('static-access-token');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('forceRefresh throws ProviderAuthError', async () => {
      await expect(forceRefresh(staticConfig)).rejects.toThrow('Token refresh is not available');
    });
  });
});
