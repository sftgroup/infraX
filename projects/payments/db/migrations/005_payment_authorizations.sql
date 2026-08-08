-- @0xinfrax/payments — 005: period authorizations + schema extensions (P2–P4)
--
-- Covers the three rails added in P2–P4 on top of the base schema:
--   * payment_authorizations — period-scheme authorizations (Permit2 / upto /
--     period all share this table): owner-approved funds consumed over time.
--   * payment_sessions policy columns — auto-settle configuration used by MPP.
--   * payment_intents.payee — a2a rail records the receiving wallet.
--
-- Every statement is idempotent (IF NOT EXISTS) so migrations can be re-applied.

CREATE TABLE IF NOT EXISTS payment_authorizations (
  id              TEXT PRIMARY KEY,          -- public authorization id
  owner           TEXT NOT NULL,             -- payer wallet (signer)
  asset           TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  chain           TEXT NOT NULL,
  amount_wei      TEXT NOT NULL,             -- total authorized (atomic units)
  remaining_wei   TEXT NOT NULL,             -- still spendable
  period_price_wei TEXT NOT NULL,            -- one-period price (atomic units)
  periods         INTEGER NOT NULL,          -- authorized number of periods
  nonce           TEXT NOT NULL,             -- replay-protection nonce (hex salt)
  reference       TEXT NOT NULL UNIQUE,      -- idempotency key (tx hash / salt)
  status          TEXT NOT NULL DEFAULT 'active', -- active | exhausted | revoked
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_authorizations_owner
  ON payment_authorizations(owner, status);

-- a2a rail: the receiving wallet is money semantics (module-owned).
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS payee TEXT;

-- MPP auto-settle policy (session-level).
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS auto_settle BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS settle_interval_sec INTEGER NOT NULL DEFAULT 86400;
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS last_settle_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
