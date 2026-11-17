import { Transaction } from 'bitcoinjs-lib';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BitcoinEsploraApiProvider,
  defaultRegtest,
  fetchBtcTransaction,
  getRegtestBtcFeeRate,
  getRecommendedFees,
  getXverseApiClient,
  RegtestApiConfigurationError,
} from '../../index';

const origin = 'http://localhost:19445';
const ordOrigin = 'http://localhost:19446';
const address = 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk';
const blockHash = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const settings = { ...defaultRegtest, btcApiUrl: `${origin}/api/`, ordApiUrl: ordOrigin };
const bitcoin = () => BitcoinEsploraApiProvider.fromSettings(settings);

const parent = new Transaction();
parent.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from('0101', 'hex'));
parent.addOutput(Buffer.from('00145686c24d85737a2f5168f514f9d33a2753e687ff', 'hex'), 4321);
const txid = parent.getId();
const raw = parent.toHex();
const confirmed = { confirmed: true, block_height: 560, block_time: 1_700_000_000 };
const utxo = { txid, vout: 0, value: 4321, status: confirmed };
const sparse = {
  txid,
  vin: [{ is_coinbase: true }],
  vout: [{ scriptpubkey_address: address, value: utxo.value }],
  status: confirmed,
};

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  nock.enableNetConnect();
  expect(pending).toEqual([]);
});

describe('Regtest Esplora', () => {
  it('leaves endpoint defaults blank and rejects a missing Bitcoin URL before HTTP', async () => {
    expect(defaultRegtest).toMatchObject({ address: '', btcApiUrl: '', ordApiUrl: '', fallbackBtcApiUrl: '' });
    const client = BitcoinEsploraApiProvider.fromSettings(defaultRegtest);
    await expect(client.getUnspentUtxos(address)).rejects.toMatchObject({
      name: 'RegtestApiConfigurationError',
      code: 'REGTEST_API_NOT_CONFIGURED',
      endpoint: 'bitcoin',
      message: 'Regtest API URL is not configured',
    });
    await expect(getRecommendedFees('Regtest')).rejects.toBeInstanceOf(RegtestApiConfigurationError);
  });

  it('sums UTXOs, uses presence for discovery, and caches unavailable address routes by base', async () => {
    const secondAddress = 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg';
    nock(origin)
      .get(`/api/address/${address}`)
      .reply(404)
      .get(`/api/address/${address}/utxo`)
      .twice()
      .reply(200, [utxo])
      .get(`/api/address/${address}/txs`)
      .reply(404)
      .get(`/api/address/${address}/txs/mempool`)
      .reply(404)
      .get(`/api/address/${secondAddress}/utxo`)
      .reply(200, []);
    const client = bitcoin();
    const [balance, history] = await Promise.all([client.getBalance(address), client.getAddressTransactions(address)]);
    expect(history).toEqual([]);
    expect(balance).toMatchObject({
      finalBalance: 4321,
      finalNTx: 0,
      totalReceived: 0,
      unconfirmedBalance: 0,
      historyAvailable: false,
    });
    const [activity, duplicateActivity] = await Promise.all([
      client.hasAddressActivity(address),
      bitcoin().hasAddressActivity(address),
    ]);
    expect(activity && duplicateActivity).toBe(true);
    expect(await bitcoin().getBalance(secondAddress)).toMatchObject({ finalBalance: 0 });
    expect(await bitcoin().getAddressTransactions(secondAddress)).toEqual([]);
    expect(await client.getAddressMempoolTransactions(address)).toEqual([]);
    expect(await client.getAddressMempoolTransactions(secondAddress)).toEqual([]);
  });

  it('reads sparse transactions, single-vout spends, and ord height, block hash, and transaction hex', async () => {
    nock(origin)
      .get(`/api/tx/${txid}`)
      .times(3)
      .reply(200, sparse)
      .get(`/api/tx/${txid}/outspends`)
      .reply(404)
      .get(`/api/tx/${txid}/outspend/0`)
      .reply(200, { spent: false })
      .get(`/api/tx/${txid}/hex`)
      .reply(404)
      .get('/api/blocks/tip/height')
      .reply(404)
      .get('/api/blocks/tip/hash')
      .reply(200, blockHash)
      .get('/api/block-height/0')
      .reply(404)
      .get('/api/status')
      .reply(200, { ok: true, network: 'regtest' });
    nock(ordOrigin, { reqheaders: { Accept: 'application/json' } })
      .get('/r/blockheight')
      .reply(200, '561')
      .get('/r/blockhash/0')
      .reply(200, JSON.stringify(blockHash), { 'Content-Type': 'application/json' })
      .get(`/r/tx/${txid}`)
      .twice()
      .reply(200, JSON.stringify(raw), { 'Content-Type': 'application/json' });

    const client = bitcoin();
    expect(await fetchBtcTransaction(txid, address, '', client)).toMatchObject({ txid, confirmed: true, total: 4321 });
    expect(await client.getTransactionOutspend(txid, 0)).toEqual({ spent: false });
    expect(await client.getTransactionHex(txid)).toBe(raw);
    expect(await bitcoin().getTransactionHex(txid)).toBe(raw);
    expect(await client.getLatestBlockHeight()).toBe(561);
    expect(await client.getBlockHash(0)).toBe(blockHash);
    expect(await client.getTipHash()).toBe(blockHash);
    expect(await client.getRegtestStatus()).toMatchObject({ ok: true, network: 'regtest' });
  });

  it('uses the local fee endpoint with a 1 sat/vB fallback and posts raw hex with no retries', async () => {
    nock(origin)
      .get('/api/fee-estimates')
      .reply(404)
      .get('/api/v1/fees/recommended')
      .twice()
      .reply(200, {
        economyFee: 1,
        fastestFee: 5,
        halfHourFee: 3,
        hourFee: 2,
        minimumFee: 1,
      })
      .post('/api/tx', raw)
      .matchHeader('content-type', 'text/plain')
      .reply(200, ` ${txid}\n`)
      .post('/api/tx', raw)
      .reply(503);
    expect(await getRecommendedFees(settings)).toMatchObject({ fastestFee: 5, minimumFee: 1 });
    expect(await getXverseApiClient(settings).fetchBtcFeeRate()).toEqual({
      regular: 3,
      priority: 5,
      limits: { min: 1, max: 5 },
    });
    const client = bitcoin();
    expect(await client.sendRawTransaction(raw)).toEqual({ tx: { hash: txid } });
    await expect(client.sendRawTransaction(raw)).rejects.toMatchObject({ response: { status: 503 } });

    const noFees = 'http://localhost:19447';
    nock(noFees).get('/fee-estimates').reply(404).get('/v1/fees/recommended').reply(404);
    const withoutFees = new BitcoinEsploraApiProvider({ network: 'Regtest', url: noFees });
    expect(await getRegtestBtcFeeRate(withoutFees)).toEqual({ regular: 1, priority: 1, limits: { min: 1, max: 1 } });
    expect(await getRegtestBtcFeeRate(withoutFees)).toEqual({ regular: 1, priority: 1, limits: { min: 1, max: 1 } });
  });

  it('uses standard endpoints on a full Esplora and does not confuse an unknown txid with a missing route', async () => {
    const full = 'http://localhost:19448';
    const missingTxid = 'ff'.repeat(32);
    const stats = { tx_count: 10, funded_txo_sum: 8000, spent_txo_sum: 1000 };
    nock(full)
      .get(`/address/${address}`)
      .reply(200, { address, chain_stats: stats, mempool_stats: stats })
      .get(`/address/${address}/txs`)
      .reply(200, [sparse])
      .get('/blocks/tip/height')
      .reply(200, '561')
      .get('/fee-estimates')
      .reply(200, { '1': 5, '3': 2.5, '6': 2, '144': 1 })
      .get(`/tx/${missingTxid}/hex`)
      .reply(404)
      .get(`/tx/${missingTxid}`)
      .reply(404)
      .get(`/tx/${txid}/hex`)
      .reply(200, raw)
      .get(`/tx/${txid}/outspends`)
      .reply(200, [{ spent: false }]);
    const client = new BitcoinEsploraApiProvider({ network: 'Regtest', url: full });
    expect(await client.getBalance(address)).toMatchObject({ finalBalance: 7000, finalNTx: 10 });
    expect(await client.getAddressTransactions(address)).toEqual([sparse]);
    expect(await client.getLatestBlockHeight()).toBe(561);
    expect(await getRegtestBtcFeeRate(client)).toEqual({ regular: 3, priority: 5, limits: { min: 1, max: 5 } });
    expect(await client.getTransactionHex(missingTxid)).toBeUndefined();
    expect(await client.getTransactionHex(txid)).toBe(raw);
    expect(await client.getTransactionOutspend(txid, 0)).toEqual({ spent: false });
  });
  it('filters submitted outpoints across clients until their address scan drops them', async () => {
    const base = 'http://localhost:19452';
    const shared = new Map<string, string>();
    const storage = {
      get: (key: string) => shared.get(key) ?? null,
      set: (key: string, value: string) => {
        shared.set(key, value);
      },
    };
    const client = (btcApiUrl = base) => BitcoinEsploraApiProvider.fromSettings({ ...settings, btcApiUrl }, storage);
    const spend = new Transaction();
    spend.addInput(parent.getHash(), 0);
    spend.addOutput(parent.outs[0].script, 4000);
    nock(base)
      .get(`/address/${address}/utxo`)
      .twice()
      .reply(200, [utxo])
      .post('/tx', spend.toHex())
      .reply(200, spend.getId())
      .get(`/address/${address}/utxo`)
      .reply(200, [])
      .get(`/address/${address}/utxo`)
      .reply(200, [utxo]);
    const sender = client();
    expect(await sender.getUnspentUtxos(address)).toMatchObject([utxo]);
    await sender.sendRawTransaction(spend.toHex());
    expect(await client().getUnspentUtxos(address)).toEqual([]);
    expect(await client().isRegtestFundingAvailable(utxo)).toBe(false);
    const otherBase = 'http://localhost:19455';
    nock(otherBase).get(`/address/${address}/utxo`).reply(200, [utxo]);
    expect(await client(otherBase).getUnspentUtxos(address)).toMatchObject([utxo]);
    expect(await client().getUnspentUtxos(address)).toEqual([]);
    expect([...shared.values()]).toEqual(['{}']);
    expect(await client().getUnspentUtxos(address)).toMatchObject([utxo]);
  });

  it('checks the single outspend and the 100-confirmation coinbase boundary', async () => {
    const base = 'http://localhost:19453';
    const client = new BitcoinEsploraApiProvider({ network: 'Regtest', url: base });
    nock(base)
      .get(`/tx/${txid}`)
      .times(3)
      .reply(200, sparse)
      .get(`/tx/${txid}/outspend/0`)
      .reply(200, { spent: true })
      .get(`/tx/${txid}/outspend/0`)
      .reply(404)
      .get(`/tx/${txid}/outspend/0`)
      .reply(200, { spent: false })
      .get('/blocks/tip/height')
      .reply(200, '658')
      .get('/blocks/tip/height')
      .reply(200, '659');
    expect(await client.isRegtestFundingAvailable(utxo)).toBe(false);
    expect(await client.isRegtestFundingAvailable(utxo)).toBe(false);
    expect(await client.isRegtestFundingAvailable(utxo)).toBe(true);
  });

  it('does not disable the block-height route on an unknown height', async () => {
    const base = 'http://localhost:19454';
    const client = new BitcoinEsploraApiProvider({ network: 'Regtest', url: base });
    nock(base).get('/block-height/99999').reply(404).get('/block-height/0').reply(200, blockHash);
    await expect(client.getBlockHash(99999)).rejects.toBeInstanceOf(RegtestApiConfigurationError);
    expect(await client.getBlockHash(0)).toBe(blockHash);
  });
});
