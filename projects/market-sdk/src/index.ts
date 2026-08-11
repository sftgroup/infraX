// ---------------------------------------------------------------------------
// @0xinfrax/market-sdk — thin wrapper over @0xinfrax/infrax-dk
// Market service surface: OKX ChainOS DEX data plane + MQ-16 market plan
// subscriptions (plans/checkout/paymentCheck/verify/usage). Same-source,
// synced releases with infrax-dk: re-exports only.
// ---------------------------------------------------------------------------

import { InfraX, MarketAPI } from '@0xinfrax/infrax-dk';
import type { InfraXConfig } from '@0xinfrax/infrax-dk';

export { InfraX, MarketAPI };
export type { InfraXConfig };

/** Market service client: ChainOS DEX data + market-plan subscriptions. */
export interface MarketClient {
  market: MarketAPI;
}

/** Build a Market-only client from the shared InfraX config. */
export function createMarketClient(config: InfraXConfig = {}): MarketClient {
  const x = new InfraX(config);
  return { market: x.market };
}

export default createMarketClient;
