import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { Verifier } from 'bip322-js';
import { describe, expect, it } from 'vitest';
import {
  getAccountFromSeedPhrase,
  getBitcoinAddressType,
  getBtcNetwork,
  MessageSigningProtocols,
  signMessage,
  validateBtcAddress,
  validateBtcAddressIsTaproot,
} from '../../index';

const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const vectors = [
  {
    path: 'native',
    type: 'p2wpkh',
    address: 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk',
    testnet: 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl',
    mainnet: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    publicKey: '02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319',
  },
  {
    path: 'nested',
    type: 'p2sh',
    address: '2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2',
    testnet: '2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2',
    mainnet: '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf',
    publicKey: '03a1af804ac108a8a51782198c2d034b28bf90c8803f5a53f76276fa69a4eae77f',
  },
  {
    path: 'taproot',
    type: 'p2tr',
    address: 'bcrt1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqjeprhg',
    testnet: 'tb1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqlqt9zj',
    mainnet: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    publicKey: '55355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116',
  },
] as const;

const getAccount = () => getAccountFromSeedPhrase({ mnemonic: seed, index: 0n, network: 'Regtest' });

describe('Regtest software addresses', () => {
  it.each(vectors)(
    'derives and validates the $path address and key',
    async ({ path, address, testnet, mainnet, type, publicKey }) => {
      const account = await getAccount();
      expect(account.btcAddresses[path]).toEqual({ address, publicKey });
      expect(getBitcoinAddressType(address, 'Regtest')).toBe(type);
      expect(validateBtcAddress({ btcAddress: address, network: 'Regtest' })).toBe(true);
      expect(validateBtcAddress({ btcAddress: address, network: 'Mainnet' })).toBe(false);
      expect(validateBtcAddress({ btcAddress: mainnet, network: 'Regtest' })).toBe(false);
      expect(validateBtcAddress({ btcAddress: address, network: 'Testnet' })).toBe(path === 'nested');
      expect(validateBtcAddress({ btcAddress: testnet, network: 'Regtest' })).toBe(path === 'nested');
      expect(validateBtcAddressIsTaproot(address, 'Regtest')).toBe(path === 'taproot');
      expect(validateBtcAddressIsTaproot(address, 'Testnet')).toBe(false);
    },
  );

  it.each(vectors)('selects the $path message signing key on Regtest', async ({ address, testnet }) => {
    const account = await getAccount();
    const message = 'Sign this disposable Regtest challenge.';
    const signed = await signMessage({
      address,
      message,
      accounts: [account],
      seedPhrase: seed,
      network: 'Regtest',
      protocol: MessageSigningProtocols.BIP322,
    });
    expect(signed.protocol).toBe(MessageSigningProtocols.BIP322);
    // This verifier version uses the equivalent Testnet encoding of the same locking script.
    expect(Verifier.verifySignature(testnet, message, signed.signature)).toBe(true);
    expect(Verifier.verifySignature(testnet, message + '?', signed.signature)).toBe(false);
  });

  it('rejects a wrong network and ECDSA on Taproot', async () => {
    const account = await getAccount();
    const { address, testnet } = vectors[2];
    const input = {
      message: 'Sign the challenge.',
      accounts: [account],
      seedPhrase: seed,
      network: 'Regtest',
    } as const;
    await expect(signMessage({ ...input, address: testnet })).rejects.toThrow();
    await expect(signMessage({ ...input, address, protocol: MessageSigningProtocols.ECDSA })).rejects.toThrow(
      'ECDSA is not supported for Taproot Addresses',
    );
  });

  it('encodes Regtest WIF with the shared test-chain 0xef version', () => {
    const wif = base58check(sha256).decode('cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA');
    expect(wif[0]).toBe(0xef);
    expect(getBtcNetwork('Regtest').wif).toBe(wif[0]);
  });
});
