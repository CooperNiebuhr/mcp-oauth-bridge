import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProviderApiClient } from '../src/client/api-client.js';
import { ProviderAuthError, ProviderApiError, ProviderNetworkError, ProviderRateLimitError } from '../src/errors.js';

// Mock the token manager module
vi.mock('../src/client/token-manager.js', () => ({
  getAccessToken: vi.fn().mockResolvedValue('test-token'),
  forceRefresh: vi.fn().mockResolvedValue('refreshed-token'),
}));

import { getAccessToken, forceRefresh } from '../src/client/token-manager.js';

const mockFetch = vi.fn();
const realFetch = globalThis.fetch;

const clientConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rt',
  tokenUrl: 'https://provider.test/token',
  apiBaseUrl: 'https://api.provider.test',
};

describe('ProviderApiClient', () => {
  let client: ProviderApiClient;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
    vi.mocked(getAccessToken).mockResolvedValue('test-token');
    vi.mocked(forceRefresh).mockResolvedValue('refreshed-token');
    client = new ProviderApiClient(clientConfig);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe('request (GET)', () => {
    it('sends GET with Bearer header and query params', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));

      const result = await client.request<{ data: string }>('/items', { page: '1' });
      expect(result.data).toBe('ok');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('https://api.provider.test/items');
      expect(url).toContain('page=1');
      expect(opts.headers.Authorization).toBe('Bearer test-token');
    });
  });

  describe('create (POST)', () => {
    it('sends POST with JSON body', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: '1' }), { status: 201 }));

      const result = await client.create<{ id: string }>('/items', { name: 'test' });
      expect(result.id).toBe('1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.provider.test/items');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({ name: 'test' });
    });
  });

  describe('update (PUT)', () => {
    it('sends PUT with JSON body', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: '1' }), { status: 200 }));

      await client.update('/items/1', { name: 'updated' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('PUT');
    });
  });

  describe('remove (DELETE)', () => {
    it('sends DELETE with query params', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await client.remove('/items/1', { force: 'true' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('force=true');
      expect(opts.method).toBe('DELETE');
    });
  });

  describe('401 retry', () => {
    it('retries once after token refresh on 401', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const result = await client.request<{ ok: boolean }>('/protected');
      expect(result.ok).toBe(true);
      expect(forceRefresh).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws ProviderApiError on persistent 401', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response('Still unauthorized', { status: 401 }));

      await expect(client.request('/protected')).rejects.toThrow(ProviderApiError);
    });
  });

  describe('429 rate limit backoff', () => {
    it('retries with backoff and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      vi.useFakeTimers();
      const promise = client.request<{ ok: boolean }>('/items');
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws ProviderRateLimitError after max retries', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 429 }));

      vi.useFakeTimers();
      const promise = client.request('/items');
      // Attach rejection handler before running timers to prevent unhandled rejection
      const expectation = expect(promise).rejects.toThrow(ProviderRateLimitError);
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      await expectation;
    });
  });

  describe('error handling', () => {
    it('wraps network errors in ProviderNetworkError', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.request('/items')).rejects.toThrow(ProviderNetworkError);
    });

    it('throws ProviderApiError for non-2xx responses', async () => {
      mockFetch.mockResolvedValue(new Response('Bad Request', { status: 400 }));

      try {
        await client.request('/items');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderApiError);
        expect((err as ProviderApiError).statusCode).toBe(400);
        expect((err as ProviderApiError).responseBody).toBe('Bad Request');
      }
    });

    it('wraps network errors in create/update/remove', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.create('/items', {})).rejects.toThrow(ProviderNetworkError);
      await expect(client.update('/items/1', {})).rejects.toThrow(ProviderNetworkError);
      await expect(client.remove('/items/1')).rejects.toThrow(ProviderNetworkError);
    });
  });

  describe('tokenNeverExpires', () => {
    let staticClient: ProviderApiClient;

    beforeEach(() => {
      staticClient = new ProviderApiClient({ ...clientConfig, tokenNeverExpires: true });
    });

    it('throws ProviderAuthError on 401 without retrying (request)', async () => {
      mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

      await expect(staticClient.request('/items')).rejects.toThrow(ProviderAuthError);
      expect(mockFetch).toHaveBeenCalledTimes(1); // no retry
    });

    it('throws ProviderAuthError on 401 without retrying (create)', async () => {
      mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

      await expect(staticClient.create('/items', { name: 'x' })).rejects.toThrow(ProviderAuthError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws ProviderAuthError on 401 without retrying (remove)', async () => {
      mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

      await expect(staticClient.remove('/items/1')).rejects.toThrow(ProviderAuthError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
