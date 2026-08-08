-- @0xinfrax/payments — unified payment intents (generic schema)
-- One row per payment intent across all rails (chain / fiat / x402 / mpp / a2a).
-- Business context is stored opaquely in `metadata` and never interpreted here.

CREATE TABLE IF NOT EXISTS payment_intents (
  id         BIGSERIAL PRIMARY KEY,
  intent_id  TEXT NOT NULL UNIQUE,          -- public id (paymentId)
  method     TEXT NOT NULL,                 -- chain | fiat | x402 | mpp | a2a
  subscriber TEXT,                          -- payer wallet
  asset      TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  amount_wei TEXT,                          -- atomic units (decimal string)
  currency   TEXT,                          -- fiat currency when applicable
  chain      TEXT,                          -- chain slot
  status     TEXT NOT NULL DEFAULT 'created', -- created | paid | failed | closed
  metadata   JSONB,                         -- opaque business context
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_subscriber ON payment_intents(subscriber, status);
CREATE INDEX IF NOT EXISTS idx_payment_intents_method ON payment_intents(method);
