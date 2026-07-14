# InfraX Code Review Report

**Date:** 2026-07-13  
**Reviewer:** Automated Code Review  
**Project Path:** `/home/ubuntu/workspace/infraX/projects/`  
**Scope:** Full codebase audit — 7 modules

---

## Executive Summary

| Module | Status | Critical | High | Medium | Low | Total Issues |
|--------|--------|----------|------|--------|-----|-------------|
| DC | ⚠️ Needs Work | 0 | 0 | 1 | 2 | 3 |
| Collector | ⚠️ Needs Work | 1 | 2 | 2 | 1 | 6 |
| WAAS | ⚠️ Needs Work | 1 | 4 | 3 | 2 | 10 |
| Vault | 🔴 Critical | 2 | 3 | 2 | 1 | 8 |
| Admin | ⚠️ Needs Work | 1 | 3 | 2 | 1 | 7 |
| Payment | ⚠️ Needs Work | 0 | 2 | 2 | 1 | 5 |
| Web | ⚠️ Needs Work | 0 | 2 | 2 | 1 | 5 |
| **TOTAL** | | **5** | **16** | **14** | **9** | **44** |

---

## 1. DC Module (`projects/dc/`)

### 1.1 DB Connection
✅ **PASS** — `index.ts` line 10: `postgresql://ubuntu@localhost:5432/pocketx_dc` — Correctly points to `pocketx_dc`.

### 1.2 SQL Table References
✅ **PASS** — All SQL queries reference appropriate tables: `users`, `tenants`, `api_usage`. No reference to `dc_subscriptions` table found — the module uses `tenants` for subscription management.
⚠️ **MEDIUM (#DC-01)** — The DC module's SQL queries reference `api_usage` table (line 66):  
```sql
SELECT COUNT(*)::int as total FROM api_usage WHERE tenant_id = $1 AND timestamp >= $2
```
But the DC module does NOT create or migrate the `api_usage` table itself. If the WAAS module is responsible for creating this table, there's a **cross-module table dependency** that is not documented. The `dc/index.ts` file has no database initialization/migration code — it assumes tables already exist.

### 1.3 Error Handling
⚠️ **MEDIUM (#DC-02)** — The `/api/v2/data/usage` endpoint has no try/catch around the `pool.query` call for `api_usage`. If that table doesn't exist yet, it will throw a 500 error instead of a graceful response.
🔷 **LOW (#DC-03)** — No input validation on `planId` in `/subscribe` beyond the `find()` check. Should sanitize against SQL injection even though parameterized queries are used.

### 1.4 General
🔷 **LOW (#DC-04)** — `generateDcApiKey()` uses `crypto.randomBytes(24)` but doesn't use `uuidv4`/`uuid` package even though other modules do. Inconsistent crypto strategy across the codebase.

---

## 2. Collector Module (`projects/collector/`)

### 2.1 DB Connection
✅ **PASS** — `config.ts` line 11: Default is `postgresql://localhost:5432/pocketx_collector`. Correct.

### 2.2 CWallet Legacy References
🔴 **CRITICAL (#COL-01)** — `config.ts` contains a legacy `cwallet` config section (line 14-16):
```typescript
cwallet: {
    apiKey: process.env.CWALLET_API_KEY || 'dev-cwallet-key',
},
```
This `cwallet` config is referenced ONLY in `database.ts` line for seeding the default CWallet API key. The Collector module is supposed to be **independent** of the CWallet/WaaS system. This is a legacy coupling that should be removed or properly namespaced as `collector_internal_key`.
🟡 **HIGH (#COL-02)** — `database.ts` creates tables that belong to the WAAS module:
- `tenants` (with `api_key`, `api_secret_hash`, `sweep_address`, `sweep_threshold`)
- `address_pool`
- `sweep_records`
- `saas_withdrawals`
- `users` (with email UNIQUE constraint)
- `custodial_wallets`
- `transactions`
- `risk_rules`
- `webhook_events`
- `tokens`, `fee_configs`, `chains`
- `safe_wallets`, `safe_transactions`, `safe_signatures`

The Collector's `database.ts` is a **duplicate** of WAAS's `models/database.ts`. If both run against the same database, they will conflict. The Collector should only migrate its own tables (`events`, `event_checkpoints`, `payment_events`, `binance_futures_prices`, `okx_token_snapshots`, `admin_*` tables).

🟡 **HIGH (#COL-03)** — `adminRoutes.ts` queries WAAS-owned tables directly:
- `tenants` (line ~150+ for tenant listing)
- `address_pool` (for address counts)
- `saas_withdrawals` (for withdrawal listing)
- `transactions` (for transaction queue)
- `webhook_events` (for webhook listing)
- `sweep_records` (for sweep queue)
- `subscriptions`, `payment_orders`, `api_usage_daily` (for revenue dashboard)

These are **cross-module DB queries** — the Collector admin panel assumes it can access the WAAS database directly. If modules are deployed with separate DB credentials, these queries will fail.

### 2.3 API Note
⚠️ **MEDIUM (#COL-04)** — `apiKeyRoutes.ts` creates a SECOND `api_keys` table with different schema than WAAS:
- Collector: `(id SERIAL, label, api_key VARCHAR(64), rate_limit INT, enabled, created_by, request_count BIGINT)`
- WAAS: `(id UUID, key_hash VARCHAR(64), name, scope, enabled, expires_at, last_used_at)`

Two different tables with the same name `api_keys` with different schemas — this WILL cause conflicts if they share a database.

### 2.4 Error Handling
⚠️ **MEDIUM (#COL-05)** — `priceRoutes.ts` has a silent fallback for price queries — returns "Price not available" without distinguishing "no data" from "query error" from "OKX API not configured". Clients can't differentiate.

### 2.5 General
🔷 **LOW (#COL-06)** — `createIndex: IF NOT EXISTS idx_api_keys_key` is wrapped in `.catch()` that swallows ALL errors silently, not just "index already exists" errors.

---

## 3. WAAS Module (`projects/waas/`)

### 3.1 DB Connection
✅ **PASS** — `config/index.ts` line 9: Default is `postgresql://localhost:5432/pocketx_waas`. Correct.

### 3.2 Table References & SQL
🟡 **HIGH (#WAA-01)** — `routes/dataSubscriptionRoutes.ts` SQL queries reference `users.wallet_address` but the `users` table in WAAS's `models/database.ts` does NOT have a `wallet_address` column. It has `email` and `hd_wallet_id`. Queries like:
```sql
SELECT id FROM users WHERE wallet_address = $1 LIMIT 1
```
will fail at runtime. This affects all DC subscription endpoints (`/api/v2/data/subscribe`, `/api/v2/data/usage`, `/api/v2/data/key`).

🟡 **HIGH (#WAA-02)** — `routes/dataSubscriptionRoutes.ts` inserts into `tenants` with columns `owner_user_id`, `data_plan_id`, `dc_api_key`, `dc_api_key_created_at`:
```sql
INSERT INTO tenants (id, name, owner_user_id, data_plan_id, api_key, api_secret_hash, status)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active') RETURNING id
```
But the WAAS `tenants` table schema in `models/database.ts` does NOT include `owner_user_id`, `data_plan_id`, or `dc_api_key` columns. These columns need ALTER TABLE migrations.

🟡 **HIGH (#WAA-03)** — `routes/subscriptionRoutes.ts` references a `subscriptions` table:
```sql
SELECT s.*, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id
```
The `subscriptions` table is **never created** in `models/database.ts`. It exists nowhere in the WAAS schema initialization.

🟡 **HIGH (#WAA-04)** — `routes/paymentRoutes.ts` references `payment_orders` table throughout:
```sql
INSERT INTO payment_orders (order_id, user_id, amount, currency, description, payment_method,...)
```
But `payment_orders` is **never created** in `models/database.ts`. This table is missing from schema initialization.

⚠️ **MEDIUM (#WAA-05)** — `routes/saasRoutes.ts` queries `hot_wallet_balances` table (line for hot wallet balance):
```sql
LEFT JOIN hot_wallet_balances hwb ON hwb.tenant_id = $1 AND hwb.chain_id = c.chain_id
```
The `hot_wallet_balances` table is **never created** in `models/database.ts`.

⚠️ **MEDIUM (#WAA-06)** — `routes/walletRoutes.ts` (custom token section) creates `user_custom_tokens` table inline using `CREATE TABLE IF NOT EXISTS`. This is fragile — should be in the main migration.

### 3.3 Cross-Module DB References
🔴 **CRITICAL (#WAA-07)** — `routes/dataQueryRoutes.ts` re-exports routes at `/api/v2/data/events`, `/api/v2/data/stats`, `/api/v2/data/health`, `/api/v2/data/checkpoints` that query the Collector's tables (`events`, `event_checkpoints`) via the WAAS database pool. If the Collector is on a **separate DB** (`pocketx_collector`), these routes will fail because the WAAS DB pool connects to `pocketx_waas`.

Similarly, `services/dataWholesale.ts` and `services/dataCleaner.ts` in the WAAS module need to access Collector tables — this is an architectural issue.

### 3.4 Error Handling
⚠️ **MEDIUM (#WAA-08)** — `routes/internalRoutes.ts` `send-tx` and `sweep` endpoints catch errors with generic messages ("TX send failed", "Sweep failed") but don't differentiate between RPC failure, insufficient balance, invalid address, or gas estimation failure. Clients get the same 500 for all.

### 3.5 General
🔷 **LOW (#WAA-09)** — `routes/saasRoutes.ts` has duplicate route definitions:
- `POST /api/v2/saas/tenants/:tenantId/apikey` — defined twice (identical code)
- `POST /api/v2/saas/tenants/:tenantId/apikey/rotate` — defined twice
- `DELETE /api/v2/saas/tenants/:tenantId/apikey` — defined twice
- `POST /api/v2/saas/tenants/:tenantId/hot-wallet` — defined twice

Express will use only the first definition, making the second set silent dead code. This indicates a copy-paste error.

🔷 **LOW (#WAA-10)** — Admin JWT secret in `middleware/auth.ts` uses `crypto.randomBytes(16)` which resets on EVERY server restart, invalidating all existing tokens. Should use a persistent secret from config/env.

---

## 4. Vault Module (`projects/vault/`)

### 4.1 DB Connection
🔴 **CRITICAL (#VAU-01)** — `src/index.ts` (Vault's config) line 9: Default is `postgresql://localhost:5432/pocketx_cwallet`.  
This is a NEW module that should use `pocketx_vault`, not `pocketx_cwallet`. The name `pocketx_cwallet` is a legacy reference to the old monolithic CWallet database. This is the most serious naming issue in the codebase — the Vault module's entire config is a copy of the WAAS config with the legacy `pocketx_cwallet` database name.

### 4.2 Module Duplication
🔴 **CRITICAL (#VAU-02)** — The Vault module's `src/routes/safeRoutes.ts` and `src/services/multiSigService.ts` are **identical copies** of the WAAS module's `routes/safeRoutes.ts` and `services/multiSigService.ts`. If both modules run simultaneously:
- Both will try to create the same `safe_wallets`, `safe_transactions`, `safe_signatures` tables
- Both will process the same Safe deployments
- Race conditions on Safe deployment and transaction execution

The Vault module is supposed to be a standalone Safe multi-sig service, but it duplicates the entire Safe logic from WAAS.

🟡 **HIGH (#VAU-03)** — `src/middleware/auth.ts` is a copy of WAAS's `middleware/auth.ts` with the same session cache, same JWT secret generation issue, and same `users.wallet_address` SQL query. But Vault's database is `pocketx_cwallet` — so it would use a shared database with old CWallet data.

🟡 **HIGH (#VAU-04)** — `package.json` structure is incomplete. The script is `tsx server.ts` but there's no `server.ts` in the root — it's in `src/`. Unless the package.json is inside `src/`, this won't work. Additionally, the `vault/server.ts` file shows as non-text in this review (possibly binary or large), indicating it may be a different format than expected.

🟡 **HIGH (#VAU-05)** — The Vault module has NO `models/database.ts` file and no database initialization. It relies on tables being already created (presumably by WAAS or a shared migration). If deployed independently, it will crash on first query.

### 4.3 Table References
⚠️ **MEDIUM (#VAU-06)** — `multiSigService.ts` references `users.wallet_address` column, `wallets` table (for userId-to-address mapping), and `safes` table (in `getSafeCount`). The `safes` table doesn't match `safe_wallets` — the query `FROM safes WHERE owner_address = $1` will fail because the table is spelled `safe_wallets`.

⚠️ **MEDIUM (#VAU-07)** — `auth.ts` has `resolveUser()` that does `SELECT id FROM users WHERE wallet_address = $1` — but `users` table in the migrated schema uses `wallet_address` which doesn't exist on the WAAS `users` table. See #WAA-01.

### 4.4 General
🔷 **LOW (#VAU-08)** — Vault `src/index.ts` config contains the entire WAAS config including `cwallet`, `gasPool`, `hdWalletSeed`, `walletEncryptionKey`, `blockScanner`, `contracts`, `feeConfig` — most of which are not used by the Vault's Safe-only functionality. Should be trimmed.

---

## 5. Admin Module (`projects/admin/`)

### 5.1 Server Configuration
⚠️ **MEDIUM (#ADM-01)** — `server/index.ts` needs to be verified for DB pool coverage. Based on the project structure, the Admin module should connect to at minimum:
- `pocketx_collector` (for events, RPC config, OKX accounts)
- `pocketx_waas` (for users, wallets, transactions, tenants, risk_rules)
- `pocketx_dc` (for DC subscriptions, api_usage)
- `pocketx_vault` (for safe wallets)

If `server/index.ts` only has a single Pool, cross-DB queries will fail.

### 5.2 Cross-DB Queries
🟡 **HIGH (#ADM-02)** — The Collector module's `adminRoutes.ts` (which serves as the admin panel backend) queries tables across DB boundaries:
- `tenants` (WAAS DB)
- `address_pool` (WAAS DB)
- `saas_withdrawals` (WAAS DB)
- `transactions` (WAAS DB)
- `webhook_events` (WAAS DB)
- `subscriptions` (WAAS DB)
- `payment_orders` (WAAS DB)
- `api_usage_daily` (DC DB)
- `api_usage` (DC DB)
- `api_keys` (Collector DB — schema conflict with WAAS)

The Admin panel has NO mechanism to route queries to different database instances. It uses the Collector's `pool` for ALL queries.

🟡 **HIGH (#ADM-03)** — `adminRoutes.ts` import structure is wrong: The admin panel is served from the Collector module (`collector/src/routes/adminRoutes.ts`), but it imports from `../database` which is the Collector's pool. This means admin functionality is tightly coupled to the Collector's deployment.

🟡 **HIGH (#ADM-04)** — `managementRoutes.ts` has a `requireAdmin` function that is essentially a no-op:
```typescript
function requireAdmin(req, res, next) { next(); }
```
This means ALL admin routes are unauthenticated at the route level (though they're behind `sessionAuth` from `index.ts` mounting). The admin guard `requireAdmin` does nothing.

### 5.3 Authentication
🔴 **CRITICAL (#ADM-05)** — The admin login uses hardcoded credentials comparison:
```typescript
if (username === config.admin.username && password === config.admin.password)
```
With default values `admin` / `pocketx123`. While config defaults are fine for dev, the password is stored in plaintext in config and there's no password hashing (unlike admin_users table which uses SHA-256 hash). The login endpoint should use the `admin_users` table instead of env config.

⚠️ **MEDIUM (#ADM-06)** — Session tokens are stored in memory (`initSessionStore`). If the server restarts, all admin sessions are invalidated. Should use Redis (which is a dependency in package.json but not used for sessions).

### 5.4 General
🔷 **LOW (#ADM-07)** — The admin panel HTML (`admin/index.html`) was not fully reviewed due to tool limitations, but should be checked for XSS vulnerabilities given it's an admin interface.

---

## 6. Payment Module (`projects/payment/`)

### 6.1 Module Structure
✅ No `server.ts` found — the payment routes are embedded in the WAAS module at `waas/routes/paymentRoutes.ts`. The standalone `projects/payment/` directory contains only `src/routes/paymentRoutes.ts` and `src/routes/subscriptionRoutes.ts`.

⚠️ **MEDIUM (#PAY-01)** — The `projects/payment/` directory has NO `package.json`, no `server.ts`, no `index.ts`, and no `config.ts`. It is **not independently deployable** — it's just a partial code copy of WAAS payment routes. This directory structure is misleading.

### 6.2 Code Quality
🟡 **HIGH (#PAY-02)** — Stripe webhook endpoint (`/stripe/webhook`) is a placeholder:
```typescript
console.log('[Stripe Webhook]', JSON.stringify(req.body));
res.json({ received: true });
```
No signature verification, no error handling, no order status update. In production, this means Stripe payments will never be reconciled.

🟡 **HIGH (#PAY-03)** — The x402 protocol implementation has critical TODOs:
- No facilitator verification (commented as "verify signature with facilitator" but not implemented)
- Token amount is set equal to USD amount with no exchange rate conversion
- `PAYMENT_RECEIVE_ADDRESS` defaults to `0x0000...0000`

⚠️ **MEDIUM (#PAY-04)** — `payment_orders` table referenced throughout but never created — same as #WAA-04. The table migration is missing.

### 6.3 General
🔷 **LOW (#PAY-05)** — No payment method validation — `paymentMethod` can be any string and is stored as-is; only Stripe has special handling in the webhook.

---

## 7. Web Module (`projects/web/`)

### 7.1 Frontend Quality
🟡 **HIGH (#WEB-01)** — The web module files (`index.html`, `modules/nc-wallet.js`, `modules/core.js`, etc.) could not be fully read during this review due to tool output limitations. This is a **review gap** that must be filled manually. Specifically:
- `index.html` needs syntax checking
- `nc-wallet.js` needs verification that CryptoJS/ethers imports are correct
- `mpc-wallet.js` needs validation of MPC wallet initialization flow
- `datacenter.js` needs verification of Data Center API key flow

🟡 **HIGH (#WEB-02)** — Based on the project structure, `nc-wallet.js` is a **partially-rewritten module** from the original NC Wallet. Unknown residual references to old CWallet APIs may exist. Manual review required.

⚠️ **MEDIUM (#WEB-03)** — `connect.html` and `admin.html` are separate HTML files that likely duplicate `index.html`'s header/footer. This creates maintenance burden — changes must be replicated across all HTML files.

⚠️ **MEDIUM (#WEB-04)** — All module JS files appear to be plain JavaScript (no bundler, no TypeScript compilation step). There's no `package.json` or build configuration in the `web/` directory. This means:
- No linting for syntax errors at build time
- No minification for production
- No import/export support (modules likely use global variables)

### 7.2 General
🔷 **LOW (#WEB-05)** — No CSP (Content Security Policy) configuration detected. For a web application handling crypto wallets, CSP headers are critical to prevent XSS attacks.

---

## 8. Cross-Cutting Issues

### 8.1 Database Naming Inconsistency
| Module | Default DB Name | Status |
|--------|----------------|--------|
| DC | `pocketx_dc` | ✅ Correct |
| Collector | `pocketx_collector` | ✅ Correct |
| WAAS | `pocketx_waas` | ✅ Correct |
| Vault | `pocketx_cwallet` | 🔴 **WRONG** — should be `pocketx_vault` |

### 8.2 Table Schema Conflicts
The following tables have conflicting schemas across modules:
- `api_keys` — Collector (SERIAL PK, plain key) vs WAAS (UUID PK, hashed key)
- `users` — DC/WaaS queries `wallet_address` but WAAS schema has `email`
- `tenants` — DC module uses `owner_user_id`, `data_plan_id`, `dc_api_key` columns not in WAAS schema
- `subscriptions` — Referenced but never created
- `payment_orders` — Referenced but never created
- `api_usage` / `api_usage_daily` — Referenced but never created

### 8.3 Module Independence
The Collector module is NOT independent — it includes the WAAS database schema and queries WAAS tables. This creates a hard coupling that prevents independent deployment.

### 8.4 Vault Module Status
The Vault module appears to be an **in-progress extraction** from the WAAS monolith:
- Shares identical Safe route/service code with WAAS
- Uses legacy `pocketx_cwallet` DB name
- Has no independent database initialization
- Has duplicate dependencies and config

### 8.5 Payment Module Status
The Payment module is **NOT a standalone module** — it's a partial code copy embedded in the WAAS module. The `projects/payment/` directory should either be completed as a standalone module or removed.

---

## 9. Priority Remediation Plan

### Immediate (Critical — Must Fix Before Production)
1. **#VAU-01**: Fix Vault DB name from `pocketx_cwallet` to `pocketx_vault`
2. **#VAU-02**: Remove duplicate Safe code from WAAS or Vault (choose one canonical location)
3. **#WAA-07**: Fix WAAS data query routes to proxy to Collector API instead of direct DB access
4. **#COL-02**: Remove WAAS table migrations from Collector `database.ts`
5. **#ADM-05**: Replace hardcoded admin credentials with hashed database auth

### High Priority (Must Fix Before Stable Release)
6. **#WAA-01**: Add `wallet_address` column to WAAS `users` table
7. **#WAA-02**: Add DC columns to WAAS `tenants` table
8. **#WAA-03/#WAA-04**: Create `subscriptions` and `payment_orders` tables in WAAS migration
9. **#COL-03**: Replace direct WAAS table queries in Collector admin routes with API calls
10. **#COL-01**: Remove legacy CWallet config from Collector
11. **#ADM-02/#ADM-03**: Fix admin module to support multi-DB routing
12. **#PAY-02/#PAY-03**: Complete Stripe webhook and x402 payment verification
13. **#VAU-05**: Add database initialization to Vault module
14. **#WEB-01/#WEB-02**: Complete manual review of web frontend code

### Medium Priority
- All MEDIUM severity issues listed above (16 items)

### Low Priority
- All LOW severity issues listed above (9 items)
- Code style and consistency improvements

---

## 10. Appendix: File Inventory

### Files Successfully Reviewed
- `dc/index.ts` ✅
- `dc/package.json` ✅
- `collector/src/config.ts` ✅
- `collector/src/index.ts` ✅
- `collector/src/database.ts` ✅
- `collector/package.json` ✅
- `collector/src/routes/adminRoutes.ts` ✅
- `collector/src/routes/dataRoutes.ts` ✅
- `collector/src/routes/managementRoutes.ts` ✅
- `collector/src/routes/relayRoutes.ts` ✅
- `collector/src/routes/priceRoutes.ts` ✅
- `collector/src/routes/apiKeyRoutes.ts` ✅
- `collector/src/services/migration.ts` ✅
- `collector/src/middleware/apiKeyAuth.ts` (partial)
- `collector/src/middleware/sessionAuth.ts` (partial)
- `waas/config/index.ts` ✅
- `waas/index.ts` ✅
- `waas/models/database.ts` ✅
- `waas/routes/walletRoutes.ts` ✅
- `waas/routes/txRoutes.ts` ✅
- `waas/routes/subscriptionRoutes.ts` ✅
- `waas/routes/dataSubscriptionRoutes.ts` ✅
- `waas/routes/paymentRoutes.ts` ✅
- `waas/routes/mpcRoutes.ts` ✅
- `waas/routes/safeRoutes.ts` ✅
- `waas/routes/saasRoutes.ts` ✅
- `waas/routes/internalRoutes.ts` ✅
- `waas/routes/dataQueryRoutes.ts` ✅
- `waas/middleware/auth.ts` (duplicate, reviewed via Vault copy)
- `vault/src/index.ts` ✅
- `vault/src/routes/safeRoutes.ts` ✅
- `vault/src/services/multiSigService.ts` ✅
- `vault/src/middleware/auth.ts` ✅

### Files Requiring Manual Review
- `vault/server.ts` — Non-text / binary content
- `admin/server/index.ts` — >4000 chars, partially reviewed
- `web/index.html` — Tool output limitation
- `web/modules/nc-wallet.js` — Tool output limitation
- `web/modules/core.js` — Tool output limitation
- `web/modules/mpc-wallet.js` — Not reviewed
- `web/modules/datacenter.js` — Not reviewed
- `web/modules/payment.js` — Not reviewed
- `web/modules/safe.js` — Not reviewed
- `web/modules/waas.js` — Not reviewed
- `web/connect.html` — Not reviewed
- `web/admin.html` — Not reviewed
- `payment/src/routes/paymentRoutes.ts` — Tool output limitation (duplicate of waas version)
- `payment/src/routes/subscriptionRoutes.ts` — Tool output limitation (duplicate of waas version)

---

*End of Report*
