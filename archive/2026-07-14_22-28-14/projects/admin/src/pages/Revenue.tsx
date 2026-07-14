import { useState, useEffect } from 'react';
import { DollarSign, TrendingUp, Activity, Zap } from 'lucide-react';
import { api } from '../lib';

export default function Revenue() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/admin/revenue').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><span className="spin"/> Loading...</div>;
  if (!data) return <div className="empty">No data</div>;

  const totalSubs = data.subscriptions?.reduce((s: number, i: any) => s + parseInt(i.cnt), 0) || 0;
  const revenue = data.payments?.filter((p: any) => p.status === 'paid').reduce((s: number, p: any) => s + parseFloat(p.total_usd), 0) || 0;

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>💰 Revenue</h2>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{data.activeTenants}</div>
          <div className="stat-label">Active Tenants</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totalSubs}</div>
          <div className="stat-label">Subscriptions</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.dcSubscribers}</div>
          <div className="stat-label">DC Subscribers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--green)' }}>${revenue.toFixed(0)}</div>
          <div className="stat-label">30d Revenue</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>📊 Subscriptions</h3>
        <table>
          <thead><tr><th>Plan</th><th>Name</th><th>Price</th><th>Cycle</th><th>Status</th><th>Count</th></tr></thead>
          <tbody>
            {data.subscriptions?.map((s: any, i: number) => (
              <tr key={i}>
                <td className="mono">{s.plan_id}</td>
                <td>{s.plan_name}</td>
                <td>${s.price}</td>
                <td>{s.billing_cycle}</td>
                <td><span className={`badge ${s.status === 'active' ? 'green' : 'yellow'}`}>{s.status}</span></td>
                <td>{s.cnt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>💳 Payments (30d)</h3>
        <table>
          <thead><tr><th>Status</th><th>Count</th><th>Total USD</th></tr></thead>
          <tbody>
            {data.payments?.map((p: any, i: number) => (
              <tr key={i}>
                <td><span className={`badge ${p.status === 'paid' ? 'green' : p.status === 'pending' ? 'yellow' : 'red'}`}>{p.status}</span></td>
                <td>{p.cnt}</td>
                <td>${parseFloat(p.total_usd).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>📈 API Usage (30d)</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: 10 }}>
          {data.apiUsage?.map((d: any) => (
            <div key={d.date} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              padding: '4px 6px', borderRadius: 4, background: 'var(--bg)',
              minWidth: 50
            }}>
              <div style={{
                width: '100%', height: Math.max(2, Math.min(80, d.calls / 500)),
                background: 'var(--accent)', borderRadius: 2, opacity: 0.7
              }}/>
              <div style={{ fontSize: 9, color: 'var(--dim)', marginTop: 3 }}>{d.date?.slice(5)}</div>
              <div style={{ fontSize: 9, fontWeight: 600 }}>{d.calls.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
