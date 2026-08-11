// ---------------------------------------------------------------------------
// @0xinfrax/vault-sdk — thin wrapper over @0xinfrax/infrax-dk
// Vault service surface: multisig safe dashboard/create/propose/confirm/execute
// + risk. Same-source, synced releases with infrax-dk: re-exports only.
// ---------------------------------------------------------------------------

import { InfraX, VaultAPI } from '@0xinfrax/infrax-dk';
import type { InfraXConfig } from '@0xinfrax/infrax-dk';

export { InfraX, VaultAPI };
export type { InfraXConfig };

/** Vault service client: multisig safes + risk. */
export interface VaultClient {
  vault: VaultAPI;
}

/** Build a Vault-only client from the shared InfraX config. */
export function createVaultClient(config: InfraXConfig = {}): VaultClient {
  const x = new InfraX(config);
  return { vault: x.vault };
}

export default createVaultClient;
