import { useState, useEffect } from 'react';
import { Wallet, Users, Activity, Zap, TrendingUp, Key } from 'lucide-react';
import { api } from '../lib';

export default function WaasPanel() {
  const [stats, setStats] = useState<any>(null);
  const [tenants, setTenants] = useState<any[]>([]);
  const [subs, setSubs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/admin/waas/stats').catch(() => null),
      api('/admin/tenants').catch(() => []),
      api('/admin/waas/subscriptions').catch(() => []),
    ]).then(([s, t, sub]) => {
      setStats(s);
      setTenants(Array.isArray(t?.items) ? t.items : Array.isArray(t) ? t : []);
      setSubs(Array.isArray(sub?.items) ? sub.items : Array.isArray(sub) ? sub : []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading WAAS...</div>;

  return (
    <div>
      <h1 className="page-title">WAAS Panel</h1>
      <p className="page-sub">Wallet-as-a-Service — Users, wallets, subscriptions</p>

      <div className="grid-4">
        <Card icon={Users} label="Users" value={stats?.users ?? '—'} />
        <Card icon={Wallet} label="Wallets" value={stats?.wallets ?? '—'} />
        <Card icon={Activity} label="Transactions" value={stats?.transactions ?? '—'} />
        <Card icon={Zap} label="Active Subs" value={stats?.activeSubs ?? '—'} />
      </div>

      <Section title="Tenants">
        <table className="table">
          <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Plan</th><th>Created</th></tr></thead>
          <tbody>
            {tenants.slice(0, 20).map((t: any) => (
              <tr key={t.id}>
                <td className="mono">{t.id?.slice(0,12)}</td>
                <td>{t.name}</td>
                <td><StatusBadge status={t.status} /></td>
                <td>{t.data_plan_id || t.plan_id || 'free'}</td>
                <td className="dim">{fmtDate(t.created_at)}</td>
              </tr>
            ))}
            {tenants.length === 0 && <tr><td colSpan={5} className="dim center">No tenants</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="Subscriptions">
        <table className="table">
          <thead><tr><th>User</th><th>Plan</th><th>Cycle</th><th>Status</th><th>Since</th></tr></thead>
          <tbody>
            {subs.slice(0, 20).map((s: any) => (
              <tr key={s.id}>
                <td className="mono">{s.user_id?.slice(0,12) || '—'}</td>
                <td>{s.plan_name || s.plan_id}</td>
                <td>{s.billing_cycle || 'monthly'}</td>
                <td><StatusBadge status={s.status} /></td>
                <td className="dim">{fmtDate(s.created_at)}</td>
              </tr>
            ))}
            {subs.length === 0 && <tr><td colSpan={5} className="dim center">No subscriptions</td></tr>}
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
  const color = status === 'active' ? 'var(--green)' : status === 'trial' ? 'var(--accent)' : 'var(--red)';
  return <span style={{ color, fontSize: 12, fontWeight: 600 }}>{status || 'unknown'}</span>;
}

function fmtDate(d: string | null) { if (!d) return '—'; return new Date(d).toLocaleDateString(); }
