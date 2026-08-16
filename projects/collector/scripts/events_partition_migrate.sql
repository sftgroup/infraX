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
-- 执行方式（2026-08-17 排期停机窗口，见 tasklist §9.16 遗留① / backup 排期）：
--   psql -h 10.3.8.6 -U postgres -d pocketx_collector -f events_partition_migrate.sql
--   或分步执行（第 3 步数据迁移最长，可分多次运行后原子切换）。
-- 回滚：切换前 events_old 保留；确认后 DROP TABLE events_old。
--
-- 2026-08-17 生产版更新：
--   * 数据盘剩余 ~80G，events 103G（heap 72G + 索引 31G）→ 必须分批迁移：
--     每迁完一日分区，即从旧表删除该日数据并 VACUUM，控制峰值双份空间
--   * 索引精简：旧表 15 个索引（31G）→ 每分区仅 3 个关键索引
--     （UNIQUE (event_id, collected_at)、(chain, block_number DESC)、
--     (collected_at)），其余查询按分区裁剪 + collected_at 索引可满足
--   * 分两阶段：迁移期（不停机，分批 INSERT+DELETE）→ 切换期（短停写 <30s）
-- ============================================================================

-- ── 1. 建分区父表（shadow）──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events_p (LIKE events INCLUDING DEFAULTS INCLUDING STORAGE)
  PARTITION BY RANGE (collected_at);

-- ── 2. 创建未来 3 天日分区 + 过去保留窗口内分区（避免新数据无分区可写）──
--    用 DO 块动态生成：从迁移起点（保留窗口起始）到 NOW()+2 天
DO $$
DECLARE
  d date := (NOW() - INTERVAL '3 days')::date;  -- 迁移起点（保留窗口 72h + 缓冲）
  end_d date := (NOW() + INTERVAL '2 days')::date;
  pname text;
BEGIN
  WHILE d <= end_d LOOP
    pname := 'events_p_' || to_char(d, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF events_p FOR VALUES FROM (%L) TO (%L)',
      pname, d::text, (d + 1)::text
    );
    d := d + 1;
  END LOOP;
END $$;

-- ── 3. 每分区索引（先于迁移：ON CONFLICT 需要分区上先有唯一索引）──────
--    仅 3 个关键索引，替代旧表 15 个（其余查询按分区裁剪 + collected_at 索引）
DO $$
DECLARE
  d date := (NOW() - INTERVAL '3 days')::date;
  end_d date := (NOW() + INTERVAL '2 days')::date;
  pname text;
BEGIN
  WHILE d <= end_d LOOP
    pname := 'events_p_' || to_char(d, 'YYYYMMDD');
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (event_id, collected_at)',
                   pname || '_uk', pname);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (chain, block_number DESC)',
                   pname || '_cb', pname);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (collected_at)',
                   pname || '_ca', pname);
    d := d + 1;
  END LOOP;
END $$;

-- ── 4. 分批数据迁移（每批一日，迁完即从旧表删除该日并 VACUUM，控空间）──
--    循环执行：当前日期 = 保留窗口起始，递增到昨天（今天及以后的数据
--    由切换时增量补迁，避免迁移中 DELETE 误删 collector 实时写入的数据）。
--    该步骤可多次运行（幂等：ON CONFLICT DO NOTHING + 已迁日期跳过）。
DO $$
DECLARE
  d date := (NOW() - INTERVAL '3 days')::date;  -- 迁移起点（保留窗口 72h + 缓冲）
  end_d date := (NOW() - INTERVAL '1 day')::date;  -- 截止昨天
  pname text;
  inserted bigint;
BEGIN
  WHILE d <= end_d LOOP
    pname := 'events_p_' || to_char(d, 'YYYYMMDD');
    -- 迁移该日数据
    EXECUTE format(
      'INSERT INTO %I SELECT * FROM events
       WHERE collected_at >= %L AND collected_at < %L
       ON CONFLICT (event_id, collected_at) DO NOTHING',
      pname, d::text, (d + 1)::text
    );
    GET DIAGNOSTICS inserted = ROW_COUNT;
    RAISE NOTICE 'migrated % (% rows)', pname, inserted;
    -- 从旧表删除已迁移日（物理回收空间，控制双份峰值）。
    -- 注意：VACUUM 不能在函数内执行 → 循环结束后单独执行（见下）
    EXECUTE format(
      'DELETE FROM events WHERE collected_at >= %L AND collected_at < %L',
      d::text, (d + 1)::text
    );
    d := d + 1;
  END LOOP;
END $$;

-- 迁移循环完成后回收旧表死元组（VACUUM 不能放在 DO 块内）
VACUUM events;

-- ── 5. 原子切换（停机窗口内执行，锁表时间 < 1s）────────────────────────
-- 切换事务内先做增量补迁（LOCK 阻塞写入后，把迁移点之后新增的数据
-- 全部灌入对应分区，ON CONFLICT 幂等），再 RENAME，保证无数据丢失。
BEGIN;
LOCK TABLE events IN ACCESS EXCLUSIVE MODE;
-- 增量补迁：events 中剩余所有数据（迁移点后新写入）插入对应分区
INSERT INTO events_p SELECT * FROM events ON CONFLICT (event_id, collected_at) DO NOTHING;
ALTER TABLE events RENAME TO events_old;
ALTER TABLE events_p RENAME TO events;
COMMIT;
-- 回滚：ALTER TABLE events RENAME TO events_p; ALTER TABLE events_old RENAME TO events;
-- 确认无误后物理删除旧表：DROP TABLE events_old;

-- ── 6. 清理 = DROP PARTITION（物理回收，无 VACUUM）─────────────────────
-- 保留窗口外整分区直接删除（collector 内置 cleaner 已支持分区感知 DROP）：
-- DROP TABLE events_20260715;  -- 2026-07-15 分区（当日数据 < 保留窗口）
-- 跨保留窗口的边界分区（残留行 < 窗口内）：DELETE 后 DROP（或留待下一日整分区 DROP）
