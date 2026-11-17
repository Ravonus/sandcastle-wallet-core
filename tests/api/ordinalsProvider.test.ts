import nock from 'nock';
import { expect, it } from 'vitest';
import { OrdinalsApi } from '../../api/ordinals/provider';
import { XORD_URL } from '../../constant';

it.each(['Mainnet', 'Testnet', 'Signet'] as const)(
  'continues hosted %s pagination after a short page',
  async (network) => {
    const address = 'wallet-address';
    const server = nock(XORD_URL(network));
    for (const [offset, limit, results] of [
      [0, 60, [{ id: 'first' }]],
      [2, 2, [{ id: 'second' }]],
      [4, 2, []],
    ] as const) {
      server
        .get('/v1/inscriptions')
        .query({ address, offset, limit })
        .reply(200, { offset, limit: 2, total: 4, results });
    }
    expect(await new OrdinalsApi({ network }).getAllInscriptions(address)).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(server.isDone()).toBe(true);
  },
);
