// MODULE 2: MPC Wallet — Intro-first flow (DB-backed, no localStorage)

// MPC state: loaded from API (getMe)
// mpcCurrentEmail (IIFE scoped)
// mpcCurrentAddr (IIFE scoped)
// mpcActivated (IIFE scoped)
async function mpcInit() {
  // Check if we have an MPC wallet by walletAddress
  var me = await getMe();
  if (me.mpc && me.mpc.walletAddress) {
    mpcCurrentAddr = me.mpc.walletAddress;
    mpcCurrentEmail = me.mpc.email || '';
    mpcActivated = true;
  }
  if (mpcActivated) {
    document.getElementById("mpc-intro").style.display = "none";
    document.getElementById("mpc-dashboard-area").style.display = "block";
    // Auto-switch to Dashboard tab for already-activated users
    var tabs = document.querySelectorAll('#page-mpc .tab-btn');
    tabs.forEach(function(t) { t.classList.remove('active'); });
    var dashTab = document.querySelector('#page-mpc .tab-btn[data-sub="mpc-dash"]');
    if (dashTab) dashTab.classList.add('active');
    var panels = document.querySelectorAll('#mpc-dashboard-area .sub-panel');
    panels.forEach(function(p) { p.classList.remove('active'); });
    var dashPanel = document.getElementById('sub-mpc-dash');
    if (dashPanel) dashPanel.classList.add('active');
    mpcDash();
  } else {
    document.getElementById("mpc-intro").style.display = "block";
    document.getElementById("mpc-dashboard-area").style.display = "none";
  }
}

async function mpcActivate() {
  // Switch to register form — user fills in email and receives verification code
  document.getElementById("mpc-intro").style.display = "none";
  document.getElementById("mpc-dashboard-area").style.display = "block";
  // Clear email field, let user fill it in
  document.getElementById("mpc-reg-email").value = "";
  // Activate Register tab
  var tabs = document.querySelectorAll('#page-mpc .tab-btn');
  tabs.forEach(function(t) { t.classList.remove('active'); });
  document.querySelector('#page-mpc .tab-btn[data-sub="mpc-reg"]').classList.add('active');
  var panels = document.querySelectorAll('#mpc-dashboard-area .sub-panel');
  panels.forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('sub-mpc-reg').classList.add('active');
  document.getElementById('mpc-reg-email').focus();
}

// ── Register ──

// mpcEmail (IIFE scoped)
async function mpcSendCode() {
  mpcEmail = document.getElementById('mpc-reg-email').value.trim();
  if (!mpcEmail) return showToast('Enter email', 'error');
  try {
    await afetch('/api/v2/mpc/send-code', { auth: 'none', method: 'POST', body: { email: mpcEmail } });
    showToast('Code sent - check server logs', 'info');
    var codeInput = document.getElementById('mpc-reg-code');
    var createBtn = document.getElementById('mpc-reg-btn');
    codeInput.disabled = false; codeInput.placeholder = 'Enter 6-digit code'; codeInput.focus();
    createBtn.disabled = false;
  } catch (e) { showToast(e.message, 'error'); }
}

async function mpcRegister() {
  var code = document.getElementById('mpc-reg-code').value.trim();
  if (!code) return showToast('Enter code', 'error');
  var btn = document.getElementById('mpc-reg-btn'); btn.classList.add('btn-loading');
  try {
    var d = await afetch('/api/v2/mpc/register', { auth: 'none', method: 'POST', body: { email: mpcEmail, code: code, walletAddress: user().walletAddress } });
    mpcCurrentAddr = d.walletAddress;
    mpcCurrentEmail = mpcEmail;
    mpcActivated = true; clearMe();
    var r = document.getElementById('mpc-reg-result'); r.className = 'result-box show success';
    r.innerHTML = '<div class="title" style="color:var(--success)">✅ Wallet Created</div><div class="mono" style="color:var(--gold-light)">' + d.walletAddress + '</div><div class="card-sub">Use email to recover anytime</div>';
  } catch (e) {
    if (e.message && e.message.indexOf('already registered') !== -1) {
      showToast('Email already registered — switch to Recover tab', 'warning');
      document.querySelector('#page-mpc .tab-btn[data-sub="mpc-rec"]').click();
      document.getElementById('mpc-rec-email').value = mpcEmail;
    } else {
      showToast(e.message, 'error');
    }
  }
  finally { btn.classList.remove('btn-loading'); }
}

function mpcReg() {} // placeholder, form already rendered

// ── Recover ──

async function mpcRecSendCode() {
  mpcEmail = document.getElementById('mpc-rec-email').value.trim();
  if (!mpcEmail) return showToast('Enter email', 'error');
  try {
    await afetch('/api/v2/mpc/send-code', { auth: 'none', method: 'POST', body: { email: mpcEmail } });
    showToast('Code sent - check server logs', 'info');
    var codeInput = document.getElementById('mpc-rec-code');
    var recoverBtn = document.getElementById('mpc-rec-btn');
    codeInput.disabled = false; codeInput.placeholder = 'Enter 6-digit code'; codeInput.focus();
    recoverBtn.disabled = false;
  } catch (e) { showToast(e.message, 'error'); }
}

async function mpcRecover() {
  var code = document.getElementById('mpc-rec-code').value.trim();
  if (!code) return showToast('Enter code', 'error');
  var btn = document.getElementById('mpc-rec-btn'); btn.classList.add('btn-loading');
  try {
    var d = await afetch('/api/v2/mpc/recover', { auth: 'none', method: 'POST', body: { email: mpcEmail, code: code, walletAddress: user().walletAddress } });
    mpcCurrentAddr = d.walletAddress;
    mpcCurrentEmail = mpcEmail;
    mpcActivated = true; clearMe();
    var r = document.getElementById('mpc-rec-result'); r.className = 'result-box show';
    r.style.borderColor = 'var(--warning)';
    r.innerHTML = '<div class="title" style="color:var(--success)">🔓 Wallet Recovered</div><div class="mono" style="color:var(--gold-light)">' + d.walletAddress + '</div><div class="card-sub">Your MPC wallet signing capability has been restored</div>';
    // Auto-switch to Dashboard after 1.5s
    setTimeout(function() {
      document.querySelector('#page-mpc .tab-btn[data-sub="mpc-dash"]').click();
    }, 1500);
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.classList.remove('btn-loading'); }
}
function mpcRec() {}

// ── Dashboard ──

async function mpcDash() {
  var grid = document.getElementById('mpc-bal-addr'); if (!grid) return;
  if (!mpcCurrentAddr) { grid.innerHTML = '<div class="kpi-val" style="font-size:16px">No MPC wallet yet</div><div class="kpi-sub">Register or Recover to create one</div>'; return; }
  try {
    var bal = await afetch('/api/v2/wallet/balance?nc=true'); var totalNative = 0;
    var w = (bal.chainBalances || [])[0];
    var eth = '0';
    if (w && w.balances) { var b = w.balances.find(function (x) { return x.token === 'ETH'; }); if (b) eth = parseFloat(b.balance || 0).toFixed(4); }
    document.getElementById('mpc-bal-addr').textContent = fmtAddrLong(mpcCurrentAddr);
    document.getElementById('mpc-bal-val').textContent = eth + ' ETH';
    document.getElementById('mpc-status').innerHTML = '🟢 Active';
  } catch (e) {
    document.getElementById('mpc-bal-addr').textContent = fmtAddrLong(mpcCurrentAddr);
    document.getElementById('mpc-bal-val').textContent = '0 ETH';
    document.getElementById('mpc-status').innerHTML = '🟢 Active';
  }
  // WSG-3: 计费模式展示（/api/v2/mpc/plans → mode/configured；fail-silent）
  try {
    var mpcP = await afetch('/api/v2/mpc/plans', { auth: 'none' });
    if (mpcP) {
      var modeTxt = mpcP.mode === 'metered' ? I18N.t('mpc_usage_metered') : I18N.t('mpc_usage_free');
      document.getElementById('mpc-status').innerHTML = '🟢 Active · ' + I18N.t('mpc_usage_mode') + ': ' + modeTxt;
    }
  } catch (e2) {}
}

// ── Send ──

// mpcSendState tracks the two-step send flow: 'idle' → 'awaiting_code' → 'sending'
var mpcSendState = 'idle';

function mpcSendLoad() {
  document.getElementById('mpc-send-from').textContent = mpcCurrentAddr ? fmtAddrLong(mpcCurrentAddr) : '—';
  // Reset send form
  mpcSendState = 'idle';
  document.getElementById('mpc-send-code-row').style.display = 'none';
  document.getElementById('mpc-send-code').value = '';
  document.getElementById('mpc-send-to').value = '';
  document.getElementById('mpc-send-amt').value = '';
  document.getElementById('mpc-send-btn').textContent = 'Send';
}

async function mpcSend() {
  var to = document.getElementById('mpc-send-to').value.trim();
  var amt = document.getElementById('mpc-send-amt').value.trim();
  var btn = document.getElementById('mpc-send-btn');

  if (!to || !amt) return showToast('Fill all fields', 'error');
  if (!mpcCurrentEmail) return showToast('MPC wallet not set up — Register or Recover first', 'error');

  // ── Step 1: Request verification code ──
  if (mpcSendState === 'idle') {
    btn.classList.add('btn-loading');
    btn.textContent = 'Requesting code...';
    try {
      await afetch('/api/v2/mpc/send-code', { auth: 'none', method: 'POST', body: { email: mpcCurrentEmail } });
      mpcSendState = 'awaiting_code';
      document.getElementById('mpc-send-code-row').style.display = 'block';
      document.getElementById('mpc-send-code').focus();
      btn.textContent = 'Verify & Send';
      showToast('Code sent — check server logs (dev: 888888)', 'info');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      btn.classList.remove('btn-loading');
    }
    return;
  }

  // ── Step 2: Verify code → unlock session → send tx → lock session ──
  if (mpcSendState === 'awaiting_code') {
    var code = document.getElementById('mpc-send-code').value.trim();
    if (!code) return showToast('Enter verification code', 'error');

    btn.classList.add('btn-loading');
    btn.textContent = 'Sending...';
    var token = null;

    try {
      // 2a. Unlock MPC session
      var unlockResp = await afetch('/api/v2/mpc/session/unlock', {
        auth: 'none', method: 'POST',
        body: { email: mpcCurrentEmail, code: code }
      });
      token = unlockResp.token;
      if (!token) throw new Error('No session token received');

      // 2b. Send transaction through MPC
      var txResp = await afetch('/api/v2/mpc/send-transaction', {
        auth: 'none', method: 'POST',
        body: { token: token, to: to, amount: amt, chain: activeChain }
      });

      showToast('Transaction sent ⚡ ' + (txResp.txHash ? fmtAddrLong(txResp.txHash) : 'OK'), 'success');

      // Reset form
      mpcSendState = 'idle';
      document.getElementById('mpc-send-code-row').style.display = 'none';
      document.getElementById('mpc-send-code').value = '';
      document.getElementById('mpc-send-to').value = '';
      document.getElementById('mpc-send-amt').value = '';
      btn.textContent = 'Send';

    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      // 2c. Always lock session after attempt
      if (token) {
        try { await afetch('/api/v2/mpc/session/lock', { auth: 'none', method: 'POST', body: { token: token } }); } catch (_) {}
      }
      btn.classList.remove('btn-loading');
    }
  }
}

// ── Receive ──

function mpcReceiveLoad() {
  document.getElementById('mpc-recv-addr').textContent = mpcCurrentAddr || '—';
  document.getElementById('mpc-recv-full').textContent = mpcCurrentAddr || '—';
  // Generate QR code
  var qrCanvas = document.getElementById('mpc-recv-qr');
  if (mpcCurrentAddr && qrCanvas) {
    try {
      var qr = new QRious({ element: qrCanvas, value: "ethereum:" + mpcCurrentAddr, size: 200 });
    } catch(e) { qrCanvas.style.display = 'none'; }
  }
}
function mpcCopyAddr() { if (mpcCurrentAddr) copyText(mpcCurrentAddr); else showToast('No MPC wallet', 'warning'); }

// ═══════════════════════════════════════════════
// ============================================================