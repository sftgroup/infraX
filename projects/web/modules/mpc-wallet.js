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
    if (document.getElementById('sub-mpc-dash').classList.contains('active')) mpcDash();
  } else {
    document.getElementById("mpc-intro").style.display = "block";
    document.getElementById("mpc-dashboard-area").style.display = "none";
  }
}

async function mpcActivate() {
  // Switch to register form so user can enter verification code
  document.getElementById("mpc-intro").style.display = "none";
  document.getElementById("mpc-dashboard-area").style.display = "block";
  // Pre-fill email and auto-send code
  mpcEmail = user().walletAddress + "@mpc.infrax.local";
  document.getElementById("mpc-reg-email").value = mpcEmail;
  var tabs = document.querySelectorAll('#page-mpc .tab-btn');
  tabs.forEach(function(t) { t.classList.remove('active'); });
  document.querySelector('#page-mpc .tab-btn[data-sub="mpc-reg"]').classList.add('active');
  var panels = document.querySelectorAll('#mpc-dashboard-area .sub-panel');
  panels.forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('sub-mpc-reg').classList.add('active');
  // Auto-send verification code
  try {
    await afetch('/api/v2/mpc/send-code', { auth: 'none', method: 'POST', body: { email: mpcEmail } });
    showToast('Code sent — check server logs', 'info');
    var codeInput = document.getElementById('mpc-reg-code');
    var createBtn = document.getElementById('mpc-reg-btn');
    codeInput.disabled = false; codeInput.placeholder = 'Enter 6-digit code'; codeInput.focus();
    createBtn.disabled = false;
  } catch (e) { showToast(e.message, 'error'); }
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
  } catch (e) { showToast(e.message, 'error'); }
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
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.classList.remove('btn-loading'); }
}
function mpcRec() {}

// ── Dashboard ──

async function mpcDash() {
  var grid = document.getElementById('mpc-bal-card'); if (!grid) return;
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
}

// ── Send ──

function mpcSendLoad() {
  document.getElementById('mpc-send-from').textContent = mpcCurrentAddr ? fmtAddrLong(mpcCurrentAddr) : '—';
}

async function mpcSend() {
  var to = document.getElementById('mpc-send-to').value.trim();
  var amt = document.getElementById('mpc-send-amt').value.trim();
  var btn = document.getElementById('mpc-send-btn');
  if (!to || !amt) return showToast('Fill all fields', 'error');
  btn.classList.add('btn-loading');
  try { await afetch('/api/v2/tx/send', { method: 'POST', body: { to: to, value: amt, chain: activeChain } }); showToast('Transaction sent ⚡ Gas sponsored', 'success'); }
  catch (e) { showToast(e.message, 'error'); }
  finally { btn.classList.remove('btn-loading'); }
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