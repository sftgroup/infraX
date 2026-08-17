//! M4 2-of-3 阈值演进 demo：任取 3 片中 2 片即可完成签名（AX-13）
//!
//!  1. trusted_dealer 按共享私钥生成 t=2/n=3 分片（片1/片2/片3，地址不变）
//!  2. 校验共享公钥 == 原私钥公钥（地址不变）
//!  3. 对全部 3 个 2 片子集 {0,1} {0,2} {1,2} 分别完成 presign + sign
//!  4. 每份签名都通过 cggmp24 内部校验 + k256 EIP-191 verify_prehash（ethers 等价）
//!  5. 兼容性说明：{0,1} 子集即原 2-of-2 路径，旧客户端（只持片1+片2）平滑兼容

use anyhow::{Context, Result};
use cggmp24::supported_curves::Secp256k1;
use cggmp24::{DataToSign, ExecutionId};
use generic_ec::{NonZero, Point, SecretScalar};
use mpc_tss::{run_presign, sign_with_presigs, KeyShare};
use rand::rngs::OsRng;
use sha3::{Digest, Keccak256};

fn main() -> Result<()> {
    // ── 存量钱包私钥（同 M2，地址 0x96fa...）──
    let sk_hex = "f8356da3003a51c0a2e4dca6ecf7154c8dd44f62d82257a6340f71bd9b34da75";
    let expected_address = "0x96fa8385802cC208119ED3D70Ef48d6c92850F78";
    let sk_bytes = hex::decode(sk_hex).context("decode private key")?;
    let sk = SecretScalar::<Secp256k1>::from_be_bytes(&sk_bytes).context("invalid private key")?;
    let sk_nz = NonZero::from_secret_scalar(sk).context("zero private key")?;
    let orig_pk = Point::<Secp256k1>::generator() * &sk_nz;

    // ── trusted_dealer 生成 2-of-3 分片，共享私钥 == sk ──
    let n: u16 = 3;
    let t: u16 = 2;
    let mut rng = OsRng;
    println!("[1/4] trusted_dealer: 导入存量私钥 → t={t}/n={n} 分片");
    let shares: Vec<KeyShare<Secp256k1>> =
        cggmp24::trusted_dealer::builder::<Secp256k1, cggmp24::security_level::SecurityLevel128>(n)
            .set_threshold(Some(t))
            .set_shared_secret_key(sk_nz)
            .generate_shares(&mut rng)
            .context("trusted dealer generate shares")?;

    // 3 片共享公钥一致，且 == 原私钥公钥（地址不变的关键）
    let shared_pk = shares[0].core.shared_public_key;
    assert_eq!(shared_pk, orig_pk, "共享公钥与原私钥公钥不一致——地址会改变");
    for (idx, s) in shares.iter().enumerate() {
        assert_eq!(
            s.core.shared_public_key, shared_pk,
            "片{idx} 共享公钥不一致"
        );
    }
    println!("     shared public key == original public key (3 片一致): OK");
    let pk_bytes = shared_pk.to_bytes(false);
    let addr_hash: [u8; 32] = Keccak256::digest(&pk_bytes[1..]).into();
    let addr = format!("0x{}", hex::encode(&addr_hash[12..]));
    println!("     分片共享地址: {addr}");
    assert_eq!(addr, expected_address.to_lowercase(), "地址变更");
    println!("     ✅ 地址不变");

    // ── 对全部 2 片子集分别签名 ──
    let message = b"m4 2-of-3: threshold sign from any 2 of 3 shares";
    let eip191 = format!(
        "\x19Ethereum Signed Message:\n{}{}",
        message.len(),
        std::str::from_utf8(message)?
    );
    let data_to_sign = DataToSign::digest::<Keccak256>(eip191.as_bytes());
    let eip191_digest: [u8; 32] = Keccak256::digest(eip191.as_bytes()).into();

    let subsets: [[u16; 2]; 3] = [[0, 1], [0, 2], [1, 2]];
    for (k, subset) in subsets.iter().enumerate() {
        println!(
            "[{}/4] 子集 {subset:?}: presign + sign（参与方=keygen 索引 {} 与 {}）",
            k + 2,
            subset[0],
            subset[1]
        );
        // 子集内本地索引恒为 {0,1}；parties_indexes_at_keygen = 该子集的 keygen 索引
        let subset_shares: Vec<KeyShare<Secp256k1>> = subset
            .iter()
            .map(|&j| shares[j as usize].clone())
            .collect();
        let eid_str = format!("mpc-tss-m4-2of3-subset-{subset:?}");
        let eid = ExecutionId::new(eid_str.as_bytes());
        let presigs = run_presign(eid, subset, &subset_shares)?;
        let signature = sign_with_presigs(presigs, data_to_sign)?;

        let mut sig_bytes = [0u8; 64];
        signature.write_to_slice(&mut sig_bytes);
        println!("     signature r||s (64B): {}", hex::encode(&sig_bytes));

        // cggmp24 内部校验 + k256 EIP-191 verify_prehash（与 ethers.verifyMessage 等价）
        signature
            .verify(&shared_pk, &data_to_sign)
            .context("cggmp24 internal verify failed")?;
        let pk = k256::ecdsa::VerifyingKey::from_sec1_bytes(&pk_bytes).context("k256 parse pk")?;
        let sig = k256::ecdsa::Signature::from_slice(&sig_bytes).context("k256 parse sig")?;
        use k256::ecdsa::signature::hazmat::PrehashVerifier;
        pk.verify_prehash(&eip191_digest, &sig)
            .context("EIP-191 (ethers.verifyMessage) verification failed")?;
        println!("     cggmp24 internal verify: OK");
        println!("     EIP-191 verify_prehash (ethers.verifyMessage 等价): OK");
    }

    println!(
        "\n✅ M4 2-of-3 验证通过（3 片中任取 2 片 → 阈值签名均有效；片1+片2 即原 2-of-2 路径）"
    );
    Ok(())
}
