import { useState, useEffect } from 'react';
import { Shield, Clock, CheckCircle, XCircle } from 'lucide-react';
import { api } from '../lib';

export default function VaultPanel() {
  const [stats, setStats] = useState<any>(null);
  const [safes, setSafes] = useState<any[]>([]);
  const [txns, setTxns] = useState<any[]>([]);
  const [riskRules, setRiskRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/admin/vault/stats').catch(() => null),
      api('/admin/vault/safes').catch(() => []),
      api('/admin/vault/transactions').catch(() => []),
      api('/admin/risk-rules').catch(() => []),
    ]).then(([s, sf, tx, rr]) => {
      setStats(s);
      setSafes(Array.isArray(sf?.items) ? sf.items : Array.isArray(sf) ? sf : []);
      setTxns(Array.isArray(tx?.items) ? tx.items : Array.isArray(tx) ? tx : []);
      setRiskRules(Array.isArray(rr?.items) ? rr.items : Array.isArray(rr) ? rr : []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading Vault...</div>;

  return (
    <div>
      <h1 className="page-title">Vault Panel</h1>
      <p className="page-sub">Multi-sig safes, transactions, risk rules</p>

      <div className="grid-3">
        <Card icon={Shield} label="Safes" value={stats?.safes ?? '—'} />
        <Card icon={Clock} label="Transactions" value={stats?.transactions ?? '—'} />
        <Card icon={CheckCircle} label="Signatures" value={stats?.signatures ?? '—'} />
      </div>

      <Section title="Safes">
        <table className="table">
          <thead><tr><th>Name</th><th>Address</th><th>Chain</th><th>Threshold</th><th>Signers</th></tr></thead>
          <tbody>
            {safes.slice(0, 20).map((s: any) => (
              <tr key={s.id || s.address}>
                <td>{s.name || 'Unnamed'}</td>
                <td className="mono">{s.address?.slice(0,14)}...</td>
                <td>{s.chain || s.chain_id}</td>
                <td>{s.threshold}/{s.signers?.length || '—'}</td>
                <td className="mono">{Array.isArray(s.signers) ? s.signers.length : s.signers_count || '—'}</td>
              </tr>
            ))}
            {safes.length === 0 && <tr><td colSpan={5} className="dim center">No safes</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="Transactions">
        <table className="table">
          <thead><tr><th>Safe</th><th>To</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {txns.slice(0, 20).map((t: any) => (
              <tr key={t.id}>
                <td className="mono">{(t.safe_id || t.safe_address)?.slice(0, 12)}</td>
                <td className="mono">{t.to_address?.slice(0, 12) || '—'}...</td>
                <td>{t.amount || t.value || '—'}</td>
                <td><TxnStatus status={t.status} /></td>
                <td className="dim">{fmtDate(t.created_at)}</td>
              </tr>
            ))}
            {txns.length === 0 && <tr><td colSpan={5} className="dim center">No transactions</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="Risk Rules">
        <table className="table">
          <thead><tr><th>Rule Name</th><th>Type</th><th>Value</th><th>Action</th></tr></thead>
          <tbody>
            {riskRules.slice(0, 20).map((r: any) => (
              <tr key={r.id}>
                <td>{r.name || r.rule_name}</td>
                <td>{r.type || r.rule_type}</td>
                <td className="mono">{r.value || r.rule_value?.slice(0, 20)}</td>
                <td>{r.action || 'block'}</td>
              </tr>
            ))}
            {riskRules.length === 0 && <tr><td colSpan={4} className="dim center">No risk rules</td></tr>}
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

function TxnStatus({ status }: { status: string }) {
  const c = status === 'executed' ? 'var(--green)' : status === 'pending' ? 'var(--accent)' : status === 'rejected' ? 'var(--red)' : 'var(--dim)';
  return <span style={{ color: c, fontSize: 12, fontWeight: 600 }}>{status || 'unknown'}</span>;
}

function fmtDate(d: string | null) { if (!d) return '—'; return new Date(d).toLocaleDateString(); }
