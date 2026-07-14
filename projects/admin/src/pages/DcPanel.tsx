import { useState, useEffect } from 'react';
import { Activity, Database, Server, Cpu } from 'lucide-react';
import { api } from '../lib';

export default function DcPanel() {
  const [stats, setStats] = useState<any>(null);
  const [subs, setSubs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/admin/dc/stats').catch(() => null),
      api('/admin/dc/subscriptions').catch(() => []),
    ]).then(([s, sub]) => {
      setStats(s);
      setSubs(Array.isArray(sub?.items) ? sub.items : Array.isArray(sub) ? sub : []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading DC...</div>;

  return (
    <div>
      <h1 className="page-title">Data Center Panel</h1>
      <p className="page-sub">On-chain data subscription, events, checkpoints</p>

      <div className="grid-4">
        <Card icon={Activity} label="Total Events" value={stats?.totalEvents?.toLocaleString() ?? '—'} />
        <Card icon={Database} label="Checkpoints" value={stats?.checkpoints?.length ?? '—'} />
        <Card icon={Server} label="Subscriptions" value={stats?.totalSubs ?? '—'} />
        <Card icon={Cpu} label="Tokens" value={stats?.totalTokens ?? '—'} />
      </div>

      <Section title="Collector Checkpoints">
        <table className="table">
          <thead><tr><th>Chain</th><th>Collector</th><th>Last Block</th><th>Status</th><th>Last Fetch</th></tr></thead>
          <tbody>
            {(stats?.checkpoints || []).slice(0, 20).map((c: any) => (
              <tr key={c.chain + c.collector_name}>
                <td className="mono">{c.chain}</td>
                <td>{c.collector_name}</td>
                <td className="mono">{c.last_block?.toLocaleString()}</td>
                <td><StatusBadge status={c.status} /></td>
                <td className="dim">{fmtDate(c.last_fetch_at)}</td>
              </tr>
            ))}
            {(stats?.checkpoints || []).length === 0 && <tr><td colSpan={5} className="dim center">No checkpoints</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="DC Subscriptions">
        <table className="table">
          <thead><tr><th>Tenant</th><th>Plan</th><th>API Calls</th><th>Status</th></tr></thead>
          <tbody>
            {subs.slice(0, 20).map((s: any) => (
              <tr key={s.id || s.tenant_id}>
                <td className="mono">{(s.tenant_id || s.id)?.slice(0, 12)}</td>
                <td>{s.data_plan_id || s.plan_id || 'free'}</td>
                <td>{(s.api_calls || 0).toLocaleString()}</td>
                <td><StatusBadge status={s.status || 'active'} /></td>
              </tr>
            ))}
            {subs.length === 0 && <tr><td colSpan={4} className="dim center">No subscriptions</td></tr>}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Card({ icon: Icon, label, value }: { icon: any; label: string; value: any }) {
  return (
    <div className="stat-card">
      <div className="stat-icon"><Icon size={20} /></div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 12, color: 'var(--dim)', fontWeight: 600, fontSize: 14 }}>{title}</h3>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'active' || status === 'ok' ? 'var(--green)' : status === 'error' ? 'var(--red)' : 'var(--accent)';
  return <span style={{ color, fontSize: 12, fontWeight: 600 }}>{status || 'unknown'}</span>;
}

function fmtDate(d: string | null) { if (!d) return '—'; return new Date(d).toLocaleDateString(); }
