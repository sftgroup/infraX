// InfraX 自建 VerifyingPaymaster signer 服务（P-3，OxaChain 19505）
// Pimlico 协议（直连 JSON-RPC 形态，aa-relay /v1/paymaster 直接转发）：
//   pimlico_getPaymasterStubData → { paymaster, data:'0x', verificationGasLimit, preVerificationGas }
//   pimlico_getPaymasterData     → { paymaster, data: abi.encode(validUntil, validAfter) + EIP-191 sig }
// 签名精确复刻 @account-abstraction/contracts@0.7.0 samples/VerifyingPaymaster.sol：
//   getHash = keccak256(abi.encode(sender, nonce, keccak256(initCode), keccak256(callData),
//     accountGasLimits, uint256(paymasterAndData[20:52]), preVerificationGas, gasFees,
//     chainid, address(this), validUntil, validAfter))
//   signature = ECDSA(keccak256("\x19Ethereum Signed Message:\n32" + getHash))
import express from 'express';
import {
  keccak256, encodeAbiParameters, concat, toHex, hexToBigInt,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = 19505;
const ENTRYPOINT_V07 = (process.env.PAYMASTER_ENTRYPOINT || '0x97e4cddcffeaf4580bc6315fee512f2b2d82798a') as Address;
const PAYMASTER_ADDRESS = (process.env.PAYMASTER_ADDRESS || '') as Address;
const SIGNER_PK = process.env.PAYMASTER_SIGNER_PK || '';
const PORT = Number(process.env.PAYMASTER_PORT || 9134);
const VALID_WINDOW_SEC = Number(process.env.PAYMASTER_VALID_WINDOW_SEC || 3600); // validUntil 窗口
const CLOCK_SKEW_SEC = Number(process.env.PAYMASTER_CLOCK_SKEW_SEC || 60);       // validAfter 容忍

if (!SIGNER_PK || !PAYMASTER_ADDRESS) {
  console.error('缺少 PAYMASTER_SIGNER_PK / PAYMASTER_ADDRESS env');
  process.exit(1);
}
const signer = privateKeyToAccount(SIGNER_PK as Hex);
console.log(`paymaster signer ready: paymaster=${PAYMASTER_ADDRESS} signer=${signer.address} entryPoint=${ENTRYPOINT_V07} port=${PORT}`);

// ── 字段工具 ──────────────────────────────────────────────
const toBI = (v: unknown): bigint =>
  typeof v === 'bigint' ? v : v === undefined || v === null ? 0n : BigInt(String(v));
const toHex16 = (v: unknown): Hex => toHex(toBI(v), { size: 16 }); // 128-bit（verification/postop gas）

/** SDK 展开字段 → v0.7 packed 关键字段（仅 getHash 所需） */
function packForHash(u: Record<string, unknown>) {
  const initCode: Hex = u.factory ? concat([u.factory as Hex, (u.factoryData as Hex) || '0x']) : '0x';
  const accountGasLimits: Hex = toHex(
    (toBI(u.verificationGasLimit) << 128n) | toBI(u.callGasLimit), { size: 32 });
  const gasFees: Hex = toHex(
    (toBI(u.maxPriorityFeePerGas) << 128n) | toBI(u.maxFeePerGas), { size: 32 });
  // paymasterAndData = paymaster(20B) + verificationGas(16B) + postOpGas(16B) + data
  const paymasterAndData: Hex = u.paymaster
    ? concat([
        u.paymaster as Hex,
        toHex16(u.paymasterVerificationGasLimit),
        toHex16(u.paymasterPostOpGasLimit),
        (u.paymasterData as Hex) || '0x',
      ])
    : '0x';
  return { sender: u.sender as Address, nonce: toBI(u.nonce), initCode, callData: u.callData as Hex,
    accountGasLimits, preVerificationGas: toBI(u.preVerificationGas), gasFees, paymasterAndData };
}

/** VerifyingPaymaster.getHash 复刻（paymasterAndData[20:52] = verification<<128 | postOp 合并 uint256） */
function getHash(u: Record<string, unknown>, validUntil: number, validAfter: number): Hex {
  const p = packForHash(u);
  const paymasterGasWord = p.paymasterAndData === '0x'
    ? 0n
    : hexToBigInt('0x' + p.paymasterAndData.slice(2 + 40, 2 + 104) as Hex);
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' },
        { type: 'uint256' }, { type: 'address' }, { type: 'uint48' }, { type: 'uint48' },
      ],
      [
        p.sender, p.nonce, keccak256(p.initCode), keccak256(p.callData),
        p.accountGasLimits, paymasterGasWord, p.preVerificationGas, p.gasFees,
        BigInt(CHAIN_ID), PAYMASTER_ADDRESS, validUntil, validAfter,
      ],
    ),
  );
}

/** abi.encode(uint48 validUntil, uint48 validAfter) + EIP-191 signature（65B） */
async function buildPaymasterData(u: Record<string, unknown>): Promise<{ data: Hex; validUntil: number; validAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - CLOCK_SKEW_SEC;
  const validUntil = now + VALID_WINDOW_SEC;
  const hash = getHash(u, validUntil, validAfter);
  const sig = await signer.signMessage({ message: { raw: hash } }); // viem 自动加 EIP-191 前缀
  const data = concat([
    encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, validAfter]),
    sig,
  ]);
  return { data, validUntil, validAfter };
}

// ── HTTP 服务 ─────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', paymaster: PAYMASTER_ADDRESS, signer: signer.address, chainId: CHAIN_ID });
});

app.post('/', async (req, res) => {
  try {
    const { method, params } = req.body ?? {};
    if (method === 'pimlico_getPaymasterStubData') {
      const [userOp] = params ?? [];
      const now = Math.floor(Date.now() / 1000);
      const validAfter = now - CLOCK_SKEW_SEC;
      const validUntil = now + VALID_WINDOW_SEC;
      // stub：预生成带空签名的 data（保证估算时 paymasterData 长度 = 正式形态）
      const sig = await signer.signMessage({ message: { raw: getHash(userOp, validUntil, validAfter) } });
      const data = concat([
        encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, validAfter]),
        sig,
      ]);
      return res.json({
        jsonrpc: '2.0',
        result: {
          paymaster: PAYMASTER_ADDRESS,
          data,
          verificationGasLimit: toHex(116_000), // 固定估算值，正式以 eth_estimateUserOperationGas 为准
          preVerificationGas: toHex(50_000),
        },
      });
    }
    if (method === 'pimlico_getPaymasterData') {
      const [userOp] = params ?? [];
      const { data } = await buildPaymasterData(userOp);
      return res.json({
        jsonrpc: '2.0',
        result: { paymaster: PAYMASTER_ADDRESS, data },
      });
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e: any) {
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32000, message: `paymaster error: ${e?.message ?? e}` } });
  }
});

app.listen(PORT, () => console.log(`aa-paymaster signer listening on :${PORT}`));
