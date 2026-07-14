import { useState, useEffect } from 'react';
import { Server, Database, HardDrive, Cpu } from 'lucide-react';
import { api } from '../lib';

interface SystemInfo { node: string; uptime: number; memory: any; pid: number; db: { connections: number; size: string }; }

export default function System() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/admin/system').then((d: any) => setInfo(d)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading...</div>;
  if (!info) return <div className="empty">Failed to load system info</div>;

  const { memory } = info;
  const heapMB = (memory.heapUsed / 1024 / 1024).toFixed(1);
  const rssMB = (memory.rss / 1024 / 1024).toFixed(1);
  const uptimeHours = Math.floor(info.uptime / 3600);
  const uptimeMins = Math.floor((info.uptime % 3600) / 60);

  return (
    <div>
      <div className="flex-between mb-2">
        <h1 className="page-title">System</h1>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label"><Server size={14} style={{verticalAlign:'middle',marginRight:4}} /> Node.js</div>
          <div className="stat-value" style={{fontSize:20,color:'var(--accent)'}}>{info.node}</div>
          <div className="stat-sub">PID {info.pid}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Cpu size={14} style={{verticalAlign:'middle',marginRight:4}} /> Uptime</div>
          <div className="stat-value" style={{fontSize:20,color:'var(--green)'}}>{uptimeHours}h {uptimeMins}m</div>
          <div className="stat-sub">{Math.floor(info.uptime)}s</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><HardDrive size={14} style={{verticalAlign:'middle',marginRight:4}} /> Memory</div>
          <div className="stat-value" style={{fontSize:20,color:'var(--yellow)'}}>{heapMB}MB</div>
          <div className="stat-sub">RSS {rssMB}MB</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Database size={14} style={{verticalAlign:'middle',marginRight:4}} /> Database</div>
          <div className="stat-value" style={{fontSize:20,color:'var(--purple)'}}>{info.db.connections}</div>
          <div className="stat-sub">{info.db.size} connections</div>
        </div>
      </div>

      <div className="card" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
        <div>
          <div className="card-title" style={{marginBottom:8}}>Process Memory</div>
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            <div className="flex-between"><span className="tooltip">Heap Used</span><span className="mono">{heapMB} MB</span></div>
            <div style={{width:'100%',height:6,background:'var(--border)',borderRadius:3,overflow:'hidden'}}>
              <div style={{width:`${(memory.heapUsed/memory.heapTotal*100).toFixed(0)}%`,height:'100%',background:'var(--accent)',borderRadius:3}} />
            </div>
            <div className="flex-between"><span className="tooltip">Heap Total</span><span className="mono">{(memory.heapTotal/1024/1024).toFixed(1)} MB</span></div>
            <div className="flex-between mt-2"><span className="tooltip">RSS</span><span className="mono">{rssMB} MB</span></div>
            <div className="flex-between"><span className="tooltip">External</span><span className="mono">{(memory.external/1024/1024).toFixed(1)} MB</span></div>
          </div>
        </div>
        <div>
          <div className="card-title" style={{marginBottom:8}}>Database</div>
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            <div className="flex-between"><span className="tooltip">Active Connections</span><span className="mono">{info.db.connections}</span></div>
            <div className="flex-between"><span className="tooltip">Database Size</span><span className="mono">{info.db.size}</span></div>
            <div className="flex-between mt-2"><span className="tooltip">Node Version</span><span className="mono">{info.node}</span></div>
            <div className="flex-between"><span className="tooltip">Process ID</span><span className="mono">{info.pid}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
