// ---------------------------------------------------------------------------
// @0xinfrax/data-sdk — thin wrapper over @0xinfrax/infrax-dk
// Data + ML service surface: market data plane (bars/snapshots/factors/
// ticker/symbols/ml-predictions/stats) + ml-service realtime inference.
// Same-source, synced releases with infrax-dk: re-exports only.
// ---------------------------------------------------------------------------

import { InfraX, DataAPI, MlAPI } from '@0xinfrax/infrax-dk';
import type { InfraXConfig } from '@0xinfrax/infrax-dk';

export { InfraX, DataAPI, MlAPI };
export type { InfraXConfig };

/** Data & ML service client: market data plane + realtime inference. */
export interface DataClient {
  data: DataAPI;
  ml: MlAPI;
}

/**
 * Build a Data-only client from the shared InfraX config.
 * Pass `dataUrl`/`dataApiKey` and `mlUrl`/`mlApiKey` when the data/ML
 * services live on separate hosts (e.g. ml-service :9120).
 */
export function createDataClient(config: InfraXConfig = {}): DataClient {
  const x = new InfraX(config);
  return { data: x.data, ml: x.ml };
}

export default createDataClient;
