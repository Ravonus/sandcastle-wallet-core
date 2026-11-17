import axios from 'axios';
import { BtcFeeResponse, NetworkType, RecommendedFeeResponse, SettingsNetwork } from '../types';
import { BitcoinEsploraApiProvider } from './esplora/esploraAPiProvider';

const mempoolUrl = 'https://mempool.space';
const mempoolSuffix = 'api/v1';
const networkRouteMap = {
  Mainnet: `${mempoolUrl}/${mempoolSuffix}`,
  Testnet: `${mempoolUrl}/testnet/${mempoolSuffix}`,
  Testnet4: `${mempoolUrl}/testnet4/${mempoolSuffix}`,
  Signet: `${mempoolUrl}/signet/${mempoolSuffix}`,
};

export async function getRecommendedFees(network: NetworkType | SettingsNetwork): Promise<RecommendedFeeResponse> {
  const type = typeof network === 'string' ? network : network.type;
  if (type === 'Regtest') {
    const provider =
      typeof network === 'string'
        ? new BitcoinEsploraApiProvider({ network: type })
        : BitcoinEsploraApiProvider.fromSettings(network);
    return provider.getRecommendedFees();
  }

  const { data } = await axios.get<RecommendedFeeResponse>(`${networkRouteMap[type]}/fees/recommended`);
  return data;
}

export async function getRegtestBtcFeeRate(provider: BitcoinEsploraApiProvider): Promise<BtcFeeResponse> {
  const fees = await provider.getRecommendedFees();
  const { halfHourFee: regular, fastestFee: priority, minimumFee: min } = fees;
  return { regular, priority, limits: { min, max: Math.max(min, regular, priority) } };
}

export default { getRecommendedFees };
