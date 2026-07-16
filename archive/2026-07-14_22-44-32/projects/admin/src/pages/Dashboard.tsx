import { useState, useEffect, useCallback } from 'react';
import { Activity, Database, Link, Zap } from 'lucide-react';
import { api } from '../lib';

interface ChainHourly { total: number; latest_block: number; checkpoint: number; status: string; }
interface ScannerCollector { chain: string; status: string; error: string | null; }
interface CollectorHealth { running: boolean; active?: boolean; symbols?: number; wsConnected?: boolean; accounts?: number; chains?: number; }
interface DashboardData {
  scanner: { collectors: ScannerCollector[]; endpoints: number };
  storage: { totalRows: number; newestBlock: number };
  hourly: Record<string, ChainHourly>;
  binance?: CollectorHealth;
  okx?: CollectorHealth;
}

const CHAINS = ['sepolia','ethereum','polygon','arbitrum','optimism','bsc','base'];
const CHAIN_NAMES: Record<string,string> = { sepolia:'Sepolia', ethereum:'Ethereum', polygon:'Polygon', arbitrum:'Arbitrum', optimism:'Optimism', bsc:'BSC', base:'Base' };

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [ts, setTs] = useState(new Date());

  const fetchData = useCallback(async () => {
    try {
      const d = await api('/admin/dashboard');
      setData(d as DashboardData);
      setTs(new Date());
    } catch {}
  }, []);

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 8000); return () => clearInterval(t); }, [fetchData]);

  if (!data) return <div className="loading"><span className="spin" />Loading dashboard...</div>;

  const { scanner, storage, hourly, binance, okx } = data;
  const collectors = scanner.collectors || [];
  // activeChains: chains that are collecting data (have checkpoint progress)
  const activeChains = Object.values(hourly).filter(h => h.checkpoint > 0 && h.latest_block > 0).length;
  const totalEvents = storage.totalRows;
  const endpoints = scanner.endpoints;

  return (
    <div>
      <div className="flex-between mb-2">
        <h1 className="page-title">Dashboard</h1>
        <span className="tooltip">Auto-refresh 8s · Updated {ts.toLocaleTimeString()}</span>
      </div>

      {/* Stats Row */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label"><Activity size={14} style={{verticalAlign:'middle',marginRight:4}} /> Events</div>
          <div className="stat-value" style={{color:'var(--accent)'}}>{totalEvents.toLocaleString()}</div>
          <div className="stat-sub">total collected</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Zap size={14} style={{verticalAlign:'middle',marginRight:4}} /> Chains</div>
          <div className="stat-value" style={{color:'var(--green)'}}>{activeChains}/7</div>
          <div className="stat-sub">scanning</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Link size={14} style={{verticalAlign:'middle',marginRight:4}} /> Endpoints</div>
          <div className="stat-value" style={{color:'var(--purple)'}}>{endpoints}</div>
          <div className="stat-sub">RPC pool</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Database size={14} style={{verticalAlign:'middle',marginRight:4}} /> Latest Block</div>
          <div className="stat-value" style={{color:'var(--teal)',fontSize:20}}>{storage.newestBlock.toLocaleString()}</div>
          <div className="stat-sub">across all chains</div>
        </div>
      </div>

      {/* Collector Status Cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Binance Futures</div>
          <div className="stat-value" style={{ fontSize: 16, color: binance?.running ? 'var(--green)' : 'var(--red)' }}>
            <span className={`pulse ${binance?.running ? 'green' : 'red'}`} />
            {binance?.running ? 'Healthy' : 'Stopped'}
          </div>
          <div className="stat-sub">{binance?.symbols ?? 0} symbols · {binance?.wsConnected ? 'WebSocket' : 'REST'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">OKX ChainOS</div>
          <div className="stat-value" style={{ fontSize: 16, color: okx?.active ? 'var(--green)' : okx?.running ? 'var(--yellow)' : 'var(--red)' }}>
            <span className={`pulse ${okx?.active ? 'green' : okx?.running ? 'yellow' : 'red'}`} />
            {okx?.active ? 'Healthy' : okx?.running ? 'No API Key' : 'Stopped'}
          </div>
          <div className="stat-sub">{okx?.accounts ?? 0} accounts · {okx?.active ? `${okx?.chains ?? 0} chains` : 'add key in OKX Accounts'}</div>
        </div>
      </div>

      {/* Chain Cards */}
      <div className="card">
        <div className="card-title" style={{marginBottom:12}}>Chain Overview</div>
        <div className="chain-grid">
          {CHAINS.map(c => {
            const h = hourly[c] || { total: 0, latest_block: 0, checkpoint: 0, status: 'idle' };
            const hasData = h.total > 0;
            return (
              <div key={c} className={`chain-card ${hasData ? 'active' : ''}`}>
                <div className="chain-name">{CHAIN_NAMES[c] || c}</div>
                <div className="chain-count">{h.total.toLocaleString()}</div>
                <div className="chain-info">
                  <span>blk {h.latest_block?.toLocaleString() || '-'}</span>
                  <span>{h.status === 'running' ? <span className="pulse green" /> : <span className="pulse yellow" />}</span>
                </div>
                <div className="chain-bar">
                  <div className={`chain-bar-fill ${hasData ? 'active' : ''}`} style={{width: hasData ? '100%' : '0%'}} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Scanner Health */}
      <div className="card">
        <div className="card-title">Scanner Health</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Chain</th><th>Status</th><th>Current Block</th><th>Checkpoint</th><th>Lag</th><th>Events/hr</th><th>Error</th>
              </tr>
            </thead>
            <tbody>
              {collectors.map((co: ScannerCollector) => {
                const h = hourly[co.chain] || { total: 0, latest_block: 0, checkpoint: 0 };
                const lag = h.latest_block && h.checkpoint ? Math.max(0, h.latest_block - h.checkpoint) : '-';
                const statusColor = co.status === 'scanning' ? 'badge-green' : co.status === 'idle' ? 'badge-yellow' : 'badge-red';
                return (
                  <tr key={co.chain}>
                    <td style={{fontWeight:600}}>{CHAIN_NAMES[co.chain] || co.chain}</td>
                    <td><span className={`badge ${statusColor}`}>{co.status}</span></td>
                    <td className="mono">{h.latest_block?.toLocaleString() || '-'}</td>
                    <td className="mono">{h.checkpoint?.toLocaleString() || '0'}</td>
                    <td className="mono">{lag}</td>
                    <td>{h.total?.toLocaleString()}</td>
                    <td className="mono truncate" title={co.error||''} style={{maxWidth:250,color:'var(--red)'}}>{co.error?.slice(0,60) || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
