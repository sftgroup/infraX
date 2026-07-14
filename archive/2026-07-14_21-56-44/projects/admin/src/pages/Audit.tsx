import { useState, useEffect } from 'react';
import { api } from '../lib';

interface AuditLog { id: string; user_id: string; username: string; action: string; resource: string; detail: any; ip_address: string; created_at: string; }

export default function Audit() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/admin/audit?limit=200').then((d: any) => setLogs(d?.data || d || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading...</div>;

  const actionBadge = (a: string) => {
    const map: Record<string,string> = { 'user.create':'badge-green','user.update':'badge-yellow','user.delete':'badge-red' };
    return map[a] || 'badge-blue';
  };

  return (
    <div>
      <div className="flex-between mb-2">
        <h1 className="page-title">Audit Log</h1>
        <span className="tooltip">{logs.length} entries</span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Time</th><th>User</th><th>Action</th><th>Resource</th><th>Details</th><th>IP</th></tr>
            </thead>
            <tbody>
              {logs.length === 0 ? <tr><td colSpan={6} className="empty">No audit logs yet</td></tr> :
                logs.map(l => (
                  <tr key={l.id}>
                    <td className="mono">{new Date(l.created_at).toISOString().slice(0,19)}</td>
                    <td>{l.username || l.user_id?.slice(0,8)}</td>
                    <td><span className={`badge ${actionBadge(l.action)}`}>{l.action}</span></td>
                    <td className="mono">{l.resource}</td>
                    <td className="mono truncate" style={{maxWidth:200}} title={JSON.stringify(l.detail)}>{JSON.stringify(l.detail)}</td>
                    <td className="mono">{l.ip_address || '—'}</td>
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
