import { useState, useEffect } from 'react';
import { ArrowRight, Check, Clock } from 'lucide-react';
import { api } from '../lib';

interface Sweep { id: string; tenant_name: string; from_address: string; to_address: string; token: string; amount: string; tx_hash: string; status: string; created_at: string; }

export default function Sweeps() {
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try { const d = await api('/admin/sweeps'); setSweeps(d || []); } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div className="loading"><span className="spin"/> Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>🧹 Sweep Queue</h2>
        <span style={{ color: 'var(--dim)', fontSize: 13 }}>{sweeps.length} records</span>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        {sweeps.length === 0 ? <div className="empty">No sweep records</div> : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Tenant</th>
                <th>From</th>
                <th>To</th>
                <th>Token</th>
                <th>Amount</th>
                <th>Status</th>
                <th>TX</th>
              </tr>
            </thead>
            <tbody>
              {sweeps.map(s => (
                <tr key={s.id}>
                  <td style={{ fontSize: 12, color: 'var(--dim)' }}>{new Date(s.created_at).toLocaleString()}</td>
                  <td style={{ fontSize: 12 }}>{s.tenant_name || '-'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.from_address?.slice(0,8)}...</td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.to_address?.slice(0,8)}...</td>
                  <td>{s.token}</td>
                  <td style={{ fontWeight: 600 }}>{parseFloat(s.amount).toFixed(4)}</td>
                  <td><span className={`badge ${s.status === 'confirmed' ? 'green' : s.status === 'failed' ? 'red' : 'yellow'}`}>{s.status}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>{s.tx_hash ? s.tx_hash.slice(0, 10) + '...' : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
