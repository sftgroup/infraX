-- @0xinfrax/payments — 006: batch collection (one-shot multi-payee)
--
-- The `batch` capability groups several a2a intents under one batch so an
-- agent can collect from N peers in a single request. Each item settles
-- through its own on-chain tx; the batch flips to `completed` when every
-- item is paid (atomic in the store).

CREATE TABLE IF NOT EXISTS payment_batches (
  id         BIGSERIAL PRIMARY KEY,
  batch_id   TEXT NOT NULL UNIQUE,           -- public id (batch_*)
  payer      TEXT NOT NULL,                  -- the paying agent wallet
  chain      TEXT,                           -- chain slot
  status     TEXT NOT NULL DEFAULT 'open',   -- open | completed | cancelled
  items      JSONB NOT NULL DEFAULT '[]',    -- [{itemId, paymentId, payee,
                                             --   amountWei, asset, status,
                                             --   reference}]
  metadata   JSONB,                          -- opaque business context
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_batches_payer ON payment_batches(payer, status);
