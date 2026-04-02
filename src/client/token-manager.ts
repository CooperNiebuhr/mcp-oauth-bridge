import { ProviderAuthError } from '../errors.js';
import type { ApiClientConfig, TokenResponse } from './types.js';

// Per-user token cache: keyed by refresh token
const tokenCache = new Map<string, { token: string; expiry: number }>();
const refreshPromises = new Map<string, Promise<string>>();

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export async function getAccessToken(config: ApiClientConfig): Promise<string> {
  const cacheKey = config.refreshToken;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiry - REFRESH_BUFFER_MS) {
    return cached.token;
  }

  // Coalesce concurrent refresh calls for the same user
  let promise = refreshPromises.get(cacheKey);
  if (!promise) {
    promise = refreshAccessToken(config).finally(() => {
      refreshPromises.delete(cacheKey);
    });
    refreshPromises.set(cacheKey, promise);
  }
  return promise;
}

export async function forceRefresh(config: ApiClientConfig): Promise<string> {
  const cacheKey = config.refreshToken;
  tokenCache.delete(cacheKey);

  let promise = refreshPromises.get(cacheKey);
  if (!promise) {
    promise = refreshAccessToken(config).finally(() => {
      refreshPromises.delete(cacheKey);
    });
    refreshPromises.set(cacheKey, promise);
  }
  return promise;
}

async function refreshAccessToken(config: ApiClientConfig): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
  });

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new ProviderAuthError(`Token refresh network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderAuthError(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as TokenResponse;

  if (data.error) {
    throw new ProviderAuthError(`Token refresh error: ${data.error}`);
  }

  const token = data.access_token;
  const expiry = Date.now() + data.expires_in * 1000;
  tokenCache.set(config.refreshToken, { token, expiry });
  console.log(`[auth] Access token refreshed, expires in ${data.expires_in}s`);

  return token;
}
