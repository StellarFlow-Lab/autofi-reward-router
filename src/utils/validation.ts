import { StrKey } from '@stellar/stellar-sdk';
import { isPositiveAmount } from './amount';

export function validateAmount(amount: string): boolean {
  return isPositiveAmount(amount);
}

export function validatePercentage(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

export function validatePercentageSplit(offRamp: number, keepCrypto: number): boolean {
  return validatePercentage(offRamp) && validatePercentage(keepCrypto) && offRamp + keepCrypto === 100;
}

export function validateStellarPublicKey(key: string): boolean {
  return typeof key === 'string' && StrKey.isValidEd25519PublicKey(key);
}

export function validateStellarSecretKey(key: string): boolean {
  return typeof key === 'string' && StrKey.isValidEd25519SecretSeed(key);
}

export function validateContractId(id: string): boolean {
  return typeof id === 'string' && StrKey.isValidContract(id);
}

export function validateAssetCode(code: string): boolean {
  return /^[a-zA-Z0-9]{1,12}$/.test(code);
}
