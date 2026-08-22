import { ethers } from "hardhat";
import { Pool } from "pg";

/**
 * OE-8: ledger 转索引/对账层 — 日终对账脚本（ledger sum == 链上扣减）
 *
 * 权威方 = 链上 Escrow（balanceOf / chargedToday）；ledger（payments 引擎
 * payment_credits / payment_balances）降级为事件索引层。本脚本逐用户对比：
 *
 *   1. onchain_balance   = balanceOf(user)              （链上权威余额）
 *   2. ledger_balance    = payment_balances.balance_wei （索引层余额，可滞后）
 *   3. credits_sum       = Σ payment_credits.amount_wei （verify 入账索引合计）
 *   4. deposits_sum      = Σ 链上 Deposited 事件         （native 存款合计）
 *   5. charged_today     = chargedToday(user, day)      （当日净扣减）
 *
 * 对账断言：
 *   - credits_sum == deposits_sum（verify 索引完整，无漏记/多记）
 *   - onchain_balance == deposits_sum - 链上净扣减（守恒校验）
 *   - ledger_balance 与 onchain_balance 的偏差为已知窗口（异步索引），
 *     超出阈值（默认 0）即报 diff，供运维判定。
 *
 * 用法：
 *   ESCROW_ADDRESS=0x... \
 *   DATABASE_URL=postgresql://ubuntu@10.3.8.6:5432/infrax_payments \
 *   [FROM_BLOCK=0] [DAY=<unix day>] [DIFF_THRESHOLD_WEI=0] [USERS=a,b,c] \
 *   [LEGACY_BASE_BLOCK=<区块>] [LEGACY_BASE_BY_USER=0xuser=wei,...] \
 *   npx hardhat run scripts/reconcile.ts --network oxachain
 *
 * 迁移基准（OE-4 EOA→Escrow 注资属于一次性迁移，非 verify 充值）：
 *   - LEGACY_BASE_BLOCK：迁移基准块（默认 = FROM_BLOCK）。<= 该块的链上事件
 *     与 credited_at 早于该块时间的 payment_credits 视为历史基准，不参与对账。
 *   - LEGACY_BASE_BY_USER：迁移基准块时刻各用户已存在的链上余额（如平台 EOA
 *     `0x5682…=9999944629992224822`），从对账余额中扣除，避免迁移资金被误判为偏差。
 *
 * 退出码：0 = 无差异（或均在阈值内）；1 = 存在差异（对账不通过）。
 */
async function main() {
  const escrowAddr = process.env.ESCROW_ADDRESS || "";
  const dbUrl = process.env.DATABASE_URL || "";
  const fromBlock = Number(process.env.FROM_BLOCK || 0);
  const legacyBaseBlock = Number(process.env.LEGACY_BASE_BLOCK || fromBlock);
  const day = process.env.DAY ? Number(process.env.DAY) : Math.floor(Date.now() / 1000 / 86400);
  const diffThreshold = BigInt(process.env.DIFF_THRESHOLD_WEI || "0");
  const onlyUsers = (process.env.USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const legacyBase = new Map<string, bigint>();
  for (const kv of (process.env.LEGACY_BASE_BY_USER || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [u, w] = kv.split("=");
    if (u && w) legacyBase.set(u.toLowerCase(), BigInt(w));
  }

  if (!escrowAddr || !dbUrl) {
    console.error("ESCROW_ADDRESS 与 DATABASE_URL 必填");
    process.exit(2);
  }

  const provider = ethers.provider;
  const escrow = await ethers.getContractAt("InfraXEscrow", escrowAddr);

  const [network, latest] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  console.log(`链: ${network.name} (chainId=${network.chainId}) | escrow=${escrowAddr} | fromBlock=${fromBlock} → ${latest} | legacyBaseBlock=${legacyBaseBlock}`);
  if (latest < fromBlock) {
    console.error("fromBlock 大于当前区块");
    process.exit(2);
  }
  // 基准块时间戳：早于此时间的 payment_credits 视为历史基准
  const legacyBaseTime = Math.floor((await provider.getBlock(legacyBaseBlock)).timestamp);

  // ── 1. 链上事件聚合（native 资产，token == address(0)）──────────────────
  //    只统计迁移基准块之后的事件（<= 基准块的为一次性迁移/历史）
  const zero = ethers.ZeroAddress.toLowerCase();
  const isLegacy = (l: any) => (l.blockNumber as number) <= legacyBaseBlock;
  const nativeDeposit = (await escrow.queryFilter("Deposited", fromBlock, latest))
    .filter((l) => !isLegacy(l) && (l.args.token as string).toLowerCase() === zero);
  const nativeWithdraw = (await escrow.queryFilter("Withdrawn", fromBlock, latest))
    .filter((l) => !isLegacy(l) && (l.args.token as string).toLowerCase() === zero);
  const chargedLogs = (await escrow.queryFilter("Charged", fromBlock, latest)).filter((l) => !isLegacy(l));
  const refundedLogs = (await escrow.queryFilter("Refunded", fromBlock, latest)).filter((l) => !isLegacy(l));

  const sumBy = (logs: any[], pick: (l: any) => bigint) => {
    const m = new Map<string, bigint>();
    for (const l of logs) {
      const u = (l.args.user as string).toLowerCase();
      m.set(u, (m.get(u) || 0n) + pick(l));
    }
    return m;
  };
  const deposits = sumBy(nativeDeposit, (l) => l.args.amount as bigint);
  const withdrawals = sumBy(nativeWithdraw, (l) => l.args.amount as bigint);
  const charges = sumBy(chargedLogs, (l) => l.args.amount as bigint);
  const refunds = sumBy(refundedLogs, (l) => l.args.amount as bigint);

  // ── 2. ledger 侧（payments 引擎索引层）───────────────────────────────────
  //    只统计迁移基准时间之后的 verify 入账（早于基准的为 OE-4 迁移前历史）
  const pool = new Pool({ connectionString: dbUrl, max: 4 });
  const { rows: credits } = await pool.query(
    `SELECT payer, SUM(amount_wei::numeric) AS sum_wei
       FROM payment_credits
      WHERE asset = $1 AND credited_at >= to_timestamp($2 / 1000.0)
      GROUP BY payer`,
    [zero, legacyBaseTime * 1000]
  );
  const creditMap = new Map<string, bigint>();
  for (const r of credits) creditMap.set((r.payer as string).toLowerCase(), BigInt(r.sum_wei));

  const { rows: balances } = await pool.query(
    `SELECT address, balance_wei FROM payment_balances WHERE asset = $1`,
    [zero]
  );
  const balanceMap = new Map<string, bigint>();
  for (const r of balances) balanceMap.set((r.address as string).toLowerCase(), BigInt(r.balance_wei));
  await pool.end();

  // ── 3. 逐用户对账 ────────────────────────────────────────────────────────
  const users = onlyUsers.length
    ? onlyUsers
    : [...new Set([...deposits.keys(), ...withdrawals.keys(), ...charges.keys(), ...refunds.keys(), ...creditMap.keys(), ...balanceMap.keys()])].sort();

  console.log(`\n对账日 day=${day}，用户数=${users.length}`);
  console.log("用户".padEnd(46), "链上余额", "当日净扣", "Deposits", "Credits索引", "Ledger余额", "结果");
  console.log("-".repeat(130));

  let diffCount = 0;
  const rows: string[] = [];
  for (const u of users) {
    const onchain = await escrow.balanceOf(u);
    const chargedToday = await escrow.chargedToday(u, day);
    const dep = deposits.get(u) || 0n;
    const wd = withdrawals.get(u) || 0n;
    const chg = charges.get(u) || 0n;
    const ref = refunds.get(u) || 0n;
    const creditsSum = creditMap.get(u) || 0n;
    const ledgerBal = balanceMap.get(u) || 0n;
    // 迁移基准余额（OE-4 一次性注资，视为用户初始链上余额）
    const baseBal = legacyBase.get(u) || 0n;

    // 守恒：基准余额 + deposits - withdrawals - (charges - refunds) == 链上余额
    const conserved = baseBal + dep - wd - (chg - ref);
    const problems: string[] = [];
    if (conserved !== onchain) problems.push(`守恒偏差 ${conserved - onchain}`);
    if (creditsSum !== dep) problems.push(`索引偏差 ${creditsSum - dep}`);
    // 余额偏差：ledger 应与"链上余额 - 迁移基准"（当日净新增）一致；
    // 迁移基准资金在 OE-8 已结清，不计入索引层偏差
    const netNew = onchain - baseBal;
    const balDiff = ledgerBal > netNew ? ledgerBal - netNew : netNew - ledgerBal;
    if (balDiff > diffThreshold) problems.push(`余额偏差 ${balDiff}`);
    if (problems.length) diffCount++;

    rows.push(
      `${u.padEnd(46)} ${ethers.formatEther(onchain).padStart(18)} ${ethers.formatEther(chargedToday).padStart(12)} ` +
      `${ethers.formatEther(dep).padStart(12)} ${ethers.formatEther(creditsSum).padStart(13)} ${ethers.formatEther(ledgerBal).padStart(12)} ` +
      `${problems.length ? "DIFF: " + problems.join("; ") : "OK"}`
    );
  }
  console.log(rows.join("\n"));

  if (diffCount) {
    console.error(`\n[FAIL] ${diffCount}/${users.length} 个用户存在差异`);
    process.exit(1);
  }
  console.log(`\n[PASS] 全部 ${users.length} 个用户对账通过（ledger 索引 == 链上扣减）`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
