import { useState, useEffect } from 'react';
import { Settings, Save } from 'lucide-react';
import { api } from '../lib';

export default function SettingsPage() {
  const [data, setData] = useState<any>({ tokens: [], chains: [], feeConfigs: [] });
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try { const d = await api('/admin/settings'); setData(d); } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div className="loading"><span className="spin"/> Loading...</div>;

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>⚙️ Settings</h2>

      <div className="card">
        <h3>🔗 Chains</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          {data.chains.map((c: any) => (
            <div key={c.id} className="chain-card">
              <div className="name">{c.display_name || c.chain_id}</div>
              <div style={{ fontSize: 12 }}>Chain ID: {c.chain_id}</div>
              <div style={{ fontSize: 12, color: 'var(--dim)' }}>Block time: {c.block_time_seconds}s</div>
              <span className={`badge ${c.enabled ? 'green' : 'red'}`}>{c.enabled ? 'enabled' : 'disabled'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>🪙 Tokens</h3>
        <table>
          <thead><tr><th>Symbol</th><th>Name</th><th>Decimals</th><th>Contract</th><th>Chain</th><th>Type</th><th>Min Withdraw</th><th>Max Withdraw</th></tr></thead>
          <tbody>
            {data.tokens.map((t: any) => (
              <tr key={t.id}>
                <td><strong>{t.symbol}</strong></td>
                <td>{t.name || '-'}</td>
                <td>{t.decimals}</td>
                <td className="mono" style={{ fontSize: 11 }}>{t.contract_address ? t.contract_address.slice(0,8)+'...' : 'native'}</td>
                <td>{t.chain_id}</td>
                <td><span className="badge blue">{t.token_type}</span></td>
                <td>{t.min_withdraw}</td>
                <td>{t.max_withdraw}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.feeConfigs?.length > 0 && (
        <div className="card">
          <h3>💰 Fee Configs</h3>
          <table>
            <thead><tr><th>Token</th><th>Type</th><th>Value</th><th>Min Fee</th><th>Max Fee</th></tr></thead>
            <tbody>
              {data.feeConfigs.map((f: any) => (
                <tr key={f.id}>
                  <td>{f.symbol || f.token_id?.slice(0,8)}</td>
                  <td>{f.fee_type}</td>
                  <td>{f.fee_value}</td>
                  <td>{f.min_fee}</td>
                  <td>{f.max_fee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
