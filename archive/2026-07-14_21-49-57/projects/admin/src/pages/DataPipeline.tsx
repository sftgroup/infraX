import { useState, useEffect } from 'react';
import { Link, Activity, Webhook, Database } from 'lucide-react';
import { api } from '../lib';

export default function DataPipeline() {
  const [rpcNodes, setRpcNodes] = useState<any[]>([]);
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [okxHealth, setOkxHealth] = useState<any>(null);
  const [sweeps, setSweeps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/admin/rpc').catch(() => []),
      api('/admin/webhooks').catch(() => []),
      api('/admin/sweeps').catch(() => []),
      api('/admin/okx/health').catch(() => null),
    ]).then(([rpc, wh, sw, okx]) => {
      setRpcNodes(Array.isArray(rpc?.items) ? rpc.items : Array.isArray(rpc) ? rpc : []);
      setWebhooks(Array.isArray(wh?.items) ? wh.items : Array.isArray(wh) ? wh : []);
      setSweeps(Array.isArray(sw?.items) ? sw.items : Array.isArray(sw) ? sw : []);
      setOkxHealth(okx);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading Pipeline...</div>;

  return (
    <div>
      <h1 className="page-title">Data Pipeline</h1>
      <p className="page-sub">RPC Pool • OKX ChainOS • Webhooks • Sweeps</p>

      {/* RPC Pool */}
      <Section title="RPC Pool">
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <Card icon={Link} label="Nodes" value={rpcNodes.length} />
          <Card icon={Activity} label="Healthy" value={rpcNodes.filter((n: any) => n.status === 'active' || n.healthy).length} />
        </div>
        <table className="table">
          <thead><tr><th>Chain</th><th>URL</th><th>Weight</th><th>Status</th><th>Latency</th></tr></thead>
          <tbody>
            {rpcNodes.slice(0, 20).map((n: any) => (
              <tr key={n.id}>
                <td className="mono">{n.chain || n.chain_id}</td>
                <td className="mono small">{n.url?.replace(/https?:\/\//, '').slice(0, 30)}</td>
                <td>{n.weight}</td>
                <td><StatusBadge status={n.status || (n.healthy ? 'active' : 'error')} /></td>
                <td>{n.latency_ms ? `${n.latency_ms}ms` : '—'}</td>
              </tr>
            ))}
            {rpcNodes.length === 0 && <tr><td colSpan={5} className="dim center">No RPC nodes</td></tr>}
          </tbody>
        </table>
      </Section>

      {/* OKX ChainOS */}
      <Section title="OKX ChainOS">
        <div>
          <StatusBadge status={okxHealth?.status === 'ok' ? 'active' : 'error'} />
          <span style={{ marginLeft: 8, color: 'var(--dim)' }}>
            {okxHealth?.status === 'ok' ? 'Healthy' : 'Not available'} — last snapshot: {fmtDate(okxHealth?.lastSnapshot?.fetched_at)}
          </span>
        </div>
      </Section>

      {/* Webhooks */}
      <Section title="Webhooks">
        <table className="table">
          <thead><tr><th>URL</th><th>Event</th><th>Status</th><th>Retries</th><th>Last Sent</th></tr></thead>
          <tbody>
            {webhooks.slice(0, 20).map((w: any) => (
              <tr key={w.id}>
                <td className="mono small">{w.url?.slice(0, 40)}</td>
                <td>{w.event_type || w.event}</td>
                <td><StatusBadge status={w.status || (w.active ? 'active' : 'inactive')} /></td>
                <td>{w.retries || 0}</td>
                <td className="dim">{fmtDate(w.last_sent_at || w.updated_at)}</td>
              </tr>
            ))}
            {webhooks.length === 0 && <tr><td colSpan={5} className="dim center">No webhooks</td></tr>}
          </tbody>
        </table>
      </Section>

      {/* Sweeps */}
      <Section title="Sweeps">
        <table className="table">
          <thead><tr><th>From</th><th>To</th><th>Chain</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            {sweeps.slice(0, 20).map((s: any) => (
              <tr key={s.id}>
                <td className="mono">{s.from_address?.slice(0, 12) || '—'}</td>
                <td className="mono">{s.to_address?.slice(0, 12)}...</td>
                <td>{s.chain}</td>
                <td><StatusBadge status={s.status || 'pending'} /></td>
                <td className="dim">{fmtDate(s.created_at)}</td>
              </tr>
            ))}
            {sweeps.length === 0 && <tr><td colSpan={5} className="dim center">No sweeps</td></tr>}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Card({ icon: Icon, label, value }: any) { return <div className="stat-card"><div className="stat-icon"><Icon size={20} /></div><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div>; }
function Section({ title, children }: any) { return <div style={{ marginTop: 24 }}><h3 style={{ marginBottom: 12, color: 'var(--dim)', fontWeight: 600, fontSize: 14 }}>{title}</h3>{children}</div>; }
function StatusBadge({ status }: any) { const c = status === 'active' || status === 'ok' ? 'var(--green)' : status === 'error' ? 'var(--red)' : 'var(--dim)'; return <span style={{ color: c, fontSize: 12, fontWeight: 600 }}>{status || 'unknown'}</span>; }
function fmtDate(d: string | null) { if (!d) return '—'; return new Date(d).toLocaleDateString(); }
