//! M2 存量迁移 demo：Key Import（trusted_dealer / spof）
//!
//! 将 E-2 现有钱包的完整私钥导入为 cggmp24 2-of-2 分片，地址保持不变：
//!  1. 输入存量钱包完整私钥（ethers 私钥 hex）
//!  2. trusted_dealer 按共享私钥生成 t=2/n=2 分片（不再需要 DKG，密钥不发生变化）
//!  3. 校验共享公钥 == 原私钥公钥（地址不变）
//!  4. presign + sign → 标准 ECDSA + ethers.verifyMessage 兼容验证

use anyhow::{Context, Result};
use cggmp24::supported_curves::Secp256k1;
use cggmp24::{DataToSign, ExecutionId};
use generic_ec::{NonZero, Point, SecretScalar};
use mpc_tss::{run_presign, sign_with_presigs};
use rand::rngs::OsRng;
use sha3::{Digest, Keccak256};

fn main() -> Result<()> {
    // ── E-2 存量钱包私钥（0x + 64 hex）──
    let sk_hex = "f8356da3003a51c0a2e4dca6ecf7154c8dd44f62d82257a6340f71bd9b34da75";
    let expected_address = "0x96fa8385802cC208119ED3D70Ef48d6c92850F78";
    let sk_bytes = hex::decode(sk_hex).context("decode private key")?;

    let sk = SecretScalar::<Secp256k1>::from_be_bytes(&sk_bytes).context("invalid private key")?;
    let sk_nz = NonZero::from_secret_scalar(sk).context("zero private key")?;

    // 原私钥对应的公钥（导入后地址必须不变）
    let orig_pk = Point::<Secp256k1>::generator() * &sk_nz;

    // ── trusted_dealer 生成 2-of-2 分片，共享私钥 == sk ──
    let n: u16 = 2;
    let t: u16 = 2;
    let mut rng = OsRng;
    println!("[1/4] trusted_dealer: 导入存量私钥 → t={t}/n={n} 分片");
    let shares = cggmp24::trusted_dealer::builder::<
        Secp256k1,
        cggmp24::security_level::SecurityLevel128,
    >(n)
    .set_threshold(Some(t))
    .set_shared_secret_key(sk_nz)
    .generate_shares(&mut rng)
    .context("trusted dealer generate shares")?;

    // 共享公钥 == 原私钥公钥（地址不变的关键）
    let shared_pk = shares[0].core.shared_public_key;
    assert_eq!(
        shared_pk, orig_pk,
        "共享公钥与原私钥公钥不一致——地址会改变"
    );
    println!("     shared public key == original public key: OK");
    let pk_bytes = shared_pk.to_bytes(false);
    println!("     shared public key (uncompressed 65B): {}", hex::encode(&pk_bytes));

    // 以太坊地址对比
    let addr_hash: [u8; 32] = Keccak256::digest(&pk_bytes[1..]).into();
    let addr = format!("0x{}", hex::encode(&addr_hash[12..]));
    println!("     分片共享地址: {addr}");
    println!("     原钱包地址:   {expected_address}");
    assert_eq!(addr, expected_address.to_lowercase(), "地址变更");
    println!("     ✅ 地址不变");

    // ── 用分片签名（与 M1 相同的 presign + combine 流程）──
    let eid = ExecutionId::new(b"mpc-tss-m2-import-presign-0001");
    let parties_at_keygen: [u16; 2] = [0, 1];
    let presigs = run_presign(eid, &parties_at_keygen, &shares)?;

    let message = b"m2 key import: threshold sign with migrated wallet";
    let eip191 = format!(
        "\x19Ethereum Signed Message:\n{}{}",
        message.len(),
        std::str::from_utf8(message)?
    );
    let data_to_sign = DataToSign::digest::<Keccak256>(eip191.as_bytes());
    let signature = sign_with_presigs(presigs, data_to_sign)?;
    let mut sig_bytes = [0u8; 64];
    signature.write_to_slice(&mut sig_bytes);
    println!("     signature r||s (64B): {}", hex::encode(&sig_bytes));

    // cggmp24 内置验证 + k256 EIP-191 verify_prehash（与 ethers.verifyMessage 等价）
    signature
        .verify(&shared_pk, &data_to_sign)
        .context("cggmp24 internal verify failed")?;
    let pk = k256::ecdsa::VerifyingKey::from_sec1_bytes(&pk_bytes).context("k256 parse pk")?;
    let eip191_digest: [u8; 32] = Keccak256::digest(eip191.as_bytes()).into();
    let sig = k256::ecdsa::Signature::from_slice(&sig_bytes).context("k256 parse sig")?;
    use k256::ecdsa::signature::hazmat::PrehashVerifier;
    pk.verify_prehash(&eip191_digest, &sig)
        .context("EIP-191 (ethers.verifyMessage) verification failed")?;
    println!("     cggmp24 internal verify: OK");
    println!("     EIP-191 verify_prehash (ethers.verifyMessage 等价): OK");

    println!("\n✅ M2 存量迁移验证通过（Key Import：私钥 → 2-of-2 分片 → 地址不变 → 阈值签名可验证）");
    Ok(())
}
