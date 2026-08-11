import { useState, useEffect } from 'react';
import { api } from '../lib';

interface Order {
  intent_id: string;
  method: string;
  subscriber: string | null;
  asset: string | null;
  amount_wei: string | null;
  currency: string | null;
  chain: string | null;
  status: string;
  metadata: any;
  created_at: string;
  updated_at: string;
}

// wei → 主链币可读值（原生资产按 18 位小数；稳定币/非原生仅展示原始单位）
function fmtAmount(order: Order): string {
  const wei = order.amount_wei;
  if (wei === null || wei === undefined || wei === '') return '-';
  const isNative = !order.asset || order.asset === 'native';
  if (isNative) {
    const bn = BigInt(wei);
    const whole = bn / 10n ** 18n;
    const frac = (bn % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
    return `${whole}.${frac}`;
  }
  return wei;
}

const METHOD_LABELS: Record<string, string> = {
  fiat: 'Fiat', chain: 'On-chain', a2a: 'A2A', mpp: 'MPP', batch: 'Batch',
};

const STATUS_FILTERS = ['', 'created', 'paid', 'failed', 'closed'];

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = async () => {
    try {
      const p = new URLSearchParams(); if (filter) p.set('status', filter);
      const d = await api(`/admin/orders?${p.toString()}`);
      setOrders(d.data || []); setTotal(d.total || 0);
    } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filter]);

  if (loading) return <div className="loading"><span className="spin"/> Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>🧾 Payment Orders</h2>
        <span style={{ color: 'var(--dim)', fontSize: 13 }}>{total} total</span>
      </div>

      <div className="form-row" style={{ marginBottom: 16 }}>
        <div>
          <label>Status Filter</label>
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            {STATUS_FILTERS.map(s => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </div>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Intent ID</th>
              <th>Method</th>
              <th>Subscriber</th>
              <th>Amount</th>
              <th>Asset</th>
              <th>Chain</th>
              <th>Status</th>
              <th>Created</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.intent_id}>
                <td className="mono" style={{ fontSize: 12 }}>{o.intent_id.slice(0, 20)}...</td>
                <td style={{ fontSize: 12 }}>{METHOD_LABELS[o.method] || o.method}</td>
                <td className="mono" style={{ fontSize: 12 }}>{o.subscriber || '-'}</td>
                <td style={{ fontWeight: 600 }}>{fmtAmount(o)}</td>
                <td style={{ fontSize: 12 }}>{o.asset === 'native' ? 'Native' : (o.asset || '-')}</td>
                <td style={{ fontSize: 12 }}>{o.chain || '-'}{o.currency ? ` (${o.currency})` : ''}</td>
                <td><span className={`badge ${o.status === 'paid' ? 'green' : o.status === 'failed' ? 'red' : 'yellow'}`}>{o.status}</span></td>
                <td style={{ fontSize: 12, color: 'var(--dim)' }}>{new Date(o.created_at).toLocaleString()}</td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--dim)', maxWidth: 180 }}>
                  {o.metadata ? JSON.stringify(o.metadata).slice(0, 60) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
