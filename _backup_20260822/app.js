/* ウチの冷蔵庫 — 冷蔵庫リスト + 買い物リスト + 家族共有
 *
 * 同期の考え方：
 *  - 操作はまず手元に保存する。通信は後追い。圏外でも普通に使える
 *  - 変更した品目には dirty 印が付き、つながったときにまとめて送る
 *  - 削除は行を消さず deleted 印を立てる（消したことを家族に伝えるため）
 *  - 同じ品目を2人が同時に触ったら、updatedAt が新しいほうを採る（後勝ち）
 */

/* ============ 端末内の保存 ============ */
const LS = {
  key: k => 'fridge.' + k,
  get(k, fallback) {
    try {
      const raw = localStorage.getItem(LS.key(k));
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(LS.key(k), JSON.stringify(v)); }
    catch { toast('保存できませんでした（空き容量を確認してください）'); }
  }
};

/* ============ 品目の知識 ============ */
const CATS = {
  veg:   '野菜',
  meat:  '肉・魚・卵',
  dairy: '乳製品・大豆',
  other: 'その他',
};
const CAT_ORDER = ['veg', 'meat', 'dairy', 'other'];

/* [名前, 単位, 既定の量, 既定の日持ち(日)] */
const PRESETS = [
  { cat: 'veg', items: [
    ['にんじん','本',1,14], ['玉ねぎ','個',1,30], ['じゃがいも','個',1,30], ['キャベツ','個',1,10],
    ['トマト','個',2,5], ['きゅうり','本',2,5], ['ほうれん草','袋',1,3], ['ねぎ','本',1,7],
    ['もやし','袋',1,2], ['ピーマン','袋',1,7],
  ]},
  { cat: 'meat', items: [
    ['鶏むね肉','g',300,3], ['鶏もも肉','g',300,3], ['豚こま','g',300,3], ['ひき肉','g',300,2],
    ['鮭','切',2,3], ['卵','個',6,14], ['ハム','パック',1,10], ['ウインナー','パック',1,14],
  ]},
  { cat: 'dairy', items: [
    ['牛乳','ml',1000,7], ['ヨーグルト','パック',1,10], ['チーズ','パック',1,21],
    ['バター','g',200,60], ['豆腐','パック',1,5], ['納豆','パック',3,7],
  ]},
  { cat: 'other', items: [
    ['食パン','袋',1,4], ['うどん','袋',2,7], ['油揚げ','パック',1,7], ['きのこ','パック',1,7],
  ]},
];

const INFO = {};
PRESETS.forEach(g => g.items.forEach(([name, unit, qty, days]) => {
  INFO[name] = { cat: g.cat, unit, qty, days };
}));
const catOf = name => (INFO[name] && INFO[name].cat) || 'other';

const UNITS = ['個','g','ml','パック','本','袋','切'];
const isBulk = u => u === 'g' || u === 'ml';
const stepOf = unit => isBulk(unit) ? 50 : 1;
const qtyChoices = unit => isBulk(unit) ? [50,100,200,300,500] : [1,2,3,6,10];

/* ============ 状態 ============ */
const TOMBSTONE_LIFE = 30 * 86400000;

function migrate(list) {
  return (Array.isArray(list) ? list : []).map(it => ({
    id: it.id,
    name: it.name,
    qty: it.qty ?? 1,
    unit: it.unit ?? '個',
    expiry: it.expiry ?? '',
    done: !!it.done,
    by: it.by ?? '',
    addedAt: it.addedAt ?? Date.now(),
    updatedAt: it.updatedAt ?? it.addedAt ?? Date.now(),
    deleted: !!it.deleted,
    dirty: it.dirty ?? true,
  }));
}
function prune(list) {
  const now = Date.now();
  return list.filter(it => !(it.deleted && !it.dirty && now - it.updatedAt > TOMBSTONE_LIFE));
}

let fridge = prune(migrate(LS.get('fridge', [])));
let shop   = prune(migrate(LS.get('shop', [])));
let me     = LS.get('me', '');
let cfg    = Object.assign({ url: '', house: '' }, LS.get('cfg', {}));
let since  = LS.get('since', 0);
let recent = LS.get('recent', []);
let sortMode = LS.get('sort', 'expiry');

const saveFridge = () => LS.set('fridge', fridge);
const saveShop   = () => LS.set('shop', shop);
const saveAll    = () => { saveFridge(); saveShop(); LS.set('since', since); };

function touch(it) {
  it.updatedAt = Date.now();
  it.dirty = true;
}

/* ============ 小道具 ============ */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const inDays = n => ymd(new Date(startOfToday().getTime() + n * 86400000));

function daysLeft(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(y, m - 1, d); t.setHours(0,0,0,0);
  return Math.round((t - startOfToday()) / 86400000);
}
function expiryTag(iso) {
  const n = daysLeft(iso);
  if (n === null) return { state: 'ok', cls: 'ok', text: '期限なし' };
  if (n < 0)   return { state: 'over', cls: 'over', text: `${-n}日 過ぎ` };
  if (n === 0) return { state: 'over', cls: 'over', text: '今日まで' };
  if (n === 1) return { state: 'soon', cls: 'soon', text: 'あと1日' };
  if (n <= 3)  return { state: 'soon', cls: 'soon', text: `あと${n}日` };
  return { state: 'ok', cls: 'ok', text: `あと${n}日` };
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const live = list => list.filter(it => !it.deleted);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.hidden = true;
  void el.offsetWidth;               // 連続表示でも出るたびに animation をやり直す
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

/* 描画のたびに拾う演出の予約 */
const pendingEnter = new Set();
const pendingPop = new Set();

function removeCard(li, after) {
  if (!li || calm()) return after();
  li.classList.add('is-leaving');
  setTimeout(after, 290);
}

/* ============ 画面切り替え ============ */
let view = 'fridge';
function setView(v) {
  view = v;
  const f = $('#view-fridge'), s = $('#view-shop');
  f.hidden = v !== 'fridge';
  s.hidden = v !== 'shop';
  // 切り替えのたびに入場アニメをやり直す
  const shown = v === 'fridge' ? f : s;
  shown.style.animation = 'none'; void shown.offsetWidth; shown.style.animation = '';
  $('#title').textContent = v === 'fridge' ? '冷蔵庫' : '買い物リスト';
  $('#fab').hidden = v !== 'fridge';
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('is-active', b.dataset.view === v));
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => setView(b.dataset.view));

/* ============ 冷蔵庫の描画 ============ */
const byExpiry = (a, b) => {
  const da = daysLeft(a.expiry), db = daysLeft(b.expiry);
  if (da === null && db === null) return b.addedAt - a.addedAt;
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
};

function cardHTML(it) {
  const t = expiryTag(it.expiry);
  return `<li class="card" data-id="${it.id}" data-state="${t.state}" data-cat="${catOf(it.name)}">
    <span class="cat-dot"></span>
    <div class="card-main">
      <div class="card-name">${esc(it.name)}</div>
      <div class="card-sub"><span class="tag ${t.cls}">${t.text}</span></div>
    </div>
    <div class="card-qty">
      <button class="qbtn" data-act="dec" aria-label="減らす">−</button>
      <span class="qnum">${it.qty}${esc(it.unit)}</span>
      <button class="qbtn" data-act="inc" aria-label="増やす">＋</button>
    </div>
    <button class="card-done" data-act="use">使い切った</button>
  </li>`;
}

function renderFridge() {
  const items = live(fridge);
  $('#fridge-empty').hidden = items.length > 0;
  $('#sortbtn').hidden = items.length === 0;

  let html = '';
  if (sortMode === 'cat') {
    CAT_ORDER.forEach(cat => {
      const group = items.filter(i => catOf(i.name) === cat).sort(byExpiry);
      if (!group.length) return;
      html += `<li class="cat-head"><span class="chip-dot" style="background:var(--cat-${cat})"></span>${CATS[cat]}　${group.length}品</li>`;
      html += group.map(cardHTML).join('');
    });
  } else {
    html = [...items].sort(byExpiry).map(cardHTML).join('');
  }
  $('#fridge-list').innerHTML = html;

  // 予約されていた演出をあてる
  let i = 0;
  $('#fridge-list').querySelectorAll('.card').forEach(li => {
    const id = li.dataset.id;
    if (pendingEnter.has(id)) {
      li.classList.add('is-enter');
      li.style.animationDelay = (i++ * 40) + 'ms';
    }
    if (pendingPop.has(id)) li.querySelector('.qnum').classList.add('pop');
  });
  pendingEnter.clear(); pendingPop.clear();

  // まとめの行
  const over = items.filter(i => { const n = daysLeft(i.expiry); return n !== null && n < 0; });
  const today = items.filter(i => daysLeft(i.expiry) === 0);
  const soon = items.filter(i => { const n = daysLeft(i.expiry); return n !== null && n >= 1 && n <= 3; });
  renderUrgent(over, today);
  renderHero(items, over, today, soon);
  renderSortBtn();
}

/* 上のイラストに、いま何が入っているかを重ねる */
function renderHero(items, over, today, soon) {
  $('#hero-count').innerHTML = items.length
    ? `<b>${items.length}</b>品 入っています`
    : 'まだ からっぽです';
  // 期限切れ・今日までの分は下のお知らせ帯が品名まで出すので、ここでは繰り返さない
  const el = $('#hero-note');
  el.textContent = (over.length || today.length) ? ''
    : soon.length ? `まもなく期限 ${soon.length}品`
    : items.length ? 'いまのところ、あわてる品はありません'
    : '';
  el.style.color = 'var(--muted)';
}

function renderUrgent(over, today) {
  const box = $('#urgent');
  const names = [...over, ...today].map(i => i.name);
  if (!names.length) {
    box.hidden = true;
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    return;
  }
  $('#urgent-title').textContent = over.length
    ? `期限が過ぎているものが ${over.length}品 あります`
    : `今日中に使いたいものが ${today.length}品 あります`;
  $('#urgent-names').textContent = names.slice(0, 6).join('、') + (names.length > 6 ? ' ほか' : '');
  box.hidden = false;
  if (navigator.setAppBadge) navigator.setAppBadge(names.length).catch(() => {});
}

function renderSortBtn() {
  $('#sort-label').textContent = sortMode === 'cat' ? '種類ごと' : '期限が近い順';
}
$('#sortbtn').onclick = () => {
  sortMode = sortMode === 'cat' ? 'expiry' : 'cat';
  LS.set('sort', sortMode);
  live(fridge).forEach(i => pendingEnter.add(i.id));   // 並べ替えを目に見えるように
  renderFridge();
};

$('#fridge-list').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const li = e.target.closest('li');
  const it = fridge.find(x => x.id === li.dataset.id);
  if (!it || it.deleted) return;

  if (btn.dataset.act === 'inc') {
    it.qty += stepOf(it.unit);
    pendingPop.add(it.id);
  } else if (btn.dataset.act === 'dec') {
    it.qty = Math.max(0, it.qty - stepOf(it.unit));
    if (it.qty === 0) return removeCard(li, () => useUp(it));
    pendingPop.add(it.id);
  } else if (btn.dataset.act === 'use') {
    return removeCard(li, () => useUp(it));
  }

  touch(it); saveFridge(); renderFridge(); scheduleSync();
});

function useUp(it) {
  it.deleted = true; touch(it);
  saveFridge(); renderFridge();

  if (!live(shop).some(s => !s.done && s.name === it.name)) {
    const s = newShopItem(it.name);
    shop.unshift(s);
    saveShop(); renderShop();
    toast(`「${it.name}」を買い物リストに入れました`);
  } else {
    toast(`「${it.name}」を冷蔵庫から出しました`);
  }
  scheduleSync();
}

/* ============ 買い物リストの描画 ============ */
const newShopItem = name => ({
  id: uid(), name, qty: 1, unit: '個', expiry: '', done: false,
  by: me, addedAt: Date.now(), updatedAt: Date.now(), deleted: false, dirty: true,
});

function renderShop() {
  const items = live(shop).sort((a, b) => (a.done - b.done) || (b.addedAt - a.addedAt));
  $('#shop-empty').hidden = items.length > 0;

  $('#shop-list').innerHTML = items.map(s => `
    <li class="card ${s.done ? 'is-done' : ''}" data-id="${s.id}" data-cat="${catOf(s.name)}">
      <button class="check" data-act="toggle" aria-label="買った">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
      </button>
      <div class="card-main">
        <div class="card-name">${esc(s.name)}</div>
        <div class="card-sub">${s.by ? esc(s.by) + 'が追加' : '追加済み'}</div>
      </div>
      ${s.done ? '<button class="card-done" data-act="tofridge">冷蔵庫へ</button>' : ''}
      <button class="card-del" data-act="del" aria-label="消す">×</button>
    </li>`).join('');

  $('#shop-list').querySelectorAll('.card').forEach(li => {
    if (pendingEnter.has(li.dataset.id)) li.classList.add('is-enter');
  });

  const left = items.filter(s => !s.done).length;
  const badge = $('#shop-badge');
  badge.textContent = left; badge.hidden = left === 0;
  $('#btn-clear-done').hidden = !items.some(s => s.done);
}

$('#shop-list').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const li = e.target.closest('li');
  const s = shop.find(x => x.id === li.dataset.id);
  if (!s || s.deleted) return;

  if (btn.dataset.act === 'toggle') {
    s.done = !s.done; touch(s); saveShop(); renderShop(); scheduleSync();
  } else if (btn.dataset.act === 'del') {
    removeCard(li, () => { s.deleted = true; touch(s); saveShop(); renderShop(); scheduleSync(); });
  } else if (btn.dataset.act === 'tofridge') {
    openSheet({ name: s.name, fromShopId: s.id });
  }
});

$('#shop-quick').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#shop-input');
  const name = input.value.trim(); if (!name) return;
  const s = newShopItem(name);
  shop.unshift(s);
  pendingEnter.add(s.id);
  saveShop(); renderShop(); scheduleSync();
  input.value = '';
});

$('#btn-clear-done').onclick = () => {
  live(shop).filter(s => s.done).forEach(s => { s.deleted = true; touch(s); });
  saveShop(); renderShop(); scheduleSync();
};

/* ============ 食材追加シート ============ */
let draft = null;

function buildSheetStatics() {
  $('#f-unit').innerHTML = UNITS.map(u => `<button type="button" data-unit="${u}">${u}</button>`).join('');
  renderPresetChips();
}

function renderPresetChips() {
  const chip = name =>
    `<button type="button" class="chip" data-name="${esc(name)}">${esc(name)}</button>`;

  let html = '';
  const recentLive = recent.filter(n => INFO[n] || true).slice(0, 8);
  if (recentLive.length) {
    html += `<div>
      <div class="chip-group-name">最近つかった</div>
      <div class="chip-row">${recentLive.map(chip).join('')}</div>
    </div>`;
  }
  html += PRESETS.map(g => `
    <div>
      <div class="chip-group-name"><span class="chip-dot" style="background:var(--cat-${g.cat})"></span>${CATS[g.cat]}</div>
      <div class="chip-row">${g.items.map(([n]) => chip(n)).join('')}</div>
    </div>`).join('');

  $('#preset-chips').innerHTML = html;
}

function renderQtyChips() {
  $('#qty-chips').innerHTML = qtyChoices(draft.unit)
    .map(q => `<button type="button" class="chip" data-qty="${q}">${q}${draft.unit}</button>`).join('');
}

function openSheet(pre = {}) {
  const info = INFO[pre.name];
  draft = {
    name: pre.name || '',
    qty: info ? info.qty : 1,
    unit: info ? info.unit : '個',
    expiry: info ? inDays(info.days) : '',
    fromShopId: pre.fromShopId || null,
  };
  renderPresetChips();
  syncSheet();
  $('#sheet-backdrop').hidden = false;
  $('#sheet').hidden = false;
  if (!draft.name) setTimeout(() => $('#f-name').focus(), 300);
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  draft = null;
}
function syncSheet(popQty) {
  $('#f-name').value = draft.name;
  const out = $('#f-qty');
  out.textContent = draft.qty;
  if (popQty && !calm()) { out.classList.remove('pop'); void out.offsetWidth; out.classList.add('pop'); }
  $('#f-expiry').value = draft.expiry;
  renderQtyChips();
  document.querySelectorAll('#f-unit button').forEach(b => b.classList.toggle('is-on', b.dataset.unit === draft.unit));
  document.querySelectorAll('#preset-chips .chip').forEach(b => b.classList.toggle('is-on', b.dataset.name === draft.name));
  document.querySelectorAll('#qty-chips .chip').forEach(b => b.classList.toggle('is-on', Number(b.dataset.qty) === draft.qty));
  document.querySelectorAll('#expiry-chips .chip').forEach(b => {
    const d = b.dataset.days;
    b.classList.toggle('is-on', (d === '' ? '' : inDays(Number(d))) === draft.expiry);
  });
}

$('#fab').onclick = () => openSheet();
$('#sheet-cancel').onclick = closeSheet;
$('#sheet-backdrop').onclick = closeSheet;

$('#f-name').addEventListener('input', e => { draft.name = e.target.value; syncSheet(); });

/* 品目をタップしたら、単位・量・期限まで一度に埋まる */
$('#preset-chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const name = c.dataset.name;
  const info = INFO[name];
  draft.name = name;
  if (info) { draft.unit = info.unit; draft.qty = info.qty; draft.expiry = inDays(info.days); }
  syncSheet(true);
});

$('#qty-chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  draft.qty = Number(c.dataset.qty);
  syncSheet(true);
});

$('#f-unit').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const was = isBulk(draft.unit);
  draft.unit = b.dataset.unit;
  if (isBulk(draft.unit) && !was) draft.qty = 100;
  if (!isBulk(draft.unit) && was) draft.qty = 1;
  syncSheet();
});

document.querySelectorAll('.step').forEach(b => b.onclick = () => {
  draft.qty = Math.max(stepOf(draft.unit), draft.qty + Number(b.dataset.step) * stepOf(draft.unit));
  syncSheet(true);
});

$('#expiry-chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const d = c.dataset.days;
  draft.expiry = d === '' ? '' : inDays(Number(d));
  syncSheet();
});
$('#f-expiry').addEventListener('change', e => { draft.expiry = e.target.value; syncSheet(); });

$('#sheet-save').onclick = () => {
  const name = draft.name.trim();
  if (!name) { toast('品目を入れてください'); $('#f-name').focus(); return; }
  const now = Date.now();
  const item = { id: uid(), name, qty: draft.qty, unit: draft.unit, expiry: draft.expiry,
                 done: false, by: me, addedAt: now, updatedAt: now, deleted: false, dirty: true };
  fridge.unshift(item);
  pendingEnter.add(item.id);
  saveFridge();

  recent = [name, ...recent.filter(n => n !== name)].slice(0, 10);
  LS.set('recent', recent);

  if (draft.fromShopId) {
    const s = shop.find(x => x.id === draft.fromShopId);
    if (s) { s.deleted = true; touch(s); saveShop(); renderShop(); }
  }
  closeSheet(); setView('fridge'); renderFridge(); scheduleSync();
  toast(`「${name}」を冷蔵庫に入れました`);
};

/* ============ 家族共有（同期） ============ */
let syncing = false, syncAgain = false, syncTimer = null;
let syncState = 'off', syncNote = '';

function setSyncState(state, note = '') {
  syncState = state; syncNote = note;
  const label = { off: 'この端末だけ', syncing: '同期中', ok: '同期済み', error: '同期できず' }[state];
  $('#sync-text').textContent = label;
  $('#sync-chip').dataset.state = state;
  const detail = $('#sync-detail');
  if (detail) {
    detail.textContent = state === 'error' ? `同期できませんでした：${note}`
      : state === 'ok'  ? `最終同期 ${new Date(LS.get('syncedAt', Date.now())).toLocaleString('ja-JP')}`
      : state === 'syncing' ? '同期中…'
      : '共有URLと家族コードを入れると、家族の端末と同じリストになります。';
  }
}

function scheduleSync(delay = 900) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

const forSend = (it, kind) => ({
  kind, id: it.id, name: it.name, qty: it.qty, unit: it.unit, expiry: it.expiry,
  addedAt: it.addedAt, updatedAt: it.updatedAt, deleted: !!it.deleted,
  by: it.by || '', done: !!it.done,
});

async function sync() {
  if (!cfg.url || !cfg.house) { setSyncState('off'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; setSyncState('syncing');

  try {
    const pending = [
      ...fridge.filter(i => i.dirty).map(i => forSend(i, 'fridge')),
      ...shop.filter(i => i.dirty).map(i => forSend(i, 'shop')),
    ];
    const sentAt = new Map(pending.map(p => [p.kind + p.id, p.updatedAt]));

    // ヘッダを付けない = 単純なリクエストになり、GAS への事前確認(preflight)が発生しない
    const res = await fetch(cfg.url, {
      method: 'POST',
      redirect: 'follow',
      body: JSON.stringify({ action: 'sync', house: cfg.house, since, changes: pending }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'サーバーがエラーを返しました');

    for (const [list, kind] of [[fridge, 'fridge'], [shop, 'shop']]) {
      for (const it of list) {
        if (it.dirty && sentAt.get(kind + it.id) === it.updatedAt) it.dirty = false;
      }
    }

    for (const row of data.rows || []) {
      const list = row.kind === 'fridge' ? fridge : row.kind === 'shop' ? shop : null;
      if (!list) continue;
      const i = list.findIndex(x => x.id === row.id);
      const incoming = {
        id: row.id, name: row.name, qty: row.qty, unit: row.unit, expiry: row.expiry,
        done: !!row.done, by: row.by, addedAt: row.addedAt, updatedAt: row.updatedAt,
        deleted: !!row.deleted, dirty: false,
      };
      if (i < 0) { list.push(incoming); pendingEnter.add(incoming.id); }
      else if ((list[i].updatedAt || 0) < incoming.updatedAt) list[i] = incoming;
    }

    since = data.now;
    fridge = prune(fridge); shop = prune(shop);
    LS.set('syncedAt', Date.now());
    saveAll();
    renderFridge(); renderShop();
    setSyncState('ok');
  } catch (err) {
    const offline = !navigator.onLine;
    setSyncState('error', offline ? 'オフラインです' : String(err.message || err));
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(400); }
  }
}

window.addEventListener('online', () => scheduleSync(200));
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(200); });
setInterval(() => { if (!document.hidden) sync(); }, 60000);

/* ============ 見た目（ライト / ダーク） ============ */
let theme = LS.get('theme', 'auto');

function applyTheme() {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  document.querySelectorAll('#theme-seg button')
    .forEach(b => b.classList.toggle('is-on', b.dataset.theme === theme));
  // ステータスバーの色も合わせる（実際に描かれている地の色を読む）
  const meta = $('#meta-theme');
  if (meta) {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg) meta.setAttribute('content', bg);
  }
}
$('#theme-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  theme = b.dataset.theme;
  LS.set('theme', theme);
  applyTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (theme === 'auto') applyTheme();
});

/* ============ 設定シート ============ */
function openSettings() {
  $('#f-me').value = me;
  $('#f-url').value = cfg.url;
  $('#f-house').value = cfg.house;
  setSyncState(syncState, syncNote);
  $('#set-backdrop').hidden = false; $('#set-sheet').hidden = false;
}
const closeSet = () => { $('#set-sheet').hidden = true; $('#set-backdrop').hidden = true; };

$('#btn-settings').onclick = openSettings;
$('#sync-chip').onclick = openSettings;
$('#set-close').onclick = closeSet;
$('#set-backdrop').onclick = closeSet;

$('#f-me').addEventListener('input', e => { me = e.target.value.trim(); LS.set('me', me); });

function setCfg(patch) {
  const before = cfg.url + '|' + cfg.house;
  cfg = Object.assign({}, cfg, patch);
  LS.set('cfg', cfg);
  if (before !== cfg.url + '|' + cfg.house) {
    since = 0; LS.set('since', 0);
    fridge.forEach(i => i.dirty = true);
    shop.forEach(i => i.dirty = true);
    saveAll();
  }
  setSyncState(cfg.url && cfg.house ? (syncState === 'off' ? 'syncing' : syncState) : 'off');
}
$('#f-url').addEventListener('change', e => { setCfg({ url: e.target.value.trim() }); scheduleSync(200); });
$('#f-house').addEventListener('change', e => { setCfg({ house: e.target.value.trim() }); scheduleSync(200); });

$('#btn-make-house').onclick = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';   // 読み間違えにくい文字だけ
  let code = '';
  for (let i = 0; i < 10; i++) code += abc[Math.floor(Math.random() * abc.length)];
  $('#f-house').value = code;
  setCfg({ house: code });
  scheduleSync(200);
  toast('家族コードを作りました。家族に同じものを入れてもらってください');
};

$('#btn-sync-now').onclick = () => {
  if (!cfg.url || !cfg.house) { toast('共有URLと家族コードを入れてください'); return; }
  sync();
};

$('#btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify({ fridge, shop, me, cfg, exportedAt: new Date().toISOString() }, null, 2)],
                        { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fridge-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* イラストがゆっくり動いて奥行きを出す（スクロールに半分だけついてくる） */
(() => {
  const img = $('#hero-img');
  if (!img || calm()) return;
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = Math.max(0, Math.min(scrollY, 300));
      img.style.transform = `translateY(${y * 0.34}px) scale(${1 + y / 2600})`;
      ticking = false;
    });
  }, { passive: true });
})();

/* ============ 起動 ============ */
applyTheme();
buildSheetStatics();
live(fridge).forEach(i => pendingEnter.add(i.id));   // 最初の一覧はふわっと出す
renderFridge();
renderShop();
setView('fridge');
setSyncState(cfg.url && cfg.house ? 'syncing' : 'off');
saveAll();
scheduleSync(300);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
