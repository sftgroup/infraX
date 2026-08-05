import { useState, useEffect, useCallback } from 'react';
import { KeyRound, RefreshCw, Plus, RotateCw, Trash2, Power, Copy, Check } from 'lucide-react';
import { api } from '../lib';

interface DataKey {
  id: number;
  label: string;
  key_masked: string;
  rate_limit: number;
  enabled: number;
  created_by: string;
  last_used_at: number | null;
  request_count: number;
  created_at: number;
  updated_at: number;
  service?: 'data';
}
interface RagKey {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  created_at?: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  active?: number | boolean;
}
interface RagTenant {
  id: string;
  name?: string;
  description?: string;
  created_at?: string;
  active?: number | boolean;
  keys: RagKey[];
  keys_ok?: boolean;
  keys_error?: string;
}
interface KeysOverview {
  data: { ok: boolean; keys: DataKey[]; adminKeySet?: boolean; error?: string };
  rag: { ok: boolean; tenants: RagTenant[]; adminKeySet?: boolean; error?: string };
  fetched_at: number;
}

const fmtMs = (t?: number | string | null) => {
  if (!t) return '-';
  if (typeof t === 'number') return new Date(t).toLocaleString();
  return new Date(t).toLocaleString();
};
const fmtDays = (expires?: string | null) => {
  if (!expires) return '永不过期';
  const d = new Date(expires).getTime() - Date.now();
  if (d <= 0) return '已过期';
  return `剩余 ${Math.ceil(d / 86400000)} 天`;
};

export default function ApiKeys() {
  const [ov, setOv] = useState<KeysOverview | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ts, setTs] = useState(new Date());

  // 签发表单
  const [svc, setSvc] = useState<'data' | 'rag'>('data');
  const [label, setLabel] = useState('');
  const [rateLimit, setRateLimit] = useState('600');
  const [tenantId, setTenantId] = useState('');
  const [expiresDays, setExpiresDays] = useState('365');

  // 新 key 一次性展示
  const [newKey, setNewKey] = useState<{ label: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      setOv(await api<KeysOverview>('/data/keys'));
      setErr('');
      setTs(new Date());
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 10000);
    return () => clearInterval(t);
  }, [fetchAll]);

  const create = async () => {
    setMsg(null);
    setNewKey(null);
    const payload: any = { service: svc };
    if (svc === 'data') {
      if (!label.trim()) { setMsg({ ok: false, text: '请填写 label（如 aitrader）' }); return; }
      payload.label = label.trim();
      payload.rate_limit = Number(rateLimit) || undefined;
    } else {
      if (!tenantId.trim()) { setMsg({ ok: false, text: '请填写租户 ID（如 servicehub）' }); return; }
      payload.tenant_id = tenantId.trim();
      payload.name = 'prod';
      payload.expires_days = Number(expiresDays) || 0;
    }
    try {
      const r = await api<any>('/data/keys', { method: 'POST', body: JSON.stringify(payload) });
      const key = r.service === 'rag' ? r.key : r.api_key;
      setNewKey({ label: r.service === 'rag' ? `${r.tenant_id}/${r.name}` : r.label, key });
      setMsg({ ok: true, text: r.service === 'rag' ? '租户 key 已签发（仅显示一次）' : 'data key 已签发（仅显示一次）' });
      setLabel(''); setTenantId('');
      fetchAll();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const act = async (fn: () => Promise<any>, okText: string) => {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: okText }); fetchAll(); }
    catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };

  const copyKey = async () => {
    if (!newKey) return;
    try { await navigator.clipboard.writeText(newKey.key); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  const dataKeys = ov?.data.keys || [];
  const tenants = ov?.rag.tenants || [];

  return (
    <div>
      <div className="flex-between mb-2">
        <h1 className="page-title">API Keys</h1>
        <span className="tooltip">Auto-refresh 10s · Updated {ts.toLocaleTimeString()}</span>
      </div>

      {err && <div className="badge yellow" style={{ marginBottom: 8 }}>{err}</div>}

      {/* 签发表单 */}
      <div className="card">
        <div className="card-header">
          <div className="card-title"><Plus size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> 签发 API Key（统一管理 data dx_ key 与 LightRAG lr_ key）</div>
        </div>
        <div className="form-row" style={{ marginBottom: 6 }}>
          <div>
            <label className="form-label">服务</label>
            <select className="form-input" value={svc} onChange={e => setSvc(e.target.value as any)}>
              <option value="data">Data Service（dx_ key · 行情/因子/快照）</option>
              <option value="rag">LightRAG（lr_ key · 知识库租户）</option>
            </select>
          </div>
          {svc === 'data' ? (
            <>
              <div>
                <label className="form-label">label（标识使用方，如 aitrader）</label>
                <input className="form-input" value={label} onChange={e => setLabel(e.target.value)} placeholder="aitrader / aiservicer / ..." />
              </div>
              <div>
                <label className="form-label">限流 RPM（1 分钟窗口）</label>
                <input className="form-input" type="number" min={1} value={rateLimit} onChange={e => setRateLimit(e.target.value)} />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="form-label">租户 ID（不存在的自动创建）</label>
                <input className="form-input" value={tenantId} onChange={e => setTenantId(e.target.value)} placeholder="servicehub / docs / ..." />
              </div>
              <div>
                <label className="form-label">有效期（天，0 = 永不过期）</label>
                <input className="form-input" type="number" min={0} value={expiresDays} onChange={e => setExpiresDays(e.target.value)} />
              </div>
            </>
          )}
        </div>
        <div className="flex-between">
          <span className="tooltip" style={{ color: msg?.ok ? 'var(--green)' : msg ? 'var(--red)' : 'var(--dim)' }}>{msg?.text || '签发的 key 仅显示一次，服务端只存哈希'}</span>
          <button className="btn btn-primary btn-sm" onClick={create}>
            <Plus size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />签发
          </button>
        </div>

        {newKey && (
          <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'rgba(139,92,246,0.08)' }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: '#e5e7eb' }}>新 key（{newKey.label}）—— 仅此一次显示，请立即复制保存</div>
            <div className="mono" style={{ wordBreak: 'break-all', marginBottom: 6 }}>{newKey.key}</div>
            <button className="btn btn-sm" onClick={copyKey}>
              {copied ? <Check size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> : <Copy size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        )}
      </div>

      {/* Data Service keys */}
      <div className="card">
        <div className="card-header">
          <div className="card-title"><KeyRound size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Data Service keys（dx_）</div>
          {!ov?.data.adminKeySet && <span className="badge yellow">未配置 data admin key（data .env 的 ADMIN_API_KEY）</span>}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>label</th><th>key</th><th>状态</th><th>RPM</th><th>请求数</th><th>最后使用</th><th>操作</th></tr>
            </thead>
            <tbody>
              {dataKeys.map(k => (
                <tr key={k.id}>
                  <td style={{ fontWeight: 600 }}>{k.label}</td>
                  <td className="mono">{k.key_masked}</td>
                  <td><span className={`badge ${k.enabled ? 'green' : 'red'}`}>{k.enabled ? '启用' : '禁用'}</span></td>
                  <td className="mono">{k.rate_limit}/min</td>
                  <td className="mono">{k.request_count}</td>
                  <td className="mono">{fmtMs(k.last_used_at)}</td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button className="btn btn-sm" title={k.enabled ? '禁用' : '启用'} onClick={() => act(() => api(`/data/keys/data/${k.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !k.enabled }) }), k.enabled ? '已禁用' : '已启用')}>
                        <Power size={13} />
                      </button>
                      <button className="btn btn-sm" title="轮换（旧 key 立即失效）" onClick={() => act(async () => {
                        const r = await api<any>(`/data/keys/data/${k.id}/rotate`, { method: 'POST' });
                        setNewKey({ label: `${k.label}（轮换后新 key）`, key: r.api_key });
                        setMsg({ ok: true, text: '已轮换（新 key 仅显示一次）' });
                      }, '')}>
                        <RotateCw size={13} />
                      </button>
                      <button className="btn btn-sm" title="删除" onClick={() => { if (confirm(`确认删除 ${k.label} 的 key？删除后立即失效`)) act(() => api(`/data/keys/data/${k.id}`, { method: 'DELETE' }), '已删除'); }}>
                        <Trash2 size={13} style={{ color: 'var(--red)' }} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {!dataKeys.length && <tr><td colSpan={7} className="tooltip" style={{ textAlign: 'center', padding: 12 }}>暂无 data key</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* LightRAG tenants & keys */}
      <div className="card">
        <div className="card-header">
          <div className="card-title"><KeyRound size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> LightRAG 租户 keys（lr_）</div>
          {!ov?.rag.adminKeySet && <span className="badge yellow">未配置 ragservicer admin key</span>}
          {ov?.rag.error && <span className="badge yellow">{ov.rag.error}</span>}
        </div>
        {tenants.map(t => (
          <div key={t.id} style={{ marginBottom: 14, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
            <div className="flex-between">
              <div>
                <span className="mono" style={{ fontWeight: 700, color: '#e5e7eb' }}>{t.id}</span>
                {t.description && <span className="tooltip" style={{ marginLeft: 8 }}>{t.description}</span>}
                <span className={`badge ${t.active !== 0 && t.active !== false ? 'green' : 'red'}`} style={{ marginLeft: 8 }}>{t.active !== 0 && t.active !== false ? 'active' : 'inactive'}</span>
              </div>
              <button className="btn btn-sm" title="删除租户（连带全部 key）" onClick={() => { if (confirm(`确认删除租户 ${t.id}？其下全部 key 立即失效`)) act(() => api(`/data/keys/rag/${t.id}`, { method: 'DELETE' }), '租户已删除'); }}>
                <Trash2 size={13} style={{ color: 'var(--red)' }} />
              </button>
            </div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr><th>name</th><th>key</th><th>有效期</th><th>状态</th><th>最后使用</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {t.keys.map(k => (
                    <tr key={k.id}>
                      <td style={{ fontWeight: 600 }}>{k.name}</td>
                      <td className="mono">{k.key_prefix}…</td>
                      <td className="mono">{fmtDays(k.expires_at)}</td>
                      <td><span className={`badge ${k.active !== 0 && k.active !== false ? 'green' : 'red'}`}>{k.active !== 0 && k.active !== false ? 'active' : 'revoked'}</span></td>
                      <td className="mono">{fmtMs(k.last_used_at)}</td>
                      <td>
                        <button className="btn btn-sm" title="吊销（不可恢复，需重新签发）" onClick={() => { if (confirm(`吊销 ${t.id}/${k.name} 的 key？`)) act(() => api(`/data/keys/rag/${k.id}/revoke`, { method: 'POST' }), '已吊销'); }}>
                          <Power size={13} style={{ color: 'var(--red)' }} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!t.keys.length && <tr><td colSpan={6} className="tooltip" style={{ textAlign: 'center', padding: 10 }}>该租户暂无 key（可在上方表单为该租户签发）</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {!tenants.length && !ov?.rag.error && (
          <div className="tooltip" style={{ textAlign: 'center', padding: 12 }}>暂无 LightRAG 租户（可先在上方表单签发第一个）</div>
        )}
      </div>
    </div>
  );
}
