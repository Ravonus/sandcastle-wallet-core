import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BitcoinEsploraApiProvider,
  checkAccountActivity,
  createTransactionContext,
  defaultRegtest,
  fetchBtcOrdinalsData,
  getAccountFromSeedPhrase,
  getNonOrdinalUtxo,
  getOrdinalsFtBalance,
  getBrc20History,
  getRunesClient,
  getStacksApiClient,
  getXverseApiClient,
  RegtestOrdinalsApi,
  SeedVault,
  StacksTestnet,
  UtxoCache,
  btcTransaction,
  type ExtendedStorageAdapter,
} from '../../index';

const btcOrigin = 'http://localhost:19545';
const ordOrigin = 'http://localhost:19546';
const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const payment = 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk';
const recipient = '2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2';
const ordinalAddress = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';
const spendableTxid = '11'.repeat(32);
const protectedTxid = '22'.repeat(32);
const unknownTxid = '33'.repeat(32);
const inscribedOutpoint = `${protectedTxid}:1`;
const cleanOutpoint = `${spendableTxid}:0`;
const unknownOutpoint = `${unknownTxid}:0`;
const first = `${'44'.repeat(32)}i0`;
const second = `${'55'.repeat(32)}i0`;
const missing = `${'66'.repeat(32)}i0`;
const confirmed = { confirmed: true, block_height: 460, block_time: 1_700_000_000 };
const spendable = { txid: spendableTxid, vout: 0, status: confirmed, value: 3000 };
const inscribed = { txid: protectedTxid, vout: 1, status: confirmed, value: 10000 };
const unknown = { txid: unknownTxid, vout: 0, status: confirmed, value: 20000 };

const settings = { ...defaultRegtest, btcApiUrl: `${btcOrigin}/api`, ordApiUrl: ordOrigin };
const btcRead = () => nock(btcOrigin);
const ordRead = () => nock(ordOrigin, { reqheaders: { Accept: 'application/json' } });
const output = (value: number, inscriptions: string[]) => ({
  indexed: true,
  spent: false,
  runes: null,
  sat_ranges: null,
  address: payment,
  value,
  inscriptions,
});
const inscription = (number: number, offset: number) => ({
  number,
  sat: null,
  satpoint: `${inscribedOutpoint}:${offset}`,
  address: payment,
  value: inscribed.value,
  fee: 225,
  height: 459,
  timestamp: 1_699_999_900,
  content_type: 'image/png',
  content_length: 714,
});
const provider = () => BitcoinEsploraApiProvider.fromSettings(settings);

const noMatch = vi.fn();
beforeEach(() => {
  nock.disableNetConnect();
  noMatch.mockClear();
  nock.emitter.on('no match', noMatch);
});
afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  nock.emitter.removeListener('no match', noMatch);
  expect(pending).toEqual([]);
  expect(noMatch).not.toHaveBeenCalled();
});

async function walletContext() {
  const electrsApi = provider();
  const regtestOrdinals = new RegtestOrdinalsApi(electrsApi);
  const utxoCache = new UtxoCache({
    network: 'Regtest',
    electrsApi,
    regtestOrdinals,
    cacheStorageController: {} as ExtendedStorageAdapter,
  });
  const account = await getAccountFromSeedPhrase({ index: 0n, mnemonic: seed, network: 'Regtest' });
  const context = createTransactionContext({
    esploraApiProvider: electrsApi,
    seedVault: { getSeed: async () => seed } as SeedVault,
    account,
    utxoCache,
    network: 'Regtest',
    btcPaymentAddressType: 'native',
  });
  return { electrsApi, regtestOrdinals, account, utxoCache, context };
}

describe('Regtest ord', () => {
  it('joins current UTXOs to deduplicated inscription IDs, keeps number zero, and emits standalone collections', async () => {
    btcRead().get(`/api/address/${payment}/utxo`).times(4).reply(200, [inscribed, inscribed]);
    ordRead()
      .get(`/output/${inscribedOutpoint}`)
      .times(4)
      .reply(200, output(inscribed.value, [second, first, first, missing]))
      .get(`/inscription/${first}`)
      .twice()
      .reply(200, inscription(0, 37))
      .get(`/inscription/${second}`)
      .twice()
      .reply(200, inscription(8, 41))
      .get(`/inscription/${missing}`)
      .times(3)
      .reply(404);

    const bitcoin = provider();
    const ord = new RegtestOrdinalsApi(bitcoin);
    const [items, collections] = await Promise.all([
      ord.getInscriptions(payment, 0, 1),
      ord.getCollections(payment, 0, 1, { starredCollectibleIds: [second] }),
    ]);
    expect(items).toMatchObject({
      limit: 1,
      offset: 0,
      total: 2,
      results: [
        {
          id: first,
          number: 0,
          genesis_tx_id: first.slice(0, 64),
          tx_id: protectedTxid,
          address: payment,
          output: inscribedOutpoint,
          location: `${inscribedOutpoint}:37`,
          value: '10000',
          offset: '37',
          mime_type: 'image/png',
          content_type: 'image/png',
          content_length: 714,
          genesis_fee: '225',
          genesis_block_height: 459,
          genesis_timestamp: 1_699_999_900,
        },
      ],
    });
    expect(items.results[0].sat_ordinal).toBeUndefined();
    expect(collections).toEqual({
      offset: 0,
      limit: 1,
      total: 3,
      total_inscriptions: 3,
      results: [
        {
          collection_id: null,
          collection_name: null,
          category: null,
          total_inscriptions: 1,
          thumbnail_inscriptions: [{ id: second, number: 8, content_type: 'image/png' }],
        },
      ],
    });
    expect(
      await ord.getCollections(payment, 0, 5, { hiddenCollectibleIds: [first], showHiddenOnly: true }),
    ).toMatchObject({ total: 1, results: [{ thumbnail_inscriptions: [{ id: first, number: 0 }] }] });
    expect(await ord.getAddressInscription(payment, missing)).toMatchObject({
      id: missing,
      output: inscribedOutpoint,
      offset: '',
      detailsUnavailable: true,
    });
    expect(ord.getContentUrl(first)).toBe(`${ordOrigin}/content/${first}`);
    const joined = await fetchBtcOrdinalsData(payment, bitcoin, 'Regtest');
    expect(joined.map(({ id }) => id)).toEqual([second, first, missing]);
    expect(joined[0]).toMatchObject({ confirmationTime: confirmed.block_time, utxo: inscribed });
  });

  it('funds BTC and explicit ordinal sends only with clean fee coins', async () => {
    btcRead().persist().get(`/api/address/${payment}/utxo`).reply(200, [inscribed, unknown, spendable]);
    btcRead().persist().get(`/api/tx/${spendableTxid}/outspend/0`).reply(200, { spent: false });
    btcRead().persist().get(`/api/tx/${spendableTxid}`).reply(404);
    ordRead()
      .persist()
      .get(`/output/${inscribedOutpoint}`)
      .reply(200, output(inscribed.value, [first, second]));
    ordRead().persist().get(`/output/${unknownOutpoint}`).reply(404);
    ordRead().persist().get(`/output/${cleanOutpoint}`).reply(200, output(spendable.value, []));
    ordRead().persist().get(`/inscription/${first}`).reply(200, inscription(0, 37));
    ordRead().persist().get(`/inscription/${second}`).reply(200, inscription(8, 37));

    const { context } = await walletContext();
    const send = await btcTransaction.sendBtc(context, [{ toAddress: recipient, amount: 1000n }], 1);
    expect((await send.getSummary()).inputs.map((input) => input.extendedUtxo.outpoint)).toEqual([cleanOutpoint]);

    await expect(
      btcTransaction.sendOrdinalsWithSplit(context, [{ toAddress: recipient, inscriptionId: first }], 1),
    ).rejects.toThrow('multiple inscriptions or an unknown offset');
    const ordinalSend = await btcTransaction.sendOrdinals(
      context,
      [{ toAddress: recipient, outpoint: inscribedOutpoint }],
      1,
    );
    const summary = await ordinalSend.getSummary();
    expect(summary.inputs.map((input) => input.extendedUtxo.outpoint)).toEqual([inscribedOutpoint, cleanOutpoint]);
    expect(summary.outputs.find((entry) => entry.type === 'address' && entry.address === recipient)).toMatchObject({
      inscriptions: [
        { id: first, offset: 37, number: 0 },
        { id: second, offset: 37, number: 8 },
      ],
    });

    const tooLarge = await btcTransaction.sendBtc(context, [{ toAddress: recipient, amount: 5000n }], 1);
    await expect(tooLarge.getSummary()).rejects.toThrow('Insufficient funds from Regtest UTXOs confirmed clean by ord');
    const pinned = await btcTransaction.sendBtc(context, [{ toAddress: recipient, amount: 1000n }], 1, {
      forceIncludeOutpointList: [inscribedOutpoint],
    });
    await expect(pinned.getSummary()).rejects.toThrow('is not confirmed clean by ord');
    await expect(btcTransaction.combineUtxos(context, [unknownOutpoint], recipient, 1)).rejects.toThrow(
      'is not confirmed clean by ord',
    );
    const max = await btcTransaction.sendMaxBtc(context, recipient, 1, false);
    expect((await max.transaction.getSummary()).inputs.map((input) => input.extendedUtxo.outpoint)).toEqual([
      cleanOutpoint,
    ]);
  });

  it('reads Regtest bundles before either hosted cache path and preserves unresolved IDs', async () => {
    ordRead()
      .get(`/output/${inscribedOutpoint}`)
      .twice()
      .reply(200, output(inscribed.value, [missing]))
      .get(`/inscription/${missing}`)
      .twice()
      .reply(404);
    const { utxoCache } = await walletContext();
    const bundle = await utxoCache.getUtxoByOutpoint(inscribedOutpoint, payment);
    expect(bundle).toMatchObject({ sat_ranges: [], localInscriptions: { ids: [missing], located: [] } });
    expect(await utxoCache.getUtxoByOutpoint(inscribedOutpoint, payment, true)).toEqual(bundle);
  });

  it('rejects a selective split when the only held inscription has an unknown offset', async () => {
    btcRead().get(`/api/address/${payment}/utxo`).reply(200, [inscribed]);
    ordRead()
      .get(`/output/${inscribedOutpoint}`)
      .reply(200, output(inscribed.value, [missing]));
    ordRead().get(`/inscription/${missing}`).reply(404);
    const { context } = await walletContext();
    await expect(
      btcTransaction.sendOrdinalsWithSplit(context, [{ toAddress: recipient, inscriptionId: missing }], 1),
    ).rejects.toThrow('multiple inscriptions or an unknown offset');
  });

  it('rejects unindexed, spent, mismatched, and unavailable outputs for funding', async () => {
    mockUnavailableFundingOutputs();
    const { electrsApi } = await walletContext();
    expect(await getNonOrdinalUtxo(payment, electrsApi, 'Regtest')).toEqual([]);
  });

  it('settles hosted reads locally and does not check Stacks for account activity', async () => {
    const { electrsApi, account } = await walletContext();
    btcRead()
      .get(`/api/address/${ordinalAddress}/utxo`)
      .reply(200, [])
      .get(`/api/address/${payment}/utxo`)
      .reply(200, [])
      .get(`/api/address/${recipient}/utxo`)
      .reply(200, []);
    expect(await checkAccountActivity(account, StacksTestnet, electrsApi)).toBe(false);
    const stacks = getStacksApiClient('Regtest');
    expect(await stacks.getAllTransactions({ stxAddress: account.stxAddress, offset: 0, limit: 20 })).toEqual([]);
    expect((await stacks.getAddressBalance(account.stxAddress)).totalBalance.isZero()).toBe(true);
    expect(await stacks.getTransaction('not-on-regtest')).toBeUndefined();
    expect(getStacksApiClient('Testnet')).not.toBe(stacks);
    const client = getXverseApiClient('Regtest');
    expect(await client.getAppFeatures()).toEqual({});
    expect(await client.getCoinsMarketData(['bitcoin'])).toEqual([]);
    expect(await client.fetchBtcToCurrencyRate({ fiatCurrency: 'USD' })).toBeUndefined();
    expect(await client.getCollections(payment)).toMatchObject({ total: 0, results: [] });
    expect(await getRunesClient('Regtest').getRuneBalances(payment)).toEqual([]);
    expect(await getRunesClient('Regtest').getDecodedRuneScript('00')).toBeUndefined();
    expect(await getOrdinalsFtBalance('Regtest', payment)).toEqual([]);
    expect(await getBrc20History('Regtest', payment, 'test')).toEqual([]);
  });
});

function mockUnavailableFundingOutputs() {
  const mismatchTxid = '77'.repeat(32);
  const spentTxid = '88'.repeat(32);
  btcRead()
    .get(`/api/address/${payment}/utxo`)
    .reply(200, [
      spendable,
      inscribed,
      unknown,
      { ...spendable, txid: mismatchTxid },
      { ...spendable, txid: spentTxid },
    ]);
  ordRead()
    .get(`/output/${cleanOutpoint}`)
    .reply(200, { ...output(spendable.value, []), indexed: false })
    .get(`/output/${inscribedOutpoint}`)
    .reply(200, output(inscribed.value, [first]))
    .get(`/output/${unknownOutpoint}`)
    .reply(503)
    .get(`/output/${mismatchTxid}:0`)
    .reply(200, output(spendable.value - 1, []))
    .get(`/output/${spentTxid}:0`)
    .reply(200, { ...output(spendable.value, []), spent: true });
}
