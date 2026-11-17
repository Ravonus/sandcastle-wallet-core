import * as ecc from '@bitcoinerlab/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment';
import { RawPSBTV0, RawPSBTV2 } from '@scure/btc-signer/psbt';
import { utils as secpUtils } from '@noble/secp256k1';
import { Transaction as BitcoinJsTransaction, script as bitcoinScript } from 'bitcoinjs-lib';
import { mnemonicToSeedSync } from 'bip39';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BitcoinEsploraApiProvider,
  createTransactionContext,
  defaultRegtest,
  EnhancedPsbt,
  getAccountFromSeedPhrase,
  getBtcNetwork,
  SeedVault,
  UtxoCache,
  type BtcPaymentType,
  type ExtendedStorageAdapter,
  type InputToSign,
} from '../../../index';
import { bip32 } from '../../../utils/bip32';

const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const buyerRoot = bip32.fromSeed(mnemonicToSeedSync(seed));
const signerKey = buyerRoot.derivePath("m/86'/1'/0'/0/0").publicKey.subarray(1);
const serverKey = secpUtils.randomPrivateKey();
const serverXOnly = ecc.xOnlyPointFromScalar(serverKey);
const network = getBtcNetwork('Regtest');
const walletTaproot = btc.p2tr(signerKey, undefined, network);
const serverTaproot = btc.p2tr(serverXOnly, undefined, network);
const saleScript = btc.Script.encode([signerKey, 'CHECKSIGVERIFY', serverXOnly, 'CHECKSIG', 1, 'NUMEQUAL']);
const cancelScript = btc.p2tr_pk(signerKey).script;
const protectedOutput = btc.p2tr(
  btc.TAPROOT_UNSPENDABLE_KEY,
  [{ script: saleScript }, { script: cancelScript }],
  network,
  true,
);
const origin = 'http://localhost:19645';
const ordOrigin = 'http://localhost:19646';
const assetTxid = 'aa'.repeat(32);
const paymentTxid = 'bb'.repeat(32);
const anchorTxid = 'cc'.repeat(32);
const single = btc.SigHash.SINGLE_ANYONECANPAY;
const all = btc.SigHash.ALL;
const defaultSighash = btc.SigHash.DEFAULT;

const noMatch = vi.fn();
beforeEach(() => {
  nock.disableNetConnect();
  noMatch.mockClear();
  nock.emitter.on('no match', noMatch);
});
afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  nock.emitter.removeListener('no match', noMatch);
  expect(pending).toEqual([]);
  expect(noMatch).not.toHaveBeenCalled();
});

async function wallet(paymentType: BtcPaymentType = 'native') {
  const electrsApi = BitcoinEsploraApiProvider.fromSettings({
    ...defaultRegtest,
    btcApiUrl: `${origin}/api`,
    ordApiUrl: ordOrigin,
  });
  const account = await getAccountFromSeedPhrase({ mnemonic: seed, index: 0n, network: 'Regtest' });
  return createTransactionContext({
    esploraApiProvider: electrsApi,
    account,
    seedVault: { getSeed: async () => seed } as SeedVault,
    utxoCache: new UtxoCache({ network: 'Regtest', electrsApi, cacheStorageController: {} as ExtendedStorageAdapter }),
    network: 'Regtest',
    btcPaymentAddressType: paymentType,
  });
}

function listing(includeInternalKey = true): btc.Transaction {
  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({
    txid: assetTxid,
    index: 1,
    sequence: 0xfffffffd,
    witnessUtxo: { script: walletTaproot.script, amount: 10000n },
    tapInternalKey: includeInternalKey ? signerKey : undefined,
    sighashType: single,
  });
  tx.addOutput({ script: serverTaproot.script, amount: 12150n });
  return tx;
}

function protectedListing(leaf: Uint8Array): btc.Transaction {
  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  const entry = protectedOutput.tapLeafScript?.find(([, scriptAndVersion]) =>
    Buffer.from(scriptAndVersion.subarray(0, -1)).equals(leaf),
  );
  if (!entry) throw new Error('Fixture Taproot leaf missing');
  tx.addInput({
    txid: assetTxid,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: protectedOutput.script, amount: 10000n },
    tapLeafScript: [entry],
    ...(leaf === saleScript ? { sighashType: single } : {}),
  });
  tx.addOutput({ script: walletTaproot.script, amount: leaf === saleScript ? 12150n : 9800n });
  return tx;
}

function tapDigest(tx: btc.Transaction, index: number, sighash: number, leaf?: Uint8Array) {
  const unsigned = BitcoinJsTransaction.fromBuffer(Buffer.from(tx.unsignedTx));
  const prevouts = Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).witnessUtxo!);
  return unsigned.hashForWitnessV1(
    index,
    prevouts.map(({ script }) => Buffer.from(script)),
    prevouts.map(({ amount }) => Number(amount)),
    sighash,
    leaf && Buffer.from(tapLeafHash(leaf)),
  );
}

function decodePsbt(encoded: string) {
  return btc.Transaction.fromPSBT(base64.decode(encoded), { allowUnknownInputs: true, allowUnknownOutputs: true });
}

function selector(address: string, signingIndexes: number[], ...sighashTypes: number[]): InputToSign[] {
  return [{ address, signingIndexes, sighashTypes }];
}

describe('Regtest marketplace PSBTs', () => {
  it.each([true, false])('signs a BIP86 listing with 0x83 (internal key supplied: %s)', async (includeInternalKey) => {
    const context = await wallet();
    const unsigned = listing(includeInternalKey);
    const encoded = base64.encode(unsigned.toPSBT());
    const psbt = new EnhancedPsbt(context, encoded, selector(context.ordinalsAddress.address, [0], single));
    const signed = decodePsbt(await psbt.getSignedPsbtBase64());
    const signature = signed.getInput(0).tapKeySig!;
    expect(signature.length).toBe(65);
    expect(signature[64]).toBe(0x83);
    expect(
      ecc.verifySchnorr(tapDigest(unsigned, 0, single), walletTaproot.tweakedPubkey, signature.subarray(0, 64)),
    ).toBe(true);
    expect(signed.getInput(0)).toEqual({ ...decodePsbt(encoded).getInput(0), tapKeySig: signature });
    expect(signed.isFinal).toBe(false);
  });

  it('summarizes an unbroadcast sale parent and signs only the 0x83 script path', async () => {
    const context = await wallet();
    const unsigned = protectedListing(saleScript);
    nock(origin).get(`/api/tx/${assetTxid}`).reply(500, { error: 'No such transaction' });
    const psbt = new EnhancedPsbt(
      context,
      base64.encode(unsigned.toPSBT()),
      selector(context.ordinalsAddress.address, [0], single),
    );
    const summary = await psbt.getSummary();
    expect(summary).toMatchObject({ hasSigHashSingle: true, isFinal: false });
    expect(summary.inputs[0].prevoutUnknown).toBe(true);
    expect(summary.inputs[0].extendedUtxo.address).toBe('');
    expect(summary.inputs[0].extendedUtxo.utxo.value).toBe(10000);
    expect(summary.inputs[0].walletWillSign).toBe(true);

    const signed = decodePsbt(await psbt.getSignedPsbtBase64());
    const input = signed.getInput(0);
    const [[key, signature]] = input.tapScriptSig!;
    expect(key.pubKey).toEqual(Uint8Array.from(signerKey));
    expect(key.leafHash).toEqual(tapLeafHash(saleScript));
    expect(signature).toHaveLength(65);
    expect(signature[64]).toBe(0x83);
    expect(ecc.verifySchnorr(tapDigest(unsigned, 0, single, saleScript), signerKey, signature.subarray(0, 64))).toBe(
      true,
    );
    expect(input).toEqual({
      ...decodePsbt(base64.encode(unsigned.toPSBT())).getInput(0),
      tapScriptSig: input.tapScriptSig,
    });
    expect(signed.isFinal).toBe(false);
  });

  it('enriches a protection-move summary locally and keeps its OP_RETURN note', async () => {
    const context = await wallet();
    const unsigned = listing();
    unsigned.updateInput(0, { sighashType: defaultSighash });
    unsigned.updateOutput(0, { script: protectedOutput.script, amount: 9800n });
    const note = btc.Script.encode(['RETURN', tapLeafHash(saleScript)]);
    unsigned.addOutput({ script: note, amount: 0n });
    const inscriptionId = `${assetTxid}i0`;
    const outpoint = `${assetTxid}:1`;
    const address = context.ordinalsAddress.address;
    nock(origin)
      .get(`/api/tx/${assetTxid}`)
      .reply(200, {
        txid: assetTxid,
        vin: [],
        vout: [{}, { value: 10000, scriptpubkey: hex.encode(walletTaproot.script), scriptpubkey_address: address }],
        status: { confirmed: true },
      })
      .get(`/api/tx/${assetTxid}/outspends`)
      .reply(200, [{ spent: true }, { spent: false }]);
    nock(ordOrigin, { reqheaders: { Accept: 'application/json' } })
      .get(`/output/${outpoint}`)
      .reply(200, {
        indexed: true,
        spent: false,
        value: 10000,
        address,
        inscriptions: [inscriptionId],
        runes: null,
      })
      .get(`/inscription/${inscriptionId}`)
      .reply(200, {
        number: 0,
        address,
        satpoint: `${outpoint}:17`,
        sat: null,
        value: 10000,
        fee: 12,
        height: 11,
        timestamp: 1_700_000_000,
        content_type: 'text/plain',
        content_length: 10,
      });
    const psbt = new EnhancedPsbt(context, base64.encode(unsigned.toPSBT()), selector(address, [0], defaultSighash));
    const summary = await psbt.getSummary();
    expect(summary.runeOp).toBeUndefined();
    expect(summary.inputs[0]).toMatchObject({ inscriptions: [{ id: inscriptionId, offset: 17 }] });
    expect(summary.outputs[0]).toMatchObject({ inscriptions: [{ id: inscriptionId, offset: 17 }] });
    expect(summary.outputs[1]).toMatchObject({ type: 'script', scriptHex: hex.encode(note) });
    expect(summary.feeOutput).toMatchObject({ amount: 200, inscriptions: [] });
  });

  it('signs the cancel leaf with DEFAULT and finalizes only on an explicit request', async () => {
    const context = await wallet();
    const unsigned = protectedListing(cancelScript);
    const psbt = new EnhancedPsbt(
      context,
      base64.encode(unsigned.toPSBT()),
      selector(context.ordinalsAddress.address, [0], defaultSighash),
    );
    const signed = decodePsbt(await psbt.getSignedPsbtBase64());
    const input = signed.getInput(0);
    const [[key, signature]] = input.tapScriptSig!;
    expect(signature).toHaveLength(64);
    expect(key.leafHash).toEqual(tapLeafHash(cancelScript));
    expect(ecc.verifySchnorr(tapDigest(unsigned, 0, defaultSighash, cancelScript), signerKey, signature)).toBe(true);
    expect(input.tapInternalKey).toBeUndefined();
    expect(input.tapKeySig).toBeUndefined();
    expect(signed.isFinal).toBe(false);
    expect(decodePsbt(await psbt.getSignedPsbtBase64({ finalize: true })).isFinal).toBe(true);
  });

  it.each(['native', 'nested'] as const)('signs only the selected %s buyer inputs with ALL', async (mode) => {
    const context = await wallet(mode);
    const path = mode === 'native' ? "m/84'/1'/0'/0/0" : "m/49'/1'/0'/0/0";
    const publicKey = buyerRoot.derivePath(path).publicKey;
    const native = btc.p2wpkh(publicKey, network);
    const nested = btc.p2sh(native, network);
    const payment = mode === 'native' ? native : nested;
    const paymentInput = {
      txid: paymentTxid,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: payment.script, amount: 20000n },
      redeemScript: mode === 'nested' ? nested.redeemScript : undefined,
      sighashType: all,
    };
    const unsigned = new btc.Transaction({ allowUnknownOutputs: true, PSBTVersion: mode === 'nested' ? 2 : 0 });
    unsigned.addInput({ ...paymentInput, txid: anchorTxid });
    unsigned.addInput({
      txid: assetTxid,
      index: 1,
      sequence: 0xfffffffd,
      witnessUtxo: { script: serverTaproot.script, amount: 10000n },
      tapInternalKey: serverXOnly,
      sighashType: single,
    });
    unsigned.addInput(paymentInput);
    unsigned.addOutput({ script: walletTaproot.script, amount: 10000n });
    unsigned.addOutput({ script: payment.script, amount: 12150n });
    unsigned.addOutput({ script: btc.Script.encode(['RETURN', Uint8Array.of(11, 22)]), amount: 0n });
    unsigned.signIdx(serverKey, 1, [single]);
    const versionCoder = mode === 'nested' ? RawPSBTV2 : RawPSBTV0;
    const maps = versionCoder.decode(unsigned.toPSBT());
    const customRecord = [[{ type: 0xcb, key: Uint8Array.of(0xab, 0xcd) }, Uint8Array.of(7, 3, 0)]] as NonNullable<
      typeof maps.global.unknown
    >;
    maps.global.unknown = customRecord;
    maps.inputs[2].unknown = customRecord;
    maps.outputs[0].unknown = customRecord;
    const original = versionCoder.encode(maps);

    const psbt = new EnhancedPsbt(context, base64.encode(original), selector(context.paymentAddress.address, [2], all));
    const signedBytes = base64.decode(await psbt.getSignedPsbtBase64());
    const signed = btc.Transaction.fromPSBT(signedBytes, { allowUnknownOutputs: true });
    const acquired = signed.getInput(2).partialSig!;
    const [[signatureKey, derSignature]] = acquired;
    expect(signatureKey).toEqual(Uint8Array.from(publicKey));
    const { signature, hashType } = bitcoinScript.signature.decode(Buffer.from(derSignature));
    expect(hashType).toBe(all);
    const scriptCode = Buffer.from(btc.p2pkh(publicKey).script);
    const raw = BitcoinJsTransaction.fromBuffer(Buffer.from(unsigned.unsignedTx));
    expect(ecc.verify(raw.hashForWitnessV0(2, scriptCode, 20000, all), publicKey, signature)).toBe(true);
    const sellerSignature = signed.getInput(1).tapKeySig!;
    expect(sellerSignature).toEqual(unsigned.getInput(1).tapKeySig);
    expect(
      ecc.verifySchnorr(tapDigest(unsigned, 1, single), serverTaproot.tweakedPubkey, sellerSignature.subarray(0, 64)),
    ).toBe(true);
    expect(signed.getInput(0).partialSig).toBeUndefined();
    expect(signed.isFinal).toBe(false);
    const after = versionCoder.decode(signedBytes);
    delete after.inputs[2].partialSig;
    expect(after).toEqual(maps);
    expect(versionCoder.encode(after)).toEqual(original);
  });

  it('leaves co-signed sale leaves to the requesting app to finalize', async () => {
    const context = await wallet();
    const unsigned = protectedListing(saleScript);
    unsigned.signIdx(serverKey, 0, [single]);
    const inputs = selector(context.ordinalsAddress.address, [0], single);
    const psbt = new EnhancedPsbt(context, base64.encode(unsigned.toPSBT()), inputs);
    await expect(psbt.getSignedPsbtBase64({ finalize: true })).rejects.toThrow('use sign-only');
    const signed = decodePsbt(await psbt.getSignedPsbtBase64());
    expect(signed.getInput(0).tapScriptSig).toHaveLength(2);
    expect(signed.isFinal).toBe(false);
    const external = new EnhancedPsbt(context, base64.encode(signed.toPSBT()), []);
    await expect(external.getSignedPsbtBase64({ finalize: true })).rejects.toThrow('use sign-only');
  });

  it('enforces the legacy sighash and intersects it with the array restriction', async () => {
    const context = await wallet();
    const encoded = base64.encode(listing().toPSBT());
    const descriptor = { address: context.ordinalsAddress.address, signingIndexes: [0] };
    const legacyConflict = new EnhancedPsbt(context, encoded, [{ ...descriptor, sigHash: all }]);
    await expect(legacyConflict.getSummary()).rejects.toThrow('Sighash 131 is not allowed');
    await expect(legacyConflict.getSignedPsbtBase64()).rejects.toThrow('Sighash 131 is not allowed');
    const intersection = new EnhancedPsbt(context, encoded, [{ ...descriptor, sigHash: single, sighashTypes: [all] }]);
    await expect(intersection.getSignedPsbtBase64()).rejects.toThrow('Sighash 131 is not allowed');
    const allowed = new EnhancedPsbt(context, encoded, [
      { ...descriptor, sigHash: single, sighashTypes: [single, all] },
    ]);
    expect(decodePsbt(await allowed.getSignedPsbtBase64()).getInput(0).tapKeySig?.[64]).toBe(single);
  });

  it('rejects disallowed sighash, wrong role, duplicate indexes, and a mismatched control block', async () => {
    const context = await wallet();
    const unsigned = listing();
    const encoded = base64.encode(unsigned.toPSBT());
    const seller = context.ordinalsAddress.address;
    const buyer = context.paymentAddress.address;
    await expect(new EnhancedPsbt(context, encoded, selector(seller, [0], all)).getSignedPsbtBase64()).rejects.toThrow(
      'Sighash 131 is not allowed',
    );
    await expect(
      new EnhancedPsbt(context, encoded, selector(buyer, [0], single)).getSignedPsbtBase64(),
    ).rejects.toThrow('does not match the selected payment address');
    await expect(
      new EnhancedPsbt(context, encoded, selector(seller, [0, 0], single)).getSignedPsbtBase64(),
    ).rejects.toThrow('Duplicate PSBT signing index');
    expect(await new EnhancedPsbt(context, encoded, []).getSignedPsbtBase64()).toBe(encoded);

    const wrongLeaf = protectedListing(saleScript);
    const [[control, script]] = wrongLeaf.getInput(0).tapLeafScript!;
    wrongLeaf.updateInput(0, { tapLeafScript: undefined }, true);
    wrongLeaf.updateInput(0, { tapLeafScript: [[{ ...control, version: control.version ^ 1 }, script]] }, true);
    const invalid = new EnhancedPsbt(context, base64.encode(wrongLeaf.toPSBT()), selector(seller, [0], single));
    await expect(invalid.getSignedPsbtBase64()).rejects.toThrow('does not match the prevout script');
  });
});
