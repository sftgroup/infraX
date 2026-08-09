//! M3 tss_signer：CGGMP24 party1（持片2）HTTP 守护进程
//!
//! 与 mpc_signer（party0，持片1）通过同步交替 HTTP 完成 2-of-2 presign。
//! 端点：
//!   POST /v1/keystore { wallet_address, share }        注册片2（隔离保存）
//!   POST /v1/init     { exec_id, wallet_address, parties, msg_hash }
//!   POST /v1/step     { exec_id, incoming }            单步推进协议
//!   GET  /health

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use mpc_tss::wire::{InitRequest, InitResponse, StepRequest, StepResponse};
use mpc_tss::{
    drain_outbox, make_party, make_protocol_future, outgoing_to_wire, outgoing_wire_to_incoming,
    KeyShare, PresignOut, SignMsg, Secp256k1,
};

type Sessions = Arc<Mutex<HashMap<String, ResponderSession>>>;
type Keystore = Arc<Mutex<HashMap<String, serde_json::Value>>>;

struct ResponderSession {
    inbox_tx: futures::channel::mpsc::UnboundedSender<round_based::Incoming<SignMsg>>,
    outbox_rx: futures::channel::mpsc::UnboundedReceiver<round_based::Outgoing<SignMsg>>,
    fut: std::pin::Pin<Box<dyn std::future::Future<Output = PresignOut> + Send>>,
    data_to_sign: cggmp24::DataToSign<Secp256k1>,
}

fn hex32(s: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = hex::decode(s.trim_start_matches("0x")).context("invalid hex")?;
    let len = bytes.len();
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected 32 bytes, got {len}"))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "tss-signer" }))
}

async fn keystore(
    State((_sessions, ks)): State<(Sessions, Keystore)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let addr = req
        .get("wallet_address")
        .and_then(|v| v.as_str())
        .ok_or((StatusCode::BAD_REQUEST, "wallet_address required".into()))?;
    let share = req
        .get("share")
        .ok_or((StatusCode::BAD_REQUEST, "share required".into()))?;
    // 校验是合法 KeyShare
    serde_json::from_value::<KeyShare<Secp256k1>>(share.clone())
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid share: {e}")))?;
    ks.lock().unwrap().insert(addr.to_string(), share.clone());
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn init(
    State((sessions, ks)): State<(Sessions, Keystore)>,
    Json(req): Json<InitRequest>,
) -> Result<Json<InitResponse>, (StatusCode, String)> {
    let share_json = ks
        .lock()
        .unwrap()
        .get(&req.wallet_address)
        .cloned()
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("no shard2 registered for {}", req.wallet_address),
        ))?;
    let share: KeyShare<Secp256k1> =
        serde_json::from_value(share_json).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let hash = hex32(&req.msg_hash).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let data_to_sign = mpc_tss::data_to_sign_from_hash(&hash);
    let eid_bytes: [u8; 32] = {
        use sha2::Digest;
        sha2::Sha256::digest(req.exec_id.as_bytes()).into()
    };
    let (inbox_tx, outbox_rx, party) = make_party();
    // party1：i=1
    let fut = make_protocol_future(eid_bytes, 1, req.parties, share, party);
    sessions.lock().unwrap().insert(
        req.exec_id.clone(),
        ResponderSession {
            inbox_tx,
            outbox_rx,
            fut,
            data_to_sign,
        },
    );
    Ok(Json(InitResponse { ok: true }))
}

async fn step(
    State((sessions, _ks)): State<(Sessions, Keystore)>,
    Json(req): Json<StepRequest>,
) -> Result<Json<StepResponse>, (StatusCode, String)> {
    let mut guard = sessions.lock().unwrap();
    let session = guard
        .get_mut(&req.exec_id)
        .ok_or((StatusCode::NOT_FOUND, format!("session {} not found", req.exec_id)))?;

    // 喂入消息（party0 发出的 OutgoingWire → 我方 Incoming，sender=0）
    for w in req.incoming {
        let incoming = outgoing_wire_to_incoming(w, 0)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        session
            .inbox_tx
            .unbounded_send(incoming)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "inbox closed".into()))?;
    }

    // poll 协议 future
    let waker = std::task::Waker::noop();
    let mut cx = std::task::Context::from_waker(&waker);
    let mut outgoing = Vec::new();
    loop {
        match session.fut.as_mut().poll(&mut cx) {
            std::task::Poll::Ready(Ok(pair)) => {
                let (presig, _commitments) = pair;
                for m in drain_outbox(&mut session.outbox_rx) {
                    outgoing.push(outgoing_to_wire(m).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?);
                }
                let partial = presig.issue_partial_signature(session.data_to_sign);
                let partial_json = serde_json::to_value(partial)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                guard.remove(&req.exec_id);
                return Ok(Json(StepResponse {
                    outgoing,
                    done: true,
                    partial: Some(partial_json),
                }));
            }
            std::task::Poll::Ready(Err(e)) => {
                guard.remove(&req.exec_id);
                return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("protocol error: {e}")));
            }
            std::task::Poll::Pending => {
                for m in drain_outbox(&mut session.outbox_rx) {
                    outgoing.push(outgoing_to_wire(m).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?);
                }
                return Ok(Json(StepResponse {
                    outgoing,
                    done: false,
                    partial: None,
                }));
            }
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::var("TSS_SIGNER_PORT").unwrap_or_else(|_| "9200".into());
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let keystore_state: Keystore = Arc::new(Mutex::new(HashMap::new()));
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/keystore", post(keystore))
        .route("/v1/init", post(init))
        .route("/v1/step", post(step))
        .with_state((sessions, keystore_state));
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("[tss-signer] listening on {addr} (party1, 持片2)");
    axum::serve(listener, app).await?;
    Ok(())
}
