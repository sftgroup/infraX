-- ============================================================================
-- events 表时间分区迁移（DROP PARTITION 物理回收，长期方案落地）
-- 背景：events 现为普通表，cleaner 用批量 DELETE + VACUUM（死元组复用，但
--       VACUUM 不物理收缩文件，磁盘峰值 = 保留窗口峰值）。本脚本将 events
--       改造为 PostgreSQL 原生声明式分区表（按 collected_at RANGE，日分区）：
--       清理 = DROP PARTITION（物理删除文件，无死元组/无 VACUUM 负担）。
--
-- 约束与前提：
--   * events 无 PRIMARY KEY（id UUID NOT NULL 但无 PK 约束），无 PK 迁移问题
--   * 唯一索引 (event_id, collected_at)：分区表要求分区键包含于唯一索引，
--     collected_at 即分区键 → 每分区建 UNIQUE (event_id, collected_at) 即可
--   * INSERT ON CONFLICT (event_id, collected_at) 在分区表可用（分区内唯一）
--   * reclassifier 的 UPDATE ... WHERE event_id = ? AND collected_at = ?
--     命中分区键，可路由；其余查询按 collected_at 条件天然分区裁剪
--   * 仅适用于 native 分区（非 TimescaleDB；TimescaleDB 未安装）
--
-- 执行方式（排期停机窗口，见 tasklist §9.16 遗留① / backup 排期）：
--   psql -h 10.3.8.6 -d pocketx_collector -f events_partition_migrate.sql
--   或分步执行（第 3 步数据迁移最长，可分多次运行后原子切换）。
-- 回滚：切换前 events_old 保留；确认后 DROP TABLE events_old。
-- ============================================================================

-- ── 0. 前置：清理占位（保留窗口与 production 对齐 72h）──────────────
-- 迁移起点 = 保留窗口起始（更老数据由 cleaner 删除，不迁移）
-- 假设 NOW() 为执行时刻；迁移窗口 = [NOW() - 96h, NOW() + 1d)（含缓冲）

-- ── 1. 建分区父表（shadow，含 DEFAULT 复制，不含索引）──────────────────
CREATE TABLE IF NOT EXISTS events_p (LIKE events INCLUDING DEFAULTS INCLUDING STORAGE)
  PARTITION BY RANGE (collected_at);

-- ── 2. 日分区（示例 2026-08-16..18；生产用 generate_series 动态生成，
--        或由 cleaner/维护脚本按需提前创建未来 3 天分区）────────────────
CREATE TABLE IF NOT EXISTS events_p_20260816 PARTITION OF events_p
  FOR VALUES FROM ('2026-08-16 00:00:00') TO ('2026-08-17 00:00:00');
CREATE TABLE IF NOT EXISTS events_p_20260817 PARTITION OF events_p
  FOR VALUES FROM ('2026-08-17 00:00:00') TO ('2026-08-18 00:00:00');
CREATE TABLE IF NOT EXISTS events_p_20260818 PARTITION OF events_p
  FOR VALUES FROM ('2026-08-18 00:00:00') TO ('2026-08-19 00:00:00');

-- ── 3. 数据迁移（分批，避免长事务；幂等靠分区唯一索引）────────────────
--    每分区独立 INSERT ... SELECT（collected_at 段锁定）：
--    INSERT INTO events_p_20260816 SELECT * FROM events
--     WHERE collected_at >= '2026-08-16 00:00:00' AND collected_at < '2026-08-17 00:00:00'
--    ON CONFLICT (event_id, collected_at) DO NOTHING;

-- ── 4. 每分区索引（与旧表查询路径对齐）────────────────────────────────
CREATE UNIQUE INDEX ON events_p_20260816 (event_id, collected_at);
CREATE INDEX ON events_p_20260816 (chain, block_number DESC);
CREATE INDEX ON events_p_20260816 (block_number DESC);
CREATE INDEX ON events_p_20260816 (to_address, chain, block_number DESC);
CREATE INDEX ON events_p_20260816 (category_id, block_number DESC);
CREATE INDEX ON events_p_20260816 (label_id, block_number DESC);
CREATE INDEX ON events_p_20260816 (from_address);
CREATE INDEX ON events_p_20260816 (contract_address);
CREATE INDEX ON events_p_20260816 (tx_hash);
-- 每新增分区重复第 4 步（维护脚本/trigger 或迁移时一次生成）

-- ── 5. 原子切换（停机窗口内执行，锁表时间 < 1s）──────────────────────
-- BEGIN;
-- LOCK TABLE events IN ACCESS EXCLUSIVE MODE;
-- ALTER TABLE events RENAME TO events_old;
-- ALTER TABLE events_p RENAME TO events;
-- COMMIT;
-- -- 回滚：ALTER TABLE events RENAME TO events_p; ALTER TABLE events_old RENAME TO events;
-- -- 确认无误后物理删除旧表：DROP TABLE events_old;

-- ── 6. 清理 = DROP PARTITION（物理回收，无 VACUUM）─────────────────────
-- 保留窗口外整分区直接删除：
-- DROP TABLE events_20260715;  -- 2026-07-15 分区（当日数据 < 保留窗口）
-- 跨保留窗口的边界分区（残留行 < 窗口内）：DELETE 后 DROP（或留待下一日整分区 DROP）
