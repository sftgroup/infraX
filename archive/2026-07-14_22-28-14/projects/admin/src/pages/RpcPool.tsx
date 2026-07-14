import { useState, useEffect } from 'react';
import { Plus, Trash2, CheckCircle, AlertTriangle, XCircle, Loader } from 'lucide-react';
import { api } from '../lib';

interface RpcEndpoint {
  chain: string;
  endpoint_key: string;
  provider: string;
  url: string;
  enabled: boolean;
  tier: string;
  rpm: number | string;
  source: 'env' | 'db';
  _readonly: boolean;
  status?: string;
  tokens?: { remaining: number; resetAt: number };
}

const CHAIN_NAMES: Record<string, string> = {
  ethereum: 'Ethereum', polygon: 'Polygon', arbitrum: 'Arbitrum',
  optimism: 'Optimism', bsc: 'BSC', base: 'Base', sepolia: 'Sepolia',
};
const CHAINS = Object.keys(CHAIN_NAMES);

interface ProviderTemplate { name: string; shortName: string; urlTemplate: string; rpm: number; rpd: number; tier: string; description: string }

const PROVIDERS: ProviderTemplate[] = [
  { name: 'Infura', shortName: 'infura', urlTemplate: 'https://{CHAIN}.infura.io/v3/{KEY}', rpm: 300, rpd: 100_000, tier: 'free', description: 'Free: 100k req/day. Sign up at infura.io' },
  { name: 'Alchemy', shortName: 'alchemy', urlTemplate: 'https://{CHAIN}.g.alchemy.com/v2/{KEY}', rpm: 330, rpd: 300_000, tier: 'free', description: 'Free: 300M CU/month, 330 req/s. Sign up at alchemy.com' },
  { name: 'QuickNode', shortName: 'quicknode', urlTemplate: 'https://REPLACE-ME.{CHAIN}.quiknode.pro/{KEY}/', rpm: 300, rpd: 100_000, tier: 'free', description: 'Free: 10M credits/month. Sign up at quicknode.com' },
  { name: 'BlastAPI', shortName: 'blastapi', urlTemplate: 'https://{CHAIN}.blastapi.io/{KEY}', rpm: 100, rpd: 12_000, tier: 'free', description: 'Free: 12k req/day. Sign up at blastapi.io' },
  { name: 'Tenderly', shortName: 'tenderly', urlTemplate: 'https://{CHAIN}.gateway.tenderly.co/{KEY}', rpm: 60, rpd: 5_000, tier: 'free', description: 'Free: testnets + mainnet fork. Sign up at tenderly.co' },
  { name: 'Ankr', shortName: 'ankr', urlTemplate: 'https://rpc.ankr.com/{CHAIN}/{KEY}', rpm: 100, rpd: 50_000, tier: 'free', description: 'Free: 100 req/s. Sign up at ankr.com' },
  { name: '1RPC', shortName: '1rpc', urlTemplate: 'https://1rpc.io/{KEY}/{CHAIN}', rpm: 60, rpd: 10_000, tier: 'free', description: 'Free: 10k/day. Sign up at 1rpc.io (privacy-focused)' },
  { name: 'DRPC', shortName: 'drpc', urlTemplate: 'https://lb.drpc.org/ogrpc?network={CHAIN}&dkey={KEY}', rpm: 60, rpd: 10_000, tier: 'free', description: 'Free: 10k/day. Sign up at drpc.org' },
  { name: 'Custom', shortName: 'custom', urlTemplate: '', rpm: 60, rpd: 10_000, tier: 'free', description: 'Enter any HTTP RPC endpoint URL' },
];

const CHAIN_ALIAS: Record<string, Record<string, string>> = {
  ethereum:   { default: 'eth-mainnet', infura: 'mainnet', alchemy: 'eth-mainnet', blastapi: 'eth-mainnet', tenderly: 'mainnet', quicknode: 'eth-mainnet' },
  polygon:    { default: 'polygon-mainnet', infura: 'polygon-mainnet', alchemy: 'polygon-mainnet', blastapi: 'polygon-mainnet' },
  arbitrum:   { default: 'arbitrum-mainnet', infura: 'arbitrum-mainnet', alchemy: 'arbitrum-mainnet', blastapi: 'arbitrum-mainnet' },
  optimism:   { default: 'optimism-mainnet', infura: 'optimism-mainnet', alchemy: 'optimism-mainnet', blastapi: 'optimism-mainnet' },
  bsc:        { default: 'bnb-mainnet', alchemy: 'bnb-mainnet', blastapi: 'bsc-mainnet' },
  base:       { default: 'base-mainnet', alchemy: 'base-mainnet', blastapi: 'base-mainnet' },
  sepolia:    { default: 'eth-sepolia', infura: 'sepolia', alchemy: 'eth-sepolia', blastapi: 'eth-sepolia' },
};

function getChainAlias(chain: string, provider: string): string {
  const aliases = CHAIN_ALIAS[chain] || { default: chain };
  return aliases[provider] || aliases['default'] || chain;
}

function HealthIcon({ status }: { status: string | undefined }) {
  if (!status) return <Loader size={14} className="spin" />;
  switch (status) {
    case 'healthy': return <CheckCircle size={14} color="var(--green)" />;
    case 'degraded': return <AlertTriangle size={14} color="var(--yellow)" />;
    case 'down': return <XCircle size={14} color="var(--red)" />;
    default: return <Loader size={14} className="spin" />;
  }
}

function HealthBadge({ status }: { status: string | undefined }) {
  const color = status === 'healthy' ? 'badge-green' : status === 'degraded' ? 'badge-yellow' : 'badge-red';
  const label = status === 'healthy' ? '● Healthy' : status === 'degraded' ? '◑ Degraded' : status === 'down' ? '○ Down' : '… Unknown';
  return <span className={`badge ${color}`}>{label}</span>;
}

export default function RpcPool() {
  const [eps, setEps] = useState<RpcEndpoint[]>([]);
  const [healthSummary, setHealthSummary] = useState<{ total: number; healthy: number; degraded: number; down: number }>({ total: 0, healthy: 0, degraded: 0, down: 0 });
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newChain, setNewChain] = useState('ethereum');
  const [selProvider, setSelProvider] = useState(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [msg, setMsg] = useState('');

  const previewUrl = selProvider.shortName === 'custom'
    ? customUrl
    : selProvider.urlTemplate.replace('{CHAIN}', getChainAlias(newChain, selProvider.shortName)).replace('{KEY}', apiKey || 'YOUR-API-KEY');

  const load = async () => {
    try {
      const [epsD, healthD] = await Promise.all([
        api('/admin/rpc-endpoints'),
        api('/admin/rpc-health'),
      ]);
      const epList: RpcEndpoint[] = epsD || [];
      const hReport: any[] = healthD?.report || [];
      // Merge health by URL
      const hMap: Record<string, any> = {};
      for (const h of hReport) { hMap[h.url] = h; }
      const merged = (Array.isArray(epList) ? epList : []).map((ep: RpcEndpoint) => {
        const h = hMap[ep.url];
        return h ? { ...ep, status: h.status, tokens: h.tokens } : ep;
      });
      setEps(merged);
      setHealthSummary(healthD?.summary || { total: 0, healthy: 0, degraded: 0, down: 0 });
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const add = async () => {
    const url = selProvider.shortName === 'custom' ? customUrl.trim() : previewUrl;
    if (!url || url.includes('YOUR-API-KEY') || url.includes('REPLACE-ME')) {
      setMsg('Please fill in your API key or URL'); setTimeout(() => setMsg(''), 3000); return;
    }
    try {
      await api('/admin/rpc-endpoint', {
        method: 'POST',
        body: JSON.stringify({
          chain: newChain, provider: selProvider.shortName,
          key: `${selProvider.shortName}-${Date.now()}`, url,
          tier: selProvider.tier, rpm: selProvider.rpm, rpd: selProvider.rpd,
        }),
      });
      setApiKey(''); setCustomUrl(''); setShowAdd(false);
      setMsg(`${selProvider.name} endpoint added`); setTimeout(() => setMsg(''), 2500);
      load();
    } catch (e: any) { setMsg(e.message); setTimeout(() => setMsg(''), 3000); }
  };

  const toggle = async (ep: RpcEndpoint) => {
    if (ep._readonly) return;
    await api(`/admin/rpc-endpoint/${ep.chain}/${ep.endpoint_key}/toggle`, { method: 'PATCH' });
    load();
  };

  const remove = async (ep: RpcEndpoint) => {
    if (ep._readonly) return;
    if (!confirm(`Delete ${ep.chain}/${ep.endpoint_key}?`)) return;
    await api(`/admin/rpc-endpoint/${ep.chain}/${ep.endpoint_key}`, { method: 'DELETE' });
    load();
  };

  const envCount = eps.filter(e => e.source === 'env').length;
  const dbCount = eps.filter(e => e.source === 'db').length;

  if (loading) return <div className="loading"><span className="spin" />Loading...</div>;

  return (
    <div>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>RPC Pool</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
            <span className="text-dim">{envCount} env · {dbCount} DB · {eps.length} total</span>
            <span style={{ color: 'var(--dim)' }}>|</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle size={12} color="var(--green)" /> {healthSummary.healthy}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={12} color="var(--yellow)" /> {healthSummary.degraded}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <XCircle size={12} color="var(--red)" /> {healthSummary.down}
            </span>
            <span className="text-dim">15s refresh</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {msg && <span className="tooltip">{msg}</span>}
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus size={14} /> Add Endpoint
          </button>
        </div>
      </div>

      {/* Health overview bar */}
      <div className="card" style={{ marginBottom: 16, padding: '10px 16px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--dim)' }}>
          🔍 Load Balancing: <span style={{ color: '#e5e7eb' }}>Round-Robin</span>
          <span style={{ color: 'var(--dim)', fontSize: 11, marginLeft: 8 }}>
            — each scan cycle picks the next healthy endpoint for that chain
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {CHAINS.map(chain => {
            const chainEps = eps.filter(e => e.chain === chain);
            const active = chainEps.filter(e => e.status === 'healthy').length;
            return (
              <div key={chain} style={{
                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                background: 'var(--surface)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <span style={{ fontWeight: 600 }}>{CHAIN_NAMES[chain]}</span>
                <span style={{ color: active > 0 ? 'var(--green)' : 'var(--red)' }}>
                  {active}/{chainEps.length} healthy
                </span>
              </div>
            );
          })}
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
              <label className="form-label">Provider</label>
              <select className="form-select" value={selProvider.shortName}
                onChange={e => setSelProvider(PROVIDERS.find(p => p.shortName === e.target.value) || PROVIDERS[0])}>
                {PROVIDERS.map(p => <option key={p.shortName} value={p.shortName}>{p.name}{p.tier === 'free' ? ' (free)' : ''}</option>)}
              </select>
            </div>
          </div>

          {selProvider.shortName !== 'custom' && (
            <div style={{ background: 'var(--surface)', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: 'var(--dim)', border: '1px solid var(--border)' }}>
              📋 Template: <code style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{selProvider.urlTemplate}</code><br />
              💡 {selProvider.description}
            </div>
          )}

          {selProvider.shortName !== 'custom' ? (
            <div style={{ marginBottom: 12 }}>
              <label className="form-label">API Key</label>
              <input className="form-input" value={apiKey} onChange={e => setApiKey(e.target.value)}
                placeholder="Paste your API key here..." onKeyDown={e => e.key === 'Enter' && add()} autoFocus />
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <label className="form-label">RPC URL</label>
              <input className="form-input" value={customUrl} onChange={e => setCustomUrl(e.target.value)}
                placeholder="https://..." onKeyDown={e => e.key === 'Enter' && add()} autoFocus />
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label className="form-label">URL Preview</label>
            <input className="form-input" value={previewUrl} readOnly
              style={{ background: 'var(--surface)', opacity: previewUrl.includes('YOUR-API-KEY') || previewUrl.includes('REPLACE-ME') ? 0.5 : 1 }} />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={add}><Plus size={14} /> Add {selProvider.name} Endpoint</button>
            <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">Endpoints ({eps.length})</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Health</th><th>Chain</th><th>Key</th><th>Provider</th><th>URL</th>
                <th>Tier</th><th>RPM</th><th>Source</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {eps.length === 0 ? <tr><td colSpan={9} className="empty">No endpoints configured</td></tr> :
                eps.map((e, i) => (
                  <tr key={i} style={{ opacity: e.status === 'down' ? 0.5 : 1 }}>
                    <td style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <HealthIcon status={e.status} />
                      <HealthBadge status={e.status} />
                    </td>
                    <td style={{ fontWeight: 600 }}>{CHAIN_NAMES[e.chain] || e.chain}</td>
                    <td className="mono">{e.endpoint_key}</td>
                    <td><span className="badge badge-blue">{e.provider}</span></td>
                    <td className="mono truncate" title={e.url}>{e.url}</td>
                    <td><span className="badge badge-purple">{e.tier}</span></td>
                    <td className="mono">{e.rpm || '-'}</td>
                    <td>
                      <span className={e.source === 'env' ? 'badge badge-orange' : 'badge badge-blue'}>
                        {e.source === 'env' ? 'ENV' : 'DB'}
                      </span>
                    </td>
                    <td>
                      {e._readonly ? (
                        <span className="text-dim" style={{ fontSize: 11 }}>read-only</span>
                      ) : (
                        <>
                          <button className="btn btn-secondary btn-xs" onClick={() => toggle(e)} style={{ marginRight: 4 }}>Toggle</button>
                          <button className="btn btn-danger btn-xs" onClick={() => remove(e)}><Trash2 size={12} /></button>
                        </>
                      )}
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
