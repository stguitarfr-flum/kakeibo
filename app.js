/* =========================================================
   家庭会計システム  —  自治体会計方式の家計簿
   すべての処理は端末内で完結します（外部送信なし）
   ========================================================= */
'use strict';

/* ---------- 0. 保存層（IndexedDB → localStorage → メモリ） ---------- */
const Store = (() => {
  let mode = 'idb', db = null, mem = {};
  const DB = 'kakeibo', VER = 1;
  function open() {
    return new Promise((res) => {
      let req;
      try { req = indexedDB.open(DB, VER); } catch (e) { mode = 'ls'; return res(); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('blob')) d.createObjectStore('blob');
      };
      req.onsuccess = () => { db = req.result; mode = 'idb'; res(); };
      req.onerror = () => { mode = 'ls'; res(); };
      setTimeout(() => { if (!db && mode === 'idb') { mode = 'ls'; res(); } }, 2500);
    });
  }
  function tx(store, rw) { return db.transaction(store, rw ? 'readwrite' : 'readonly').objectStore(store); }
  function get(store, k) {
    if (mode === 'idb') return new Promise((res, rej) => { const r = tx(store, 0).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (mode === 'ls') { try { const v = localStorage.getItem(store + ':' + k); return Promise.resolve(v ? JSON.parse(v) : undefined); } catch (e) { return Promise.resolve(undefined); } }
    return Promise.resolve(mem[store + ':' + k]);
  }
  function put(store, k, v) {
    if (mode === 'idb') return new Promise((res, rej) => { const r = tx(store, 1).put(v, k); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
    if (mode === 'ls') { try { localStorage.setItem(store + ':' + k, JSON.stringify(v)); return Promise.resolve(); } catch (e) { mode = 'mem'; mem[store + ':' + k] = v; return Promise.resolve(); } }
    mem[store + ':' + k] = v; return Promise.resolve();
  }
  function del(store, k) {
    if (mode === 'idb') return new Promise((res) => { const r = tx(store, 1).delete(k); r.onsuccess = () => res(); r.onerror = () => res(); });
    if (mode === 'ls') { localStorage.removeItem(store + ':' + k); return Promise.resolve(); }
    delete mem[store + ':' + k]; return Promise.resolve();
  }
  return { open, get, put, del, mode: () => mode };
})();

/* ---------- 1. 共通ユーティリティ ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => (n == null || isNaN(n) ? '—' : (n < 0 ? '△' : '') + Math.abs(Math.round(n)).toLocaleString('ja-JP'));
const yenS = (n) => yen(n) + '円';
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; };
const today = () => new Date().toISOString().slice(0, 10);
const pad2 = (n) => String(n).padStart(2, '0');

/* 年度：4月1日〜翌年3月31日 */
const FY_START = 4;
function fyOf(dateStr) { const d = new Date(dateStr + 'T00:00:00'); if (isNaN(d)) return null; return d.getMonth() + 1 >= FY_START ? d.getFullYear() : d.getFullYear() - 1; }
function fyRange(fy) { return [`${fy}-04-01`, `${fy + 1}-03-31`]; }
function fyLabel(fy) { return `${fy}年度（${fy}.4.1〜${fy + 1}.3.31）`; }
/* 年度内の月の並び 4,5,…,3 */
const FY_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
function ymOfFY(fy, m) { return (m >= FY_START ? fy : fy + 1) + '-' + pad2(m); }
function monthsBetween(a, b) { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); }

function toast(msg, ms) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), ms || 2200);
}
function confirmBox(msg) { return window.confirm(msg); }

/* ---------- 2. 初期データ（添付ファイルの科目コードを移植） ---------- */
function defaultCategories() {
  const g = (name, items) => ({ id: uid(), name, items: items.map((it) => ({ id: uid(), name: it[0], desc: it[1] || '', fixed: !!it[2] })) });
  return {
    income: [
      g('１．給与', [['01．給料(夫)', '月例賃金'], ['02．給料(妻)', '月例賃金']]),
      g('２．繰越金', [['01．繰越金', '前年度からの繰越金']]),
      g('３．雑収入', [['01．雑収入', '臨時収入（細かいもの）']]),
      g('４．繰入金', [['01．繰入金', '臨時収入（大きいもの）']])
    ],
    expense: [
      g('１．生活費', [
        ['01．家庭内食料費', '家庭での食材費'], ['02．日用品', '洗剤・трイレットペーパー等'],
        ['03．衣服・美容費', '洋服・化粧品'], ['04．娯楽費', '自分たちのための費用'],
        ['05．交通費', 'ガソリン・電車・バス等'], ['06．医療費', '治療代・常備薬'],
        ['07．交際費', '友人との交際費・職場の会等'], ['08．御小遣', 'お小遣い'],
        ['09．外食費', '外食した場合の費用'], ['10．活動費', 'サークル等の会費・活動費']
      ]),
      g('２．固定費', [
        ['01．住居費', '家賃・共益費等', 1], ['02．電気代', '', 1], ['03．水道代', '上水道代', 1],
        ['04．ガス代', '', 1], ['05．通信費', 'インターネット・携帯電話等', 1],
        ['06．車両代', '車両・車検・タイヤ・修繕代等', 1], ['07．保険費', '生命・任意・自賠責等', 1],
        ['08．税金', '重量税・その他税金等', 1], ['09．教育費', '子どもへの費用', 1]
      ]),
      g('３．特別経費', [['01．冠婚葬祭', ''], ['02．その他', '引越費用等']]),
      g('４．積立金', [['01．貯金', '']]),
      g('５．予備費', [['01．予備費', '']])
    ]
  };
}
/* 「トイレットペーパー」の表記ゆれ修正 */
function fixSeed(c) { c.expense[0].items[1].desc = '洗剤・トイレットペーパー・包丁等'; return c; }

const USEFUL_LIFE = [
  ['普通自動車', 6], ['軽自動車', 4], ['自動二輪', 3], ['自転車', 2],
  ['冷蔵庫・洗濯機', 6], ['エアコン', 6], ['テレビ', 5], ['パソコン', 4],
  ['スマートフォン', 4], ['カメラ', 5], ['家具（金属以外）', 8], ['家具（金属製）', 15],
  ['楽器', 5], ['給湯器', 6], ['暖房器具', 6], ['木造住宅', 22], ['鉄骨造住宅', 34]
];

function blankState() {
  return {
    v: 1,
    settings: { title: '一般家庭会計', pin: null, lockOnHide: true, defaultAccount: null, ocrLang: 'jpn' },
    members: [{ id: uid(), name: '世帯主' }],
    accounts: [],
    categories: fixSeed(defaultCategories()),
    tx: [],
    fixed: [],
    assets: [],
    budgets: {},      /* budgets[fy][itemId] = {b0,hosei,yobi,ryuyo} */
    utilities: [],    /* {id,ym,kind,usage,unit,amount,memo} */
    sim: null,
    seq: 1
  };
}

/* ---------- 3. アプリ状態 ---------- */
let S = blankState();
let CUR_FY = fyOf(today()) || new Date().getFullYear();
let VIEW = 'dash';
let dirty = false, saveTimer = null;

function save(now) {
  dirty = true;
  clearTimeout(saveTimer);
  const go = () => Store.put('kv', 'state', JSON.parse(JSON.stringify(S))).then(() => { dirty = false; });
  if (now) return go();
  saveTimer = setTimeout(go, 400);
}

/* ---------- 4. 科目ヘルパ ---------- */
function allGroups(type) { return S.categories[type] || []; }
function findItem(itemId) {
  for (const t of ['income', 'expense']) for (const g of S.categories[t]) for (const it of g.items) if (it.id === itemId) return { type: t, group: g, item: it };
  return null;
}
function itemName(id) { const f = findItem(id); return f ? f.item.name : '（未設定）'; }
function groupNameOf(id) { const f = findItem(id); return f ? f.group.name : ''; }
function itemOptions(type, sel) {
  let h = '<option value="">選択してください</option>';
  for (const g of allGroups(type)) {
    h += `<optgroup label="${esc(g.name)}">`;
    for (const it of g.items) h += `<option value="${it.id}"${it.id === sel ? ' selected' : ''}>${esc(it.name)}</option>`;
    h += '</optgroup>';
  }
  return h;
}
function accountOptions(sel, blank) {
  let h = `<option value="">${blank || '（口座指定なし）'}</option>`;
  for (const a of S.accounts) h += `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${esc(accLabel(a))}</option>`;
  return h;
}
function accLabel(a) {
  const m = S.members.find((x) => x.id === a.memberId);
  return (m ? m.name + '／' : '') + a.bank + (a.name ? '（' + a.name + '）' : '');
}
function memberOptions(sel) { return S.members.map((m) => `<option value="${m.id}"${m.id === sel ? ' selected' : ''}>${esc(m.name)}</option>`).join(''); }

/* ---------- 5. 集計 ---------- */
function txOfFY(fy) { const [a, b] = fyRange(fy); return S.tx.filter((t) => t.date >= a && t.date <= b); }
function sumBy(list, type, key) {
  const m = {};
  for (const t of list) { if (t.type !== type) continue; const k = t[key] || '(未設定)'; m[k] = (m[k] || 0) + num(t.amount); }
  return m;
}
function totalIn(list) { return list.reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : 0), 0); }
function totalOut(list) { return list.reduce((s, t) => s + (t.type === 'out' ? num(t.amount) : 0), 0); }

/* 現在残高：口座の開始残高＋全取引（口座紐付の有無を問わず全体を通算） */
function balanceAll() {
  const open = S.accounts.reduce((s, a) => s + num(a.opening), 0);
  return open + S.tx.reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
}
function balanceOfAccount(id) {
  const a = S.accounts.find((x) => x.id === id); if (!a) return 0;
  return num(a.opening) + S.tx.reduce((s, t) => (t.accountId === id ? s + (t.type === 'in' ? num(t.amount) : -num(t.amount)) : s), 0);
}
/* 直近n か月の平均収支 */
function recentAvg(n) {
  const now = new Date(); const end = now.toISOString().slice(0, 7);
  const start = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1).toISOString().slice(0, 7);
  const list = S.tx.filter((t) => t.date.slice(0, 7) >= start && t.date.slice(0, 7) <= end);
  const months = Math.max(1, monthsBetween(start, end) + 1);
  const ex = (t) => t.excludeSim ? 0 : num(t.amount);
  const i = list.reduce((s, t) => s + (t.type === 'in' ? ex(t) : 0), 0);
  const o = list.reduce((s, t) => s + (t.type === 'out' ? ex(t) : 0), 0);
  return { months, income: i / months, expense: o / months, net: (i - o) / months, n: list.length };
}

/* ---------- 6. 予算 ---------- */
function budgetOf(fy, itemId) {
  const b = (S.budgets[fy] || {})[itemId] || {};
  const b0 = num(b.b0), hosei = num(b.hosei), yobi = num(b.yobi), ryuyo = num(b.ryuyo);
  return { b0, hosei, yobi, ryuyo, genzai: b0 + hosei + yobi + ryuyo };
}
function setBudget(fy, itemId, key, val) {
  S.budgets[fy] = S.budgets[fy] || {};
  S.budgets[fy][itemId] = S.budgets[fy][itemId] || { b0: 0, hosei: 0, yobi: 0, ryuyo: 0 };
  S.budgets[fy][itemId][key] = num(val);
  save();
}

/* ---------- 7. 減価償却 ---------- */
/* 定額法：取得価額 ÷ 耐用年数（月割）／備忘価額1円まで
   定率法：200%定率法の簡易計算（償却額が残存年数均等額を下回ったら均等償却に切替） */
function depreciate(asset, asOf) {
  const price = num(asset.price), life = Math.max(1, num(asset.life) || 1);
  const acq = asset.acquired || today();
  const end = asOf || today();
  const months = Math.max(0, monthsBetween(acq.slice(0, 7), end.slice(0, 7)) + 1);
  const memo = 1; /* 備忘価額 */
  const rows = [];
  if (price <= 0) return { book: 0, accum: 0, yearly: 0, rows: [], monthsUsed: months, life, done: true };
  if ((asset.method || '定額法') === '定額法') {
    const per = price / life;               /* 年額 */
    const perM = per / 12;
    let accum = Math.min(price - memo, perM * months);
    for (let y = 0; y < life; y++) rows.push({ y, amount: Math.round(per), book: Math.max(memo, Math.round(price - per * (y + 1))) });
    return { book: Math.max(memo, Math.round(price - accum)), accum: Math.round(accum), yearly: Math.round(per), rows, monthsUsed: months, life, done: months >= life * 12 };
  }
  const rate = Math.min(1, 2 / life);
  let book = price, accum = 0, sw = false, evenly = 0;
  for (let y = 0; y < life; y++) {
    let amt;
    const remain = life - y;
    if (!sw) {
      amt = book * rate;
      if (amt < book / remain) { sw = true; evenly = (book - memo) / remain; amt = evenly; }
    } else amt = evenly;
    amt = Math.min(amt, book - memo);
    book = book - amt; accum += amt;
    rows.push({ y, amount: Math.round(amt), book: Math.max(memo, Math.round(book)) });
  }
  const yearsUsed = Math.floor(months / 12), rem = months % 12;
  let acc2 = 0;
  for (let y = 0; y < Math.min(yearsUsed, rows.length); y++) acc2 += rows[y].amount;
  if (yearsUsed < rows.length) acc2 += rows[yearsUsed].amount * rem / 12;
  acc2 = Math.min(acc2, price - memo);
  return { book: Math.max(memo, Math.round(price - acc2)), accum: Math.round(acc2), yearly: rows[Math.min(yearsUsed, rows.length - 1)] ? rows[Math.min(yearsUsed, rows.length - 1)].amount : 0, rows, monthsUsed: months, life, done: months >= life * 12 };
}
function replaceDate(asset) {
  const acq = new Date((asset.acquired || today()) + 'T00:00:00');
  acq.setFullYear(acq.getFullYear() + (num(asset.life) || 1));
  return acq.toISOString().slice(0, 10);
}

/* ---------- 8. 簡易SVGグラフ ---------- */
const PAL = ['#5b6cff', '#00b4f0', '#00c2a8', '#f59e0b', '#ff5c8a', '#a855f7', '#22c55e', '#fb7185', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];
/* 各色の「明るい方」— グラデーションの上端に使う */
const PAL2 = { '#5b6cff': '#8ba0ff', '#00b4f0': '#5ad8ff', '#00c2a8': '#5ce6cd', '#f59e0b': '#ffcf5c',
  '#ff5c8a': '#ff9ab6', '#a855f7': '#cf95ff', '#22c55e': '#6ee7a0', '#fb7185': '#ffa8b8',
  '#06b6d4': '#5ce0f0', '#f97316': '#ffab5c', '#8b5cf6': '#b795ff', '#14b8a6': '#5fe0d0' };
const lighten = (c) => PAL2[c] || c;
const gradId = () => 'g' + Math.random().toString(36).slice(2, 8);
function gradDefs(series, vertical) {
  return '<defs>' + series.map((s) => {
    const c = s.color || PAL[0];
    return `<linearGradient id="${s.gid}" x1="0" y1="${vertical ? 0 : 0}" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">
      <stop offset="0%" stop-color="${lighten(c)}"/><stop offset="100%" stop-color="${c}"/></linearGradient>`;
  }).join('') + '</defs>';
}
const CHART = { in: '#00c2a8', out: '#ff5c8a', main: '#5b6cff', sub: '#a855f7', prev: '#cfd6f0' };
function barChart(labels, series, opt) {
  opt = opt || {};
  const W = 720, H = opt.h || 220, L = 46, R = 8, T = 10, B = 26;
  const iw = W - L - R, ih = H - T - B;
  let max = 0, min = 0;
  series.forEach((s) => s.data.forEach((v) => { max = Math.max(max, v); min = Math.min(min, v); }));
  if (max === 0 && min === 0) max = 1;
  const span = (max - min) || 1;
  const y = (v) => T + ih - ((v - min) / span) * ih;
  const n = labels.length, gw = iw / Math.max(1, n), bw = Math.min(26, (gw - 6) / series.length);
  series.forEach((s, i) => { s.color = s.color || PAL[i % PAL.length]; s.gid = gradId(); });
  let g = gradDefs(series, true);
  for (let i = 0; i <= 4; i++) { const v = min + span * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eaeefb"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#9aa1bd">${Math.round(v / (opt.unit || 1)).toLocaleString()}</text>`; }
  labels.forEach((lb, i) => { g += `<text x="${L + gw * i + gw / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6a7192">${esc(lb)}</text>`; });
  series.forEach((s, si) => {
    s.data.forEach((v, i) => {
      const x = L + gw * i + (gw - bw * series.length) / 2 + bw * si;
      const y0 = y(0), y1 = y(v);
      g += `<rect x="${x}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1, Math.abs(y1 - y0))}" fill="url(#${s.gid})" rx="${Math.min(5, bw / 2)}"><title>${esc(labels[i])} ${esc(s.name || '')} ${yen(v)}</title></rect>`;
    });
  });
  g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#c4cbe6"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>` + legend(series);
}
function lineChart(labels, series, opt) {
  opt = opt || {};
  const W = 720, H = opt.h || 220, L = 52, R = 10, T = 10, B = 26;
  const iw = W - L - R, ih = H - T - B;
  let max = -Infinity, min = Infinity;
  series.forEach((s) => s.data.forEach((v) => { if (v == null) return; max = Math.max(max, v); min = Math.min(min, v); }));
  if (!isFinite(max)) { max = 1; min = 0; }
  if (min > 0) min = 0; if (max === min) max = min + 1;
  const span = max - min;
  const x = (i) => L + (labels.length <= 1 ? iw / 2 : iw * i / (labels.length - 1));
  const y = (v) => T + ih - ((v - min) / span) * ih;
  series.forEach((s, i) => { s.color = s.color || PAL[i % PAL.length]; s.gid = gradId(); });
  let g = '<defs>' + series.map((s) => `<linearGradient id="${s.gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${s.color}" stop-opacity=".38"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`).join('') + '</defs>';
  for (let i = 0; i <= 4; i++) { const v = min + span * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eaeefb"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#9aa1bd">${Math.round(v / (opt.unit || 1)).toLocaleString()}</text>`; }
  const step = Math.ceil(labels.length / 12);
  labels.forEach((lb, i) => { if (i % step) return; g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6a7192">${esc(lb)}</text>`; });
  if (min < 0) g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#ff5c8a" stroke-dasharray="4 4"/>`;
  series.forEach((s) => {
    const col = s.color;
    const pts = s.data.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
    if (s.area) g += `<polygon points="${L},${y(Math.max(0, min))} ${pts} ${x(s.data.length - 1)},${y(Math.max(0, min))}" fill="url(#${s.gid})"/>`;
    g += `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`;
    s.data.forEach((v, i) => { if (v == null) return; g += `<circle cx="${x(i)}" cy="${y(v)}" r="3.4" fill="#fff" stroke="${col}" stroke-width="2.2"><title>${esc(labels[i])} ${yen(v)}</title></circle>`; });
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>` + legend(series);
}
function donutChart(data, opt) {
  opt = opt || {};
  const total = data.reduce((s, d) => s + d.value, 0);
  const W = 260, cx = 130, cy = 122, r = 96, rin = 58;
  if (!total) return '<div class="empty">データがありません</div>';
  data.forEach((d, i) => { d.color = d.color || PAL[i % PAL.length]; d.gid = gradId(); });
  let a = -Math.PI / 2;
  let g = '<defs>' + data.map((d) => `<linearGradient id="${d.gid}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${lighten(d.color)}"/><stop offset="100%" stop-color="${d.color}"/></linearGradient>`).join('') + '</defs>';
  data.forEach((d, i) => {
    const ang = (d.value / total) * Math.PI * 2, b = a + ang;
    const big = ang > Math.PI ? 1 : 0;
    const p = (rr, t) => `${(cx + rr * Math.cos(t)).toFixed(1)},${(cy + rr * Math.sin(t)).toFixed(1)}`;
    g += `<path d="M ${p(r, a)} A ${r} ${r} 0 ${big} 1 ${p(r, b)} L ${p(rin, b)} A ${rin} ${rin} 0 ${big} 0 ${p(rin, a)} Z" fill="url(#${d.gid})" stroke="#fff" stroke-width="2"><title>${esc(d.label)} ${yen(d.value)}（${(d.value / total * 100).toFixed(1)}%）</title></path>`;
    a = b;
  });
  g += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="11" fill="#9aa1bd" font-weight="600">合計</text><text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="19" font-weight="800" fill="#1d2138">${yen(total)}</text>`;
  const leg = data.map((d) => `<span><i style="background:linear-gradient(135deg,${lighten(d.color)},${d.color})"></i>${esc(d.label)} ${yen(d.value)}（${(d.value / total * 100).toFixed(0)}%）</span>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} 244" style="max-width:280px;margin:0 auto">${g}</svg><div class="legend">${leg}</div>`;
}
function legend(series) {
  const s = series.filter((x) => x.name);
  if (!s.length) return '';
  return '<div class="legend">' + s.map((x, i) => { const c = x.color || PAL[i % PAL.length]; return `<span><i style="background:linear-gradient(135deg,${lighten(c)},${c})"></i>${esc(x.name)}</span>`; }).join('') + '</div>';
}
/* ---------- 9. 画面制御 ---------- */
const TABS = [
  { id: 'dash', ic: '▤', name: '概況' },
  { id: 'ledger', ic: '☰', name: '出納簿' },
  { id: 'entry', ic: '＋', name: '記帳' },
  { id: 'settle', ic: '⚖', name: '決算' },
  { id: 'more', ic: '⋯', name: 'その他' }
];
const MORE = [
  { id: 'sim', ic: '📈', name: '将来設計' },
  { id: 'fixed', ic: '🔁', name: '固定費' },
  { id: 'accounts', ic: '🏦', name: '通帳・カード' },
  { id: 'assets', ic: '🚗', name: '財産・減価償却' },
  { id: 'compare', ic: '⇄', name: '前年度比較' },
  { id: 'util', ic: '💡', name: '光熱費' },
  { id: 'budget', ic: '📋', name: '予算編成' },
  { id: 'cats', ic: '🗂', name: '科目設定' },
  { id: 'data', ic: '💾', name: 'データ管理' },
  { id: 'config', ic: '⚙', name: '設定' }
];

function go(v) { VIEW = v; window.scrollTo(0, 0); render(); }

function renderTabs() {
  $('#tabs').innerHTML = TABS.map((t) => {
    const on = t.id === VIEW || (t.id === 'more' && MORE.some((m) => m.id === VIEW));
    return `<button data-tab="${t.id}" class="${on ? 'on' : ''}"><span class="ic">${t.ic}</span>${t.name}</button>`;
  }).join('');
}
function renderFY() {
  const years = new Set([CUR_FY, fyOf(today())]);
  S.tx.forEach((t) => { const f = fyOf(t.date); if (f) years.add(f); });
  Object.keys(S.budgets).forEach((y) => years.add(Number(y)));
  const arr = Array.from(years).filter((x) => x).sort((a, b) => b - a);
  $('#fySel').innerHTML = arr.map((y) => `<option value="${y}"${y === CUR_FY ? ' selected' : ''}>${y}年度</option>`).join('')
    + `<option value="__new">＋ 年度を追加</option>`;
}

function render() {
  renderTabs(); renderFY();
  const h1 = $('.masthead h1'); if (h1) h1.textContent = (S.settings.title || '家庭会計').slice(0, 8);
  /* 画面を作り直すことで、前の画面のイベントを残さない */
  const old = $('#view'); const v = old.cloneNode(false); old.replaceWith(v);
  const f = {
    dash: viewDash, ledger: viewLedger, entry: viewEntry, settle: viewSettle, more: viewMore,
    sim: viewSim, fixed: viewFixed, accounts: viewAccounts, assets: viewAssets,
    compare: viewCompare, util: viewUtil, budget: viewBudget, cats: viewCats, data: viewData, config: viewConfig
  }[VIEW] || viewDash;
  v.innerHTML = f();
  if (typeof window['bind_' + VIEW] === 'function') window['bind_' + VIEW]();
}

/* ---------- 10. 概況 ---------- */
function viewDash() {
  const list = txOfFY(CUR_FY);
  const bal = balanceAll();
  const inc = totalIn(list), out = totalOut(list);
  const av = recentAvg(12);
  /* 月別収支 */
  const labels = FY_MONTHS.map((m) => m + '月');
  const mi = [], mo = [], mnet = [];
  FY_MONTHS.forEach((m) => {
    const ym = ymOfFY(CUR_FY, m);
    const l = list.filter((t) => t.date.slice(0, 7) === ym);
    mi.push(totalIn(l)); mo.push(totalOut(l)); mnet.push(totalIn(l) - totalOut(l));
  });
  /* 項別支出 */
  const byGroup = {};
  list.filter((t) => t.type === 'out').forEach((t) => { const g = groupNameOf(t.itemId) || '（未設定）'; byGroup[g] = (byGroup[g] || 0) + num(t.amount); });
  const donut = Object.entries(byGroup).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v }));
  /* 固定費 */
  const fixedIds = new Set();
  S.categories.expense.forEach((g) => g.items.forEach((it) => { if (it.fixed) fixedIds.add(it.id); }));
  const fixedSum = list.filter((t) => t.type === 'out' && fixedIds.has(t.itemId)).reduce((s, t) => s + num(t.amount), 0);
  const varSum = out - fixedSum;
  /* 直近 */
  const recent = S.tx.slice().sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 8);
  /* 予算執行 */
  const bTot = Object.values(S.budgets[CUR_FY] || {}).reduce((s, b) => s + num(b.b0) + num(b.hosei), 0);

  return `
  ${storageWarn()}
  <section class="form">
    <div class="fh"><h2>現 在 高</h2><span class="slip">${fyLabel(CUR_FY)}</span></div>
    <div class="hero">
      <div class="big">
        <div class="lab">差 引 現 在 高</div>
        <div class="val ${bal < 0 ? 'neg' : ''}">${yen(bal)}<span style="font-size:16px;font-weight:400">円</span></div>
        <div class="sub">口座開始残高 ${yen(S.accounts.reduce((s, a) => s + num(a.opening), 0))}円 ＋ 記帳分 ${yen(S.tx.reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0))}円</div>
      </div>
      <div class="tri">
        <div><div class="l">年度収入</div><div class="v pos">${yen(inc)}</div></div>
        <div><div class="l">年度支出</div><div class="v neg">${yen(out)}</div></div>
        <div><div class="l">年度収支</div><div class="v ${inc - out < 0 ? 'neg' : 'pos'}">${yen(inc - out)}</div></div>
      </div>
    </div>
  </section>

  <section class="form">
    <div class="fh"><h2>月 別 収 支</h2><span class="slip">単位：千円</span></div>
    <div class="fb">${barChart(labels, [
      { name: '収入', data: mi, color: CHART.in },
      { name: '支出', data: mo, color: CHART.out }
    ], { unit: 1000, h: 210 })}
    <div style="margin-top:10px">${lineChart(labels, [{ name: '月次収支', data: mnet, color: CHART.main, area: true }], { unit: 1000, h: 150 })}</div>
    </div>
  </section>

  <section class="form">
    <div class="fh"><h2>固定費と変動費</h2><span class="slip">科目設定で区分</span></div>
    <div class="fb">
      <table class="led"><tbody>
        <tr><td style="width:32%">固定費</td><td class="r num neg" style="width:26%">${yen(fixedSum)}</td>
          <td><div class="bar"><i style="width:${out ? (fixedSum / out * 100).toFixed(1) : 0}%;background:linear-gradient(90deg,#8ba0ff,#5b6cff)"></i></div></td>
          <td class="r tiny" style="width:52px">${out ? (fixedSum / out * 100).toFixed(0) : 0}%</td></tr>
        <tr><td>変動費</td><td class="r num neg">${yen(varSum)}</td>
          <td><div class="bar"><i style="width:${out ? (varSum / out * 100).toFixed(1) : 0}%;background:linear-gradient(90deg,#5ad8ff,#00b4f0)"></i></div></td>
          <td class="r tiny">${out ? (varSum / out * 100).toFixed(0) : 0}%</td></tr>
        <tr class="sum"><td>支出計</td><td class="r num">${yen(out)}</td><td colspan="2" class="tiny">月平均 ${yen(out / 12)}円</td></tr>
      </tbody></table>
      <p class="note">月あたりの固定費はおよそ ${yen(fixedSum / 12)}円です。${bTot ? '' : '予算をまだ編成していません。「予算編成」から設定すると執行状況が表示されます。'}</p>
    </div>
  </section>

  <section class="form">
    <div class="fh"><h2>項 別 支 出</h2><span class="slip">${CUR_FY}年度</span></div>
    <div class="fb">${donut.length ? donutChart(donut) : '<div class="empty"><b>まだ記帳がありません</b>「＋記帳」から入力するか、データ管理でCSVを取り込んでください。</div>'}</div>
  </section>

  <section class="form">
    <div class="fh"><h2>直 近 の 記 帳</h2><span class="slip">最新8件</span></div>
    <div class="fb tight">
      ${recent.length ? `<div class="tw"><table class="led"><thead><tr><th>年月日</th><th>区分</th><th>目</th><th>件名</th><th class="r">金額</th></tr></thead><tbody>
      ${recent.map((t) => `<tr class="clickable" data-act="editTx" data-id="${t.id}">
        <td class="num tiny">${t.date.replace(/-/g, '.')}</td>
        <td><span class="pill ${t.type}">${t.type === 'in' ? '入' : '出'}</span></td>
        <td class="tiny">${esc(itemName(t.itemId))}</td>
        <td>${esc(t.title || '')}${t.receiptId ? ' 📎' : ''}</td>
        <td class="r num ${t.type === 'in' ? 'pos' : 'neg'}">${yen(t.amount)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">記帳がありません</div>'}
    </div>
  </section>

  <section class="form">
    <div class="fh"><h2>将 来 の 見 通 し</h2><span class="slip">直近${av.months}か月平均</span></div>
    <div class="fb">
      <div class="tri" style="border:1px solid var(--rule);border-radius:4px">
        <div><div class="l">月平均収入</div><div class="v pos">${yen(av.income)}</div></div>
        <div><div class="l">月平均支出</div><div class="v neg">${yen(av.expense)}</div></div>
        <div><div class="l">月平均収支</div><div class="v ${av.net < 0 ? 'neg' : 'pos'}">${yen(av.net)}</div></div>
      </div>
      <p class="note">この収支が続くと、10年後の残高はおよそ <b class="num">${yen(bal + av.net * 120)}円</b> になります。</p>
      <div class="row end"><button class="btn ghost sm" data-act="goSim">将来設計を開く</button></div>
    </div>
  </section>`;
}
function bind_dash() {
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'goSim') go('sim');
    if (b.dataset.act === 'editTx') openEntry(b.dataset.id);
  });
}
function storageWarn() {
  if (Store.mode() === 'mem') return '<div class="err">この環境では保存領域が使えません。入力内容はページを閉じると消えます。<b>データ管理からバックアップを書き出してください。</b>ローカルファイルを直接開いている場合は、簡易サーバー経由かウェブに設置して開くと保存できます。</div>';
  if (Store.mode() === 'ls') return '<div class="warn">簡易保存モードで動作しています（画像の保存は使えません）。容量に限りがあるため、定期的にバックアップを取ってください。</div>';
  return '';
}

/* ---------- 11. 出納簿 ---------- */
let LED = { q: '', type: '', item: '', month: '', acct: '' };
function viewLedger() {
  let list = txOfFY(CUR_FY).slice().sort((a, b) => (a.date + a.seq).localeCompare(b.date + b.seq));
  if (LED.type) list = list.filter((t) => t.type === LED.type);
  if (LED.item) list = list.filter((t) => t.itemId === LED.item);
  if (LED.acct) list = list.filter((t) => t.accountId === LED.acct);
  if (LED.month) list = list.filter((t) => t.date.slice(0, 7) === LED.month);
  if (LED.q) { const q = LED.q.toLowerCase(); list = list.filter((t) => ((t.title || '') + (t.payee || '') + (t.memo || '')).toLowerCase().includes(q)); }
  let run = S.accounts.reduce((s, a) => s + num(a.opening), 0);
  const rows = list.map((t, i) => {
    run += t.type === 'in' ? num(t.amount) : -num(t.amount);
    return `<tr class="clickable" data-act="editTx" data-id="${t.id}">
      <td class="c tiny num">${i + 1}</td>
      <td class="num" style="white-space:nowrap">${t.date.slice(2).replace(/-/g, '.')}</td>
      <td class="c"><span class="pill ${t.type}">${t.type === 'in' ? '入' : '出'}</span></td>
      <td class="tiny nw">${esc(groupNameOf(t.itemId))}<br><b>${esc(itemName(t.itemId))}</b></td>
      <td>${esc(t.title || '')}${t.receiptId ? ' <span class="tiny">📎</span>' : ''}${t.fixedId ? ' <span class="pill gray">固定</span>' : ''}<div class="tiny">${esc(t.payee || '')}</div></td>
      <td class="r num pos">${t.type === 'in' ? yen(t.amount) : ''}</td>
      <td class="r num neg">${t.type === 'out' ? yen(t.amount) : ''}</td>
      <td class="r num tiny">${yen(run)}</td>
      <td class="tiny">${esc(t.memo || '')}</td></tr>`;
  }).join('');
  const monthOpts = FY_MONTHS.map((m) => { const ym = ymOfFY(CUR_FY, m); return `<option value="${ym}"${LED.month === ym ? ' selected' : ''}>${m}月</option>`; }).join('');
  return `
  <section class="form">
    <div class="fh"><h2>出　納　簿</h2><span class="slip">様式第1号／日計表</span></div>
    <div class="fb">
      <div class="grid g3">
        <label class="fld"><span>区分</span><select id="fType"><option value="">すべて</option><option value="in"${LED.type === 'in' ? ' selected' : ''}>収入</option><option value="out"${LED.type === 'out' ? ' selected' : ''}>支出</option></select></label>
        <label class="fld"><span>月</span><select id="fMonth"><option value="">通年</option>${monthOpts}</select></label>
        <label class="fld"><span>口座</span><select id="fAcct">${accountOptions(LED.acct, 'すべて')}</select></label>
      </div>
      <div class="grid g2" style="margin-top:10px">
        <label class="fld"><span>目（科目）</span><select id="fItem"><option value="">すべて</option>${itemOptions('income', LED.item)}${itemOptions('expense', LED.item).replace('<option value="">選択してください</option>', '')}</select></label>
        <label class="fld"><span>キーワード</span><input id="fQ" value="${esc(LED.q)}" placeholder="件名・支払先・摘要"></label>
      </div>
      <div class="row end" style="margin-top:10px">
        <button class="btn ghost sm" data-act="clearF">条件をクリア</button>
        <button class="btn ghost sm" data-act="csvOut">この一覧をCSVで書き出す</button>
        <button class="btn sm" data-act="new">＋ 記帳する</button>
      </div>
    </div>
    <div class="tw">
      <table class="led wide">
        <thead><tr><th class="c">No.</th><th>年月日</th><th class="c">区分</th><th class="nw">項／目</th><th>件名・相手先</th><th class="r">収入</th><th class="r">支出</th><th class="r">差引残高</th><th>摘要</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="empty">該当する記帳がありません</td></tr>'}
        ${list.length ? `<tr class="sum"><td colspan="5">合　　計（${list.length}件）</td><td class="r num pos">${yen(totalIn(list))}</td><td class="r num neg">${yen(totalOut(list))}</td><td class="r num">${yen(run)}</td><td></td></tr>` : ''}
        </tbody>
      </table>
    </div>
  </section>`;
}
function bind_ledger() {
  const rr = () => { LED.type = $('#fType').value; LED.month = $('#fMonth').value; LED.item = $('#fItem').value; LED.q = $('#fQ').value; LED.acct = $('#fAcct').value; render(); };
  ['#fType', '#fMonth', '#fItem', '#fAcct'].forEach((s) => $(s).addEventListener('change', rr));
  let t; $('#fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(rr, 350); });
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'editTx') openEntry(b.dataset.id);
    if (a === 'new') go('entry');
    if (a === 'clearF') { LED = { q: '', type: '', item: '', month: '', acct: '' }; render(); }
    if (a === 'csvOut') exportLedgerCSV(CUR_FY);
  });
}

/* ---------- 12. 記帳（新規入力画面） ---------- */
let ENTRY = null;
function viewEntry() {
  const d = ENTRY || { type: 'out', date: today(), amount: '', itemId: '', title: '', payee: '', memo: '', accountId: S.settings.defaultAccount || '' };
  return `
  <section class="form">
    <div class="fh"><h2>記　帳</h2><span class="slip">出納簿へ登録</span></div>
    <div class="fb">
      <div class="row" style="margin-bottom:12px">
        <button class="btn ${d.type === 'out' ? '' : 'ghost'} wide" style="flex:1" data-act="t-out">支 出</button>
        <button class="btn ${d.type === 'in' ? '' : 'ghost'} wide" style="flex:1" data-act="t-in">収 入</button>
      </div>
      <label class="fld"><span>金額（円）</span><input id="eAmount" class="amt" type="number" inputmode="numeric" value="${d.amount}" placeholder="0"></label>
      <div class="grid g2" style="margin-top:10px">
        <label class="fld"><span>年月日</span><input id="eDate" type="date" value="${d.date}"></label>
        <label class="fld"><span>口座・支払方法</span><select id="eAccount">${accountOptions(d.accountId)}</select></label>
      </div>
      <label class="fld" style="margin-top:10px"><span>目（科目）</span><select id="eItem">${itemOptions(d.type === 'in' ? 'income' : 'expense', d.itemId)}</select></label>
      <div class="grid g2" style="margin-top:10px">
        <label class="fld"><span>件名</span><input id="eTitle" value="${esc(d.title)}" placeholder="例：食料品"></label>
        <label class="fld"><span>相手先</span><input id="ePayee" value="${esc(d.payee)}" placeholder="例：○○スーパー"></label>
      </div>
      <label class="fld" style="margin-top:10px"><span>摘要</span><input id="eMemo" value="${esc(d.memo)}"></label>
      <label class="chk" style="margin-top:10px"><input type="checkbox" id="eExc">将来シミュレーションの平均計算から除外する（臨時のもの）</label>
      <div class="row end" style="margin-top:14px">
        <button class="btn ghost" data-act="cam">📷 撮影して読み取る</button>
        <button class="btn ghost" data-act="lib">🖼 写真から選ぶ</button>
        <button class="btn" data-act="save">登 録</button>
      </div>
    </div>
  </section>
  <section class="form">
    <div class="fh"><h2>よ く 使 う 記 帳</h2><span class="slip">直近から複製</span></div>
    <div class="fb tight">${quickList()}</div>
  </section>
  <input type="file" id="camIn" accept="image/*" capture="environment" hidden>
  <input type="file" id="libIn" accept="image/jpeg,image/png,image/webp,image/*" hidden>`;
}
function quickList() {
  const seen = {}, out = [];
  S.tx.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach((t) => {
    const k = t.type + '|' + t.itemId + '|' + (t.title || '');
    if (seen[k]) return; seen[k] = 1;
    if (out.length < 10) out.push(t);
  });
  if (!out.length) return '<div class="empty">記帳を重ねると、ここによく使う内容が並びます</div>';
  return `<div class="tw"><table class="led"><tbody>${out.map((t) => `<tr class="clickable" data-act="dup" data-id="${t.id}">
    <td><span class="pill ${t.type}">${t.type === 'in' ? '入' : '出'}</span></td>
    <td class="tiny">${esc(itemName(t.itemId))}</td><td>${esc(t.title || '')}</td>
    <td class="r num">${yen(t.amount)}</td></tr>`).join('')}</tbody></table></div>`;
}
function bind_entry() {
  const read = () => ({
    type: (ENTRY && ENTRY.type) || 'out',
    date: $('#eDate').value, amount: num($('#eAmount').value), itemId: $('#eItem').value,
    title: $('#eTitle').value, payee: $('#ePayee').value, memo: $('#eMemo').value,
    accountId: $('#eAccount').value, excludeSim: $('#eExc').checked,
    receiptId: ENTRY && ENTRY.receiptId, ocr: ENTRY && ENTRY.ocr
  });
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 't-out' || a === 't-in') { ENTRY = Object.assign(read(), { type: a === 't-in' ? 'in' : 'out', itemId: '' }); render(); }
    if (a === 'cam') $('#camIn').click();
    if (a === 'lib') $('#libIn').click();
    if (a === 'dup') {
      const t = S.tx.find((x) => x.id === b.dataset.id); if (!t) return;
      ENTRY = { type: t.type, date: today(), amount: t.amount, itemId: t.itemId, title: t.title, payee: t.payee, memo: '', accountId: t.accountId };
      render(); toast('内容を複製しました');
    }
    if (a === 'save') {
      const d = read();
      if (!d.amount) { toast('金額を入力してください'); return; }
      if (!d.itemId) { toast('科目を選んでください'); return; }
      S.tx.push(Object.assign({ id: uid(), seq: String(S.seq++).padStart(5, '0') }, d));
      save(); ENTRY = null;
      toast('出納簿に登録しました'); go('ledger');
    }
  });
  $('#camIn').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) startOCR(f); e.target.value = ''; });
  $('#libIn').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) startOCR(f); e.target.value = ''; });
  if (ENTRY && ENTRY.excludeSim) $('#eExc').checked = true;
}

/* 既存記帳の編集（モーダル） ---------------------------------- */
function openEntry(id) {
  const t = S.tx.find((x) => x.id === id); if (!t) return;
  modal('記帳の修正', `
    <div class="row" style="margin-bottom:12px">
      <button class="btn ${t.type === 'out' ? '' : 'ghost'}" style="flex:1" data-m="type" data-v="out">支 出</button>
      <button class="btn ${t.type === 'in' ? '' : 'ghost'}" style="flex:1" data-m="type" data-v="in">収 入</button>
    </div>
    <label class="fld"><span>金額（円）</span><input id="mAmount" class="amt" type="number" value="${num(t.amount)}"></label>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>年月日</span><input id="mDate" type="date" value="${t.date}"></label>
      <label class="fld"><span>口座</span><select id="mAccount">${accountOptions(t.accountId)}</select></label>
    </div>
    <label class="fld" style="margin-top:10px"><span>目（科目）</span><select id="mItem">${itemOptions(t.type === 'in' ? 'income' : 'expense', t.itemId)}</select></label>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>件名</span><input id="mTitle" value="${esc(t.title || '')}"></label>
      <label class="fld"><span>相手先</span><input id="mPayee" value="${esc(t.payee || '')}"></label>
    </div>
    <label class="fld" style="margin-top:10px"><span>摘要</span><input id="mMemo" value="${esc(t.memo || '')}"></label>
    <label class="chk" style="margin-top:10px"><input type="checkbox" id="mExc" ${t.excludeSim ? 'checked' : ''}>将来シミュレーションの平均から除外</label>
    <div id="mReceipt" style="margin-top:12px"></div>
    <div class="row end" style="margin-top:14px">
      <button class="btn danger ghost" data-m="del">削 除</button>
      <button class="btn" data-m="ok">保 存</button>
    </div>`, (root) => {
    if (t.receiptId) showReceipt(t.receiptId, $('#mReceipt', root));
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      if (b.dataset.m === 'type') { t.type = b.dataset.v; t.itemId = ''; save(); closeModal(); openEntry(id); return; }
      if (b.dataset.m === 'del') { if (!confirmBox('この記帳を削除します。よろしいですか。')) return; S.tx = S.tx.filter((x) => x.id !== id); save(); closeModal(); render(); toast('削除しました'); return; }
      if (b.dataset.m === 'ok') {
        Object.assign(t, {
          amount: num($('#mAmount').value), date: $('#mDate').value, itemId: $('#mItem').value,
          title: $('#mTitle').value, payee: $('#mPayee').value, memo: $('#mMemo').value,
          accountId: $('#mAccount').value, excludeSim: $('#mExc').checked
        });
        save(); closeModal(); render(); toast('保存しました');
      }
    });
  });
}

/* ---------- 13. モーダル ---------- */
let modalEl = null;
function modal(title, html, onReady) {
  closeModal();
  modalEl = document.createElement('div'); modalEl.className = 'mask';
  modalEl.innerHTML = `<div class="modal"><div class="mh"><h3>${esc(title)}</h3><button class="x" data-close>×</button></div><div class="mb">${html}</div></div>`;
  document.body.appendChild(modalEl);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl || e.target.hasAttribute('data-close')) closeModal(); });
  if (onReady) onReady(modalEl);
}
function closeModal() {
  if (typeof abortOCR === 'function') abortOCR();   /* 読み取り中なら止める */
  if (modalEl) { modalEl.remove(); modalEl = null; }
}

/* ---------- 14. その他メニュー ---------- */
function viewMore() {
  return `<section class="form"><div class="fh"><h2>そ の 他 の 帳 票</h2><span class="slip">${fyLabel(CUR_FY)}</span></div>
  <div class="fb"><div class="more">${MORE.map((m) => `<button data-go="${m.id}"><span class="ic">${m.ic}</span>${m.name}</button>`).join('')}</div></div></section>
  <section class="form"><div class="fh"><h2>こ の ア プ リ に つ い て</h2></div><div class="fb">
    <p class="note">記録・集計・グラフ表示のすべてを端末の中だけで行います。入力した内容が外部に送信されることはありません。保存方式：<b>${Store.mode() === 'idb' ? '端末内データベース' : Store.mode() === 'ls' ? '簡易保存' : 'メモリのみ（保存されません）'}</b>／記帳件数：<b>${S.tx.length}</b>件</p>
    <p class="note">レシート読み取りの仕組み（文字認識エンジンと日本語データ）もアプリに同梱しているため、通信なしで動作します。</p>
  </div></section>`;
}
function bind_more() {
  $('#view').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
}
/* ---------- 15. レシート読み取り（AI-OCR） ---------- */
let tessReady = null;
/* 文字認識一式の置き場所
   embed : 単一ファイル版に埋め込み済み（外部通信なし）
   local : index.html と同じ場所の ocr フォルダ（ウェブに置いた版・オフライン可）
   cdn   : 上記が無いときだけインターネットから取得 */
let OCR_MODE = null, OCR_EMBED = null;
const OCR_LOCAL = 'ocr/';
const TESS_URLS = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js'
];
function loadScript(src) {
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => res();
    el.onerror = () => { el.remove(); rej(new Error(src)); };
    document.head.appendChild(el);
    setTimeout(() => rej(new Error('timeout')), 25000);
  });
}
function embeddedBytes(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const t = el.textContent.replace(/\s+/g, '');
  if (!t) return null;
  const bin = atob(t), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function hasEmbeddedOCR() { return !!document.getElementById('ocr-engine'); }
function loadTesseract() {
  if (window.Tesseract && OCR_MODE) return Promise.resolve();
  if (tessReady) return tessReady;
  tessReady = (async () => {
    /* ① 単一ファイル版に埋め込まれたエンジン */
    if (hasEmbeddedOCR()) {
      const code = new TextDecoder('utf-8').decode(embeddedBytes('ocr-engine'));
      const el = document.createElement('script');
      el.textContent = code;
      document.head.appendChild(el);
      if (window.Tesseract) { OCR_MODE = 'embed'; return; }
    }
    /* ② 同じ場所の ocr フォルダ */
    if (location.protocol !== 'file:') {
      try { await loadScript(OCR_LOCAL + 'tesseract.min.js'); if (window.Tesseract) { OCR_MODE = 'local'; return; } } catch (e) { /* ③へ */ }
    }
    /* ③ インターネットから */
    for (const u of TESS_URLS) {
      try { await loadScript(u); if (window.Tesseract) { OCR_MODE = 'cdn'; return; } } catch (e) { /* 次へ */ }
    }
    tessReady = null;
    throw new Error('文字認識エンジンを読み込めませんでした');
  })();
  return tessReady;
}
/* 置き場所に応じてワーカーを作る */
async function createOCRWorker(logger) {
  const T = window.Tesseract;
  if (OCR_MODE === 'embed') {
    if (!OCR_EMBED) {
      const w = embeddedBytes('ocr-worker'), c = embeddedBytes('ocr-core'), l = embeddedBytes('ocr-lang');
      if (!w || !c || !l) throw new Error('埋め込みデータが不完全です');
      /* 認識コアをワーカーの先頭に連結して1つにまとめる。
         ワーカー内での追加読み込みが不要になり、制限の厳しい環境（ファイル直接・アプリ内表示）でも動く */
      OCR_EMBED = {
        workerURL: URL.createObjectURL(new Blob([c, '\n;\n', w], { type: 'text/javascript' })),
        lang: l
      };
    }
    return T.createWorker([{ code: 'jpn', data: OCR_EMBED.lang }], 1, {
      workerPath: OCR_EMBED.workerURL, corePath: 'embedded-core.js',
      workerBlobURL: false, cacheMethod: 'none', logger
    });
  }
  if (OCR_MODE === 'local') {
    const base = new URL(OCR_LOCAL, location.href).href;
    return T.createWorker('jpn', 1, {
      workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang',
      workerBlobURL: false, gzip: true, logger
    });
  }
  /* CDN：言語データも同じ配布元（jsDelivr）から取る */
  return T.createWorker('jpn', 1, {
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int',
    gzip: true, logger
  });
}
/* 撮影した写真を扱いやすい大きさに縮める。
   端末やブラウザによって使える手段が違うため、順に試します。 */
function drawScaled(src, w, h, maxW) {
  if (!w || !h) throw new Error('画像の大きさを取得できませんでした');
  const sc = Math.min(1, (maxW || 1400) / w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * sc));
  c.height = Math.max(1, Math.round(h * sc));
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(src, 0, 0, c.width, c.height);
  const dataURL = c.toDataURL('image/jpeg', 0.82);
  if (!dataURL || dataURL.length < 128) throw new Error('画像を変換できませんでした');
  return { dataURL: dataURL, w: c.width, h: c.height };
}
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ''));
    fr.onerror = () => rej(new Error('ファイルを読み取れませんでした'));
    try { fr.readAsDataURL(file); } catch (e) { rej(new Error('ファイルを読み取れませんでした')); }
  });
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('この形式の画像を表示できません'));
    im.src = src;
    setTimeout(() => rej(new Error('画像の読み込みに時間がかかりすぎました')), 20000);
  });
}
function imageFormatError(file) {
  const name = String((file && file.name) || '').toLowerCase();
  const type = String((file && file.type) || '');
  if (/\.(heic|heif)$/.test(name) || /heic|heif/i.test(type)) {
    return new Error('iPhoneのHEIC形式は、このブラウザでは開けませんでした。'
      + '「設定」→「カメラ」→「フォーマット」を「互換性優先」にすると、以後はJPEGで撮影されます。');
  }
  if (/\.(pdf)$/.test(name)) return new Error('PDFは読み取れません。写真として撮影してください。');
  return new Error('この画像を開けませんでした' + (type ? '（形式：' + type + '）' : '') + '。別の方法で撮影・保存してからお試しください。');
}
async function decodeImage(file) {
  if (!file || !file.size) throw new Error('写真が受け取れませんでした。もう一度撮影してください。');
  if (file.size > 40 * 1024 * 1024) throw new Error('写真の容量が大きすぎます（40MBまで）。');
  /* ① createImageBitmap：対応形式が広く、大きな写真にも強い */
  if (typeof createImageBitmap === 'function') {
    try { const b = await createImageBitmap(file); return { src: b, w: b.width, h: b.height, bmp: true }; }
    catch (e) { /* ②へ */ }
  }
  /* ② FileReader でデータURLにしてから読み込む（file:// でも動く） */
  try {
    const im = await loadImage(await readAsDataURL(file));
    return { src: im, w: im.naturalWidth || im.width, h: im.naturalHeight || im.height };
  } catch (e) { /* ③へ */ }
  /* ③ 一時URL経由（古いブラウザ向け） */
  let url = null;
  try {
    url = URL.createObjectURL(file);
    const im = await loadImage(url);
    return { src: im, w: im.naturalWidth || im.width, h: im.naturalHeight || im.height };
  } catch (e) { throw imageFormatError(file); }
  finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 30000); }
}
function releaseImage(dec) { if (dec && dec.bmp && dec.src && dec.src.close) { try { dec.src.close(); } catch (e) { /* 無視 */ } } }
/* rect は 0〜1 の割合で指定。null なら全体。 */
function renderRegion(dec, rect, maxW, allowUpscale) {
  const r = rect || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.max(0, Math.round(r.x * dec.w)), sy = Math.max(0, Math.round(r.y * dec.h));
  const sw = Math.max(1, Math.round(r.w * dec.w)), sh = Math.max(1, Math.round(r.h * dec.h));
  /* 読み取り用は、切り出しが小さいときに拡大する（文字が小さいと認識できないため） */
  const sc = Math.min(allowUpscale ? 2.5 : 1, (maxW || 1400) / sw);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * sc));
  c.height = Math.max(1, Math.round(sh * sc));
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in x) x.imageSmoothingQuality = 'high';
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(dec.src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const durl = c.toDataURL('image/jpeg', 0.9);
  if (!durl || durl.length < 128) throw new Error('画像を変換できませんでした');
  return durl;
}

/* 認識しやすいよう、周辺の明るさに応じて白黒に整える（影や照明ムラに強い） */
function preprocess(dataURL) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, W, H), p = d.data;
        /* グレースケール化 */
        const g = new Uint8Array(W * H);
        for (let i = 0, j = 0; i < p.length; i += 4, j++) {
          g[j] = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) | 0;
        }
        /* 積分画像を作り、周辺の平均と比べて 白と黒を決める */
        const integ = new Float64Array((W + 1) * (H + 1));
        for (let y = 0; y < H; y++) {
          let rowSum = 0;
          for (let xx = 0; xx < W; xx++) {
            rowSum += g[y * W + xx];
            integ[(y + 1) * (W + 1) + xx + 1] = integ[y * (W + 1) + xx + 1] + rowSum;
          }
        }
        const S = Math.max(12, Math.round(W / 16));   /* 参照する窓の半径 */
        const T = 0.86;                               /* 周辺平均に対する比率 */
        for (let y = 0; y < H; y++) {
          const y1 = Math.max(0, y - S), y2 = Math.min(H - 1, y + S);
          for (let xx = 0; xx < W; xx++) {
            const x1 = Math.max(0, xx - S), x2 = Math.min(W - 1, xx + S);
            const cnt = (x2 - x1 + 1) * (y2 - y1 + 1);
            const sum = integ[(y2 + 1) * (W + 1) + x2 + 1] - integ[y1 * (W + 1) + x2 + 1]
                      - integ[(y2 + 1) * (W + 1) + x1] + integ[y1 * (W + 1) + x1];
            const v = g[y * W + xx] < (sum / cnt) * T ? 0 : 255;
            const i = (y * W + xx) * 4;
            p[i] = p[i + 1] = p[i + 2] = v;
          }
        }
        x.putImageData(d, 0, 0);
        res(c.toDataURL('image/jpeg', 0.92));
      } catch (e) { res(dataURL); }
    };
    img.onerror = () => res(dataURL);
    img.src = dataURL;
  });
}

/* レシートの範囲を自動で推定する。
   感熱紙は白黒（彩度が低い）で、机・布などの背景は色がある、という違いを使う。 */
function autoDetectReceipt(dec) {
  try {
    const W = 320, H = Math.max(1, Math.round(dec.h * W / dec.w));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d'); x.drawImage(dec.src, 0, 0, W, H);
    const p = x.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const r = p[i] / 255, g = p[i + 1] / 255, b = p[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      mask[j] = sat < 0.09 && mx > 0.18 ? 1 : 0;
    }
    const longestRun = (arr, th) => {
      let best = [0, 0], cur = -1;
      for (let i = 0; i <= arr.length; i++) {
        const on = i < arr.length && arr[i] > th;
        if (on && cur < 0) cur = i;
        if (!on && cur >= 0) { if (i - cur > best[1] - best[0]) best = [cur, i]; cur = -1; }
      }
      return best;
    };
    const col = new Float32Array(W);
    for (let xx = 0; xx < W; xx++) { let n = 0; for (let y = 0; y < H; y++) n += mask[y * W + xx]; col[xx] = n / H; }
    const [x0, x1] = longestRun(col, 0.35);
    if (x1 - x0 < 8) return null;
    const row = new Float32Array(H);
    for (let y = 0; y < H; y++) { let n = 0; for (let xx = x0; xx < x1; xx++) n += mask[y * W + xx]; row[y] = n / (x1 - x0); }
    const [y0, y1] = longestRun(row, 0.35);
    const rect = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
    const area = rect.w * rect.h;
    /* ほぼ全体、または小さすぎる場合は当てにしない */
    if (area < 0.12 || area > 0.93 || rect.w < 0.2 || rect.h < 0.2) return null;
    return rect;
  } catch (e) { return null; }
}

let OCR_DEC = null, OCR_RECT = null;
async function startOCR(file) {
  releaseImage(OCR_DEC); OCR_DEC = null;
  let dec = null, loadErr = null;
  try { dec = await decodeImage(file); } catch (e) { loadErr = e; }
  OCR_RECT = null;
  const thumb = dec ? renderRegion(dec, null, 1000) : null;
  modal('レシートの読み取り', `
    ${dec ? `<div class="cropwrap" id="cropWrap">
      <img class="thumb" id="cropImg" src="${thumb}" alt="撮影したレシート">
      <div class="cropbox" id="cropBox" hidden></div>
    </div>
    <div class="row" style="margin-top:8px">
      <span class="tiny" id="cropHint" style="margin-right:auto">写真の上をなぞって、レシートの部分だけを囲むと読み取りやすくなります</span>
      <button class="btn ghost sm" data-o="whole">全体に戻す</button>
      <button class="btn sm" data-o="redo">この範囲で読み取る</button>
    </div>` : ''}
    <div id="ocrStat" class="warn" style="margin-top:10px">読み取りを準備しています…</div>
    <div id="ocrBody">
      <div class="grid g2">
        <label class="fld"><span>年月日</span><input id="oDate" type="date"></label>
        <label class="fld"><span>金額（円）</span><input id="oAmount" class="amt" type="number"></label>
      </div>
      <label class="fld" style="margin-top:10px"><span>相手先</span><input id="oPayee"></label>
      <label class="fld" style="margin-top:10px"><span>目（科目）</span><select id="oItem">${itemOptions('expense', guessItemInit())}</select></label>
      <label class="fld" style="margin-top:10px"><span>件名</span><input id="oTitle"></label>
      <details style="margin-top:10px"><summary class="tiny">読み取った文字を確認する</summary><div id="oRaw" class="ocrlines"></div></details>
      <label class="chk" style="margin-top:10px"><input type="checkbox" id="oKeep" checked>レシート画像を一緒に保存する</label>
      <div class="row end" style="margin-top:14px"><button class="btn" data-o="save">出納簿に登録</button></div>
    </div>`, (root) => {
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-o]'); if (!b) return;
      if (b.dataset.o === 'whole') { OCR_RECT = null; $('#cropBox', root).hidden = true; abortOCR(); ocrCancel = false; startRecognize(); return; }
      if (b.dataset.o === 'redo') { abortOCR(); ocrCancel = false; startRecognize(); return; }
      if (b.dataset.o === 'save') {
        const amount = num($('#oAmount').value);
        if (!amount) { toast('金額を入力してください'); return; }
        let rid = null;
        if (thumb && $('#oKeep').checked && Store.mode() === 'idb') { rid = uid(); await Store.put('blob', rid, thumb); }
        S.tx.push({
          id: uid(), seq: String(S.seq++).padStart(5, '0'), type: 'out',
          date: $('#oDate').value || today(), amount, itemId: $('#oItem').value,
          title: $('#oTitle').value, payee: $('#oPayee').value, memo: '', accountId: S.settings.defaultAccount || '',
          receiptId: rid, ocr: true
        });
        stopOCR(); save(); closeModal(); toast('出納簿に登録しました'); go('ledger');
      }
    });
    OCR_DEC = dec;
    if (dec) {
      setupCrop(root);
      const auto = autoDetectReceipt(dec);
      if (auto) {
        OCR_RECT = auto;
        const img = $('#cropImg', root);
        const place = () => showCropRect(root, auto);
        if (img.complete) requestAnimationFrame(place); else img.addEventListener('load', place, { once: true });
        const hint = $('#cropHint', root);
        if (hint) hint.textContent = 'レシートの範囲を自動で選びました。ずれている場合は、なぞって選び直してください。';
      }
    }
    $('#oDate').value = today();
    if (!dec) {
      const st = $('#ocrStat', root);
      st.className = 'err';
      st.textContent = (loadErr && loadErr.message) || '画像を読み込めませんでした';
      $('#oKeep').checked = false; $('#oKeep').disabled = true;
      return;
    }
    startRecognize();
  });
}
function startRecognize() {
  if (!OCR_DEC) return;
  /* 指定範囲を高い解像度で描き直してから読み取る */
  let url;
  try { url = renderRegion(OCR_DEC, OCR_RECT, OCR_RECT ? 2200 : 1900, true); }
  catch (e) { manualMode('画像を用意できませんでした。手で入力してください。'); return; }
  runOCR(url);
}
/* 写真の実際の表示位置（余白を除いた部分） */
function imageBox(img) {
  const r = img.getBoundingClientRect();
  const iw = img.naturalWidth || r.width, ih = img.naturalHeight || r.height;
  const sc = Math.min(r.width / iw, r.height / ih);
  const w = iw * sc, h = ih * sc;
  const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
  return { left, top, width: w, height: h, right: left + w, bottom: top + h };
}
function showCropRect(root, rect) {
  const wrap = $('#cropWrap', root), img = $('#cropImg', root), box = $('#cropBox', root);
  if (!wrap || !img || !box) return;
  const r = imageBox(img), w = wrap.getBoundingClientRect();
  box.hidden = false;
  box.style.left = (r.left - w.left + rect.x * r.width) + 'px';
  box.style.top = (r.top - w.top + rect.y * r.height) + 'px';
  box.style.width = (rect.w * r.width) + 'px';
  box.style.height = (rect.h * r.height) + 'px';
}
/* 写真の上をなぞって範囲を選ぶ */
function setupCrop(root) {
  const wrap = $('#cropWrap', root), img = $('#cropImg', root), box = $('#cropBox', root);
  if (!wrap || !img) return;
  let sx = 0, sy = 0, dragging = false;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const draw = (x1, y1, x2, y2) => {
    const r = imageBox(img);
    OCR_RECT = {
      x: (Math.min(x1, x2) - r.left) / r.width,
      y: (Math.min(y1, y2) - r.top) / r.height,
      w: Math.abs(x2 - x1) / r.width,
      h: Math.abs(y2 - y1) / r.height
    };
    showCropRect(root, OCR_RECT);
  };
  const start = (e) => {
    const t = e.touches ? e.touches[0] : e;
    const r = imageBox(img);
    if (t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom) return;
    dragging = true; sx = t.clientX; sy = t.clientY;
    draw(sx, sy, sx, sy);
    e.preventDefault();
  };
  const move = (e) => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e, r = imageBox(img);
    draw(sx, sy, clamp(t.clientX, r.left, r.right), clamp(t.clientY, r.top, r.bottom));
    e.preventDefault();
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!OCR_RECT || OCR_RECT.w < 0.06 || OCR_RECT.h < 0.06) { OCR_RECT = null; box.hidden = true; }
  };
  wrap.addEventListener('mousedown', start); wrap.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', move); wrap.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', end); wrap.addEventListener('touchend', end);
}
function guessItemInit() {
  const g = S.categories.expense[0]; return g && g.items[0] ? g.items[0].id : '';
}
const OCR_PHASE = {
  'loading tesseract core': 'エンジンを読み込み中',
  'loading tesseract': 'エンジンを読み込み中',
  'initializing tesseract': '準備中',
  'initializing api': '準備中',
  'loading language traineddata': '日本語データを取得中',
  'loading language traineddata (from cache)': '日本語データを読み込み中',
  'initialized api': '準備完了',
  'recognizing text': '読み取り中'
};
let ocrWorker = null, ocrCancel = false;
async function runOCR(dataURL) {
  const stat = $('#ocrStat');
  ocrCancel = false;
  const show = (msg, cancellable) => {
    stat.className = 'warn';
    stat.innerHTML = esc(msg) + (cancellable ? ' <button class="linkbtn" data-cancel>中止して手入力</button>' : '');
    const cb = stat.querySelector('[data-cancel]');
    if (cb) cb.addEventListener('click', () => { ocrCancel = true; stopOCR(); manualMode('手入力に切り替えました。下の欄に入力してください。'); });
  };
  try {
    if (location.protocol === 'file:' && !hasEmbeddedOCR()) {
      throw new Error('ファイルを直接開いた状態では文字認識エンジンを取得できません。httpsまたはlocalhost経由で開いてください');
    }
    show('文字認識エンジンを準備しています…', true);
    await loadTesseract();
    if (ocrCancel) return;
    const pre = await preprocess(dataURL);
    if (ocrCancel) return;

    const logger = (m) => {
      if (ocrCancel) return;
      const label = OCR_PHASE[m.status] || m.status || '処理中';
      const pct = m.progress != null ? Math.round(m.progress * 100) : null;
      const first = /traineddata/.test(m.status || '') && !/cache/.test(m.status || '');
      show(label + (pct != null ? '… ' + pct + '%' : '…') + (first ? '（初回のみ・数十秒かかることがあります）' : ''), true);
    };
    let worker = null;
    try { worker = await createOCRWorker(logger); }
    catch (e) {
      const why = (e && (e.message || String(e))) || '';
      throw new Error((OCR_MODE === 'cdn' ? '日本語データを取得できませんでした' : '文字認識の準備に失敗しました') + (why ? '（' + why.slice(0, 80) + '）' : ''));
    }
    ocrWorker = worker;
    if (ocrCancel) { stopOCR(); return; }
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: OCR_RECT ? '6' : '4',   /* 範囲指定ありなら1つの塊として読む */
        preserve_interword_spaces: '1'
      });
    } catch (e) { /* 対応していない版では既定のまま */ }

    /* 応答がないまま3分経ったら打ち切る */
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('時間内に読み取れませんでした。通信環境の良い場所でお試しください')), ms));
    const r = await Promise.race([worker.recognize(pre), timeout(180000)]);
    if (ocrCancel) { stopOCR(); return; }

    let text = (r && r.data && r.data.text) || '';
    let p = parseReceipt(text);
    /* 白黒化がうまくいかなかった場合に備え、元の写真でもう一度試す */
    if (!p.amount) {
      show('もう一度読み取っています…', true);
      try {
        const r2 = await Promise.race([worker.recognize(dataURL), timeout(180000)]);
        if (ocrCancel) { stopOCR(); return; }
        const t2 = (r2 && r2.data && r2.data.text) || '';
        const p2 = parseReceipt(t2);
        if (p2.amount || t2.length > text.length * 1.3) { text = t2; p = p2; }
      } catch (e) { /* 1回目の結果を使う */ }
    }
    stopOCR();
    if (ocrCancel) return;

    $('#oRaw').textContent = text || '（文字を検出できませんでした）';
    if (p.date) $('#oDate').value = p.date;
    if (p.amount) $('#oAmount').value = p.amount;
    if (p.payee) $('#oPayee').value = p.payee;
    if (p.title) $('#oTitle').value = p.title;
    const gi = guessItem(p.payee + ' ' + text, p.cat);
    if (gi) $('#oItem').value = gi;
    stat.className = p.amount ? 'ok' : 'warn';
    stat.innerHTML = p.amount
      ? '読み取りました。金額と日付が合っているか確かめてから登録してください。'
      : '金額を読み取れませんでした。<b>写真の上をなぞってレシートの部分だけを囲み、「この範囲で読み取る」</b>を押すと精度が上がります。手入力でも登録できます。';
  } catch (err) {
    stopOCR();
    if (ocrCancel) return;
    stat.className = 'err';
    stat.innerHTML = '自動読み取りができませんでした（' + esc(err.message || 'エラー') + '）。'
      + '下の欄に手で入力して登録できます。 <button class="linkbtn" data-retry>もう一度試す</button>';
    const rb = stat.querySelector('[data-retry]');
    if (rb) rb.addEventListener('click', () => runOCR(dataURL));
  }
}
function abortOCR() { ocrCancel = true; stopOCR(); }
function stopOCR() {
  if (ocrWorker) { try { ocrWorker.terminate(); } catch (e) { /* 無視 */ } ocrWorker = null; }
}
function manualMode(msg) {
  const stat = $('#ocrStat');
  if (!stat) return;
  stat.className = 'warn';
  stat.textContent = msg;
  const d = $('#oDate');
  if (d && !d.value) d.value = today();
}

/* 主な店名。認識で1〜2文字化けても拾えるよう、揺れを許す書き方にしている。
   cat は科目名に含まれる語（食料・外食・日用品・交通・衣服・医療）。 */
const STORES = [
  [/マク[ドトト゛]?ナル[ドト]|ナル[ドト]\s*[0-9０-９]|McDonald/i, 'マクドナルド', '外食'],
  [/Fam[il1|]{1,3}y|ファミリ.?マ|ファミマ/i, 'ファミリーマート', '食料'],
  [/セ[ブフプ]?ン.{0,3}イ[レワル].{0,2}ン|7.?ELEVEN|SEVEN.?ELEVEN/i, 'セブン-イレブン', '食料'],
  [/ロ.?ソン|LAWSON/i, 'ローソン', '食料'],
  [/セイコ.?マ.?ト|Seicomart/i, 'セイコーマート', '食料'],
  [/ミニスト.?プ|MINISTOP/i, 'ミニストップ', '食料'],
  [/デイリ.?ヤマザキ/, 'デイリーヤマザキ', '食料'],
  [/ベイシア|Beisia/i, 'ベイシア', '食料'],
  [/カスミ|KASUMI/i, 'カスミ', '食料'],
  [/セイミヤ/, 'セイミヤ', '食料'],
  [/ヨ.?クベニマル/, 'ヨークベニマル', '食料'],
  [/イオン|AEON/i, 'イオン', '食料'],
  [/ヤオコ/, 'ヤオコー', '食料'],
  [/とりせん/, 'とりせん', '食料'],
  [/業務ス.?パ/, '業務スーパー', '食料'],
  [/カワチ/, 'カワチ薬品', '日用品'],
  [/ウエルシア|welcia/i, 'ウエルシア', '日用品'],
  [/ツルハ/, 'ツルハドラッグ', '日用品'],
  [/マツモトキヨシ|マツキヨ/, 'マツモトキヨシ', '日用品'],
  [/コメリ/, 'コメリ', '日用品'],
  [/カインズ|CAINZ/i, 'カインズ', '日用品'],
  [/ジョイフル本田/, 'ジョイフル本田', '日用品'],
  [/ダイソ|DAISO/i, 'ダイソー', '日用品'],
  [/セリア|Seria/i, 'セリア', '日用品'],
  [/ニトリ/, 'ニトリ', '日用品'],
  [/ENEOS|エネオス/i, 'ENEOS', '交通'],
  [/出光|apollo/i, '出光', '交通'],
  [/コスモ石油|COSMO/i, 'コスモ石油', '交通'],
  [/すき家/, 'すき家', '外食'], [/吉野家/, '吉野家', '外食'], [/松屋/, '松屋', '外食'],
  [/ガスト/, 'ガスト', '外食'], [/サイゼリヤ/, 'サイゼリヤ', '外食'], [/くら寿司/, 'くら寿司', '外食'],
  [/スシロ/, 'スシロー', '外食'], [/はま寿司/, 'はま寿司', '外食'], [/丸亀製麺/, '丸亀製麺', '外食'],
  [/ケンタッキ/, 'ケンタッキー', '外食'], [/モスバ.?ガ/, 'モスバーガー', '外食'],
  [/ミスタ.?ド.?ナツ/, 'ミスタードーナツ', '外食'], [/スタ.?バックス|STARBUCKS/i, 'スターバックス', '外食'],
  [/ユニクロ|UNIQLO/i, 'ユニクロ', '衣服'], [/しまむら/, 'しまむら', '衣服']
];
/* 意味のある文字列か（「ーールンニンン」のような雑音を除く） */
function looksReal(t) {
  t = String(t || '').trim();
  const core = t.replace(/[\s・]/g, '');
  if (core.length < 3) return false;
  if ((core.match(/ー/g) || []).length / core.length > 0.35) return false;
  if (new Set(core).size / core.length < 0.5) return false;
  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.length >= 2 && toks.filter((x) => x.length === 1).length / toks.length >= 0.5) return false;
  return true;
}
function findStore(text) {
  const t = String(text || '');
  for (const [re, name, cat] of STORES) if (re.test(t)) return { name, cat };
  return null;
}

/* レシート文字列の解析 */
function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const joined = lines.join('\n');
  /* 日付 */
  let date = null;
  let m = joined.match(/(20\d{2})\s*[年\/\-\.]\s*(\d{1,2})\s*[月\/\-\.]\s*(\d{1,2})/);
  if (m) date = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  if (!date) { m = joined.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/); if (m) date = `${2018 + Number(m[1])}-${pad2(m[2])}-${pad2(m[3])}`; }
  if (!date) { m = joined.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/); if (m) { const y = new Date().getFullYear(); date = `${y}-${pad2(m[1])}-${pad2(m[2])}`; } }
  /* 金額の決め方
     ・合計を表す語がある行を最優先
     ・レシートでは合計額が何度も現れるため、出現回数も手がかりにする
     ・小計や税、預り金、電話番号などの行は候補から除く */
  const KEY = /(合.{0,3}[計訃言二十]|台\s*計|お?買上|税込|総額|お?支払|請求|現計|売上|^\s*計\s)/;
  const NEG = /(小\s*計|消費税|内税|外税|お預|預り|おあずかり|お釣|釣銭|釣り|ポイント|会員|伝票|登録番号|登錬番号|TEL|電話|営業|レジ|番号|残高|カード|有効期限|承認|責\s*No|No\.\s*\d|20\d{2}\s*[年\/\-.]|令和|平成|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*:\s*\d{2}|\d{2,4}-\d{2,4}-\d{3,4})/;
  /* 「8%対象 ¥651」のような税率ごとの対象額（小さな字で正しく読めることが多い） */
  const TAIGAKU = /[0-9０-９]\s*[%％]?.{0,3}[対材村]\s*象|[0-9０-９]\s*[%％].{0,3}象/;
  const NUMRE = /[¥￥\\*＊]?\s*([0-9０-９][0-9０-９,，.\s]{0,12})/g;
  const z2h = (t) => t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,，.\s]/g, '');
  const numsIn = (ln) => {
    const out = []; let m; NUMRE.lastIndex = 0;
    while ((m = NUMRE.exec(ln))) {
      const v = Number(z2h(m[1]));
      if (v >= 10 && v <= 3000000) out.push({ v: v, yen: /[¥￥\\*＊]/.test(m[0]) });
    }
    return out;
  };
  /* 合計は、商品1つ1つの金額より小さくはならない → 下限を求める */
  const firstTotal = lines.findIndex((ln) => /小\s*計|合.{0,3}[計訃言二十]/.test(ln));
  let minTotal = 0;
  lines.slice(0, firstTotal < 0 ? lines.length : firstTotal).forEach((ln) => {
    if (NEG.test(ln) || TAIGAKU.test(ln)) return;
    numsIn(ln).forEach((n) => { if (n.yen && n.v > minTotal) minTotal = n.v; });
  });
  const cands = [];
  lines.forEach((ln) => {
    const neg = NEG.test(ln), key = KEY.test(ln), tai = TAIGAKU.test(ln);
    numsIn(ln).forEach((n) => {
      /* 対象額の行では「8%」の8を拾わない */
      if (tai && n.v < 100 && new RegExp(n.v + '\\s*[%％]?\\s*.{0,2}[対材村]?\\s*象|' + n.v + '\\s*[%％]').test(ln)) return;
      cands.push({ v: n.v, key: key && !neg, tai: tai, neg: neg && !tai });
    });
  });
  const freq = {};
  cands.forEach((c) => { freq[c.v] = (freq[c.v] || 0) + 1; });
  /* 対象額が2つ（8%と10%）あれば、その合計も候補にする */
  const taiVals = cands.filter((c) => c.tai).map((c) => c.v);
  if (taiVals.length === 2) cands.push({ v: taiVals[0] + taiVals[1], key: false, tai: true, neg: false, sum: true });
  let amount = null, bestScore = -Infinity;
  const pick = (strict) => cands.forEach((c) => {
    if (c.neg) return;
    if (strict && c.v < minTotal) return;          /* 商品額より小さい合計はありえない */
    let sc = c.v;
    if (c.key) sc += 5000000;
    if (c.tai) sc += 4500000;
    sc += (freq[c.v] - 1) * 1500000;              /* 何度も現れる金額は合計の可能性が高い */
    if (sc > bestScore) { bestScore = sc; amount = c.v; }
  });
  pick(true);
  if (amount == null) pick(false);
  /* それでも無ければ、除外行も含めて最頻・最大のもの */
  if (amount == null && cands.length) {
    cands.forEach((c) => {
      const sc = c.v + (freq[c.v] - 1) * 1500000;
      if (sc > bestScore) { bestScore = sc; amount = c.v; }
    });
  }
  /* 相手先：店名辞書を優先。なければ上部の行のうち、意味のある文字が続く部分 */
  let payee = '';
  const store = findStore(lines.slice(0, 12).join('\n')) || findStore(joined);
  if (store) payee = store.name;
  else {
    const GOOD = /[ァ-ヶーｦ-ﾟぁ-ん一-龥A-Za-z0-9・&＆]{3,}/g;
    for (const ln of lines.slice(0, 6)) {
      if (/[0-9０-９]{4,}|領収|レシート|明細|TEL|電話|登録|様/.test(ln)) continue;
      const segs = (ln.match(GOOD) || []).filter((x) => !/^\d+$/.test(x)).sort((p, q) => q.length - p.length);
      const good = segs.find((x) => x.length <= 24 && looksReal(x));
      if (good) { payee = good; break; }
    }
  }
  /* 件名：品目らしい行を優先して拾う（住所・電話・合計行などは除く） */
  const SKIP = /(合\s*計|小\s*計|消費税|お預|お釣|釣銭|領収|レシート|明細|TEL|電話|様|登録番号|レジ|営業|伝票|会員|売上|支払|対象|番号|\d{1,2}:\d{2}|現金|クレジット|カード|電子マネー|ポイント|チャージ|残高|QUICPay|PayPay|Suica|nanaco|WAON|楽天|令和|平成|昭和|20\d{2}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日)/;
  const ADDR = /(都|道|府|県|市|区|町|村|丁目|番地|\d+-\d+)/;
  const clean = (ln) => ln
    .replace(/[¥￥][0-9０-９,，.]+/g, ' ')
    .replace(/[0-9０-９][0-9０-９,，.]*\s*[コ個点入袋本枚]/g, ' ')
    .replace(/[0-9０-９,，.]{2,}/g, ' ')
    .replace(/[（）()「」『』【】※*＊_@]/g, ' ')
    .replace(/(^|\s)(ml|mL|cc|L|ℓ|g|kg|G|入|袋|本|枚|個|コ)(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const usable = (ln) => ln !== payee && !SKIP.test(ln) && !ADDR.test(ln) && /[ぁ-んァ-ヶ一-龥ｱ-ﾝ]/.test(ln);
  let title = '';
  /* ① 「品名 … 金額」の形になっている行から、金額の直前の品名を取り出す */
  const ITEM = /([ァ-ヶーｦ-ﾟぁ-ん一-龥A-Za-z][ァ-ヶーｦ-ﾟぁ-ん一-龥A-Za-z0-9・]{1,}(?:\s[ァ-ヶーｦ-ﾟ一-龥A-Za-z][ァ-ヶーｦ-ﾟ一-龥A-Za-z0-9]{1,})?)\s+\S{0,2}\s*[*＊¥￥\\]?\s*[0-9０-９][0-9０-９,，]{1,}/;
  for (const ln of lines) {
    if (ln === payee || SKIP.test(ln) || ADDR.test(ln) || findStore(ln)) continue;
    const m = ln.match(ITEM);
    if (!m) continue;
    const t = clean(m[1]);
    const letters = t.replace(/[0-9０-９\s]/g, '');
    const kanji2 = /^[一-龥]{2}$/.test(t);   /* 牛乳・豆腐など漢字2文字の品名 */
    if ((kanji2 || (letters.length >= 3 && looksReal(t))) && !/^[A-Za-z0-9 ]+$/.test(t)) { title = t.slice(0, 24); break; }
  }
  /* ② 見つからなければ、記号や数字を除いた最初の行 */
  if (!title) {
    for (const ln of lines) {
      if (!usable(ln) || findStore(ln)) continue;
      const t = clean(ln);
      if (t.length >= 3 && looksReal(t)) { title = t.slice(0, 24); break; }
    }
  }
  return { date, amount, payee, title, cat: store ? store.cat : '' };
}
/* 相手先・本文から科目を推測（学習：過去の相手先と一致すればそれを使う） */
function guessItem(text, cat) {
  const t = (text || '').toLowerCase();
  const byKey = (key) => {
    for (const g of S.categories.expense) for (const it of g.items) if (it.name.includes(key)) return it.id;
    return '';
  };
  /* ① 以前に同じ相手先で記帳していれば、その科目を使う（学習） */
  for (let i = S.tx.length - 1; i >= 0; i--) {
    const tx = S.tx[i];
    if (tx.payee && tx.itemId && tx.payee.length >= 2 && t.includes(tx.payee.toLowerCase())) return tx.itemId;
  }
  /* ② 店名辞書 */
  const st = cat ? { cat } : findStore(text);
  if (st && st.cat) { const id = byKey(st.cat); if (id) return id; }
  /* ③ 語句 */
  const RULE = [
    [/スーパー|マート|ストア|青果|精肉|鮮魚|食品|八百屋|肉屋|魚屋|豆腐|ベーカリー|パン屋|酒店|米穀|直売所|農産物/, '食料'],
    [/ドラッグ|薬局|ホームセンター/, '日用品'],
    [/ガソリン|給油|石油|レギュラー|ハイオク|軽油/, '交通'],
    [/病院|クリニック|医院|歯科|調剤/, '医療'],
    [/レストラン|食堂|ラーメン|居酒屋|カフェ|寿司|そば|うどん/, '外食'],
    [/衣料|美容室|理容/, '衣服'],
    [/電気料金|電力/, '電気'], [/水道料金/, '水道'], [/ガス料金/, 'ガス'],
    [/携帯|通信料/, '通信'],
    [/書店|映画|カラオケ|レジャー/, '娯楽']
  ];
  for (const [re, key] of RULE) if (re.test(t)) { const id = byKey(key); if (id) return id; }
  return '';
}
async function showReceipt(rid, box) {
  if (!box) return;
  const d = await Store.get('blob', rid);
  if (!d) { box.innerHTML = '<p class="tiny">画像は見つかりませんでした</p>'; return; }
  box.innerHTML = `<img class="thumb" src="${d}" alt="レシート"><div class="row end" style="margin-top:6px"><button class="linkbtn" data-rm="${rid}">画像を削除</button></div>`;
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    await Store.del('blob', b.dataset.rm);
    S.tx.forEach((t) => { if (t.receiptId === b.dataset.rm) t.receiptId = null; });
    save(); box.innerHTML = '<p class="tiny">画像を削除しました</p>';
  });
}

/* ---------- 16. 通帳・カード ---------- */
function viewAccounts() {
  const rows = S.accounts.map((a) => {
    const bal = balanceOfAccount(a.id);
    const m = S.members.find((x) => x.id === a.memberId);
    return `<tr class="clickable" data-act="edit" data-id="${a.id}">
      <td>${esc(m ? m.name : '—')}</td>
      <td><b>${esc(a.bank)}</b><div class="tiny">${esc(a.branch || '')} ${esc(a.kind || '')} ${a.last4 ? '****' + esc(a.last4) : ''}</div></td>
      <td>${esc(a.name || '')}<div class="tiny">${esc(a.memo || '')}</div></td>
      <td class="r num">${yen(a.opening)}</td>
      <td class="r num ${bal < 0 ? 'neg' : ''}"><b>${yen(bal)}</b></td></tr>`;
  }).join('');
  const total = S.accounts.reduce((s, a) => s + balanceOfAccount(a.id), 0);
  const unassigned = S.tx.filter((t) => !t.accountId).reduce((s, t) => s + (t.type === 'in' ? num(t.amount) : -num(t.amount)), 0);
  const byMember = S.members.map((m) => ({ label: m.name, value: Math.max(0, S.accounts.filter((a) => a.memberId === m.id).reduce((s, a) => s + balanceOfAccount(a.id), 0)) })).filter((x) => x.value > 0);
  return `
  <section class="form">
    <div class="fh"><h2>通　帳　・　カ ー ド</h2><span class="slip">預貯金一覧</span></div>
    <div class="tw"><table class="led">
      <thead><tr><th>名義</th><th>金融機関</th><th>用途・備考</th><th class="r">開始残高</th><th class="r">現在残高</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty"><b>口座がまだありません</b>「＋口座を追加」から、誰のどの預貯金かを登録してください。</td></tr>'}
      ${S.accounts.length ? `<tr class="sum"><td colspan="4">合　　計</td><td class="r num">${yen(total)}</td></tr>` : ''}
      ${unassigned !== 0 ? `<tr><td colspan="4" class="tiny">口座を指定していない記帳の差引</td><td class="r num tiny">${yen(unassigned)}</td></tr>` : ''}
      </tbody></table></div>
    <div class="fb">
      <div class="row end">
        <button class="btn ghost sm" data-act="member">名義人を管理</button>
        <button class="btn sm" data-act="add">＋ 口座を追加</button>
      </div>
      <p class="note">現在残高＝開始残高＋その口座に紐づけた記帳の増減。口座を指定せずに記帳したものは上の行にまとめています。</p>
    </div>
  </section>
  ${byMember.length ? `<section class="form"><div class="fh"><h2>名 義 別 の 内 訳</h2></div><div class="fb">${donutChart(byMember)}</div></section>` : ''}`;
}
function bind_accounts() {
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'add') editAccount(null);
    if (a === 'edit') editAccount(b.dataset.id);
    if (a === 'member') editMembers();
  });
}
function editAccount(id) {
  const a = S.accounts.find((x) => x.id === id) || { id: null, memberId: S.members[0] && S.members[0].id, bank: '', branch: '', kind: '普通預金', last4: '', name: '', opening: 0, memo: '' };
  const kinds = ['普通預金', '定期預金', '積立', '財形', '現金', 'クレジットカード', '電子マネー', '証券', 'その他'];
  modal(id ? '口座の修正' : '口座の追加', `
    <div class="grid g2">
      <label class="fld"><span>名義人</span><select id="aMember">${memberOptions(a.memberId)}</select></label>
      <label class="fld"><span>種別</span><select id="aKind">${kinds.map((k) => `<option${k === a.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    </div>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>金融機関名</span><input id="aBank" value="${esc(a.bank)}" placeholder="例：常陽銀行"></label>
      <label class="fld"><span>支店名</span><input id="aBranch" value="${esc(a.branch || '')}"></label>
    </div>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>口座番号 下4桁</span><input id="aLast4" maxlength="4" inputmode="numeric" value="${esc(a.last4 || '')}" placeholder="1234"></label>
      <label class="fld"><span>開始残高（円）</span><input id="aOpen" type="number" value="${num(a.opening)}"></label>
    </div>
    <label class="fld" style="margin-top:10px"><span>呼び名</span><input id="aName" value="${esc(a.name || '')}" placeholder="例：生活費用"></label>
    <label class="fld" style="margin-top:10px"><span>備考</span><input id="aMemo" value="${esc(a.memo || '')}"></label>
    <div class="warn" style="margin-top:12px">口座番号は下4桁だけを控える設計にしています。暗証番号やフルの口座番号は入力しないでください。</div>
    <div class="row end" style="margin-top:12px">
      ${id ? '<button class="btn danger ghost" data-m="del">削 除</button>' : ''}
      <button class="btn" data-m="ok">保 存</button>
    </div>`, (root) => {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      if (b.dataset.m === 'del') {
        if (!confirmBox('この口座を削除します。紐づけた記帳は「口座指定なし」になります。')) return;
        S.accounts = S.accounts.filter((x) => x.id !== id);
        S.tx.forEach((t) => { if (t.accountId === id) t.accountId = ''; });
        save(); closeModal(); render(); return;
      }
      const d = {
        memberId: $('#aMember').value, kind: $('#aKind').value, bank: $('#aBank').value.trim(),
        branch: $('#aBranch').value.trim(), last4: $('#aLast4').value.replace(/\D/g, '').slice(0, 4),
        opening: num($('#aOpen').value), name: $('#aName').value.trim(), memo: $('#aMemo').value.trim()
      };
      if (!d.bank) { toast('金融機関名を入力してください'); return; }
      if (id) Object.assign(a, d); else S.accounts.push(Object.assign({ id: uid() }, d));
      save(); closeModal(); render(); toast('保存しました');
    });
  });
}
function editMembers() {
  modal('名義人の管理', `<div id="mList"></div>
    <div class="row" style="margin-top:10px"><input id="mNew" placeholder="名前を入力"><button class="btn sm" data-m="add">追加</button></div>`, (root) => {
    const draw = () => {
      $('#mList', root).innerHTML = `<table class="led"><tbody>${S.members.map((m) => `<tr><td><input data-mid="${m.id}" value="${esc(m.name)}"></td><td class="r"><button class="linkbtn" data-m="del" data-id="${m.id}">削除</button></td></tr>`).join('')}</tbody></table>`;
    };
    draw();
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      if (b.dataset.m === 'add') { const v = $('#mNew').value.trim(); if (!v) return; S.members.push({ id: uid(), name: v }); $('#mNew').value = ''; save(); draw(); }
      if (b.dataset.m === 'del') {
        if (S.members.length <= 1) { toast('最低1人は必要です'); return; }
        S.members = S.members.filter((x) => x.id !== b.dataset.id); save(); draw();
      }
    });
    root.addEventListener('input', (e) => { const i = e.target.closest('[data-mid]'); if (!i) return; const m = S.members.find((x) => x.id === i.dataset.mid); if (m) { m.name = i.value; save(); } });
  });
}

/* ---------- 17. 固定費 ---------- */
const CYCLES = { monthly: '毎月', bimonthly: '2か月ごと', quarterly: '3か月ごと', yearly: '年1回' };
function fixedMonthly(f) {
  const a = num(f.amount);
  return f.cycle === 'monthly' ? a : f.cycle === 'bimonthly' ? a / 2 : f.cycle === 'quarterly' ? a / 3 : a / 12;
}
function viewFixed() {
  const act = S.fixed.filter((f) => f.active !== false);
  const perMonth = act.reduce((s, f) => s + fixedMonthly(f), 0);
  const rows = S.fixed.map((f) => `<tr class="clickable" data-act="edit" data-id="${f.id}">
    <td>${esc(f.title)}<div class="tiny">${esc(itemName(f.itemId))}</div></td>
    <td class="c tiny">${CYCLES[f.cycle] || ''}<br>${f.cycle === 'yearly' ? (f.month || 4) + '月' : ''}${f.day ? f.day + '日' : ''}</td>
    <td class="r num">${yen(f.amount)}</td>
    <td class="r num tiny">${yen(fixedMonthly(f))}</td>
    <td class="c">${f.active === false ? '<span class="pill gray">停止</span>' : '<span class="pill in">有効</span>'}</td></tr>`).join('');
  /* 固定費の内訳グラフ */
  const donut = act.map((f) => ({ label: f.title, value: Math.round(fixedMonthly(f) * 12) })).sort((a, b) => b.value - a.value);
  /* 固定費科目の年度推移 */
  const fixedIds = new Set(); S.categories.expense.forEach((g) => g.items.forEach((it) => { if (it.fixed) fixedIds.add(it.id); }));
  const labels = FY_MONTHS.map((m) => m + '月');
  const data = FY_MONTHS.map((m) => { const ym = ymOfFY(CUR_FY, m); return S.tx.filter((t) => t.type === 'out' && t.date.slice(0, 7) === ym && fixedIds.has(t.itemId)).reduce((s, t) => s + num(t.amount), 0); });
  return `
  <section class="form">
    <div class="fh"><h2>固 定 費 の 設 定</h2><span class="slip">定期的に出ていくお金</span></div>
    <div class="hero g-sunset"><div class="big"><div class="lab">月 額 換 算 合 計</div><div class="val neg">${yen(perMonth)}<span style="font-size:16px;font-weight:400">円</span></div><div class="sub">年額 ${yen(perMonth * 12)}円／${act.length}件</div></div></div>
    <div class="tw"><table class="led"><thead><tr><th>名称・科目</th><th class="c">周期</th><th class="r">1回の額</th><th class="r">月額換算</th><th class="c">状態</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty"><b>固定費が未登録です</b>家賃・電気・通信・保険など、毎月決まって出るものを登録すると、自動で記帳できます。</td></tr>'}</tbody></table></div>
    <div class="fb"><div class="row end">
      <button class="btn ghost sm" data-act="post">今月分をまとめて記帳</button>
      <button class="btn sm" data-act="add">＋ 固定費を追加</button>
    </div>
    <p class="note">「まとめて記帳」は、当月に該当する固定費を出納簿へ一括登録します。同じ月に二重登録されないようになっています。</p></div>
  </section>
  ${donut.length ? `<section class="form"><div class="fh"><h2>固 定 費 の 内 訳</h2><span class="slip">年額換算</span></div><div class="fb">${donutChart(donut)}</div></section>` : ''}
  <section class="form"><div class="fh"><h2>固定費科目の実績推移</h2><span class="slip">${CUR_FY}年度・単位千円</span></div>
    <div class="fb">${barChart(labels, [{ name: '固定費の支出実績', data, color: CHART.sub }], { unit: 1000, h: 190 })}</div></section>`;
}
function bind_fixed() {
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'add') editFixed(null);
    if (a === 'edit') editFixed(b.dataset.id);
    if (a === 'post') postFixed();
  });
}
function editFixed(id) {
  const f = S.fixed.find((x) => x.id === id) || { id: null, title: '', itemId: '', amount: 0, cycle: 'monthly', day: 27, month: 4, accountId: S.settings.defaultAccount || '', active: true, posted: {} };
  modal(id ? '固定費の修正' : '固定費の追加', `
    <label class="fld"><span>名称</span><input id="fTitle" value="${esc(f.title)}" placeholder="例：家賃"></label>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>金額（円）</span><input id="fAmount" class="amt" type="number" value="${num(f.amount)}"></label>
      <label class="fld"><span>周期</span><select id="fCycle">${Object.entries(CYCLES).map(([k, v]) => `<option value="${k}"${f.cycle === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>支払月（年1回の場合）</span><select id="fMonth">${FY_MONTHS.map((m) => `<option value="${m}"${num(f.month) === m ? ' selected' : ''}>${m}月</option>`).join('')}</select></label>
      <label class="fld"><span>支払日</span><input id="fDay" type="number" min="1" max="31" value="${num(f.day) || 27}"></label>
    </div>
    <label class="fld" style="margin-top:10px"><span>目（科目）</span><select id="fItem">${itemOptions('expense', f.itemId)}</select></label>
    <label class="fld" style="margin-top:10px"><span>口座</span><select id="fAccount">${accountOptions(f.accountId)}</select></label>
    <label class="chk" style="margin-top:10px"><input type="checkbox" id="fActive" ${f.active === false ? '' : 'checked'}>有効にする</label>
    <div class="row end" style="margin-top:14px">
      ${id ? '<button class="btn danger ghost" data-m="del">削 除</button>' : ''}
      <button class="btn" data-m="ok">保 存</button></div>`, (root) => {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      if (b.dataset.m === 'del') { if (!confirmBox('この固定費を削除します。登録済みの記帳は残ります。')) return; S.fixed = S.fixed.filter((x) => x.id !== id); save(); closeModal(); render(); return; }
      const d = {
        title: $('#fTitle').value.trim(), amount: num($('#fAmount').value), cycle: $('#fCycle').value,
        month: num($('#fMonth').value), day: num($('#fDay').value), itemId: $('#fItem').value,
        accountId: $('#fAccount').value, active: $('#fActive').checked
      };
      if (!d.title) { toast('名称を入力してください'); return; }
      if (!d.itemId) { toast('科目を選んでください'); return; }
      if (id) Object.assign(f, d); else S.fixed.push(Object.assign({ id: uid(), posted: {} }, d));
      save(); closeModal(); render(); toast('保存しました');
    });
  });
}
function dueThisMonth(f, ym) {
  const m = Number(ym.slice(5, 7));
  if (f.cycle === 'monthly') return true;
  if (f.cycle === 'yearly') return m === num(f.month);
  const step = f.cycle === 'bimonthly' ? 2 : 3;
  const base = num(f.month) || 4;
  return ((m - base) % step + step) % step === 0;
}
function postFixed() {
  const ym = today().slice(0, 7);
  let n = 0;
  S.fixed.forEach((f) => {
    if (f.active === false) return;
    if (!dueThisMonth(f, ym)) return;
    f.posted = f.posted || {};
    if (f.posted[ym]) return;
    const day = Math.min(num(f.day) || 27, new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate());
    S.tx.push({
      id: uid(), seq: String(S.seq++).padStart(5, '0'), type: 'out',
      date: ym + '-' + pad2(day), amount: num(f.amount), itemId: f.itemId,
      title: f.title, payee: '', memo: '固定費', accountId: f.accountId, fixedId: f.id
    });
    f.posted[ym] = true; n++;
  });
  save();
  render();
  toast(n ? `${n}件を出納簿に登録しました` : '今月分はすでに登録済みです');
}

/* ---------- 18. 財産目録・減価償却 ---------- */
function viewAssets() {
  const rows = S.assets.map((a) => {
    const d = depreciate(a);
    const rep = replaceDate(a);
    const soon = rep <= new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    return `<tr class="clickable" data-act="edit" data-id="${a.id}">
      <td><b>${esc(a.name)}</b><div class="tiny">${esc(a.maker || '')} ${esc(a.model || '')}</div></td>
      <td class="tiny">${esc((a.acquired || '').replace(/-/g, '.'))}<br>${esc(a.method || '定額法')}・${d.life}年</td>
      <td class="r num">${yen(a.price)}</td>
      <td class="r num">${yen(d.yearly)}</td>
      <td class="r num"><b>${yen(d.book)}</b><div class="tiny">${d.done ? '償却済' : Math.floor(d.monthsUsed / 12) + '年経過'}</div></td>
      <td class="c tiny ${soon ? 'neg' : ''}">${rep.slice(0, 7).replace('-', '.')}</td></tr>`;
  }).join('');
  const price = S.assets.reduce((s, a) => s + num(a.price), 0);
  const book = S.assets.reduce((s, a) => s + depreciate(a).book, 0);
  const yearly = S.assets.reduce((s, a) => s + depreciate(a).yearly, 0);
  return `
  <section class="form">
    <div class="fh"><h2>財　産　目　録</h2><span class="slip">減価償却計算書</span></div>
    <div class="tri" style="border-bottom:1px solid var(--rule)">
      <div><div class="l">取得価額計</div><div class="v">${yen(price)}</div></div>
      <div><div class="l">現在の帳簿価額</div><div class="v">${yen(book)}</div></div>
      <div><div class="l">年間償却費</div><div class="v neg">${yen(yearly)}</div></div>
    </div>
    <div class="tw"><table class="led">
      <thead><tr><th>品名</th><th>取得・方法</th><th class="r">取得価額</th><th class="r">年償却額</th><th class="r">帳簿価額</th><th class="c">買替目安</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty"><b>財産が未登録です</b>車・家電・家具などを登録すると、いまの価値と買い替え時期の目安が出ます。</td></tr>'}</tbody></table></div>
    <div class="fb"><div class="row end"><button class="btn sm" data-act="add">＋ 財産を追加</button></div>
    <p class="note">帳簿価額は税法の考え方にならった目安です（備忘価額1円まで償却）。定率法は200%定率法の簡易計算で、償却額が残存年数の均等額を下回った年から均等償却に切り替えます。</p></div>
  </section>`;
}
function bind_assets() {
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'add') editAsset(null);
    if (b.dataset.act === 'edit') editAsset(b.dataset.id);
  });
}
function editAsset(id) {
  const a = S.assets.find((x) => x.id === id) || { id: null, name: '', maker: '', model: '', place: '', price: 0, acquired: today(), life: 6, method: '定額法', memo: '' };
  modal(id ? '財産の修正' : '財産の追加', `
    <label class="fld"><span>品名</span><input id="sName" value="${esc(a.name)}" placeholder="例：軽自動車"></label>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>メーカー</span><input id="sMaker" value="${esc(a.maker || '')}"></label>
      <label class="fld"><span>型番</span><input id="sModel" value="${esc(a.model || '')}"></label>
    </div>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>取得価額（円）</span><input id="sPrice" class="amt" type="number" value="${num(a.price)}"></label>
      <label class="fld"><span>取得年月日</span><input id="sDate" type="date" value="${a.acquired || today()}"></label>
    </div>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>種類から耐用年数を選ぶ</span><select id="sPreset"><option value="">（手入力）</option>${USEFUL_LIFE.map(([n, y]) => `<option value="${y}">${n}（${y}年）</option>`).join('')}</select></label>
      <label class="fld"><span>耐用年数（年）</span><input id="sLife" type="number" min="1" max="60" value="${num(a.life) || 6}"></label>
    </div>
    <div class="grid g2" style="margin-top:10px">
      <label class="fld"><span>償却方法</span><select id="sMethod"><option${a.method === '定額法' ? ' selected' : ''}>定額法</option><option${a.method === '定率法' ? ' selected' : ''}>定率法</option></select></label>
      <label class="fld"><span>購入場所</span><input id="sPlace" value="${esc(a.place || '')}"></label>
    </div>
    <label class="fld" style="margin-top:10px"><span>備考</span><input id="sMemo" value="${esc(a.memo || '')}"></label>
    <div id="sTable" style="margin-top:12px"></div>
    <div class="row end" style="margin-top:14px">
      ${id ? '<button class="btn danger ghost" data-m="del">削 除</button>' : ''}
      <button class="btn" data-m="ok">保 存</button></div>`, (root) => {
    const preview = () => {
      const tmp = { price: num($('#sPrice').value), acquired: $('#sDate').value, life: num($('#sLife').value), method: $('#sMethod').value };
      const d = depreciate(tmp);
      $('#sTable', root).innerHTML = `<table class="led"><thead><tr><th>年目</th><th class="r">償却額</th><th class="r">期末帳簿価額</th></tr></thead><tbody>
        ${d.rows.map((r) => `<tr><td>${r.y + 1}年目</td><td class="r num">${yen(r.amount)}</td><td class="r num">${yen(r.book)}</td></tr>`).join('')}
        <tr class="sum"><td>現在</td><td class="r num">累計 ${yen(d.accum)}</td><td class="r num">${yen(d.book)}</td></tr></tbody></table>`;
    };
    preview();
    ['#sPrice', '#sDate', '#sLife', '#sMethod'].forEach((s) => $(s, root).addEventListener('input', preview));
    $('#sPreset', root).addEventListener('change', (e) => { if (e.target.value) { $('#sLife').value = e.target.value; preview(); } });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      if (b.dataset.m === 'del') { if (!confirmBox('この財産を削除します。')) return; S.assets = S.assets.filter((x) => x.id !== id); save(); closeModal(); render(); return; }
      const d = {
        name: $('#sName').value.trim(), maker: $('#sMaker').value.trim(), model: $('#sModel').value.trim(),
        price: num($('#sPrice').value), acquired: $('#sDate').value, life: num($('#sLife').value) || 1,
        method: $('#sMethod').value, place: $('#sPlace').value.trim(), memo: $('#sMemo').value.trim()
      };
      if (!d.name) { toast('品名を入力してください'); return; }
      if (id) Object.assign(a, d); else S.assets.push(Object.assign({ id: uid() }, d));
      save(); closeModal(); render(); toast('保存しました');
    });
  });
}

/* ---------- 19. 光熱費 ---------- */
const UTIL_KINDS = ['電気', '水道', 'ガス', 'ガソリン', '灯油'];
function viewUtil() {
  const rows = S.utilities.filter((u) => fyOf(u.ym + '-01') === CUR_FY).sort((a, b) => a.ym.localeCompare(b.ym));
  const series = UTIL_KINDS.map((k, i) => ({
    name: k, color: PAL[i],
    data: FY_MONTHS.map((m) => { const ym = ymOfFY(CUR_FY, m); const r = rows.filter((u) => u.ym === ym && u.kind === k); return r.reduce((s, u) => s + num(u.amount), 0); })
  })).filter((s) => s.data.some((v) => v));
  const elec = rows.filter((u) => u.kind === '電気');
  return `
  <section class="form">
    <div class="fh"><h2>光　熱　費</h2><span class="slip">${CUR_FY}年度</span></div>
    <div class="fb">
      <div class="grid g3">
        <label class="fld"><span>年月</span><input id="uYm" type="month" value="${today().slice(0, 7)}"></label>
        <label class="fld"><span>種別</span><select id="uKind">${UTIL_KINDS.map((k) => `<option>${k}</option>`).join('')}</select></label>
        <label class="fld"><span>金額（円）</span><input id="uAmount" type="number" placeholder="0"></label>
      </div>
      <div class="grid g3" style="margin-top:10px">
        <label class="fld"><span>使用量</span><input id="uUsage" type="number" step="0.1" placeholder="kWh・㎥・ℓ"></label>
        <label class="fld"><span>単価（円）</span><input id="uUnit" type="number" step="0.01" placeholder="燃料のとき"></label>
        <label class="fld"><span>備考</span><input id="uMemo"></label>
      </div>
      <div class="row end" style="margin-top:10px">
        <label class="chk" style="margin-right:auto"><input type="checkbox" id="uPost" checked>出納簿にも支出として記帳する</label>
        <button class="btn sm" data-act="uAdd">登 録</button>
      </div>
      <p class="note">単価を入れて金額を空欄にすると、使用量×単価で金額を計算します（ガソリン・灯油向け）。</p>
    </div>
  </section>
  ${series.length ? `<section class="form"><div class="fh"><h2>月 別 推 移</h2><span class="slip">単位：円</span></div><div class="fb">${lineChart(FY_MONTHS.map((m) => m + '月'), series, { h: 220 })}</div></section>` : ''}
  ${elec.length ? `<section class="form"><div class="fh"><h2>電気 使用量と料金</h2></div><div class="fb">${barChart(elec.map((u) => u.ym.slice(5) + '月'), [{ name: '使用量(kWh)', data: elec.map((u) => num(u.usage)), color: '#2a7fa8' }], { h: 170 })}</div></section>` : ''}
  <section class="form">
    <div class="fh"><h2>入 力 実 績</h2><span class="slip">${rows.length}件</span></div>
    <div class="tw"><table class="led"><thead><tr><th>年月</th><th>種別</th><th class="r">使用量</th><th class="r">単価</th><th class="r">金額</th><th></th></tr></thead>
    <tbody>${rows.map((u) => `<tr><td class="num">${u.ym.replace('-', '.')}</td><td>${esc(u.kind)}</td>
      <td class="r num">${u.usage ? num(u.usage).toLocaleString() : ''}</td><td class="r num">${u.unit ? num(u.unit) : ''}</td>
      <td class="r num">${yen(u.amount)}</td><td class="r"><button class="linkbtn" data-act="uDel" data-id="${u.id}">削除</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">まだ入力がありません</td></tr>'}
      ${rows.length ? `<tr class="sum"><td colspan="4">年度計</td><td class="r num">${yen(rows.reduce((s, u) => s + num(u.amount), 0))}</td><td></td></tr>` : ''}
    </tbody></table></div>
  </section>`;
}
function bind_util() {
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'uDel') { S.utilities = S.utilities.filter((x) => x.id !== b.dataset.id); save(); render(); return; }
    if (b.dataset.act !== 'uAdd') return;
    const usage = num($('#uUsage').value), unit = num($('#uUnit').value);
    let amount = num($('#uAmount').value);
    if (!amount && usage && unit) amount = Math.round(usage * unit);
    const kind = $('#uKind').value, ym = $('#uYm').value;
    if (!ym) { toast('年月を入力してください'); return; }
    if (!amount) { toast('金額または使用量と単価を入力してください'); return; }
    S.utilities.push({ id: uid(), ym, kind, usage, unit, amount, memo: $('#uMemo').value });
    if ($('#uPost').checked) {
      const key = { '電気': '電気', '水道': '水道', 'ガス': 'ガス', 'ガソリン': '交通', '灯油': 'ガス' }[kind];
      let itemId = '';
      for (const g of S.categories.expense) for (const it of g.items) if (it.name.includes(key)) { itemId = it.id; break; }
      S.tx.push({ id: uid(), seq: String(S.seq++).padStart(5, '0'), type: 'out', date: ym + '-25', amount, itemId, title: kind + '料金', payee: '', memo: '光熱費', accountId: S.settings.defaultAccount || '' });
    }
    save(); render(); toast('登録しました');
  });
}
/* ---------- 20. 決算書（歳入・歳出） ---------- */
function settleRows(type, fy) {
  const list = txOfFY(fy).filter((t) => t.type === (type === 'income' ? 'in' : 'out'));
  const spent = {};
  list.forEach((t) => { spent[t.itemId] = (spent[t.itemId] || 0) + num(t.amount); });
  const out = [];
  let tot = { genzai: 0, b0: 0, done: 0 };
  for (const g of allGroups(type)) {
    const gr = { group: true, name: g.name, genzai: 0, b0: 0, done: 0, items: [] };
    for (const it of g.items) {
      const b = budgetOf(fy, it.id), d = spent[it.id] || 0;
      gr.items.push({ id: it.id, name: it.name, b0: b.b0, hosei: b.hosei, genzai: b.genzai, done: d });
      gr.genzai += b.genzai; gr.b0 += b.b0; gr.done += d;
    }
    tot.genzai += gr.genzai; tot.b0 += gr.b0; tot.done += gr.done;
    out.push(gr);
  }
  return { groups: out, total: tot };
}
function viewSettle() {
  const inc = settleRows('income', CUR_FY), exp = settleRows('expense', CUR_FY);
  const t = (r, type) => `
    <div class="tw"><table class="led">
      <thead><tr><th>項／目</th><th class="r">予算現額</th><th class="r">${type === 'income' ? '収入済額' : '支出済額'}</th><th class="r">${type === 'income' ? '比較増減' : '不用額'}</th><th class="r">執行率</th></tr></thead>
      <tbody>
      ${r.groups.map((g) => `
        <tr class="grp"><td>${esc(g.name)}</td><td class="r num">${yen(g.genzai)}</td><td class="r num">${yen(g.done)}</td>
          <td class="r num ${type === 'income' ? (g.done - g.genzai < 0 ? 'neg' : 'pos') : ''}">${g.genzai ? yen(type === 'income' ? g.done - g.genzai : g.genzai - g.done) : '—'}</td>
          <td class="r num tiny">${g.genzai ? (g.done / g.genzai * 100).toFixed(1) + '%' : '—'}</td></tr>
        ${g.items.map((i) => `<tr><td style="padding-left:22px">${esc(i.name)}</td>
          <td class="r num tiny">${i.genzai ? yen(i.genzai) : '—'}</td>
          <td class="r num">${yen(i.done)}</td>
          <td class="r num tiny">${i.genzai ? yen(type === 'income' ? i.done - i.genzai : i.genzai - i.done) : '—'}</td>
          <td class="r tiny">${i.genzai ? `<div class="bar" style="min-width:52px"><i style="width:${Math.min(100, i.done / i.genzai * 100).toFixed(0)}%;background:${i.done > i.genzai ? 'linear-gradient(90deg,#ff9ab6,#ff5c8a)' : 'linear-gradient(90deg,#8ba0ff,#5b6cff)'}"></i></div>${(i.done / i.genzai * 100).toFixed(0)}%` : '—'}</td></tr>`).join('')}
      `).join('')}
      <tr class="sum"><td>合　　計</td><td class="r num">${yen(r.total.genzai)}</td><td class="r num">${yen(r.total.done)}</td>
        <td class="r num">${r.total.genzai ? yen(type === 'income' ? r.total.done - r.total.genzai : r.total.genzai - r.total.done) : '—'}</td>
        <td class="r num tiny">${r.total.genzai ? (r.total.done / r.total.genzai * 100).toFixed(1) + '%' : '—'}</td></tr>
      </tbody></table></div>`;
  const sa = inc.total.done - exp.total.done;
  return `
  <section class="form">
    <div class="fh"><h2>歳入歳出決算書</h2><span class="slip">${fyLabel(CUR_FY)}</span></div>
    <div class="hero g-indigo"><div class="tri">
      <div><div class="l">収入済額</div><div class="v pos">${yen(inc.total.done)}</div></div>
      <div><div class="l">支出済額</div><div class="v neg">${yen(exp.total.done)}</div></div>
      <div><div class="l">差引（翌年度繰越）</div><div class="v ${sa < 0 ? 'neg' : ''}">${yen(sa)}</div></div>
    </div></div>
    <div class="fb"><div class="row end">
      <button class="btn ghost sm" data-act="budget">予算を編成する</button>
      <button class="btn ghost sm" data-act="carry">翌年度へ繰越金を計上</button>
      <button class="btn ghost sm noprint" data-act="print">印刷・PDF保存</button>
    </div></div>
  </section>
  <section class="form"><div class="fh"><h2>収 入 の 部</h2><span class="slip">単位：円</span></div>${t(inc, 'income')}</section>
  <section class="form"><div class="fh"><h2>支 出 の 部</h2><span class="slip">単位：円</span></div>${t(exp, 'expense')}</section>`;
}
function bind_settle() {
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'budget') go('budget');
    if (b.dataset.act === 'print') window.print();
    if (b.dataset.act === 'carry') carryOver();
  });
}
function carryOver() {
  const list = txOfFY(CUR_FY);
  const sa = totalIn(list) - totalOut(list);
  const nextFY = CUR_FY + 1;
  let itemId = '';
  for (const g of S.categories.income) for (const it of g.items) if (it.name.includes('繰越')) itemId = it.id;
  if (!itemId) { toast('収入科目に「繰越金」がありません'); return; }
  const dt = nextFY + '-04-01';
  if (S.tx.some((t) => t.date === dt && t.itemId === itemId)) { if (!confirmBox(`${nextFY}年度の繰越金はすでに計上されています。もう一度計上しますか。`)) return; }
  if (!confirmBox(`${CUR_FY}年度の差引 ${yenS(sa)} を ${nextFY}年度の繰越金として計上します。よろしいですか。`)) return;
  S.tx.push({ id: uid(), seq: String(S.seq++).padStart(5, '0'), type: 'in', date: dt, amount: sa, itemId, title: '前年度　繰越金', payee: '', memo: `${CUR_FY}年度からの繰越`, accountId: '', excludeSim: true });
  save(); CUR_FY = nextFY; render(); toast('繰越金を計上しました');
}

/* ---------- 21. 予算編成 ---------- */
function viewBudget() {
  const prev = CUR_FY - 1;
  const prevList = txOfFY(prev);
  const prevSpent = {};
  prevList.forEach((t) => { prevSpent[t.itemId] = (prevSpent[t.itemId] || 0) + num(t.amount); });
  const block = (type) => allGroups(type).map((g) => {
    const items = g.items.map((it) => {
      const b = budgetOf(CUR_FY, it.id);
      const pb = budgetOf(prev, it.id);
      return `<tr>
        <td style="padding-left:18px">${esc(it.name)}</td>
        <td class="r"><input class="bin" data-item="${it.id}" data-key="b0" type="number" value="${b.b0 || ''}" placeholder="0" style="max-width:120px"></td>
        <td class="r"><input class="bin" data-item="${it.id}" data-key="hosei" type="number" value="${b.hosei || ''}" placeholder="0" style="max-width:100px"></td>
        <td class="r num"><b>${yen(b.genzai)}</b></td>
        <td class="r num tiny">${yen(pb.b0)}</td>
        <td class="r num tiny">${yen(prevSpent[it.id] || 0)}</td>
        <td class="c"><button class="linkbtn" data-copy="${it.id}">実績を反映</button></td></tr>`;
    }).join('');
    const sum = g.items.reduce((s, it) => s + budgetOf(CUR_FY, it.id).genzai, 0);
    return `<tr class="grp"><td>${esc(g.name)}</td><td colspan="2"></td><td class="r num">${yen(sum)}</td><td colspan="3"></td></tr>${items}`;
  }).join('');
  const totIn = allGroups('income').reduce((s, g) => s + g.items.reduce((a, it) => a + budgetOf(CUR_FY, it.id).genzai, 0), 0);
  const totOut = allGroups('expense').reduce((s, g) => s + g.items.reduce((a, it) => a + budgetOf(CUR_FY, it.id).genzai, 0), 0);
  return `
  <section class="form">
    <div class="fh"><h2>予 算 算 定 資 料</h2><span class="slip">${fyLabel(CUR_FY)}</span></div>
    <div class="tri" style="border-bottom:1px solid var(--rule)">
      <div><div class="l">収入予算額</div><div class="v pos">${yen(totIn)}</div></div>
      <div><div class="l">支出予算額</div><div class="v neg">${yen(totOut)}</div></div>
      <div><div class="l">差引残額</div><div class="v ${totIn - totOut < 0 ? 'neg' : ''}">${yen(totIn - totOut)}</div></div>
    </div>
    <div class="fb"><div class="row end">
      <button class="btn ghost sm" data-act="fromPrev">前年度の実績をすべて反映</button>
      <button class="btn ghost sm" data-act="fromFixed">固定費から自動計上</button>
    </div>
    <p class="note">当初予算額と補正額を入れると、決算書に予算現額・執行率・不用額が表示されます。</p></div>
  </section>
  <section class="form"><div class="fh"><h2>収 入 の 部</h2><span class="slip">単位：円</span></div>
    <div class="tw"><table class="led"><thead><tr><th>項／目</th><th class="r">当初予算額</th><th class="r">補正額</th><th class="r">予算現額</th><th class="r">前年度当初</th><th class="r">前年度実績</th><th></th></tr></thead><tbody>${block('income')}</tbody></table></div></section>
  <section class="form"><div class="fh"><h2>支 出 の 部</h2><span class="slip">単位：円</span></div>
    <div class="tw"><table class="led"><thead><tr><th>項／目</th><th class="r">当初予算額</th><th class="r">補正額</th><th class="r">予算現額</th><th class="r">前年度当初</th><th class="r">前年度実績</th><th></th></tr></thead><tbody>${block('expense')}</tbody></table></div></section>`;
}
function bind_budget() {
  const prevSpent = {};
  txOfFY(CUR_FY - 1).forEach((t) => { prevSpent[t.itemId] = (prevSpent[t.itemId] || 0) + num(t.amount); });
  $('#view').addEventListener('change', (e) => {
    const i = e.target.closest('.bin'); if (!i) return;
    setBudget(CUR_FY, i.dataset.item, i.dataset.key, i.value);
    render();
  });
  $('#view').addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { setBudget(CUR_FY, c.dataset.copy, 'b0', Math.round((prevSpent[c.dataset.copy] || 0) / 1000) * 1000); render(); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'fromPrev') {
      if (!confirmBox(`${CUR_FY - 1}年度の実績（千円単位に丸め）を当初予算額に一括で反映します。よろしいですか。`)) return;
      Object.keys(prevSpent).forEach((k) => setBudget(CUR_FY, k, 'b0', Math.round(prevSpent[k] / 1000) * 1000));
      render(); toast('反映しました');
    }
    if (b.dataset.act === 'fromFixed') {
      const per = {};
      S.fixed.filter((f) => f.active !== false).forEach((f) => { per[f.itemId] = (per[f.itemId] || 0) + fixedMonthly(f) * 12; });
      Object.keys(per).forEach((k) => setBudget(CUR_FY, k, 'b0', Math.round(per[k] / 1000) * 1000));
      render(); toast('固定費から年額を計上しました');
    }
  });
}

/* ---------- 22. 前年度比較 ---------- */
function viewCompare() {
  const a = CUR_FY, b = CUR_FY - 1;
  const sa = {}, sb = {};
  txOfFY(a).forEach((t) => { sa[t.itemId] = (sa[t.itemId] || 0) + num(t.amount); });
  txOfFY(b).forEach((t) => { sb[t.itemId] = (sb[t.itemId] || 0) + num(t.amount); });
  const table = (type) => {
    let ta = 0, tb = 0;
    const body = allGroups(type).map((g) => {
      let ga = 0, gb = 0;
      const rows = g.items.map((it) => {
        const va = sa[it.id] || 0, vb = sb[it.id] || 0; ga += va; gb += vb;
        const diff = va - vb, rate = vb ? (diff / vb * 100) : null;
        return `<tr><td style="padding-left:18px">${esc(it.name)}</td>
          <td class="r num">${va ? yen(va) : '—'}</td><td class="r num tiny">${vb ? yen(vb) : '—'}</td>
          <td class="r num ${diff > 0 ? 'neg' : diff < 0 ? 'pos' : ''}">${diff ? yen(diff) : '—'}</td>
          <td class="r tiny ${diff > 0 ? 'neg' : diff < 0 ? 'pos' : ''}">${rate == null ? '—' : (rate > 0 ? '+' : '') + rate.toFixed(1) + '%'}</td>
          <td>${cmpBar(va, vb)}</td></tr>`;
      }).join('');
      ta += ga; tb += gb;
      const gd = ga - gb;
      return `<tr class="grp"><td>${esc(g.name)}</td><td class="r num">${yen(ga)}</td><td class="r num">${yen(gb)}</td>
        <td class="r num ${gd > 0 ? 'neg' : gd < 0 ? 'pos' : ''}">${yen(gd)}</td>
        <td class="r tiny">${gb ? ((gd / gb * 100 > 0 ? '+' : '') + (gd / gb * 100).toFixed(1) + '%') : '—'}</td><td></td></tr>${rows}`;
    }).join('');
    const td = ta - tb;
    return `<div class="tw"><table class="led">
      <thead><tr><th>項／目</th><th class="r">${a}年度</th><th class="r">${b}年度</th><th class="r">増減</th><th class="r">増減率</th><th style="width:96px">対比</th></tr></thead>
      <tbody>${body}<tr class="sum"><td>合　　計</td><td class="r num">${yen(ta)}</td><td class="r num">${yen(tb)}</td>
        <td class="r num ${td > 0 ? 'neg' : 'pos'}">${yen(td)}</td><td class="r tiny">${tb ? ((td / tb * 100 > 0 ? '+' : '') + (td / tb * 100).toFixed(1) + '%') : '—'}</td><td></td></tr></tbody></table></div>`;
  };
  /* 月別の対比グラフ */
  const labels = FY_MONTHS.map((m) => m + '月');
  const da = FY_MONTHS.map((m) => totalOut(txOfFY(a).filter((t) => t.date.slice(0, 7) === ymOfFY(a, m))));
  const db = FY_MONTHS.map((m) => totalOut(txOfFY(b).filter((t) => t.date.slice(0, 7) === ymOfFY(b, m))));
  return `
  <section class="form">
    <div class="fh"><h2>前年度同科目比較表</h2><span class="slip">${a}年度 対 ${b}年度</span></div>
    <div class="fb">${barChart(labels, [{ name: a + '年度支出', data: da, color: CHART.main }, { name: b + '年度支出', data: db, color: CHART.prev }], { unit: 1000, h: 210 })}</div>
  </section>
  <section class="form"><div class="fh"><h2>支 出 の 比 較</h2><span class="slip">増加は朱書き</span></div>${table('expense')}</section>
  <section class="form"><div class="fh"><h2>収 入 の 比 較</h2></div>${table('income')}</section>`;
}
function cmpBar(a, b) {
  const max = Math.max(a, b, 1);
  return `<div class="bar" style="margin-bottom:3px"><i style="width:${(a / max * 100).toFixed(0)}%;background:linear-gradient(90deg,#8ba0ff,#5b6cff)"></i></div>
          <div class="bar"><i style="width:${(b / max * 100).toFixed(0)}%;background:#cfd6f0"></i></div>`;
}

/* ---------- 23. 将来設計シミュレーション ---------- */
function defaultSim() {
  const av = recentAvg(12);
  return {
    start: Math.round(balanceAll()),
    income: Math.round(av.income) || 0,
    expense: Math.round(av.expense) || 0,
    bonus: 0, bonusMonths: '6,12',
    years: 20, inflation: 1.5, interest: 0.1,
    target: 0, targetYears: 10,
    events: []
  };
}
function viewSim() {
  const p = S.sim || defaultSim();
  const r = runSim(p);
  const labels = r.points.map((x) => x.label);
  const shortAt = r.points.find((x) => x.bal < 0);
  return `
  <section class="form">
    <div class="fh"><h2>将 来 シ ミ ュ レ ー シ ョ ン</h2><span class="slip">${p.years}年先まで</span></div>
    <div class="hero g-violet">
      <div class="big"><div class="lab">${p.years}年後の見込み残高</div>
        <div class="val ${r.end < 0 ? 'neg' : ''}">${yen(r.end)}<span style="font-size:16px;font-weight:400">円</span></div>
        <div class="sub">現在 ${yen(p.start)}円から ${r.end - p.start >= 0 ? '＋' : ''}${yen(r.end - p.start)}円</div></div>
    </div>
    <div class="fb">
      ${shortAt ? `<div class="err">このままでは <b>${shortAt.label}</b> ごろに残高が不足します（${yenS(shortAt.bal)}）。支出の見直しか収入の上積みが必要です。</div>` : '<div class="ok">試算の範囲では、残高が不足する時期はありません。</div>'}
      ${lineChart(labels, [{ name: '見込み残高', data: r.points.map((x) => x.bal), color: CHART.sub, area: true }], { unit: 10000, h: 230 })}
      <p class="note">縦軸の単位は万円です。</p>
    </div>
  </section>

  <section class="form">
    <div class="fh"><h2>試 算 の 前 提</h2><span class="slip">変えるとすぐ再計算します</span></div>
    <div class="fb">
      <div class="grid g2">
        <label class="fld"><span>現在の残高（円）</span><input class="si" id="pStart" type="number" value="${p.start}"></label>
        <label class="fld"><span>試算する年数</span><input class="si" id="pYears" type="number" min="1" max="60" value="${p.years}"></label>
      </div>
      <div class="grid g2" style="margin-top:10px">
        <label class="fld"><span>月の収入（円）</span><input class="si" id="pIncome" type="number" value="${p.income}"></label>
        <label class="fld"><span>月の支出（円）</span><input class="si" id="pExpense" type="number" value="${p.expense}"></label>
      </div>
      <div class="grid g2" style="margin-top:10px">
        <label class="fld"><span>賞与など（1回あたり円）</span><input class="si" id="pBonus" type="number" value="${p.bonus}"></label>
        <label class="fld"><span>賞与の月（カンマ区切り）</span><input class="si" id="pBonusM" value="${esc(p.bonusMonths)}"></label>
      </div>
      <div class="grid g2" style="margin-top:10px">
        <label class="fld"><span>支出の年上昇率（％）</span><input class="si" id="pInf" type="number" step="0.1" value="${p.inflation}"></label>
        <label class="fld"><span>預金の年利率（％）</span><input class="si" id="pInt" type="number" step="0.01" value="${p.interest}"></label>
      </div>
      <div class="row end" style="margin-top:10px">
        <button class="btn ghost sm" data-act="reload">直近12か月の実績を取り込む</button>
      </div>
    </div>
  </section>

  <section class="form">
    <div class="fh"><h2>目 標 か ら の 逆 算</h2><span class="slip">必要額の算定</span></div>
    <div class="fb">
      <div class="grid g2">
        <label class="fld"><span>目標額（円）</span><input class="si" id="pTarget" type="number" value="${p.target}"></label>
        <label class="fld"><span>何年後までに</span><input class="si" id="pTY" type="number" min="1" max="60" value="${p.targetYears}"></label>
      </div>
      ${p.target ? renderTarget(p, r) : '<p class="note">目標額を入れると、毎月いくら積み立てればよいか、いまの収支で足りるかを表示します。</p>'}
    </div>
  </section>

  <section class="form">
    <div class="fh"><h2>予 定 し て い る 大 き な 支 出</h2><span class="slip">${p.events.length}件</span></div>
    <div class="tw"><table class="led"><thead><tr><th>時期</th><th>内容</th><th class="r">金額</th><th></th></tr></thead>
      <tbody>${p.events.length ? p.events.slice().sort((a, b) => a.ym.localeCompare(b.ym)).map((ev) => `<tr>
        <td class="num">${ev.ym.replace('-', '.')}</td><td>${esc(ev.name)}</td>
        <td class="r num ${ev.amount < 0 ? 'pos' : 'neg'}">${yen(ev.amount)}</td>
        <td class="r"><button class="linkbtn" data-act="evDel" data-id="${ev.id}">削除</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">車の買替、進学、住宅の修繕など、まとまった出費を入れておくと精度が上がります</td></tr>'}</tbody></table></div>
    <div class="fb">
      <div class="grid g3">
        <label class="fld"><span>時期</span><input id="evYm" type="month" value="${new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 7)}"></label>
        <label class="fld"><span>内容</span><input id="evName" placeholder="例：車の買替"></label>
        <label class="fld"><span>金額（円）</span><input id="evAmount" type="number" placeholder="1500000"></label>
      </div>
      <div class="row end" style="margin-top:10px">
        <button class="btn ghost sm" data-act="evFromAssets">財産目録から買替予定を取り込む</button>
        <button class="btn sm" data-act="evAdd">追 加</button>
      </div>
      <p class="note">収入の予定（退職金など）を入れるときは金額にマイナスを付けてください。</p>
    </div>
  </section>`;
}
function renderTarget(p, r) {
  const months = p.targetYears * 12;
  const need = p.target - p.start;
  const perMonth = need / months;
  const at = r.points.find((x) => x.i === months);
  const now = at ? at.bal : null;
  const gap = now == null ? null : p.target - now;
  return `<table class="led"><tbody>
    <tr><td>目標額</td><td class="r num">${yenS(p.target)}</td></tr>
    <tr><td>現在残高との差</td><td class="r num">${yenS(need)}</td></tr>
    <tr><td>単純に積み立てる場合の月額</td><td class="r num"><b>${yenS(Math.max(0, Math.ceil(perMonth)))}</b></td></tr>
    <tr><td>いまの収支で${p.targetYears}年後に見込まれる残高</td><td class="r num">${now == null ? '—' : yenS(now)}</td></tr>
    <tr class="sum"><td>${gap == null ? '' : gap <= 0 ? '達成の見込み（余裕額）' : '不足する額'}</td>
      <td class="r num ${gap > 0 ? 'neg' : 'pos'}">${gap == null ? '—' : yenS(Math.abs(gap))}</td></tr>
    ${gap > 0 ? `<tr><td>不足を埋めるために必要な毎月の上積み</td><td class="r num neg"><b>${yenS(Math.ceil(gap / months))}</b></td></tr>` : ''}
  </tbody></table>`;
}
function runSim(p) {
  const months = Math.max(1, num(p.years)) * 12;
  const bmonths = String(p.bonusMonths || '').split(/[,、\s]+/).map((x) => Number(x)).filter((x) => x >= 1 && x <= 12);
  const infM = Math.pow(1 + num(p.inflation) / 100, 1 / 12);
  const intM = num(p.interest) / 100 / 12;
  let bal = num(p.start), exp = num(p.expense);
  const now = new Date();
  const points = [{ i: 0, label: now.getFullYear() + '.' + (now.getMonth() + 1), bal: Math.round(bal) }];
  const evMap = {};
  (p.events || []).forEach((e) => { evMap[e.ym] = (evMap[e.ym] || 0) + num(e.amount); });
  for (let i = 1; i <= months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const ym = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    bal += num(p.income) - exp;
    if (bmonths.includes(d.getMonth() + 1)) bal += num(p.bonus);
    if (evMap[ym]) bal -= evMap[ym];
    bal += bal > 0 ? bal * intM : 0;
    exp *= infM;
    if (i % 3 === 0 || i === months) points.push({ i, label: d.getFullYear() + '.' + (d.getMonth() + 1), bal: Math.round(bal) });
  }
  return { end: Math.round(bal), points };
}
function bind_sim() {
  if (!S.sim) { S.sim = defaultSim(); save(); }
  const p = S.sim;
  const readAll = () => {
    p.start = num($('#pStart').value); p.years = Math.min(60, Math.max(1, num($('#pYears').value)));
    p.income = num($('#pIncome').value); p.expense = num($('#pExpense').value);
    p.bonus = num($('#pBonus').value); p.bonusMonths = $('#pBonusM').value;
    p.inflation = Number($('#pInf').value) || 0; p.interest = Number($('#pInt').value) || 0;
    p.target = num($('#pTarget').value); p.targetYears = Math.max(1, num($('#pTY').value));
    save(); render();
  };
  let t;
  $$('.si').forEach((i) => i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(readAll, 500); }));
  $('#view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'reload') { const av = recentAvg(12); p.income = Math.round(av.income); p.expense = Math.round(av.expense); p.start = Math.round(balanceAll()); save(); render(); toast('実績を取り込みました'); }
    if (a === 'evAdd') {
      const ym = $('#evYm').value, name = $('#evName').value.trim(), amount = num($('#evAmount').value);
      if (!ym || !amount) { toast('時期と金額を入力してください'); return; }
      p.events.push({ id: uid(), ym, name: name || '予定支出', amount }); save(); render();
    }
    if (a === 'evDel') { p.events = p.events.filter((x) => x.id !== b.dataset.id); save(); render(); }
    if (a === 'evFromAssets') {
      let n = 0;
      S.assets.forEach((as) => {
        const ym = replaceDate(as).slice(0, 7);
        if (ym < today().slice(0, 7)) return;
        if (p.events.some((e) => e.ym === ym && e.name === as.name + 'の買替')) return;
        p.events.push({ id: uid(), ym, name: as.name + 'の買替', amount: num(as.price) }); n++;
      });
      save(); render(); toast(n ? `${n}件を取り込みました` : '取り込む予定はありませんでした');
    }
  });
}
/* =========================================================
   Excel(.xlsx) の取り込み
   xlsx は ZIP + XML なので、ブラウザ標準の機能だけで解析します。
   （外部ライブラリなし＝オフラインのまま動作）
   ========================================================= */

/* ---------- ZIP を展開する ---------- */
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Excelファイルとして読めませんでした');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder('utf-8');
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nLen = dv.getUint16(off + 28, true), eLen = dv.getUint16(off + 30, true), cLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nLen));
    const lnLen = dv.getUint16(lho + 26, true), leLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnLen + leLen;
    files[name] = { method, data: u8.subarray(start, start + csize) };
    off += 46 + nLen + eLen + cLen;
  }
  return files;
}
async function inflate(entry) {
  if (!entry) return null;
  if (entry.method === 0) return entry.data;
  if (typeof DecompressionStream === 'undefined') throw new Error('このブラウザではExcelの解凍ができません。CSVでの取り込みをご利用ください');
  const st = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
const xmlOf = async (files, path) => {
  const raw = await inflate(files[path]);
  if (!raw) return null;
  return new DOMParser().parseFromString(new TextDecoder('utf-8').decode(raw), 'application/xml');
};

/* ---------- ワークブックを2次元配列にする ---------- */
function colOfRef(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}
async function readXlsx(file) {
  const files = await unzip(await file.arrayBuffer());
  /* 共有文字列 */
  const ssDoc = await xmlOf(files, 'xl/sharedStrings.xml');
  const shared = [];
  if (ssDoc) {
    for (const si of ssDoc.getElementsByTagName('si')) {
      let s = '';
      for (const t of si.getElementsByTagName('t')) s += t.textContent;
      shared.push(s);
    }
  }
  /* シート一覧（表示順・非表示も含む） */
  const wbDoc = await xmlOf(files, 'xl/workbook.xml');
  if (!wbDoc) throw new Error('ワークブックが見つかりません');
  const relDoc = await xmlOf(files, 'xl/_rels/workbook.xml.rels');
  const rel = {};
  if (relDoc) for (const r of relDoc.getElementsByTagName('Relationship')) rel[r.getAttribute('Id')] = r.getAttribute('Target');
  const sheets = [];
  const nodes = wbDoc.getElementsByTagName('sheet');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const name = el.getAttribute('name');
    const rid = el.getAttribute('r:id') || el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = rel[rid] || ('worksheets/sheet' + (i + 1) + '.xml');
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const doc = await xmlOf(files, 'xl/' + target);
    sheets.push({ name, rows: doc ? sheetRows(doc, shared) : [] });
  }
  return sheets;
}
function sheetRows(doc, shared) {
  const out = [];
  for (const row of doc.getElementsByTagName('row')) {
    const r = (Number(row.getAttribute('r')) || out.length + 1) - 1;
    const arr = out[r] || (out[r] = []);
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r') || '';
      const ci = ref ? colOfRef(ref) : arr.length;
      const t = c.getAttribute('t');
      let v = null;
      if (t === 'inlineStr') {
        v = '';
        for (const tt of c.getElementsByTagName('t')) v += tt.textContent;
      } else {
        const vn = c.getElementsByTagName('v')[0];
        if (vn) {
          const raw = vn.textContent;
          if (t === 's') v = shared[Number(raw)] != null ? shared[Number(raw)] : '';
          else if (t === 'e') v = null;
          else if (t === 'b') v = raw === '1';
          else if (t === 'str') v = raw;
          else { const n = Number(raw); v = isNaN(n) ? raw : n; }
        }
      }
      arr[ci] = v;
    }
  }
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
  return out;
}

/* ---------- シートの種類を見分ける ---------- */
const cellS = (r, i) => (r && r[i] != null ? String(r[i]).replace(/[\s　]/g, '') : '');
function findHeader(rows, keys, limit) {
  for (let i = 0; i < Math.min(limit || 12, rows.length); i++) {
    const line = (rows[i] || []).map((c) => String(c == null ? '' : c).replace(/[\s　]/g, '')).join('|');
    if (keys.every((k) => line.includes(k))) return i;
  }
  return -1;
}
function analyzeSheet(sh) {
  const rows = sh.rows, name = sh.name.replace(/[\s　]/g, '');
  const isTemplate = /template|ﾃﾝﾌﾟﾚ|テンプレ|雛形|ひな形/i.test(name);
  /* 出納簿（年・月・日の3列） */
  let h = findHeader(rows, ['区分', '項', '目', '収入金額']);
  if (h >= 0) {
    const n = parseLedgerSheet(rows, h).length;
    return { type: n && !isTemplate ? 'ledger' : 'skip', header: h, count: n };
  }
  /* フォームの回答 */
  h = findHeader(rows, ['タイムスタンプ']);
  if (h >= 0) { const n = parseFormSheet(rows, h).length; return { type: n ? 'form' : 'skip', header: h, count: n }; }
  /* 財産目録 */
  h = findHeader(rows, ['メーカー', '取得年月日']);
  if (h < 0) h = findHeader(rows, ['商品名', '値段']);
  if (h >= 0) { const n = parseAssetSheet(rows, h).length; return { type: n && !isTemplate ? 'assets' : 'skip', header: h, count: n }; }
  /* 光熱費 */
  if (/光熱費|電気|水道|燃料/.test(name) || findHeader(rows, ['月分'], 8) >= 0) {
    const n = parseUtilSheet(rows).length;
    if (n) return { type: 'util', header: 0, count: n };
  }
  /* 科目コード説明 */
  if (/科目コード説明/.test(name)) return { type: 'catdesc', header: 0, count: countFrom(rows, 0, (r) => r[0] != null && r[1] != null) };
  return { type: 'skip', header: 0, count: countFrom(rows, 0, (r) => r.some((c) => c != null && c !== '')) };
}
function countFrom(rows, from, ok) {
  let n = 0;
  for (let i = from; i < rows.length; i++) if (ok(rows[i] || [])) n++;
  return n;
}

/* ---------- 各種取り込み ---------- */
/* 出納簿：年・月・日が別列。年が空の行は直前の年を引き継ぐ */
function parseLedgerSheet(rows, h) {
  const head = (rows[h] || []).map((c) => String(c == null ? '' : c).replace(/[\s　]/g, ''));
  const col = (...names) => { for (const n of names) { const i = head.findIndex((x) => x.includes(n)); if (i >= 0) return i; } return -1; };
  const C = {
    y: col('年'), m: col('月'), d: col('日'), ymd: col('年月日', '日付', '請求年月日'),
    k: col('区分'), grp: col('項'), item: col('目'),
    title: col('収入・支出件名', '収支件名', '件名'), payee: col('収入・支出先', '収支先', '相手先'),
    inA: col('収入金額'), outA: col('支払金額', '支出金額'), amt: col('金額'), memo: col('摘要', '備考')
  };
  /* 表題から年度を拾っておく（年の欄が空の行の手がかり） */
  let baseFY = null;
  for (let i = 0; i <= h && i < rows.length; i++) {
    for (const c of rows[i] || []) {
      const t = String(c == null ? '' : c);
      let mm = t.match(/(20\d\d)\s*年度/); if (mm) { baseFY = Number(mm[1]); break; }
      mm = t.match(/令和\s*(\d+)\s*年度/); if (mm) { baseFY = 2018 + Number(mm[1]); break; }
    }
    if (baseFY) break;
  }
  const out = []; let lastY = null, lastM = null;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    let date = null;
    if (C.ymd >= 0 && r[C.ymd] != null && r[C.ymd] !== '') date = parseDateLoose(r[C.ymd]);
    if (!date && C.m >= 0 && C.d >= 0) {
      let y = num(r[C.y]);
      const m = num(r[C.m]), d = num(r[C.d]);
      if (!y && m) {
        /* 年が空欄のとき：月が戻ったら年度が変わったとみなす */
        if (lastY) y = (lastM && m < lastM) ? lastY + 1 : lastY;
        else if (baseFY) y = m >= FY_START ? baseFY : baseFY + 1;
      }
      if (y && m && d) date = `${y}-${pad2(m)}-${pad2(d)}`;
    }
    if (!date) continue;
    lastY = Number(date.slice(0, 4)); lastM = Number(date.slice(5, 7));
    const vin = C.inA >= 0 ? num(r[C.inA]) : 0, vout = C.outA >= 0 ? num(r[C.outA]) : 0;
    let type = null, amount = 0;
    if (vin) { type = 'in'; amount = vin; }
    else if (vout) { type = 'out'; amount = vout; }
    else if (C.amt >= 0 && num(r[C.amt])) {
      amount = Math.abs(num(r[C.amt]));
      const k = C.k >= 0 ? String(r[C.k] || '') : '';
      type = /入|収/.test(k) ? 'in' : 'out';
    }
    if (!amount) continue;
    out.push({
      date, type, amount,
      groupName: C.grp >= 0 ? String(r[C.grp] || '').trim() : '',
      itemName: C.item >= 0 ? String(r[C.item] || '').trim() : '',
      title: C.title >= 0 ? String(r[C.title] || '').trim() : '',
      payee: C.payee >= 0 ? String(r[C.payee] || '').trim() : '',
      memo: C.memo >= 0 ? String(r[C.memo] || '').trim() : ''
    });
  }
  return out;
}
/* フォームの回答：項・目・件名・先・金額が複数組ある形に対応 */
function parseFormSheet(rows, h) {
  const head = (rows[h] || []).map((c) => String(c == null ? '' : c).replace(/[\s　]/g, ''));
  const all = (n) => head.map((x, i) => (x.includes(n) ? i : -1)).filter((i) => i >= 0);
  const first = (r, idx) => { for (const i of idx) if (r[i] != null && String(r[i]).trim() !== '') return String(r[i]).trim(); return ''; };
  const firstN = (r, idx) => { for (const i of idx) if (num(r[i])) return num(r[i]); return 0; };
  const cD = all('請求年月日').concat(all('タイムスタンプ'));
  const cK = all('区分'), cG = all('項'), cI = all('目');
  const cT = all('件名'), cP = all('収支先').concat(all('支出先')), cA = all('金額'), cM = all('備考').concat(all('摘要'));
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const date = parseDateLoose(first(r, cD));
    const amount = firstN(r, cA);
    if (!date || !amount) continue;
    const k = first(r, cK);
    out.push({
      date, type: /入|収/.test(k) ? 'in' : 'out', amount: Math.abs(amount),
      groupName: first(r, cG), itemName: first(r, cI),
      title: first(r, cT), payee: first(r, cP), memo: first(r, cM)
    });
  }
  return out;
}
/* 財産目録 */
function parseAssetSheet(rows, h) {
  const head = (rows[h] || []).map((c) => String(c == null ? '' : c).replace(/[\s　]/g, ''));
  const col = (...names) => { for (const n of names) { const i = head.findIndex((x) => x.includes(n)); if (i >= 0) return i; } return -1; };
  const C = { maker: col('メーカー'), name: col('商品名', '品名'), model: col('型番'), place: col('購入場所'), price: col('値段', '取得価額', '金額'), date: col('取得年月日', '購入日'), memo: col('備考') };
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const nm = C.name >= 0 ? String(r[C.name] || '').trim() : '';
    const mk = C.maker >= 0 ? String(r[C.maker] || '').trim() : '';
    if (!nm && !mk) continue;
    out.push({
      name: nm || mk, maker: mk, model: C.model >= 0 ? String(r[C.model] || '').trim() : '',
      place: C.place >= 0 ? String(r[C.place] || '').trim() : '',
      price: C.price >= 0 ? num(r[C.price]) : 0,
      acquired: (C.date >= 0 ? parseDateLoose(r[C.date]) : null) || today(),
      memo: C.memo >= 0 ? String(r[C.memo] || '').trim() : ''
    });
  }
  return out;
}
/* 光熱費：月を横に並べた集計表を読み取る */
function parseUtilSheet(rows) {
  let fy = null;
  for (let i = 0; i < Math.min(4, rows.length); i++) {
    for (const c of rows[i] || []) {
      const s = String(c == null ? '' : c);
      let m = s.match(/令和\s*(\d+)\s*年度/); if (m) { fy = 2018 + Number(m[1]); break; }
      m = s.match(/(20\d\d)\s*年度/); if (m) { fy = Number(m[1]); break; }
    }
    if (fy) break;
  }
  if (!fy) fy = fyOf(today());
  const KIND = [[/電\s*気/, '電気'], [/水\s*道/, '水道'], [/ガ\s*ス/, 'ガス'], [/ガソリン/, 'ガソリン'], [/灯\s*油/, '灯油']];
  const kindOf = (s) => { for (const [re, k] of KIND) if (re.test(s)) return k; return null; };
  let block = null, months = null, sub = null;
  const acc = {};
  const put = (kind, mo, field, val) => {
    if (!kind || !mo || !val) return;
    const y = mo >= FY_START ? fy : fy + 1;
    const key = kind + '|' + y + '-' + pad2(mo);
    (acc[key] = acc[key] || { kind, ym: y + '-' + pad2(mo) })[field] = val;
  };
  for (const row of rows) {
    const r = row || [];
    const joined = r.map((c) => String(c == null ? '' : c)).join(' ');
    /* ブロックの見出し（○ 電 気 料 など） */
    if (/[○◯●■]/.test(joined)) { const k = kindOf(joined.replace(/[\s　]/g, '')); if (k || /燃\s*料/.test(joined)) { block = k; sub = null; months = null; } }
    /* 月の並び */
    const cand = {};
    let hits = 0, labelCol = -1;
    for (let i = 0; i < r.length; i++) {
      const s = cellS(r, i);
      if (/^月分?$/.test(s)) labelCol = i;
      const n = Number(r[i]);
      if (labelCol >= 0 && i > labelCol && Number.isInteger(n) && n >= 1 && n <= 12) { cand[i] = n; hits++; }
    }
    if (hits >= 4) { months = cand; if (labelCol >= 0) months.__label = labelCol; continue; }
    if (!months) continue;
    /* 種別（ガソリン・灯油など） */
    for (let i = 0; i < (months.__label >= 0 ? months.__label : 3); i++) {
      const k = kindOf(cellS(r, i));
      if (k) sub = k;
    }
    const label = cellS(r, months.__label >= 0 ? months.__label : 3);
    const kind = sub || block;
    if (!kind || !label) continue;
    const field = /数量|使用量|使用料/.test(label) ? 'usage' : /料金|金額|小計|合計/.test(label) ? 'amount' : /単価/.test(label) ? 'unit' : null;
    if (!field) continue;
    for (const key in months) {
      if (key === '__label') continue;
      put(kind, months[key], field, num(r[key]));
    }
  }
  return Object.values(acc).filter((x) => num(x.amount) || num(x.usage));
}

/* ---------- 出納簿への反映（CSVと共通） ---------- */
function commitLedgerDraft(draft, map) {
  map = map || {};
  let n = 0;
  draft.forEach((d) => {
    let itemId = d.itemId || '';
    if (!itemId && d.itemName) {
      const type = d.type === 'in' ? 'income' : 'expense';
      let found = '';
      S.categories[type].forEach((g) => g.items.forEach((it) => { if (normName(it.name) === normName(d.itemName)) found = it.id; }));
      const m = map[d.itemName];
      if (m && m !== '__new') itemId = m;
      else if (found) itemId = found;
      else {
        let g = S.categories[type].find((x) => normName(x.name) === normName(d.groupName));
        if (!g) g = S.categories[type][S.categories[type].length - 1];
        if (!g) { g = { id: uid(), name: 'その他', items: [] }; S.categories[type].push(g); }
        const it = { id: uid(), name: d.itemName, desc: '（取り込みで追加）' };
        g.items.push(it); itemId = it.id;
      }
    }
    S.tx.push({
      id: uid(), seq: String(S.seq++).padStart(5, '0'), type: d.type, date: d.date,
      amount: d.amount, itemId, title: d.title || '', payee: d.payee || '', memo: d.memo || '', accountId: ''
    });
    n++;
  });
  return n;
}
/* 二重取り込みの検知 */
function dupCount(draft) {
  const key = (t) => t.date + '|' + t.type + '|' + num(t.amount) + '|' + (t.title || '');
  const have = new Set(S.tx.map(key));
  return draft.filter((d) => have.has(key(d))).length;
}

/* ---------- 取り込み画面 ---------- */
const TYPE_LABEL = { ledger: '出納簿', form: 'フォームの回答', assets: '財産目録', util: '光熱費', catdesc: '科目の説明', skip: '取り込まない' };
async function openXlsxImport(file) {
  modal('Excelの取り込み', '<div class="warn" id="xStat">ファイルを読み込んでいます…</div><div id="xBody"></div>', async (root) => {
    let sheets;
    try { sheets = await readXlsx(file); }
    catch (e) {
      $('#xStat', root).className = 'err';
      $('#xStat', root).textContent = e.message || '読み込めませんでした';
      return;
    }
    const info = sheets.map((sh) => ({ sh, a: analyzeSheet(sh) }));
    const usable = info.filter((x) => x.a.type !== 'skip' && x.a.count);
    $('#xStat', root).className = usable.length ? 'ok' : 'warn';
    $('#xStat', root).innerHTML = usable.length
      ? `${sheets.length}シートのうち、<b>${usable.length}シート</b>から取り込める内容が見つかりました。`
      : 'このファイルからは、自動で判別できる表が見つかりませんでした。シートの種類を手で選んでお試しください。';
    $('#xBody', root).innerHTML = `
      <div class="tw"><table class="led"><thead><tr><th>シート</th><th>取り込む内容</th><th class="r">件数</th></tr></thead>
      <tbody>${info.map((x, i) => `<tr>
        <td><b>${esc(x.sh.name)}</b><div class="tiny">${x.sh.rows.length}行</div></td>
        <td><select data-x="${i}">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}"${k === x.a.type ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="r num" data-xc="${i}">${x.a.type !== 'skip' && x.a.count ? x.a.count : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <div id="xPrev" style="margin-top:12px"></div>
      <div class="row end" style="margin-top:12px"><button class="btn" data-x-go>選んだ内容を取り込む</button></div>
      <p class="note">同じ年度を二度取り込むと記帳が重複します。取り込み前に重複の有無をお知らせします。</p>`;

    const drafts = () => {
      const led = [], as = [], ut = [], cd = [];
      $$('[data-x]', root).forEach((sel) => {
        const x = info[Number(sel.dataset.x)], t = sel.value;
        if (t === 'ledger') led.push(...parseLedgerSheet(x.sh.rows, x.a.type === 'ledger' ? x.a.header : Math.max(0, findHeader(x.sh.rows, ['区分'], 12))));
        else if (t === 'form') led.push(...parseFormSheet(x.sh.rows, x.a.type === 'form' ? x.a.header : Math.max(0, findHeader(x.sh.rows, ['金額'], 12))));
        else if (t === 'assets') as.push(...parseAssetSheet(x.sh.rows, x.a.type === 'assets' ? x.a.header : 0));
        else if (t === 'util') ut.push(...parseUtilSheet(x.sh.rows));
        else if (t === 'catdesc') cd.push(...parseCatDesc(x.sh.rows));
      });
      return { led, as, ut, cd };
    };
    const preview = () => {
      const d = drafts();
      const dup = dupCount(d.led);
      $('#xPrev', root).innerHTML = `
        ${dup ? `<div class="warn">すでに登録済みと思われる記帳が <b>${dup}件</b> 含まれています。重複を避けたい場合は、対象のシートを「取り込まない」にしてください。</div>` : ''}
        <table class="led"><tbody>
          <tr><td>出納簿へ</td><td class="r num"><b>${d.led.length}</b> 件</td></tr>
          <tr><td>財産目録へ</td><td class="r num"><b>${d.as.length}</b> 件</td></tr>
          <tr><td>光熱費へ</td><td class="r num"><b>${d.ut.length}</b> 件</td></tr>
          <tr><td>科目の説明を更新</td><td class="r num"><b>${d.cd.length}</b> 件</td></tr>
        </tbody></table>
        ${d.led.length ? `<div class="tw" style="margin-top:10px"><table class="led"><thead><tr><th>年月日</th><th>区分</th><th>目</th><th>件名</th><th class="r">金額</th></tr></thead><tbody>
          ${d.led.slice(0, 5).map((t) => `<tr><td class="num tiny">${t.date}</td><td><span class="pill ${t.type}">${t.type === 'in' ? '入' : '出'}</span></td><td class="tiny">${esc(t.itemName || '未設定')}</td><td>${esc(t.title)}</td><td class="r num">${yen(t.amount)}</td></tr>`).join('')}
          ${d.led.length > 5 ? `<tr><td colspan="5" class="tiny">ほか${d.led.length - 5}件</td></tr>` : ''}</tbody></table></div>` : ''}
        ${d.as.length ? `<div class="tw" style="margin-top:8px"><table class="led"><thead><tr><th>品名</th><th class="r">取得価額</th><th>取得日</th></tr></thead><tbody>
          ${d.as.slice(0, 4).map((a) => `<tr><td>${esc(a.name)}</td><td class="r num">${yen(a.price)}</td><td class="tiny num">${a.acquired}</td></tr>`).join('')}
          ${d.as.length > 4 ? `<tr><td colspan="3" class="tiny">ほか${d.as.length - 4}件</td></tr>` : ''}</tbody></table></div>` : ''}`;
    };
    preview();
    root.addEventListener('change', (e) => { if (e.target.closest('[data-x]')) preview(); });
    root.addEventListener('click', (e) => {
      if (!e.target.closest('[data-x-go]')) return;
      const d = drafts();
      const total = d.led.length + d.as.length + d.ut.length + d.cd.length;
      if (!total) { toast('取り込む内容がありません'); return; }
      if (!confirmBox(`合計 ${total} 件を取り込みます。よろしいですか。`)) return;
      const n = commitLedgerDraft(d.led);
      d.as.forEach((a) => S.assets.push({
        id: uid(), name: a.name, maker: a.maker, model: a.model, place: a.place,
        price: a.price, acquired: a.acquired, life: guessLife(a.name + a.maker + a.model), method: '定額法', memo: a.memo
      }));
      d.ut.forEach((u) => S.utilities.push({ id: uid(), ym: u.ym, kind: u.kind, usage: num(u.usage), unit: num(u.unit), amount: num(u.amount), memo: 'Excelから取り込み' }));
      d.cd.forEach((c) => {
        for (const t of ['income', 'expense']) for (const g of S.categories[t]) for (const it of g.items) {
          if (normName(it.name) === normName(c.name) && c.desc) it.desc = c.desc;
        }
      });
      save();
      closeModal();
      toast(`${total}件を取り込みました`);
      go(d.led.length ? 'ledger' : d.as.length ? 'assets' : 'util');
    });
  });
}
/* 科目コード説明シート */
function parseCatDesc(rows) {
  const out = [];
  for (const r of rows) {
    const a = r && r[0] != null ? String(r[0]).trim() : '';
    const b = r && r[1] != null ? String(r[1]).trim() : '';
    if (!a || !b) continue;
    if (/^[「【]/.test(a) || /目名|項名/.test(a)) continue;
    out.push({ name: a, desc: b });
  }
  return out;
}
/* 品名から耐用年数をあてる */
function guessLife(text) {
  const t = String(text || '');
  for (const [name, y] of USEFUL_LIFE) {
    const key = name.replace(/（.*?）/g, '').split('・')[0];
    if (key && t.includes(key)) return y;
  }
  if (/軽/.test(t) && /自動車|バン|ワゴン/.test(t)) return 4;
  if (/自動車|セダン|ハイブリッド/.test(t)) return 6;
  if (/冷蔵|洗濯|エアコン|給湯|ストーブ|暖房/.test(t)) return 6;
  if (/テレビ|ＴＶ|カメラ/.test(t)) return 5;
  if (/パソコン|ＰＣ|PC|タブレット|スマート/.test(t)) return 4;
  if (/机|棚|ソファ|ベッド|家具|タンス/.test(t)) return 8;
  return 6;
}
/* ---------- 24. 科目設定 ---------- */
function viewCats() {
  const block = (type, label) => `
  <section class="form">
    <div class="fh"><h2>${label}</h2><span class="slip">項と目の加除</span></div>
    <div class="fb tight">
      ${allGroups(type).map((g, gi) => `
        <div style="border-bottom:1px solid var(--rule);padding:10px 14px">
          <div class="row">
            <input data-gname="${g.id}" value="${esc(g.name)}" style="flex:1;min-width:150px;font-weight:700;color:var(--navy)">
            <button class="btn ghost sm" data-act="up" data-t="${type}" data-i="${gi}">↑</button>
            <button class="btn ghost sm" data-act="down" data-t="${type}" data-i="${gi}">↓</button>
            <button class="btn danger ghost sm" data-act="gdel" data-id="${g.id}" data-t="${type}">項を削除</button>
          </div>
          <table class="led" style="margin-top:8px"><tbody>
          ${g.items.map((it) => `<tr>
            <td style="width:38%"><input data-iname="${it.id}" value="${esc(it.name)}"></td>
            <td><input data-idesc="${it.id}" value="${esc(it.desc || '')}" placeholder="説明"></td>
            ${type === 'expense' ? `<td class="c" style="width:74px"><label class="chk"><input type="checkbox" data-ifix="${it.id}" ${it.fixed ? 'checked' : ''}>固定費</label></td>` : ''}
            <td class="r" style="width:48px"><button class="linkbtn" data-act="idel" data-id="${it.id}" data-g="${g.id}" data-t="${type}">削除</button></td></tr>`).join('')}
          </tbody></table>
          <div class="row" style="margin-top:6px"><button class="btn ghost sm" data-act="iadd" data-id="${g.id}" data-t="${type}">＋ 目を追加</button></div>
        </div>`).join('')}
      <div class="fb"><button class="btn ghost sm" data-act="gadd" data-t="${type}">＋ 項を追加</button></div>
    </div>
  </section>`;
  return `<div class="warn">科目名を変えても、これまでの記帳はその科目に付いたままです。科目を<b>削除</b>すると、そこに紐づく記帳は「未設定」になります。</div>
  ${block('income', '収 入 科 目')}${block('expense', '支 出 科 目')}`;
}
function bind_cats() {
  const v = $('#view');
  v.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.gname) { const f = S.categories.income.concat(S.categories.expense).find((g) => g.id === t.dataset.gname); if (f) { f.name = t.value; save(); } }
    if (t.dataset.iname) { const f = findItem(t.dataset.iname); if (f) { f.item.name = t.value; save(); } }
    if (t.dataset.idesc) { const f = findItem(t.dataset.idesc); if (f) { f.item.desc = t.value; save(); } }
  });
  v.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ifix) { const f = findItem(t.dataset.ifix); if (f) { f.item.fixed = t.checked; save(); } }
  });
  v.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act, type = b.dataset.t, arr = S.categories[type];
    if (a === 'gadd') { arr.push({ id: uid(), name: `${arr.length + 1}．新しい項`, items: [] }); save(); render(); }
    if (a === 'gdel') {
      const g = arr.find((x) => x.id === b.dataset.id);
      const cnt = S.tx.filter((t) => g.items.some((i) => i.id === t.itemId)).length;
      if (!confirmBox(`「${g.name}」を削除します。${cnt ? `この項の科目が付いた記帳が${cnt}件あります。` : ''}よろしいですか。`)) return;
      S.categories[type] = arr.filter((x) => x.id !== b.dataset.id); save(); render();
    }
    if (a === 'iadd') { const g = arr.find((x) => x.id === b.dataset.id); g.items.push({ id: uid(), name: pad2(g.items.length + 1) + '．新しい目', desc: '' }); save(); render(); }
    if (a === 'idel') {
      const g = arr.find((x) => x.id === b.dataset.g);
      const cnt = S.tx.filter((t) => t.itemId === b.dataset.id).length;
      if (!confirmBox(`この目を削除します。${cnt ? `記帳${cnt}件が「未設定」になります。` : ''}よろしいですか。`)) return;
      g.items = g.items.filter((x) => x.id !== b.dataset.id); save(); render();
    }
    if (a === 'up' || a === 'down') {
      const i = Number(b.dataset.i), j = a === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= arr.length) return;
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; save(); render();
    }
  });
}

/* ---------- 25. データ管理（CSV・バックアップ） ---------- */
function viewData() {
  return `
  <section class="form">
    <div class="fh"><h2>C S V の 書 き 出 し</h2><span class="slip">Excelで開けます</span></div>
    <div class="fb">
      <div class="row">
        <button class="btn ghost sm" data-act="csvLedger">出納簿（${CUR_FY}年度）</button>
        <button class="btn ghost sm" data-act="csvAll">出納簿（全期間）</button>
        <button class="btn ghost sm" data-act="csvSettle">決算書</button>
        <button class="btn ghost sm" data-act="csvAssets">財産目録</button>
        <button class="btn ghost sm" data-act="csvUtil">光熱費</button>
      </div>
      <p class="note">文字コードはUTF-8（BOM付き）です。Excelでそのまま開けます。</p>
    </div>
  </section>
  <section class="form">
    <div class="fh"><h2>E x c e l の 取 り 込 み</h2><span class="slip">.xlsx をそのまま</span></div>
    <div class="fb">
      <div class="dz" id="xdz">ここに Excel ファイルをドラッグするか、下のボタンで選んでください</div>
      <div class="row end" style="margin-top:10px"><button class="btn sm" data-act="xpick">Excelファイルを選ぶ</button></div>
      <input type="file" id="xlsxIn" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      <p class="note">これまでの家計簿ファイルを、シートごと読み取ります。出納簿・フォームの回答・財産目録・光熱費・科目の説明を自動で見分け、取り込む内容はシートごとに選べます。複数年分のファイルは、1つずつ順に取り込んでください。</p>
    </div>
  </section>
  <section class="form">
    <div class="fh"><h2>C S V の 取 り 込 み</h2><span class="slip">出納簿へ追加</span></div>
    <div class="fb">
      <div class="dz" id="dz">ここにCSVファイルをドラッグするか、下のボタンで選んでください</div>
      <div class="row end" style="margin-top:10px"><button class="btn ghost sm" data-act="pick">ファイルを選ぶ</button></div>
      <input type="file" id="csvIn" accept=".csv,text/csv" hidden>
      <p class="note">見出し行から列を自動で判定します。対応する見出し：年月日／日付／請求年月日、区分、項、目、件名／収支件名／支出件名、相手先／収支先／支出先、収入金額、支払金額／金額、摘要／備考。1列だけの「金額」なら区分で収支を判定します。</p>
      <div id="csvPrev"></div>
    </div>
  </section>
  <section class="form">
    <div class="fh"><h2>バ ッ ク ア ッ プ</h2><span class="slip">全データの保存と復元</span></div>
    <div class="fb">
      <div class="row">
        <button class="btn sm" data-act="bkOut">バックアップを書き出す</button>
        <button class="btn ghost sm" data-act="bkIn">バックアップから復元</button>
      </div>
      <label class="chk" style="margin-top:10px"><input type="checkbox" id="bkEnc">パスワードで暗号化する（復元時に同じパスワードが必要）</label>
      <input type="file" id="bkFile" accept=".json,.kakeibo,application/json" hidden>
      <p class="note">端末の買い替えや故障に備えて、月に一度は書き出しておくことをおすすめします。復元は、いまのデータを<b>すべて置き換えます</b>。</p>
    </div>
  </section>
  <section class="form">
    <div class="fh"><h2>デ ー タ の 削 除</h2></div>
    <div class="fb"><div class="row"><button class="btn danger ghost sm" data-act="wipeTx">${CUR_FY}年度の記帳を削除</button><button class="btn danger ghost sm" data-act="wipeAll">すべて初期化</button></div></div>
  </section>`;
}
function bind_data() {
  const v = $('#view');
  v.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'csvLedger') exportLedgerCSV(CUR_FY);
    if (a === 'csvAll') exportLedgerCSV(null);
    if (a === 'csvSettle') exportSettleCSV();
    if (a === 'csvAssets') exportAssetsCSV();
    if (a === 'csvUtil') exportUtilCSV();
    if (a === 'pick') $('#csvIn').click();
    if (a === 'xpick') $('#xlsxIn').click();
    if (a === 'bkOut') backupOut($('#bkEnc').checked);
    if (a === 'bkIn') $('#bkFile').click();
    if (a === 'wipeTx') {
      if (!confirmBox(`${CUR_FY}年度の記帳をすべて削除します。元に戻せません。よろしいですか。`)) return;
      const [s, t] = fyRange(CUR_FY); S.tx = S.tx.filter((x) => !(x.date >= s && x.date <= t)); save(); render(); toast('削除しました');
    }
    if (a === 'wipeAll') {
      if (!confirmBox('すべてのデータを初期化します。元に戻せません。よろしいですか。')) return;
      if (!confirmBox('本当に初期化してよろしいですか。')) return;
      S = blankState(); CUR_FY = fyOf(today()); save(true); render(); toast('初期化しました');
    }
  });
  $('#csvIn').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importCSV(f); });
  $('#xlsxIn').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openXlsxImport(f); });
  const xdz = $('#xdz');
  ['dragover', 'dragenter'].forEach((ev) => xdz.addEventListener(ev, (e) => { e.preventDefault(); xdz.style.background = '#e6ecff'; }));
  ['dragleave', 'drop'].forEach((ev) => xdz.addEventListener(ev, (e) => { e.preventDefault(); xdz.style.background = ''; }));
  xdz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) openXlsxImport(f); });
  $('#bkFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) backupIn(f); });
  const dz = $('#dz');
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.background = '#dfe6ec'; }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.background = ''; }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) importCSV(f); });
}
function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const BOM = '\uFEFF';
const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
function exportLedgerCSV(fy) {
  const list = (fy ? txOfFY(fy) : S.tx).slice().sort((a, b) => (a.date + (a.seq || '')).localeCompare(b.date + (b.seq || '')));
  let run = S.accounts.reduce((s, a) => s + num(a.opening), 0), n = 0;
  const rows = list.map((t) => {
    run += t.type === 'in' ? num(t.amount) : -num(t.amount);
    const acc = S.accounts.find((a) => a.id === t.accountId);
    return [++n, t.date, t.type === 'in' ? '入' : '出', groupNameOf(t.itemId), itemName(t.itemId), t.title || '', t.payee || '',
      t.type === 'in' ? num(t.amount) : '', t.type === 'out' ? num(t.amount) : '', run, acc ? accLabel(acc) : '', t.memo || ''].map(q).join(',');
  });
  const head = ['帳票No.', '年月日', '区分', '項', '目', '収入・支出件名', '収入・支出先', '収入金額', '支払金額', '差引残高', '口座', '摘要'].map(q).join(',');
  download(`出納簿_${fy || '全期間'}.csv`, BOM + [head].concat(rows).join('\r\n'));
  toast('書き出しました');
}
function exportSettleCSV() {
  const out = [['区分', '項', '目', '当初予算額', '補正額', '予算現額', '執行額', '差引'].map(q).join(',')];
  ['income', 'expense'].forEach((type) => {
    const r = settleRows(type, CUR_FY);
    r.groups.forEach((g) => g.items.forEach((i) => {
      const b = budgetOf(CUR_FY, i.id);
      out.push([type === 'income' ? '収入' : '支出', g.name, i.name, b.b0, b.hosei, b.genzai, i.done, type === 'income' ? i.done - b.genzai : b.genzai - i.done].map(q).join(','));
    }));
  });
  download(`決算書_${CUR_FY}年度.csv`, BOM + out.join('\r\n')); toast('書き出しました');
}
function exportAssetsCSV() {
  const head = ['品名', 'メーカー', '型番', '購入場所', '取得価額', '取得年月日', '耐用年数', '償却方法', '年償却額', '償却累計', '帳簿価額', '買替目安', '備考'];
  const rows = S.assets.map((a) => { const d = depreciate(a); return [a.name, a.maker, a.model, a.place, num(a.price), a.acquired, a.life, a.method, d.yearly, d.accum, d.book, replaceDate(a), a.memo].map(q).join(','); });
  download('財産目録.csv', BOM + [head.map(q).join(',')].concat(rows).join('\r\n')); toast('書き出しました');
}
function exportUtilCSV() {
  const head = ['年月', '種別', '使用量', '単価', '金額', '備考'];
  const rows = S.utilities.slice().sort((a, b) => a.ym.localeCompare(b.ym)).map((u) => [u.ym, u.kind, u.usage, u.unit, u.amount, u.memo].map(q).join(','));
  download('光熱費.csv', BOM + [head.map(q).join(',')].concat(rows).join('\r\n')); toast('書き出しました');
}
/* CSV 解析（引用符対応） */
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
function importCSV(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const rows = parseCSV(String(fr.result));
    if (rows.length < 2) { toast('データが見つかりません'); return; }
    /* 見出し行を探す */
    let hi = 0;
    for (let i = 0; i < Math.min(8, rows.length); i++) if (rows[i].some((c) => /年月日|日付|金額|科目|区分|目/.test(c))) { hi = i; break; }
    const head = rows[hi].map((s) => String(s).replace(/[\s　]/g, ''));
    const col = (...names) => { for (const n of names) { const i = head.findIndex((h) => h.includes(n)); if (i >= 0) return i; } return -1; };
    const C = {
      date: col('年月日', '日付', '請求年月日', 'タイムスタンプ'), type: col('区分'),
      grp: col('項'), item: col('目', '科目'), title: col('収入・支出件名', '収支件名', '支出件名', '件名', '内容', '摘要名'),
      payee: col('収入・支出先', '収支先', '支出先', '相手先', '支払先', '店'),
      inAmt: col('収入金額'), outAmt: col('支払金額', '支出金額'), amt: col('金額'), memo: col('摘要', '備考')
    };
    if (C.date < 0) { toast('日付の列が見つかりません'); return; }
    const body = rows.slice(hi + 1);
    const draft = [];
    const nameIndex = {};
    ['income', 'expense'].forEach((t) => S.categories[t].forEach((g) => g.items.forEach((it) => { nameIndex[normName(it.name)] = it.id; })));
    body.forEach((r) => {
      const raw = String(r[C.date] || '').trim(); if (!raw) return;
      const d = parseDateLoose(raw); if (!d) return;
      let type = null, amount = 0;
      const vIn = C.inAmt >= 0 ? num(r[C.inAmt]) : 0, vOut = C.outAmt >= 0 ? num(r[C.outAmt]) : 0;
      if (vIn) { type = 'in'; amount = vIn; }
      else if (vOut) { type = 'out'; amount = vOut; }
      else if (C.amt >= 0 && num(r[C.amt])) {
        amount = Math.abs(num(r[C.amt]));
        const k = C.type >= 0 ? String(r[C.type]) : '';
        type = /入|収/.test(k) ? 'in' : /出|支/.test(k) ? 'out' : (num(r[C.amt]) < 0 ? 'out' : 'out');
      }
      if (!amount) return;
      const iname = C.item >= 0 ? String(r[C.item] || '').trim() : '';
      draft.push({
        date: d, type, amount,
        itemName: iname, itemId: nameIndex[normName(iname)] || '',
        groupName: C.grp >= 0 ? String(r[C.grp] || '').trim() : '',
        title: C.title >= 0 ? String(r[C.title] || '').trim() : '',
        payee: C.payee >= 0 ? String(r[C.payee] || '').trim() : '',
        memo: C.memo >= 0 ? String(r[C.memo] || '').trim() : ''
      });
    });
    if (!draft.length) { toast('取り込める行がありませんでした'); return; }
    const unknown = Array.from(new Set(draft.filter((d) => !d.itemId && d.itemName).map((d) => d.itemName)));
    $('#csvPrev').innerHTML = `<div class="ok" style="margin-top:12px">${draft.length}件を読み取りました。${unknown.length ? `未登録の科目が${unknown.length}種類あります。` : ''}</div>
      ${unknown.length ? `<div class="tw"><table class="led"><thead><tr><th>CSVの科目名</th><th>割り当て先</th></tr></thead><tbody>
      ${unknown.map((u, i) => `<tr><td>${esc(u)}</td><td><select data-map="${i}" data-name="${esc(u)}"><option value="__new">新しい目として追加</option>${itemOptions('expense').replace('<option value="">選択してください</option>', '')}${itemOptions('income').replace('<option value="">選択してください</option>', '')}</select></td></tr>`).join('')}
      </tbody></table></div>` : ''}
      <div class="tw" style="margin-top:10px"><table class="led"><thead><tr><th>年月日</th><th>区分</th><th>目</th><th>件名</th><th class="r">金額</th></tr></thead><tbody>
      ${draft.slice(0, 6).map((d) => `<tr><td class="num tiny">${d.date}</td><td><span class="pill ${d.type}">${d.type === 'in' ? '入' : '出'}</span></td><td class="tiny">${esc(d.itemName || '未設定')}</td><td>${esc(d.title)}</td><td class="r num">${yen(d.amount)}</td></tr>`).join('')}
      ${draft.length > 6 ? `<tr><td colspan="5" class="tiny">ほか${draft.length - 6}件</td></tr>` : ''}</tbody></table></div>
      <div class="row end" style="margin-top:10px"><button class="btn" id="csvGo">${draft.length}件を出納簿に取り込む</button></div>`;
    $('#csvGo').addEventListener('click', () => {
      const map = {};
      $$('[data-map]').forEach((s) => { map[s.dataset.name] = s.value; });
      const n = commitLedgerDraft(draft, map);
      save(); toast(`${n}件を取り込みました`); go('ledger');
    });
  };
  fr.readAsText(file, 'UTF-8');
}
function normName(s) { return String(s || '').replace(/[\s　]/g, '').replace(/^[0-9０-９]+[．.\-]?/, '').toLowerCase(); }
function parseDateLoose(s) {
  s = String(s).trim();
  let m = s.match(/(\d{4})[\/\-\.年](\d{1,2})[\/\-\.月](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/);
  if (m) return `${2018 + Number(m[1])}-${pad2(m[2])}-${pad2(m[3])}`;
  const d = new Date(s);
  if (!isNaN(d) && d.getFullYear() > 1990 && d.getFullYear() < 2100) return d.toISOString().slice(0, 10);
  const n = Number(s);
  if (n > 20000 && n < 80000) { const dd = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return dd.toISOString().slice(0, 10); }
  return null;
}

/* ---------- 26. バックアップ（任意で暗号化） ---------- */
async function deriveKey(pass, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const b64 = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function backupOut(encrypt) {
  const payload = JSON.stringify({ app: 'kakeibo', v: 1, at: new Date().toISOString(), state: S });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (!encrypt) { download(`家庭会計_バックアップ_${stamp}.json`, payload, 'application/json'); toast('書き出しました'); return; }
  if (!SUBTLE) {
    window.alert('この開き方では暗号化が使えません（ブラウザの制限）。\nhttps か localhost 経由で開くとご利用いただけます。\n今回は暗号化なしで書き出します。');
    download(`家庭会計_バックアップ_${stamp}.json`, payload, 'application/json'); return;
  }
  const pass = window.prompt('復元に使うパスワードを決めてください（忘れると復元できません）');
  if (!pass) return;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(payload));
  download(`家庭会計_バックアップ_${stamp}.kakeibo`, JSON.stringify({ enc: 'AES-GCM', salt: b64(salt), iv: b64(iv), data: b64(ct) }), 'application/json');
  toast('暗号化して書き出しました');
}
async function backupIn(file) {
  const text = await file.text();
  let obj;
  try { obj = JSON.parse(text); } catch (e) { toast('ファイルを読めません'); return; }
  if (obj.enc) {
    if (!SUBTLE) { toast('暗号化された控えは https か localhost で開いてください'); return; }
    const pass = window.prompt('バックアップのパスワードを入力してください');
    if (!pass) return;
    try {
      const key = await deriveKey(pass, unb64(obj.salt));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, key, unb64(obj.data));
      obj = JSON.parse(new TextDecoder().decode(pt));
    } catch (e) { toast('パスワードが違います'); return; }
  }
  if (!obj.state) { toast('このファイルは復元できません'); return; }
  if (!confirmBox('いまのデータをすべて置き換えます。よろしいですか。')) return;
  S = Object.assign(blankState(), obj.state);
  CUR_FY = fyOf(today());
  await save(true); render(); toast('復元しました');
}

/* ---------- 27. 設定 ---------- */
function viewConfig() {
  const s = S.settings;
  return `
  <section class="form">
    <div class="fh"><h2>基 本 設 定</h2></div>
    <div class="fb">
      <label class="fld"><span>表題</span><input id="cTitle" value="${esc(s.title || '')}"></label>
      <label class="fld" style="margin-top:10px"><span>記帳のときに最初に選ぶ口座</span><select id="cAcct">${accountOptions(s.defaultAccount)}</select></label>
    </div>
  </section>
  <section class="form">
    <div class="fh"><h2>暗 証 番 号</h2><span class="slip">端末を共有するとき</span></div>
    <div class="fb">
      <p class="note" style="margin:0 0 10px">${s.pin ? '暗証番号が設定されています。' : '暗証番号は設定されていません。'}起動時と、しばらく操作しなかったときに入力を求めます。</p>
      <div class="row">
        <button class="btn ghost sm" data-act="pinSet">${s.pin ? '暗証番号を変更' : '暗証番号を設定'}</button>
        ${s.pin ? '<button class="btn danger ghost sm" data-act="pinDel">解除する</button>' : ''}
      </div>
      <div class="warn" style="margin-top:10px">暗証番号は画面を隠すためのものです。端末そのものの画面ロックと合わせてお使いください。データは端末の中だけに保存され、外部には送られません。</div>
    </div>
  </section>
  <section class="form">
    <div class="fh"><h2>ス マ ー ト フ ォ ン で 使 う</h2></div>
    <div class="fb">
      <p class="note" style="margin:0">ブラウザのメニューから「ホーム画面に追加」を選ぶと、アプリのように起動できます。オフラインでも動作します。レシート読み取りも通信なしで使えます。</p>
    </div>
  </section>`;
}
function bind_config() {
  $('#cTitle').addEventListener('input', (e) => { S.settings.title = e.target.value; save(); });
  $('#cAcct').addEventListener('change', (e) => { S.settings.defaultAccount = e.target.value; save(); });
  $('#view').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'pinSet') {
      const p = window.prompt('新しい暗証番号（4〜12桁の数字）');
      if (!p) return;
      if (!/^\d{4,12}$/.test(p)) { toast('4〜12桁の数字で入力してください'); return; }
      S.settings.pin = await hashPin(p); save(); render(); toast('設定しました');
    }
    if (b.dataset.act === 'pinDel') {
      const p = window.prompt('いまの暗証番号を入力してください');
      if (!p) return;
      if (await hashPin(p) !== S.settings.pin) { toast('暗証番号が違います'); return; }
      S.settings.pin = null; save(); render(); toast('解除しました');
    }
  });
}
/* crypto.subtle は https か localhost でしか使えないため、
   使えない環境では同じ SHA-256 を JavaScript で計算する */
const SUBTLE = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
async function hashPin(p) {
  const bytes = new TextEncoder().encode('kakeibo:' + p);
  if (SUBTLE) return b64(await SUBTLE.digest('SHA-256', bytes));
  return b64(sha256(bytes));
}
function sha256(msg) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = msg.length, wl = ((l + 8 >> 6) + 1) << 4;
  const m = new Int32Array(wl);
  for (let i = 0; i < l; i++) m[i >> 2] |= msg[i] << (24 - (i % 4) * 8);
  m[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
  m[wl - 1] = l * 8;
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Int32Array(64);
  for (let i = 0; i < wl; i += 16) {
    let [a,b,c,d,e,f,g,h] = H;
    for (let t = 0; t < 64; t++) {
      if (t < 16) w[t] = m[i + t];
      else {
        const s0 = rr(w[t-15],7) ^ rr(w[t-15],18) ^ (w[t-15] >>> 3);
        const s1 = rr(w[t-2],17) ^ rr(w[t-2],19) ^ (w[t-2] >>> 10);
        w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0;
      }
      const S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[i*4]=H[i]>>>24; out[i*4+1]=(H[i]>>>16)&255; out[i*4+2]=(H[i]>>>8)&255; out[i*4+3]=H[i]&255; }
  return out;
}

/* ---------- 28. 施錠 ---------- */
let locked = false;
function showLock() {
  if (!S.settings.pin) { hideLock(); return; }
  locked = true;
  $('#lock').hidden = false; $('#lockMsg').textContent = ''; $('#lockPin').value = '';
  setTimeout(() => $('#lockPin').focus(), 120);
}
function hideLock() { locked = false; $('#lock').hidden = true; }
function setupLock() {
  const tryUnlock = async () => {
    if (!S.settings.pin) { hideLock(); render(); return; }  /* 未設定なら素通り */
    const v = $('#lockPin').value;
    if (await hashPin(v) === S.settings.pin) { hideLock(); render(); }
    else { $('#lockMsg').textContent = '暗証番号が違います'; $('#lockPin').value = ''; }
  };
  $('#lockGo').addEventListener('click', tryUnlock);
  $('#lockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  $('#btnLock').addEventListener('click', showLock);
  let hid = 0;
  document.addEventListener('visibilitychange', () => {
    if (!S.settings.pin) return;
    if (document.hidden) hid = Date.now();
    else if (hid && Date.now() - hid > 120000) showLock();
  });
}

/* ---------- 29. 起動 ---------- */
async function boot() {
  await Store.open();
  const saved = await Store.get('kv', 'state');
  if (saved && saved.categories) S = Object.assign(blankState(), saved);
  CUR_FY = fyOf(today()) || new Date().getFullYear();

  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });
  $('#fySel').addEventListener('change', (e) => {
    if (e.target.value === '__new') {
      const y = window.prompt('追加する年度（西暦）', String(fyOf(today()) + 1));
      if (y && /^\d{4}$/.test(y)) { CUR_FY = Number(y); S.budgets[CUR_FY] = S.budgets[CUR_FY] || {}; save(); }
      render(); return;
    }
    CUR_FY = Number(e.target.value); render();
  });
  setupLock();
  $('#btnLock').hidden = !S.settings.pin;
  if (S.settings.pin) showLock(); else render();
  window.addEventListener('beforeunload', () => { if (dirty) save(true); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
}
boot();
