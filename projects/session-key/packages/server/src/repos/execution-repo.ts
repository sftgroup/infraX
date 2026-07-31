import { pool } from '../plugins/db.js';

export interface ExecutionRecord {
  id: string;
  sessionId: string;
  txHash: string;
  contract: string;
  functionSig: string;
  value: string;
  status: 'pending' | 'success' | 'failed';
  errorReason?: string;
  executedAt: Date;
}

export class ExecutionRepo {
  async insert(params: {
    sessionId: string;
    txHash: string;
    contract: string;
    functionSig: string;
    value: string;
    status: 'success' | 'failed';
    errorReason?: string;
  }): Promise<ExecutionRecord> {
    const result = await pool.query(
      `INSERT INTO session_executions (session_id, tx_hash, contract, function_sig, value, status, error_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [params.sessionId, params.txHash, params.contract, params.functionSig,
       params.value, params.status, params.errorReason || null]
    );
    return rowToExec(result.rows[0]);
  }

  async findBySession(sessionId: string, limit = 50): Promise<ExecutionRecord[]> {
    const result = await pool.query(
      'SELECT * FROM session_executions WHERE session_id = $1 ORDER BY executed_at DESC LIMIT $2',
      [sessionId, limit]
    );
    return result.rows.map(rowToExec);
  }
}

function rowToExec(row: any): ExecutionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    txHash: row.tx_hash || '',
    contract: row.contract,
    functionSig: row.function_sig,
    value: row.value,
    status: row.status,
    errorReason: row.error_reason || undefined,
    executedAt: row.executed_at,
  };
}
