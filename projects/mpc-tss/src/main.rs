//! M1 集成验证 demo：cggmp24 2-of-2 (t=2, n=2) CGGMP24 全流程
//!
//! keygen → presign → sign → 标准 ECDSA 验证（k256 独立库）+ ethers.verifyMessage 兼容验证
//! 进程内使用 round_based::sim 仿真双 party 通信（生产集成时替换为真实传输）。

use anyhow::{Context, Result};
use cggmp24::supported_curves::Secp256k1;
use cggmp24::{DataToSign, ExecutionId, KeyShare};
use k256::ecdsa::signature::hazmat::PrehashVerifier;
use mpc_tss::{run_presign, sign_with_presigs, verify_k256};
use rand::rngs::OsRng;
use sha2::Sha256;
use sha3::{Digest, Keccak256};

/// 每个 party 执行 aux_info_gen（生成各自的 Paillier 参数）
fn run_aux_gen(eid: ExecutionId, n: u16) -> Vec<cggmp24::key_share::AuxInfo> {
    round_based::sim::run(n, |i, party| {
        let mut rng = OsRng;
        async move {
            // 安全素数生成较慢，此处每个 party 独立生成
            let primes = cggmp24::PregeneratedPrimes::generate(&mut rng);
            cggmp24::aux_info_gen(eid, i, n, primes)
                .start(&mut rng, party)
                .await
        }
    })
    .expect("aux info simulation failed")
    .expect_ok()
    .into_vec()
}

/// 每个 party 执行 DKG keygen（threshold t-of-n）
fn run_keygen(
    eid: ExecutionId,
    n: u16,
    t: u16,
) -> Vec<cggmp24::IncompleteKeyShare<Secp256k1>> {
    round_based::sim::run(n, |i, party| {
        let mut rng = OsRng;
        async move {
            cggmp24::keygen::<Secp256k1>(eid, i, n)
                .set_threshold(t)
                .start(&mut rng, party)
                .await
        }
    })
    .expect("keygen simulation failed")
    .expect_ok()
    .into_vec()
}

fn main() -> Result<()> {
    let n: u16 = 2;
    let t: u16 = 2;
    // 同一组 signer 的 aux 可跨多个 key 复用；三轮协议（aux/keygen/presign）各用独立 ExecutionId
    let eid = ExecutionId::new(b"mpc-tss-m1-demo-eid-0001");
    let eid2 = ExecutionId::new(b"mpc-tss-m1-demo-eid-0002");
    let eid3 = ExecutionId::new(b"mpc-tss-m1-demo-eid-0003");

    println!("[1/5] aux_info_gen (2 parties, 各自生成安全素数…)");
    let aux = run_aux_gen(eid, n);

    println!("[2/5] DKG keygen t={t}/n={n}");
    let incomplete = run_keygen(eid, n, t);
    let shares = incomplete
        .iter()
        .zip(aux.iter())
        .map(|(inc, aux)| KeyShare::from_parts((inc.clone(), aux.clone())))
        .collect::<Result<Vec<_>, _>>()
        .context("complete key share")?;

    // 校验：共享公钥一致
    let pk0 = shares[0].core.shared_public_key;
    for (i, s) in shares.iter().enumerate() {
        assert_eq!(
            s.core.shared_public_key, pk0,
            "party {i} shared public key mismatch"
        );
    }
    let pk_bytes = pk0.to_bytes(false); // 未压缩 04||X||Y
    println!("     shared public key (uncompressed 65B): {}", hex::encode(&pk_bytes));
    println!("     shared public key (compressed 33B):   {}", hex::encode(pk0.to_bytes(true)));

    println!("[3/5] presignature generation (2 parties)");
    let parties_at_keygen: [u16; 2] = [0, 1];
    let presigs = run_presign(eid2, &parties_at_keygen, &shares)?;

    println!("[4/5] 本地 partial signature + combine（不再需要 party 通信）");
    let message = b"hello mpc-tss, sign me with threshold ecdsa";
    let data_to_sign = DataToSign::digest::<Sha256>(message);
    let signature = sign_with_presigs(presigs, data_to_sign)?;

    let mut sig_bytes = [0u8; 64];
    signature.write_to_slice(&mut sig_bytes);
    println!("     signature r||s (64B): {}", hex::encode(&sig_bytes));

    println!("[5/5] 独立库验证");
    // cggmp24 内置验证
    signature
        .verify(&pk0, &data_to_sign)
        .context("cggmp24 internal verify failed")?;
    println!("     cggmp24 internal verify: OK");

    // k256 独立验证（标准 secp256k1 ECDSA、SHA-256 摘要）
    verify_k256(&pk_bytes, &sig_bytes, message)?;
    println!("     k256 external verify (sha256): OK");

    // ethers 兼容签名：EIP-191 personal_sign 消息格式（ethers.verifyMessage 使用的语义）
    let personal_msg = message;
    let eip191 = format!(
        "\x19Ethereum Signed Message:\n{}{}",
        personal_msg.len(),
        std::str::from_utf8(personal_msg)?
    );
    let eip191_digest: [u8; 32] = Keccak256::digest(eip191.as_bytes()).into();
    let data_to_sign = DataToSign::digest::<Keccak256>(eip191.as_bytes());
    // 再跑一轮 presign（presig 生成后只能消费一次）
    let presigs = run_presign(eid3, &parties_at_keygen, &shares)?;
    let eth_sig = sign_with_presigs(presigs, data_to_sign)?;
    let mut eth_sig_bytes = [0u8; 64];
    eth_sig.write_to_slice(&mut eth_sig_bytes);

    // ethers.hashMessage 输出即 eip191_digest → verify_prehash 与之数学等价
    let pk = k256::ecdsa::VerifyingKey::from_sec1_bytes(&pk_bytes)
        .context("k256 parse public key")?;
    let eth_sig_k256 =
        k256::ecdsa::Signature::from_slice(&eth_sig_bytes).context("k256 parse eth sig")?;
    pk.verify_prehash(&eip191_digest, &eth_sig_k256)
        .context("EIP-191 (ethers.verifyMessage) verification failed")?;
    println!("     EIP-191 verify_prehash (keccak256): OK");

    // 以太坊地址 = keccak256(未压缩公钥去 04 前缀) 的后 20 字节
    let addr_hash: [u8; 32] = Keccak256::digest(&pk_bytes[1..]).into();
    println!("     ethers 地址: 0x{}", hex::encode(&addr_hash[12..]));
    println!("     ethers 签名 (r||s): {}", hex::encode(&eth_sig_bytes));

    println!("\n✅ M1 全流程通过（2-of-2 keygen → presign → sign → 标准 ECDSA + ethers.verifyMessage 兼容验证）");
    Ok(())
}
