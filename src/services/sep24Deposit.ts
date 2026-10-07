import { logger } from '../utils/logger';
import type { AnchorConfig } from '../types';

export interface SEP24DepositRequest {
  anchorConfig: AnchorConfig;
  amount: string;
  userPublicKey: string;
  userEmail?: string;
}

export interface SEP24DepositResponse {
  id: string;
  type: 'interactive';
  url: string;
}

interface AnchorToml {
  TRANSFER_SERVER_SEP0024?: string;
  TRANSFER_SERVER?: string;
}

/**
 * Fetch the anchor's stellar.toml to discover the SEP-24 transfer server URL.
 * Falls back to the well-known path https://<homeDomain>/.well-known/stellar.toml.
 */
async function fetchAnchorToml(homeDomain: string): Promise<AnchorToml> {
  const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
  logger.debug(`Fetching anchor TOML: ${tomlUrl}`);

  const response = await fetch(tomlUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch anchor TOML: ${response.status} ${response.statusText}`);
  }

  const tomlText = await response.text();

  // Lightweight TOML parser for the SEP-24 field
  const transferServerMatch = tomlText.match(/^TRANSFER_SERVER_SEP0024\s*=\s*"(.+)"/m);
  const fallbackMatch = tomlText.match(/^TRANSFER_SERVER\s*=\s*"(.+)"/m);

  return {
    TRANSFER_SERVER_SEP0024: transferServerMatch?.[1],
    TRANSFER_SERVER: fallbackMatch?.[1],
  };
}

export async function initiateSEP24Deposit(
  request: SEP24DepositRequest,
): Promise<SEP24DepositResponse> {
  const { anchorConfig, amount, userPublicKey, userEmail } = request;

  try {
    logger.info(`Initiating SEP-24 deposit for ${amount} ${anchorConfig.code} to ${userPublicKey}`);

    // 1. Fetch anchor TOML to get the transfer server URL
    const toml = await fetchAnchorToml(anchorConfig.homeDomain);
    const transferServer = toml.TRANSFER_SERVER_SEP0024 || toml.TRANSFER_SERVER;

    if (!transferServer) {
      throw new Error(
        `No SEP-24 transfer server found for anchor ${anchorConfig.homeDomain}`,
      );
    }

    // 2. POST to /transactions/deposit/interactive
    const depositUrl = `${transferServer}/transactions/deposit/interactive`;
    const formData = new URLSearchParams({
      asset_code: anchorConfig.code,
      amount,
      account: userPublicKey,
      ...(userEmail && { email_address: userEmail }),
      lang: 'en',
    });

    logger.debug(`POST ${depositUrl} with asset_code=${anchorConfig.code} amount=${amount}`);

    const response = await fetch(depositUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `SEP-24 deposit request failed (${response.status}): ${errorBody}`,
      );
    }

    const result = (await response.json()) as SEP24DepositResponse;
    logger.info(`SEP-24 interactive deposit initiated: ${result.url}`);
    return result;
  } catch (err) {
    logger.error(
      'Failed to initiate SEP-24 deposit',
      err instanceof Error ? err.message : String(err),
    );

    // Fallback: build a best-effort URL so the user can proceed manually
    const fallbackUrl = `https://${anchorConfig.homeDomain}/transactions/deposit/interactive?asset_code=${anchorConfig.code}&amount=${amount}&account=${userPublicKey}`;

    return {
      id: `manual-${Date.now()}`,
      type: 'interactive',
      url: fallbackUrl,
    };
  }
}

export async function pollSEP24Status(
  transferServer: string,
  transactionId: string,
): Promise<{ status: string; amount?: string }> {
  try {
    const url = `${transferServer}/transaction?id=${transactionId}`;
    logger.debug(`Polling SEP-24 transaction status: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`SEP-24 status check failed: ${response.status}`);
    }

    const result = await response.json();
    return {
      status: result.transaction?.status || 'unknown',
      amount: result.transaction?.amount_in,
    };
  } catch (err) {
    logger.error(
      'Failed to poll SEP-24 status',
      err instanceof Error ? err.message : String(err),
    );
    return { status: 'error' };
  }
}
