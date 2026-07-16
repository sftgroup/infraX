import { useState, useEffect } from 'react';
import { Webhook, RefreshCw, Check, XCircle } from 'lucide-react';
import { api } from '../lib';

interface WebhookEvent {
  id: string; event_type: string; tenant_id: string; user_id: string;
  payload: any; retry_count: number; last_error: string; status: string; created_at: string;
}

export default function Webhooks() {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = async () => {
    try {
      const p = new URLSearchParams(); if (filter) p.set('status', filter);
      const d = await api(`/admin/webhooks?${p.toString()}`);
      setEvents(d.data || []); setTotal(d.total || 0);
    } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filter]);

  if (loading) return <div className="loading"><span className="spin"/> Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>📡 Webhook Events</h2>
        <span style={{ color: 'var(--dim)', fontSize: 13 }}>{total} events</span>
      </div>

      <div className="form-row" style={{ marginBottom: 16 }}>
        <div>
          <label>Status Filter</label>
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={load} style={{ flex: 'none' }}>
          <RefreshCw size={14}/>Refresh
        </button>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Tenant</th>
              <th>Retries</th>
              <th>Status</th>
              <th>Error</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {events.map(e => (
              <tr key={e.id}>
                <td style={{ fontSize: 12, color: 'var(--dim)' }}>{new Date(e.created_at).toLocaleString()}</td>
                <td><span className={`badge ${e.event_type === 'deposit' ? 'green' : e.event_type === 'withdrawal' ? 'blue' : e.event_type === 'failed' ? 'red' : 'yellow'}`}>{e.event_type}</span></td>
                <td className="mono" style={{ fontSize: 11 }}>{e.tenant_id?.slice(0, 8)}...</td>
                <td>{e.retry_count}</td>
                <td><span className={`badge ${e.status === 'delivered' ? 'green' : e.status === 'failed' ? 'red' : 'yellow'}`}>{e.status}</span></td>
                <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, color: 'var(--red)' }}>{e.last_error || '-'}</td>
                <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, color: 'var(--dim)' }}>
                  {e.event_type && JSON.stringify(e.payload)?.slice(0, 60)}...
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
