import { useState, useEffect } from 'react';
import { Key, Mail, Wallet, Shield } from 'lucide-react';
import { api } from '../lib';

export default function MpcPanel() {
  const [stats, setStats] = useState<any>(null);
  const [wallets, setWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/admin/mpc/stats').catch(() => null),
      api('/admin/mpc/wallets').catch(() => []),
    ]).then(([s, w]) => {
      setStats(s);
      setWallets(Array.isArray(w?.items) ? w.items : Array.isArray(w) ? w : []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading MPC...</div>;

  return (
    <div>
      <h1 className="page-title">MPC Panel</h1>
      <p className="page-sub">Key shard wallet management</p>

      <div className="grid-3">
        <Card icon={Wallet} label="Total Wallets" value={stats?.total ?? '—'} />
        <Card icon={Key} label="Active" value={stats?.registered ?? '—'} />
        <Card icon={Shield} label="Recovered" value={stats?.recovered ?? '—'} />
      </div>

      <Section title="Wallets">
        <table className="table">
          <thead><tr><th>Email</th><th>Address</th><th>Shards</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {wallets.slice(0, 20).map((w: any) => (
              <tr key={w.id}>
                <td className="mono">{w.email}</td>
                <td className="mono">{w.wallet_address?.slice(0,14)}...</td>
                <td>{w.shard_count}/{w.total_shards}</td>
                <td><StatusBadge status={w.status} /></td>
                <td className="dim">{fmtDate(w.created_at)}</td>
              </tr>
            ))}
            {wallets.length === 0 && <tr><td colSpan={5} className="dim center">No wallets</td></tr>}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Card({ icon: Icon, label, value }: any) { return <div className="stat-card"><div className="stat-icon"><Icon size={20} /></div><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div>; }
function Section({ title, children }: any) { return <div style={{ marginTop: 24 }}><h3 style={{ marginBottom: 12, color: 'var(--dim)', fontWeight: 600, fontSize: 14 }}>{title}</h3>{children}</div>; }
function StatusBadge({ status }: any) { const c = status === 'active' ? 'var(--green)' : 'var(--dim)'; return <span style={{ color: c, fontSize: 12, fontWeight: 600 }}>{status}</span>; }
function fmtDate(d: string | null) { if (!d) return '—'; return new Date(d).toLocaleDateString(); }
