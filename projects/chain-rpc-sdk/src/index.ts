// ---------------------------------------------------------------------------
// @0xinfrax/chain-rpc-sdk — thin wrapper over @0xinfrax/infrax-dk
// chain-rpc gateway surface: read calls (/v1/rpc/:chain with read key),
// broadcast (/v1/broadcast/:chain with independent broadcast key), status,
// health + MQ-16 subscription plans. Same-source, synced releases with
// infrax-dk: re-exports only.
// ---------------------------------------------------------------------------

import { InfraX, ChainRpcAPI } from '@0xinfrax/infrax-dk';
import type { InfraXConfig } from '@0xinfrax/infrax-dk';

export { InfraX, ChainRpcAPI };
export type { InfraXConfig };

/** Chain RPC gateway client: read + broadcast (key-separated) + subscriptions. */
export interface ChainRpcClient {
  chainRpc: ChainRpcAPI;
}

/**
 * Build a ChainRPC-only client from the shared InfraX config.
 * Broadcast requires `chainRpcBroadcastKey` (fail-closed without it).
 */
export function createChainRpcClient(config: InfraXConfig = {}): ChainRpcClient {
  const x = new InfraX(config);
  return { chainRpc: x.chainRpc };
}

export default createChainRpcClient;
