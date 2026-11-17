import axios from 'axios';

export class RegtestApiConfigurationError extends Error {
  readonly code = 'REGTEST_API_NOT_CONFIGURED';

  constructor(readonly endpoint: 'bitcoin' | 'ord') {
    super('Regtest API URL is not configured');
    this.name = 'RegtestApiConfigurationError';
  }
}

export function regtestApiUrl(value: string | undefined, endpoint: 'bitcoin' | 'ord'): string {
  try {
    const url = new URL(value?.trim() ?? '');
    const hosted = /(^|\.)(xverse\.app|mempool\.space|sbtc-mempool\.tech|hiro\.so|gamma\.io|ordinals\.com)\.?$/i;
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !hosted.test(url.hostname)
    ) {
      return url.href.replace(/\/+$/, '');
    }
  } catch {
    // Report missing and invalid configuration through the same settings error.
  }
  throw new RegtestApiConfigurationError(endpoint);
}

export const REGTEST_API_TIMEOUT = 5000;

export function isNotFound(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404;
}

export async function getRegtestOrdJson<T>(ordApiUrl: string | undefined, path: string): Promise<T> {
  const url = regtestApiUrl(ordApiUrl, 'ord');
  const { data } = await axios.get<T>(`${url}${path}`, {
    headers: { Accept: 'application/json' },
    timeout: REGTEST_API_TIMEOUT,
    maxRedirects: 0,
  });
  return data;
}
