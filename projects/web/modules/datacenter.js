/**
 * InfraX Data Center — B2B On-chain Data API Module
 * Dependencies: core.js, infrax.css
 */

function obscureKey(key) { return key && key.length > 16 ? key.slice(0,14) + '…' + key.slice(-8) : key; }

// ─── State ───────────────────────────────────────────────────────────
let dcPlan = null;
let dcUsage = null;
let dcEventsPageToken = null;

// ─── Init ────────────────────────────────────────────────────────────
async function dcInit() {
  // Load chain list for filter
  const chains = ['sepolia', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'base'];
  const sel = document.getElementById('dc-filter-chain');
  if (sel) {
    sel.innerHTML = '<option value="">All Chains</option>' + 
      chains.map(c => `<option value="${c}">${c[0].toUpperCase()+c.slice(1)}</option>`).join('');
  }

  // Check if user has an active Data Center plan
  try {
    const usage = await afetch('/api/v2/data/usage', { method: 'GET', auth: 'wallet' });
    var ud = usage && usage.data ? usage.data : usage;
    if (ud && ud.planId) {
      dcPlan = { id: ud.planId, name: ud.planName };
      dcUsage = ud;
      await dcLoadDashboard();
      return;
    }
  } catch (e) {
    console.log('dcInit: no plan');
  }
  // Show intro page
  const introEl = document.getElementById('dc-intro');
  const dashEl = document.getElementById('dc-dash');
  if (introEl) { introEl.style.display = 'block'; }
  if (dashEl) { dashEl.style.display = 'none'; }
}

// ─── Subscribe ───────────────────────────────────────────────────────
async function dcSubscribe(planId) {
  const wallet = (typeof user !== 'undefined' && user()?.walletAddress) || '';
  if (!wallet) {
    showToast('Connect wallet first', 'error');
    return;
  }

  try {
    const resp = await afetch('/api/v2/data/subscribe', {
      method: 'POST',
      auth: 'none',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': wallet },
      body: JSON.stringify({ planId }),
    });
    
    var r = resp && resp.data ? resp.data : resp;
    if (r && r.planId) {
      dcPlan = { id: r.planId, name: r.planName };
      dcUsage = { dcApiKey: r.dcApiKey, dcApiKeyObscured: obscureKey(r.dcApiKey), planName: r.planName, monthlyQuota: r.monthlyQuota || 10000, currentUsage: r.currentUsage || 0, dailyBreakdown: [] };
      showToast('Data plan activated!', 'success');
      await dcLoadDashboard();
    } else {
      showToast('Subscribe failed — please try again', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  }
}

// ─── Load Dashboard ──────────────────────────────────────────────────
async function dcLoadDashboard() {
  
  const introEl = document.getElementById('dc-intro');
  const dashEl = document.getElementById('dc-dash');

  try {
    const wallet = (typeof user !== 'undefined' && user()?.walletAddress) || '';
    const resp = await afetch(`/api/v2/data/usage?walletAddress=${encodeURIComponent(wallet)}`, { auth: 'wallet' });
    var r = resp && resp.data ? resp.data : resp;

    if (r && r.planId) {
      dcUsage = r;
      dcPlan = { id: r.planId, name: r.planName };
      
      // Show dashboard
      if (introEl) introEl.style.display = 'none';
      if (dashEl) dashEl.style.display = 'block';

      // Populate info cards
      setHtml('dc-plan-name', dcPlan.name);
      setHtml('dc-usage-count', formatNumber(dcUsage.currentUsage || 0));
      setHtml('dc-quota', formatNumber(dcUsage.monthlyQuota || 0));

      // Determine active chains
      const planChains = { data_free: ['Sepolia'], data_pro: ['All 7 chains'], data_enterprise: ['All 7 chains + custom'] };
      setHtml('dc-chains', (planChains[dcPlan.id] || ['—']).join(', '));

      // API Key
      const apiKey = dcUsage?.dcApiKey || '—';
      const keyInput = document.getElementById('dc-api-key');
      if (keyInput) keyInput.value = apiKey;
    } else {
      // No plan — show intro
      if (introEl) introEl.style.display = 'block';
      if (dashEl) dashEl.style.display = 'none';
    }
  } catch (e) {
    // Show intro on error
    if (introEl) introEl.style.display = 'block';
    if (dashEl) dashEl.style.display = 'none';
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
    const resp = await afetch('/api/v2/data/events?' + params.toString());
    if (!resp || resp.code !== 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--binance-text-tertiary,#5e6673);text-align:center;padding:24px">No results</td></tr>';
      return;
    }

    const { data, next_page_token } = resp;
    dcEventsPageToken = next_page_token;

    if (!data || data.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--binance-text-tertiary,#5e6673);text-align:center;padding:24px">No events found</td></tr>';
      return;
    }

    if (tbody) {
      tbody.innerHTML = data.map(e => {
        const shortFrom = (e.from_address || '').slice(0, 10) + '...';
        const shortTo = (e.to_address || '').slice(0, 10) + '...';
        const shortTx = (e.tx_hash || '').slice(0, 8) + '...';
        return `<tr>
          <td><span class="dc-chain-badge dc-chain-${e.chain}">${e.chain}</span></td>
          <td>${formatNumber(e.block_number)}</td>
          <td>${e.event_type}</td>
          <td><span class="dc-mono">${shortFrom}</span></td>
          <td><span class="dc-mono">${shortTo}</span></td>
          <td>${e.amount || '—'} ${e.token_symbol || ''}</td>
          <td><span class="dc-mono">${shortTx}</span></td>
        </tr>`;
      }).join('');
    }

    // Pager
    const pager = document.getElementById('dc-explorer-pager');
    if (pager) {
      pager.innerHTML = next_page_token
        ? `<button class="btn btn-sm" onclick="dcQueryEvents('${next_page_token}')">Next Page →</button>`
        : '<span style="color:var(--binance-text-tertiary,#5e6673);font-size:12px">End of results</span>';
    }
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--binance-red,#F6465D)">Query failed</td></tr>';
  }
}

// ─── Copy Key ────────────────────────────────────────────────────────
function dcCopyKey() {
  const input = document.getElementById('dc-api-key');
  if (!input || !input.value || input.value === '—') return;
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('API Key copied', 'success');
  });
}

// ─── Tab Switch ──────────────────────────────────────────────────────
function dcSwitchTab(sub) {
  document.querySelectorAll('#dc-dash .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#dc-dash .sub-panel').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`#dc-dash [data-sub="${sub}"]`);
  const panel = document.getElementById('sub-' + sub);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');

  if (sub === 'dc-explorer' && !dcEventsPageToken && document.getElementById('dc-events-tbody')?.innerHTML.includes('Enter filters')) {
    // Don't auto-search; wait for user
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────
function formatNumber(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ─── Register module loader in core.js ───────────────────────────────
(function registerDC() {
  // Hook into infrax module system
  // Registered via core.js loaders map

  // Hook tab clicks in DC dash
  document.addEventListener('click', function(e) {
    const btn = e.target.closest('#dc-dash .tab-btn');
    if (btn) {
      const sub = btn.getAttribute('data-sub');
      if (sub) dcSwitchTab(sub);
    }
  });
})();
