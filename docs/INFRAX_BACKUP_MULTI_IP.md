# infraX 数据备份 + 多 IP 出口方案

> 2026-08-13 方案稿（待评审，未实施）；**2026-08-17 按当前架构更新**（postgres 已迁新机 43.156.78.59/内网 10.3.8.6；collector 库膨胀至 104GB → 整库排除备份）
> 背景：主服务器 43.163.105.172 单机承载全部 infraX 服务 + 单 IP 出口；
> 目标：① 关键业务数据异地备份，防单机灾难；② 多公网 IP 轮换，降低上游数据源限流。
> 约束：B 端零感知、fail-silent；不干扰目标服务器上的其他服务；密钥凭证不入 git。

---

## 1. 数据资产盘点（先定"备份什么"）

### 1.1 必须备份（不可再生，业务核心，合计 ~87MB）

| 库 | 内容 | 大小 | 备份优先级 |
|---|---|---|---|
| `pocketx_mpc` | MPC 钱包/密钥分片/验证码 | 9.4MB | **P0（丢了=用户资产不可恢复）** |
| `pocketx_payments` + `pocketx_payment` | 支付订单/账务流水 | 18MB | P0 |
| `pocketx_waas` / `pocketx_vault` / `pocketx_chainrpc` | 链上操作账本/多签/广播记录 | 29MB | P0 |
| `pocketx_dc` / `pocketx_admin` / `session_key_engine` | 租户 API Key/会话/后台配置 | 30MB | P1 |
| 配置文件（`.env`、systemd override、OpenD.xml） | 密钥凭证/连接串 | KB 级 | P0（**加密后**备份） |

### 1.2 不备份（可再生 / 重拉即得，**2026-08-17 用户确认整库排除**）

| 数据 | 理由 |
|---|---|
| **`pocketx_collector`（整库，~104GB，其中 events 表 103GB）** | events 设计即 72h 保留自动删，可从链上 RPC 重扫恢复；OKX 快照等小表可重拉；**2026-08-17 用户裁定 collector 不备份** |
| 日志、缓存 | 临时数据 |

> 备份口径结论：**全量 `pg_dump -Fc` 9 个业务库（不含 collector）+ 加密配置文件**，压缩后每日增量 ~50~90MB，跨网传输无压力。

---

## 2. 备份方案（P0，最先实施）

### 2.1 备份内容与格式

- 每个业务库独立 `pg_dump -Fc`（自定义格式，可单表恢复）；**collector 整库不备份**（§1.2）
- 配置文件：`tar` + `openssl enc -aes-256-gcm` 加密（口令存主服务器 root-only 文件，副本离线交用户保管）
- 目录结构：`/srv/infrax-backup/{YYYY-MM-DD}/{db}.dump.gz`

### 2.2 传输与存储（异地）

- 目标：一台空闲云服务器（磁盘 ≥10GB 空闲即可），目录 `/srv/infrax-backup`
- 通道：专用 SSH key（`~/.ssh/infrax_backup_rsa`，权限 600，仅主服务器持有），`rsync -z` 增量同步
- 目标服务器不部署任何 agent，仅 `sshd` + 磁盘目录

### 2.3 调度

- 主服务器 systemd timer：`infrax-backup.timer` 每日 03:30（避开业务高峰），`infrax-backup.service` 执行备份脚本
- 保留策略：本地/远端各留 **14 天** 每日 + **4 周** 每周（周一全量）+ **12 月** 每月（可配置）

### 2.4 验证与告警（防"备份了但恢复不了"）

- 备份脚本内嵌 `pg_restore --list` 校验 dump 完整性，失败即发告警（journal + 可选 webhook）
- **每月一次恢复演练**：在测试库 `pg_restore` 恢复并比对关键表行数（mpc_wallets 等）
- 验收标准：任一关键库可在 **15 分钟内**从最近备份恢复

### 2.5 events 历史归档（已评审：**不做**）

> **2026-08-13 评审结论：不归档**。实测 events 每天 ~19GB（1784 万行），归档需 8-10GB/天，1 个月 250-300GB，
> 且增加每天导出+传输开销；当前业务只需实时查询，72h 保留足够。保持只删不存（§1.2）。
> 若将来出现回测/审计需求再评估（届时优先归档到远程冷存储）。
> **2026-08-17 用户再确认：collector 整库（含 events 与 OKX 快照等小表）不备份**，备份仅覆盖 9 业务库 + 配置文件。

---

## 3. 多 IP 防限流方案

### 3.1 限流风险盘点（现全部走主服务器单 IP 出口）

| 数据源 | 用途 | 风险等级 |
|---|---|---|
| Yahoo Finance（yfinance） | 9 个全球股指（knowledge-injector） | **高**，单 IP 高频必 429 |
| OKX（www.okx.com） | 行情/榜单/K线/热币（collector） | 中 |
| 公共 RPC（publicnode/bsc-dataseed/base/oxachain） | 区块扫描（流量最大） | 中，节点级限流 |
| MooMoo OpenD | 行情（未接入生产） | 低（单会话） |

### 3.2 分层策略（先节流，再 RPC 池，最后代理池）

**第一层：请求侧节流（零风险，先行）**
- OKX/yfinance 统一加指数退避（429/5xx 时 1s→2s→4s…）+ 随机 jitter
- 先连续观察 24~48h，确认实际是否被限，再决定代理池投入

**第二层：RPC 多提供商池（不换 IP，靠 provider 配额叠加）**
- **阶段 A（2026-08-13 确认）**：用户将提供 **Infura / Alchemy API key** → 升级为 ETH/SEPOLIA/BSC/BASE 主 RPC（双 provider），免费节点降级为 failover 备选
- 阶段 B：免费节点池按健康度+延迟轮询、故障自动切换（现有 `rpc-pool` 已有节点降级检测，扩展为多 provider 轮询）
- 说明：不同 provider 限流相互独立，同一 IP 分摊到多个 provider 即放大总配额；但若某 provider 按 IP 限额，单 provider 配额不变，瓶颈=节点数×单节点配额
- 免费公共节点（publicnode/ankr/drpc/bsc-dataseed/base.org/oxachain）均按 IP 限流 → 多 IP 轮换（第三层代理池）对它们有效，配额 ×N

**第三层：出口代理池（核心，多 IP 直接轮换）**
- 在 2~3 台空闲服务器各部署一个轻量正向代理（CONNECT 代理，自写 ~30 行 Node/Python，或 tinyproxy），监听内网/白名单端口
- **鉴权**：`Proxy-Authorization` token + 源 IP 白名单（仅主服务器），不暴露公网
- **客户端接入**（主服务器调用侧）：
  - yfinance：请求级 `proxies={"http":..., "https":...}` 轮换
  - OKX（axios v1 走 undici）：每请求注入 `ProxyAgent` dispatcher
  - RPC（viem `http`）：`fetchOptions.dispatcher` 注入代理
- **轮换与降级**：按数据源绑定（Yahoo→代理A、OKX→代理B）或 round-robin；每代理 30s 健康探测，失败自动回**直连**（fail-silent，B 端零感知）
- 配置驱动：`EGRESS_PROXIES`（JSON）环境变量，**默认空=直连**，回滚只需清空配置重启

### 3.3 安全与资源

- 代理进程极轻（<20MB RSS），tinyproxy 可设 `MaxClients` 限流，不影响目标机主服务
- 带宽注意：区块扫描流量最大，代理池仅承担 Yahoo/OKX 低频请求为主，RPC 优先走直连+多提供商池

---

## 4. 实施阶段与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 备份** | 目标服务器确认 → 专用 SSH key → 备份脚本 + systemd timer → 首跑 → 恢复演练 | 每日自动备份成功；任一关键库 15 分钟内可恢复 |
| **P1 节流+RPC 池** | OKX/yfinance 指数退避；rpc-pool 多提供商轮询 | 连续 24h 无 429 剧增；单 RPC 节点故障自动切换无感知 |
| **P2 代理池** | 2 台目标机装代理 → `EGRESS_PROXIES` 接入 yfinance/OKX → 健康检查+回退 | Yahoo/OKX 出口 IP 可轮换；单代理故障 fail-silent |

---

## 5. 风险与回滚

- **跨机依赖 = 新故障域**：备份机不可用只影响"备份失败"（告警即可），不影响主服务
- **带宽**：每日备份 ~100MB 无压力；代理池流量需按目标机带宽评估（先只承担低频请求）
- **安全**：SSH key 600、代理 token+白名单、配置文件加密
- **干扰他机**：代理为轻量进程+限流，部署前确认目标机 CPU/带宽余量
- **回滚**：代理池全部配置驱动、默认直连；备份可随时停用 timer

---

## 6. 待确认事项（实施前置）

1. **目标服务器清单**：数量 / 公网 IP / 磁盘与带宽余量 / 与主服务器网络关系（同地域内网 or 公网）
2. **备份保留周期**偏好（默认 14 日 + 4 周 + 12 月）
3. **events 历史归档**是否需要（决定 P0 是否含 §2.5）
4. 是否接受公共 RPC 作为 failover 备选
