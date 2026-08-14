# InfraX 生产扩容迁移方案（方案 C：整盘迁移 + ML 服务外迁）

> 状态：**待执行**（2026-08-15 定稿）
> 背景：172 服务器（2C3.6G）内存/CPU 长期高负载（swap 已用 1.3G、15min load 曾达 3.19），新增一台同规格（2C4G）服务器分流。

## 1. 现状与目标

| 项 | 现状 | 迁移后 |
|---|---|---|
| 172（43.163.105.172） | 单机承载 24+ 服务，postgres 占 ~1.1G 内存 + ~60% CPU | 保留采集/对外/MCP 全家桶，负载降至 ~1.0 以下 |
| 新机（43.156.78.59） | 空白（2C4G Ubuntu 22.04，系统盘 60G） | 承载 postgres（整盘）+ ragservicer + knowledge-injector |

**核心决策**：172 的 `/dev/vdb`（200G 数据盘）是 postgres 唯一数据目录（10 库全在盘上，含 85G collector 事件库）。腾讯云同地域支持数据盘跨实例卸载/挂载，故采用**物理整盘迁移**——零数据传输、一次迁移全部库。

**新机同样 2C4G 的约束下**：172 跑 CPU 密集的采集/扫描（postgres 移走后单 collector ~35%），新机跑存储（postgres）+ ML/RAG 内存集中型服务，为最优分配。

## 2. 目标架构

```
172 (2C3.6G) — 保留                           新机 43.156.78.59 (2C4G) — 新增
├── 系统盘 vda 60G（代码/venv/日志）           ├── 数据盘 vdb 200G（随盘迁入）
├── collector :9101（写库走内网）              │    └── postgres 14（10 库，85G collector）
├── data :9112 + OpenD :11111                  ├── ragservicer :9721
├── dc :9102 / chain-rpc :9130                 ├── knowledge-injector :9113
├── vault/waas/mpc/payments/admin-legacy        └── egress 隧道 ×5 (18848-18852)
├── hub-index :3008 / web / nginx :9111
└── 各 MCP ×9
        │ 9 服务连接串改 新机内网 10.3.8.6:5432（内网 <1ms）
        └──────────────► postgres@新机
```

## 3. 迁移内容清单

**迁走**：
1. **vdb 数据盘**（200G，postgres 10 库，87G 已用）——物理挂载迁移，零数据传输
2. **infrax-ragservicer**（349M 内存，纯云端 API，无本地模型）
3. **infrax-knowledge-injector**（70M，含 yfinance Egress 代理池）
4. 新机自建 5 条 egress SSH 隧道（18848~18852，供 ki 出口 IP 轮换，token 同 RI-4）

**留在 172**（不动）：collector、dc、chain-rpc、data+OpenD、vault/waas/mpc/payments、admin-legacy、hub-index、web/nginx、全部 MCP

## 4. 数据库与连接方（已实测确认）

**postgres 物理结构**：
- `data_directory` = `/var/lib/postgresql/14/main` → 符号链接 → `/mnt/pgdata/main`（`/dev/vdb` 挂载点，fstab 已配置）
- 全部 10 个业务库物理文件在 `/dev/vdb` 上：pocketx_collector(85G) + dc/waas/payments/mpc/chainrpc/vault/admin + session_key_engine + 旧 pocketx_payment
- postgres 版本：**14**（新机默认 22.04 源为 14，需对齐）

**连接方（9 个服务，全部 `localhost:5432`）**：

| 服务 | 库 | 连接方式 |
|---|---|---|
| infrax-collector | pocketx_collector + pocketx_chainrpc | unit env + override.conf |
| infrax-chain-rpc | pocketx_chainrpc | 代码默认（改 env） |
| infrax-dc | pocketx_dc | unit env |
| infrax-vault / waas / mpc / payments | 各自库 | unit env |
| infrax-session-key | session_key_engine | .env |
| infrax-admin-legacy | pocketx_payment | .env（回退链） |

## 5. 配置改动清单（172 侧）

- **A. 9 服务连接串** `localhost:5432 → 10.3.8.6:5432`
- **B. nginx** `/api/rag/` proxy_pass → `10.3.8.6:9721`（`/api/data/`、`/api/v1/` 不动）
- **C. admin-legacy / hub-index** env：RAG_URL → 10.3.8.6:9721、INJECTOR_URL → 10.3.8.6:9113
- **D. 新机 postgres**：`listen_addresses=10.3.8.6`、pg_hba 放行 172（10.3.8.12）、shared_buffers=1G、max_connections 调低

## 6. 执行步骤

### 阶段 0（停机前，可随时做）
- 新机：Ubuntu 22.04 + postgresql-14 + python3.12 + node（已具备）
- 172：pg_dump 备份 9 个小库（~100M，防盘操作意外）
- rsync 新机 ragservicer/ki 代码 + venv + systemd units

### 阶段 1 — 停机窗口（10-30 分钟）
```
1. systemctl stop postgresql（172，先停再卸盘）
2. 腾讯云控制台：卸载 vdb → 挂载到新机 43.156.78.59
3. 新机：mount /dev/vdb /mnt/pgdata + fstab + 符号链接（目录结构与 172 一致）
4. 新机：postgresql.conf 调优 + pg_hba → 启动 → 验证 10 库齐全
```

### 阶段 2 — 服务切换
```
5. 172：9 服务连接串改 10.3.8.6 → 逐个 restart → 验证 DB 连接
6. 172：nginx /api/rag/ → 新机；admin-legacy/hub-index env
7. 新机：启动 ragservicer + knowledge-injector + 5 条 egress 隧道
```

### 阶段 3 — 验证
```
8. events 持续写入新机 DB、dc/chain-rpc 查询正常
9. 公网 /api/data、/api/rag、/api/v1 全部 200
10. 172 内存/swap 观察、tasklist 更新
```

**回滚**：停机窗口内把盘挂回 172 + 连接串改回 localhost（盘数据无变化，秒级恢复）。

## 7. 迁移后负载评估

### 172（迁移后）

| 指标 | 现在 | 迁移后 |
|---|---|---|
| CPU（loadavg） | 1.39 / 2.70 / 3.19 | ~0.6-0.8（postgres 60% 移走） |
| 内存 | 3.6G 满，swap 1.3G | ~2.3G/3.6G，swap 归零 |
| 磁盘 | vda 66% + vdb 47% | vda 66%（vdb 随盘迁走） |

### 新机（迁移后）

| 指标 | 预期 |
|---|---|
| CPU | postgres ~60% + rag 0.4% + ki 0.6% ≈ loadavg ~0.6 |
| 内存 | postgres ~2G + rag 0.35G + ki 0.07G + 系统 0.5G ≈ 3G/4G |
| 磁盘 | 87G/196G（47%） |

### 网络波动影响（已评估）
- 唯一敏感链路：collector/chain-rpc/dc → 新机 postgres（内网 0.225ms RTT，0% 丢包实测）
- collector 写库 ~1 事务/秒（批量 INSERT，`ON CONFLICT DO NOTHING` 幂等），断线重连不丢不重
- 高耦合服务群（collector↔chain-rpc↔payments↔data↔dc↔MCP）全留 172 同机，不跨机
- 结论：跨机影响可忽略，无需额外架构改动

## 8. 风险与规避

| 风险 | 规避 |
|---|---|
| 盘挂载失败 | 同地域已确认；执行前 9 小库先 dump 备份 |
| postgres 版本不一致 | 172 与新机均 postgres 14 |
| 停机期间 8 服务写失败 | 先停 postgres 再停服务；窗口 10-30 分钟 |
| 新机内存不足 | shared_buffers 调 1G + max_connections 调低 |

## 9. 二期可选（不在本次范围）

- collector 跟随数据迁新机（跨机 URL 5 处：collector→chain-rpc/payments、vault/data→collector），彻底消除跨机写库
- 决策依据：本次迁移后 172 负载已降至 ~1.0，collector 35% 不构成瓶颈，故不叠加变更风险
