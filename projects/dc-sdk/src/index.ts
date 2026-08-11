// ---------------------------------------------------------------------------
// @0xinfrax/dc-sdk — thin wrapper over @0xinfrax/infrax-dk
// DC service surface: on-chain events/tokens/chains/checkpoints + MQ-16 data
// plan subscriptions (subscribe/paymentCheck/verify/usage). Same-source,
// synced releases with infrax-dk: re-exports only.
// ---------------------------------------------------------------------------

import { InfraX, DCAPI } from '@0xinfrax/infrax-dk';
import type { InfraXConfig } from '@0xinfrax/infrax-dk';

export { InfraX, DCAPI };
export type { InfraXConfig };

/** DC service client: on-chain data + data-plan subscriptions. */
export interface DcClient {
  dc: DCAPI;
}

/** Build a DC-only client from the shared InfraX config. */
export function createDcClient(config: InfraXConfig = {}): DcClient {
  const x = new InfraX(config);
  return { dc: x.dc };
}

export default createDcClient;
