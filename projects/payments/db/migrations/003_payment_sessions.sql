-- @0xinfrax/payments — MPP sessions (payment channels) + vouchers (P2 scaffold)

CREATE TABLE IF NOT EXISTS payment_sessions (
  channel_id     TEXT PRIMARY KEY,          -- keccak256(payer,payee,asset,salt,chainId)
  payer          TEXT NOT NULL,
  payee          TEXT NOT NULL,
  chain          TEXT NOT NULL,
  asset          TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  deposit_wei    TEXT NOT NULL DEFAULT '0',
  current_cum    TEXT NOT NULL DEFAULT '0',
  spent_wei      TEXT NOT NULL DEFAULT '0',
  last_signature TEXT,
  status         TEXT NOT NULL DEFAULT 'open', -- open | closed
  salt           TEXT,
  auto_settle    BOOLEAN NOT NULL DEFAULT TRUE,     -- MPP auto-settle policy
  settle_interval_sec INTEGER NOT NULL DEFAULT 86400,
  last_settle_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_payer ON payment_sessions(payer, status);

CREATE TABLE IF NOT EXISTS payment_vouchers (
  id                BIGSERIAL PRIMARY KEY,
  channel_id        TEXT NOT NULL,
  cumulative_amount TEXT NOT NULL,
  signature         TEXT NOT NULL,
  signed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_channel ON payment_vouchers(channel_id, id);
