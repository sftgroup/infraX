// InfraXEscrow 充值构建 单测（REQ-1 / REQ-5，docs/AA_RELAY_BILLING.md §5）
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem';
import {
  InfraXEscrowAbi,
  encodeDeposit,
  encodeDepositFor,
  encodeDepositForBatch,
  encodeDepositForERC20,
  encodeDepositForERC20Batch,
  buildDepositForUserOp,
  buildDepositForBatchUserOp,
  buildDepositForERC20UserOp,
  buildDepositForERC20BatchUserOp,
} from '../src/escrow.js';
import { encodeExecute, encodeExecuteBatch } from '../src/userop.js';

const ESCROW = '0x1111111111111111111111111111111111111111' as Address;
const SENDER = '0x0000000000000000000000000000000000000001' as Address;
const USER_A = '0x2222222222222222222222222222222222222222' as Address;
const USER_B = '0x3333333333333333333333333333333333333333' as Address;
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;

/** 解码 escrow 调用（verify 编码结果与参数一致） */
function decodeCall(data: Hex) {
  return decodeFunctionData({ abi: InfraXEscrowAbi, data });
}

describe('escrow 编码 helpers（calldata 层）', () => {
  it('encodeDeposit → deposit() 无参数', () => {
    const { functionName, args } = decodeCall(encodeDeposit());
    expect(functionName).toBe('deposit');
    expect(args ?? []).toEqual([]);
  });

  it('encodeDepositFor 编码 user 参数', () => {
    const { functionName, args } = decodeCall(encodeDepositFor(USER_A));
    expect(functionName).toBe('depositFor');
    expect(args[0].toLowerCase()).toBe(USER_A.toLowerCase());
  });

  it('encodeDepositForBatch 编码 users/amounts（等长校验由 builder 负责）', () => {
    const users = [USER_A, USER_B];
    const amounts = [1n, 2n];
    const { functionName, args } = decodeCall(encodeDepositForBatch(users, amounts));
    expect(functionName).toBe('depositForBatch');
    expect((args[0] as Address[]).map((a) => a.toLowerCase())).toEqual(users.map((u) => u.toLowerCase()));
    expect(args[1]).toEqual(amounts);
  });

  it('encodeDepositForERC20 编码 token/amount/user', () => {
    const { functionName, args } = decodeCall(encodeDepositForERC20(TOKEN, 100n, USER_A));
    expect(functionName).toBe('depositForERC20');
    expect(args[0].toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(args[1]).toBe(100n);
    expect(args[2].toLowerCase()).toBe(USER_A.toLowerCase());
  });

  it('encodeDepositForERC20Batch 编码 token/users/amounts', () => {
    const users = [USER_A, USER_B];
    const amounts = [10n, 20n];
    const { functionName, args } = decodeCall(encodeDepositForERC20Batch(TOKEN, users, amounts));
    expect(functionName).toBe('depositForERC20Batch');
    expect(args[0].toLowerCase()).toBe(TOKEN.toLowerCase());
    expect((args[1] as Address[]).map((a) => a.toLowerCase())).toEqual(users.map((u) => u.toLowerCase()));
    expect(args[2]).toEqual(amounts);
  });
});

describe('buildDepositForUserOp（单账户 native 充值，REQ-1）', () => {
  it('callData = execute(escrow, amount, depositFor(user))，value 等于充值额', () => {
    const amount = 123456n;
    const op = buildDepositForUserOp({
      sender: SENDER,
      nonce: 1n,
      escrow: ESCROW,
      amount,
      user: USER_A,
    });
    expect(op.sender).toBe(SENDER);
    expect(op.nonce).toBe(1n);
    // 与 encodeExecute 单调用一致（target=escrow, value=amount, data=depositFor(user)）
    expect(op.callData).toBe(encodeExecute(ESCROW, amount, encodeDepositFor(USER_A)));
    expect(op.signature).toBe('0x');
  });

  it('支持 factory/gas 透传（counterfactual 部署）', () => {
    const op = buildDepositForUserOp({
      sender: SENDER,
      nonce: 0n,
      escrow: ESCROW,
      amount: 1n,
      user: USER_A,
      factory: '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419' as Address,
      factoryData: '0x1234' as Hex,
      gas: { callGasLimit: 50000n },
    });
    expect(op.factory).toBe('0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419');
    expect(op.factoryData).toBe('0x1234');
    expect(op.callGasLimit).toBe(50000n);
  });
});

describe('buildDepositForBatchUserOp（多账户 native 批量充值，REQ-5）', () => {
  it('callData = execute(escrow, Σamounts, depositForBatch(users, amounts))', () => {
    const users = [USER_A, USER_B];
    const amounts = [100n, 200n];
    const op = buildDepositForBatchUserOp({
      sender: SENDER,
      nonce: 2n,
      escrow: ESCROW,
      users,
      amounts,
    });
    // execute 单调用：value = 300（msg.value = 各额之和）
    expect(op.callData).toBe(
      encodeExecute(ESCROW, 300n, encodeDepositForBatch(users, amounts)),
    );
  });

  it('users/amounts 不等长 → 抛错（防链上 revert）', () => {
    expect(() =>
      buildDepositForBatchUserOp({
        sender: SENDER,
        nonce: 0n,
        escrow: ESCROW,
        users: [USER_A],
        amounts: [1n, 2n],
      }),
    ).toThrow(/length mismatch/);
  });
});

describe('buildDepositForERC20UserOp / Batch（ERC20 充值）', () => {
  it('单账户：execute(escrow, 0, depositForERC20(token, amount, user))', () => {
    const op = buildDepositForERC20UserOp({
      sender: SENDER,
      nonce: 3n,
      escrow: ESCROW,
      token: TOKEN,
      amount: 50n,
      user: USER_A,
    });
    expect(op.callData).toBe(
      encodeExecute(ESCROW, 0n, encodeDepositForERC20(TOKEN, 50n, USER_A)),
    );
  });

  it('批量：execute(escrow, 0, depositForERC20Batch(token, users, amounts))', () => {
    const users = [USER_A, USER_B];
    const amounts = [5n, 6n];
    const op = buildDepositForERC20BatchUserOp({
      sender: SENDER,
      nonce: 4n,
      escrow: ESCROW,
      token: TOKEN,
      users,
      amounts,
    });
    expect(op.callData).toBe(
      encodeExecute(ESCROW, 0n, encodeDepositForERC20Batch(TOKEN, users, amounts)),
    );
  });

  it('批量 users/amounts 不等长 → 抛错', () => {
    expect(() =>
      buildDepositForERC20BatchUserOp({
        sender: SENDER,
        nonce: 0n,
        escrow: ESCROW,
        token: TOKEN,
        users: [USER_A],
        amounts: [1n, 2n],
      }),
    ).toThrow(/length mismatch/);
  });
});

describe('与 encodeExecuteBatch 组合（多 execution 场景）', () => {
  it('encodeExecuteBatch 可编排「native + ERC20」两笔充值于一个 UserOp', () => {
    const callData = encodeExecuteBatch([
      { target: ESCROW, value: 100n, data: encodeDepositFor(USER_A) },
      { target: ESCROW, value: 0n, data: encodeDepositForERC20(TOKEN, 50n, USER_B) },
    ]);
    // BATCH execMode（高 2 字节 0x0100，MSB 布局）
    expect(callData).toContain('0100000000000000000000000000000000000000000000000000000000000000');
    // 内含 depositFor selector（运行时计算，避免硬编码错误）
    const depositForSelector = encodeFunctionData({
      abi: InfraXEscrowAbi,
      functionName: 'depositFor',
      args: [USER_A],
    }).slice(0, 10);
    expect(callData.toLowerCase()).toContain(depositForSelector.slice(2));
  });
});
