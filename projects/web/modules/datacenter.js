/**
 * InfraX Data Center — B2B On-chain Data API Module
 * Dependencies: core.js, infrax.css
 */

function obscureKey(key) { return key && key.length > 16 ? key.slice(0,14) + '…' + key.slice(-8) : key; }

// ─── State ───────────────────────────────────────────────────────────
let dcPlan = null;
let dcUsage = null;
let dcEventsPageToken = null;

const DC_CHAINS = [
  { name: 'Sepolia', img: '/img/chain-sepolia.svg', color: '#6366f1' },
  { name: 'Ethereum', img: '/img/chain-ethereum.svg', color: '#627eea' },
  { name: 'BSC', img: '/img/chain-bsc.svg', color: '#f0b90b' },
  { name: 'Base', img: '/img/chain-base.svg', color: '#0052ff' },
  { name: 'OxaChain', img: '/img/chain-oxa.svg', color: '#ff6b35' },
];

// ─── Init ────────────────────────────────────────────────────────────
async function dcInit() {
  const sel = document.getElementById('dc-filter-chain');
  if (sel) {
    sel.innerHTML = '<option value="">All Chains</option>' + 
      DC_CHAINS.map(c => '<option value="' + c.name.toLowerCase() + '">' + c.name + '</option>').join('');
  }

  var addr = '';
  try { addr = user().walletAddress || ''; } catch(e) {}

  if (!addr) {
    var intro = document.getElementById('dc-intro');
    if (intro) {
      intro.innerHTML = '<div style="text-align:center;padding:60px">' +
        '<div style="font-size:48px;margin-bottom:12px">🔌</div>' +
        '<div style="font-size:16px;color:var(--gold-light);margin-bottom:8px">Connect wallet to view Data Center</div>' +
        '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a></div>';
    }
    return;
  }

  try {
    var url = '/api/v2/data/usage?walletAddress=' + encodeURIComponent(addr);
    const usage = await afetch(url, { auth: 'none' });
    if (usage && usage.planId) {
      dcPlan = { id: usage.planId, name: usage.planName };
      dcUsage = usage;
      await dcLoadDashboard();
      return;
    }
  } catch (e) {
    console.log('dcInit error:', e.message);
  }
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');
  if (ie) ie.style.display = 'block';
  if (de) de.style.display = 'none';
}

// ─── Subscribe ───────────────────────────────────────────────────────
async function dcSubscribe(planId) {
  const wallet = (typeof user !== 'undefined' && user()?.walletAddress) || '';
  if (!wallet) { showToast('Connect wallet first', 'error'); return; }
  try {
    const resp = await afetch('/api/v2/data/subscribe', {
      method: 'POST', auth: 'none',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': wallet },
      body: JSON.stringify({ planId }),
    });
    if (resp && resp.planId) {
      dcPlan = { id: resp.planId, name: resp.planName };
      dcUsage = { dcApiKey: resp.dcApiKey, dcApiKeyObscured: obscureKey(resp.dcApiKey), planName: resp.planName, monthlyQuota: resp.monthlyQuota || 10000, currentUsage: resp.currentUsage || 0, dailyBreakdown: [] };
      showToast('Data plan activated!', 'success');
      await dcLoadDashboard();
    } else {
      showToast('Subscribe failed — please try again', 'error');
    }
  } catch (e) { showToast('Network error', 'error'); }
}

// ─── Load Dashboard ──────────────────────────────────────────────────
async function dcLoadDashboard() {
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');

  if (dcUsage && dcPlan) {
    if (ie) ie.style.display = 'none';
    if (de) de.style.display = 'block';

    setHtml('dc-plan-name', dcPlan.name);
    setHtml('dc-usage-count', formatNumber(dcUsage.currentUsage || 0));
    setHtml('dc-quota', formatNumber(dcUsage.monthlyQuota || 0));
    var planChains = { data_free: ['Sepolia'], data_pro: ['All 6 chains'], data_enterprise: ['All 6 chains + custom'] };
    setHtml('dc-chains', (planChains[dcPlan.id] || ['—']).join(', '));

    // Chain scan status — card UI
    setHtml('dc-chain-count', DC_CHAINS.length + ' chains');
    setHtml('dc-chain-stats',
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">' +
      DC_CHAINS.map(function(c) {
        return '<div class="chain-card">' +
          '<div class="chain-card-icon"><img src="' + c.img + '" width="36" height="36" alt="' + c.name + '"></div>' +
          '<div class="chain-card-name">' + c.name + '</div>' +
          '<div class="chain-card-status">' +
            '<span class="chain-dot" style="background:#0ecb81"></span> scanning' +
          '</div>' +
          '<div class="chain-card-stats">' +
            '<span class="chain-stat">⛽ 12 Gwei</span>' +
            '<span class="chain-stat">📦 #19.8M</span>' +
          '</div>' +
        '</div>';
      }).join('') +
      '</div>'
    );

    var apiKey = dcUsage?.dcApiKey || '—';
    var ki = document.getElementById('dc-api-key');
    if (ki) ki.value = apiKey;
  } else {
    if (ie) ie.style.display = 'block';
    if (de) de.style.display = 'none';
  }
}

// ─── Explorer ────────────────────────────────────────────────────────
async function dcQueryEvents(pageToken) {
  const chain = document.getElementById('dc-filter-chain')?.value || '';
  const address = document.getElementById('dc-filter-addr')?.value || '';
  const eventType = document.getElementById('dc-filter-type')?.value || '';
  const params = new URLSearchParams();
  if (chain) params.set('chain', chain);
  if (address) params.set('address', address);
  if (eventType) params.set('event_type', eventType);
  params.set('page_size', '20');
  if (pageToken) params.set('page_token', pageToken);
  const tbody = document.getElementById('dc-events-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px">Loading...</td></tr>';
  try {
    const resp = await afetch('/api/v2/data/events?' + params.toString(), { auth: 'none' });
    if (!resp || resp.code !== 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:24px">No results</td></tr>';
      return;
    }
    const { data, next_page_token } = resp;
    dcEventsPageToken = next_page_token;
    if (!data || data.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:24px">No events found</td></tr>';
      return;
    }
    if (tbody) {
      tbody.innerHTML = data.map(function(e) {
        var sf = (e.from_address || '').slice(0, 10) + '...';
        var st = (e.to_address || '').slice(0, 10) + '...';
        var sx = (e.tx_hash || '').slice(0, 8) + '...';
        return '<tr><td><span class="dc-chain-badge dc-chain-' + e.chain + '">' + e.chain + '</span></td><td>' + formatNumber(e.block_number) + '</td><td>' + e.event_type + '</td><td><span class="dc-mono">' + sf + '</span></td><td><span class="dc-mono">' + st + '</span></td><td>' + (e.amount || '—') + ' ' + (e.token_symbol || '') + '</td><td><span class="dc-mono">' + sx + '</span></td></tr>';
      }).join('');
    }
    const pager = document.getElementById('dc-explorer-pager');
    if (pager) {
      pager.innerHTML = next_page_token ? '<button class="btn btn-sm" onclick="dcQueryEvents(\'' + next_page_token + '\')">Next Page →</button>' : '<span style="color:var(--text-muted);font-size:12px">End of results</span>';
    }
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--binance-red,#F6465D)">Query failed</td></tr>';
  }
}

// ─── Copy Key ────────────────────────────────────────────────────────
function dcCopyKey() {
  const input = document.getElementById('dc-api-key');
  if (!input || !input.value || input.value === '—') return;
  navigator.clipboard.writeText(input.value).then(function() { showToast('API Key copied', 'success'); });
}

// ─── Tab Switch ──────────────────────────────────────────────────────
function dcSwitchTab(sub) {
  document.querySelectorAll('#dc-dash .tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('#dc-dash .sub-panel').forEach(function(p) { p.classList.remove('active'); });
  const btn = document.querySelector('#dc-dash [data-sub="' + sub + '"]');
  const panel = document.getElementById('sub-' + sub);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');
}

// ─── Helpers ─────────────────────────────────────────────────────────
function formatNumber(n) { return n == null ? '—' : Number(n).toLocaleString(); }
function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

// ─── Register ────────────────────────────────────────────────────────
(function() {
  document.addEventListener('click', function(e) {
    const btn = e.target.closest('#dc-dash .tab-btn');
    if (btn) { var s = btn.getAttribute('data-sub'); if (s) dcSwitchTab(s); }
  });
})();
