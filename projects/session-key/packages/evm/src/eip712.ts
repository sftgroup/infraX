import type { Chain, PermissionConfig } from '@sftgroup/session-key-core';
import { CHAIN_IDS } from '@sftgroup/session-key-core';
import { verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export function buildSessionAuthMessage(params: {
  nonce: string;
  chainId: number;
  sessionAddress: string;
  permissions: PermissionConfig;
  validUntil: number;
  maxPerTx: string;
  maxTotal: string;
}) {
  const domain = {
    name: 'Session Key Engine',
    version: '1',
    chainId: params.chainId,
  } as const;

  const types = {
    SessionAuth: [
      { name: 'nonce', type: 'string' },
      { name: 'sessionAddress', type: 'address' },
      { name: 'contracts', type: 'string' },
      { name: 'validUntil', type: 'uint256' },
      { name: 'maxPerTx', type: 'uint256' },
      { name: 'maxTotal', type: 'uint256' },
    ],
  } as const;

  const value = {
    nonce: params.nonce,
    sessionAddress: params.sessionAddress as `0x${string}`,
    contracts: JSON.stringify(params.permissions.contracts),
    validUntil: BigInt(params.validUntil),
    maxPerTx: BigInt(params.maxPerTx),
    maxTotal: BigInt(params.maxTotal),
  };

  return { domain, types, primaryType: 'SessionAuth' as const, message: value };
}

export async function verifySessionAuthSignature(params: {
  userAddress: string;
  signature: string;
  nonce: string;
  chain: Chain;
  sessionAddress: string;
  permissions: PermissionConfig;
  validUntil: number;
  maxPerTx: string;
  maxTotal: string;
}): Promise<boolean> {
  const chainId = CHAIN_IDS[params.chain];
  if (!chainId) return false;

  const message = buildSessionAuthMessage({
    nonce: params.nonce,
    chainId,
    sessionAddress: params.sessionAddress,
    permissions: params.permissions,
    validUntil: params.validUntil,
    maxPerTx: params.maxPerTx,
    maxTotal: params.maxTotal,
  });

  return verifyTypedData({
    address: params.userAddress as `0x${string}`,
    ...message,
    signature: params.signature as `0x${string}`,
  });
}

export function generateSessionKey(): { address: string; privateKey: string } {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { address: account.address, privateKey: pk };
}
