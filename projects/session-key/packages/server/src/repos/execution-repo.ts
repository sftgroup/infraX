import pg from 'pg';

export interface ExecutionRecord {
  id: string;
  sessionId: string;
  txHash: string;
  contract: string;
  functionSig: string;
  value: string;
  status: 'pending' | 'success' | 'failed';
  errorReason?: string;
  blockNumber?: number;
  caller?: string;
  limitSnapshot?: Record<string, unknown>;
  executedAt: Date;
}

export class ExecutionRepo {
  constructor(private pool: pg.Pool) {}

  async insert(params: {
    sessionId: string; txHash: string; contract: string; functionSig: string;
    value: string; status: 'success' | 'failed'; errorReason?: string;
    blockNumber?: number; caller?: string; limitSnapshot?: Record<string, unknown>;
  }): Promise<ExecutionRecord> {
    const result = await this.pool.query(
      `INSERT INTO session_executions
         (session_id, tx_hash, contract, function_sig, value, status, error_reason, block_number, caller, limit_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [params.sessionId, params.txHash, params.contract, params.functionSig,
       params.value, params.status, params.errorReason || null,
       params.blockNumber ?? null, params.caller || null,
       params.limitSnapshot ? JSON.stringify(params.limitSnapshot) : null]
    );
    return rowToExec(result.rows[0]);
  }

  /** A-17: GET /execute/:id 单条查询 */
  async findById(id: string): Promise<ExecutionRecord | null> {
    const result = await this.pool.query('SELECT * FROM session_executions WHERE id = $1 LIMIT 1', [id]);
    return result.rows.length > 0 ? rowToExec(result.rows[0]) : null;
  }

  async findBySession(sessionId: string, limit = 50): Promise<ExecutionRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM session_executions WHERE session_id = $1 ORDER BY executed_at DESC LIMIT $2',
      [sessionId, limit]
    );
    return result.rows.map(rowToExec);
  }
}

function rowToExec(row: any): ExecutionRecord {
  return {
    id: row.id, sessionId: row.session_id, txHash: row.tx_hash || '',
    contract: row.contract, functionSig: row.function_sig,
    value: row.value, status: row.status,
    errorReason: row.error_reason || undefined,
    blockNumber: row.block_number != null ? Number(row.block_number) : undefined,
    caller: row.caller || undefined,
    limitSnapshot: row.limit_snapshot || undefined,
    executedAt: row.executed_at,
  };
}
