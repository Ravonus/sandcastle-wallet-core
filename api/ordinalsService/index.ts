import { ORDINALS_SERVICE_BASE_URL } from '../../constant';
import { NetworkType } from '../../types';
import { CreateEtchOrderRequest, CreateMintOrderRequest, CreateOrderResponse } from '../../types/api/ordinalsService';

import axios, { AxiosInstance } from 'axios';

export class OrdinalsServiceApi {
  client: AxiosInstance;

  constructor(private readonly network?: NetworkType) {
    this.client = axios.create({
      baseURL: network === 'Regtest' ? undefined : ORDINALS_SERVICE_BASE_URL(network),
      ...(network === 'Regtest' && {
        adapter: () => Promise.reject(new Error('Hosted ordinals orders are unavailable on Regtest')),
      }),
    });
  }

  createMintOrder = async (mintOrderParams: CreateMintOrderRequest) => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.post<CreateOrderResponse>('/runes/mint/orders', {
      ...mintOrderParams,
    });
    return response.data;
  };

  createEtchOrder = async (etchOrderParams: CreateEtchOrderRequest) => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.post<CreateOrderResponse>('/runes/etch/orders', {
      ...etchOrderParams,
    });
    return response.data;
  };

  executeMint = async (orderId: string, fundTransactionId: string) => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.post(`/runes/mint/orders/${orderId}/execute`, {
      fundTransactionId,
    });
    return response.data;
  };

  executeEtch = async (orderId: string, fundTransactionId: string) => {
    if (this.network === 'Regtest') return undefined;
    const response = await this.client.post(`/runes/etch/orders/${orderId}/execute`, {
      fundTransactionId,
    });
    return response.data;
  };
}

const apiClients: Partial<Record<NetworkType, OrdinalsServiceApi>> = {};

export const getOrdinalsServiceApiClient = (network: NetworkType): OrdinalsServiceApi => {
  if (!apiClients[network]) {
    apiClients[network] = new OrdinalsServiceApi(network);
  }
  return apiClients[network] as OrdinalsServiceApi;
};

export * from './config';
