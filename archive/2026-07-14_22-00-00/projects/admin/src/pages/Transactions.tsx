import { useState, useEffect } from 'react';
import { Shield, Clock, Check, XCircle, ArrowRight } from 'lucide-react';
import { api } from '../lib';

interface Tx {
  id: string; wallet_address: string; from_address: string; to_address: string;
  amount: string; token_address: string; tx_hash: string; status: string;
  signature_strategy: string; risk_result: any; user_email: string; created_at: string;
}

export default function Transactions() {
  const [txs, setTxs] = useState<Tx[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = async () => {
    try {
      const p = new URLSearchParams(); if (filter) p.set('status', filter);
      const d = await api(`/admin/transactions?${p.toString()}`);
      setTxs(d.data || []); setTotal(d.total || 0);
    } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filter]);

  const doAction = async (id: string, status: string) => {
    await api(`/admin/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    load();
  };

  const statusFilters = ['', 'pending', 'pending_confirmation', 'pending_approval', 'confirmed', 'failed', 'rejected', 'blocked'];

  if (loading) return <div className="loading"><span className="spin"/> Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>💰 Transactions</h2>
        <span style={{ color: 'var(--dim)', fontSize: 13 }}>{total} total</span>
      </div>

      <div className="form-row" style={{ marginBottom: 16 }}>
        <div>
          <label>Status Filter</label>
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            {statusFilters.map(s => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </div>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Wallet</th>
              <th>To</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Strategy</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {txs.map(tx => (
              <tr key={tx.id}>
                <td style={{ fontSize: 12, color: 'var(--dim)' }}>{new Date(tx.created_at).toLocaleString()}</td>
                <td style={{ fontSize: 12 }}>{tx.user_email || '-'}</td>
                <td className="mono" style={{ fontSize: 12 }}>{tx.wallet_address ? tx.wallet_address.slice(0,8)+'...' : '-'}</td>
                <td className="mono" style={{ fontSize: 12 }}>{tx.to_address?.slice(0,8)}...</td>
                <td style={{ fontWeight: 600 }}>{parseFloat(tx.amount).toFixed(4)} {tx.token_address === '*' ? 'ETH' : 'TOKEN'}</td>
                <td><span className={`badge ${tx.status === 'confirmed' ? 'green' : tx.status === 'failed' ? 'red' : 'yellow'}`}>{tx.status}</span></td>
                <td style={{ fontSize: 12 }}>{tx.signature_strategy}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {['pending_approval'].includes(tx.status) && (
                      <button className="btn btn-primary btn-xs" onClick={() => doAction(tx.id, 'pending_confirmation')}>Approve</button>
                    )}
                    {['pending', 'pending_confirmation', 'pending_approval'].includes(tx.status) && (
                      <button className="btn btn-danger btn-xs" onClick={() => doAction(tx.id, 'rejected')}>Reject</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
