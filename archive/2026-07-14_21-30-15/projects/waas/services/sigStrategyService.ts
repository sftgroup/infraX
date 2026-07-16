import { config } from '../config';

/**
 * BE-06: Signature Strategy Engine
 * (L-007) <100 USD auto-sign | 100-10k confirm | >10k approval
 */

export type SigAction = 'auto' | 'confirm' | 'approval';

export interface StrategyResult {
  action: SigAction;
  amount: number;
  threshold: string;
  description: string;
}

/**
 * Determine signature strategy based on USD amount
 */
export function determineStrategy(amountUsd: number): StrategyResult {
  const autoMax = config.sig.autoSignMax;   // <100
  const confirmMin = config.sig.confirmMin;  // >=100
  const confirmMax = config.sig.confirmMax;  // <=10000
  // >10000 => approval

  if (amountUsd <= autoMax) {
    return {
      action: 'auto',
      amount: amountUsd,
      threshold: `< ${autoMax} USD`,
      description: `Auto-sign: transaction $${amountUsd} is under $${autoMax}`,
    };
  }

  if (amountUsd >= confirmMin && amountUsd <= confirmMax) {
    return {
      action: 'confirm',
      amount: amountUsd,
      threshold: `${confirmMin} - ${confirmMax} USD`,
      description: `Requires user confirmation: transaction $${amountUsd} is between $${confirmMin} and $${confirmMax}`,
    };
  }

  return {
    action: 'approval',
    amount: amountUsd,
    threshold: `> ${config.sig.approvalMin} USD`,
    description: `Requires multi-sig approval: transaction $${amountUsd} exceeds $${config.sig.approvalMin}`,
  };
}
