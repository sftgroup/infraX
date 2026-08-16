import { ethers } from "hardhat";

/**
 * OE-3/6: 授权 relayer（charge/refund 扣款权，仅 owner 可调）
 *
 * 用法（oxachain 主网）：
 *   DEPLOYER_PRIVATE_KEY=0x<owner 私钥> npx hardhat run scripts/set-relayer.ts --network oxachain
 *
 * 环境变量：
 *   ESCROW_ADDRESS       InfraXEscrow proxy（默认读取 .env 或手动指定）
 *   RELAYER_ADDRESS      待授权 relayer 地址（必填）
 *   RELAYER_ENABLED      true=授权（默认）/ false=撤销
 */
async function main() {
  const escrowAddr = process.env.ESCROW_ADDRESS;
  const relayer = process.env.RELAYER_ADDRESS;
  if (!escrowAddr || !relayer) {
    throw new Error("需要 ESCROW_ADDRESS 与 RELAYER_ADDRESS 环境变量");
  }
  const enabled = (process.env.RELAYER_ENABLED ?? 'true') === 'true';

  const escrow = await ethers.getContractAt("InfraXEscrow", escrowAddr);
  const [owner] = await ethers.getSigners();
  console.log("Owner:", owner.address);
  console.log("Escrow:", escrowAddr);
  console.log("Relayer:", relayer, "enabled:", enabled);

  const before = await escrow.relayerEnabled(relayer);
  console.log("before relayerEnabled:", before);

  const tx = await escrow.setRelayer(relayer, enabled);
  const receipt = await tx.wait();
  console.log("tx:", receipt?.hash);

  const after = await escrow.relayerEnabled(relayer);
  console.log("after relayerEnabled:", after);
  if (after !== enabled) throw new Error("授权结果未生效");
  console.log("OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
