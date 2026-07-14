// MODULE 5: Payment — B2B2C Unified Payment
// ============================================================

// paymentEnabled (IIFE scoped)
function paymentInit() {
  if (paymentEnabled) {
    document.getElementById('payment-intro').style.display = 'none';
    document.getElementById('payment-dashboard-area').style.display = 'block';
  } else {
    document.getElementById('payment-intro').style.display = 'block';
    document.getElementById('payment-dashboard-area').style.display = 'none';
  }
}

function paymentEnable() {
  paymentEnabled = true;
  document.getElementById('payment-intro').style.display = 'none';
  document.getElementById('payment-dashboard-area').style.display = 'block';
  showToast('Payment module enabled!', 'success');
}

function paymentMethodChange() {
  var m = document.getElementById('pay-method').value;
  var chainEl = document.getElementById('pay-chain');
  chainEl.disabled = m === 'stripe' || m === 'x402';
  if (m === 'stripe') chainEl.value = '-';
  else chainEl.value = 'sepolia';
}

async function paymentCreateOrder() {
  var amount = parseFloat(document.getElementById('pay-amount').value);
  var method = document.getElementById('pay-method').value;
  var desc = document.getElementById('pay-desc').value.trim();
  var chain = document.getElementById('pay-chain').value;

  if (!amount || amount <= 0) return showToast('Enter amount', 'error');

  var url = method === 'x402' ? '/api/v2/payment/x402/request' : '/api/v2/payment/create-order';

  try {
    var d = await afetch(url, {
      method: 'POST',
      body: { amount: amount, description: desc, paymentMethod: method, chain: chain }
    });
    var html = '<div class="panel"><div class="panel-header">Order Created</div><div class="panel-body">' +
      '<div style="margin-bottom:8px">Order ID: <code>' + d.orderId + '</code></div>' +
      '<div style="margin-bottom:8px">Status: <b style="color:var(--warning)">' + d.status + '</b></div>' +
      '<div style="margin-bottom:8px">Amount: $' + d.amount + ' ' + d.currency + '</div>';

    if (d.status === 'payment_required') {
      html += '<div style="margin-top:12px;padding:12px;background:rgba(251,191,36,0.1);border:1px solid var(--gold-light);border-radius:8px">' +
        '<div style="font-weight:600;color:var(--gold-light);margin-bottom:4px">⚡ x402 Payment Required (HTTP 402)</div>' +
        '<div style="font-size:11px;color:var(--text-muted);line-height:1.5">' +
        'Send <b>' + d.amount + ' ' + d.token + '</b> on <b>' + d.network + '</b> → <code style="font-size:10px;word-break:break-all">' + (d.recipientAddress || '—') + '</code>' +
        '<br>Expires: ' + (d.expiresAt || '15 min') +
        '<br><br>Include <code>X-PAYMENT</code> header with signed tx in next request.</div></div>';
    } else if (d.qrAddress) {
      html += '<div style="margin-bottom:12px"><label>Send to Address</label>' +
        '<div class="addr-pill" style="word-break:break-all;font-size:12px">' + d.qrAddress + '</div>' +
        '<div style="margin-top:8px">Amount: <b>' + d.qrAmount + ' ETH</b> on ' + d.qrChain + '</div></div>';
    }

    html += '<div style="margin-top:8px"><a href="' + (d.payUrl || '#') + '" target="_blank" style="color:var(--text-brand)">Open Payment Page →</a></div>' +
      '</div></div>';
    document.getElementById('pay-result').innerHTML = html;
    showToast('Order created: ' + d.orderId, 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function paymentLoadHistory() {
  var el = document.getElementById('pay-history-list');
  try {
    var d = await afetch('/api/v2/payment/orders');
    var orders = d.orders || [];
    if (!orders.length) {
      el.innerHTML = '<div class="empty"><div class="empty-text">No orders yet</div></div>';
      return;
    }
    el.innerHTML = orders.map(function(o) {
      var sc = o.status === 'paid' ? 'var(--success)' : 'var(--warning)';
      var icon = o.paymentMethod === 'stripe' ? '💳' : o.paymentMethod === 'wallet' ? '🔐' : '📱';
      return '<div class="card" style="padding:12px 16px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><div style="font-weight:600">' + icon + ' $' + o.amount + ' ' + o.currency + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted)">' + (o.description || '') + '</div></div>' +
        '<div style="text-align:right"><div style="font-size:12px;font-weight:600;color:' + sc + '">' + o.status.toUpperCase() + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted)">' + (o.createdAt || '') + '</div></div>' +
        '</div></div>';
    }).join('');
  } catch (e) { el.innerHTML = '<div class="empty" style="color:var(--error)">Failed to load</div>'; }
}

async function paymentLoadMethods() {
  var el = document.getElementById('pay-methods-info');
  try {
    var d = await afetch('/api/v2/payment/methods');
    var methods = d.methods || [];
    el.innerHTML = methods.map(function(m) {
      return '<div class="card" style="padding:16px;margin-bottom:10px">' +
        '<div style="font-size:16px;font-weight:600;margin-bottom:4px">' + m.icon + ' ' + m.name + '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">' + m.description + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted)">' +
        'Range: ' + m.minAmount + ' - ' + m.maxAmount + ' ' + m.currency +
        (m.chains ? ' | Chains: ' + m.chains.join(', ') : '') +
        '</div></div>';
    }).join('');
  } catch (e) { el.innerHTML = '<div class="empty" style="color:var(--error)">Failed to load</div>'; }
}
