-- AX-6 / PC-2: 通用访问扣费审计日志（宿主可订阅审计/对账）
-- ref_id 唯一 → 按次扣费幂等（对齐 AgentX a2a_pay_log 的 payer/agent_id/amount/ref_id 语义）
CREATE TABLE IF NOT EXISTS payment_access_log (
  id BIGSERIAL PRIMARY KEY,
  ref_id VARCHAR(128) NOT NULL UNIQUE,
  subscriber VARCHAR(64) NOT NULL,
  resource TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  asset VARCHAR(64) NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  chain VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_access_log_subscriber ON payment_access_log (subscriber);
CREATE INDEX IF NOT EXISTS idx_payment_access_log_created_at ON payment_access_log (created_at DESC);
