-- ---------------------------------------------------------------------------
-- @0xinfrax/payments — 004: payment_events (outbound lifecycle event queue)
-- ---------------------------------------------------------------------------
-- Module-side event log emitted at payment lifecycle points:
--   payment.intent.created   → createPayment (chain / fiat intents)
--   payment.credited         → verifyPayment (x402 on-chain credit)
--   payment.intent.status    → updateIntentStatus (created/paid/failed/closed)
--   payment.webhook.received → handleWebhook (normalized provider event)
-- Downstream hosts (e.g. an AgentX subscription bridge) poll unprocessed rows
-- and mark them processed; the module itself never blocks on consumption.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  -- Correlation id: paymentId / tx hash / reference.
  reference TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Consumers read only the unprocessed tail.
CREATE INDEX IF NOT EXISTS idx_payment_events_unprocessed
  ON payment_events (created_at) WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payment_events_reference
  ON payment_events (reference);
