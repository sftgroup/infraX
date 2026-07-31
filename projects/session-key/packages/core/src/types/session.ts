export type SessionStatus = 'active' | 'revoked' | 'expired' | 'quota_exhausted';

export type Chain = 'eth' | 'bsc' | 'base' | 'polygon' | 'arbitrum' | 'optimism' | 'xlayer' | 'sol';

export interface PermissionConfig {
  contracts: string[];
  functions?: string[];
}

export interface SessionKey {
  id: string;
  userId: string;
  chain: Chain;
  sessionAddress: string;
  sessionKeyEnc: string;
  validFrom: Date;
  validUntil: Date;
  permissions: PermissionConfig;
  maxPerTx: string;
  maxTotal: string;
  totalSpent: string;
  status: SessionStatus;
  createdAt: Date;
  revokedAt?: Date;
}
