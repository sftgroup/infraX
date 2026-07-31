import { ethers } from 'ethers';
import type { NormalizedEvent } from './normalizer';

const SOLANA_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const MINT_TRUNCATE_LENGTH = 16;
const MINT_EVENT_ID_LENGTH = 12;
const DEFAULT_DECIMALS = 9;

/**
 * Normalize a Solana block — extract SPL token transfers from tokenBalances
 */
export function normalizeSolanaBlock(rawBlock: any): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (!rawBlock || !rawBlock.transactions) return events;

  const slot = rawBlock.blockHeight ?? rawBlock.slot ?? 0;
  const blockTime = rawBlock.blockTime ?? 0;

  for (const tx of rawBlock.transactions) {
    const txSig = tx.transaction?.signatures?.[0];
    if (!txSig) continue;

    const meta = tx.meta || {};
    if (meta.err) continue; // skip failed transactions

    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];

    if (pre.length === 0 && post.length === 0) continue;

    // Build pre/post balance maps keyed by (mint, owner, accountIndex)
    const preMap = new Map<string, any>();
    for (const b of pre) {
      const key = `${b.mint}|${b.owner}|${b.accountIndex}`;
      preMap.set(key, b);
    }

    const postMap = new Map<string, any>();
    for (const b of post) {
      const key = `${b.mint}|${b.owner}|${b.accountIndex}`;
      postMap.set(key, b);
    }

    // Find transfers: same (mint, accountIndex) but different owner or amount
    for (const [key, postBal] of postMap) {
      const preBal = preMap.get(key);
      if (!preBal) continue;

      const preAmount = BigInt(preBal.uiTokenAmount?.amount || '0');
      const postAmount = BigInt(postBal.uiTokenAmount?.amount || '0');

      if (postAmount === preAmount) continue;

      const token = preBal.uiTokenAmount || {};
      const mint = preBal.mint;
      const decimals = token.decimals || DEFAULT_DECIMALS;
      const diff = postAmount > preAmount ? postAmount - preAmount : preAmount - postAmount;
      const direction = postAmount > preAmount ? 'in' : 'out';

      const amountRaw = diff.toString();
      const amount = ethers.formatUnits(diff, decimals);

      // Find corresponding sender/receiver accounts
      const toAddress = direction === 'in' ? postBal.owner : null;
      const fromAddress = direction === 'out' ? preBal.owner : null;

      // Try to find counterpart in post balances
      let counterpart: string | null = null;
      if (direction === 'in') {
        for (const [k2, b2] of postMap) {
          if (k2 === key) continue;
          const b2Post = BigInt(b2.uiTokenAmount?.amount || '0');
          const b2Pre = preMap.get(k2);
          if (!b2Pre) continue;
          const b2PreAmt = BigInt(b2Pre.uiTokenAmount?.amount || '0');
          if (b2Post < b2PreAmt && parseInt(b2.mint, 16) === parseInt(mint, 16)) {
            counterpart = b2.owner;
            break;
          }
        }
      } else {
        for (const [, b2] of postMap) {
          if (b2.owner === postBal.owner) continue;
          const b2Post = BigInt(b2.uiTokenAmount?.amount || '0');
          const b2PreKey = `${b2.mint}|${b2.owner}|${b2.accountIndex}`;
          const b2Pre2 = preMap.get(b2PreKey);
          if (!b2Pre2) continue;
          const b2PreAmt = BigInt(b2Pre2.uiTokenAmount?.amount || '0');
          if (b2Post > b2PreAmt && b2.mint === mint) {
            counterpart = b2.owner;
            break;
          }
        }
      }

      const symbol = mint === SOLANA_NATIVE_MINT ? 'SOL'
        : mint.length > MINT_TRUNCATE_LENGTH ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint;

      events.push({
        event_id: `${txSig}_${mint.slice(0, MINT_EVENT_ID_LENGTH)}_${preBal.accountIndex}`,
        event_type: 'transfer',
        source: 'blockchain',
        chain: 'solana',
        block_number: slot,
        tx_hash: txSig,
        log_index: preBal.accountIndex,
        contract_address: null,
        from_address: direction === 'out' ? postBal.owner : (counterpart || preBal.owner),
        to_address: direction === 'in' ? postBal.owner : (counterpart || postBal.owner),
        token_address: mint,
        token_symbol: symbol,
        token_id: null,
        amount,
        amount_raw: amountRaw,
        event_data: {
          slot,
          blockTime,
          decimals,
          programId: preBal.programId,
        },
        topic_hash: null,
        status: 'confirmed',
        confirmations: 1,
      });
    }
  }

  return events;
}
