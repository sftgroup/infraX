-- ============================================================================
-- events 分区迁移 · 阶段 B：原子切换（停机窗口 <30s）
-- 前置：阶段 A 已把 08-14 ~ 08-16 迁入 events_p 对应分区并 DELETE 旧表
-- 流程：LOCK 阻塞写入 → 增量补迁旧表剩余数据（08-17 实时数据）→ RENAME
-- 回滚：ALTER TABLE events RENAME TO events_p; ALTER TABLE events_old RENAME TO events;
-- ============================================================================
BEGIN;

LOCK TABLE events IN ACCESS EXCLUSIVE MODE;

-- 增量补迁：events 中剩余数据（迁移点后新写入）插入对应分区。
-- 注：父表 INSERT 不支持 ON CONFLICT（PG14 限制，分区各自有唯一索引）；
-- 旧表剩余仅 08-17 实时数据（阶段 A 迁移只到 08-16），无重复风险。
INSERT INTO events_p SELECT * FROM events;

ALTER TABLE events RENAME TO events_old;
ALTER TABLE events_p RENAME TO events;

COMMIT;
