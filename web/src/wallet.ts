import { getNetworkDetails, isConnected, requestAccess, signTransaction } from '@stellar/freighter-api';
import { NETWORK_PASSPHRASE } from './contract';

/** Thin wrapper over the Freighter browser wallet. The secret key never leaves Freighter. */

export async function connectWallet(): Promise<string> {
  const conn = await isConnected();
  if (!conn.isConnected) {
    throw new Error('Freighter wallet not found. Install it from freighter.app, then reload this page.');
  }
  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message);
  if (!access.address) throw new Error('Freighter did not share an address.');

  const net = await getNetworkDetails();
  if (!net.error && net.networkPassphrase !== NETWORK_PASSPHRASE) {
    throw new Error(`Switch Freighter to Testnet (it's on ${net.network || 'another network'}).`);
  }
  return access.address;
}

export async function signWithWallet(xdr: string, address: string): Promise<string> {
  const res = await signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE, address });
  if (res.error) throw new Error(res.error.message || 'Signing was cancelled.');
  return res.signedTxXdr;
}
