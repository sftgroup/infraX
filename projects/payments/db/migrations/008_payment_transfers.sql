-- @0xinfrax/payments — 008: ledger-internal transfers (the `transfer` capability)
--
-- Unlike a2a (on-chain proof), a transfer moves funds between platform
-- balances with no new signature: the payer's host confirms once, then the
-- store debits `from_addr` and credits `to_addr` atomically in one tx.
-- `reference` is an idempotency key — a reference is executed at most once.

CREATE TABLE IF NOT EXISTS payment_transfers (
  id             BIGSERIAL PRIMARY KEY,
  transfer_id    TEXT NOT NULL UNIQUE,       -- public id (tf_*)
  from_addr      TEXT NOT NULL,              -- debited wallet
  to_addr        TEXT NOT NULL,              -- credited wallet
  asset          TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  amount_wei     TEXT NOT NULL,              -- atomic units
  status         TEXT NOT NULL DEFAULT 'requested', -- requested|executed|rejected|cancelled
  confirm_method TEXT NOT NULL DEFAULT 'callback',
  reference      TEXT NOT NULL UNIQUE,       -- idempotency key (invite id / client ref)
  executed_at    TIMESTAMPTZ,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_transfers_from ON payment_transfers(from_addr, status);
CREATE INDEX IF NOT EXISTS idx_payment_transfers_to ON payment_transfers(to_addr, status);
