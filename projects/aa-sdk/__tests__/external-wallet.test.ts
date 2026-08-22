// 外部钱包签名器单测（P0.13，AA_SDK_TECH_DESIGN §6.1）
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { createSigner } from '../src/signers/types.js';
import { ExternalWalletSigner, type EIP1193Provider } from '../src/signers/external-wallet.js';

const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address;
const USER_OP_HASH = `0x${'11'.repeat(32)}` as Hex;
const MESSAGE = `0x${'22'.repeat(32)}` as Hex;
const SIG = `0x${'33'.repeat(65)}` as Hex;

/** mock EIP-1193 provider：记录 request 调用，签名方法返回固定 SIG */
function makeProvider(
  accounts: string[] = [ACCOUNT],
): { provider: EIP1193Provider; calls: { method: string; params?: unknown[] }[] } {
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider: EIP1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_sign' || method === 'personal_sign' || method === 'eth_signTypedData_v4') return SIG;
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { provider, calls };
}

describe('ExternalWalletSigner', () => {
  it('exposes type external-wallet and resolved address', () => {
    const { provider } = makeProvider();
    const signer = new ExternalWalletSigner(provider, ACCOUNT);
    expect(signer.type).toBe('external-wallet');
    expect(signer.address).toBe(ACCOUNT);
  });

  it('connect() resolves account from eth_accounts[0]', async () => {
    const { provider } = makeProvider();
    const signer = new ExternalWalletSigner(provider);
    expect(await signer.connect()).toBe(ACCOUNT);
    expect(signer.address).toBe(ACCOUNT);
  });

  it('connect() throws when no account connected', async () => {
    const { provider } = makeProvider([]);
    const signer = new ExternalWalletSigner(provider);
    await expect(signer.connect()).rejects.toThrow(/not connected/);
  });

  it('signUserOp uses eth_sign with raw digest', async () => {
    const { provider, calls } = makeProvider();
    const signer = new ExternalWalletSigner(provider, ACCOUNT);
    const sig = await signer.signUserOp(USER_OP_HASH);
    expect(sig).toBe(SIG);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'eth_sign', params: [ACCOUNT, USER_OP_HASH] });
  });

  it('signMessage uses personal_sign', async () => {
    const { provider, calls } = makeProvider();
    const signer = new ExternalWalletSigner(provider, ACCOUNT);
    const sig = await signer.signMessage(MESSAGE);
    expect(sig).toBe(SIG);
    expect(calls[0]).toEqual({ method: 'personal_sign', params: [MESSAGE, ACCOUNT] });
  });

  it('signTypedData uses eth_signTypedData_v4 with JSON stringified data', async () => {
    const { provider, calls } = makeProvider();
    const signer = new ExternalWalletSigner(provider, ACCOUNT);
    const typedData = {
      // PocketX 保留（EPF-9 T-4）：EIP-712 domain name，若 SDK 已有外部使用者则不可改动
      domain: { name: 'PocketX', chainId: 84532 },
      types: { UserOperation: [{ name: 'sender', type: 'address' }] },
      primaryType: 'UserOperation',
      message: { sender: ACCOUNT },
    };
    const sig = await signer.signTypedData(typedData);
    expect(sig).toBe(SIG);
    expect(calls[0]).toEqual({ method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(typedData)] });
  });
});

describe('createSigner 工厂（P0.13 external-wallet 路由）', () => {
  it('returns ExternalWalletSigner when only externalWallet provided', async () => {
    const { provider } = makeProvider();
    const signer = await createSigner({ externalWallet: { provider, address: ACCOUNT } });
    expect(signer.type).toBe('external-wallet');
    expect(signer.address).toBe(ACCOUNT);
  });

  it('auto-connects when address omitted', async () => {
    const { provider } = makeProvider();
    const signer = await createSigner({ externalWallet: { provider } });
    expect(signer.type).toBe('external-wallet');
    expect(signer.address).toBe(ACCOUNT);
  });

  it('prefers privateKey over externalWallet', async () => {
    const { provider, calls } = makeProvider();
    const signer = await createSigner({ privateKey: `0x${'aa'.repeat(32)}` as Hex, externalWallet: { provider, address: ACCOUNT } });
    expect(signer.type).toBe('private-key');
    expect(calls).toHaveLength(0);
  });

  it('throws when no signer option provided', async () => {
    await expect(createSigner({})).rejects.toThrow(/no signer option/);
  });
});
