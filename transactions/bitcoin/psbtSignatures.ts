import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { decode } from 'varuint-bitcoin';

type PsbtEntry = { type: number; key: string; bytes: Uint8Array };

function readInputMaps(psbt: Uint8Array, inputCount: number) {
  const bytes = Buffer.from(psbt);
  let offset = 5; // PSBT magic
  const readSize = () => {
    const size = decode(bytes, offset);
    offset += decode.bytes;
    return size;
  };
  const readMap = () => {
    const entries: PsbtEntry[] = [];
    while (true) {
      const start = offset;
      const keySize = readSize();
      if (!keySize) return { entries, end: start };
      const key = bytes.subarray(offset, offset + keySize);
      offset += keySize;
      const valueSize = readSize();
      offset += valueSize;
      entries.push({ type: key[0], key: hex.encode(key), bytes: bytes.subarray(start, offset) });
    }
  };
  readMap(); // global
  return Array.from({ length: inputCount }, readMap);
}

/** Add signature records to the original maps, preserving every original byte and its order. */
export function appendPsbtSignatures(original: Uint8Array, signed: Transaction): Uint8Array {
  const unsignedMaps = readInputMaps(original, signed.inputsLength);
  const signedMaps = readInputMaps(signed.toPSBT(), signed.inputsLength);
  const parts: Uint8Array[] = [];
  let from = 0;
  unsignedMaps.forEach(({ entries, end }, index) => {
    const existing = new Set(entries.map(({ key }) => key));
    const additions = signedMaps[index].entries.filter(
      ({ type, key }) => (type === 0x02 || type === 0x13 || type === 0x14) && !existing.has(key),
    );
    if (!additions.length) return;
    parts.push(original.subarray(from, end), ...additions.map(({ bytes }) => bytes));
    from = end;
  });
  parts.push(original.subarray(from));
  return Buffer.concat(parts);
}
