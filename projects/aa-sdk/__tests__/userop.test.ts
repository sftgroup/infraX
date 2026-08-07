// UserOp 构建 / 编码 / 哈希 / 签名 单测（对齐 AA_SDK_TECH_DESIGN §10.1 + §5）
import { describe, expect, it } from 'vitest';
import { concatHex, decodeFunctionData, recoverAddress, toHex, type Address, type Hex } from 'viem';
import { PrivateKeySigner } from '../src/signers/private-key.js';
import { buildUserOp, encodeExecute, getUserOpHash, signUserOp } from '../src/userop.js';

const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SENDER = '0x0000000000000000000000000000000000000001' as Address;
const TARGET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const FACTORY = '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419' as Address;
const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
const CHAIN_ID = 84532;

/** Kernel v3 execute ABI（测试内联，与 userop.ts 保持一致） */
const ExecuteAbi = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      { name: 'execMode', type: 'bytes32' },
      { name: 'executionCalldata', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

describe('encodeExecute (Kernel v3, ERC-7579 DEFAULT mode)', () => {
  it('encodes execute(bytes32,bytes) with all-zero execMode', () => {
    const data = encodeExecute(TARGET, 0n, '0x');
    const decoded = decodeFunctionData({ abi: ExecuteAbi, data });
    expect(decoded.functionName).toBe('execute');
    const [execMode, executionCalldata] = decoded.args;
    expect(execMode).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    );
    // executionCalldata = target(20B) + value(32B) + data（viem decode 输出小写，统一 lowercase 比较）
    expect(executionCalldata.toLowerCase()).toBe(
      concatHex([TARGET, toHex(0n, { size: 32 }), '0x']).toLowerCase(),
    );
  });

  it('packs value into 32-byte word', () => {
    const value = 123456789n;
    const data = encodeExecute(TARGET, value, '0x');
    const decoded = decodeFunctionData({ abi: ExecuteAbi, data });
    const executionCalldata = decoded.args[1] as Hex;
    expect(executionCalldata.toLowerCase()).toBe(
      concatHex([TARGET, toHex(value, { size: 32 }), '0x']).toLowerCase(),
    );
  });

  it('appends arbitrary calldata after target+value', () => {
    const callData = '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000';
    const data = encodeExecute(TARGET, 1n, callData as Hex);
    const decoded = decodeFunctionData({ abi: ExecuteAbi, data });
    expect((decoded.args[1] as string).toLowerCase()).toContain(callData.slice(2).toLowerCase());
  });
});

describe('buildUserOp', () => {
  it('assembles v0.7 fields and executes callData', () => {
    const op = buildUserOp({ sender: SENDER, nonce: 42n, call: { target: TARGET, data: '0x' } });
    expect(op.sender).toBe(SENDER);
    expect(op.nonce).toBe(42n);
    expect(op.callData).toBe(encodeExecute(TARGET, 0n, '0x'));
    expect(op.factory).toBeUndefined();
    expect(op.factoryData).toBeUndefined();
    expect(op.signature).toBe('0x');
  });

  it('carries factory/factoryData for counterfactual deployment', () => {
    const op = buildUserOp({
      sender: SENDER,
      nonce: 0n,
      call: { target: TARGET, data: '0x' },
      factory: FACTORY,
      factoryData: '0x1234' as Hex,
    });
    expect(op.factory).toBe(FACTORY);
    expect(op.factoryData).toBe('0x1234');
  });

  it('allows explicit gas override', () => {
    const op = buildUserOp({
      sender: SENDER,
      nonce: 0n,
      call: { target: TARGET, data: '0x' },
      gas: { callGasLimit: 50000n, maxFeePerGas: 10n },
    });
    expect(op.callGasLimit).toBe(50000n);
    expect(op.maxFeePerGas).toBe(10n);
    expect(op.verificationGasLimit).toBe(0n); // 未提供 → 缺省 0（M3 估算）
  });
});

describe('getUserOpHash (v0.7 EIP-712)', () => {
  const op = buildUserOp({ sender: SENDER, nonce: 0n, call: { target: TARGET, data: '0x' } });

  it('is deterministic', () => {
    expect(getUserOpHash(op, ENTRYPOINT, CHAIN_ID)).toBe(
      getUserOpHash(op, ENTRYPOINT, CHAIN_ID),
    );
  });

  it('differs across chains (replay protection)', () => {
    const hashBase = getUserOpHash(op, ENTRYPOINT, CHAIN_ID);
    const hashOther = getUserOpHash(op, ENTRYPOINT, 8453);
    expect(hashOther).not.toBe(hashBase);
  });

  it('differs when callData changes', () => {
    const op2 = buildUserOp({ sender: SENDER, nonce: 0n, call: { target: TARGET, data: '0xdeadbeef' as Hex } });
    expect(getUserOpHash(op2, ENTRYPOINT, CHAIN_ID)).not.toBe(
      getUserOpHash(op, ENTRYPOINT, CHAIN_ID),
    );
  });
});

describe('signUserOp (E2E: build → hash → sign → recover)', () => {
  it('signature recovers to the owner address', async () => {
    const signer = new PrivateKeySigner(TEST_PRIVATE_KEY);
    const op = buildUserOp({
      sender: SENDER,
      nonce: 7n,
      call: { target: TARGET, value: 1n, data: '0x' },
      factory: FACTORY,
      factoryData: '0x1234' as Hex,
    });
    const signed = await signUserOp(op, ENTRYPOINT, CHAIN_ID, signer);
    expect(signed.signature).not.toBe('0x');

    const hash = getUserOpHash(op, ENTRYPOINT, CHAIN_ID);
    const recovered = await recoverAddress({ hash, signature: signed.signature });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });
});
