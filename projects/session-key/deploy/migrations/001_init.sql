CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Session Keys ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         VARCHAR(64)     NOT NULL,
    chain           VARCHAR(16)     NOT NULL,
    session_address VARCHAR(44)     NOT NULL,
    session_key_enc TEXT            NOT NULL,
    valid_from      TIMESTAMP       NOT NULL DEFAULT NOW(),
    valid_until     TIMESTAMP       NOT NULL,
    permissions     JSONB           NOT NULL DEFAULT '{}',
    max_per_tx      DECIMAL(36,18)  NOT NULL,
    max_total       DECIMAL(36,18)  NOT NULL,
    total_spent     DECIMAL(36,18)  NOT NULL DEFAULT 0,
    status          VARCHAR(16)     NOT NULL DEFAULT 'active',
    created_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMP,

    CONSTRAINT chk_status CHECK (status IN ('active','revoked','expired','quota_exhausted'))
);

CREATE INDEX IF NOT EXISTS idx_sk_user       ON session_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_sk_user_chain ON session_keys(user_id, chain);
CREATE INDEX IF NOT EXISTS idx_sk_status     ON session_keys(status);

-- ── Execution Log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_executions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID            NOT NULL REFERENCES session_keys(id) ON DELETE CASCADE,
    tx_hash         VARCHAR(66),
    contract        VARCHAR(42)     NOT NULL,
    function_sig    VARCHAR(10)     NOT NULL,
    value           DECIMAL(36,18)  NOT NULL DEFAULT 0,
    status          VARCHAR(16)     NOT NULL DEFAULT 'pending',
    error_reason    TEXT,
    executed_at     TIMESTAMP       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exec_session ON session_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_exec_hash    ON session_executions(tx_hash);
