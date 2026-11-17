import { Semaphore } from 'async-mutex';
import {
  CollectionsList,
  CollectionsListFilters,
  Inscription,
  InscriptionsList,
  UTXO,
  UtxoOrdinalBundle,
} from '../../types';
import { BitcoinEsploraApiProvider } from '../esplora/esploraAPiProvider';
import { getRegtestOrdJson, regtestApiUrl } from '../regtest';

export type RegtestOutput = {
  indexed: true;
  spent: false;
  value: number;
  address?: string | null;
  inscriptions: string[];
  runes?: Record<string, unknown> | null;
};

export type RegtestSpendStatus = 'clean' | 'protected' | 'unknown';

export function getRegtestInscriptionContentUrl(ordApiUrl: string | undefined, inscriptionId: string): string {
  return `${regtestApiUrl(ordApiUrl, 'ord')}/content/${encodeURIComponent(inscriptionId)}`;
}

type OrdInscription = {
  id?: string;
  number: number;
  address?: string | null;
  sat?: number | string | null;
  satpoint: string;
  value: number;
  fee: number;
  height: number;
  timestamp: number;
  content_type?: string | null;
  content_length?: number | null;
};

const outpointPattern = /^[a-f0-9]{64}:\d+$/;
const inscriptionPattern = /^[a-f0-9]{64}i\d+$/;

export class RegtestOrdinalsApi {
  private readonly requests = new Map<string, Promise<unknown>>();
  private readonly concurrency = new Semaphore(4);
  private readonly pendingAddressReads = new Map<string, Promise<Inscription[]>>();

  constructor(private readonly bitcoin: BitcoinEsploraApiProvider) {}

  private read<T>(path: string): Promise<T | undefined> {
    if (!this.bitcoin.ordApiUrl?.trim()) return Promise.resolve(undefined);
    const pending = this.requests.get(path);
    if (pending) return pending as Promise<T | undefined>;

    const request = this.concurrency
      .runExclusive(() => getRegtestOrdJson<T>(this.bitcoin.ordApiUrl, path))
      .catch(() => undefined)
      .finally(() => this.requests.delete(path));
    this.requests.set(path, request);
    return request;
  }

  getContentUrl(inscriptionId: string): string {
    return getRegtestInscriptionContentUrl(this.bitcoin.ordApiUrl, inscriptionId);
  }

  async getOutput(outpoint: string): Promise<RegtestOutput | undefined> {
    if (!outpointPattern.test(outpoint)) return undefined;
    const output = await this.read<RegtestOutput>(`/output/${outpoint}`);
    if (
      !output ||
      output.indexed !== true ||
      output.spent !== false ||
      !Number.isSafeInteger(output.value) ||
      output.value < 0 ||
      !Array.isArray(output.inscriptions) ||
      !output.inscriptions.every((id) => typeof id === 'string') ||
      (output.runes != null && (typeof output.runes !== 'object' || Array.isArray(output.runes)))
    ) {
      return undefined;
    }
    return output;
  }

  async getSpendStatus(utxo: UTXO): Promise<RegtestSpendStatus> {
    if (!utxo.status.confirmed) return 'unknown';
    const output = await this.getOutput(`${utxo.txid}:${utxo.vout}`);
    if (!output || output.value !== utxo.value || output.address !== utxo.address) return 'unknown';
    return output.inscriptions.length || Object.keys(output.runes ?? {}).length ? 'protected' : 'clean';
  }

  async getInscription(inscriptionId: string): Promise<Inscription | undefined> {
    if (!inscriptionPattern.test(inscriptionId)) return undefined;
    const item = await this.read<OrdInscription>(`/inscription/${inscriptionId}`);
    if (
      !item ||
      (item.id !== undefined && item.id !== inscriptionId) ||
      typeof item.satpoint !== 'string' ||
      !Number.isSafeInteger(item.number) ||
      !Number.isSafeInteger(item.height) ||
      !Number.isSafeInteger(item.timestamp) ||
      !Number.isSafeInteger(item.fee) ||
      !Number.isSafeInteger(item.value) ||
      item.value <= 0
    )
      return undefined;

    const [txid, vout, offset, extra] = item.satpoint.split(':');
    const output = `${txid}:${vout}`;
    if (
      extra !== undefined ||
      !outpointPattern.test(output) ||
      !/^\d+$/.test(offset ?? '') ||
      !Number.isSafeInteger(Number(offset)) ||
      Number(offset) >= item.value
    )
      return undefined;

    return {
      id: inscriptionId,
      number: item.number,
      address: item.address ?? '',
      genesis_tx_id: inscriptionId.slice(0, 64),
      genesis_block_height: item.height,
      genesis_fee: String(item.fee),
      genesis_timestamp: item.timestamp,
      timestamp: item.timestamp,
      location: item.satpoint,
      output,
      value: String(item.value),
      offset,
      sat_ordinal: item.sat == null ? undefined : String(item.sat),
      mime_type: item.content_type ?? '',
      content_type: item.content_type ?? '',
      content_length: item.content_length ?? 0,
      tx_id: txid,
    };
  }

  async getAddressHoldings(address: string): Promise<{ utxo: UTXO; ids: string[] }[]> {
    if (!this.bitcoin.ordApiUrl?.trim()) return [];
    const utxos = await this.bitcoin.getUnspentUtxos(address);
    const unique = new Map(utxos.map((utxo) => [`${utxo.txid}:${utxo.vout}`, utxo]));
    const holdings = await Promise.all(
      [...unique].map(async ([outpoint, utxo]) => {
        const output = await this.getOutput(outpoint);
        return {
          utxo,
          ids: output && output.value === utxo.value && output.address === address ? output.inscriptions : [],
        };
      }),
    );
    return holdings;
  }

  async getAllInscriptions(address: string): Promise<Inscription[]> {
    const pending = this.pendingAddressReads.get(address);
    if (pending) return pending;

    const read = (async () => {
      const holdings = await this.getAddressHoldings(address);
      const outpointsById = new Map<string, Set<string>>();
      for (const { utxo, ids } of holdings) {
        for (const id of ids) {
          const outpoints = outpointsById.get(id) ?? new Set<string>();
          outpoints.add(`${utxo.txid}:${utxo.vout}`);
          outpointsById.set(id, outpoints);
        }
      }
      const items = await Promise.all(
        [...outpointsById].map(async ([id, outpoints]) => {
          const item = await this.getInscription(id);
          if (item?.address === address && outpoints.has(item.output)) return item;
          return undefined;
        }),
      );
      return items
        .filter((item): item is Inscription => item !== undefined)
        .sort(
          (a, b) => a.output.localeCompare(b.output) || Number(a.offset) - Number(b.offset) || a.id.localeCompare(b.id),
        );
    })().finally(() => this.pendingAddressReads.delete(address));
    this.pendingAddressReads.set(address, read);
    return read;
  }

  async getInscriptions(address: string, offset = 0, limit = 60): Promise<InscriptionsList> {
    const items = await this.getAllInscriptions(address);
    return { offset, limit, total: items.length, results: items.slice(offset, offset + limit) };
  }

  async getCollections(
    address: string,
    offset = 0,
    limit = 60,
    filters?: CollectionsListFilters,
  ): Promise<CollectionsList> {
    const hidden = new Set(filters?.hiddenCollectibleIds);
    const starred = new Set(filters?.starredCollectibleIds);
    const items = await this.getAllInscriptions(address);
    const visible = items
      .filter(({ id }) => (filters?.showHiddenOnly ? hidden.has(id) : !hidden.has(id)))
      .sort((a, b) => Number(starred.has(b.id)) - Number(starred.has(a.id)));
    return {
      offset,
      limit,
      total: visible.length,
      total_inscriptions: visible.length,
      results: visible.slice(offset, offset + limit).map(({ id, number, content_type }) => ({
        collection_id: null,
        collection_name: null,
        category: null,
        total_inscriptions: 1,
        thumbnail_inscriptions: [{ id, number, content_type }],
      })),
    };
  }

  async getBundle(outpoint: string, address?: string, value?: number): Promise<UtxoOrdinalBundle | undefined> {
    const output = await this.getOutput(outpoint);
    if (!output || (address && output.address !== address) || (value !== undefined && value !== output.value)) {
      return undefined;
    }

    const [txid, vout] = outpoint.split(':');
    const inscriptionIds = [...new Set(output.inscriptions)];
    const items = await Promise.all(inscriptionIds.map((id) => this.getInscription(id)));
    return {
      txid,
      vout: Number(vout),
      value: output.value,
      sat_ranges: [],
      localInscriptions: {
        ids: inscriptionIds,
        located: items.flatMap((item) =>
          item?.output === outpoint && Number(item.value) === output.value && (!address || item.address === address)
            ? [
                {
                  id: item.id,
                  content_type: item.content_type,
                  inscription_number: item.number,
                  offset: Number(item.offset),
                },
              ]
            : [],
        ),
      },
    };
  }
}
