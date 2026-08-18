import { ethers, upgrades } from "hardhat";

/**
 * 升级 InfraXEscrow（UUPS）：pause → upgradeTo(新实现) → unpause
 *
 * 依据 REQ-1（depositFor 新增）与合约安全约定（升级必须先暂停计费窗口）。
 * 用法：
 *   DEPLOYER_PRIVATE_KEY=0x<owner 私钥> npx hardhat run scripts/upgrade.ts --network oxachain
 * 可选：ESCROW_PROXY_ADDRESS 覆盖代理地址（默认生产 0x8Bf8Ffee…）
 */
async function main() {
  const [owner] = await ethers.getSigners();
  console.log("Signer(owner):", owner.address);

  const proxy = process.env.ESCROW_PROXY_ADDRESS || "0x8Bf8Ffee86F1D4a160f0953Eb13BEDcBF99eaF9E";
  const escrow = await ethers.getContractAt("InfraXEscrow", proxy);

  const chainOwner = await escrow.owner();
  console.log("Chain owner:", chainOwner, "| Paused:", await escrow.paused());
  if (chainOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`signer 非 owner（${chainOwner}），终止升级`);
  }

  // 1) 暂停计费窗口（升级要求 paused）
  if (!(await escrow.paused())) {
    const t = await escrow.pause();
    await t.wait();
    console.log("paused ✓");
  }

  // 2) UUPS 升级到当前本地源码实现
  const Escrow = await ethers.getContractFactory("InfraXEscrow");
  const tx = await upgrades.upgradeProxy(proxy, Escrow, { kind: "uups" });
  await tx.waitForDeployment();

  // 3) 校验新函数存在
  const impl = await upgrades.erc1967.getImplementationAddress(proxy);
  console.log("New implementation:", impl);
  const iface = new ethers.Interface(["function depositFor(address) external payable"]);
  const hasDepositFor = await ethers.provider.call({ to: proxy, data: iface.encodeFunctionData("depositFor", [owner.address]) }).catch(() => null) !== null;
  console.log("depositFor 可用:", hasDepositFor);

  // 4) 恢复计费
  if (await escrow.paused()) {
    const t = await escrow.unpause();
    await t.wait();
    console.log("unpaused ✓");
  }
  console.log("sanity balanceOf(owner):", (await escrow.balanceOf(owner.address)).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
