//! M3 mpc_signer：CGGMP24 party0（持片1）HTTP 服务 —— Node mpc server 的 TSS 签名器
//!
//! 端点：
//!   POST /v1/import { private_key }        → { shard1, shard2, shard3, address }（trusted_dealer 2-of-3 迁移，地址不变）
//!   POST /v1/sign    { share1, wallet_address, msg_hash, partner_index? }
//!                                          → { signature(64B hex) }（与 tss_signer(party1/party2) 完成 2-of-3 presign+sign）
//!   GET  /health

use anyhow::Context;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use generic_ec::{NonZero, SecretScalar};
use mpc_tss::wire::{InitRequest, StepRequest};
use mpc_tss::{
    data_to_sign_from_hash, drain_outbox, make_party, make_protocol_future, outgoing_to_wire,
    outgoing_wire_to_incoming, KeyShare, Secp256k1,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha3::Digest;

#[derive(Clone)]
struct AppState {
    /// 索引 0 → 片2(tss_signer party1)、索引 1 → 片3(tss_signer party2)
    partner_urls: Vec<String>,
    client: Client,
}

#[derive(Debug, Serialize, Deserialize)]
struct ImportRequest {
    private_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ImportResponse {
    shard1: serde_json::Value,
    shard2: serde_json::Value,
    shard3: serde_json::Value,
    address: String,
    compressed_pk: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SignRequest {
    share1: serde_json::Value,
    wallet_address: String,
    msg_hash: String, // 32B hex（Node 已按 EIP-191/EIP-712/交易哈希计算好的摘要）
    // 参与签名的 partner 片索引：1（片2，默认，兼容 2-of-2）或 2（片3，独立签名机/HSM）
    partner_index: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SignResponse {
    signature: String, // 64B r||s hex
}

#[derive(Debug, Serialize, Deserialize)]
struct AddressRequest {
    share: serde_json::Value,
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "mpc-signer" }))
}

/// 存量迁移：完整私钥 → trusted_dealer 2-of-3 分片（地址不变）
async fn import_shares(
    Json(req): Json<ImportRequest>,
) -> Result<Json<ImportResponse>, (StatusCode, String)> {
    let sk_hex = req.private_key.trim_start_matches("0x");
    let sk_bytes = hex::decode(sk_hex).map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid private key hex: {e}")))?;
    let sk = SecretScalar::<Secp256k1>::from_be_bytes(&sk_bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid private key: {e}")))?;
    let sk_nz = NonZero::from_secret_scalar(sk).ok_or((StatusCode::BAD_REQUEST, "zero private key".into()))?;

    let mut rng = rand::rngs::OsRng;
    // AX-13：2-of-3 阈值演进。片1=mpc_signer、片2=tss_signer(party1)、片3=tss_signer(party2, 独立签名机/HSM)。
    // 任取 2 片即可完成签名；2-of-2 平滑兼容（旧客户端只存片1+片2 仍可签名）。
    let shares = cggmp24::trusted_dealer::builder::<Secp256k1, cggmp24::security_level::SecurityLevel128>(3)
        .set_threshold(Some(2))
        .set_shared_secret_key(sk_nz)
        .generate_shares(&mut rng)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("trusted dealer: {e}")))?;

    let address = {
        let pk_bytes = shares[0].core.shared_public_key.to_bytes(false);
        let hash: [u8; 32] = sha3::Keccak256::digest(&pk_bytes[1..]).into();
        format!("0x{}", hex::encode(&hash[12..]))
    };
    Ok(Json(ImportResponse {
        shard1: serde_json::to_value(&shares[0]).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        shard2: serde_json::to_value(&shares[1]).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        shard3: serde_json::to_value(&shares[2]).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        address,
        compressed_pk: hex::encode(shares[0].core.shared_public_key.to_bytes(true)),
    }))
}

/// 由分片反推地址（校验用；与 import 同一套哈希逻辑）
async fn share_address(
    Json(req): Json<AddressRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let share: KeyShare<Secp256k1> = serde_json::from_value(req.share)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid share: {e}")))?;
    let pk_bytes = share.core.shared_public_key.to_bytes(false);
    let hash: [u8; 32] = sha3::Keccak256::digest(&pk_bytes[1..]).into();
    Ok(Json(serde_json::json!({
        "address": format!("0x{}", hex::encode(&hash[12..])),
    })))
}

/// 与 tss_signer 完成 2-of-3 presign + sign（同步交替；party0 与 party1/party2 中任一方）
async fn run_initiator(
    share: KeyShare<Secp256k1>,
    eid_bytes: [u8; 32],
    parties: Vec<u16>,
    data_to_sign: cggmp24::DataToSign<Secp256k1>,
    partner_url: &str,
    exec_id: &str,
    client: &Client,
) -> anyhow::Result<cggmp24::Signature<Secp256k1>> {
    let (inbox_tx, mut outbox_rx, party) = make_party();
    let mut fut = make_protocol_future(eid_bytes, 0, parties, share, party);
    let mut my_pair: Option<mpc_tss::PresignPair> = None;

    // done 后仍需继续轮询 partner 直到拿到 partial（鲁棒处理）
    let mut extra_rounds = 0;
    loop {
        // 推进自己的协议 future（waker/cx 在块内重建，避免非 Send 引用跨 await 存活）
        let mut outgoing = Vec::new();
        {
            let waker = std::task::Waker::noop();
            let mut cx = std::task::Context::from_waker(&waker);
            loop {
                match fut.as_mut().poll(&mut cx) {
                    std::task::Poll::Ready(Ok(pair)) => {
                        my_pair = Some(pair);
                        break;
                    }
                    std::task::Poll::Ready(Err(e)) => {
                        return Err(anyhow::anyhow!("initiator protocol error: {e}"))
                    }
                    std::task::Poll::Pending => break,
                }
            }
        }
        for m in drain_outbox(&mut outbox_rx) {
            outgoing.push(outgoing_to_wire(m)?);
        }

        // 与 partner 交换一轮
        let resp: mpc_tss::wire::StepResponse = client
            .post(format!("{partner_url}/v1/step"))
            .json(&StepRequest {
                exec_id: exec_id.to_string(),
                incoming: outgoing,
            })
            .send()
            .await
            .context("call tss-signer /v1/step")?
            .error_for_status()
            .context("tss-signer step error")?
            .json()
            .await
            .context("parse step response")?;

        for w in resp.outgoing {
            // 参与子集恒为 2 方：本地索引 0（本机/party0）与 1（partner）
            let incoming = outgoing_wire_to_incoming(w, 1).context("parse partner msg")?;
            inbox_tx
                .unbounded_send(incoming)
                .map_err(|_| anyhow::anyhow!("inbox closed"))?;
        }

        if let Some((presig, commitments)) = my_pair.take() {
            if let Some(partial_json) = resp.partial {
                let other_partial: cggmp24::PartialSignature<Secp256k1> =
                    serde_json::from_value(partial_json)
                        .context("parse partner partial signature")?;
                let my_partial = presig.issue_partial_signature(data_to_sign);
                let sig = cggmp24::PartialSignature::combine(
                    &[my_partial, other_partial],
                    &commitments,
                    data_to_sign,
                )
                .context("combine partial signatures")?;
                return Ok(sig);
            }
            // 协议已结束但 partner 尚未返回 partial：再等一轮
            extra_rounds += 1;
            my_pair = Some((presig, commitments));
            if extra_rounds > 5 {
                return Err(anyhow::anyhow!("partner never returned partial signature"));
            }
        }
    }
}

async fn sign(
    State(st): State<AppState>,
    Json(req): Json<SignRequest>,
) -> Result<Json<SignResponse>, (StatusCode, String)> {
    let share: KeyShare<Secp256k1> = serde_json::from_value(req.share1)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid share1: {e}")))?;
    let msg_hash_bytes = hex::decode(req.msg_hash.trim_start_matches("0x"))
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid msg_hash: {e}")))?;
    let hash: [u8; 32] = msg_hash_bytes
        .try_into()
        .map_err(|_| (StatusCode::BAD_REQUEST, "msg_hash must be 32 bytes".into()))?;
    let data_to_sign = data_to_sign_from_hash(&hash);

    // AX-13：partner_index 选择参与签名的片（1→片2，2→片3）。
    // parties 是参与子集在 keygen 时的索引 S（协议内 Lagrange 用）；本机恒为本地索引 0，
    // partner 恒为本地索引 1（2 方子集）。
    let partner_index = req.partner_index.unwrap_or(1);
    if partner_index != 1 && partner_index != 2 {
        return Err((StatusCode::BAD_REQUEST, "partner_index must be 1 or 2".into()));
    }
    let parties = if partner_index == 2 { vec![0u16, 2u16] } else { vec![0u16, 1u16] };
    let partner_url = st
        .partner_urls
        .get(partner_index as usize - 1)
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, format!("partner url for index {partner_index} not configured").into()))?
        .clone();

    let exec_id = format!("sign-{}-{}", req.wallet_address, hex::encode(&hash[..8]));
    let eid_bytes: [u8; 32] = sha2::Sha256::digest(exec_id.as_bytes()).into();

    // 初始化 partner 会话（幂等：tss_signer 从 keystore 取片2/片3）
    st.client
        .post(format!("{}/v1/init", partner_url))
        .json(&InitRequest {
            exec_id: exec_id.clone(),
            wallet_address: req.wallet_address.clone(),
            parties: parties.clone(),
            // tss_signer 的 hex32 不接受 0x 前缀，统一剥离后再转发
            msg_hash: req.msg_hash.trim_start_matches("0x").to_string(),
        })
        .send()
        .await
        .context("call tss-signer /v1/init")
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("{e:#}")))? 
        .error_for_status()
        .context("tss-signer init error")
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("{e:#}")))?;

    // 与 tss_signer 同步交替完成 presign+sign
    let signature = run_initiator(
        share,
        eid_bytes,
        parties,
        data_to_sign,
        &partner_url,
        &exec_id,
        &st.client,
    )
    .await
    .map_err(|e| (StatusCode::BAD_GATEWAY, format!("TSS sign failed: {e}")))?;

    let mut sig_bytes = [0u8; 64];
    signature.write_to_slice(&mut sig_bytes);
    Ok(Json(SignResponse {
        signature: hex::encode(sig_bytes),
    }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::var("MPC_SIGNER_PORT").unwrap_or_else(|_| "9201".into());
    // AX-13：片2/片3 可部署在不同机器（独立签名机/HSM），分别配置 URL。
    // 兼容旧配置：只配 TSS_SIGNER_URL 时视为片2。
    let legacy = std::env::var("TSS_SIGNER_URL").unwrap_or_else(|_| "http://127.0.0.1:9200".into());
    let partner_urls = vec![
        std::env::var("TSS_SIGNER_URL_1").unwrap_or_else(|_| legacy.clone()),
        std::env::var("TSS_SIGNER_URL_2").unwrap_or_else(|_| legacy),
    ];
    let client = Client::builder().build()?;
    let state = AppState {
        partner_urls,
        client,
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/import", post(import_shares))
        .route("/v1/address", post(share_address))
        .route("/v1/sign", post(sign))
        .with_state(state);
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!(
        "[mpc-signer] listening on {addr} (party0, 持片1), partners={:?}",
        std::env::var("TSS_SIGNER_URL_1").or_else(|_| std::env::var("TSS_SIGNER_URL")).unwrap_or_else(|_| "http://127.0.0.1:9200".into())
    );
    axum::serve(listener, app).await?;
    Ok(())
}
