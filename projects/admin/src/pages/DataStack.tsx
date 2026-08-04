import { useState, useEffect, useCallback } from 'react';
import { BarChart3, Server, FileText, KeyRound, Save, RefreshCw } from 'lucide-react';
import { api } from '../lib';

interface RagConfig {
  llm: { model: string; base_url: string; api_key_set: boolean; api_key: string };
  embedding: { backend: string; model_name: string; dims: number; max_token_size: number; base_url: string; api_key_set: boolean; api_key: string };
  env_file: string;
}
interface DataStackOverview {
  data: { ok: boolean; error?: string; health?: any; stats?: any };
  injector: { ok: boolean; error?: string; health?: any; stats?: any; recent?: any[] };
  rag: { ok: boolean; error?: string; health?: any; instances?: any[]; adminKeySet?: boolean };
  fetched_at: number;
}
interface SourceKeyInfo { set: boolean; key_count: number; keys: string[] }
interface SourceKeysSnapshot { keys: Record<string, SourceKeyInfo>; env_file: string; hot_reload: boolean }
interface SourceKeysOverview {
  data: { ok: boolean; config: SourceKeysSnapshot | null; adminKeySet?: boolean; error?: string };
  injector: { ok: boolean; config: SourceKeysSnapshot | null; adminKeySet?: boolean; error?: string };
}

const LLM_FIELDS: Array<[string, string]> = [
  ['llm_api_key', 'LLM API Key (DeepSeek)'],
  ['llm_model', 'LLM Model'],
  ['llm_base_url', 'LLM Base URL'],
];
const EMB_FIELDS: Array<[string, string]> = [
  ['embedding_api_key', 'Embedding API Key (DashScope)'],
  ['embedding_backend', 'Embedding Backend'],
  ['embedding_model_name', 'Embedding Model'],
  ['embedding_base_url', 'Embedding Base URL'],
];
// 数据源 API Key（data-service 侧，多 key 逗号分隔、采集时轮询取用）
const DATA_SRC_FIELDS: Array<[string, string]> = [
  ['FRED_API_KEY', 'FRED'],
  ['NEWSAPI_API_KEY', 'NewsAPI'],
  ['ADANOS_API_KEY', 'Adanos'],
  ['FINNHUB_API_KEY', 'Finnhub'],
  ['TIINGO_API_KEY', 'Tiingo'],
  ['TWELVE_DATA_API_KEY', 'Twelve Data'],
  ['ALPHA_VANTAGE_KEY', 'Alpha Vantage'],
  ['COINGECKO_API_KEY', 'CoinGecko'],
  ['CRYPTOCOMPARE_API_KEY', 'CryptoCompare'],
];
// 数据源 API Key（knowledge-injector 侧）
const INJ_SRC_FIELDS: Array<[string, string]> = [
  ['FRED_API_KEY', 'FRED'],
  ['ETHERSCAN_API_KEY', 'Etherscan'],
  ['FINNHUB_API_KEY', 'Finnhub'],
  ['TUSHARE_API_KEY', 'TuShare'],
  ['NEWSAPI_KEY', 'NewsAPI'],
];

export default function DataStack() {
  const [overview, setOverview] = useState<DataStackOverview | null>(null);
  const [factors, setFactors] = useState<{ catalog?: any; current?: any } | null>(null);
  const [cfg, setCfg] = useState<RagConfig | null>(null);
  const [cfgErr, setCfgErr] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [srcKeys, setSrcKeys] = useState<SourceKeysOverview | null>(null);
  const [srcForm, setSrcForm] = useState<Record<string, string>>({});
  const [srcSaving, setSrcSaving] = useState(false);
  const [srcMsg, setSrcMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [srcErr, setSrcErr] = useState('');
  const [ts, setTs] = useState(new Date());

  const fetchAll = useCallback(async () => {
    try {
      const [ov, k, sk] = await Promise.all([
        api<DataStackOverview>('/data/overview'),
        api<{ config: RagConfig }>('/data/llm-keys'),
        api<SourceKeysOverview>('/data/data-source-keys'),
      ]);
      setOverview(ov);
      setCfg(k.config || null);
      setSrcKeys(sk);
      setCfgErr('');
      setSrcErr('');
      setTs(new Date());
    } catch (e: any) {
      setCfgErr(e.message);
      setSrcErr(e.message);
    }
    try { setFactors(await api('/data/factors')); } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 10000);
    return () => clearInterval(t);
  }, [fetchAll]);

  const saveKeys = async () => {
    const llm: Record<string, string> = {};
    const embedding: Record<string, string> = {};
    if (form.llm_api_key?.trim()) llm.api_key = form.llm_api_key.trim();
    if (form.llm_model?.trim()) llm.model = form.llm_model.trim();
    if (form.llm_base_url?.trim()) llm.base_url = form.llm_base_url.trim();
    if (form.embedding_api_key?.trim()) embedding.api_key = form.embedding_api_key.trim();
    if (form.embedding_backend?.trim()) embedding.backend = form.embedding_backend.trim();
    if (form.embedding_model_name?.trim()) embedding.model_name = form.embedding_model_name.trim();
    if (form.embedding_base_url?.trim()) embedding.base_url = form.embedding_base_url.trim();

    const payload: Record<string, any> = {};
    if (Object.keys(llm).length) payload.llm = llm;
    if (Object.keys(embedding).length) payload.embedding = embedding;
    if (!Object.keys(payload).length) { setMsg({ ok: false, text: '请至少填写一个配置项' }); return; }

    setSaving(true);
    setMsg(null);
    try {
      const r = await api<{ config: RagConfig }>('/data/llm-keys', { method: 'POST', body: JSON.stringify(payload) });
      setCfg(r.config || null);
      setMsg({ ok: true, text: '已保存并热生效（无需重启服务）' });
      setForm({});
      fetchAll();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
    setSaving(false);
  };

  const saveSrcKeys = async () => {
    const data: Record<string, string> = {};
    const injector: Record<string, string> = {};
    DATA_SRC_FIELDS.forEach(([k]) => { const v = srcForm[`data.${k}`]; if (v?.trim()) data[k] = v.trim(); });
    INJ_SRC_FIELDS.forEach(([k]) => { const v = srcForm[`inj.${k}`]; if (v?.trim()) injector[k] = v.trim(); });

    const payload: Record<string, any> = {};
    if (Object.keys(data).length) payload.data = data;
    if (Object.keys(injector).length) payload.injector = injector;
    if (!Object.keys(payload).length) { setSrcMsg({ ok: false, text: '请至少填写一个数据源 Key' }); return; }

    setSrcSaving(true);
    setSrcMsg(null);
    try {
      const r = await api<SourceKeysOverview>('/data/data-source-keys', { method: 'POST', body: JSON.stringify(payload) });
      setSrcKeys(r);
      setSrcMsg({ ok: true, text: '已保存并热生效（无需重启服务）' });
      setSrcForm({});
    } catch (e: any) {
      setSrcMsg({ ok: false, text: e.message });
    }
    setSrcSaving(false);
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

      {/* LLM / Embedding 配置（转发 ragservicer /admin/config，热生效） */}
      <div className="card">
        <div className="card-header">
          <div className="card-title"><KeyRound size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> LLM / Embedding 配置（保存后热生效，无需重启）</div>
          {cfgErr && <span className="badge yellow">{cfgErr}</span>}
        </div>

        <div className="form-row" style={{ marginBottom: 6 }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: '#e5e7eb' }}>LLM（实体抽取 · DeepSeek）</div>
            {LLM_FIELDS.map(([k, label]) => {
              const placeholder =
                k === 'llm_api_key'
                  ? cfg?.llm.api_key_set ? `已配置 ${cfg.llm.api_key}` : '未配置'
                  : (cfg?.llm as any)?.[k === 'llm_model' ? 'model' : 'base_url'] || '默认值';
              return (
                <div key={k}>
                  <label className="form-label">{label}</label>
                  <input
                    className="form-input"
                    type="password"
                    placeholder={placeholder}
                    value={form[k] || ''}
                    onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                    autoComplete="new-password"
                  />
                </div>
              );
            })}
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: '#e5e7eb' }}>
              Embedding（DashScope）{cfg?.embedding ? ` · dims=${cfg.embedding.dims}` : ''}
            </div>
            {EMB_FIELDS.map(([k, label]) => {
              const placeholder =
                k === 'embedding_api_key'
                  ? cfg?.embedding.api_key_set ? `已配置 ${cfg.embedding.api_key}` : '未配置'
                  : (cfg?.embedding as any)?.[k === 'embedding_backend' ? 'backend' : k === 'embedding_model_name' ? 'model_name' : 'base_url'] || '默认值';
              return (
                <div key={k}>
                  <label className="form-label">{label}</label>
                  <input
                    className="form-input"
                    type="password"
                    placeholder={placeholder}
                    value={form[k] || ''}
                    onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                    autoComplete="new-password"
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex-between">
          <span className="tooltip" style={{ color: msg?.ok ? 'var(--green)' : msg ? 'var(--red)' : 'var(--dim)' }}>
            {msg?.text || '留空的字段保持不变；密钥显示为脱敏值，仅展示'}
          </span>
          <button className="btn btn-primary btn-sm" onClick={saveKeys} disabled={saving}>
            {saving ? <span className="spin" style={{ marginRight: 6 }} /> : <Save size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />}
            {saving ? 'Saving...' : '保存配置'}
          </button>
        </div>
      </div>

      {/* 数据源 API Key 配置（data-service / knowledge-injector，多 key 轮询 · 热生效） */}
      <div className="card">
        <div className="card-header">
          <div className="card-title"><KeyRound size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} /> 数据源 API Key 配置（多 key 英文逗号分隔 · 采集时轮询 · 保存后热生效）</div>
          {srcErr && <span className="badge yellow">{srcErr}</span>}
        </div>

        <div className="form-row" style={{ marginBottom: 6 }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: '#e5e7eb' }}>
              Data Service :9112{srcKeys?.data.ok ? '' : ` · ${srcKeys?.data.error || '无法读取'}`}
            </div>
            {DATA_SRC_FIELDS.map(([k, label]) => {
              const info = srcKeys?.data.config?.keys[k];
              return (
                <div key={`data.${k}`}>
                  <label className="form-label">{label} <span className="mono" style={{ opacity: 0.55, fontSize: 11 }}>{k}</span></label>
                  <input
                    className="form-input"
                    type="password"
                    placeholder={info?.set ? `已配置 ${info.key_count} 个：${info.keys.join('，')}` : '未配置 · 多 key 用英文逗号分隔'}
                    value={srcForm[`data.${k}`] || ''}
                    onChange={e => setSrcForm(f => ({ ...f, [`data.${k}`]: e.target.value }))}
                    autoComplete="new-password"
                  />
                </div>
              );
            })}
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 8, color: '#e5e7eb' }}>
              Knowledge Injector :9113{srcKeys?.injector.ok ? '' : ` · ${srcKeys?.injector.error || '无法读取'}`}
            </div>
            {INJ_SRC_FIELDS.map(([k, label]) => {
              const info = srcKeys?.injector.config?.keys[k];
              return (
                <div key={`inj.${k}`}>
                  <label className="form-label">{label} <span className="mono" style={{ opacity: 0.55, fontSize: 11 }}>{k}</span></label>
                  <input
                    className="form-input"
                    type="password"
                    placeholder={info?.set ? `已配置 ${info.key_count} 个：${info.keys.join('，')}` : '未配置 · 多 key 用英文逗号分隔'}
                    value={srcForm[`inj.${k}`] || ''}
                    onChange={e => setSrcForm(f => ({ ...f, [`inj.${k}`]: e.target.value }))}
                    autoComplete="new-password"
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex-between">
          <span className="tooltip" style={{ color: srcMsg?.ok ? 'var(--green)' : srcMsg ? 'var(--red)' : 'var(--dim)' }}>
            {srcMsg?.text || '多个 key 用英文逗号分隔（如 key1,key2），请求自动轮询取用；留空的字段保持不变'}
          </span>
          <button className="btn btn-primary btn-sm" onClick={saveSrcKeys} disabled={srcSaving}>
            {srcSaving ? <span className="spin" style={{ marginRight: 6 }} /> : <Save size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />}
            {srcSaving ? 'Saving...' : '保存数据源 Key'}
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
