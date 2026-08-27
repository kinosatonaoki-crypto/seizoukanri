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
  printMode: 'week', // 'week' | 'month' | 'range' — which period the print preview shows
  printRangeStart: null, // 週次計画とは独立した、カスタム週数印刷の起点週（月曜ISO日付）
  printRangeWeeks: 2, // カスタム週数印刷でまとめて印刷する週数
  collapsed: {},
  memoModalOpen: false,
  memoModalChannel: null,
  campaignModalOpen: false,
  monthlyNoteModalOpen: false,
  breakdownProductCode: null, // 「商品内訳設定」画面で選択中の商品コード
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
function getWeek(channel, wk){ return chData(channel).weeks[wk] || { status: 'draft', qty: defaultWeekQty(channel, wk), memo: '' }; }
function ensureWeek(channel, wk){
  const c = chData(channel);
  if(!c.weeks[wk]) c.weeks[wk] = { status: 'draft', qty: defaultWeekQty(channel, wk), memo: '' };
  return c.weeks[wk];
}
function getMonth(channel, mk){ return chData(channel).months[mk] || { memo: '' }; }
function ensureMonth(channel, mk){
  const c = chData(channel);
  if(!c.months[mk]) c.months[mk] = { memo: '' };
  return c.months[mk];
}
function weekKeysInMonth(channel, monthKey){
  // すべての暦週（月曜始まり）を、そのMondayが属する月として列挙する
  // （STATEにまだ何も入力されていない週も、前年実績ベースの既定値を月合計へ反映するため一覧に含める）
  const parts = monthKey.split('-').map(Number);
  const first = new Date(parts[0], parts[1] - 1, 1);
  const last = new Date(parts[0], parts[1], 0);
  const result = [];
  let d = mondayOf(first);
  if(d < first) d = addDays(d, 7);
  while(d <= last){
    result.push(isoDate(d));
    d = addDays(d, 7);
  }
  return result;
}
function groupedRetailProducts(){
  const order = STATE.retail.groupOrder;
  const byGroup = {};
  MASTER.retailProducts.forEach(function(p){ (byGroup[p.group] = byGroup[p.group] || []).push(p); });
  return order.map(function(g){ return { name: g, products: byGroup[g] || [] }; });
}
/* ---------- 卸売：取引先ごとのグループ分け ---------- */
// 各商品は「最も数量の多い取引先」に1つだけ紐付ける（通販の商品グループと同じ考え方）。
// 複数の取引先が買っている商品には otherCustomersNote() で「（他◯社）」を添える。
function groupedWholesaleProducts(){
  const order = (STATE.wholesale.groupOrder && STATE.wholesale.groupOrder.length) ? STATE.wholesale.groupOrder : (MASTER.wholesaleGroupOrder || []);
  const byCustomer = {};
  const unlinked = [];
  MASTER.wholesaleProducts.forEach(function(p){
    if(p.customerCode){ (byCustomer[p.customerCode] = byCustomer[p.customerCode] || []).push(p); }
    else { unlinked.push(p); }
  });
  const nameOf = {};
  (MASTER.wholesaleCustomers || []).forEach(function(c){ nameOf[c.code] = c.name; });
  const groups = order.map(function(code){ return { code: code, name: nameOf[code] || code, products: byCustomer[code] || [] }; });
  if(unlinked.length) groups.push({ code: null, name: '取引先未設定', products: unlinked });
  return groups;
}
function otherCustomersNote(code){
  const list = MASTER.wholesaleProductCustomers && MASTER.wholesaleProductCustomers[code];
  if(!list || list.length <= 1) return '';
  return '<span class="other-customers">（他' + (list.length - 1) + '社）</span>';
}

/* ---------- 卸売：商品ごとの内訳（割合ベース） ---------- */
// 「梅きらら70g」のように、1商品の中に複数の内訳品目（バリエーション）が内包されている場合に、
// 商品ごとに「内訳品目名＋割合(%)」をSTATE側で自由に設定でき、製造予定数を割合で按分した
// 内訳個数を週次・月次・印刷で確認できるようにする仕組み。実数がわからない前提のため、
// 割合は手動設定（0%のままなら内訳表示は行われない）。
// 梅きらら70gだけは、あらかじめ教えてもらった内訳品目名を割合0%の状態で登録しておく
// （ユーザーが「商品内訳設定」画面から割合だけ入力すればすぐ使える）。
const DEFAULT_BREAKDOWN_NAMES = {
  '104000004': ['極上漬', 'はちみつ梅', 'かつお梅', '甘口はちみつ梅', 'りんご梅', 'しそ漬梅', 'みかん梅', '白干梅', 'こんぶ梅', '極上小梅', 'しそ小梅', 'はちみつ小梅', 'かつお小梅']
};
function ensureProductBreakdowns(){
  if(!STATE.wholesale.productBreakdowns) STATE.wholesale.productBreakdowns = {};
  return STATE.wholesale.productBreakdowns;
}
function productBreakdown(code){
  const b = ensureProductBreakdowns();
  if(!b[code] && DEFAULT_BREAKDOWN_NAMES[code]){
    b[code] = DEFAULT_BREAKDOWN_NAMES[code].map(function(name){ return { id: genId(), name: name, percent: 0 }; });
  }
  return b[code] || [];
}
function breakdownTotalPercent(code){
  return productBreakdown(code).reduce(function(s, it){ return s + (it.percent || 0); }, 0);
}
function fmtPctDisplay(n){
  const r = Math.round((n || 0) * 10) / 10;
  return (r % 1 === 0) ? String(r) : r.toFixed(1);
}
function breakdownQtyList(code, qty){
  return productBreakdown(code).map(function(it){
    return { name: it.name, percent: it.percent || 0, qty: Math.round((qty || 0) * (it.percent || 0) / 100) };
  });
}
function renderBreakdownInteractiveHtml(code, qty){
  const items = productBreakdown(code);
  if(!items.length) return '';
  const key = 'bd:' + code;
  const open = !!NAV.collapsed[key];
  let out = '<button type="button" class="link-btn breakdown-toggle no-print" onclick="toggleGroupCollapse(\'' + key + '\')">' +
    (open ? '▲ 内訳を閉じる' : '▼ 内訳を見る') + '（' + items.length + '品目）</button>';
  if(open){
    const totalPct = breakdownTotalPercent(code);
    const off = items.length && Math.round(totalPct * 10) / 10 !== 100;
    out += '<table class="breakdown-table no-print"><tbody>';
    items.forEach(function(it, idx){
      const n = Math.round((qty || 0) * (it.percent || 0) / 100);
      out += '<tr><td class="bd-name">' + esc(it.name || '（品目名未設定）') + '</td>' +
        '<td class="bd-pct">' + fmtPctDisplay(it.percent) + '%</td>' +
        '<td class="bd-qty" id="bd-qty-' + esc(code) + '-' + idx + '">' + fmtInt(n) + '個</td></tr>';
    });
    out += '</tbody></table>';
    if(off){
      out += '<div class="breakdown-warn no-print">※ 割合の合計が' + fmtPctDisplay(totalPct) + '%です（「商品内訳設定」で100%になるよう調整してください）</div>';
    }
  }
  return out;
}
function updateBreakdownInPlace(code, qty){
  const items = productBreakdown(code);
  if(!items.length) return;
  items.forEach(function(it, idx){
    const el = document.getElementById('bd-qty-' + code + '-' + idx);
    if(el) el.textContent = fmtInt(Math.round((qty || 0) * (it.percent || 0) / 100)) + '個';
  });
}
function renderBreakdownPrintRow(code, qty){
  const items = productBreakdown(code);
  if(!items.length || !qty) return '';
  const parts = breakdownQtyList(code, qty).map(function(it){
    return esc(it.name || '（品目名未設定）') + ' ' + fmtInt(it.qty) + '個';
  });
  return '<tr class="print-breakdown-row"><td></td><td colspan="2" class="print-breakdown">内訳：' + parts.join('／') + '</td></tr>';
}
function weekGroupSubtotal(channel, wk, products){
  const q = getWeek(channel, wk).qty;
  return products.reduce(function(s, p){ return s + (q[p.code] || 0); }, 0);
}
function weekGrandTotal(channel, wk){
  const q = getWeek(channel, wk).qty;
  return Object.keys(q).reduce(function(s, k){ return s + (q[k] || 0); }, 0);
}
function rangeGroupSubtotal(channel, wks, products){
  return products.reduce(function(s, p){
    return s + wks.reduce(function(s2, wk){ return s2 + (getWeek(channel, wk).qty[p.code] || 0); }, 0);
  }, 0);
}
function rangeProductTotal(channel, wks, code){
  return wks.reduce(function(s, wk){ return s + (getWeek(channel, wk).qty[code] || 0); }, 0);
}
function monthGroupSubtotal(channel, monthKey, products){
  return rangeGroupSubtotal(channel, weekKeysInMonth(channel, monthKey), products);
}
function monthProductTotal(channel, monthKey, code){
  return rangeProductTotal(channel, weekKeysInMonth(channel, monthKey), code);
}
function rangeGrandTotal(channel, wks){
  return wks.reduce(function(s, wk){ return s + weekGrandTotal(channel, wk); }, 0);
}
function rangeWeekKeys(startWk, count){
  const keys = [];
  for(let i = 0; i < count; i++){
    keys.push(isoDate(addDays(parseIso(startWk), i * 7)));
  }
  return keys;
}
function fmtRangeLabel(wks){
  const first = parseIso(wks[0]);
  const last = addDays(parseIso(wks[wks.length - 1]), 6);
  const tail = first.getFullYear() === last.getFullYear()
    ? (last.getMonth() + 1) + '月' + last.getDate() + '日'
    : fmtDateJp(last);
  return fmtDateJp(first) + '(' + DOW_JP[first.getDay()] + ') 〜 ' + tail + '(' + DOW_JP[last.getDay()] + ')';
}
/* ---------- 実績参考（前年同期・前々年同期） ---------- */
function refWeekIso(wk, yearsBack){
  return isoDate(addDays(parseIso(wk), -364 * yearsBack));
}
function historyQty(channel, code, wk, yearsBack){
  const hist = MASTER.salesHistory && MASTER.salesHistory[channel] && MASTER.salesHistory[channel][code];
  if(!hist) return null;
  const refWk = refWeekIso(wk, yearsBack);
  const v = hist[refWk];
  return (typeof v === 'number') ? v : null;
}
function renderWeekRefHtml(channel, code, wk){
  const y1 = historyQty(channel, code, wk, 1);
  const y2 = historyQty(channel, code, wk, 2);
  if(y1 === null && y2 === null) return '';
  const parts = [];
  if(y1 !== null) parts.push('前年' + fmtInt(y1) + '個');
  if(y2 !== null) parts.push('前々年' + fmtInt(y2) + '個');
  return '<div class="week-ref">参考（同時期実績）: ' + parts.join('／') + '</div>';
}
function roundUpToTens(n){ return Math.ceil(n / 10) * 10; }

/* ---------- 前年実績＋キャンペーンによる既定値（製造予定の初期値） ---------- */
// 通販・卸売どちらも対応。salesHistory[channel] に実績データが無い間は既定値なし＝従来どおり空欄になる
// （卸売は実績データの整備待ち。データが揃い次第、何もコードを変えなくても自動的に反映される）。
// キャンペーン増加分は通販のみの概念（卸売には無い）。
// まだ何も入力されていない週は、この既定値がそのまま「製造予定数」として最初から表示される。
// 1回のrender()内で何度も呼ばれるため、週ごとに結果をキャッシュする（render()の先頭でクリア）。
let _defaultQtyCache = {};
function defaultWeekEntries(channel, wk){
  const cacheKey = channel + '|' + wk;
  if(_defaultQtyCache[cacheKey]) return _defaultQtyCache[cacheKey];
  const campaignBumpByCode = {};
  if(channel === 'retail'){
    weekCampaigns(wk).forEach(function(c){
      campaignBumpByCode[c.code] = (campaignBumpByCode[c.code] || 0) + c.qty;
    });
  } else {
    const mk = monthKeyOf(parseIso(wk));
    const notes = monthNotes(mk);
    if(notes.length){
      const weekCount = weekKeysInMonth('wholesale', mk).length || 1;
      notes.forEach(function(n){
        campaignBumpByCode[n.code] = (campaignBumpByCode[n.code] || 0) + (n.qty / weekCount);
      });
    }
  }
  const products = channel === 'retail' ? MASTER.retailProducts : MASTER.wholesaleProducts;
  const entries = [];
  products.forEach(function(p){
    const h = historyQty(channel, p.code, wk, 1);
    const bump = campaignBumpByCode[p.code] || 0;
    if(h === null && !bump) return;
    const raw = (h || 0) + bump;
    entries.push({ code: p.code, qty: Math.max(0, roundUpToTens(raw)), hasBump: bump !== 0 });
  });
  _defaultQtyCache[cacheKey] = entries;
  return entries;
}
function defaultWeekQty(channel, wk){
  const qty = {};
  defaultWeekEntries(channel, wk).forEach(function(e){ qty[e.code] = e.qty; });
  return qty;
}
function autoFillFromLastYear(channel){
  const wk = NAV.weekStart;
  const week = ensureWeek(channel, wk);
  const targets = defaultWeekEntries(channel, wk);
  if(!targets.length){
    showToast('前年の同じ週の実績データがある商品が見つかりませんでした。');
    return;
  }
  const willOverwrite = targets.some(function(t){ return (week.qty[t.code] || 0) > 0 && week.qty[t.code] !== t.qty; });
  if(willOverwrite){
    const ok = window.confirm('すでに入力されている数量を、前年実績（10個単位に切り上げ）で上書きします。よろしいですか？');
    if(!ok) return;
  }
  targets.forEach(function(t){ week.qty[t.code] = t.qty; });
  dirty = true;
  render();
  const bumpCount = targets.filter(function(t){ return t.hasBump; }).length;
  const bumpLabel = channel === 'retail' ? 'キャンペーン分' : '特記事項分';
  showToast('✓ ' + targets.length + '品目を前年実績（10個単位に切り上げ）にリセットしました' +
    (bumpCount ? '（うち' + bumpLabel + 'を含む: ' + bumpCount + '品目）' : '') + '。内容を確認して保存してください。');
}

/* ---------- 実施中のキャンペーン（増加分の登録） ---------- */
function genId(){ return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function weekCampaigns(wk){
  const c = STATE.retail.campaigns;
  return (c && c[wk]) || [];
}
function openCampaignModal(){ NAV.campaignModalOpen = true; render(); }
function closeCampaignModal(){ NAV.campaignModalOpen = false; render(); }
function submitCampaign(){
  const wk = NAV.weekStart;
  const code = document.getElementById('cmp-product').value;
  const title = document.getElementById('cmp-title').value.trim();
  const qty = parseInt(document.getElementById('cmp-qty').value, 10);
  const memo = document.getElementById('cmp-memo').value.trim();
  if(!code || !title || !qty || qty <= 0){
    showToast('対象商品・施策名・増加数量（1以上）を入力してください。');
    return;
  }
  if(!STATE.retail.campaigns) STATE.retail.campaigns = {};
  if(!STATE.retail.campaigns[wk]) STATE.retail.campaigns[wk] = [];
  STATE.retail.campaigns[wk].push({ id: genId(), code: code, title: title, qty: qty, memo: memo });
  dirty = true;
  NAV.campaignModalOpen = false;
  render();
  showToast('✓ キャンペーンを追加しました。内容を確認して保存してください。');
}
function deleteCampaign(wk, id){
  if(!STATE.retail.campaigns || !STATE.retail.campaigns[wk]) return;
  STATE.retail.campaigns[wk] = STATE.retail.campaigns[wk].filter(function(c){ return c.id !== id; });
  dirty = true;
  render();
}
function renderCampaignBanner(wk){
  const list = weekCampaigns(wk);
  let out = '<div class="campaign-banner no-print"><div class="campaign-icon">📣</div><div class="campaign-body">' +
    '<div class="campaign-title-row"><div class="campaign-title">現在実施中のキャンペーン</div>' +
    '<button class="link-btn" onclick="openCampaignModal()" ' + (isReadOnly ? 'disabled' : '') + '>＋ 増加分を追加</button></div>';
  if(!list.length){
    out += '<div style="color:var(--muted);font-size:12.5px;">この週に登録されているキャンペーンはありません</div>';
  } else {
    out += '<div class="campaign-list">';
    list.forEach(function(c){
      const p = MASTER.retailProducts.find(function(pp){ return pp.code === c.code; });
      out += '<div class="campaign-chip"><b>' + esc(c.title) + '</b> ' + esc(p ? p.name : c.code) +
        ' <span class="delta">+' + fmtInt(c.qty) + '個</span>' +
        (c.memo ? ' <span class="camp-memo-note">・' + esc(c.memo) + '</span>' : '') +
        ' <button class="camp-del" onclick="deleteCampaign(\'' + wk + '\',\'' + c.id + '\')" ' + (isReadOnly ? 'disabled' : '') + '>×</button></div>';
    });
    out += '</div>';
  }
  out += '</div></div>';
  return out;
}
function renderCampaignModal(){
  if(!NAV.campaignModalOpen) return '';
  const products = MASTER.retailProducts;
  return '<div class="modal-overlay open"><div class="modal-box">' +
    '<div class="modal-title">増加分を追加</div>' +
    '<div class="modal-sub">お中元・お歳暮のDMやカタログ、催事など、通常予測を上回る予定がある場合にここから登録します（' +
      fmtWeekLabel(parseIso(NAV.weekStart)) + 'の週に登録されます）。</div>' +
    '<div class="field"><label>対象商品</label><select id="cmp-product">' +
      products.map(function(p){ return '<option value="' + esc(p.code) + '">' + esc(p.name) + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>施策名</label><input type="text" id="cmp-title" placeholder="例：秋の贈答フェア"></div>' +
      '<div class="field"><label>増加数量</label><input type="number" id="cmp-qty" min="1" placeholder="例：200"></div>' +
    '</div>' +
    '<div class="field"><label>メモ（任意）</label><textarea id="cmp-memo" placeholder="例：お中元DM・表紙掲載"></textarea></div>' +
    '<div class="modal-actions"><button class="btn ghost" onclick="closeCampaignModal()">キャンセル</button>' +
    '<button class="btn primary" onclick="submitCampaign()">追加する</button></div>' +
    '</div></div>';
}

/* ---------- 卸売：今月の特記事項（増減分の登録） ---------- */
function monthNotes(mk){
  const n = STATE.wholesale.monthlyNotes;
  return (n && n[mk]) || [];
}
function openMonthlyNoteModal(){ NAV.monthlyNoteModalOpen = true; render(); }
function closeMonthlyNoteModal(){ NAV.monthlyNoteModalOpen = false; render(); }
function submitMonthlyNote(){
  const mk = NAV.monthKey;
  const code = document.getElementById('mnote-product').value;
  const title = document.getElementById('mnote-title').value.trim();
  const qty = parseInt(document.getElementById('mnote-qty').value, 10);
  const memo = document.getElementById('mnote-memo').value.trim();
  if(!code || !title || !qty){
    showToast('対象商品・件名・増減数量（0以外）を入力してください。');
    return;
  }
  if(!STATE.wholesale.monthlyNotes) STATE.wholesale.monthlyNotes = {};
  if(!STATE.wholesale.monthlyNotes[mk]) STATE.wholesale.monthlyNotes[mk] = [];
  STATE.wholesale.monthlyNotes[mk].push({ id: genId(), code: code, title: title, qty: qty, memo: memo });
  dirty = true;
  NAV.monthlyNoteModalOpen = false;
  render();
  showToast('✓ 特記事項を追加しました。内容を確認して保存してください。');
}
function deleteMonthlyNote(mk, id){
  if(!STATE.wholesale.monthlyNotes || !STATE.wholesale.monthlyNotes[mk]) return;
  STATE.wholesale.monthlyNotes[mk] = STATE.wholesale.monthlyNotes[mk].filter(function(n){ return n.id !== id; });
  dirty = true;
  render();
}
function renderMonthlyNoteBanner(mk){
  const list = monthNotes(mk);
  let out = '<div class="campaign-banner no-print"><div class="campaign-icon">📝</div><div class="campaign-body">' +
    '<div class="campaign-title-row"><div class="campaign-title">今月の特記事項</div>' +
    '<button class="link-btn" onclick="openMonthlyNoteModal()" ' + (isReadOnly ? 'disabled' : '') + '>＋ 特記事項を追加</button></div>';
  if(!list.length){
    out += '<div style="color:var(--muted);font-size:12.5px;">この月に登録されている特記事項はありません</div>';
  } else {
    out += '<div class="campaign-list">';
    list.forEach(function(n){
      const p = MASTER.wholesaleProducts.find(function(pp){ return pp.code === n.code; });
      const neg = n.qty < 0;
      out += '<div class="campaign-chip"><b>' + esc(n.title) + '</b> ' + esc(p ? p.name : n.code) +
        ' <span class="delta' + (neg ? ' negative' : '') + '">' + (neg ? '' : '+') + fmtInt(n.qty) + '個</span>' +
        (n.memo ? ' <span class="camp-memo-note">・' + esc(n.memo) + '</span>' : '') +
        ' <button class="camp-del" onclick="deleteMonthlyNote(\'' + mk + '\',\'' + n.id + '\')" ' + (isReadOnly ? 'disabled' : '') + '>×</button></div>';
    });
    out += '</div>';
  }
  out += '</div></div>';
  return out;
}
function renderMonthlyNoteModal(){
  if(!NAV.monthlyNoteModalOpen) return '';
  const products = MASTER.wholesaleProducts;
  return '<div class="modal-overlay open"><div class="modal-box">' +
    '<div class="modal-title">特記事項を追加</div>' +
    '<div class="modal-sub">取引先の催事出店・スポット発注・取引縮小など、前年実績だけでは読めない増減が見込まれる場合に' +
      'ここから登録します（' + fmtMonthLabel(NAV.monthKey) + 'に登録されます）。増える場合はプラス、減る場合はマイナスの数量を入力してください。</div>' +
    '<div class="field"><label>対象商品</label><select id="mnote-product">' +
      products.map(function(p){ return '<option value="' + esc(p.code) + '">' + esc(p.name) + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>件名</label><input type="text" id="mnote-title" placeholder="例：〇〇物産展に出店"></div>' +
      '<div class="field"><label>増減数量</label><input type="number" id="mnote-qty" placeholder="例：300　減る場合は-100など"></div>' +
    '</div>' +
    '<div class="field"><label>メモ（任意）</label><textarea id="mnote-memo" placeholder="例：A社より事前連絡あり"></textarea></div>' +
    '<div class="modal-actions"><button class="btn ghost" onclick="closeMonthlyNoteModal()">キャンセル</button>' +
    '<button class="btn primary" onclick="submitMonthlyNote()">追加する</button></div>' +
    '</div></div>';
}
function monthGrandTotal(channel, monthKey){
  return rangeGrandTotal(channel, weekKeysInMonth(channel, monthKey));
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
  _defaultQtyCache = {};
  document.getElementById('root').innerHTML = renderApp();
}
function renderApp(){
  return renderTopbar() + renderStatusStrip() + renderBody() + renderMemoModal() + renderCampaignModal() + renderMonthlyNoteModal();
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
    '<button class="btn ghost" onclick="autoFillFromLastYear(\'retail\')" ' + (isReadOnly ? 'disabled' : '') + '>🔄 前年実績にリセット</button>' +
    '<button class="btn primary" onclick="toggleConfirm(\'retail\')" ' + (isReadOnly ? 'disabled' : '') + '>' +
      (week.status === 'confirmed' ? '↩ 下書きに戻す' : 'この週を確定する') + '</button>' +
    '</div>';
  out += renderCampaignBanner(wk);
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
          '<td class="annual">' + renderWeekRefHtml('retail', p.code, wk) + '年間参考 ' + fmtInt(p.annualQty) + '個</td>' +
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
    '<button class="btn ghost" onclick="autoFillFromLastYear(\'retail\')" ' + (isReadOnly ? 'disabled' : '') + '>🔄 前年実績にリセット（10個単位に切り上げ）</button>' +
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

/* ---------- print preview (both channels, week or month, real entered quantities) ---------- */
function setPrintMode(mode){
  NAV.printMode = mode;
  if(mode === 'range' && !NAV.printRangeStart) NAV.printRangeStart = NAV.weekStart;
  render();
}
function navPrintRangePrev(){
  if(!NAV.printRangeStart) NAV.printRangeStart = NAV.weekStart;
  NAV.printRangeStart = isoDate(addDays(parseIso(NAV.printRangeStart), -7 * NAV.printRangeWeeks));
  render();
}
function navPrintRangeNext(){
  if(!NAV.printRangeStart) NAV.printRangeStart = NAV.weekStart;
  NAV.printRangeStart = isoDate(addDays(parseIso(NAV.printRangeStart), 7 * NAV.printRangeWeeks));
  render();
}
function setPrintRangeWeeks(n){
  n = Math.max(1, Math.min(8, parseInt(n, 10) || 1));
  NAV.printRangeWeeks = n;
  render();
}
function renderPrintView(channel){
  const mode = NAV.printMode || 'week';
  let out = '<div class="subnav no-print">' +
    '<button class="' + (mode === 'week' ? 'active' : '') + '" onclick="setPrintMode(\'week\')">週次で印刷</button>' +
    '<button class="' + (mode === 'month' ? 'active' : '') + '" onclick="setPrintMode(\'month\')">月次で印刷</button>' +
    '<button class="' + (mode === 'range' ? 'active' : '') + '" onclick="setPrintMode(\'range\')">週数指定で印刷</button>' +
    '</div>';
  if(mode === 'month') return out + renderPrintViewMonth(channel);
  if(mode === 'range') return out + renderPrintViewRange(channel);
  return out + renderPrintViewWeek(channel);
}
function renderPrintViewWeek(channel){
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
    const groups = groupedWholesaleProducts();
    groups.forEach(function(g, i){
      const items = g.products.filter(function(p){ return (week.qty[p.code] || 0) > 0; });
      if(!items.length) return;
      const subtotal = items.reduce(function(s, p){ return s + (week.qty[p.code] || 0); }, 0);
      out += '<div class="print-group">' +
        '<div class="print-group-title"><span class="rank">' + pad2(i + 1) + '</span><span class="gname">' + esc(g.name) + '</span><span class="gtotal">小計 <b>' + fmtInt(subtotal) + '個</b></span></div>' +
        '<table class="print-table"><tbody>';
      items.forEach(function(p){
        out += '<tr><td class="code">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="qty">' + fmtInt(week.qty[p.code]) + '</td></tr>';
        out += renderBreakdownPrintRow(p.code, week.qty[p.code]);
      });
      out += '</tbody></table></div>';
    });
    out += '<div class="print-grand">製造予定合計　<b>' + fmtInt(weekGrandTotal('wholesale', wk)) + '個</b></div>';
  }
  out += '</div>';
  return out;
}
function renderPrintViewMonth(channel){
  const mk = NAV.monthKey;
  const grand = monthGrandTotal(channel, mk);
  let out = '<div class="print-toolbar no-print">' +
    '<button class="nav-arrow" onclick="navPrevMonth()">‹</button>' +
    '<div class="period-label">' + fmtMonthLabel(mk) + '</div>' +
    '<button class="nav-arrow" onclick="navNextMonth()">›</button>' +
    '<div class="spacer"></div>' +
    '<button class="btn primary" onclick="window.print()">🖨 このページを印刷</button>' +
    '</div>';
  out += '<div class="print-sheet">';
  out += '<div class="print-head">' +
    '<div class="print-title">製造予定表　' + (channel === 'retail' ? '通信販売' : '卸販売') + '</div>' +
    '<div class="print-sub">' + fmtMonthLabel(mk) + '　（月次合計）</div>' +
    '</div>';
  if(grand === 0){
    out += '<div class="empty-note">この月はまだ製造予定数が入力されていません。週次計画画面で数量を入力すると、ここに月合計として反映されます。</div>';
  } else if(channel === 'retail'){
    const groups = groupedRetailProducts();
    groups.forEach(function(g, i){
      const items = g.products.filter(function(p){ return monthProductTotal('retail', mk, p.code) > 0; });
      if(!items.length) return;
      const subtotal = monthGroupSubtotal('retail', mk, g.products);
      out += '<div class="print-group">' +
        '<div class="print-group-title"><span class="rank">' + pad2(i + 1) + '</span><span class="gname">' + esc(g.name) + '</span><span class="gtotal">小計 <b>' + fmtInt(subtotal) + '個</b></span></div>' +
        '<table class="print-table"><tbody>';
      items.forEach(function(p){
        out += '<tr><td class="code">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="qty">' + fmtInt(monthProductTotal('retail', mk, p.code)) + '</td></tr>';
      });
      out += '</tbody></table></div>';
    });
    out += '<div class="print-grand">製造予定合計　<b>' + fmtInt(grand) + '個</b></div>';
  } else {
    const groups = groupedWholesaleProducts();
    groups.forEach(function(g, i){
      const items = g.products.filter(function(p){ return monthProductTotal('wholesale', mk, p.code) > 0; });
      if(!items.length) return;
      const subtotal = monthGroupSubtotal('wholesale', mk, g.products);
      out += '<div class="print-group">' +
        '<div class="print-group-title"><span class="rank">' + pad2(i + 1) + '</span><span class="gname">' + esc(g.name) + '</span><span class="gtotal">小計 <b>' + fmtInt(subtotal) + '個</b></span></div>' +
        '<table class="print-table"><tbody>';
      items.forEach(function(p){
        out += '<tr><td class="code">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="qty">' + fmtInt(monthProductTotal('wholesale', mk, p.code)) + '</td></tr>';
        out += renderBreakdownPrintRow(p.code, monthProductTotal('wholesale', mk, p.code));
      });
      out += '</tbody></table></div>';
    });
    out += '<div class="print-grand">製造予定合計　<b>' + fmtInt(grand) + '個</b></div>';
  }
  out += '</div>';
  return out;
}
function renderPrintViewRange(channel){
  if(!NAV.printRangeStart) NAV.printRangeStart = NAV.weekStart;
  const weeksCount = NAV.printRangeWeeks || 2;
  const wks = rangeWeekKeys(NAV.printRangeStart, weeksCount);
  const grand = rangeGrandTotal(channel, wks);
  const weekOptions = [2, 3, 4, 5, 6].map(function(n){
    return '<option value="' + n + '"' + (n === weeksCount ? ' selected' : '') + '>' + n + '週分</option>';
  }).join('');
  let out = '<div class="print-toolbar no-print">' +
    '<button class="nav-arrow" onclick="navPrintRangePrev()">‹</button>' +
    '<div class="period-label">' + fmtRangeLabel(wks) + '</div>' +
    '<button class="nav-arrow" onclick="navPrintRangeNext()">›</button>' +
    '<select onchange="setPrintRangeWeeks(this.value)">' + weekOptions + '</select>' +
    '<div class="spacer"></div>' +
    '<button class="btn primary" onclick="window.print()">🖨 このページを印刷</button>' +
    '</div>';
  out += '<div class="range-weeks-note no-print">含まれる週：' +
    wks.map(function(w){
      const st = getWeek(channel, w).status;
      return '<span class="week-chip ' + st + '">' + fmtWeekLabel(parseIso(w)) + (st === 'confirmed' ? ' 確定' : ' 下書き') + '</span>';
    }).join('') + '</div>';
  out += '<div class="print-sheet">';
  out += '<div class="print-head">' +
    '<div class="print-title">製造予定表　' + (channel === 'retail' ? '通信販売' : '卸販売') + '</div>' +
    '<div class="print-sub">' + fmtRangeLabel(wks) + '　（' + weeksCount + '週分合計）</div>' +
    '</div>';
  if(grand === 0){
    out += '<div class="empty-note">この期間はまだ製造予定数が入力されていません。週次計画画面で数量を入力すると、ここに合計として反映されます。</div>';
  } else if(channel === 'retail'){
    const groups = groupedRetailProducts();
    groups.forEach(function(g, i){
      const items = g.products.filter(function(p){ return rangeProductTotal('retail', wks, p.code) > 0; });
      if(!items.length) return;
      const subtotal = rangeGroupSubtotal('retail', wks, g.products);
      out += '<div class="print-group">' +
        '<div class="print-group-title"><span class="rank">' + pad2(i + 1) + '</span><span class="gname">' + esc(g.name) + '</span><span class="gtotal">小計 <b>' + fmtInt(subtotal) + '個</b></span></div>' +
        '<table class="print-table"><tbody>';
      items.forEach(function(p){
        out += '<tr><td class="code">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="qty">' + fmtInt(rangeProductTotal('retail', wks, p.code)) + '</td></tr>';
      });
      out += '</tbody></table></div>';
    });
    out += '<div class="print-grand">製造予定合計　<b>' + fmtInt(grand) + '個</b></div>';
  } else {
    const groups = groupedWholesaleProducts();
    groups.forEach(function(g, i){
      const items = g.products.filter(function(p){ return rangeProductTotal('wholesale', wks, p.code) > 0; });
      if(!items.length) return;
      const subtotal = rangeGroupSubtotal('wholesale', wks, g.products);
      out += '<div class="print-group">' +
        '<div class="print-group-title"><span class="rank">' + pad2(i + 1) + '</span><span class="gname">' + esc(g.name) + '</span><span class="gtotal">小計 <b>' + fmtInt(subtotal) + '個</b></span></div>' +
        '<table class="print-table"><tbody>';
      items.forEach(function(p){
        out += '<tr><td class="code">' + esc(p.code) + '</td><td>' + esc(p.name) + '</td><td class="qty">' + fmtInt(rangeProductTotal('wholesale', wks, p.code)) + '</td></tr>';
        out += renderBreakdownPrintRow(p.code, rangeProductTotal('wholesale', wks, p.code));
      });
      out += '</tbody></table></div>';
    });
    out += '<div class="print-grand">製造予定合計　<b>' + fmtInt(grand) + '個</b></div>';
  }
  out += '</div>';
  return out;
}

/* ---------- wholesale ---------- */
function renderWholesaleBody(){
  let out = '<div class="subnav no-print">' +
    '<button class="' + (NAV.view === 'weekly' ? 'active' : '') + '" onclick="navView(\'weekly\')">週次計画</button>' +
    '<button class="' + (NAV.view === 'monthly' ? 'active' : '') + '" onclick="navView(\'monthly\')">月次計画</button>' +
    '<button class="' + (NAV.view === 'grouporder' ? 'active' : '') + '" onclick="navView(\'grouporder\')">取引先並び順</button>' +
    '<button class="' + (NAV.view === 'breakdown' ? 'active' : '') + '" onclick="navView(\'breakdown\')">商品内訳設定</button>' +
    '<button class="' + (NAV.view === 'ocr' ? 'active' : '') + '" onclick="navView(\'ocr\')">📷 OCR取込</button>' +
    '<button class="' + (NAV.view === 'print' ? 'active' : '') + '" onclick="navView(\'print\')">🖨 印刷プレビュー</button>' +
    '</div><div class="view-pad">';
  if(NAV.view === 'weekly' || NAV.view === 'monthly') out += '<div class="known-issue">卸売は「主にどの取引先が買っているか」で商品をグループ分けして表示しています（1つの商品は最も数量の多い取引先1社に紐付けています。他の取引先も買っている商品には「（他◯社）」と表示されます）。ただし製造予定数はこれまでどおり商品ごとの合計1つだけを入力する形式で、取引先別の内訳数量はまだ管理していません。</div>';
  if(NAV.view === 'weekly') out += renderWholesaleWeekly();
  else if(NAV.view === 'monthly') out += renderWholesaleMonthly();
  else if(NAV.view === 'grouporder') out += renderWholesaleGroupOrderView();
  else if(NAV.view === 'breakdown') out += renderWholesaleBreakdownView();
  else if(NAV.view === 'ocr') out += renderOcrView('wholesale');
  else out += renderPrintView('wholesale');
  out += '</div>';
  return out;
}
function renderWholesaleWeekly(){
  const wk = NAV.weekStart;
  const monday = parseIso(wk);
  const week = getWeek('wholesale', wk);
  const groups = groupedWholesaleProducts();
  let out = '<div class="week-nav">' +
    '<button class="nav-arrow" onclick="navPrevWeek()">‹</button>' +
    '<div class="period-label">' + fmtWeekLabel(monday) + '</div>' +
    '<button class="nav-arrow" onclick="navNextWeek()">›</button>' +
    '<span class="status-badge ' + week.status + '">' + (week.status === 'confirmed' ? '✓ 確定済み' : '下書き') + '</span>' +
    '<div class="spacer"></div>' +
    '<button class="this-week-btn" onclick="navThisWeek()">今週へ</button>' +
    '<button class="btn ghost" onclick="autoFillFromLastYear(\'wholesale\')" ' + (isReadOnly ? 'disabled' : '') + '>🔄 前年実績にリセット</button>' +
    '<button class="btn primary" onclick="toggleConfirm(\'wholesale\')" ' + (isReadOnly ? 'disabled' : '') + '>' +
      (week.status === 'confirmed' ? '↩ 下書きに戻す' : 'この週を確定する') + '</button>' +
    '</div>';
  groups.forEach(function(g, i){
    if(!g.products.length) return;
    const collapsed = !!NAV.collapsed['w:' + (g.code || g.name)];
    out += '<div class="group-section">' +
      '<div class="group-head" onclick="toggleGroupCollapse(\'w:' + esc(g.code || g.name) + '\')">' +
        '<span class="group-rank">' + pad2(i + 1) + '</span>' +
        '<span class="group-name">' + esc(g.name) + '</span>' +
        '<span class="group-sub">' + fmtInt(weekGroupSubtotal('wholesale', wk, g.products)) + '個</span>' +
        '<span class="collapse-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
      '</div>';
    if(!collapsed){
      out += '<table class="item-table"><tbody>';
      g.products.forEach(function(p){
        const v = week.qty[p.code] || '';
        out += '<tr><td class="name">' + esc(p.name) + otherCustomersNote(p.code) + '</td>' +
          '<td class="annual">' + renderWeekRefHtml('wholesale', p.code, wk) + '年間参考 ' + fmtInt(p.annualQty) + '個</td>' +
          '<td class="qtycell"><input type="number" min="0" inputmode="numeric" value="' + (v === 0 ? '' : v) + '" placeholder="0" ' +
          (isReadOnly ? 'disabled' : '') + ' oninput="onQtyInput(this,\'wholesale\',\'' + wk + '\',\'' + p.code + '\')"></td></tr>';
        const bdHtml = renderBreakdownInteractiveHtml(p.code, week.qty[p.code] || 0);
        if(bdHtml) out += '<tr class="breakdown-row"><td colspan="3">' + bdHtml + '</td></tr>';
      });
      out += '</tbody></table>';
    }
    out += '</div>';
  });
  out += '<div class="footer-bar">' +
    '<div class="grand-total">今週の製造予定合計<b id="ww-grand">' + fmtInt(weekGrandTotal('wholesale', wk)) + '個</b></div>' +
    '<div class="spacer"></div>' +
    '<button class="btn ghost" onclick="autoFillFromLastYear(\'wholesale\')" ' + (isReadOnly ? 'disabled' : '') + '>🔄 前年実績にリセット（10個単位に切り上げ）</button>' +
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
  const groups = groupedWholesaleProducts();
  let out = '<div class="month-nav">' +
    '<button class="nav-arrow" onclick="navPrevMonth()">‹</button>' +
    '<div class="period-label">' + fmtMonthLabel(mk) + '</div>' +
    '<button class="nav-arrow" onclick="navNextMonth()">›</button>' +
    '</div>';
  out += renderMonthlyNoteBanner(mk);
  out += '<div class="month-weeks-note">この月に含まれる週（各週の製造予定をそのまま積み上げた合計です）：' +
    (wks.length ? wks.map(function(w){
      const st = getWeek('wholesale', w).status;
      return '<span class="week-chip ' + st + '">' + fmtWeekLabel(parseIso(w)) + (st === 'confirmed' ? ' 確定' : ' 下書き') + '</span>';
    }).join('') : '<span style="color:var(--muted)">まだこの月に入力された週がありません</span>') +
    '</div>';
  out += '<div class="wide-table-wrap"><table class="month-table"><thead><tr><th class="name">商品（主な取引先順）</th><th>月合計</th></tr></thead><tbody>';
  groups.forEach(function(g, i){
    if(!g.products.length) return;
    out += '<tr class="group-row"><td class="name">' + pad2(i + 1) + '　' + esc(g.name) + '</td><td>' + fmtInt(monthGroupSubtotal('wholesale', mk, g.products)) + '個</td></tr>';
    g.products.forEach(function(p){
      const t = monthProductTotal('wholesale', mk, p.code);
      if(t === 0) return;
      out += '<tr><td class="name">　' + esc(p.name) + otherCustomersNote(p.code) + '</td><td>' + fmtInt(t) + '個</td></tr>';
      const bdHtml = renderBreakdownInteractiveHtml(p.code, t);
      if(bdHtml) out += '<tr class="breakdown-row"><td colspan="2">' + bdHtml + '</td></tr>';
    });
  });
  out += '</tbody></table></div>';
  out += '<div class="footer-bar"><div class="grand-total">' + fmtMonthLabel(mk) + 'の製造予定合計<b>' + fmtInt(monthGrandTotal('wholesale', mk)) + '個</b></div></div>';
  out += renderMemoCard('wholesale', 'month', mk, month.memo);
  return out;
}
function renderWholesaleGroupOrderView(){
  const order = (STATE.wholesale.groupOrder && STATE.wholesale.groupOrder.length) ? STATE.wholesale.groupOrder : (MASTER.wholesaleGroupOrder || []);
  const nameOf = {};
  (MASTER.wholesaleCustomers || []).forEach(function(c){ nameOf[c.code] = c.name; });
  const byCustomer = {};
  MASTER.wholesaleProducts.forEach(function(p){ if(p.customerCode) (byCustomer[p.customerCode] = byCustomer[p.customerCode] || []).push(p); });
  let out = '<div class="known-issue">並び順は週次・月次の計画画面・印刷プレビューに共通で反映されます。変更後は「この並び順を保存」を押してください。</div>';
  out += '<div class="grouporder-list">';
  order.forEach(function(code, i){
    const products = byCustomer[code] || [];
    out += '<div class="go-row">' +
      '<span class="go-rank">' + pad2(i + 1) + '</span>' +
      '<span class="go-name">' + esc(nameOf[code] || code) + '</span>' +
      '<span class="go-count">' + products.length + '品目</span>' +
      '<span class="go-arrows">' +
        '<button onclick="moveWholesaleGroupUp(\'' + esc(code) + '\')" ' + (i === 0 ? 'disabled' : '') + '>▲</button>' +
        '<button onclick="moveWholesaleGroupDown(\'' + esc(code) + '\')" ' + (i === order.length - 1 ? 'disabled' : '') + '>▼</button>' +
      '</span></div>';
  });
  out += '</div>';
  out += '<div class="go-bottom">' +
    '<button class="btn ghost" onclick="resetWholesaleGroupOrder()" ' + (isReadOnly ? 'disabled' : '') + '>初期値（年間売上順）に戻す</button>' +
    '<button class="btn primary" onclick="saveGroupOrder()" ' + (isReadOnly ? 'disabled' : '') + '>この並び順を保存</button>' +
    '</div>';
  return out;
}
function renderWholesaleBreakdownView(){
  if(!NAV.breakdownProductCode) NAV.breakdownProductCode = Object.keys(DEFAULT_BREAKDOWN_NAMES)[0] || (MASTER.wholesaleProducts[0] && MASTER.wholesaleProducts[0].code);
  const code = NAV.breakdownProductCode;
  const items = productBreakdown(code);
  const totalPct = breakdownTotalPercent(code);
  const off = items.length && Math.round(totalPct * 10) / 10 !== 100;
  let out = '<div class="known-issue">卸の商品には「梅きらら70g」のように、複数の内訳品目（バリエーション）が内包されているものがあります。ここで内訳品目名と割合（%）を登録すると、週次計画・月次計画・印刷プレビューで、製造予定数を割合で按分した内訳個数を確認できるようになります。割合がまだ分からない場合は0%のままで構いません（その場合、内訳は表示されません）。</div>';
  out += '<div class="field" style="max-width:420px;"><label>対象商品</label><select onchange="setBreakdownProduct(this.value)">' +
    MASTER.wholesaleProducts.map(function(p){
      return '<option value="' + esc(p.code) + '"' + (p.code === code ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('') +
    '</select></div>';
  out += '<div class="breakdown-editor">';
  out += '<div class="breakdown-editor-head"><span>内訳品目名</span><span>割合(%)</span><span></span></div>';
  items.forEach(function(it){
    out += '<div class="breakdown-editor-row">' +
      '<input type="text" value="' + esc(it.name) + '" placeholder="例：極上漬" ' + (isReadOnly ? 'disabled' : '') +
        ' oninput="updateBreakdownItemName(\'' + esc(code) + '\',\'' + it.id + '\',this.value)">' +
      '<input type="number" min="0" step="0.1" value="' + (it.percent || 0) + '" ' + (isReadOnly ? 'disabled' : '') +
        ' oninput="updateBreakdownItemPercent(\'' + esc(code) + '\',\'' + it.id + '\',this.value)">' +
      '<button class="camp-del" onclick="removeBreakdownItem(\'' + esc(code) + '\',\'' + it.id + '\')" ' + (isReadOnly ? 'disabled' : '') + '>×</button>' +
      '</div>';
  });
  if(!items.length){
    out += '<div style="padding:14px;color:var(--muted);font-size:12.5px;">まだ内訳品目が登録されていません。「＋ 内訳品目を追加」から登録してください。</div>';
  }
  out += '</div>';
  out += '<div class="breakdown-total' + (off ? ' warn' : '') + '" id="bd-total-pct">割合の合計：' + fmtPctDisplay(totalPct) + '%' +
    (off ? '（100%になるよう調整してください）' : '') + '</div>';
  out += '<div class="footer-bar">' +
    '<button class="btn ghost" onclick="addBreakdownItem(\'' + esc(code) + '\')" ' + (isReadOnly ? 'disabled' : '') + '>＋ 内訳品目を追加</button>' +
    '<div class="spacer"></div>' +
    '<button class="btn primary" onclick="saveBreakdown()" ' + (isReadOnly ? 'disabled' : '') + '>内訳設定を保存</button>' +
    '</div>';
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
    '<textarea id="' + inputId + '" placeholder="例：容器の不足で予定数量が作れなかった…（来年見返す時のために残しておきましょう）">' + esc(text) + '</textarea>' +
    '<div class="memo-actions">' +
      '<button class="btn small" onclick="saveMemo(\'' + channel + '\',\'' + kind + '\',\'' + key + '\',\'' + inputId + '\')" ' + (isReadOnly ? 'disabled' : '') + '>メモを保存</button>' +
    '</div>' +
    renderPastMemoRef(channel, kind, key) +
    '</div>';
}
function refMonthKey(mk, yearsBack){
  const parts = mk.split('-').map(Number);
  return (parts[0] - yearsBack) + '-' + pad2(parts[1]);
}
function findMemoEntry(channel, kind, key){
  const log = chData(channel).memoLog;
  return log.find(function(m){ return m.kind === kind && m.key === key; }) || null;
}
function renderPastMemoRef(channel, kind, key){
  const refKey = kind === 'week' ? refWeekIso(key, 1) : refMonthKey(key, 1);
  const entry = findMemoEntry(channel, kind, refKey);
  if(!entry || !entry.text) return '';
  const d = new Date(entry.savedAt);
  const label = kind === 'week' ? '昨年同時期のメモ' : '昨年同月のメモ';
  return '<div class="memo-history">' +
    '<div class="memo-past-label">' + label + '</div>' +
    '<div class="memo-past-item">「' + esc(entry.text) + '」<span>' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日</span></div>' +
    '</div>';
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
  if(channel === 'wholesale') updateBreakdownInPlace(code, v);
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

function ensureWholesaleGroupOrder(){
  if(!STATE.wholesale.groupOrder || !STATE.wholesale.groupOrder.length){
    STATE.wholesale.groupOrder = (MASTER.wholesaleGroupOrder || []).slice();
  }
  return STATE.wholesale.groupOrder;
}
function moveWholesaleGroupUp(code){
  const arr = ensureWholesaleGroupOrder(); const i = arr.indexOf(code);
  if(i > 0){ const tmp = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = tmp; dirty = true; render(); }
}
function moveWholesaleGroupDown(code){
  const arr = ensureWholesaleGroupOrder(); const i = arr.indexOf(code);
  if(i < arr.length - 1){ const tmp = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = tmp; dirty = true; render(); }
}
function resetWholesaleGroupOrder(){ STATE.wholesale.groupOrder = (MASTER.wholesaleGroupOrder || []).slice(); dirty = true; render(); }

function setBreakdownProduct(code){ NAV.breakdownProductCode = code; render(); }
function addBreakdownItem(code){
  const items = productBreakdown(code);
  ensureProductBreakdowns()[code] = items;
  items.push({ id: genId(), name: '', percent: 0 });
  dirty = true;
  render();
}
function removeBreakdownItem(code, id){
  const items = productBreakdown(code);
  ensureProductBreakdowns()[code] = items.filter(function(it){ return it.id !== id; });
  dirty = true;
  render();
}
function updateBreakdownItemName(code, id, value){
  const items = productBreakdown(code);
  const it = items.find(function(x){ return x.id === id; });
  if(it){ it.name = value; dirty = true; updateStatusStripInPlace(); }
}
function updateBreakdownTotalInPlace(code){
  const totalEl = document.getElementById('bd-total-pct');
  if(!totalEl) return;
  const items = productBreakdown(code);
  const totalPct = breakdownTotalPercent(code);
  const off = items.length && Math.round(totalPct * 10) / 10 !== 100;
  totalEl.textContent = '割合の合計：' + fmtPctDisplay(totalPct) + '%' + (off ? '（100%になるよう調整してください）' : '');
  totalEl.classList.toggle('warn', !!off);
}
function updateBreakdownItemPercent(code, id, value){
  const items = productBreakdown(code);
  const it = items.find(function(x){ return x.id === id; });
  if(it){ it.percent = Math.max(0, parseFloat(value) || 0); dirty = true; }
  updateBreakdownTotalInPlace(code);
  updateStatusStripInPlace();
}
async function saveBreakdown(){ await publishState(); }

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
window.setPrintMode = setPrintMode;
window.navPrintRangePrev = navPrintRangePrev;
window.navPrintRangeNext = navPrintRangeNext;
window.setPrintRangeWeeks = setPrintRangeWeeks;
window.toggleGroupCollapse = toggleGroupCollapse;
window.onQtyInput = onQtyInput;
window.moveGroupUp = moveGroupUp;
window.moveGroupDown = moveGroupDown;
window.resetGroupOrder = resetGroupOrder;
window.saveGroupOrder = saveGroupOrder;
window.moveWholesaleGroupUp = moveWholesaleGroupUp;
window.moveWholesaleGroupDown = moveWholesaleGroupDown;
window.resetWholesaleGroupOrder = resetWholesaleGroupOrder;
window.setBreakdownProduct = setBreakdownProduct;
window.addBreakdownItem = addBreakdownItem;
window.removeBreakdownItem = removeBreakdownItem;
window.updateBreakdownItemName = updateBreakdownItemName;
window.updateBreakdownItemPercent = updateBreakdownItemPercent;
window.saveBreakdown = saveBreakdown;
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
window.autoFillFromLastYear = autoFillFromLastYear;
window.openCampaignModal = openCampaignModal;
window.closeCampaignModal = closeCampaignModal;
window.submitCampaign = submitCampaign;
window.deleteCampaign = deleteCampaign;
window.openMonthlyNoteModal = openMonthlyNoteModal;
window.closeMonthlyNoteModal = closeMonthlyNoteModal;
window.submitMonthlyNote = submitMonthlyNote;
window.deleteMonthlyNote = deleteMonthlyNote;
