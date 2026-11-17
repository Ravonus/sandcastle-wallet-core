import { Address } from '@scure/btc-signer';
import { AddressType } from 'bitcoin-address-validation';
import { NetworkType } from '../types/network';

export interface BitcoinNetwork {
  bech32: string;
  pubKeyHash: number;
  scriptHash: number;
  wif: number;
}

const bitcoinMainnet: BitcoinNetwork = {
  bech32: 'bc',
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
};

const bitcoinTestnet: BitcoinNetwork = {
  bech32: 'tb',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

const bitcoinRegtest: BitcoinNetwork = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

export const bitcoinNetworks: Record<NetworkType, BitcoinNetwork> = {
  Mainnet: bitcoinMainnet,
  Testnet: bitcoinTestnet,
  Testnet4: bitcoinTestnet,
  Signet: bitcoinTestnet,
  Regtest: bitcoinRegtest,
};

export const getBtcNetwork = (networkType: NetworkType) => {
  return bitcoinNetworks[networkType];
};

export const getBtcNetworkDefinition = (networkType?: NetworkType) => {
  switch (networkType) {
    case 'Mainnet':
      return bitcoinMainnet;
    case 'Testnet':
    case 'Testnet4':
    case 'Signet':
    case undefined:
      return bitcoinTestnet;
    case 'Regtest':
      return bitcoinRegtest;
    default:
      throw new Error('Invalid network type');
  }
};

export const isInscriptionsAndRunesCompatible = (networkType: NetworkType) => {
  return networkType !== 'Regtest';
};

export function getBitcoinAddressType(address: string, network: NetworkType): AddressType {
  switch (Address(getBtcNetworkDefinition(network)).decode(address).type) {
    case 'tr':
      return AddressType.p2tr;
    case 'wpkh':
      return AddressType.p2wpkh;
    case 'wsh':
      return AddressType.p2wsh;
    case 'sh':
      return AddressType.p2sh;
    case 'pkh':
      return AddressType.p2pkh;
    default:
      throw new Error('Unsupported Bitcoin address type');
  }
}
