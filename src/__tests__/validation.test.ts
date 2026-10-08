import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  validateAmount, validateAssetCode, validateContractId, validatePercentageSplit,
  validateStellarPublicKey, validateStellarSecretKey,
} from '../utils/validation';

describe('validation', () => {
  test('amounts', () => {
    expect(validateAmount('100.50')).toBe(true);
    expect(validateAmount('0.0000001')).toBe(true);
    expect(validateAmount('-10')).toBe(false);
    expect(validateAmount('0')).toBe(false);
    expect(validateAmount('invalid')).toBe(false);
  });

  test('percentage splits', () => {
    expect(validatePercentageSplit(70, 30)).toBe(true);
    expect(validatePercentageSplit(100, 0)).toBe(true);
    expect(validatePercentageSplit(70, 29)).toBe(false);
    expect(validatePercentageSplit(50.5, 49.5)).toBe(false);
    expect(validatePercentageSplit(-10, 110)).toBe(false);
  });

  test('keys and contract ids', () => {
    const kp = Keypair.random();
    expect(validateStellarPublicKey(kp.publicKey())).toBe(true);
    expect(validateStellarPublicKey(kp.secret())).toBe(false);
    expect(validateStellarSecretKey(kp.secret())).toBe(true);
    expect(validateStellarSecretKey('S123')).toBe(false);
    expect(validateContractId(StrKey.encodeContract(Buffer.alloc(32)))).toBe(true);
    expect(validateContractId('Cnotacontract')).toBe(false);
  });

  test('asset codes', () => {
    expect(validateAssetCode('USDC')).toBe(true);
    expect(validateAssetCode('NGNX')).toBe(true);
    expect(validateAssetCode('TOOLONGASSETCODE')).toBe(false);
    expect(validateAssetCode('')).toBe(false);
    expect(validateAssetCode('USD-C')).toBe(false);
  });
});
