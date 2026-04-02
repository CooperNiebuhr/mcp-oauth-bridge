import { ProviderRateLimitError, ProviderApiError, ProviderNetworkError } from '../errors.js';
import { getAccessToken, forceRefresh } from './token-manager.js';
import type { ApiClientConfig } from './types.js';

export class ProviderApiClient {
  private config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = config;
  }

  async request<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    return this.doRequest<T>(endpoint, params, false);
  }

  async update<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.doMutate<T>('PUT', endpoint, body, false);
  }

  async create<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.doMutate<T>('POST', endpoint, body, false);
  }

  async remove<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    return this.doRemove<T>(endpoint, params, false);
  }

  private async doMutate<T>(
    method: 'PUT' | 'POST',
    endpoint: string,
    body: Record<string, unknown>,
    isRetryAfterAuth: boolean,
  ): Promise<T> {
    const token = await getAccessToken(this.config);
    const url = `${this.config.apiBaseUrl}${endpoint}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderNetworkError(`${method} request to ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 401 && !isRetryAfterAuth) {
      console.log(`[provider] 401 on ${method} ${endpoint}, forcing token refresh and retrying`);
      await forceRefresh(this.config);
      return this.doMutate<T>(method, endpoint, body, true);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ProviderApiError(`API error on ${method} ${endpoint}`, response.status, text);
    }

    return (await response.json()) as T;
  }

  private async doRemove<T>(
    endpoint: string,
    params: Record<string, string> | undefined,
    isRetryAfterAuth: boolean,
  ): Promise<T> {
    const token = await getAccessToken(this.config);
    const url = new URL(`${this.config.apiBaseUrl}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new ProviderNetworkError(`DELETE request to ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 401 && !isRetryAfterAuth) {
      console.log(`[provider] 401 on DELETE ${endpoint}, forcing token refresh and retrying`);
      await forceRefresh(this.config);
      return this.doRemove<T>(endpoint, params, true);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ProviderApiError(`API error on DELETE ${endpoint}`, response.status, text);
    }

    return (await response.json()) as T;
  }

  private async doRequest<T>(
    endpoint: string,
    params: Record<string, string> | undefined,
    isRetryAfterAuth: boolean,
  ): Promise<T> {
    const token = await getAccessToken(this.config);
    const url = new URL(`${this.config.apiBaseUrl}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    let response: Response;
    try {
      response = await this.fetchWithRetry(url.toString(), token);
    } catch (err) {
      if (err instanceof ProviderRateLimitError || err instanceof ProviderApiError) throw err;
      throw new ProviderNetworkError(`Request to ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 401 && !isRetryAfterAuth) {
      console.log(`[provider] 401 on ${endpoint}, forcing token refresh and retrying`);
      await forceRefresh(this.config);
      return this.doRequest<T>(endpoint, params, true);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new ProviderApiError(`API error on ${endpoint}`, response.status, body);
    }

    return (await response.json()) as T;
  }

  private async fetchWithRetry(url: string, token: string): Promise<Response> {
    const delays = [1000, 2000, 4000];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        throw new ProviderNetworkError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (response.status !== 429) {
        return response;
      }

      if (attempt >= delays.length) {
        const retryAfter = response.headers.get('Retry-After');
        throw new ProviderRateLimitError(
          'Rate limit exceeded after retries',
          retryAfter ? parseInt(retryAfter, 10) : null,
        );
      }

      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : delays[attempt];
      console.log(`[provider] 429 rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${delays.length})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new ProviderRateLimitError('Rate limit exceeded', null);
  }
}
