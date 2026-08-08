-- @0xinfrax/payments — credit ledger + balances (generic schema)

CREATE TABLE IF NOT EXISTS payment_credits (
  reference   TEXT PRIMARY KEY,             -- idempotency key (tx hash / provider sub id / payment id)
  payer       TEXT NOT NULL,
  amount_wei  TEXT NOT NULL,                -- atomic units (decimal string)
  asset       TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  chain_id    INTEGER NOT NULL,
  metadata    JSONB,
  credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_credits_payer ON payment_credits(payer);

CREATE TABLE IF NOT EXISTS payment_balances (
  address     TEXT NOT NULL,
  asset       TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  balance_wei TEXT NOT NULL DEFAULT '0',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (address, asset)
);

-- Generic access registry (used by PgPaymentStore.resolveAccess).
-- Hosts that manage their own access tables inject a custom store instead.
CREATE TABLE IF NOT EXISTS payment_access (
  id         BIGSERIAL PRIMARY KEY,
  subscriber TEXT NOT NULL,
  resource   TEXT NOT NULL,                 -- JSON-serialized resource id
  status     TEXT NOT NULL DEFAULT 'active', -- active | cancelled | expired
  starts_at  TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscriber, resource)
);
CREATE INDEX IF NOT EXISTS idx_payment_access_active ON payment_access(subscriber) WHERE status = 'active';
