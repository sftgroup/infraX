// ---------------------------------------------------------------------------
// @0xinfrax/waas-sdk — thin wrapper over @0xinfrax/infrax-dk
// WAAS service surface: wallet (custodial wallets) + safe (multi-sig) + saas
// (tenant management) + sub (plan subscriptions). Same-source, synced
// releases with infrax-dk: re-exports only, no duplicated implementation.
// Callers needing the full stack should use @0xinfrax/infrax-dk directly.
// ---------------------------------------------------------------------------

import { InfraX, WalletAPI, SafeAPI, SaaSAPI, SubAPI } from '@0xinfrax/infrax-dk';
import type { InfraXConfig } from '@0xinfrax/infrax-dk';

export { InfraX, WalletAPI, SafeAPI, SaaSAPI, SubAPI };
export type { InfraXConfig };

/** WAAS service client: custodial wallets + multi-sig safes + SaaS tenants + subscriptions. */
export interface WaasClient {
  wallet: WalletAPI;
  safe: SafeAPI;
  saas: SaaSAPI;
  sub: SubAPI;
}

/** Build a WAAS-only client from the shared InfraX config. */
export function createWaasClient(config: InfraXConfig = {}): WaasClient {
  const x = new InfraX(config);
  return { wallet: x.wallet, safe: x.safe, saas: x.saas, sub: x.sub };
}

export default createWaasClient;
