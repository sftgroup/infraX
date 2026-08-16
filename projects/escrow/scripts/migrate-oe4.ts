// OE-4 资金迁移 v2：ethers 本地填充 gas（规避 RPC 不支持 eth_fillTransaction）
// EOA 0x5682e2… → Escrow deposit()，金额 = 10 OXA（不足则全迁留 gas）
import { ethers } from "hardhat";

const ESCROW = "0x8Bf8Ffee86F1D4a160f0953Eb13BEDcBF99eaF9E";
const EOA = "0x5682e2d55770e46ad24b92e51d6d0a3b629fa0b3";
const DEPOSIT_DATA = "0xd0e30db0"; // deposit()

async function main() {
  const key = process.env.EOA_KEY;
  if (!key) throw new Error("EOA_KEY missing");

  // ethers v6: 本地 Wallet（不经过 RPC eth_fillTransaction）
  const provider = ethers.provider;
  const wallet = new ethers.Wallet(key, provider);
  if (wallet.address.toLowerCase() !== EOA.toLowerCase()) {
    throw new Error(`私钥不匹配平台 EOA! signer=${wallet.address} expected=${EOA}`);
  }
  console.log("signer 匹配 EOA:", wallet.address);

  const bal = await provider.getBalance(wallet.address);
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice;
  const maxPrio = fee.maxPriorityFeePerGas ?? 0n;
  const gasPrice = fee.gasPrice ?? maxFee;
  const gasEstimate = await wallet.estimateGas({ to: ESCROW, value: ethers.parseEther("10"), data: DEPOSIT_DATA });
  // 显式 gasLimit（估算 ×1.1 buffer），成本精确可控：send + gasLimit*maxFee == bal
  const gasLimit = (gasEstimate * 110n) / 100n + 1n;
  const gasCost = gasLimit * maxFee;
  console.log("EOA balance:", ethers.formatEther(bal), "OXA");
  console.log("gas estimate:", gasEstimate.toString(), "×1.1 =", gasLimit.toString(), "× maxFee", ethers.formatEther(maxFee), "= cost", ethers.formatEther(gasCost), "OXA");

  const target = ethers.parseEther("10");
  let send = target;
  if (bal < target + gasCost) {
    send = bal - gasCost;
    console.log(`余额不足 10 OXA+gas，全迁金额=${ethers.formatEther(send)} OXA`);
  }
  if (send <= 0n) throw new Error("余额不足以支付 gas");

  console.log("deposit amount:", ethers.formatEther(send), "OXA");
  const tx = await wallet.sendTransaction({
    to: ESCROW, value: send, data: DEPOSIT_DATA,
    gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPrio,
  });
  console.log("tx:", tx.hash);
  await tx.wait();
  const after = await provider.getBalance(wallet.address);
  console.log("EOA balance after:", ethers.formatEther(after), "OXA");
  console.log("done");
}

main().catch((error) => {
  console.error(error?.shortMessage || error);
  process.exitCode = 1;
});
