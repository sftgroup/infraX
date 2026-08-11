import { useState, useEffect } from 'react';
import { Server, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { api } from '../lib';

interface ServiceStatus {
  name: string;
  port: number;
  status: 'up' | 'error' | 'down';
}

const STATUS_LABEL: Record<string, string> = {
  up: '● Up',
  error: '◑ Error',
  down: '○ Down',
};
const STATUS_CLASS: Record<string, string> = {
  up: 'green',
  error: 'yellow',
  down: 'red',
};

export default function System() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const d = await api('/admin/status');
      setServices(Array.isArray(d) ? d : []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading...</div>;

  const counts = services.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div>
      <div className="flex-between mb-2">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>System</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle size={12} color="var(--green)" /> {counts.up || 0} up
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={12} color="var(--yellow)" /> {counts.error || 0} error
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <XCircle size={12} color="var(--red)" /> {counts.down || 0} down
            </span>
            <span className="text-dim">15s refresh · GET /health per service</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Service Health</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Service</th><th>Port</th><th>Status</th></tr>
            </thead>
            <tbody>
              {services.length === 0 ? <tr><td colSpan={3} className="empty">No services reported</td></tr> :
                services.map((s, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}><Server size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />{s.name}</td>
                    <td className="mono">:{s.port}</td>
                    <td><span className={`badge ${STATUS_CLASS[s.status] || 'yellow'}`}>{STATUS_LABEL[s.status] || s.status}</span></td>
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
