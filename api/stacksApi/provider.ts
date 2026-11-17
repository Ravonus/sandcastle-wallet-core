import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { API_TIMEOUT_MILLI, HIRO_MAINNET_DEFAULT, HIRO_TESTNET_DEFAULT } from '../../constant';
import { NetworkType, StacksNetwork, NftHistoryResponse, StacksMainnet } from '../../types';
import {
  AccountDataResponse,
  AddressTransaction,
  AddressTransactionEventListResponse,
  AddressTransactionsV2ListResponse,
  MempoolTransaction,
  MempoolTransactionListResponse,
  Transaction,
  GetRawTransactionResult,
} from '@stacks/stacks-blockchain-api-types';
import BigNumber from 'bignumber.js';

export interface StacksApiProviderOptions {
  network: StacksNetwork;
  btcNetwork?: NetworkType;
}

const LIMIT = 100;
const OFFSET = 0;

export class StacksApiProvider {
  StacksApi: AxiosInstance;

  _network: StacksNetwork;

  private readonly isRegtest: boolean;

  constructor(options: StacksApiProviderOptions) {
    const { network, btcNetwork } = options;
    this.isRegtest = btcNetwork === 'Regtest';
    let baseURL = network.client.baseUrl;

    if (!baseURL) {
      if (!(network.chainId === StacksMainnet.chainId)) {
        baseURL = HIRO_TESTNET_DEFAULT;
      }
      baseURL = HIRO_MAINNET_DEFAULT;
    }
    const axiosConfig: AxiosRequestConfig = { baseURL, timeout: API_TIMEOUT_MILLI };

    this._network = network;
    this.StacksApi = axios.create(
      this.isRegtest
        ? { adapter: () => Promise.reject(new Error('Stacks APIs are unavailable on Regtest')) }
        : axiosConfig,
    );
  }

  private async httpGet<T>(
    url: string,
    params: unknown = {},
    reqConfig: Omit<AxiosRequestConfig, 'params'> = {},
  ): Promise<T> {
    const response = await this.StacksApi.get<T>(url, { ...reqConfig, params });
    return response.data;
  }

  private async httpPost<T>(url: string, data: unknown): Promise<T> {
    const response = await this.StacksApi.post(url, data);
    return response.data;
  }

  getAddressBalance = async (stxAddress: string) => {
    if (this.isRegtest) {
      return {
        availableBalance: new BigNumber(0),
        lockedBalance: new BigNumber(0),
        totalBalance: new BigNumber(0),
        nonce: 0,
      };
    }
    const apiUrl = `/v2/accounts/${stxAddress}?proof=0`;
    const response = await this.httpGet<AccountDataResponse>(apiUrl);
    const availableBalance = new BigNumber(response.balance);
    const lockedBalance = new BigNumber(response.locked);
    return {
      availableBalance,
      lockedBalance,
      totalBalance: availableBalance.plus(lockedBalance),
      nonce: response.nonce,
    };
  };

  getAddressTransactions = async ({
    stxAddress,
    offset,
    limit,
  }: {
    stxAddress: string;
    offset?: number;
    limit?: number;
  }): Promise<{
    list: AddressTransaction[];
    total: number;
  }> => {
    if (this.isRegtest) return { list: [], total: 0 };
    const apiUrl = `/extended/v2/address/${stxAddress}/transactions`;

    const response = await this.httpGet<AddressTransactionsV2ListResponse>(apiUrl, {
      limit,
      offset,
    });

    return {
      list: response.results,
      total: response.total,
    };
  };

  getAddressMempoolTransactions = async ({
    stxAddress,
    offset,
    limit,
  }: {
    stxAddress: string;
    offset: number;
    limit: number;
  }): Promise<{
    list: MempoolTransaction[];
    total: number;
  }> => {
    if (this.isRegtest) return { list: [], total: 0 };
    const apiUrl = `/extended/v1/tx/mempool?address=${stxAddress}`;

    const response = await this.httpGet<MempoolTransactionListResponse>(apiUrl, {
      limit: limit,
      offset: offset,
    });

    return {
      list: response.results,
      total: response.total,
    };
  };

  getTransactionEvents = async ({
    txid,
    stxAddress,
    limit,
    offset,
  }: {
    txid: string;
    stxAddress: string;
    limit: number;
    offset: number;
  }): Promise<AddressTransactionEventListResponse> => {
    if (this.isRegtest) return { limit, offset, total: 0, results: [] };
    const apiUrl = `/extended/v2/addresses/${stxAddress}/transactions/${txid}/events`;
    const response = await this.httpGet<AddressTransactionEventListResponse>(apiUrl, {
      limit,
      offset,
    });
    return response;
  };

  getAllTransactions = async ({
    stxAddress,
    offset = OFFSET,
    limit = LIMIT,
  }: {
    stxAddress: string;
    offset: number;
    limit: number;
  }): Promise<(AddressTransaction | MempoolTransaction)[]> => {
    if (this.isRegtest) return [];
    let allTransactions: (AddressTransaction | MempoolTransaction)[] = [];
    let hasMore = true;

    while (hasMore) {
      const [transactionsWithTransfers, mempoolTransactions] = await Promise.all([
        this.getAddressTransactions({ stxAddress, offset, limit }),
        this.getAddressMempoolTransactions({ stxAddress, limit, offset }),
      ]);

      const combinedTransactions = [...mempoolTransactions.list, ...transactionsWithTransfers.list];

      allTransactions = [...allTransactions, ...combinedTransactions];

      // Check if we received fewer transactions than the limit, indicating no more transactions
      if (combinedTransactions.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    return allTransactions;
  };

  getTransaction = async (txid: string): Promise<Transaction | undefined> => {
    if (this.isRegtest) return undefined;
    const response = await this.httpGet<Transaction>(`/extended/v1/tx/${txid}`);
    return response;
  };

  getRawTransaction = async (txid: string): Promise<string> => {
    if (this.isRegtest) return '';
    const response = await this.httpGet<GetRawTransactionResult>(`/extended/v1/tx/${txid}/raw`);
    return response.raw_tx;
  };

  getNftHistory = async (
    assetIdentifier: string,
    value: string,
    limit = 1,
    offset = 0,
  ): Promise<NftHistoryResponse> => {
    if (this.isRegtest) return { limit, offset, total: 0, results: [] };
    return this.httpGet<NftHistoryResponse>(`/extended/v1/tokens/nft/history`, {
      asset_identifier: assetIdentifier,
      value,
      limit,
      offset,
    });
  };
}

export default StacksApiProvider;
