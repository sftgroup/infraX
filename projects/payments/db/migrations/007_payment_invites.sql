-- @0xinfrax/payments — 007: business billing invitations (the `invite` capability)
--
-- One invite wraps an a2a payment intent and tracks its lifecycle:
--   created → sent → settled | expired | cancelled
-- Past-due invites expire lazily (checked on read / settle / pay).

CREATE TABLE IF NOT EXISTS payment_invites (
  id            BIGSERIAL PRIMARY KEY,
  invite_id     TEXT NOT NULL UNIQUE,        -- public id (inv_*)
  payment_id    TEXT NOT NULL,               -- underlying a2a intent
  payer         TEXT NOT NULL,               -- the paying agent
  payee         TEXT NOT NULL,               -- the collecting agent
  asset         TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  chain         TEXT NOT NULL,
  amount_wei    TEXT NOT NULL,               -- atomic units
  memo          TEXT,                        -- human-readable bill note
  due_at        TIMESTAMPTZ,                 -- deadline (lazy expiry)
  status        TEXT NOT NULL DEFAULT 'created', -- created|sent|settled|expired|cancelled
  settled_method TEXT,                       -- chain | balance
  settled_ref   TEXT,                        -- tx hash (chain) / transfer id (balance)
  metadata      JSONB,                       -- opaque business context
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_invites_payer ON payment_invites(payer, status);
CREATE INDEX IF NOT EXISTS idx_payment_invites_payee ON payment_invites(payee, status);
CREATE INDEX IF NOT EXISTS idx_payment_invites_due ON payment_invites(status, due_at);
