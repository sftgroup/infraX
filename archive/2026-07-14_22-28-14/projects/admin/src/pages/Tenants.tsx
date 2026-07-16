import { useState, useEffect } from 'react';
import { Building, DollarSign } from 'lucide-react';
import { api } from '../lib';

interface Tenant {
  id: string; name: string; contact_email: string; status: string;
  webhook_url: string; sweep_address: string; sweep_threshold: number;
  review_mode: string; addresses: number; withdrawals: number; created_at: string;
}

export default function Tenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = async () => {
    try { const d = await api('/admin/tenants'); setTenants(d || []); } catch {} finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openDetail = async (id: string) => {
    setDetailId(id);
    try { const d = await api(`/admin/tenants/${id}`); setDetail(d); } catch {}
  };

  const patch = async (id: string, body: any) => {
    await api(`/admin/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    load(); if (detailId === id) openDetail(id);
  };

  if (loading) return <div className="loading"><span className="spin"/> Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>🏢 Tenants</h2>
        <span style={{ color: 'var(--dim)', fontSize: 13 }}>{tenants.length} tenants</span>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Review</th>
              <th>Addresses</th>
              <th>Withdrawals</th>
              <th>Sweep</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tenants.map(t => (
              <tr key={t.id}>
                <td><strong>{t.name}</strong><br/><span style={{ color: 'var(--dim)', fontSize: 11 }}>{t.contact_email || '-'}</span></td>
                <td><span className={`badge ${t.status === 'active' ? 'green' : t.status === 'suspended' ? 'red' : 'yellow'}`}>{t.status}</span></td>
                <td><span className="badge blue">{t.review_mode}</span></td>
                <td>{t.addresses}</td>
                <td>{t.withdrawals}</td>
                <td>{t.sweep_address ? t.sweep_address.slice(0, 8) + '...' : '-'}</td>
                <td style={{ fontSize: 12, color: 'var(--dim)' }}>{new Date(t.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn btn-primary btn-xs" onClick={() => openDetail(t.id)}>Detail</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detailId && detail && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3>Tenant Detail — {detail.tenant?.name}</h3>
            <button className="btn btn-warn btn-xs" onClick={() => { setDetailId(null); setDetail(null); }}>Close</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div><label>Status</label>
              <select value={detail.tenant?.status} onChange={e => patch(detail.tenant.id, { status: e.target.value })}>
                <option value="active">active</option>
                <option value="suspended">suspended</option>
                <option value="pending">pending</option>
              </select>
            </div>
            <div><label>Review Mode</label>
              <select value={detail.tenant?.review_mode} onChange={e => patch(detail.tenant.id, { review_mode: e.target.value })}>
                <option value="manual">manual</option>
                <option value="auto">auto</option>
              </select>
            </div>
            <div><label>Sweep Threshold</label>
              <input value={detail.tenant?.sweep_threshold || 0} onChange={e => patch(detail.tenant.id, { sweep_threshold: parseInt(e.target.value) })} type="number"/>
            </div>
            <div><label>Sweep Address</label>
              <input value={detail.tenant?.sweep_address || ''} placeholder="0x..." onChange={e => patch(detail.tenant.id, { sweep_address: e.target.value })}/>
            </div>
          </div>
          {detail.addresses?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ fontSize: 13, color: 'var(--dim)', marginBottom: 8 }}>Address Pool</h4>
              <div className="card" style={{ overflow: 'auto', maxHeight: 300 }}>
                <table>
                  <thead><tr><th>Chain</th><th>Address</th><th>User ID</th><th>Label</th></tr></thead>
                  <tbody>
                    {detail.addresses.map((a: any) => (
                      <tr key={a.id}>
                        <td>{a.chain}</td>
                        <td className="mono">{a.address.slice(0, 10)}...{a.address.slice(-6)}</td>
                        <td className="mono">{a.external_user_id.slice(0,10)}...</td>
                        <td>{a.label || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
