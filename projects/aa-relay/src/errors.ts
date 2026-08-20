// A-10: 计费/引擎业务错误（billing.ts / escrow-client.ts / payments 共用，避免循环依赖）
export class AABillingError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
