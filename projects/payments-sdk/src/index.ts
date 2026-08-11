// ---------------------------------------------------------------------------
// @0xinfrax/payments-sdk — thin wrapper over @0xinfrax/infrax-dk
// payments engine surface: fiat checkout, a2a two-phase, x402 verify,
// ledger balance, on-chain pricing, capabilities + batch/invite/transfer
// + WAAS sub (plan subscriptions). Same-source, synced releases with
// infrax-dk: re-exports only.
// ---------------------------------------------------------------------------

import { InfraX, PaymentAPI, SubAPI } from '@0xinfrax/infrax-dk';
import type { InfraXConfig } from '@0xinfrax/infrax-dk';

export { InfraX, PaymentAPI, SubAPI };
export type { InfraXConfig };

/** Payments engine client: payment rails + plan subscriptions. */
export interface PaymentsClient {
  payment: PaymentAPI;
  sub: SubAPI;
}

/**
 * Build a Payments-only client from the shared InfraX config.
 * The engine may live on a separate host — pass `paymentsUrl` (and
 * `paymentsApiKey`) in the config when it differs from the platform base.
 */
export function createPaymentsClient(config: InfraXConfig = {}): PaymentsClient {
  const x = new InfraX(config);
  return { payment: x.payment, sub: x.sub };
}

export default createPaymentsClient;
