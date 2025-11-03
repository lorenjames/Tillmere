// reports.js
const ipcRenderer = (window.require && window.require('electron') && window.require('electron').ipcRenderer) || window.ipcRenderer;
if (!ipcRenderer) {
    alert('Electron ipcRenderer not available. Ensure nodeIntegration:true or a preload exposing ipcRenderer.');
}
console.log('[reports] script loaded');
window.addEventListener('error', e => console.error('[reports] error:', e.message));

const money = n => Number(n || 0).toFixed(2);
const esc = s => String(s || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

let receipts = [];
let vendors = [];
let vendorByCode = new Map();

const TENDERS = ['Cash', 'Card', 'Check', 'Gift Card'];
const normalizeTender = (t) => {
    t = String(t || '').trim();
    return TENDERS.includes(t) ? t : 'Other';
};


/** RENAMED: avoid conflict with Bootstrap's global `window.bootstrap` */
async function initReports() {
    let bundle;
    try {
        // one round-trip for speed
        bundle = await ipcRenderer.invoke('state:bootstrap');
    } catch {
        // fallback if state:bootstrap not present
        const v = await ipcRenderer.invoke('vendors:load');
        const r = await ipcRenderer.invoke('receipts:load');
        bundle = { vendors: v, cashiers: [], receipts: r };
    }

    vendors = Array.isArray(bundle.vendors) ? bundle.vendors : [];
    receipts = Array.isArray(bundle.receipts) ? bundle.receipts : [];

    vendorByCode = new Map(
        vendors
            .filter(v => v.code)
            .map(v => [String(v.code).trim().toLowerCase(), v])
    );

    // default dates: last 30 days
    // default dates: full current calendar month
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth(); // 0 = Jan

    // First day of current month (local)
    const from = new Date(y, m, 1);

    // Last day of current month (local)
    const to = new Date(y, m + 1, 0);

    // Format YYYY-MM-DD in local time (avoid UTC off-by-one)
    const fmtLocal = d =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    document.getElementById('fromDate')?.setAttribute('value', fmtLocal(from));
    document.getElementById('toDate')?.setAttribute('value', fmtLocal(to));


    runReport();
}

function runReport() {
    const fromVal = document.getElementById('fromDate').value;
    const toVal = document.getElementById('toDate').value;
    const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
    const to = toVal ? new Date(toVal + 'T23:59:59') : null;

    const bucket = new Map(); // key -> { code,name, cash,card,check,gift,other,gross,count }

    receipts.forEach(r => {
        if (r.voided) return;
        const when = r.datetime ? new Date(r.datetime) : null;
        if (from && when && when < from) return;
        if (to && when && when > to) return;

        const tender = normalizeTender(r.payment);
        (r.items || []).forEach(it => {
            const code = String(it.vendorCode || '').trim();
            let key = code;
            let name = '';

            if (code) {
                const v = vendorByCode.get(code.toLowerCase());
                name = v?.name || '';
            } else {
                name = String(it.vendor || '').trim();
                key = name || '(Unassigned)';
            }

            let rec = bucket.get(key);
            if (!rec) {
                rec = {
                    code: code || '', name,
                    cash: 0, card: 0, check: 0, gift: 0, other: 0,
                    gross: 0, count: 0
                };
            }

            const price = Number(it.price || 0);
            rec.gross += price;
            rec.count += 1;
            if (tender === 'Cash') rec.cash += price;
            else if (tender === 'Card') rec.card += price;
            else if (tender === 'Check') rec.check += price;
            else if (tender === 'Gift Card') rec.gift += price;
            else rec.other += price;

            // prefer known vendor name
            if (!rec.name && name) rec.name = name;

            bucket.set(key, rec);
        });
    });

    const rows = Array.from(bucket.values())
        .sort((a, b) => (a.name || a.code || '').localeCompare(b.name || b.code || ''));

    const tbody = document.getElementById('reportBody');
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();

    let totCash = 0, totCard = 0, totCheck = 0, totGift = 0, totOther = 0, grandGross = 0, grandCount = 0;

    rows.forEach(r => {
        totCash += r.cash;
        totCard += r.card;
        totCheck += r.check;
        totGift += r.gift;
        totOther += r.other;
        grandGross += r.gross;
        grandCount += r.count;

        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td>${esc(r.code || '')}</td>
      <td>${esc(r.name || '')}</td>
      <td class="text-end">$${money(r.cash)}</td>
      <td class="text-end">$${money(r.card)}</td>
      <td class="text-end">$${money(r.check)}</td>
      <td class="text-end">$${money(r.gift)}</td>
      <td class="text-end">$${money(r.other)}</td>
      <td class="text-end">$${money(r.gross)}</td>
      <td class="text-end">${r.count}</td>
    `;
        frag.appendChild(tr);
    });

    tbody.appendChild(frag);
    document.getElementById('totCash').textContent = `$${money(totCash)}`;
    document.getElementById('totCard').textContent = `$${money(totCard)}`;
    document.getElementById('totCheck').textContent = `$${money(totCheck)}`;
    document.getElementById('totGift').textContent = `$${money(totGift)}`;
    document.getElementById('totOther').textContent = `$${money(totOther)}`;
    document.getElementById('grandTotal').textContent = `$${money(grandGross)}`;
    document.getElementById('grandCount').textContent = String(grandCount);

    // --- Build Credit Card Fee section (5% of gross card sales per vendor) ---
    const feeTbody = document.getElementById('cardFeeBody');
    if (feeTbody) {
        feeTbody.innerHTML = '';
        const feeFrag = document.createDocumentFragment();
        let feeTot = 0;
        // show only vendors with card > 0 for a tidy report
        rows.filter(r => r.card > 0).forEach(r => {
            const fee = Number(r.card) * 0.05;
            feeTot += fee;
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${esc(r.code || '')}</td>
              <td>${esc(r.name || '')}</td>
              <td class="text-end">$${money(r.card)}</td>
              <td class="text-end">$${money(fee)}</td>
            `;
            feeFrag.appendChild(tr);
        });
        feeTbody.appendChild(feeFrag);
        const feeTotCardEl = document.getElementById('feeTotCard');
        const feeTotAmountEl = document.getElementById('feeTotAmount');
        if (feeTotCardEl) feeTotCardEl.textContent = `$${money(totCard)}`;
        if (feeTotAmountEl) feeTotAmountEl.textContent = `$${money(feeTot)}`;
    }

    // Build the detailed per-vendor section
    try { runDetailedReport(); } catch (e) { console.error('[reports] detailed failed:', e); }
}


// Detailed Sales by Vendor (respects same date filters)
function runDetailedReport() {
    const fromVal = document.getElementById('fromDate')?.value;
    const toVal = document.getElementById('toDate')?.value;
    const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
    const to = toVal ? new Date(toVal + 'T23:59:59') : null;

    const container = document.getElementById('detailedReport');
    if (!container) return;
    container.innerHTML = '';

    const groups = new Map();

    receipts.forEach(r => {
        if (r.voided) return;
        const when = r.datetime ? new Date(r.datetime) : null;
        if (from && when && when < from) return;
        if (to && when && when > to) return;
        const tender = normalizeTender(r.payment);

        (r.items || []).forEach(it => {
            const code = String(it.vendorCode || '').trim();
            let key = code;
            let name = '';
            if (code) {
                const v = vendorByCode.get(code.toLowerCase());
                name = v?.name || '';
            } else {
                name = String(it.vendor || '').trim();
                key = name || '(Unassigned)';
            }

            let g = groups.get(key);
            if (!g) {
                g = { code: code || '', name, cash: 0, card: 0, check: 0, gift: 0, other: 0, gross: 0, count: 0, items: [] };
            }

            const price = Number(it.price || 0);
            g.gross += price;
            g.count += 1;
            if (tender === 'Cash') g.cash += price;
            else if (tender === 'Card') g.card += price;
            else if (tender === 'Check') g.check += price;
            else if (tender === 'Gift Card') g.gift += price;
            else g.other += price;
            if (!g.name && name) g.name = name;

            g.items.push({ datetime: when, number: r.number || '', item: it.name || '', price, tender });
            groups.set(key, g);
        });
    });

    const list = Array.from(groups.values()).sort((a, b) => (a.name || a.code || '').localeCompare(b.name || b.code || ''));

    if (!list.length) {
        container.innerHTML = '<div class="text-muted">No sales for the selected period.</div>';
        return;
    }

    const moneyStr = n => `$${money(n)}`;
    const frag = document.createDocumentFragment();

    list.forEach(g => {
        const fee = Number(g.card) * 0.05;
        const rowsHtml = g.items
            .slice()
            .sort((a, b) => (a.datetime?.getTime?.() || 0) - (b.datetime?.getTime?.() || 0))
            .map(it => `
              <tr>
                <td>${it.datetime ? esc(new Date(it.datetime).toLocaleString()) : ''}</td>
                <td><a href="#" class="detail-receipt-link" data-id="${esc(String(it.number || ''))}">${esc(String(it.number || ''))}</a></td>
                <td>${esc(String(it.item || ''))}</td>
                <td class="text-end">${esc(String(it.tender || ''))}</td>
                <td class="text-end">${moneyStr(it.price)}</td>
              </tr>
            `).join('');

        const wrap = document.createElement('div');
        wrap.innerHTML = `
          <div class="border rounded p-3">
            <div class="d-flex justify-content-between align-items-baseline mb-2">
              <div><strong>${esc(g.code || '')}</strong> - ${esc(g.name || '')}</div>
              <div class="text-muted small">Items: ${g.count} | Gross: ${moneyStr(g.gross)}</div>
            </div>
            <div class="table-responsive">
              <table class="table table-sm table-striped mb-2">
                <thead class="table-light">
                  <tr>
                    <th>Date/Time</th>
                    <th>Receipt #</th>
                    <th>Item</th>
                    <th class="text-end">Tender</th>
                    <th class="text-end">Price ($)</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml || '<tr><td colspan="5" class="text-muted">No items.</td></tr>'}</tbody>
              </table>
            </div>
            <div class="small">
              <strong>Totals:</strong>
              Cash ${moneyStr(g.cash)} |
              Card ${moneyStr(g.card)} |
              Check ${moneyStr(g.check)} |
              Gift ${moneyStr(g.gift)} |
              Other ${moneyStr(g.other)} |
              Gross ${moneyStr(g.gross)} |
              Items ${g.count} |
              Credit Fee (5% of Card) ${moneyStr(fee)}
            </div>
          </div>`;
        frag.appendChild(wrap.firstElementChild);
    });

    container.appendChild(frag);

    // click handlers for receipt links
    container.querySelectorAll('.detail-receipt-link').forEach(el => {
        el.addEventListener('click', async (e) => {
            e.preventDefault();
            const id = el.getAttribute('data-id');
            if (!id) return;
            try {
                const r = await ipcRenderer.invoke('receipts:get', id);
                if (!r) { alert(`Receipt not found for id: ${id}`); return; }
                openReceiptWindowFromReports(r);
            } catch (err) {
                console.error('[reports] open receipt failed', err);
                alert('Open failed: ' + (err?.message || err));
            }
        });
    });
}

// lightweight receipt view window used by reports page
function openReceiptWindowFromReports(r) {
    try {
        const toMoneyNumber = n => {
            const num = Number(n);
            return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
        };
        const deriveOriginalPrice = it => {
            if (typeof it?.originalPrice === 'number' && !Number.isNaN(it.originalPrice)) return toMoneyNumber(it.originalPrice);
            const price = toMoneyNumber(it?.price || 0);
            const discount = toMoneyNumber(it?.discountAmount || 0);
            return toMoneyNumber(price + discount);
        };
        const formatPercentText = value => {
            const pct = toMoneyNumber(value);
            if (pct <= 0) return '';
            const isWhole = Math.abs(pct - Math.round(pct)) < 0.01;
            return isWhole ? String(Math.round(pct)) : pct.toFixed(2).replace(/\.?0+$/, '');
        };
        const formatDiscountLabel = (type, value, amount) => {
            if (type === 'percent') {
                const pct = formatPercentText(value);
                return pct ? `${pct}% off` : '';
            }
            if (type === 'amount') {
                const amt = toMoneyNumber(amount || value);
                if (amt <= 0) return '';
                return `$${money(amt)} off`;
            }
            return '';
        };
        const buildDiscountSuffix = (type, value, amount, reason, escapeFn = s => s) => {
            const parts = [];
            const trimmed = String(reason || '').trim();
            if (trimmed) parts.push(escapeFn(trimmed));
            const label = formatDiscountLabel(type, value, amount);
            if (label) parts.push(escapeFn(label));
            return parts.length ? ` (${parts.join(', ')})` : '';
        };

        const style = `
  <style>
    @page { size: Letter portrait; margin: 0.5in; }
    :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
    html,body{height:100%}
    body{margin:0;background:#fff;color:var(--ink);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
    .invoice{max-width:8.5in;margin:0 auto}
    .sheet{background:#fff;margin:20px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:28px 34px}
    .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .brand-wrap{display:flex;gap:12px;align-items:center}
    .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
    .addr{color:var(--muted);font-size:12px;margin-top:2px}
    .title{font-size:18px;font-weight:800;letter-spacing:.3px;color:var(--emph)}
    .meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 16px;margin-top:12px}
    .label{color:var(--muted)}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
    tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
    th.num, td.num{text-align:right}
    .actions{display:flex;justify-content:flex-end;margin:8px}
    .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
    @media print{ .actions{display:none} }
  </style>`;

        const rowsHtml = (r.items || []).map((it, idx) => {
            const code = String(it.vendorCode || '').trim();
            const original = deriveOriginalPrice(it);
            const finalPrice = toMoneyNumber(it?.price || 0);
            const discountAmount = Math.max(0, toMoneyNumber(it?.discountAmount ?? (original - finalPrice)));
            const hasDiscount = discountAmount > 0;
            const type = hasDiscount ? (it?.discountType === 'percent' ? 'percent' : 'amount') : 'none';
            const value = hasDiscount ? (type === 'percent' ? toMoneyNumber(it?.discountValue || 0) : discountAmount) : 0;
            const reason = hasDiscount ? String(it?.discountReason || '').trim() : '';
            const discountSuffix = hasDiscount ? buildDiscountSuffix(type, value, discountAmount, reason, esc) : '';

            return `
            <tr>
              <td>
                <div class="title">${esc(it.name || '')}</div>
                ${it.comment ? `<div class="addr">${esc(it.comment)}</div>` : ''}
                ${code ? `<div class="addr">Vendor: ${esc(code)}</div>` : ''}
                ${hasDiscount ? `<div class="addr" style="text-decoration:line-through;">Original: $${money(original)}</div>` : ''}
                ${hasDiscount ? `<div class="addr" style="color:#dc3545;">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
              </td>
              <td class="num">$${money(finalPrice)}</td>
            </tr>`;
        }).join('');

        const html = `
  <html>
    <head><meta charset="utf-8" /><title>${esc(r.number || r.id || 'Receipt')}</title>${style}</head>
    <body>
      <div class="invoice">
        <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
        <div class="sheet">
          <div class="hdr">
            <div class="brand-wrap">
              <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="44" height="44" style="border-radius:8px" />
              <div>
                <div class="brand">Middleton's Antiques &amp; Uniques</div>
                <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
              </div>
            </div>
            <div class="title">Sales Receipt</div>
          </div>
          <div class="meta">
            <div><div class="label">Receipt #</div><div><strong>${esc(r.number || r.id || '')}</strong></div></div>
            <div><div class="label">Date</div><div><strong>${r.datetime ? new Date(r.datetime).toLocaleString() : ''}</strong></div></div>
            <div><div class="label">Cashier</div><div><strong>${esc(r.cashier || '-')}</strong></div></div>
            <div><div class="label">Payment</div><div><strong>${esc(r.payment || '-')}</strong></div></div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Price</th>
              </tr>
            </thead>
            <tbody>${rowsHtml || '<tr><td colspan="2" class="label">No items</td></tr>'}</tbody>
          </table>
          <div class="meta" style="grid-template-columns: 1fr 1fr; margin-top:12px">
            <div></div>
            <div>
              <div style="display:flex; justify-content:space-between;"><div class="label">Subtotal</div><div><strong>$${money(r.subtotal || 0)}</strong></div></div>
              <div style="display:flex; justify-content:space-between;"><div class="label">Tax</div><div><strong>$${money(r.tax || 0)}</strong></div></div>
              <div style="display:flex; justify-content:space-between;"><div class="label" style="font-weight:800">Total</div><div><strong>$${money(r.total || 0)}</strong></div></div>
            </div>
          </div>
        </div>
      </div>
    </body>
  </html>`;

        const w = window.open('', '', 'width=1024,height=1100');
        w.document.write(html);
        w.document.close();
    } catch (e) {
        console.error('[reports] render receipt view failed', e);
        alert('Open failed: ' + (e?.message || e));
    }
}


// Print Detailed: cover page + vendors, each on its own page
function printDetailedReport() {
    try {
        const fromVal = document.getElementById('fromDate')?.value;
        const toVal = document.getElementById('toDate')?.value;
        const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
        const to = toVal ? new Date(toVal + 'T23:59:59') : null;

        // Group by vendor (code if present; otherwise vendor name)
        const groups = new Map();
        receipts.forEach(r => {
            if (r.voided) return;
            const when = r.datetime ? new Date(r.datetime) : null;
            if (from && when && when < from) return;
            if (to && when && when > to) return;
            const tender = normalizeTender(r.payment);
            (r.items || []).forEach(it => {
                const code = String(it.vendorCode || '').trim();
                let key = code, name = '';
                if (code) {
                    const v = vendorByCode.get(code.toLowerCase());
                    name = v?.name || '';
                } else {
                    name = String(it.vendor || '').trim();
                    key = name || '(Unassigned)';
                }
                let g = groups.get(key);
                if (!g) g = { code: code || '', name, cash: 0, card: 0, check: 0, gift: 0, other: 0, gross: 0, count: 0, items: [] };
                const price = Number(it.price || 0);
                g.gross += price; g.count += 1;
                if (tender === 'Cash') g.cash += price;
                else if (tender === 'Card') g.card += price;
                else if (tender === 'Check') g.check += price;
                else if (tender === 'Gift Card') g.gift += price;
                else g.other += price;
                if (!g.name && name) g.name = name;
                g.items.push({ datetime: when, number: r.number || '', item: it.name || '', price, tender });
                groups.set(key, g);
            });
        });

        const list = Array.from(groups.values()).sort((a, b) => (a.name || a.code || '').localeCompare(b.name || b.code || ''));

        const style = `
      <style>
        @page { size: Letter portrait; margin: 0.5in; }
        :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
        html,body{height:100%}
        body{margin:0;background:#f3f4f6;color:var(--ink);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
        .doc{max-width:8.5in;margin:0 auto}
        .sheet{background:#fff;margin:20px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:24px 28px; page-break-after: always;}
        .sheet:last-child{ page-break-after: auto; }
        .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
        .brand-wrap{display:flex;gap:12px;align-items:center}
        .logo{width:44px;height:44px;border-radius:8px}
        .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
        .addr{color:var(--muted);font-size:12px;margin-top:2px}
        .title{font-size:22px;font-weight:800;letter-spacing:.3px;color:var(--emph)}
        .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin-top:12px}
        .label{color:var(--muted)}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
        tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
        th.num, td.num{text-align:right}
        .actions{display:flex;justify-content:flex-end;margin:8px}
        .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
        @media print{ .actions{display:none} }
      </style>`;

        const moneyStr = n => `$${money(n)}`;

        // Cover page with period and totals
        const agg = list.reduce((a, b) => ({
            cash: a.cash + b.cash,
            card: a.card + b.card,
            check: a.check + b.check,
            gift: a.gift + b.gift,
            other: a.other + b.other,
            gross: a.gross + b.gross,
            count: a.count + b.count
        }), { cash: 0, card: 0, check: 0, gift: 0, other: 0, gross: 0, count: 0 });
        const period = (fromVal || toVal) ? `${fromVal || '-'} to ${toVal || '-'}` : 'All Dates';
        const aggFee = Number(agg.card) * 0.05;
        const cover = `
        <div class="sheet">
          <div class="hdr">
            <div class="brand-wrap">
              <img src="assets/MiddletonsStoreFrontLogoBW.png" class="logo" alt="Logo" />
              <div>
                <div class="brand">Middleton's Antiques &amp; Uniques</div>
                <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
              </div>
            </div>
            <div class="title">Detailed Sales by Vendor</div>
          </div>
          <div class="meta">
            <div><div class="label">Period</div><div><strong>${esc(period)}</strong></div></div>
            <div><div class="label">Generated</div><div><strong>${new Date().toLocaleString()}</strong></div></div>
            <div><div class="label">Vendors</div><div><strong>${list.length}</strong></div></div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Total Cash</th>
                <th>Total Card</th>
                <th>Total Check</th>
                <th>Total Gift</th>
                <th>Total Other</th>
                <th>Total Gross</th>
                <th>Total Items</th>
                <th>Total Credit Fee (5% of Card)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="num">${moneyStr(agg.cash)}</td>
                <td class="num">${moneyStr(agg.card)}</td>
                <td class="num">${moneyStr(agg.check)}</td>
                <td class="num">${moneyStr(agg.gift)}</td>
                <td class="num">${moneyStr(agg.other)}</td>
                <td class="num">${moneyStr(agg.gross)}</td>
                <td class="num">${agg.count}</td>
                <td class="num">${moneyStr(aggFee)}</td>
              </tr>
            </tbody>
          </table>
        </div>`;

        // Vendor pages
        const vendorSheets = list.map(g => {
            const fee = Number(g.card) * 0.05;
            const rowsHtml = g.items.length ? g.items.map(it => `
              <tr>
                <td>${it.datetime ? esc(new Date(it.datetime).toLocaleString()) : ''}</td>
                <td>${esc(String(it.number || ''))}</td>
                <td>${esc(String(it.item || ''))}</td>
                <td class="num">${esc(String(it.tender || ''))}</td>
                <td class="num">${moneyStr(it.price)}</td>
              </tr>`).join('') : `<tr><td colspan="5" class="label">No items.</td></tr>`;

            return `
            <div class="sheet">
              <div class="hdr">
                <div class="brand-wrap">
                  <img src="assets/MiddletonsStoreFrontLogoBW.png" class="logo" alt="Logo"/>
                  <div>
                    <div class="brand">Middleton's Antiques &amp; Uniques</div>
                    <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
                  </div>
                </div>
                <div class="title">${esc(g.code || '')} — ${esc(g.name || '')}</div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Date/Time</th>
                    <th>Receipt #</th>
                    <th>Item</th>
                    <th class="num">Tender</th>
                    <th class="num">Price ($)</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
              <div class="meta" style="grid-template-columns: repeat(4,1fr)">
                <div><div class="label">Cash</div><div><strong>${moneyStr(g.cash)}</strong></div></div>
                <div><div class="label">Card</div><div><strong>${moneyStr(g.card)}</strong></div></div>
                <div><div class="label">Check</div><div><strong>${moneyStr(g.check)}</strong></div></div>
                <div><div class="label">Gift</div><div><strong>${moneyStr(g.gift)}</strong></div></div>
                <div><div class="label">Other</div><div><strong>${moneyStr(g.other)}</strong></div></div>
                <div><div class="label">Gross</div><div><strong>${moneyStr(g.gross)}</strong></div></div>
                <div><div class="label">Items</div><div><strong>${g.count}</strong></div></div>
                <div><div class="label">Credit Fee (5% of Card)</div><div><strong>${moneyStr(fee)}</strong></div></div>
              </div>
            </div>`;
        }).join('');

        const html = `
        <html>
          <head><meta charset="utf-8" /><title>Detailed Sales by Vendor</title>${style}</head>
          <body>
            <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
            <div class="doc">${cover}${vendorSheets}</div>
          </body>
        </html>`;

        const w = window.open('', '', 'width=960,height=900');
        w.document.write(html);
        w.document.close();
        try { w.focus(); } catch (_) { }
    } catch (err) {
        console.error('[reports] detailed print failed', err);
        alert('Print failed: ' + (err?.message || err));
    }
}

function exportCSV() {
    const tbody = document.getElementById('reportBody');
    const rows = [['Vendor Code', 'Vendor Name', 'Cash ($)', 'Card ($)', 'Check ($)', 'Gift Card ($)', 'Other ($)', 'Gross ($)', 'Items']];
    for (const tr of tbody.querySelectorAll('tr')) {
        const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/^\$/, ''));
        rows.push(tds);
    }
    rows.push(['', 'Totals',
        document.getElementById('totCash').textContent.replace('$', ''),
        document.getElementById('totCard').textContent.replace('$', ''),
        document.getElementById('totCheck').textContent.replace('$', ''),
        document.getElementById('totGift').textContent.replace('$', ''),
        document.getElementById('totOther').textContent.replace('$', ''),
        document.getElementById('grandTotal').textContent.replace('$', ''),
        document.getElementById('grandCount').textContent
    ]);

    const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sales_per_vendor_by_tender_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); a.remove();
}



// Expose for inline use/debug
window.runReport = runReport;
window.exportCSV = exportCSV;
function printReport() {
    try {
        const tbody = document.getElementById('reportBody');
        const rows = [...tbody.querySelectorAll('tr')].map(tr => {
            const t = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
            return { code: t[0] || '', name: t[1] || '', cash: t[2] || '', card: t[3] || '', check: t[4] || '', gift: t[5] || '', other: t[6] || '', gross: t[7] || '', count: t[8] || '' };
        });

        const fromVal = document.getElementById('fromDate').value;
        const toVal = document.getElementById('toDate').value;
        const period = (fromVal || toVal) ? `${fromVal || '—'} to ${toVal || '—'}` : 'All Dates';

        const totCash = document.getElementById('totCash').textContent;
        const totCard = document.getElementById('totCard').textContent;
        const totCheck = document.getElementById('totCheck').textContent;
        const totGift = document.getElementById('totGift').textContent;
        const totOther = document.getElementById('totOther').textContent;
        const grandTotal = document.getElementById('grandTotal').textContent;
        const grandCount = document.getElementById('grandCount').textContent;

        const style = `
      <style>
        @page { size: Letter portrait; margin: 0.5in; }
        :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
        html,body{height:100%}
        body{margin:0;background:#f3f4f6;color:var(--ink);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
        .doc{max-width:8.5in;margin:0 auto}
        .sheet{background:#fff;margin:20px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:28px 34px}
        .actions{display:flex;justify-content:flex-end;margin-bottom:8px}
        .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
        .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
        .brand-wrap{display:flex;gap:12px;align-items:center}
        .logo{width:44px;height:44px;border-radius:8px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
        .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
        .addr{color:var(--muted);font-size:12px;margin-top:2px}
        .title{font-size:22px;font-weight:800;letter-spacing:.3px;color:var(--emph)}
        .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin-top:12px}
        .label{color:var(--muted)}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
        tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
        th.num, td.num{text-align:right}
        tfoot th, tfoot td{padding:10px 8px;border-top:2px solid var(--border)}
        .totrow th{font-weight:800}
        @media print{ body{background:#fff} .sheet{margin:0;box-shadow:none} .actions{display:none} }
      </style>`;

        const tableRows = rows.length
            ? rows.map(r => `
                <tr>
                  <td>${esc(r.code)}</td>
                  <td>${esc(r.name)}</td>
                  <td class="num">${esc(r.cash)}</td>
                  <td class="num">${esc(r.card)}</td>
                  <td class="num">${esc(r.check)}</td>
                  <td class="num">${esc(r.gift)}</td>
                  <td class="num">${esc(r.other)}</td>
                  <td class="num">${esc(r.gross)}</td>
                  <td class="num">${esc(r.count)}</td>
                </tr>`).join('')
            : `<tr><td colspan="9" class="label">No sales for the selected period.</td></tr>`;

        // Build card fee rows (5% of card). Parse numbers from strings that may include $ and commas.
        const num = (s) => Number(String(s || '').replace(/[^\d.\-]/g, '')) || 0;
        const feeRows = rows
            .map(r => ({ code: r.code, name: r.name, card: num(r.card) }))
            .filter(r => r.card > 0)
            .map(r => ({ ...r, fee: r.card * 0.05 }));
        const feeTotCard = feeRows.reduce((a, b) => a + b.card, 0);
        const feeTotAmt = feeRows.reduce((a, b) => a + b.fee, 0);
        const feeTableRows = feeRows.length
            ? feeRows.map(r => `
                <tr>
                  <td>${esc(r.code || '')}</td>
                  <td>${esc(r.name || '')}</td>
                  <td class="num">$${money(r.card)}</td>
                  <td class="num">$${money(r.fee)}</td>
                </tr>`).join('')
            : `<tr><td colspan="4" class="label">No credit card sales for the selected period.</td></tr>`;

        const html = `
        <html>
          <head><meta charset="utf-8" /><title>Vendor Payout Summary</title>${style}</head>
          <body>
            <div class="doc">
              <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
              <div class="sheet">
                <div class="hdr">
                  <div class="brand-wrap">
                    <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="44" height="44" style="border-radius:8px" />
                    <div>
                      <div class="brand">Middleton's Antiques &amp; Uniques</div>
                      <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
                    </div>
                  </div>
                  <div class="title">Vendor Payout Summary</div>
                </div>
                <div class="meta">
                  <div><div class="label">Period</div><div><strong>${esc(period)}</strong></div></div>
                  <div><div class="label">Generated</div><div><strong>${new Date().toLocaleString()}</strong></div></div>
                  <div><div class="label">Vendors</div><div><strong>${rows.length}</strong></div></div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Vendor Code</th>
                      <th>Vendor Name</th>
                      <th class="num">Cash ($)</th>
                      <th class="num">Card ($)</th>
                      <th class="num">Check ($)</th>
                      <th class="num">Gift Card ($)</th>
                      <th class="num">Other ($)</th>
                      <th class="num">Gross ($)</th>
                      <th class="num"># Items</th>
                    </tr>
                  </thead>
                  <tbody>${tableRows}</tbody>
                  <tfoot>
                    <tr class="totrow">
                      <th colspan="2" class="num">Totals</th>
                      <td class="num">${esc(totCash)}</td>
                      <td class="num">${esc(totCard)}</td>
                      <td class="num">${esc(totCheck)}</td>
                      <td class="num">${esc(totGift)}</td>
                      <td class="num">${esc(totOther)}</td>
                      <td class="num">${esc(grandTotal)}</td>
                      <td class="num">${esc(grandCount)}</td>
                    </tr>
                  </tfoot>
                </table>
                <div style="height:10px"></div>
                <div class="title" style="font-size:16px; margin-top:12px">Credit Card Processing Fee (5% of Gross Card Sales)</div>
                <table>
                  <thead>
                    <tr>
                      <th>Vendor Code</th>
                      <th>Vendor Name</th>
                      <th class="num">Card ($)</th>
                      <th class="num">5% Fee ($)</th>
                    </tr>
                  </thead>
                  <tbody>${feeTableRows}</tbody>
                  <tfoot>
                    <tr class="totrow">
                      <th colspan="2" class="num">Totals</th>
                      <td class="num">$${money(feeTotCard)}</td>
                      <td class="num">$${money(feeTotAmt)}</td>
                    </tr>
                  </tfoot>
                </table>
                <div class="label" style="margin-top:12px">Payouts are based on gross sales by vendor for the selected period.</div>
              </div>
            </div>
          </body>
        </html>`;

        const w = window.open('', '', 'width=960,height=900');
        w.document.write(html);
        try {
            const txt = '1615 S 17th St, Lincoln, NE 68502 · 531-500-0135';
            const nodes = w.document.querySelectorAll('.addr, .addr.muted, #rcpt-address');
            nodes.forEach(n => n.textContent = txt);
        } catch (_) { }
        w.document.close();
    } catch (err) {
        console.error('[reports] print failed', err);
        alert('Print failed: ' + (err?.message || err));
    }
}

// Attach handlers ASAP; then init (so clicks always work even if init fails)
window.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runBtn');
    const expBtn = document.getElementById('exportBtn');
    const prnBtn = document.getElementById('printBtn');
    const prnDetBtn = document.getElementById('printDetailBtn');
    const bkpBtn = document.getElementById('backupBtn');
    const rstBtn = document.getElementById('restoreBtn');
    const todayBtn = document.getElementById('todayBtn');
    const monthBtn = document.getElementById('currentMonthBtn');

    // Developer-mode visibility toggle for backup/restore buttons
    const setDevVisibility = (isDev) => {
        const on = !!isDev;
        try {
            if (bkpBtn) bkpBtn.classList.toggle('d-none', !on);
        } catch (_) { }
        try {
            if (rstBtn) rstBtn.classList.toggle('d-none', !on);
        } catch (_) { }
    };
    // Initial settings fetch
    try {
        ipcRenderer.invoke('settings:load').then(s => setDevVisibility(!!s?.developerMode)).catch(() => {});
    } catch (_) { }
    // Live updates
    try {
        ipcRenderer.on('settings:changed', (_evt, payload) => setDevVisibility(!!payload?.developerMode));
    } catch (_) { }

    if (runBtn) {
        const onClickRun = () => { console.log('[reports] Run button clicked'); try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); } };
        runBtn.addEventListener('click', onClickRun);
    }
    if (expBtn) {
        const onClickExport = () => { console.log('[reports] Export button clicked'); try { exportCSV(); } catch (e) { console.error(e); alert('Export failed: ' + (e?.message || e)); } };
        expBtn.addEventListener('click', onClickExport);
    }
    if (prnBtn) {
        const onClickPrint = () => { console.log('[reports] Print button clicked'); try { printReport(); } catch (e) { console.error(e); alert('Print failed: ' + (e?.message || e)); } };
        prnBtn.addEventListener('click', onClickPrint);
    }
    if (prnDetBtn) {
        const onClickPrintDet = () => { console.log('[reports] Print detailed clicked'); try { printDetailedReport(); } catch (e) { console.error(e); alert('Print failed: ' + (e?.message || e)); } };
        prnDetBtn.addEventListener('click', onClickPrintDet);
    }
    if (bkpBtn) {
        const onClickBackup = async () => {
            try {
                const res = await ipcRenderer.invoke('data:export');
                if (res?.ok) alert(`Backup saved.\n\nPath: ${res.path}\nVendors: ${res.counts.vendors}\nCashiers: ${res.counts.cashiers}\nReceipts: ${res.counts.receipts}`);
                else if (!res?.canceled) alert('Backup failed: ' + (res?.error || 'Unknown error'));
            } catch (e) {
                console.error(e); alert('Backup failed: ' + (e?.message || e));
            }
        };
        bkpBtn.addEventListener('click', onClickBackup);
    }
    if (rstBtn) {
        const onClickRestore = async () => {
            if (!confirm('Importing a backup will overwrite current data. Continue?')) return;
            try {
                const res = await ipcRenderer.invoke('data:import');
                if (res?.ok) {
                    alert(`Import complete.\nVendors: ${res.counts.vendors}\nCashiers: ${res.counts.cashiers}\nReceipts: ${res.counts.receipts}`);
                    // Refresh in-memory data and rerun report
                    await initReports();
                } else if (!res?.canceled) {
                    alert('Import failed: ' + (res?.error || 'Unknown error'));
                }
            } catch (e) {
                console.error(e); alert('Import failed: ' + (e?.message || e));
            }
        };
        rstBtn.addEventListener('click', onClickRestore);
    }

    // Quick Filters
    const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const setRange = (from, to) => {
        const fromEl = document.getElementById('fromDate');
        const toEl = document.getElementById('toDate');
        if (fromEl) fromEl.value = fmtLocal(from);
        if (toEl) toEl.value = fmtLocal(to);
    };
    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            setRange(start, start);
            try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        });
    }
    if (monthBtn) {
        monthBtn.addEventListener('click', () => {
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth(), 1);
            const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            setRange(from, to);
            try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        });
    }
});

// Initialize data after full load; do NOT call something named `bootstrap` here
window.addEventListener('load', async () => {
    try {
        await initReports();
        console.log('[reports] init complete');
    } catch (err) {
        console.error('[reports] init failed:', err);
        alert('Reports init failed: ' + (err?.message || err));
        // Continue with empty arrays so the UI still works
    }
});
