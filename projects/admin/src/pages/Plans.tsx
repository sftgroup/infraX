import { useState, useEffect } from 'react';
import { Tag, Plus, Pencil, Trash2, Power, Save, X } from 'lucide-react';
import { api } from '../lib';

// B-11-5 admin 套餐管理（CRUD）：
// waas-subscription / waas-data / dc-data 三组套餐覆盖配置。
// 各服务 /plans 端点 DB 优先（billing_plans）→ 回退代码常量；此处管理覆盖。
interface PlanOverride {
  id: string;
  planId: string;
  name: string;
  price: number;
  billingCycle: string;
  features: Record<string, any>;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}
interface Group {
  db: 'waas' | 'dc';
  service: string;
  overrides: PlanOverride[];
}

const SERVICE_META: Record<string, { label: string; defaultPlans: { id: string; name: string; price: number }[] }> = {
  'waas-subscription': {
    label: 'WAAS 订阅套餐',
    defaultPlans: [
      { id: 'free', name: 'Starter', price: 0 },
      { id: 'pro', name: 'Pro', price: 49 },
      { id: 'enterprise', name: 'Enterprise', price: 199 },
    ],
  },
  'waas-data': {
    label: 'WAAS Data 套餐',
    defaultPlans: [
      { id: 'data_free', name: 'Data Free', price: 0 },
      { id: 'data_pro', name: 'Data Pro', price: 29 },
      { id: 'data_enterprise', name: 'Data Enterprise', price: 99 },
    ],
  },
  'dc-data': {
    label: 'DC Data 套餐',
    defaultPlans: [
      { id: 'data_free', name: 'Data Free', price: 0 },
      { id: 'data_pro', name: 'Data Pro', price: 29 },
      { id: 'data_enterprise', name: 'Data Enterprise', price: 99 },
    ],
  },
};

const fmtFeatures = (f: Record<string, any>) => {
  if (!f || typeof f !== 'object') return '-';
  const parts = Object.entries(f).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).slice(0, 6);
  return parts.join('  ') || '-';
};

export default function Plans() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 编辑表单
  const [editing, setEditing] = useState<PlanOverride | null>(null);
  const [form, setForm] = useState<any>({ db: 'waas', service: 'waas-subscription', planId: '', name: '', price: '0', billingCycle: 'monthly', features: '{}', enabled: true });
  const [showNew, setShowNew] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setGroups(await api<Group[]>('/admin/plans') || []); }
    catch (e: any) { setMsg({ ok: false, text: e.message }); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setMsg(null);
    const body = {
      db: form.db, service: form.service, planId: form.planId, name: form.name,
      price: Number(form.price) || 0, billingCycle: form.billingCycle,
      features: JSON.parse(form.features || '{}'), enabled: form.enabled,
    };
    if (!body.planId.trim() || !body.name.trim()) { setMsg({ ok: false, text: 'planId 与 name 必填' }); return; }
    try {
      await api('/admin/plans', { method: 'POST', body: JSON.stringify(body) });
      setMsg({ ok: true, text: '已保存覆盖配置（服务 /plans 端点 DB 优先生效）' });
      setShowNew(false); setEditing(null);
      load();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  const patch = async (id: string, db: string, patchBody: any) => {
    setMsg(null);
    try {
      await api(`/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify({ db, ...patchBody }) });
      load();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  const del = async (id: string, db: string) => {
    if (!confirm('删除该覆盖配置？删除后该套餐恢复代码常量默认')) return;
    setMsg(null);
    try {
      await api(`/admin/plans/${id}?db=${db}`, { method: 'DELETE' });
      setMsg({ ok: true, text: '已删除覆盖（恢复默认）' });
      load();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  if (loading) return <div className="loading"><span className="spin" />Loading Plans...</div>;

  return (
    <div>
      <div className="flex-between mb-2">
        <h1 className="page-title">Plans</h1>
        <button className="btn btn-primary btn-sm" onClick={() => { setForm({ db: 'waas', service: 'waas-subscription', planId: '', name: '', price: '0', billingCycle: 'monthly', features: '{}', enabled: true }); setEditing(null); setShowNew(true); }}>
          <Plus size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />新增套餐覆盖
        </button>
      </div>
      <p className="page-sub" style={{ marginBottom: 12 }}>套餐默认在代码常量中定义；此处新增/编辑「覆盖配置」后，对应服务 /plans 端点 DB 优先返回覆盖值</p>

      {msg && <div className={`badge ${msg.ok ? 'green' : 'red'}`} style={{ marginBottom: 8 }}>{msg.text}</div>}

      {/* 新增/编辑表单 */}
      {showNew && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <div className="card-title"><Plus size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> {editing ? `编辑覆盖 ${editing.planId}` : '新增套餐覆盖'}</div>
          </div>
          <div className="form-row" style={{ marginBottom: 6 }}>
            <div>
              <label className="form-label">库</label>
              <select className="form-input" value={form.db} onChange={e => setForm({ ...form, db: e.target.value, service: e.target.value === 'dc' ? 'dc-data' : 'waas-subscription' })}>
                <option value="waas">waas（pocketx_waas）</option>
                <option value="dc">dc（pocketx_dc）</option>
              </select>
            </div>
            <div>
              <label className="form-label">套餐组</label>
              <select className="form-input" value={form.service} onChange={e => setForm({ ...form, service: e.target.value })}>
                <option value="waas-subscription">WAAS 订阅</option>
                <option value="waas-data">WAAS Data</option>
                <option value="dc-data">DC Data</option>
              </select>
            </div>
            <div>
              <label className="form-label">plan_id（对应代码常量 id）</label>
              <input className="form-input" value={form.planId} onChange={e => setForm({ ...form, planId: e.target.value })} placeholder="free / pro / data_pro / ..." />
            </div>
            <div>
              <label className="form-label">名称</label>
              <input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="form-label">价格（USD/月）</label>
              <input className="form-input" type="number" min={0} value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} />
            </div>
            <div>
              <label className="form-label">billing cycle</label>
              <input className="form-input" value={form.billingCycle} onChange={e => setForm({ ...form, billingCycle: e.target.value })} />
            </div>
            <div>
              <label className="form-label">features（JSON，与默认合并）</label>
              <input className="form-input mono" style={{ minWidth: 280 }} value={form.features} onChange={e => setForm({ ...form, features: e.target.value })} placeholder='{"mpcWallets": 50}' />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="form-label" style={{ marginBottom: 0 }}>启用</label>
              <input type="checkbox" checked={!!form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
            </div>
          </div>
          <div className="flex-between">
            <span className="tooltip">覆盖后该套餐名称/价格/配额以此处为准；features 与代码常量默认深合并</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-sm" onClick={() => setShowNew(false)}><X size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />取消</button>
              <button className="btn btn-primary btn-sm" onClick={save}><Save size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 分组卡片 */}
      {groups.map(g => {
        const meta = SERVICE_META[g.service];
        const byId = new Map(g.overrides.map(o => [o.planId, o]));
        const allPlans = meta?.defaultPlans.map(dp => ({ ...dp, override: byId.get(dp.id) })) || [];
        return (
          <div className="card" key={g.service} style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div className="card-title"><Tag size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> {meta?.label || g.service}</div>
              <span className="tooltip">db={g.db} · {g.overrides.length} 条覆盖</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>plan_id</th><th>名称</th><th>价格</th><th>周期</th><th>features（覆盖）</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {allPlans.map(p => (
                    <tr key={p.id}>
                      <td className="mono" style={{ fontWeight: 600 }}>{p.id}</td>
                      <td>{p.override ? <strong>{p.override.name}</strong> : <span>{p.name}</span>}
                        {p.override && <span className="badge blue" style={{ marginLeft: 6 }}>覆盖中</span>}
                        {!p.override && <span className="tooltip" style={{ marginLeft: 6 }}>代码常量默认</span>}
                      </td>
                      <td className="mono">${p.override ? p.override.price : p.price}</td>
                      <td className="mono">{p.override?.billingCycle || 'monthly'}</td>
                      <td className="tooltip" style={{ fontSize: 12 }}>{p.override ? fmtFeatures(p.override.features) : '—'}</td>
                      <td>
                        {p.override ? (
                          <span className={`badge ${p.override.enabled ? 'green' : 'red'}`}>{p.override.enabled ? '启用' : '停用'}</span>
                        ) : <span className="badge">默认</span>}
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          {p.override && (
                            <>
                              <button className="btn btn-sm" title="编辑覆盖" onClick={() => {
                                setEditing(p.override!);
                                setForm({
                                  db: g.db, service: g.service, planId: p.override!.planId, name: p.override!.name,
                                  price: String(p.override!.price), billingCycle: p.override!.billingCycle,
                                  features: JSON.stringify(p.override!.features || {}), enabled: p.override!.enabled,
                                });
                                setShowNew(true);
                              }}>
                                <Pencil size={13} />
                              </button>
                              <button className="btn btn-sm" title={p.override!.enabled ? '停用' : '启用'} onClick={() => patch(p.override!.id, g.db, { enabled: !p.override!.enabled })}>
                                <Power size={13} />
                              </button>
                              <button className="btn btn-sm" title="删除覆盖（恢复默认）" onClick={() => del(p.override!.id, g.db)}>
                                <Trash2 size={13} style={{ color: 'var(--red)' }} />
                              </button>
                            </>
                          )}
                          {!p.override && (
                            <button className="btn btn-sm" title="为默认套餐创建覆盖" onClick={() => {
                              setEditing(null);
                              setForm({ db: g.db, service: g.service, planId: p.id, name: p.name, price: String(p.price), billingCycle: 'monthly', features: '{}', enabled: true });
                              setShowNew(true);
                            }}>
                              <Plus size={13} />
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
