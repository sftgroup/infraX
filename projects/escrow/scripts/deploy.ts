import { ethers, upgrades } from "hardhat";

/**
 * 部署 InfraXEscrow（UUPS 代理，OE-3 链上部署前置脚本）
 *
 * 用法：
 *   # 本地测试网试跑
 *   npx hardhat run scripts/deploy.ts
 *   # oxachain 主网（需先设置 DEPLOYER_PRIVATE_KEY + 可选 OXA_RPC_URL）
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network oxachain
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // 部署 proxy + implementation（owner 先设为 deployer，随后移交平台多签）
  const Escrow = await ethers.getContractFactory("InfraXEscrow");
  const escrow = await upgrades.deployProxy(Escrow, [deployer.address], { kind: "uups" });
  await escrow.waitForDeployment();

  const proxyAddr = await escrow.getAddress();
  const implAddr = await upgrades.erc1967.getImplementationAddress(proxyAddr);
  console.log("InfraXEscrow proxy:", proxyAddr);
  console.log("Implementation:", implAddr);
  console.log("Owner:", await escrow.owner());
  console.log("Default per-tx limit:", await escrow.defaultPerTxLimit());
  console.log("Default per-day limit:", await escrow.defaultPerDayLimit());

  // OE-3 提醒：上线前将 owner 移交平台多签
  // await escrow.transferOwnership("0x<多签地址>");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
