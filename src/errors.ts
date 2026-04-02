export class ProviderAuthError extends Error {
  readonly code = 'PROVIDER_AUTH_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderRateLimitError extends Error {
  readonly code = 'PROVIDER_RATE_LIMIT';
  readonly retryAfter: number | null;
  constructor(message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'ProviderRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ProviderApiError extends Error {
  readonly code = 'PROVIDER_API_ERROR';
  readonly statusCode: number;
  readonly responseBody: string;
  constructor(message: string, statusCode: number, responseBody: string) {
    super(message);
    this.name = 'ProviderApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class ProviderNetworkError extends Error {
  readonly code = 'PROVIDER_NETWORK_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNetworkError';
  }
}

export function formatToolError(err: unknown): { content: Array<{ type: 'text'; text: string }> } {
  if (err instanceof ProviderApiError) {
    console.error(`[error] ${err.code} (${err.statusCode}): ${err.message}`, err.responseBody);
  } else if (err instanceof Error) {
    console.error(`[error] ${err.name}: ${err.message}`);
  }

  if (err instanceof ProviderAuthError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: true, code: err.code, message: 'Authentication failed — check provider credentials' }) }],
    };
  }
  if (err instanceof ProviderRateLimitError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: true, code: err.code, message: 'Rate limited by provider API — please retry shortly', retryAfter: err.retryAfter }) }],
    };
  }
  if (err instanceof ProviderApiError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: true, code: err.code, message: `Provider API error (${err.statusCode})` }) }],
    };
  }
  if (err instanceof ProviderNetworkError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: true, code: err.code, message: 'Unable to reach provider API' }) }],
    };
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: true, code: 'UNKNOWN_ERROR', message }) }],
  };
}
