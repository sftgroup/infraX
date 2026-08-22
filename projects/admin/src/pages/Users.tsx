import { useState, useEffect } from 'react';
import { User, Mail, Wallet, Database, KeyRound, Search } from 'lucide-react';
import { api } from '../lib';

// B-11-4 admin 用户管理页：聚合 waas users（C 端邮箱）/ dc users（钱包地址）/ mpc wallets（email 维度）
export default function Users() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  const load = async (query: string) => {
    setLoading(true);
    try {
      const d = await api(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setData(d);
    } catch (e: any) {
      setData({ error: e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(''); }, []);
  useEffect(() => {
    if (!q) return;
    const t = setTimeout(() => load(q), 400);
    return () => clearTimeout(t);
  }, [q]);

  const waas = data?.waas || [];
  const dc = data?.dc || [];
  const mpc = data?.mpc || [];

  if (loading && !data) return <div className="loading"><span className="spin" />Loading Users...</div>;

  return (
    <div>
      <h1 className="page-title">Users</h1>
      <p className="page-sub">跨模块用户管理（waas C 端邮箱 / dc 钱包地址 / mpc 钱包邮箱聚合）</p>

      {data?.error && <div className="badge yellow" style={{ marginBottom: 8 }}>{data.error}</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="flex-between">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={14} style={{ color: 'var(--dim)' }} />
            <input
              className="form-input" style={{ width: 280 }}
              placeholder="搜索 email / 钱包地址…（自动查询）"
              value={q} onChange={e => setQ(e.target.value)}
            />
            {q && <button className="btn btn-sm" onClick={() => { setQ(''); load(''); }}>清除</button>}
          </div>
          <span className="tooltip">共 {waas.length + dc.length + mpc.length} 条（上限 100/类）</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {/* WAAS C 端用户 */}
        <div className="card" style={{ flex: '1 1 420px' }}>
          <div className="card-header">
            <div className="card-title"><Mail size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> WAAS 用户（邮箱 · infrax_waas.users）</div>
            <span className="tooltip">{waas.length} 条</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Email</th><th>角色</th><th>钱包</th><th>交易</th><th>订阅</th><th>创建</th></tr></thead>
              <tbody>
                {waas.map((u: any) => (
                  <tr key={u.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{u.email}</td>
                    <td><span className={`badge ${u.role === 'admin' ? 'red' : 'blue'}`}>{u.role}</span></td>
                    <td className="mono">{u.wallets}</td>
                    <td className="mono">{u.txns}</td>
                    <td className="mono">{u.active_subs}</td>
                    <td className="mono">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</td>
                  </tr>
                ))}
                {!waas.length && <tr><td colSpan={6} className="tooltip" style={{ textAlign: 'center', padding: 12 }}>暂无用户</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* DC 钱包用户 */}
        <div className="card" style={{ flex: '1 1 420px' }}>
          <div className="card-header">
            <div className="card-title"><Wallet size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> DC 用户（钱包地址 · infrax_dc.users）</div>
            <span className="tooltip">{dc.length} 条</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>钱包地址</th><th>角色</th><th>租户</th><th>创建</th></tr></thead>
              <tbody>
                {dc.map((u: any) => (
                  <tr key={u.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{u.wallet_address}</td>
                    <td><span className={`badge ${u.role === 'admin' ? 'red' : 'blue'}`}>{u.role}</span></td>
                    <td className="mono">{u.tenants}</td>
                    <td className="mono">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</td>
                  </tr>
                ))}
                {!dc.length && <tr><td colSpan={4} className="tooltip" style={{ textAlign: 'center', padding: 12 }}>暂无用户</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* MPC 钱包邮箱聚合 */}
        <div className="card" style={{ flex: '1 1 100%' }}>
          <div className="card-header">
            <div className="card-title"><KeyRound size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> MPC 钱包（按 email 聚合 · infrax_mpc.mpc_wallets）</div>
            <span className="tooltip">E-4 后放开 1:1 时单邮箱多子钱包，此处按邮箱分组</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Email</th><th>子钱包数</th><th>活跃</th><th>最后创建</th></tr></thead>
              <tbody>
                {mpc.map((u: any) => (
                  <tr key={u.email}>
                    <td className="mono" style={{ fontWeight: 600 }}>{u.email}</td>
                    <td className="mono">{u.wallets}</td>
                    <td className="mono">{u.active_wallets}</td>
                    <td className="mono">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '-'}</td>
                  </tr>
                ))}
                {!mpc.length && <tr><td colSpan={4} className="tooltip" style={{ textAlign: 'center', padding: 12 }}>暂无钱包</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
