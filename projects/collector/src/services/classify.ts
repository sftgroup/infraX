/**
 * 9.6 Phase 1.3 — Event classification mapping
 *
 * Maps normalized event_type + context onto the business classification
 * catalog (event_categories table):
 *   category_id — first-level business category
 *   label_id    — second-level label (event_type granularity)
 *
 * Kept pure/stateless so both insertEvents (eventStore.ts) and the
 * batch reclassifier (reclassifier.ts) reuse the same mapping.
 */

export interface EventCategory {
  category_id: string;
  label_id: string;
}

export interface ClassifyContext {
  event_type: string;
  /** ERC-721/ERC-1155 等标准标记（event_data.standard） */
  standard?: string | null;
  /** 原生转账时 contract_address 为空串，ERC-20 转账为代币合约地址 */
  contract_address?: string | null;
}

/**
 * Classify an event from its normalized event_type + context.
 * Falls back to unclassified/raw_event for unknown types.
 */
export function classifyEvent(ctx: ClassifyContext): EventCategory {
  const { event_type, standard, contract_address } = ctx;
  switch (event_type) {
    case 'transfer':
      // 原生转账（ETH/BNB/SOL 由 block.transactions 提取，contract_address 为空）
      // vs ERC-20 转账（contract_address 为代币合约地址）
      if (!contract_address) return { category_id: 'asset_transfer', label_id: 'native_transfer' };
      if (standard === 'ERC-721') return { category_id: 'asset_transfer', label_id: 'nft_transfer' };
      return { category_id: 'asset_transfer', label_id: 'erc20_transfer' };
    case 'nft_transfer':
      return { category_id: 'asset_transfer', label_id: 'nft_transfer' };
    case 'approval':
      return { category_id: 'authorization', label_id: 'approval' };
    case 'swap':
      return { category_id: 'dex_trading', label_id: 'swap' };
    case 'deposit':
      return { category_id: 'wrapping', label_id: 'deposit' };
    case 'withdrawal':
      return { category_id: 'wrapping', label_id: 'withdrawal' };
    case 'mint':
      return { category_id: 'supply', label_id: 'mint' };
    case 'burn':
      return { category_id: 'supply', label_id: 'burn' };
    default:
      return { category_id: 'unclassified', label_id: 'raw_event' };
  }
}
