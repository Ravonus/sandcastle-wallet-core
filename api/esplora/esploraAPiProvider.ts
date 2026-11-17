import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { Mutex } from 'async-mutex';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import axiosRetry from 'axios-retry';
import {
  XVERSE_BTC_BASE_URI_MAINNET,
  XVERSE_BTC_BASE_URI_SIGNET,
  XVERSE_BTC_BASE_URI_TESTNET,
  XVERSE_BTC_BASE_URI_TESTNET4,
} from '../../constant';
import {
  Address,
  BtcAddressBalanceResponse,
  BtcAddressMempool,
  BtcTransactionBroadcastResponse,
  EsploraTransaction,
  FeeEstimates,
  NetworkType,
  RecommendedFeeResponse,
  SettingsNetwork,
  StorageAdapter,
  TransactionOutspend,
  UTXO,
} from '../../types';
import { AxiosRateLimit } from '../../utils/axiosRateLimit';
import { getRegtestOrdJson, isNotFound, regtestApiUrl, regtestTransport, REGTEST_API_TIMEOUT } from '../regtest';

export interface EsploraApiProviderOptions {
  network: NetworkType;
  url?: string;
  fallbackUrl?: string;
  ordApiUrl?: string;
  pendingSpendStorage?: Pick<StorageAdapter, 'get' | 'set'>;
}

const unsupportedRoutes = new Map<string, Set<string>>();
const scanQueues = new Map<string, Mutex>();
const pendingScans = new Map<string, Promise<UTXO[]>>();
const pendingSpendQueues = new Map<string, Mutex>();
const outpoint = ({ txid, vout }: Pick<UTXO, 'txid' | 'vout'>) => `${txid}:${vout}`;
type PendingSpends = Record<string, string | null>;

const minimumFees: RecommendedFeeResponse = {
  economyFee: 1,
  fastestFee: 1,
  halfHourFee: 1,
  hourFee: 1,
  minimumFee: 1,
};

export type RegtestEsploraStatus = { ok: boolean; network: string };

export class BitcoinEsploraApiProvider {
  readonly ordApiUrl?: string;

  private readonly pendingSpendStorage?: EsploraApiProviderOptions['pendingSpendStorage'];
  private readonly scannedOutpointAddresses = new Map<string, string>();

  static fromSettings(
    settings: SettingsNetwork,
    pendingSpendStorage?: EsploraApiProviderOptions['pendingSpendStorage'],
  ): BitcoinEsploraApiProvider {
    return new BitcoinEsploraApiProvider({
      network: settings.type,
      url: settings.btcApiUrl,
      fallbackUrl: settings.fallbackBtcApiUrl,
      ordApiUrl: settings.ordApiUrl,
      pendingSpendStorage,
    });
  }

  bitcoinApi: AxiosInstance;

  rateLimiter: AxiosRateLimit;

  fallbackBitcoinApi?: AxiosInstance;

  fallbackRateLimiter?: AxiosRateLimit;

  _network: NetworkType;

  constructor(options: EsploraApiProviderOptions) {
    const { url, network, fallbackUrl, ordApiUrl } = options;
    this.ordApiUrl = ordApiUrl;
    this.pendingSpendStorage = options.pendingSpendStorage;
    let baseURL = url;

    if (!baseURL) {
      switch (network) {
        case 'Mainnet':
          baseURL = XVERSE_BTC_BASE_URI_MAINNET;
          break;
        case 'Testnet':
          baseURL = XVERSE_BTC_BASE_URI_TESTNET;
          break;
        case 'Testnet4':
          baseURL = XVERSE_BTC_BASE_URI_TESTNET4;
          break;
        case 'Signet':
          baseURL = XVERSE_BTC_BASE_URI_SIGNET;
          break;
        case 'Regtest':
          baseURL = '';
          break;
        default:
          throw new Error('Invalid network');
      }
    }
    const axiosConfig: AxiosRequestConfig =
      network === 'Regtest' ? { baseURL, timeout: REGTEST_API_TIMEOUT, ...regtestTransport } : { baseURL };

    this._network = network;
    this.bitcoinApi = axios.create(axiosConfig);

    this.rateLimiter = new AxiosRateLimit(this.bitcoinApi, {
      maxRPS: 10,
    });

    if (network === 'Regtest') {
      this.bitcoinApi.interceptors.request.use((request) => {
        request.baseURL = regtestApiUrl(baseURL, 'bitcoin');
        return request;
      });
      return;
    }

    axiosRetry(this.bitcoinApi, {
      retries: 1,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        if (error?.response?.status === 429 || (error?.response?.status ?? 0) >= 500) {
          return true;
        }
        return false;
      },
    });

    if (fallbackUrl) {
      this.fallbackBitcoinApi = axios.create({ ...axiosConfig, baseURL: fallbackUrl });

      this.fallbackRateLimiter = new AxiosRateLimit(this.fallbackBitcoinApi, {
        maxRPS: 10,
      });

      this.bitcoinApi.interceptors.response.use(
        // if the request succeeds, we do nothing.
        (response) => response,
        (error) => {
          if (!this.fallbackBitcoinApi) {
            return Promise.reject(error);
          }

          const requestTimedOut = error?.code === 'ECONNABORTED';
          const serverError = error?.response?.status >= 500;
          const addressHasTooManyUtxos =
            error?.response?.status === 400 &&
            typeof error.response.data === 'string' &&
            error.response.data.includes('Too many unspent transaction outputs');
          const rateLimitError = error?.response?.status === 429;

          if (requestTimedOut || serverError || addressHasTooManyUtxos || rateLimitError) {
            return this.fallbackBitcoinApi.request({
              ...error.config,
              baseURL: fallbackUrl,
            });
          }

          return Promise.reject(error);
        },
      );
    }
  }

  private async httpGet<T>(
    url: string,
    params: unknown = {},
    reqConfig: Omit<AxiosRequestConfig, 'params'> = {},
  ): Promise<T> {
    const response = await this.bitcoinApi.get<T>(url, { ...reqConfig, params });
    return response.data;
  }

  private async httpPost<T>(url: string, data: unknown): Promise<T> {
    const response = await this.bitcoinApi.post(url, data);
    return response.data;
  }

  private async optionalRegtestRoute<T>(
    route: string,
    path: string,
    parentTxid?: string,
    cache404 = true,
  ): Promise<T | undefined> {
    const base = regtestApiUrl(this.bitcoinApi.defaults.baseURL, 'bitcoin');
    let unsupported = unsupportedRoutes.get(base);
    if (!unsupported) {
      unsupported = new Set();
      unsupportedRoutes.set(base, unsupported);
    }
    if (unsupported.has(route)) return undefined;

    try {
      return await this.httpGet<T>(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // A full Esplora also returns 404 for an unknown transaction.
      if (cache404 && (!parentTxid || (await this.getTransaction(parentTxid).catch(() => undefined)))) {
        unsupported.add(route);
      }
      return undefined;
    }
  }

  private getRegtestUtxos(address: string): Promise<UTXO[]> {
    const base = regtestApiUrl(this.bitcoinApi.defaults.baseURL, 'bitcoin');
    const path = `/address/${address}/utxo`;
    const key = base + path;
    const pending = pendingScans.get(key);
    if (pending) return pending;

    let queue = scanQueues.get(base);
    if (!queue) {
      queue = new Mutex();
      scanQueues.set(base, queue);
    }
    const read = () => this.httpGet<UTXO[]>(path);
    const scan = queue
      .runExclusive(() => {
        // Extension pages and their service worker share an origin, but not the in-memory queue.
        const locks = globalThis.navigator?.locks;
        return locks ? locks.request(`sandcastle:regtest-scan:${base}`, read) : read();
      })
      .finally(() => pendingScans.delete(key));
    pendingScans.set(key, scan);
    return scan;
  }

  private get pendingSpendKey() {
    return `sandcastle:pending-spends:${this._network}:${regtestApiUrl(this.bitcoinApi.defaults.baseURL, 'bitcoin')}`;
  }

  private async withPendingSpends<T>(action: (spends: PendingSpends, save: () => Promise<void>) => Promise<T>) {
    const storage = this.pendingSpendStorage!;
    const key = this.pendingSpendKey;
    const run = async () => {
      const spends: PendingSpends = JSON.parse((await storage.get(key)) ?? '{}');
      return action(spends, async () => {
        await storage.set(key, JSON.stringify(spends));
      });
    };
    const locks = globalThis.navigator?.locks;
    if (locks) return locks.request(key, run);
    let queue = pendingSpendQueues.get(key);
    if (!queue) {
      queue = new Mutex();
      pendingSpendQueues.set(key, queue);
    }
    return queue.runExclusive(run);
  }

  private async filterPendingSpends(address: string, coins: UTXO[]): Promise<UTXO[]> {
    if (!this.pendingSpendStorage) return coins;
    // Retain only the latest scan for each address so sendRawTransaction can associate inputs with the scan.
    for (const [key, knownAddress] of this.scannedOutpointAddresses) {
      if (knownAddress === address) this.scannedOutpointAddresses.delete(key);
    }
    const scanned = new Set(coins.map(outpoint));
    for (const key of scanned) this.scannedOutpointAddresses.set(key, address);

    return this.withPendingSpends(async (spends, save) => {
      let changed = false;
      for (const [key, knownAddress] of Object.entries(spends)) {
        if (knownAddress === address && !scanned.has(key)) {
          delete spends[key];
          changed = true;
        } else if (knownAddress === null && scanned.has(key)) {
          spends[key] = address;
          changed = true;
        }
      }
      if (changed) await save();
      return coins.filter((coin) => !Object.hasOwn(spends, outpoint(coin)));
    });
  }

  async isRegtestFundingAvailable(coin: UTXO): Promise<boolean> {
    if (
      this.pendingSpendStorage &&
      (await this.withPendingSpends(async (spends) => Object.hasOwn(spends, outpoint(coin))))
    ) {
      return false;
    }
    const [outspend, parent] = await Promise.all([
      this.httpGet<TransactionOutspend>(`/tx/${coin.txid}/outspend/${coin.vout}`).catch(() => undefined),
      this.getTransaction(coin.txid).catch(() => undefined),
    ]);
    if (outspend?.spent === true) return false;
    const height = parent?.status?.block_height ?? coin.status.block_height;
    if (parent?.vin?.[0]?.is_coinbase !== true || height === undefined) return true;
    const tip = await this.getLatestBlockHeight().catch(() => undefined);
    return tip === undefined || tip - height + 1 >= 100;
  }

  async getBalance(address: string) {
    const data = await this.getAddressData(address);
    const { chain_stats: chainStats, mempool_stats: mempoolStats } = data;

    const finalBalance = chainStats.funded_txo_sum - chainStats.spent_txo_sum;
    const unconfirmedBalance = mempoolStats.funded_txo_sum - mempoolStats.spent_txo_sum;

    return {
      address,
      finalBalance,
      finalNTx: chainStats.tx_count,
      totalReceived: data.historyAvailable === false ? 0 : chainStats.funded_txo_sum,
      totalSent: chainStats.spent_txo_sum,
      ...(data.historyAvailable === false && { historyAvailable: false as const }),
      unconfirmedTx: mempoolStats.tx_count,
      unconfirmedBalance,
    };
  }

  async getAddressData(address: string) {
    const path = `/address/${address}`;
    if (this._network !== 'Regtest') return this.httpGet<BtcAddressBalanceResponse>(path);

    const stats = await this.optionalRegtestRoute<BtcAddressBalanceResponse>('address', path);
    if (stats) return stats;

    const utxos = await this.getUnspentUtxos(address);
    const balanceStats = (confirmed: boolean) => ({
      funded_txo_count: utxos.filter((utxo) => utxo.status.confirmed === confirmed).length,
      funded_txo_sum: utxos.reduce((total, utxo) => total + (utxo.status.confirmed === confirmed ? utxo.value : 0), 0),
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    });
    return { address, historyAvailable: false, chain_stats: balanceStats(true), mempool_stats: balanceStats(false) };
  }

  async getUnspentUtxos(address: string): Promise<(UTXO & { address: string; blockHeight?: number })[]> {
    const data = await (this._network === 'Regtest'
      ? this.getRegtestUtxos(address)
      : this.httpGet<UTXO[]>(`/address/${address}/utxo`));

    const coins = this._network === 'Regtest' ? await this.filterPendingSpends(address, data) : data;
    const utxoSets = coins.map((utxo) => ({
      ...utxo,
      address,
      blockHeight: utxo.status.block_height,
    }));

    return utxoSets;
  }

  async hasAddressActivity(address: string): Promise<boolean> {
    if (this._network === 'Regtest') return (await this.getUnspentUtxos(address)).length > 0;
    return (await this._getAddressTransactionCount(address)) > 0;
  }

  async _getAddressTransactionCount(address: string) {
    const data =
      this._network === 'Regtest'
        ? await this.getAddressData(address)
        : await this.httpGet<Address>(`/address/${address}`);
    return data.chain_stats.tx_count + data.mempool_stats.tx_count;
  }

  async getAddressTransactions(address: string): Promise<EsploraTransaction[]> {
    const path = `/address/${address}/txs`;
    return this._network === 'Regtest'
      ? (await this.optionalRegtestRoute<EsploraTransaction[]>('history', path)) ?? []
      : this.httpGet<EsploraTransaction[]>(path);
  }

  async getTransaction(txid: string): Promise<EsploraTransaction> {
    // TODO: 404 return undefined
    return this.httpGet<EsploraTransaction>(`/tx/${txid}`);
  }

  async getTransactionHex(txid: string): Promise<string | undefined> {
    if (this._network === 'Regtest') {
      const data = await this.optionalRegtestRoute<string>('txHex', `/tx/${txid}/hex`, txid);
      if (data !== undefined) return data.trim();
      if (!this.ordApiUrl?.trim()) return undefined;

      try {
        const raw = await getRegtestOrdJson<string | null>(this.ordApiUrl, `/r/tx/${txid}`);
        if (raw === null) return undefined;
        const transaction = Transaction.fromRaw(hex.decode(raw), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        });
        if (transaction.id !== txid.toLowerCase()) throw new Error('Regtest raw transaction does not match txid');
        return raw;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    }
    const response = await this.bitcoinApi.get<string>(`/tx/${txid}/hex`, {
      validateStatus: (status) => status >= 200 && (status < 300 || status === 404),
    });
    if (response.status === 404) return undefined;
    return response.data;
  }

  async getAddressMempoolTransactions(address: string): Promise<BtcAddressMempool[]> {
    const path = `/address/${address}/txs/mempool`;
    return this._network === 'Regtest'
      ? (await this.optionalRegtestRoute<BtcAddressMempool[]>('mempoolHistory', path)) ?? []
      : this.httpGet<BtcAddressMempool[]>(path);
  }

  async sendRawTransaction(rawTransaction: string): Promise<BtcTransactionBroadcastResponse> {
    let data: string;
    if (this._network === 'Regtest') {
      const post = async () => {
        const response = await this.bitcoinApi.post<string>('/tx', rawTransaction, {
          headers: { 'Content-Type': 'text/plain' },
          responseType: 'text',
        });
        const txid = response.data.trim();
        if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Invalid Regtest broadcast transaction id');
        return txid;
      };
      if (this.pendingSpendStorage) {
        const tx = Transaction.fromRaw(hex.decode(rawTransaction), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        });
        const inputs = await Promise.all(
          Array.from({ length: tx.inputsLength }, async (_, index) => {
            const input = tx.getInput(index);
            const txid = hex.encode(input.txid!);
            const vout = input.index!;
            const key = outpoint({ txid, vout });
            const address =
              this.scannedOutpointAddresses.get(key) ??
              (await this.getTransaction(txid).catch(() => undefined))?.vout[vout]?.scriptpubkey_address;
            return [key, address ?? null] as const;
          }),
        );
        data = await this.withPendingSpends(async (spends, save) => {
          if (inputs.some(([key]) => Object.hasOwn(spends, key))) {
            throw new Error('A Regtest transaction input has already been submitted by this wallet');
          }
          const txid = await post();
          for (const [key, address] of inputs) spends[key] = address ?? spends[key] ?? null;
          await save();
          return txid;
        });
      } else {
        data = await post();
      }
    } else {
      data = await this.httpPost<string>('/tx', rawTransaction);
    }
    return {
      tx: {
        hash: data,
      },
    };
  }

  async getTransactionOutspend(txid: string, vout: number): Promise<TransactionOutspend | undefined> {
    const outspends = await this.getTransactionOutspends(txid);
    if (outspends || this._network !== 'Regtest') return outspends?.[vout];

    try {
      return await this.httpGet<TransactionOutspend>(`/tx/${txid}/outspend/${vout}`);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async getTransactionOutspends(txid: string): Promise<TransactionOutspend[] | undefined> {
    if (this._network === 'Regtest') {
      return this.optionalRegtestRoute<TransactionOutspend[]>('outspends', `/tx/${txid}/outspends`, txid);
    }
    const response = await this.bitcoinApi.get<TransactionOutspend[]>(`/tx/${txid}/outspends`, {
      validateStatus: (status) => status >= 200 && (status < 300 || status === 404),
    });
    if (response.status === 404) return undefined;
    return response.data;
  }

  async getLatestBlockHeight(): Promise<number> {
    const path = '/blocks/tip/height';
    if (this._network !== 'Regtest') return this.httpGet<number>(path);
    const height =
      (await this.optionalRegtestRoute<number>('tipHeight', path)) ??
      (await getRegtestOrdJson<number | string>(this.ordApiUrl, '/r/blockheight'));
    if (!/^\d+$/.test(String(height).trim()) || !Number.isSafeInteger(Number(height))) {
      throw new Error('Invalid Regtest block height');
    }
    return Number(height);
  }

  async getBlockHash(height: number): Promise<string> {
    const path = `/block-height/${height}`;
    if (this._network !== 'Regtest') return this.httpGet<string>(path);
    const hash =
      (await this.optionalRegtestRoute<string>('blockHash', path, undefined, height === 0)) ??
      (await getRegtestOrdJson<string>(this.ordApiUrl, `/r/blockhash/${height}`));
    if (!/^[0-9a-f]{64}$/i.test(hash.trim())) throw new Error('Invalid Regtest block hash');
    return hash.trim();
  }

  async getTipHash(): Promise<string> {
    const hash = (await this.httpGet<string>('/blocks/tip/hash')).trim();
    if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('Invalid Bitcoin tip block hash');
    return hash;
  }

  async getRegtestStatus(): Promise<RegtestEsploraStatus | undefined> {
    if (this._network !== 'Regtest') return undefined;
    return this.optionalRegtestRoute<RegtestEsploraStatus>('status', '/status');
  }

  async getRecommendedFees(): Promise<RecommendedFeeResponse> {
    if (this._network !== 'Regtest') throw new Error('Use mempoolApi for hosted Bitcoin fees');
    const estimates = await this.optionalRegtestRoute<FeeEstimates>('feeEstimates', '/fee-estimates');
    if (estimates && Object.values(estimates).some((rate) => Number.isFinite(rate) && rate > 0)) {
      const estimate = (target: number) => {
        const targets = Object.keys(estimates)
          .map(Number)
          .filter((blocks) => Number.isFinite(estimates[blocks]) && estimates[blocks] > 0)
          .sort((a, b) => a - b);
        return Math.max(1, Math.ceil(estimates[targets.find((blocks) => blocks >= target) ?? targets.at(-1)!]));
      };
      return {
        economyFee: estimate(24),
        fastestFee: estimate(1),
        halfHourFee: estimate(3),
        hourFee: estimate(6),
        minimumFee: estimate(144),
      };
    }
    const rates = await this.optionalRegtestRoute<RecommendedFeeResponse>('recommendedFees', '/v1/fees/recommended');
    if (!rates) return { ...minimumFees };

    return {
      economyFee: rates.economyFee > 0 ? rates.economyFee : 1,
      fastestFee: rates.fastestFee > 0 ? rates.fastestFee : 1,
      halfHourFee: rates.halfHourFee > 0 ? rates.halfHourFee : 1,
      hourFee: rates.hourFee > 0 ? rates.hourFee : 1,
      minimumFee: rates.minimumFee > 0 ? rates.minimumFee : 1,
    };
  }
}

export default BitcoinEsploraApiProvider;
