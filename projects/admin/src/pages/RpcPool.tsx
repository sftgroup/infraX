import { useState, useEffect } from 'react';
import { Plus, Trash2, Power } from 'lucide-react';
import { api } from '../lib';

interface RpcConfig {
  id: number;
  chain: string;
  url: string;
  priority: number;
  enabled: boolean;
}

const CHAIN_NAMES: Record<string, string> = {
  ethereum: 'Ethereum', bsc: 'BSC', base: 'Base', sepolia: 'Sepolia',
  oxachain: 'OxaChain', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon',
};
const CHAINS = Object.keys(CHAIN_NAMES);

export default function RpcPool() {
  const [eps, setEps] = useState<RpcConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newChain, setNewChain] = useState('ethereum');
  const [url, setUrl] = useState('');
  const [priority, setPriority] = useState('99');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try { const d = await api('/admin/rpc'); setEps(d || []); } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    const trimmed = url.trim();
    if (!trimmed || !trimmed.startsWith('http')) {
      setMsg('Please enter a valid http(s) RPC URL'); setTimeout(() => setMsg(''), 3000); return;
    }
    try {
      await api('/admin/rpc', {
        method: 'POST',
        body: JSON.stringify({ chain: newChain, url: trimmed, priority: parseInt(priority) || 99, enabled: true }),
      });
      setUrl(''); setShowAdd(false);
      setMsg('RPC endpoint added'); setTimeout(() => setMsg(''), 2500);
      load();
    } catch (e: any) { setMsg(e.message); setTimeout(() => setMsg(''), 3000); }
  };

  const toggle = async (ep: RpcConfig) => {
    await api(`/admin/rpc/${ep.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !ep.enabled }) });
    load();
  };

  const remove = async (ep: RpcConfig) => {
    if (!confirm(`Delete RPC endpoint ${ep.chain} #${ep.id}?`)) return;
    try {
      await api(`/admin/rpc/${ep.id}`, { method: 'DELETE' });
      load();
    } catch (e: any) { setMsg(e.message); setTimeout(() => setMsg(''), 3000); }
  };

  if (loading) return <div className="loading"><span className="spin" />Loading...</div>;

  return (
    <div>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>RPC Pool</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
            <span className="text-dim">{eps.length} endpoints · {eps.filter(e => e.enabled).length} enabled</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {msg && <span className="tooltip">{msg}</span>}
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus size={14} /> Add Endpoint
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">Add RPC Endpoint</div>
          <div className="form-row" style={{ marginBottom: 12 }}>
            <div>
              <label className="form-label">Chain</label>
              <select className="form-select" value={newChain} onChange={e => setNewChain(e.target.value)}>
                {CHAINS.map(c => <option key={c} value={c}>{CHAIN_NAMES[c]}</option>)}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <label className="form-label">Priority</label>
              <input className="form-input" type="number" value={priority} onChange={e => setPriority(e.target.value)}
                style={{ maxWidth: 120 }} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="form-label">RPC URL</label>
            <input className="form-input" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://..." onKeyDown={e => e.key === 'Enter' && add()} autoFocus />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={add}><Plus size={14} /> Add Endpoint</button>
            <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">Endpoints ({eps.length})</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Chain</th><th>URL</th><th>Priority</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {eps.length === 0 ? <tr><td colSpan={5} className="empty">No endpoints configured</td></tr> :
                eps.map(e => (
                  <tr key={e.id} style={{ opacity: e.enabled ? 1 : 0.5 }}>
                    <td style={{ fontWeight: 600 }}>{CHAIN_NAMES[e.chain] || e.chain}</td>
                    <td className="mono truncate" title={e.url}>{e.url}</td>
                    <td className="mono">{e.priority}</td>
                    <td><span className={`badge ${e.enabled ? 'green' : 'yellow'}`}>{e.enabled ? 'enabled' : 'disabled'}</span></td>
                    <td>
                      <button className="btn btn-secondary btn-xs" onClick={() => toggle(e)} style={{ marginRight: 4 }}>
                        <Power size={12} /> {e.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn btn-danger btn-xs" onClick={() => remove(e)}><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
