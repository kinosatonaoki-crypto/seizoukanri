const APP_SCRIPT_SOURCE = document.currentScript.textContent;
const MASTER = JSON.parse(document.getElementById('app-master').textContent);
let STATE = JSON.parse(document.getElementById('app-state').textContent);

let claudeArtifact = null;
let backendMode = 'checking'; // 'checking' | 'artifact' | 'netlify' | 'none'
let stateVersion = 0;
let isReadOnly = false;
let dirty = false;

const NAV = {
  channel: 'retail',
  view: 'weekly',
  weekStart: null,
  monthKey: null,
  collapsed: {},
  memoModalOpen: false,
  memoModalChannel: null,
  ocr: { status: 'idle', file: null, previewUrl: null, progressPct: 0, rows: [], errorMsg: '' },
};

/* ---------- date helpers ---------- */
function pad2(n){ return String(n).padStart(2, '0'); }
function isoDate(d){ return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseIso(s){ const parts = s.split('-').map(Number); return new Date(parts[0], parts[1] - 1, parts[2]); }
function mondayOf(d){
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const r = new Date(d);
  r.setDate(d.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}
function addDays(d, n){ const r = new Date(d); r.setDate(d.getDate() + n); return r; }
function monthKeyOf(d){ return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDateJp(d){ return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
function fmtWeekLabel(monday){
  const sunday = addDays(monday, 6);
  const tail = monday.getFullYear() === sunday.getFullYear()
    ? (sunday.getMonth() + 1) + '月' + sunday.getDate() + '日'
    : fmtDateJp(sunday);
  return fmtDateJp(monday) + '(' + DOW_JP[monday.getDay()] + ') 〜 ' + tail + '(' + DOW_JP[sunday.getDay()] + ')';
}
function fmtMonthLabel(monthKey){
  const parts = monthKey.split('-').map(Number);
  return parts[0] + '年' + parts[1] + '月';
}
function fmtInt(n){ return (n || 0).toLocaleString('ja-JP'); }
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ---------- state access helpers ---------- */
function chData(channel){ return STATE[channel]; }
function getWeek(channel, wk){ return chData(channel).weeks[wk] || { status: 'draft', qty: {}, memo: '' }; }
function ensureWeek(channel, wk){
  const c = chData(channel);
  if(!c.weeks[wk]) c.weeks[wk] = { status: 'draft', qty: {}, memo: '' };
  return c.weeks[wk];
}
function getMonth(channel, mk){ return chData(channel).months[mk] || { memo: '' }; }
function ensureMonth(channel, mk){
  const c = chData(channel);
  if(!c.months[mk]) c.months[mk] = { memo: '' };
  return c.months[mk];
}
function weekKeysInMonth(channel, monthKey){
  return Object.keys(chData(channel).weeks).filter(function(wk){ return monthKeyOf(parseIso(wk)) === monthKey; }).sort();
}
function groupedRetailProducts(){
  const order = STATE.retail.groupOrder;
  const byGroup = {};
  MASTER.retailProducts.forEach(function(p){ (byGroup[p.group] = byGroup[p.group] || []).push(p); });
  return order.map(function(g){ return { name: g, products: byGroup[g] || [] }; });
}
function weekGroupSubtotal(channel, wk, products){
  const q = getWeek(channel, wk).qty;
  return products.reduce(function(s, p){ return s + (q[p.code] || 0); }, 0);
}
function weekGrandTotal(channel, wk){
  const q = getWeek(channel, wk).qty;
  return Object.keys(q).reduce(function(s, k){ return s + (q[k] || 0); }, 0);
}
function monthGroupSubtotal(channel, monthKey, products){
  const wks = weekKeysInMonth(channel, monthKey);
  return products.reduce(function(s, p){
    return s + wks.reduce(function(s2, wk){ return s2 + (getWeek(channel, wk).qty[p.code] || 0); }, 0);
  }, 0);
}
function monthProductTotal(channel, monthKey, code){
  const wks = weekKeysInMonth(channel, monthKey);
  return wks.reduce(function(s, wk){ return s + (getWeek(channel, wk).qty[code] || 0); }, 0);
}
function monthGrandTotal(channel, monthKey){
  const wks = weekKeysInMonth(channel, monthKey);
  return wks.reduce(function(s, wk){ return s + weekGrandTotal(channel, wk); }, 0);
}
function upsertMemoLog(channel, kind, key, text){
  const c = chData(channel);
  const now = new Date().toISOString();
  const existing = c.memoLog.find(function(e){ return e.kind === kind && e.key === key; });
  if(existing){ existing.text = text; existing.savedAt = now; }
  else { c.memoLog.unshift({ kind: kind, key: key, text: text, savedAt: now }); }
  c.memoLog = c.memoLog.filter(function(e){ return e.text && e.text.trim() !== ''; });
  c.memoLog.sort(function(a, b){ return a.key < b.key ? 1 : -1; });
}

/* ---------- render: shell ---------- */
function render(){
  document.getElementById('root').innerHTML = renderApp();
}
function renderApp(){
  return renderTopbar() + renderStatusStrip() + renderBody() + renderMemoModal();
}
function renderTopbar(){
  return '' +
    '<div class="topbar no-print">' +
      '<div class="brand">紀の里食品<span>製造予定作成アプリ</span></div>' +
      '<div class="channel-tabs">' +
        '<button class="' + (NAV.channel === 'retail' ? 'active' : '') + '" onclick="navChannel(\'retail\')">通信販売</button>' +
        '<button class="' + (NAV.channel === 'wholesale' ? 'active' : '') + '" onclick="navChannel(\'wholesale\')">卸販売</button>' +
      '</div>' +
      '<div class="top-right">3名利用 ・ 通販' + MASTER.retailProducts.length + '品目 / 卸' + MASTER.wholesaleProducts.length + '品目</div>' +
    '</div>';
}
function renderStatusStrip(){
  let cls = 'ok', text = '';
  if(isReadOnly){ cls = 'readonly'; text = '⚠ このビューは閲覧のみです（保存はできません）。'; }
  else if(backendMode === 'checking'){ cls = 'checking'; text = '保存の準備を確認しています…'; }
  else if(backendMode === 'none'){ cls = 'readonly'; text = '⚠ この画面では自動保存ができません（プレビュー表示です）。入力内容はこの端末を閉じると失われます。'; }
  if(!text && !dirty) return '';
  return '<div class="status-strip no-print ' + cls + '">' + (text ? '<span>' + text + '</span>' : '') +
    (dirty ? '<span class="dirty-badge"><span class="dirty-dot"></span>未保存の変更があります</span>' : '') + '</div>';
}
function renderBody(){
  if(NAV.channel === 'retail') return renderRetailBody();
  return renderWholesaleBody();
}

/* ---------- retail ---------- */
function renderRetailBody(){
  let out = '<div class="subnav no-print">' +
    '<button class="' + (NAV.view === 'weekly' ? 'active' : '') + '" onclick="navView(\'weekly\')">週次計画</button>' +
    '<button class="' + (NAV.view === 'monthly' ? 'active' : '') + '" onclick="navView(\'monthly\')">月次計画</button>' +
    '<button class="' + (NAV.view === 'grouporder' ? 'active' : '') + '" onclick="navView(\'grouporder\')">グループ並び順</button>' +
    '<button class="' + (NAV.view === 'ocr' ? 'active' : '') + '" onclick="navView(\'ocr\')">📷 OCR取込</button>' +
    '<button class="' + (NAV.view === 'print' ? 'active' : '') + '" onclick="navView(\'print\')">🖨 印刷プレビュー</button>' +
    '</div><div class="view-pad">';
  if(NAV.view === 'weekly') out += renderRetailWeekly();
  else if(NAV.view === 'monthly') out += renderRetailMonthly();
  else if(NAV.view === 'grouporder') out += renderGroupOrderView();
  else if(NAV.view === 'ocr') out += renderOcrView('retail');
  else out += renderPrintView('retail');
  out += '</div>';
  return out;
}
function renderRetailWeekly(){
  const wk = NAV.weekStart;
  const monday = parseIso(wk);
  const week = getWeek('retail', wk);
  const groups = groupedRetailProducts();
  let out = '<div class="week-nav">' +
    '<button class="nav-arrow" onclick="navPrevWeek()">‹</button>' +
    '<div class="period-label">' + fmtWeekLabel(monday) + '</div>' +
    '<button class="nav-arrow" onclick="navNextWeek()">›</button>' +
    '<span class="status-badge ' + week.status + '">' + (week.status === 'confirmed' ? '✓ 確定済み' : '下書き') + '</span>' +
    '<div class="spacer"></div>' +
    '<button class="this-week-btn" onclick="navThisWeek()">今週へ</button>' +
    '<button class="btn primary" onclick="toggleConfirm(\'retail\')" ' + (isReadOnly ? 'disabled' : '') + '>' +
      (week.status === 'confirmed' ? '↩ 下書きに戻す' : 'この週を確定する') + '</button>' +
    '</div>';
  groups.forEach(function(g, i){
    const collapsed = !!NAV.collapsed[g.name];
    out += '<div class="group-section">' +
      '<div class="group-head" onclick="toggleGroupCollapse(\'' + esc(g.name) + '\')">' +
        '<span class="group-rank">' + pad2(i + 1) + '</span>' +
        '<span class="group-name">' + esc(g.name) + '</span>' +
        '<span class="group-sub" id="rw-gsub-' + i + '">' + fmtInt(weekGroupSubtotal('retail', wk, g.products)) + '個</span>' +
        '<span class="collapse-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
      '</div>';
    if(!collapsed){
      out += '<table class="item-table"><tbody>';
      g.products.forEach(function(p){
        const v = week.qty[p.code] || '';
        out += '<tr><td class="name">' + esc(p.name) + '</td>' +
          '<td class="annual">年間参考 ' + fmtInt(p.annualQty) + '個</td>' +
          '<td class="qtycell"><input type="number" min="0" inputmode="numeric" value="' + (v === 0 ? '' : v) + '" placeholder="0" ' +
          (isReadOnly ? 'disabled' : '') + ' oninput="onQtyInput(this,\'retail\',\'' + wk + '\',\'' + p.code + '\')"></td></tr>';
      });
      out += '</tbody></table>';
    }
    out += '</div>';
  });
  out += '<div class="footer-bar">' +
    '<div class="grand-total">今週の製造予定合計<b id="rw-grand">' + fmtInt(weekGrandTotal('retail', wk)) + '個</b></div>' +
    '<div class="spacer"></div>' +
    '<button class="btn" onclick="saveDraft(\'retail\')" ' + (isReadOnly ? 'disabled' : '') + '>下書き保存</button>' +
    '<button class="btn primary" onclick="toggleConfirm(\'retail\')" ' + (isReadOnly ? 'disabled' : '') + '>' +
      (week.status === 'confirmed' ? '↩ 下書きに戻す' : 'この週を確定する') + '</button>' +
    '</div>';
  out += renderMemoCard('retail', 'week', wk, week.memo);
  return out;
}
function renderRetailMonthly(){
  const mk = NAV.monthKey;
  const groups = groupedRetailProducts();
  const wks = weekKeysInMonth('retail', mk);
  const month = getMonth('retail', mk);
  let out = '<div class="month-nav">' +
    '<button class="nav-arrow" onclick="navPrevMonth()">‹</button>' +
    '<div class="period-label">' + fmtMonthLabel(mk) + '</div>' +
    '<button class="nav-arrow" onclick="navNextMonth()">›</button>' +
    '</div>';
  out += '<div class="month-weeks-note">この月に含まれる週（各週の製造予定をそのまま積み上げた合計です）：' +
    (wks.length ? wks.map(function(w){
      const st = getWeek('retail', w).status;
      return '<span class="week-chip ' + st + '">' + fmtWeekLabel(parseIso(w)) + (st === 'confirmed' ? ' 確定' : ' 下書き') + '</span>';
    }).join('') : '<span style="color:var(--muted)">まだこの月に入力された週がありません</span>') +
    '</div>';
  out += '<div class="wide-table-wrap"><table class="month-table"><thead><tr><th class="name">商品（グループ順）</th><th>月合計</th></tr></thead><tbody>';
  groups.forEach(function(g, i){
    out += '<tr class="group-row"><td class="name">' + pad2(i + 1) + '　' + esc(g.name) + '</td><td>' + fmtInt(monthGroupSubtotal('retail', mk, g.products)) + '個</td></tr>';
    g.products.forEach(function(p){
      const t = monthProductTotal('retail', mk, p.code);
      if(t === 0) return;
      out += '<tr><td class="name">　' + esc(p.name) + '</td><td>' + fmtInt(t) + '個</td></tr>';
    });
  });
  out += '</tbody></table></div>';
  out += '<div class="footer-bar"><div class="grand-total">' + fmtMonthLabel(mk) + 'の製造予定合計<b>' + fmtInt(monthGrandTotal('retail', mk)) + '個</b></div></div>';
  out += renderMemoCard('retail', 'month', mk, month.memo);
  return out;
}
function renderGroupOrderView(){
  const order = STATE.retail.groupOrder;
  const byGroup = {};
  MASTER.retailProducts.forEach(function(p){ (byGroup[p.group] = byGroup[p.group] || []).push(p); });
  let out = '<div class="known-issue">並び順は週次・月次の計画画面に共通で反映されます。変更後は「この並び順を保存」を押してください。</div>';
  out += '<div class="grouporder-list">';
  order.forEach(function(name, i){
    const products = byGroup[name] || [];
    out += '<div class="go-row">' +
      '<span class="go-rank">' + pad2(i + 1) + '</span>' +
      '<span class="go-name">' + esc(name) + '</span>' +
      '<span class="go-count">' + products.length + '品目</span>' +
      '<span class="go-arrows">' +
        '<button onclick="moveGroupUp(\'' + esc(name) + '\')" ' + (i === 0 ? 'disabled' : '') + '>▲</button>' +
        '<button onclick="moveGroupDown(\'' + esc(name) + '\')" ' + (i === order.length - 1 ? 'disabled' : '') + '>▼</button>' +
      '</span></div>';
  });
  out += '</div>';
  out += '<div class="go-bottom">' +
    '<button class="btn ghost" onclick="resetGroupOrder()" ' + (isReadOnly ? 'disabled' : '') + '>初期値（年間売上順）に戻す</button>' +
    '<button class="btn primary" onclick="saveGroupOrder()" ' + (isReadOnly ? 'disabled' : '') + '>この並び順を保存</button>' +
    '</div>';
  return out;
}

/* ---------- print preview (both channels, current week, real entered quantities) ---------- */
function renderPrintView(channel){
  const wk = NAV.weekStart;
  const monday = parseIso(wk);
  const week = getWeek(channel, wk);
  const hasAny = Object.values(week.qty).some(function(v){ return v > 0; });
  let out = '<div class="print-toolbar no-print">' +
    '<button class="nav-arrow" onclick="navPrevWeek()">‹</button>' +
    '<div class="period-label">' + fmtWeekLabel(monday) + '</div>' +
    '<button class="nav-arrow" onclick="navNextWeek()">›</button>' +
    '<span class="status-badge ' + week.status + '">' + (week.status === 'confirmed' ? '✓ 確定済み' : '下書き') + '</span>' +
    '<div class="spacer"></div>' +
    '<button class="btn primary" onclick="window.print()">🖨 このページを印刷</button>' +
    '</div>';
  out += '<div class="print-sheet">';
  out += '<div class="print-head">' +
    '<div class="print-title">製造予定表　' + (channel === 'retail' ? '通信販売' : '卸販売') + '</div>' +
    '<div class="print-sub">' + fmtWeekLabel(monday) + '　' + (week.status === 'confirmed' ? '（確定済み）' : '（下書き）') + '</div>' +
    '</div>';
  if(!hasAny){
    out += '<div class="empty-note">この週はまだ製造予定数が入力されていません。週次計画画面で数量を入力すると、ここに一覧表示されます。</div>';
  } else if(channel === 'retail'){
    const groups = groupedRetailProducts();
    groups.forEach(function(g, i){
      const items = g.products.filter(function(p){ return (week.qty[p.code] || 0) > 0; });
      if(!items.length) return;
      const subtotal = items.reduce(function(s, p){ return s + (week.qty[p.code] || 0); }, 0);
      out += '<div class="print-group">' +
        '<div class="print-group-title"><span class="rank">' + pad2(i + 1) + '</span><span class="gname">' + esc(g.name) + '</span><span class="gtotal">小計 <b>' + fmtInt(subtotal) + '個</b></span></div>' +
        '<table class="print-table"><tbody>';
      items.forEach(function(p){
        out += '<tr><td class="code">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="qty">' + fmtInt(week.qty[p.code]) + '</td></tr>';
      });
      out += '</tbody></table></div>';
    });
    out += '<div class="print-grand">製造予定合計　<b>' + fmtInt(weekGrandTotal('retail', wk)) + '個</b></div>';
  } else {
    const items = MASTER.wholesaleProducts.filter(function(p){ return (week.qty[p.code] || 0) > 0; });
    out += '<table class="print-table"><tbody>';
    items.forEach(function(p){
      out += '<tr><td class="code">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="qty">' + fmtInt(week.qty[p.code]) + '</td></tr>';
    });
    out += '</tbody></table>';
    out += '<div class="print-grand">製造予定合計　<b>' + fmtInt(weekGrandTotal('wholesale', wk)) + '個</b></div>';
  }
  out += '</div>';
  return out;
}

/* ---------- wholesale ---------- */
function renderWholesaleBody(){
  let out = '<div class="subnav no-print">' +
    '<button class="' + (NAV.view === 'weekly' ? 'active' : '') + '" onclick="navView(\'weekly\')">週次計画</button>' +
    '<button class="' + (NAV.view === 'monthly' ? 'active' : '') + '" onclick="navView(\'monthly\')">月次計画</button>' +
    '<button class="' + (NAV.view === 'ocr' ? 'active' : '') + '" onclick="navView(\'ocr\')">📷 OCR取込</button>' +
    '<button class="' + (NAV.view === 'print' ? 'active' : '') + '" onclick="navView(\'print\')">🖨 印刷プレビュー</button>' +
    '</div><div class="view-pad">';
  if(NAV.view !== 'print' && NAV.view !== 'ocr') out += '<div class="known-issue">現時点のマスタデータには「どの取引先がどの商品をいくつ買うか」の対応表がないため、卸販売は商品別合計のみで作成しています。取引先別の内訳が必要な場合は、取引先マスタの整備とあわせて追加を検討してください。</div>';
  if(NAV.view === 'weekly') out += renderWholesaleWeekly();
  else if(NAV.view === 'monthly') out += renderWholesaleMonthly();
  else if(NAV.view === 'ocr') out += renderOcrView('wholesale');
  else out += renderPrintView('wholesale');
  out += '</div>';
  return out;
}
function renderWholesaleWeekly(){
  const wk = NAV.weekStart;
  const monday = parseIso(wk);
  const week = getWeek('wholesale', wk);
  let out = '<div class="week-nav">' +
    '<button class="nav-arrow" onclick="navPrevWeek()">‹</button>' +
    '<div class="period-label">' + fmtWeekLabel(monday) + '</div>' +
    '<button class="nav-arrow" onclick="navNextWeek()">›</button>' +
    '<span class="status-badge ' + week.status + '">' + (week.status === 'confirmed' ? '✓ 確定済み' : '下書き') + '</span>' +
    '<div class="spacer"></div>' +
    '<button class="this-week-btn" onclick="navThisWeek()">今週へ</button>' +
    '<button class="btn primary" onclick="toggleConfirm(\'wholesale\')" ' + (isReadOnly ? 'disabled' : '') + '>' +
      (week.status === 'confirmed' ? '↩ 下書きに戻す' : 'この週を確定する') + '</button>' +
    '</div>';
  out += '<div class="wide-table-wrap"><table class="wide-table"><thead><tr><th>商品コード</th><th>商品名</th><th class="qtycell">年間参考</th><th class="qtycell">製造予定数</th></tr></thead><tbody>';
  MASTER.wholesaleProducts.forEach(function(p){
    const v = week.qty[p.code] || '';
    out += '<tr><td>' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="annual">' + fmtInt(p.annualQty) + '個</td>' +
      '<td class="qtycell"><input type="number" min="0" inputmode="numeric" value="' + (v === 0 ? '' : v) + '" placeholder="0" ' +
      (isReadOnly ? 'disabled' : '') + ' oninput="onQtyInput(this,\'wholesale\',\'' + wk + '\',\'' + p.code + '\')"></td></tr>';
  });
  out += '</tbody></table></div>';
  out += '<div class="footer-bar">' +
    '<div class="grand-total">今週の製造予定合計<b id="ww-grand">' + fmtInt(weekGrandTotal('wholesale', wk)) + '個</b></div>' +
    '<div class="spacer"></div>' +
    '<button class="btn" onclick="saveDraft(\'wholesale\')" ' + (isReadOnly ? 'disabled' : '') + '>下書き保存</button>' +
    '<button class="btn primary" onclick="toggleConfirm(\'wholesale\')" ' + (isReadOnly ? 'disabled' : '') + '>' +
      (week.status === 'confirmed' ? '↩ 下書きに戻す' : 'この週を確定する') + '</button>' +
    '</div>';
  out += renderMemoCard('wholesale', 'week', wk, week.memo);
  return out;
}
function renderWholesaleMonthly(){
  const mk = NAV.monthKey;
  const wks = weekKeysInMonth('wholesale', mk);
  const month = getMonth('wholesale', mk);
  let out = '<div class="month-nav">' +
    '<button class="nav-arrow" onclick="navPrevMonth()">‹</button>' +
    '<div class="period-label">' + fmtMonthLabel(mk) + '</div>' +
    '<button class="nav-arrow" onclick="navNextMonth()">›</button>' +
    '</div>';
  out += '<div class="month-weeks-note">この月に含まれる週：' +
    (wks.length ? wks.map(function(w){
      const st = getWeek('wholesale', w).status;
      return '<span class="week-chip ' + st + '">' + fmtWeekLabel(parseIso(w)) + (st === 'confirmed' ? ' 確定' : ' 下書き') + '</span>';
    }).join('') : '<span style="color:var(--muted)">まだこの月に入力された週がありません</span>') +
    '</div>';
  out += '<div class="wide-table-wrap"><table class="wide-table"><thead><tr><th>商品名</th><th class="qtycell">月合計</th></tr></thead><tbody>';
  MASTER.wholesaleProducts.forEach(function(p){
    const t = monthProductTotal('wholesale', mk, p.code);
    if(t === 0) return;
    out += '<tr><td>' + esc(p.name) + '</td><td class="qtycell">' + fmtInt(t) + '個</td></tr>';
  });
  out += '</tbody></table></div>';
  out += '<div class="footer-bar"><div class="grand-total">' + fmtMonthLabel(mk) + 'の製造予定合計<b>' + fmtInt(monthGrandTotal('wholesale', mk)) + '個</b></div></div>';
  out += renderMemoCard('wholesale', 'month', mk, month.memo);
  return out;
}

/* ---------- OCR取込（写真の読み取りによる入力補助） ---------- */
function renderOcrView(channel){
  const products = channel === 'retail' ? MASTER.retailProducts : MASTER.wholesaleProducts;
  const o = NAV.ocr;
  let out = '<div class="known-issue">紙の伝票・注文書などをスマホで撮影して、数量の入力を補助する機能です。読み取り結果はあくまで目安なので、必ずこの画面で内容を確認してから反映してください（印刷された文字向けの機能で、手書きの精度は高くありません）。</div>';

  if(o.status === 'idle' || o.status === 'error'){
    out += '<div class="ocr-dropzone">' +
      '<div style="margin-bottom:10px;color:var(--muted);font-size:13px;">写真を選ぶか、その場で撮影してください</div>' +
      '<label class="btn primary ocr-pick-btn">写真を選ぶ／撮影する' +
        '<input type="file" accept="image/*" capture="environment" onchange="onOcrFileSelected(this,\'' + channel + '\')"></label>' +
      (o.status === 'error' ? '<div style="margin-top:10px;color:var(--warn);font-size:12.5px;">' + esc(o.errorMsg || '読み取りに失敗しました。もう一度お試しください。') + '</div>' : '') +
      '</div>';
    return out;
  }

  out += '<div class="ocr-preview-wrap">';
  if(o.previewUrl) out += '<img src="' + o.previewUrl + '" alt="撮影した写真">';
  out += '<div style="flex:1;min-width:220px;">';
  if(o.status === 'preview'){
    out += '<button class="btn primary" onclick="startOcrRecognition(\'' + channel + '\')">この写真を読み取る</button> ' +
      '<button class="btn ghost" onclick="resetOcr()">やり直す</button>';
  } else if(o.status === 'processing'){
    const pct = Math.round((o.progressPct || 0) * 100);
    out += '<div class="ocr-progress">読み取り中…（' + pct + '%）' +
      '<div class="ocr-progress-bar"><div style="width:' + pct + '%"></div></div></div>';
  } else if(o.status === 'review'){
    out += '<div style="color:var(--muted);font-size:12.5px;">' + o.rows.length + '行を検出しました。内容を確認し、必要に応じて商品・数量を修正してから反映してください。</div>';
  }
  out += '</div></div>';

  if(o.status === 'review'){
    if(!o.rows.length){
      out += '<div class="empty-note">数量らしき行を検出できませんでした。写真の向き・明るさを変えて撮り直すか、週次計画画面で直接入力してください。</div>' +
        '<div class="go-bottom"><button class="btn ghost" onclick="resetOcr()">やり直す</button></div>';
    } else {
      out += '<div class="ocr-list">';
      o.rows.forEach(function(row, i){
        out += '<div class="ocr-row">' +
          '<input type="checkbox" ' + (row.include ? 'checked' : '') + ' onchange="toggleOcrRowInclude(' + i + ')">' +
          '<select onchange="updateOcrRowField(' + i + ',\'matchedCode\',this.value,\'' + channel + '\')">' +
            '<option value=""' + (row.matchedCode ? '' : ' selected') + '>（商品を選択）</option>' +
            products.map(function(p){
              return '<option value="' + esc(p.code) + '"' + (p.code === row.matchedCode ? ' selected' : '') + '>' + esc(p.name) + '</option>';
            }).join('') +
          '</select>' +
          '<input type="number" min="0" inputmode="numeric" value="' + (row.qty === null ? '' : row.qty) + '" placeholder="数量" ' +
            'oninput="updateOcrRowField(' + i + ',\'qty\',this.value,\'' + channel + '\')">' +
          '<span class="raw">検出テキスト:「' + esc(row.rawLine) + '」' + (!row.matchedCode ? '<span class="unmatched"> ・候補なし</span>' : '') + '</span>' +
          '</div>';
      });
      out += '</div>';
      out += '<div class="go-bottom">' +
        '<button class="btn ghost" onclick="resetOcr()">やり直す</button>' +
        '<div class="spacer"></div>' +
        '<button class="btn primary" onclick="applyOcrRows(\'' + channel + '\')" ' + (isReadOnly ? 'disabled' : '') + '>チェックした内容を今週の入力欄に反映</button>' +
        '</div>';
    }
  }
  return out;
}
function onOcrFileSelected(input, channel){
  const file = input.files && input.files[0];
  if(!file) return;
  if(NAV.ocr.previewUrl) URL.revokeObjectURL(NAV.ocr.previewUrl);
  NAV.ocr.file = file;
  NAV.ocr.previewUrl = URL.createObjectURL(file);
  NAV.ocr.status = 'preview';
  NAV.ocr.rows = [];
  NAV.ocr.errorMsg = '';
  render();
}
function resetOcr(){
  if(NAV.ocr.previewUrl) URL.revokeObjectURL(NAV.ocr.previewUrl);
  NAV.ocr = { status: 'idle', file: null, previewUrl: null, progressPct: 0, rows: [], errorMsg: '' };
  render();
}
async function startOcrRecognition(channel){
  NAV.ocr.status = 'processing';
  NAV.ocr.progressPct = 0;
  render();
  try{
    if(typeof Tesseract === 'undefined'){
      throw new Error('OCRライブラリの読み込みに失敗しました（通信環境をご確認のうえ、もう一度お試しください）');
    }
    const worker = await Tesseract.createWorker('jpn+eng', 1, {
      logger: function(m){
        if(m && typeof m.progress === 'number'){
          NAV.ocr.progressPct = m.progress;
          const pct = Math.round(m.progress * 100);
          const bar = document.querySelector('.ocr-progress-bar > div');
          if(bar) bar.style.width = pct + '%';
          const label = document.querySelector('.ocr-progress');
          if(label) label.firstChild.textContent = '読み取り中…（' + pct + '%）';
        }
      },
    });
    const result = await worker.recognize(NAV.ocr.file);
    await worker.terminate();
    const text = (result && result.data && result.data.text) || '';
    const products = channel === 'retail' ? MASTER.retailProducts : MASTER.wholesaleProducts;
    NAV.ocr.rows = parseOcrLines(text, products);
    NAV.ocr.status = 'review';
    render();
  } catch(err){
    NAV.ocr.status = 'error';
    NAV.ocr.errorMsg = (err && err.message) || '読み取りに失敗しました。もう一度お試しください。';
    render();
  }
}
function toggleOcrRowInclude(i){
  const row = NAV.ocr.rows[i];
  if(!row) return;
  row.include = !row.include;
  render();
}
function updateOcrRowField(i, field, value, channel){
  const row = NAV.ocr.rows[i];
  if(!row) return;
  if(field === 'qty'){
    row.qty = value === '' ? null : Math.max(0, parseInt(value, 10) || 0);
  } else if(field === 'matchedCode'){
    row.matchedCode = value;
    const products = channel === 'retail' ? MASTER.retailProducts : MASTER.wholesaleProducts;
    const p = products.find(function(pp){ return pp.code === value; });
    row.matchedName = p ? p.name : '';
    if(value) row.include = true;
  }
  render();
}
function applyOcrRows(channel){
  const wk = NAV.weekStart;
  const week = ensureWeek(channel, wk);
  let count = 0;
  NAV.ocr.rows.forEach(function(row){
    if(row.include && row.matchedCode && row.qty !== null && row.qty !== undefined){
      week.qty[row.matchedCode] = row.qty;
      count++;
    }
  });
  if(count > 0) dirty = true;
  if(NAV.ocr.previewUrl) URL.revokeObjectURL(NAV.ocr.previewUrl);
  NAV.ocr = { status: 'idle', file: null, previewUrl: null, progressPct: 0, rows: [], errorMsg: '' };
  NAV.view = 'weekly';
  render();
  showToast(count > 0
    ? '✓ ' + count + '件を今週の入力欄に反映しました。内容を確認して保存してください。'
    : '反映する行がありませんでした。チェック・商品・数量を確認してください。');
}

/* ---------- OCR: text extraction & fuzzy product matching (pure functions) ---------- */
function toHalfWidthDigits(s){
  return s.replace(/[０-９]/g, function(ch){ return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
}
function normalizeForMatch(s){
  return toHalfWidthDigits(s)
    .replace(/[\s　]+/g, '')
    .replace(/[・、。,.\-‐－()（）\[\]【】]/g, '')
    .toLowerCase();
}
function extractQtyFromLine(line){
  const norm = toHalfWidthDigits(line);
  const m = norm.match(/([0-9]+)\s*(?:個|袋|本|枚|箱|セット|kg|ｋｇ|g|ｇ)?\s*$/);
  if(!m) return null;
  const qty = parseInt(m[1], 10);
  const namePart = norm.slice(0, norm.length - m[0].length).trim();
  return { qty: qty, namePart: namePart };
}
function bigrams(s){
  const arr = [];
  for(let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i + 2));
  return arr;
}
function diceCoeff(a, b){
  if(a === b && a.length > 0) return 1;
  const A = bigrams(a), B = bigrams(b);
  if(A.length === 0 || B.length === 0) return 0;
  const pool = B.slice();
  let matches = 0;
  for(let i = 0; i < A.length; i++){
    const idx = pool.indexOf(A[i]);
    if(idx !== -1){ matches++; pool.splice(idx, 1); }
  }
  return (2 * matches) / (A.length + B.length);
}
function bestProductMatch(text, products){
  const norm = normalizeForMatch(text);
  if(!norm) return null;
  let best = null, bestScore = 0;
  for(let i = 0; i < products.length; i++){
    const p = products[i];
    const score = diceCoeff(norm, normalizeForMatch(p.name));
    if(score > bestScore){ bestScore = score; best = p; }
  }
  if(!best) return null;
  return { code: best.code, name: best.name, score: bestScore };
}
function parseOcrLines(text, products){
  const lines = text.split(/\r?\n/).map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });
  return lines.map(function(line){
    const extracted = extractQtyFromLine(line);
    const qty = extracted ? extracted.qty : null;
    const namePart = extracted ? extracted.namePart : line;
    const match = bestProductMatch(namePart, products);
    return {
      rawLine: line,
      qty: qty,
      matchedCode: match ? match.code : '',
      matchedName: match ? match.name : '',
      score: match ? match.score : 0,
      include: !!(match && qty !== null && match.score >= 0.3),
    };
  });
}

/* ---------- memo card + history modal ---------- */
function renderMemoCard(channel, kind, key, text){
  const inputId = 'memo-input-' + channel + '-' + kind;
  return '<div class="memo-card">' +
    '<div class="memo-card-title"><span>製造メモ（この' + (kind === 'week' ? '週' : '月') + '）</span>' +
    '<button class="link-btn" onclick="openMemoHistory(\'' + channel + '\')">🗂 メモ履歴を見る</button></div>' +
    '<textarea id="' + inputId + '" placeholder="例：容器の不足で予定数量が作れなかった…">' + esc(text) + '</textarea>' +
    '<div class="memo-actions">' +
      '<button class="btn small" onclick="saveMemo(\'' + channel + '\',\'' + kind + '\',\'' + key + '\',\'' + inputId + '\')" ' + (isReadOnly ? 'disabled' : '') + '>メモを保存</button>' +
    '</div></div>';
}
function renderMemoModal(){
  if(!NAV.memoModalOpen) return '';
  const channel = NAV.memoModalChannel;
  const log = chData(channel).memoLog;
  return '<div class="modal-overlay open"><div class="modal-box">' +
    '<div class="modal-title">製造メモ履歴（' + (channel === 'retail' ? '通信販売' : '卸販売') + '）</div>' +
    '<input class="modal-filter" id="memo-filter-input" placeholder="キーワードで絞り込み" oninput="onMemoFilterInput(this)">' +
    '<div class="modal-list" id="memo-modal-list">' + renderMemoListItems(log, '') + '</div>' +
    '<div class="modal-actions"><button class="btn ghost" onclick="closeMemoHistory()">閉じる</button></div>' +
    '</div></div>';
}
function renderMemoListItems(log, filter){
  const f = (filter || '').trim().toLowerCase();
  const filtered = f ? log.filter(function(e){ return e.text.toLowerCase().indexOf(f) !== -1; }) : log;
  if(!filtered.length) return '<div class="empty-note">' + (log.length ? '一致するメモがありません' : 'まだメモがありません') + '</div>';
  return filtered.map(function(e){
    const label = e.kind === 'week' ? fmtWeekLabel(parseIso(e.key)) : fmtMonthLabel(e.key);
    const d = new Date(e.savedAt);
    return '<div class="modal-list-item"><div class="meta">' + label + '　（保存: ' + d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + '）</div>' +
      '<div>' + esc(e.text) + '</div></div>';
  }).join('');
}
function onMemoFilterInput(el){
  const channel = NAV.memoModalChannel;
  document.getElementById('memo-modal-list').innerHTML = renderMemoListItems(chData(channel).memoLog, el.value);
}
function openMemoHistory(channel){ NAV.memoModalChannel = channel; NAV.memoModalOpen = true; render(); }
function closeMemoHistory(){ NAV.memoModalOpen = false; render(); }

/* ---------- interactions ---------- */
function navChannel(ch){ NAV.channel = ch; NAV.view = 'weekly'; render(); }
function navView(v){ NAV.view = v; render(); }
function navPrevWeek(){ NAV.weekStart = isoDate(addDays(parseIso(NAV.weekStart), -7)); render(); }
function navNextWeek(){ NAV.weekStart = isoDate(addDays(parseIso(NAV.weekStart), 7)); render(); }
function navThisWeek(){ NAV.weekStart = isoDate(mondayOf(new Date())); render(); }
function navPrevMonth(){
  const parts = NAV.monthKey.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 2, 1);
  NAV.monthKey = monthKeyOf(d); render();
}
function navNextMonth(){
  const parts = NAV.monthKey.split('-').map(Number);
  const d = new Date(parts[0], parts[1], 1);
  NAV.monthKey = monthKeyOf(d); render();
}
function toggleGroupCollapse(name){ NAV.collapsed[name] = !NAV.collapsed[name]; render(); }

function onQtyInput(el, channel, wk, code){
  const v = el.value === '' ? 0 : Math.max(0, parseInt(el.value, 10) || 0);
  ensureWeek(channel, wk).qty[code] = v;
  dirty = true;
  updateTotalsInPlace(channel, wk);
  updateStatusStripInPlace();
}
function updateTotalsInPlace(channel, wk){
  if(channel === 'retail'){
    const groups = groupedRetailProducts();
    groups.forEach(function(g, i){
      const el = document.getElementById('rw-gsub-' + i);
      if(el) el.textContent = fmtInt(weekGroupSubtotal('retail', wk, g.products)) + '個';
    });
    const gt = document.getElementById('rw-grand');
    if(gt) gt.textContent = fmtInt(weekGrandTotal('retail', wk)) + '個';
  } else {
    const gt = document.getElementById('ww-grand');
    if(gt) gt.textContent = fmtInt(weekGrandTotal('wholesale', wk)) + '個';
  }
}
function updateStatusStripInPlace(){
  const strips = document.querySelectorAll('.status-strip');
  const newHtml = renderStatusStrip();
  if(strips.length){
    strips[0].outerHTML = newHtml || '<div style="display:none"></div>';
  } else if(newHtml){
    document.querySelector('.topbar').insertAdjacentHTML('afterend', newHtml);
  }
}

function moveGroupUp(name){
  const arr = STATE.retail.groupOrder; const i = arr.indexOf(name);
  if(i > 0){ const tmp = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = tmp; dirty = true; render(); }
}
function moveGroupDown(name){
  const arr = STATE.retail.groupOrder; const i = arr.indexOf(name);
  if(i < arr.length - 1){ const tmp = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = tmp; dirty = true; render(); }
}
function resetGroupOrder(){ STATE.retail.groupOrder = MASTER.groupOrder.slice(); dirty = true; render(); }
async function saveGroupOrder(){ await publishState(); }

async function saveDraft(channel){ await publishState(); }
async function toggleConfirm(channel){
  const wk = NAV.weekStart;
  const w = ensureWeek(channel, wk);
  w.status = w.status === 'confirmed' ? 'draft' : 'confirmed';
  dirty = true;
  render();
  await publishState();
}
async function saveMemo(channel, kind, key, inputId){
  const text = document.getElementById(inputId).value;
  if(kind === 'week'){ ensureWeek(channel, key).memo = text; }
  else { ensureMonth(channel, key).memo = text; }
  upsertMemoLog(channel, kind, key, text);
  dirty = true;
  await publishState();
}

/* ---------- save / publish ---------- */
function showToast(msg){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(function(){ t.classList.remove('show'); }, 2600);
}
async function ensureBackend(){
  if(backendMode !== 'checking') return backendMode;
  try{
    claudeArtifact = (typeof window.claude !== 'undefined' && window.claude.use) ? await window.claude.use('artifact') : null;
  } catch(e){ claudeArtifact = null; }
  if(claudeArtifact){
    backendMode = 'artifact';
    return backendMode;
  }
  /* not running inside the Claude artifact viewer — try the Netlify Functions backend */
  try{
    const res = await fetch('/api/state', { headers: { 'accept': 'application/json' } });
    if(res.ok){
      const data = await res.json();
      backendMode = 'netlify';
      if(data && data.state){
        STATE = data.state;
        stateVersion = data.version || 0;
        render();
      }
      return backendMode;
    }
  } catch(e){ /* no backend reachable — fall through to 'none' */ }
  backendMode = 'none';
  return backendMode;
}
function buildHtml(state){
  const masterJson = JSON.stringify(MASTER).replace(/</g, '\\u003c');
  const stateJson = JSON.stringify(state).replace(/</g, '\\u003c');
  return '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>紀の里 製造予定</title>\n</head>\n<body>\n' +
    '<div id="root"></div>\n<div class="toast" id="toast"></div>\n' +
    '<script id="app-master" type="application/json">' + masterJson + '<' + '/script>\n' +
    '<script id="app-state" type="application/json">' + stateJson + '<' + '/script>\n' +
    '<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"><' + '/script>\n' +
    '<script>' + APP_SCRIPT_SOURCE + '<' + '/script>\n' +
    '</body>\n</html>';
}
async function publishState(){
  if(backendMode === 'checking') await ensureBackend();

  if(backendMode === 'artifact'){
    try{
      const html = buildHtml(STATE);
      await claudeArtifact.publish(html);
      dirty = false;
      updateStatusStripInPlace();
      showToast('✓ 保存しました');
      return true;
    } catch(err){
      const code = err && err.code;
      let msg = '保存に失敗しました。もう一度お試しください。';
      if(code === 'not_writer' || code === 'not_granted' || code === 'consent_required'){
        isReadOnly = true;
        msg = 'このビューは閲覧のみです（保存できません）';
      } else if(code === 'conflict'){
        /* another view published first; the shell is already reloading this view */
        return false;
      } else if(code === 'not_declared' || code === 'capability_disabled' || code === 'capability_removed'){
        claudeArtifact = null;
        backendMode = 'none';
        msg = 'この画面では保存できません（プレビュー表示です）';
      }
      render();
      showToast(msg);
      return false;
    }
  }

  if(backendMode === 'netlify'){
    try{
      const res = await fetch('/api/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: STATE, expectedVersion: stateVersion }),
      });
      if(res.status === 409){
        const data = await res.json();
        STATE = data.state || STATE;
        stateVersion = data.version || stateVersion;
        dirty = false;
        render();
        showToast('他の方が先に保存したため、最新の内容を読み込み直しました。もう一度入力してください。');
        return false;
      }
      if(!res.ok){
        showToast('保存に失敗しました。もう一度お試しください。');
        return false;
      }
      const data = await res.json();
      stateVersion = (data && data.version) || (stateVersion + 1);
      dirty = false;
      updateStatusStripInPlace();
      showToast('✓ 保存しました');
      return true;
    } catch(err){
      showToast('保存に失敗しました（通信エラー）。もう一度お試しください。');
      return false;
    }
  }

  updateStatusStripInPlace();
  showToast('この画面では保存できません（プレビュー表示です）');
  return false;
}

/* ---------- init ---------- */
(function init(){
  const today = new Date();
  NAV.weekStart = isoDate(mondayOf(today));
  NAV.monthKey = monthKeyOf(today);
  render();
  ensureBackend().then(function(){ updateStatusStripInPlace(); });
})();

window.navChannel = navChannel;
window.navView = navView;
window.navPrevWeek = navPrevWeek;
window.navNextWeek = navNextWeek;
window.navThisWeek = navThisWeek;
window.navPrevMonth = navPrevMonth;
window.navNextMonth = navNextMonth;
window.toggleGroupCollapse = toggleGroupCollapse;
window.onQtyInput = onQtyInput;
window.moveGroupUp = moveGroupUp;
window.moveGroupDown = moveGroupDown;
window.resetGroupOrder = resetGroupOrder;
window.saveGroupOrder = saveGroupOrder;
window.saveDraft = saveDraft;
window.toggleConfirm = toggleConfirm;
window.saveMemo = saveMemo;
window.openMemoHistory = openMemoHistory;
window.closeMemoHistory = closeMemoHistory;
window.onMemoFilterInput = onMemoFilterInput;
window.onOcrFileSelected = onOcrFileSelected;
window.resetOcr = resetOcr;
window.startOcrRecognition = startOcrRecognition;
window.toggleOcrRowInclude = toggleOcrRowInclude;
window.updateOcrRowField = updateOcrRowField;
window.applyOcrRows = applyOcrRows;
