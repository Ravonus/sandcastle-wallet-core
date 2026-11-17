import { describe, expect, it } from 'vitest';
import { RegtestApiConfigurationError, regtestApiUrl } from '../../api/regtest';

describe('Regtest endpoint URLs', () => {
  it.each([
    ['http://host', 'http://host'],
    ['http://host:19445', 'http://host:19445'],
    ['http://host:19445/api', 'http://host:19445/api'],
    ['https://host/api', 'https://host/api'],
    ['http://192.0.2.5:3002', 'http://192.0.2.5:3002'],
    ['localhost:3002/api', 'http://localhost:3002/api'],
    ['host:19445', 'http://host:19445'],
    ['host', 'http://host'],
    ['host/api', 'http://host/api'],
  ])('normalizes %s with or without trailing slashes', (entered, normalized) => {
    for (const suffix of ['', '/', '///']) {
      expect(regtestApiUrl(` ${entered}${suffix} `, 'bitcoin')).toBe(normalized);
      expect(regtestApiUrl(` ${entered}${suffix} `, 'ord')).toBe(normalized);
    }
  });

  it.each([
    '',
    '/api',
    'http:/host',
    'ftp://host/api',
    'http://user:pass@host/api',
    'user@host:19445',
    'http://@host',
    'http://host/api?query=1',
    'host/api?',
    'http://host/api#section',
    'host/api#',
    'https://api.xverse.app/api',
    'mempool.space:19445/api',
    'https://api.testnet.hiro.so.',
    'https://gamma.io',
    'https://gamma.mypinata.cloud/ipfs',
    'https://api.unisat.io',
    'ordinals.com',
    'sbtc-mempool.tech',
  ])('rejects invalid or hosted input %s', (input) => {
    expect(() => regtestApiUrl(input, 'ord')).toThrow(RegtestApiConfigurationError);
  });
});
