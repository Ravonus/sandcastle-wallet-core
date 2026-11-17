import { StacksNetworkName } from '@stacks/network';
import { NetworkType, StacksMainnet, StacksTestnet } from '../../types';
import { StacksApiProvider } from './provider';

type ClientKey = StacksNetworkName | 'regtest';
const clients: Partial<Record<ClientKey, StacksApiProvider>> = {};
const stacksNetworksMap: Record<NetworkType, ClientKey> = {
  Mainnet: 'mainnet',
  Testnet: 'testnet',
  Testnet4: 'testnet',
  Signet: 'testnet',
  Regtest: 'regtest',
};

export const getStacksApiClient = (networkType: NetworkType): StacksApiProvider => {
  const networkName = stacksNetworksMap[networkType];

  if (!clients[networkName]) {
    const network = networkType === 'Mainnet' ? StacksMainnet : StacksTestnet;
    clients[networkName] = new StacksApiProvider({ network, btcNetwork: networkType });
  }

  return clients[networkName] as StacksApiProvider;
};

export default StacksApiProvider;
export * from './provider';
