import { StacksTransactionWire } from '@stacks/transactions';
import axios, { AxiosHeaders, AxiosInstance, AxiosResponse } from 'axios';
import BigNumber from 'bignumber.js';
import EsploraApiProvider from '../api/esplora/esploraAPiProvider';
import { API_TIMEOUT_MILLI, XVERSE_API_BASE_URL, XVERSE_SPONSOR_URL } from '../constant';
import { runeTokenToFungibleToken } from '../fungibleTokens';
import {
  APIGetRunesActivityForAddressResponse,
  AppFeaturesBody,
  AppFeaturesContext,
  AppFeaturesResponse,
  AppInfo,
  Brc20TokensResponse,
  BtcFeeResponse,
  CoinsMarket,
  CoinsResponse,
  CollectionMarketDataResponse,
  CollectionsList,
  CollectionsListFilters,
  CreateRuneListingCancellationRequest,
  CreateRuneListingCancellationResponse,
  CreateRuneListingRequest,
  CreateRuneListingResponse,
  DappSectionData,
  ExchangeRateAvailableCurrencies,
  ExchangeRateList,
  ExecuteOrderRequest,
  ExecuteOrderResponse,
  ExecuteStxOrderRequest,
  ExecuteStxOrderResponse,
  ExecuteUtxoOrderRequest,
  ExecuteUtxoOrderResponse,
  GetDestinationTokensRequest,
  GetDestinationTokensResponse,
  GetListedUtxosRequest,
  GetListedUtxosResponse,
  GetOrderHistoryRequest,
  GetOrderHistoryResponse,
  GetQuotesRequest,
  GetQuotesResponse,
  GetRuneMarketDataRequest,
  GetSourceTokensRequest,
  GetUtxosRequest,
  GetUtxosResponse,
  HistoricalDataParamsPeriod,
  HistoricalDataResponsePrices,
  Inscription,
  InscriptionInCollectionsList,
  ListingRuneMarketInfo,
  NetworkType,
  NotificationBanner,
  OrdinalInfo,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PlaceStxOrderRequest,
  PlaceStxOrderResponse,
  PlaceUtxoOrderRequest,
  PlaceUtxoOrderResponse,
  PlaceXcOrderRequest,
  PlaceXcOrderResponse,
  PrincipalToFungibleToken,
  SignedUrlResponse,
  SimplePriceResponse,
  SettingsNetwork,
  SponsorInfoResponse,
  SponsorTransactionResponse,
  StackerInfo,
  StackingPoolInfo,
  SubmitRuneListingCancellationRequest,
  SubmitRuneListingCancellationResponse,
  SubmitRuneListingRequest,
  SubmitRuneListingResponse,
  SupportedCurrency,
  TokenBasic,
  TokenFiatRateResponse,
  TopTokens,
  TopTokensResponse,
} from '../types';
import { getXClientVersion } from '../utils/xClientVersion';
import { handleAxiosError } from './error';
import { fetchBtcOrdinalsData } from './ordinals';
import { getRegtestBtcFeeRate } from './mempool';
import { RegtestOrdinalsApi } from './ordinals/regtest';

const produceHistoricalDataObject = (timestamp: number, price: number) => ({
  x: timestamp,
  y: price,
  tooltipLabel: new Date(timestamp).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }),
});

export class XverseApi {
  private client: AxiosInstance;

  private network: NetworkType;

  private readonly regtestBitcoin?: EsploraApiProvider;
  private readonly regtestOrdinals?: RegtestOrdinalsApi;

  constructor(settings: NetworkType | SettingsNetwork) {
    const network = typeof settings === 'string' ? settings : settings.type;
    this.network = network;

    if (network === 'Regtest') {
      this.regtestBitcoin =
        typeof settings === 'string' ? new EsploraApiProvider({ network }) : EsploraApiProvider.fromSettings(settings);
      this.regtestOrdinals = new RegtestOrdinalsApi(this.regtestBitcoin);
    }

    this.client = axios.create({
      baseURL: network === 'Regtest' ? undefined : XVERSE_API_BASE_URL(network),
      ...(network === 'Regtest' && {
        adapter: () => Promise.reject(new Error('Hosted APIs are unavailable on Regtest')),
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Version': getXClientVersion() || undefined,
      },
    });
  }

  fetchBtcFeeRate = async (): Promise<BtcFeeResponse> => {
    if (this.regtestBitcoin) return getRegtestBtcFeeRate(this.regtestBitcoin);
    const response = await this.client.get('/v1/fees/btc');
    return response.data;
  };

  fetchStxToBtcRate = async (): Promise<BigNumber | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.get('/v1/prices/stx/btc', { timeout: API_TIMEOUT_MILLI });
    return new BigNumber(response.data.stxBtcRate.toString());
  };

  fetchBtcToCurrencyRate = async ({
    fiatCurrency,
  }: {
    fiatCurrency: SupportedCurrency;
  }): Promise<BigNumber | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.get(`/v1/prices/btc/${fiatCurrency}`, { timeout: API_TIMEOUT_MILLI });
    return new BigNumber(response.data.btcFiatRate.toString());
  };

  fetchTokenFiateRate = async (ft: string, fiatCurrency: string): Promise<BigNumber | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const url = `/v1/prices/${ft}/${fiatCurrency}`;

    return this.client
      .get<TokenFiatRateResponse>(url, { timeout: API_TIMEOUT_MILLI })
      .then((response) => {
        return new BigNumber(response.data.tokenFiatRate);
      })
      .catch(() => {
        return new BigNumber(0);
      });
  };

  getSip10Tokens = async (contractids: string[], fiatCurrency: string): Promise<CoinsResponse> => {
    if (this.network === 'Regtest') return [];
    const response = await this.client.post<CoinsResponse>('/v1/sip10/tokens', {
      currency: fiatCurrency,
      coins: JSON.stringify(contractids),
    });
    return response.data;
  };

  /**
   * get BRC-20 supported tokens with the fiat rate
   * @param tickers provided to get the fiat rate along with supported tokens
   * @param fiatCurrency
   */
  getBrc20Tokens = async (tickers: string[], fiatCurrency: string): Promise<Brc20TokensResponse> => {
    if (this.network === 'Regtest') return [];
    const response = await this.client.get<Brc20TokensResponse>('/v1/brc20/tokens', {
      params: {
        currency: fiatCurrency,
        tickers: tickers,
      },
    });
    return response.data;
  };

  /**
   * get rune fiat rate data
   * @param runeNames provided to get the fiat rates of supported tokens from coingecko
   * @param fiatCurrency
   * @deprecated use getRuneFiatRatesByRuneIds instead
   */
  getRuneFiatRates = async (runeNames: string[] | string, fiatCurrency: string): Promise<SimplePriceResponse> => {
    if (this.network === 'Regtest') return {};
    const response = await this.client.get<SimplePriceResponse>('/v1/runes/fiat-rates', {
      params: {
        currency: fiatCurrency,
        runeNames,
      },
    });
    return response.data;
  };

  /**
   * get rune tx history for a given address and rune
   * @param address ordinal address
   * @param runeName e.g.LFG•ROCKET•RUNE
   * @param offset
   * @param limit
   */
  getRuneTxHistory = async (
    address: string,
    runeName: string,
    offset: number,
    limit: number,
  ): Promise<APIGetRunesActivityForAddressResponse> => {
    if (this.network === 'Regtest') return { items: [], divisibility: 0, runeName, total: 0, offset, limit };
    const response = await this.client.get<APIGetRunesActivityForAddressResponse>(
      `/v1/address/${address}/rune/${runeName}?offset=${offset}&limit=${limit}`,
    );
    return response.data;
  };

  fetchAppInfo = async (): Promise<AppInfo> => {
    if (this.network === 'Regtest')
      return {
        stxSendTxMultiplier: 1,
        poolStackingTxMultiplier: 1,
        otherTxMultiplier: 1,
        thresholdHighSatsFee: 0,
        thresholdHighSatsPerByteRatio: 0,
        thresholdHighStacksFee: 0,
      };
    const response = await this.client.get<AppInfo>('/v1/info');
    return response.data;
  };

  fetchStackingPoolInfo = async (): Promise<StackingPoolInfo | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.get<StackingPoolInfo>(`/v1/pool/info?pool_version=5`);
    return response.data;
  };

  fetchPoolStackerInfo = async (stxAddress: string): Promise<StackerInfo | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.get<StackerInfo>(`/v1/pool/${stxAddress}/status`);
    return response.data;
  };

  getMoonPaySignedUrl = async (unsignedUrl: string): Promise<SignedUrlResponse | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.post<SignedUrlResponse>('/v1/sign-url', {
      url: unsignedUrl,
    });
    return response.data;
  };

  getBinanceSignature = async (srcData: string): Promise<SignedUrlResponse | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.post<SignedUrlResponse>('/v1/binance/sign', {
      url: srcData,
    });
    return response.data;
  };

  getOrdinalInfo = async (ordinalId: string): Promise<OrdinalInfo | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.get(`/v1/ordinals/${ordinalId}`);
    return response.data;
  };

  getErc721Metadata = async (tokenContract: string, tokenId: string): Promise<string> => {
    if (this.network === 'Regtest') return '';
    const response = await this.client.get(`/v1/eth/${tokenContract}/${tokenId}`);
    return response.data;
  };

  /**
   * Get inscription collections by address
   * @param address ordinal address
   * @param offset
   * @param limit
   * @param filters options to star/hide certain collectibleIds or inscriptionIds
   */
  getCollections = async (
    address: string,
    offset?: number,
    limit?: number,
    filters?: CollectionsListFilters,
  ): Promise<CollectionsList> => {
    if (this.regtestOrdinals) return this.regtestOrdinals.getCollections(address, offset, limit, filters);
    const response = await this.client.post(`/v2/address/${address}/ordinals/collections`, {
      limit,
      offset,
      filters,
    });
    return response.data;
  };

  getCollectionSpecificInscriptions = async (
    address: string,
    collectionId: string,
    offset?: number,
    limit?: number,
    filters?: CollectionsListFilters,
  ): Promise<InscriptionInCollectionsList> => {
    if (this.network === 'Regtest')
      return { offset: offset ?? 0, limit: limit ?? 60, total: 0, collection_name: '', portfolio_value: 0, data: [] };
    const response = await this.client.get(`/v1/address/${address}/ordinals/collections/${collectionId}`, {
      params: {
        limit,
        offset,
        filters,
      },
    });
    return response.data;
  };

  getCollectionMarketData = async (collectionId: string): Promise<CollectionMarketDataResponse | undefined> => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.get(`/v1/ordinals/collections/${collectionId}`);
    return response.data;
  };

  getInscription = async (address: string, inscriptionId: string): Promise<Inscription | undefined> => {
    if (this.regtestOrdinals) {
      return this.regtestOrdinals.getAddressInscription(address, inscriptionId);
    }
    const response = await this.client.get(`/v1/address/${address}/ordinals/inscriptions/${inscriptionId}`);
    return response.data;
  };

  getAppConfig = async () => {
    if (this.regtestBitcoin) {
      return {
        data: { btcApiURL: this.regtestBitcoin.bitcoinApi.defaults.baseURL ?? '' },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: new AxiosHeaders() },
      } satisfies AxiosResponse;
    }
    const response = await this.client.get(`/v1/app-config`);
    return response;
  };

  getFeaturedDapps = async (): Promise<DappSectionData[]> => {
    if (this.network === 'Regtest') return [];
    const response = await this.client.get(`/v2/featured/dapp`);
    return response.data.featuredDapp;
  };

  getNotificationBanners = async (): Promise<NotificationBanner[]> => {
    if (this.network === 'Regtest') return [];
    const response = await this.client.get(`/v2/notification-banners`);
    return response.data.notificationBanners;
  };

  getCoinsMarketData = async (ids: string[]): Promise<CoinsMarket[]> => {
    if (this.network === 'Regtest') return [];
    const response = await this.client.get(`/v2/coins-market-data?ids=${ids.join(',')}`);
    return response.data;
  };

  getExchangeRate = async (currency: ExchangeRateAvailableCurrencies): Promise<ExchangeRateList> => {
    if (this.network === 'Regtest') return {};
    const response = await this.client.get(`/v2/exchange-rate?currency=${currency}`);
    return response.data;
  };

  getHistoricalData = async (
    id: 'btc' | 'stx' | string,
    period: HistoricalDataParamsPeriod,
    exchangeRate = 1,
  ): Promise<HistoricalDataResponsePrices> => {
    if (this.network === 'Regtest') return [];
    const idMap: Record<string, string> = {
      btc: 'bitcoin',
      stx: 'stacks',
    };
    const formattedId = idMap[id.toLowerCase()] || id.toLowerCase();

    const response = await this.client.get<[number, number][]>(
      `/v2/historical-data?id=${formattedId}&period=${period}`,
    );
    return response.data.map(([timestamp, price]) => produceHistoricalDataObject(timestamp, price * exchangeRate));
  };

  getSpamTokensList = async () => {
    if (this.network === 'Regtest') return [];
    const response = await this.client.get(`/v1/spam-tokens`);
    return response.data;
  };

  getTopTokens = async (): Promise<TopTokensResponse> => {
    if (this.network === 'Regtest') return { runes: {}, stacks: {}, 'brc-20': {} };
    const response = await this.client.get<TopTokens>('/v1/top-tokens');
    const topRunesTokens: PrincipalToFungibleToken = {};
    for (const runeId in response.data.runes) {
      const runeData = response.data.runes[runeId];
      topRunesTokens[runeId] = runeTokenToFungibleToken(runeData);
    }
    return {
      ...response.data,
      runes: topRunesTokens,
    };
  };

  getAppFeatures = async (context?: Partial<AppFeaturesContext>, headers?: Record<string, string>) => {
    if (this.network === 'Regtest') return {};
    const response = await this.client.post<
      AppFeaturesResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- this is the axios default
      AxiosResponse<AppFeaturesResponse, any>,
      AppFeaturesBody
    >('/v1/app-features', { context: { ...context, network: this.network } }, { headers });
    return response.data;
  };

  listings = {
    getRuneMarketData: async (body: GetRuneMarketDataRequest): Promise<ListingRuneMarketInfo[]> => {
      if (this.network === 'Regtest') return [];
      const response = await this.client.post(`/v1/listings/runes/market-data`, body);
      return response.data;
    },
    getRuneSellOrder: async (body: CreateRuneListingRequest): Promise<CreateRuneListingResponse[]> => {
      if (this.network === 'Regtest') return [];
      const response = await this.client.post<CreateRuneListingResponse[]>('/v1/listings/runes/create-order', body);
      return response.data;
    },
    submitRuneSellOrder: async (body: SubmitRuneListingRequest[]): Promise<SubmitRuneListingResponse[]> => {
      if (this.network === 'Regtest') return [];
      const response = await this.client.post<SubmitRuneListingResponse[]>('/v1/listings/runes/submit-order', body);
      return response.data;
    },
    getListedUtxos: async (body: GetListedUtxosRequest): Promise<GetListedUtxosResponse> => {
      if (this.network === 'Regtest') return { marketplaces: [], utxos: {} };
      const response = await this.client.post<GetListedUtxosResponse>('/v1/listings/runes/listed-utxos', body);
      return response.data;
    },
    getRuneCancelOrder: async (
      body: CreateRuneListingCancellationRequest,
    ): Promise<CreateRuneListingCancellationResponse[]> => {
      if (this.network === 'Regtest') return [];
      const response = await this.client.post<CreateRuneListingCancellationResponse[]>(
        '/v1/listings/runes/create-cancellation',
        body,
      );
      return response.data;
    },
    submitRuneCancelOrder: async (
      body: SubmitRuneListingCancellationRequest,
    ): Promise<SubmitRuneListingCancellationResponse[]> => {
      if (this.network === 'Regtest') return [];
      const response = await this.client.post<SubmitRuneListingCancellationResponse[]>(
        '/v1/listings/runes/submit-cancellation',
        body,
      );
      return response.data;
    },
  };

  swaps = {
    /** Get the tokens that the user has which are supported by the swap services */
    getSourceTokens: async (body: GetSourceTokensRequest): Promise<TokenBasic[]> => {
      if (this.network === 'Regtest') return [];
      const response = await this.client.post<TokenBasic[]>('/v1/swaps/get-source-tokens', body);
      return response.data;
    },
    /** Get the tokens that the user can swap to, depending on the tokens they have in their wallet */
    getDestinationTokens: async (body: GetDestinationTokensRequest): Promise<GetDestinationTokensResponse> => {
      if (this.network === 'Regtest') return { items: [] };
      const response = await this.client.post<GetDestinationTokensResponse>('/v1/swaps/get-destination-tokens', body);
      return response.data;
    },
    /** Get quotes for a specific token swap */
    getQuotes: async (body: GetQuotesRequest): Promise<GetQuotesResponse> => {
      if (this.network === 'Regtest') return { amm: [], utxo: [], stx: [], xc: [] };
      const response = await this.client.post<GetQuotesResponse>('/v1/swaps/get-quotes', body);
      return response.data;
    },
    /** Get utxos for a swap pair from a specific provider */
    getUtxos: async (body: GetUtxosRequest): Promise<GetUtxosResponse> => {
      if (this.network === 'Regtest') return { items: [] };
      const response = await this.client.post<GetUtxosResponse>('/v1/swaps/get-utxos', body);
      return response.data;
    },
    /** Place a swap order. This is for AMM providers. */
    placeOrder: async (body: PlaceOrderRequest): Promise<PlaceOrderResponse | undefined> => {
      if (this.network === 'Regtest') return undefined;
      const response = await this.client.post<PlaceOrderResponse>('/v1/swaps/place-order', body);
      return response.data;
    },
    /** Execute a swap order. This is for AMM providers. */
    executeOrder: async (body: ExecuteOrderRequest): Promise<ExecuteOrderResponse | undefined> => {
      if (this.network === 'Regtest') return undefined;
      const response = await this.client.post<ExecuteOrderResponse>('/v1/swaps/execute-order', body);
      return response.data;
    },
    /** Place a swap order. This is for STX providers. */
    placeStxOrder: async (body: PlaceStxOrderRequest): Promise<PlaceStxOrderResponse | undefined> => {
      if (this.network === 'Regtest') return undefined;
      const response = await this.client.post<PlaceStxOrderResponse>('/v1/swaps/place-stx-order', body);
      return response.data;
    },
    /** Execute a swap order. This is for STX providers. */
    executeStxOrder: async (body: ExecuteStxOrderRequest): Promise<ExecuteStxOrderResponse | undefined> => {
      if (this.network === 'Regtest') return undefined;
      const response = await this.client.post<ExecuteStxOrderResponse>('/v1/swaps/execute-stx-order', body);
      return response.data;
    },
    /** Place a swap order. This is for UTXO based providers. */
    placeUtxoOrder: async (body: PlaceUtxoOrderRequest): Promise<PlaceUtxoOrderResponse | undefined> => {
      if (this.network === 'Regtest') return undefined;
      const response = await this.client.post<PlaceUtxoOrderResponse>('/v1/swaps/place-utxo-order', body);
      return response.data;
    },
    /** Execute a swap order. This is for UTXO based providers. */
    executeUtxoOrder: async (body: ExecuteUtxoOrderRequest): Promise<ExecuteUtxoOrderResponse | undefined> => {
      if (this.network === 'Regtest') return undefined;
      const response = await this.client.post<ExecuteUtxoOrderResponse>('/v1/swaps/execute-utxo-order', body);
      return response.data;
    },
    /** Place a XC swap order. */
    placeXcOrder: async (body: PlaceXcOrderRequest): Promise<PlaceXcOrderResponse | undefined> => {
      if (this.network === 'Regtest') return undefined;
      const response = await this.client.post<PlaceXcOrderResponse>('/v1/swaps/place-xc-order', body);
      return response.data;
    },
    /** Gets order history. This is for XC providers. */
    getOrderHistory: async (body: GetOrderHistoryRequest): Promise<GetOrderHistoryResponse> => {
      if (this.network === 'Regtest') return [];
      const response = await this.client.post<GetOrderHistoryResponse>('/v1/swaps/get-order-history', body);
      return response.data;
    },
  };
}

const apiClients: Partial<Record<NetworkType, XverseApi>> = {};

export const getXverseApiClient = (settings: NetworkType | SettingsNetwork): XverseApi => {
  const network = typeof settings === 'string' ? settings : settings.type;
  if (typeof settings !== 'string' && network === 'Regtest') return new XverseApi(settings);
  if (!apiClients[network]) {
    apiClients[network] = new XverseApi(network);
  }
  return apiClients[network] as XverseApi;
};

/**
 * @deprecated use XverseApi.fetchBtcFeeRate instead
 */
export async function fetchBtcFeeRate(network: NetworkType | SettingsNetwork): Promise<BtcFeeResponse> {
  return getXverseApiClient(network).fetchBtcFeeRate();
}

/**
 * @deprecated use XverseApi.fetchStxToBtcRate instead
 */
export async function fetchStxToBtcRate(network: NetworkType): Promise<BigNumber | undefined> {
  return getXverseApiClient(network).fetchStxToBtcRate();
}

/**
 * @deprecated use XverseApi.fetchBtcToCurrencyRate instead
 */
export async function fetchBtcToCurrencyRate(
  network: NetworkType,
  { fiatCurrency }: { fiatCurrency: SupportedCurrency },
): Promise<BigNumber | undefined> {
  return getXverseApiClient(network).fetchBtcToCurrencyRate({ fiatCurrency });
}

/**
 * @deprecated use XverseApi.fetchTokenFiateRate instead
 */
export async function fetchTokenFiateRate(
  network: NetworkType,
  ft: string,
  fiatCurrency: string,
): Promise<BigNumber | undefined> {
  return getXverseApiClient(network).fetchTokenFiateRate(ft, fiatCurrency);
}

/**
 * @deprecated use XverseApi.getCoinsInfo instead
 */
export async function getCoinsInfo(
  network: NetworkType,
  contractids: string[],
  fiatCurrency: string,
): Promise<CoinsResponse | null> {
  return getXverseApiClient(network)
    .getSip10Tokens(contractids, fiatCurrency)
    .catch(() => null);
}

/**
 * @deprecated use XverseApi.getBrc20Tokens instead
 */
export async function getBrc20Tokens(
  network: NetworkType,
  tickers: string[],
  fiatCurrency: string,
): Promise<Brc20TokensResponse | null> {
  return getXverseApiClient(network)
    .getBrc20Tokens(tickers, fiatCurrency)
    .catch(() => null);
}

/**
 * @deprecated use XverseApi.fetchAppInfo instead
 */
export async function fetchAppInfo(network: NetworkType): Promise<AppInfo | null> {
  return getXverseApiClient(network)
    .fetchAppInfo()
    .catch(() => null);
}

/**
 * @deprecated use XverseApi.fetchStackingPoolInfo instead
 */
export async function fetchStackingPoolInfo(network: NetworkType): Promise<StackingPoolInfo | undefined> {
  return getXverseApiClient(network).fetchStackingPoolInfo();
}

/**
 * @deprecated use XverseApi.fetchPoolStackerInfo instead
 */
export async function fetchPoolStackerInfo(network: NetworkType, stxAddress: string): Promise<StackerInfo | undefined> {
  return getXverseApiClient(network).fetchPoolStackerInfo(stxAddress);
}

/**
 * @deprecated use XverseApi.getMoonPaySignedUrl instead
 */
export async function getMoonPaySignedUrl(
  network: NetworkType,
  unsignedUrl: string,
): Promise<SignedUrlResponse | null> {
  return getXverseApiClient(network)
    .getMoonPaySignedUrl(unsignedUrl)
    .then((result) => result ?? null)
    .catch(() => null);
}

/**
 * @deprecated use XverseApi.getBinanceSignature instead
 */
export async function getBinaceSignature(network: NetworkType, srcData: string): Promise<SignedUrlResponse | null> {
  return getXverseApiClient(network)
    .getBinanceSignature(srcData)
    .then((result) => result ?? null)
    .catch(() => null);
}

// TODO move this to another file
/**
 * Return the sponsored signed transaction
 *
 * @param {StacksTransactionWire} signedTx
 * @param {string} [sponsorHost] - optional host for stacks-transaction-sponsor fork
 * @returns {Promise<string>}
 * @throws {ApiResponseError} - if api responded with an error status
 */
export async function sponsorTransaction(signedTx: StacksTransactionWire, sponsorHost?: string): Promise<string> {
  const url = `${sponsorHost ?? XVERSE_SPONSOR_URL}/v1/sponsor`;

  const data = {
    tx: signedTx.serialize(),
  };

  return axios
    .post(url, data, { timeout: 45000 })
    .then((response: AxiosResponse<SponsorTransactionResponse>) => {
      return response.data.txid;
    })
    .catch(handleAxiosError);
}

// TODO move this to another file
/**
 * Get whether sponsor service is active
 *
 * @param {string} [sponsorHost] - optional host for stacks-transaction-sponsor fork
 * @returns {Promise<boolean>}
 * @throws {ApiResponseError} - if api responded with an error status
 */
export async function getSponsorInfo(sponsorHost?: string): Promise<boolean> {
  const url = `${sponsorHost ?? XVERSE_SPONSOR_URL}/v1/info`;

  return axios
    .get(url)
    .then((response: AxiosResponse<SponsorInfoResponse>) => {
      return response.data.active;
    })
    .catch(handleAxiosError);
}

// TODO move this to another file
export async function getOrdinalsByAddress(
  esploraProvider: EsploraApiProvider,
  network: NetworkType,
  ordinalsAddress: string,
) {
  return fetchBtcOrdinalsData(ordinalsAddress, esploraProvider, network);
}

/**
 * @deprecated use XverseApi.getOrdinalInfo instead
 */
export async function getOrdinalInfo(network: NetworkType, ordinalId: string): Promise<OrdinalInfo | undefined> {
  return getXverseApiClient(network).getOrdinalInfo(ordinalId);
}

/**
 * @deprecated use XverseApi.getErc721Metadata instead
 */
export async function getErc721Metadata(network: NetworkType, tokenContract: string, tokenId: string): Promise<string> {
  return getXverseApiClient(network).getErc721Metadata(tokenContract, tokenId);
}

/**
 * @deprecated use XverseApi.getCollections instead
 */
export async function getCollections(
  network: NetworkType,
  address: string,
  offset?: number,
  limit?: number,
): Promise<CollectionsList> {
  return getXverseApiClient(network).getCollections(address, offset, limit);
}

/**
 * @deprecated use XverseApi.getCollectionMarketData instead
 */
export async function getCollectionMarketData(
  network: NetworkType,
  collectionId: string,
): Promise<CollectionMarketDataResponse | undefined> {
  return getXverseApiClient(network).getCollectionMarketData(collectionId);
}

/**
 * @deprecated use XverseApi.getCollectionSpecificInscriptions instead
 */
export async function getCollectionSpecificInscriptions(
  network: NetworkType,
  address: string,
  collectionId: string,
  offset?: number,
  limit?: number,
): Promise<InscriptionInCollectionsList> {
  return getXverseApiClient(network).getCollectionSpecificInscriptions(address, collectionId, offset, limit);
}

/**
 * @deprecated use XverseApi.getInscription instead
 */
export async function getInscription(
  network: NetworkType,
  address: string,
  inscriptionId: string,
): Promise<Inscription | undefined> {
  return getXverseApiClient(network).getInscription(address, inscriptionId);
}

/**
 * @deprecated use XverseApi.getAppConfig instead
 */
export async function getAppConfig(network: NetworkType) {
  return getXverseApiClient(network).getAppConfig();
}

/**
 * @deprecated use XverseApi.getFeaturedDapps instead
 */
export async function getFeaturedDapps(network: NetworkType): Promise<DappSectionData[]> {
  return getXverseApiClient(network).getFeaturedDapps();
}

/**
 * @deprecated use XverseApi.getSpamTokensList instead
 */
export async function getSpamTokensList(network: NetworkType) {
  return getXverseApiClient(network).getSpamTokensList();
}
