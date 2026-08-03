import { useState, useEffect, useCallback } from 'react';
import { BarChart3, Server, FileText, KeyRound, Save, RefreshCw } from 'lucide-react';
import { api } from '../lib';

interface KeyStatus { set: boolean; masked: string }
interface DataStackOverview {
  data: { ok: boolean; error?: string; health?: any; stats?: any };
  injector: { ok: boolean; error?: string; health?: any; stats?: any; recent?: any[] };
  rag: { ok: boolean; error?: string; health?: any; instances?: any[]; adminKeySet?: boolean };
  fetched_at: number;
}

const KEY_LABELS: Array<[string, string]> = [
  ['llm_api_key', 'LLM API Key (DeepSeek)'],
  ['embedding_api_key', 'Embedding API Key (DashScope)'],
  ['admin_api_key', 'RAGservicer Admin Key'],
  ['ragservicer_api_key', '注入器桥接 Key (RAGSERVICER_API_KEY)'],
];

export default function DataStack() {
  const [overview, setOverview] = useState<DataStackOverview | null>(null);
  const [factors, setFactors] = useState<{ catalog?: any; current?: any } | null>(null);
  const [keys, setKeys] = useState<Record<string, KeyStatus>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ts, setTs] = useState(new Date());

  const fetchAll = useCallback(async () => {
    try {
      const [ov, k] = await Promise.all([
        api<DataStackOverview>('/data/overview'),
        api<{ keys: Record<string, KeyStatus> }>('/data/llm-keys'),
      ]);
      setOverview(ov);
      setKeys(k.keys || {});
      setTs(new Date());
    } catch {}
    try { setFactors(await api('/data/factors')); } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 10000);
    return () => clearInterval(t);
  }, [fetchAll]);

  const saveKeys = async () => {
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) if (v && v.trim()) payload[k] = v.trim();
    if (!Object.keys(payload).length) { setMsg({ ok: false, text: '请至少填写一个 key' }); return; }
    setSaving(true);
    setMsg(null);
    try {
      const r = await api<{ restarted: string[] }>('/data/llm-keys', { method: 'POST', body: JSON.stringify(payload) });
      const list = (r.restarted || []).join(', ') || '（重启失败，请手动重启）';
      setMsg({ ok: true, text: `已保存并重启: ${list}` });
      setForm({});
      fetchAll();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
    setSaving(false);
  };

  const fmtTime = (t?: number) => (t ? new Date(t * 1000).toLocaleTimeString() : '-');
  const extValues = (factors?.current?.factors || {}) as Record<string, any>;
  const instances = overview?.rag.instances || [];

  return (
    <div>
      <div className="flex-between mb-2">
        <h1 className="page-title">Data Stack</h1>
        <span className="tooltip">Auto-refresh 10s · Updated {ts.toLocaleTimeString()}</span>
      </div>

      {/* 三个服务状态 */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label"><Server size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Data Service :9112</div>
          <div className="stat-value" style={{ fontSize: 16, color: overview?.data.ok ? 'var(--green)' : 'var(--red)' }}>
            <span className={`pulse ${overview?.data.ok ? 'green' : 'red'}`} />
            {overview?.data.ok ? 'Healthy' : 'Down'}
          </div>
          <div className="stat-sub">
            {overview?.data.ok
              ? `${overview.data.stats?.symbols ?? '-'} symbols · ${(overview.data.stats?.kline_rows ?? 0).toLocaleString()} bars · ${(overview.data.stats?.snapshot_rows ?? 0).toLocaleString()} snapshots`
              : overview?.data.error || 'no data'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><FileText size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Knowledge Injector :9113</div>
          <div className="stat-value" style={{ fontSize: 16, color: overview?.injector.ok ? 'var(--green)' : 'var(--red)' }}>
            <span className={`pulse ${overview?.injector.ok ? 'green' : 'red'}`} />
            {overview?.injector.ok ? 'Healthy' : 'Down'}
          </div>
          <div className="stat-sub">
            {overview?.injector.ok
              ? `${overview.injector.health?.injector_count ?? '-'} injectors · LightRAG ${overview.injector.health?.lightrag_enabled ? 'enabled' : 'disabled'} · ${overview.injector.stats?.total_runs ?? 0} runs`
              : overview?.injector.error || 'no data'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><BarChart3 size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> RAGservicer :9721</div>
          <div className="stat-value" style={{ fontSize: 16, color: overview?.rag.ok ? 'var(--green)' : 'var(--red)' }}>
            <span className={`pulse ${overview?.rag.ok ? 'green' : 'red'}`} />
            {overview?.rag.ok ? 'Healthy' : 'Down'}
          </div>
          <div className="stat-sub">
            {overview?.rag.ok
              ? `${overview.rag.health?.data?.instances ?? '-'} instances · admin key ${overview.rag.adminKeySet ? 'configured' : 'not set'}`
              : overview?.rag.error || 'no data'}
          </div>
        </div>
      </div>

      {/* LLM API Keys */}
      <div className="card">
        <div className="card-header">
          <div className="card-title"><KeyRound size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> LLM / Embedding API Keys（写入 ragservicer .env 并自动重启）</div>
        </div>
        <div className="form-row" style={{ marginBottom: 6 }}>
          {KEY_LABELS.map(([k, label]) => {
            const st = keys[k];
            return (
              <div key={k}>
                <label className="form-label">{label}</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder={st?.set ? `已配置 ${st.masked}` : '未配置'}
                  value={form[k] || ''}
                  onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                  autoComplete="new-password"
                />
              </div>
            );
          })}
        </div>
        <div className="flex-between">
          <span className="tooltip" style={{ color: msg?.ok ? 'var(--green)' : msg ? 'var(--red)' : 'var(--dim)' }}>
            {msg?.text || '留空的字段保持不变；保存后 ragservicer 自动重启'}
          </span>
          <button className="btn btn-primary btn-sm" onClick={saveKeys} disabled={saving}>
            {saving ? <span className="spin" style={{ marginRight: 6 }} /> : <Save size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />}
            {saving ? 'Saving...' : '保存 Keys'}
          </button>
        </div>
      </div>

      {/* 外部因子 */}
      <div className="card">
        <div className="card-header">
          <div className="card-title"><RefreshCw size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> 外部因子（external factors）</div>
          <span className="badge blue">{factors?.catalog ? `${Object.keys(factors.catalog).length} 项` : '-'}</span>
        </div>
        {factors?.current ? (
          <div className="stats-grid">
            {Object.entries(extValues).map(([k, v]) => (
              <div className="stat-card" key={k} style={{ padding: 10 }}>
                <div className="stat-label">{k}</div>
                <div className="stat-value mono" style={{ fontSize: 16, color: 'var(--accent)' }}>{String(v)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="tooltip">因子数据不可用（data-service 未返回）</div>
        )}
      </div>

      {/* 注入日志 */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">最近注入记录（10 条）</div>
          <span className="badge purple">total {overview?.injector.stats?.total_runs ?? 0}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>时间</th><th>注入器</th><th>状态</th><th>耗时</th><th>错误</th></tr>
            </thead>
            <tbody>
              {(overview?.injector.recent || []).map((r, i) => (
                <tr key={i}>
                  <td className="mono">{fmtTime(r.timestamp)}</td>
                  <td style={{ fontWeight: 600 }}>{r.injector}</td>
                  <td><span className={`badge ${r.success ? 'green' : 'red'}`}>{r.success ? 'ok' : 'failed'}</span></td>
                  <td className="mono">{r.duration_ms} ms</td>
                  <td className="mono truncate" style={{ color: r.error && !r.success ? 'var(--red)' : 'var(--dim)' }}>{r.error || '—'}</td>
                </tr>
              ))}
              {!(overview?.injector.recent || []).length && (
                <tr><td colSpan={5} className="tooltip" style={{ textAlign: 'center', padding: 12 }}>暂无注入记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* RAG 实例 */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">RAG 实例（namespace 隔离）</div>
          {!overview?.rag.adminKeySet && <span className="badge yellow">未配置 ragservicer admin key，无法列出实例</span>}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Tenant</th><th>Namespace</th></tr>
            </thead>
            <tbody>
              {instances.map((inst, i) => (
                <tr key={i}>
                  <td className="mono">{i + 1}</td>
                  <td className="mono">{inst.tenant_id}</td>
                  <td className="mono">{inst.namespace}</td>
                </tr>
              ))}
              {!instances.length && (
                <tr><td colSpan={3} className="tooltip" style={{ textAlign: 'center', padding: 12 }}>暂无实例</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
