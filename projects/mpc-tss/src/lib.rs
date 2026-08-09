//! mpc-tss 共享库：presign → partial → combine → 标准 ECDSA 验证
//!
//! M1（DKG 新生密钥）、M2（trusted_dealer 导入存量密钥）与 M3（跨进程 HTTP TSS）
//! 共用此逻辑。

use anyhow::{Context, Result};
pub use cggmp24::supported_curves::Secp256k1;
pub use cggmp24::{DataToSign, ExecutionId, KeyShare};
use futures::StreamExt as _;

/// 跨进程协议消息类型（cggmp24 signing 协议消息，可 serde）
pub type SignMsg = cggmp24::signing::msg::Msg<Secp256k1, sha2::Sha256>;
/// presignature 协议输出
pub type PresignPair = (
    cggmp24::Presignature<Secp256k1>,
    cggmp24::signing::PresignaturePublicData<Secp256k1>,
);
/// presignature 协议输出类型（带错误）
pub type PresignOut = Result<PresignPair, cggmp24::SigningError>;

// ─── HTTP wire 格式（Outgoing/Incoming 的 JSON 封装） ───
pub mod wire {
    use serde::{Deserialize, Serialize};

    /// 传输层向外发送的消息（recipient=-1 表示广播）
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct OutgoingWire {
        pub recipient: i64,
        pub msg: serde_json::Value,
    }

    /// responder（party1）单步请求：incoming 为发起方（party0）发出的消息
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct StepRequest {
        pub exec_id: String,
        pub incoming: Vec<OutgoingWire>,
    }

    /// responder（party1）单步响应
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct StepResponse {
        pub outgoing: Vec<OutgoingWire>,
        pub done: bool,
        pub partial: Option<serde_json::Value>,
    }

    /// 初始化 responder 会话（party1 从 keystore 取片2；双方确认待签摘要）
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct InitRequest {
        pub exec_id: String,
        pub wallet_address: String,
        pub parties: Vec<u16>,
        pub msg_hash: String, // 32B hex，双方共同确认的待签摘要
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct InitResponse {
        pub ok: bool,
    }
}

// ─── IdentityDigest：直接把 32 字节摘要当作 z（Node/ethers 已算好 EIP-191/EIP-712/交易哈希） ───
use digest::core_api::{
    BlockSizeUser, Buffer, BufferKindUser, CoreWrapper, FixedOutputCore, OutputSizeUser, UpdateCore,
};
use digest::generic_array::GenericArray;
use digest::typenum::U32;
use digest::HashMarker;

#[derive(Clone, Default)]
pub struct IdentityCore {
    buf: [u8; 32],
    len: usize,
}

impl HashMarker for IdentityCore {}

impl BlockSizeUser for IdentityCore {
    type BlockSize = U32;
}

impl BufferKindUser for IdentityCore {
    type BufferKind = digest::block_buffer::Eager;
}

impl OutputSizeUser for IdentityCore {
    type OutputSize = U32;
}

impl UpdateCore for IdentityCore {
    fn update_blocks(&mut self, blocks: &[GenericArray<u8, U32>]) {
        for block in blocks {
            let take = block.len().min(32usize.saturating_sub(self.len));
            self.buf[self.len..self.len + take].copy_from_slice(&block[..take]);
            self.len += take;
            if self.len >= 32 {
                break;
            }
        }
    }
}

impl FixedOutputCore for IdentityCore {
    fn finalize_fixed_core(
        &mut self,
        buffer: &mut Buffer<Self>,
        out: &mut GenericArray<u8, Self::OutputSize>,
    ) {
        let remaining = buffer.get_data();
        let take = remaining.len().min(32usize.saturating_sub(self.len));
        self.buf[self.len..self.len + take].copy_from_slice(&remaining[..take]);
        out.copy_from_slice(&self.buf);
    }
}

impl digest::Reset for IdentityCore {
    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// 直接把 32 字节摘要当作 z（不再二次哈希）
pub type IdentityDigest = CoreWrapper<IdentityCore>;

/// 从双方共同确认的 32 字节摘要构造待签数据
pub fn data_to_sign_from_hash(hash: &[u8; 32]) -> DataToSign<Secp256k1> {
    DataToSign::digest::<IdentityDigest>(hash)
}

// ─── wire 转换 ───
pub fn outgoing_to_wire(out: round_based::Outgoing<SignMsg>) -> Result<wire::OutgoingWire> {
    let recipient = match out.recipient {
        round_based::MessageDestination::AllParties => -1i64,
        round_based::MessageDestination::OneParty(p) => i64::from(p),
    };
    Ok(wire::OutgoingWire {
        recipient,
        msg: serde_json::to_value(out.msg).context("serialize signing msg")?,
    })
}

pub fn wire_to_outgoing(w: wire::OutgoingWire) -> Result<round_based::Outgoing<SignMsg>> {
    let recipient = if w.recipient < 0 {
        round_based::MessageDestination::AllParties
    } else {
        round_based::MessageDestination::OneParty(w.recipient as u16)
    };
    let msg = serde_json::from_value(w.msg).context("deserialize signing msg")?;
    Ok(round_based::Outgoing { recipient, msg })
}

/// 把对方发来的 OutgoingWire 包装成本方协议可消费的 Incoming（sender 固定为对方 party 索引）
pub fn outgoing_wire_to_incoming(
    w: wire::OutgoingWire,
    sender: u16,
) -> Result<round_based::Incoming<SignMsg>> {
    let msg_type = if w.recipient < 0 {
        round_based::MessageType::Broadcast
    } else {
        round_based::MessageType::P2P
    };
    let msg = serde_json::from_value(w.msg).context("deserialize signing msg")?;
    Ok(round_based::Incoming {
        id: 0,
        sender,
        msg_type,
        msg,
    })
}

// ─── 传输错误占位（mpsc 通道错误，实际不会产生） ───
#[derive(Debug)]
pub struct NeverErr;

impl std::fmt::Display for NeverErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "never")
    }
}
impl std::error::Error for NeverErr {}

/// 构造协议 future（rng 为 async block 局部变量，避免自引用；share 克隆进入）
pub fn make_protocol_future(
    eid_bytes: [u8; 32],
    i: u16,
    parties: Vec<u16>,
    share: KeyShare<Secp256k1>,
    party: round_based::MpcParty<SignMsg, PartyDelivery>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = PresignOut> + Send>> {
    Box::pin(async move {
        let mut rng = rand::rngs::OsRng;
        let eid = ExecutionId::new(&eid_bytes);
        cggmp24::signing(eid, i, &parties, &share)
            .generate_presignature(&mut rng, party)
            .await
    })
}

/// party 传输层：incoming 流 + outgoing sink（mpsc 通道）
pub type PartyDelivery = (
    futures::stream::Map<
        futures::channel::mpsc::UnboundedReceiver<round_based::Incoming<SignMsg>>,
        fn(round_based::Incoming<SignMsg>) -> std::result::Result<round_based::Incoming<SignMsg>, NeverErr>,
    >,
    futures::channel::mpsc::UnboundedSender<round_based::Outgoing<SignMsg>>,
);

/// 创建 party 及与其关联的通道（返回 inbox 发送端 + outbox 接收端）
pub fn make_party() -> (
    futures::channel::mpsc::UnboundedSender<round_based::Incoming<SignMsg>>,
    futures::channel::mpsc::UnboundedReceiver<round_based::Outgoing<SignMsg>>,
    round_based::MpcParty<SignMsg, PartyDelivery>,
) {
    let (inbox_tx, inbox_rx) = futures::channel::mpsc::unbounded();
    let (outbox_tx, outbox_rx) = futures::channel::mpsc::unbounded();
    let rx: futures::stream::Map<
        _,
        fn(round_based::Incoming<SignMsg>) -> std::result::Result<round_based::Incoming<SignMsg>, NeverErr>,
    > = inbox_rx.map(Ok as fn(_) -> _);
    let party = round_based::MpcParty::connected((rx, outbox_tx));
    (inbox_tx, outbox_rx, party)
}

/// 排空协议产出的所有 outgoing 消息
pub fn drain_outbox(
    outbox: &mut futures::channel::mpsc::UnboundedReceiver<round_based::Outgoing<SignMsg>>,
) -> Vec<round_based::Outgoing<SignMsg>> {
    let mut msgs = Vec::new();
    while let Ok(m) = outbox.try_recv() {
        msgs.push(m);
    }
    msgs
}

/// 每个 party 执行 presignature 生成协议（进程内仿真，M1/M2 用），返回 (presig, commitments) 元组
pub fn run_presign(
    eid: ExecutionId,
    parties_indexes_at_keygen: &[u16],
    shares: &[KeyShare<Secp256k1>],
) -> Result<Vec<PresignPair>> {
    let n = shares.len() as u16;
    let result = round_based::sim::run(n, |i, party| {
        let mut rng = rand::rngs::OsRng;
        let share = &shares[i as usize];
        async move {
            cggmp24::signing(eid, i, parties_indexes_at_keygen, share)
                .generate_presignature(&mut rng, party)
                .await
        }
    })
    .context("presign simulation failed")?
    .expect_ok()
    .into_vec();
    Ok(result)
}

/// 由 presig 元组列表对给定消息签发，返回 64B r||s 标准 ECDSA 签名
pub fn sign_with_presigs(
    presigs: Vec<PresignPair>,
    data_to_sign: DataToSign<Secp256k1>,
) -> Result<cggmp24::Signature<Secp256k1>> {
    let (_, commitments) = presigs[0].clone();
    let partials: Vec<_> = presigs
        .into_iter()
        .map(|(presig, _)| presig.issue_partial_signature(data_to_sign))
        .collect();
    cggmp24::PartialSignature::combine(&partials, &commitments, data_to_sign)
        .context("combine partial signatures")
}

/// 独立库（k256）标准 ECDSA 验证
pub fn verify_k256(pk_bytes: &[u8], sig_bytes: &[u8; 64], message: &[u8]) -> Result<()> {
    use k256::ecdsa::signature::Verifier;
    let pk = k256::ecdsa::VerifyingKey::from_sec1_bytes(pk_bytes).context("k256 parse pk")?;
    let sig = k256::ecdsa::Signature::from_slice(sig_bytes).context("k256 parse sig")?;
    pk.verify(message, &sig).context("k256 external verify failed")
}
