/* アルノポケット — 触ったときに起きること */

/* LINE などアプリ内ブラウザで開かれているか。
 * ここから「他のブラウザで開く」を選ぶと、端末の控え（localStorage）は
 * 引き継がれず、家族コードだけが消えたように見える。
 * URL に合言葉を残しておけば、開き直した先でもそのまま仲間に入れる。 */
const IN_APP_BROWSER = /Line\/|FBAN|FBAV|Instagram|MicroMessenger|KAKAOTALK/i.test(navigator.userAgent);

/* 招待リンク。合言葉は ? のほうに置く。
 * # から後ろはアプリ内ブラウザの受け渡しで落ちることがあるため。 */
function inviteUrl(code) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `${base}?join=${encodeURIComponent(code)}`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); return true; }
  catch { toast('この端末ではコピーできませんでした'); return false; }
}

/* ============ タブ・棚を開く ============ */
$$('.tab').forEach(b => b.onclick = () => setView(b.dataset.view));
$('#shelf-back').onclick = () => setView('home');

$('#shelf-grid').addEventListener('click', e => {
  if (e.target.closest('#tile-add')) { openShelfEditor(); return; }
  const tile = e.target.closest('.shelf-tile');
  if (tile && tile.dataset.shelf) openShelf(tile.dataset.shelf);
});

$('#urgent-list').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (li) openShelf(li.dataset.shelf);
});

$('#soon-list').addEventListener('click', e => {
  const li = e.target.closest('li');
  if (li) openShelf(li.dataset.shelf);
});

$('#shelf-tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  shelfTab = b.dataset.tab;
  renderShelf();
});

/* ============ 棚の中の操作 ============ */
$('#shelf-list').addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  const it = items.find(x => x.id === li.dataset.id);
  if (!it || it.deleted) return;

  const act = (e.target.closest('[data-act]') || {}).dataset?.act;
  if (!act) return;
  if (act === 'inc' || act === 'dec' || act === 'stock') hopChar(li);

  if (act === 'inc') {
    const from = it.qty;
    it.qty += stepOf(it.unit);
    pendingPop.add(it.id);
    touch(it, '増やした', { from, to: it.qty });
  } else if (act === 'dec') {
    const from = it.qty;
    it.qty = Math.max(0, it.qty - stepOf(it.unit));
    if (it.qty === 0) return removeCard(li, () => useUp(it));
    pendingPop.add(it.id);
    touch(it, '減らした', { from, to: it.qty });
  } else if (act === 'stock') {
    /* たっぷり → はんぶん → のこりわずか → きれた → たっぷり と回る */
    const order = ['full','half','low','empty'];
    const from = it.stock;
    it.stock = order[(order.indexOf(it.stock) + 1) % order.length];
    if (it.stock === 'empty') return removeCard(li, () => useUp(it, true));
    /* きれた → たっぷり は補充。ここを補充として残さないと、
     * 次に切れたときの「何日もったか」が前の補充から数えられてしまう（機能F） */
    touch(it, from === 'empty' ? '増やした' : '残量を変えた',
          { from: stockLabel(from), to: stockLabel(it.stock) });
  } else if (act === 'use') {
    popFx(e.target.closest('[data-act]'));
    return removeCard(li, () => useUp(it));
  } else if (act === 'hist') {
    return openHistory(it);
  } else {
    return;
  }

  saveItems(); renderShelf(); renderHome(); renderStats(); scheduleSync();
});

/* 使い切ったら棚から出し、同じものが買い物リストに無ければ足す */
function useUp(it, keepRecord) {
  noteCycle(it);                 /* 何日もったかを覚えておく（機能F） */
  if (keepRecord) {
    touch(it, 'きれた');
  } else {
    it.deleted = true;
    touch(it, '使い切った');
  }
  saveItems();

  if (!live(shop).some(s => !s.done && s.name === it.name)) {
    const s = newShopItem(it.name);
    shop.unshift(s); pendingEnter.add(s.id);
    saveShop();
    fireMood('use-up', it.name);
  } else {
    toast(`「${it.name}」は買い物リストにもう入っています`);
  }
  renderAll();
  scheduleSync();
}

const newShopItem = name => normalize({
  id: uid(), name, qty: 1, unit: '個', shelf: shelfId,
  by: settings.me, addedAt: Date.now(), updatedAt: Date.now(), dirty: true,
});

/* ============ これまで（機能B） ============ */
const ACTION_ICON = { '入れた':'＋', '増やした':'↑', '減らした':'↓', '使い切った':'✓', 'きれた':'✓', '残量を変えた':'●', '写真から入れた':'📷' };

function openHistory(it) {
  $('#hist-title').textContent = `${it.name} のこれまで`;
  const rows = (it.history || []).slice().reverse();
  $('#hist-list').innerHTML = rows.length
    ? rows.map(h => `<li>
        <span class="hist-when type-mono">${new Date(h.at).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}</span>
        <span class="hist-who">${esc(h.by || 'だれか')}</span>
        <span class="hist-what">${esc(h.action)}${h.from !== undefined ? `（${esc(h.from)} → ${esc(h.to)}）` : ''}</span>
      </li>`).join('')
    : '<li class="muted type-body-sm">まだ記録はありません。</li>';
  showLayer($('#hist-backdrop'), $('#hist-sheet'));
}
const closeHistory = () => hideLayer($('#hist-sheet'), $('#hist-backdrop'));
$('#hist-close').onclick = closeHistory;
$('#hist-backdrop').onclick = closeHistory;

/* ============ 追加シート ============ */
let draft = null;

function openSheet(pre = {}) {
  const sh = shelfOf(pre.shelf || shelfId);
  const info = INFO[pre.name];
  draft = {
    name: pre.name || '',
    shelf: sh.id,
    mode: pre.mode || sh.mode || 'qty',
    qty: info ? info.qty : 1,
    unit: info ? info.unit : '個',
    expiry: info && info.days ? inDays(info.days) : '',
    target: null,
    stock: 'full',
    stockTarget: 'low',
    fromShopId: pre.fromShopId || null,
  };
  buildSheetStatics();
  syncSheet();
  showLayer($('#sheet-backdrop'), $('#sheet'));
  syncSegPills($('#sheet'));        /* 出してから測る。隠れている間は幅0 */
  if (!draft.name) setTimeout(() => $('#f-name').focus(), 300);
}
function closeSheet() {
  hideLayer($('#sheet'), $('#sheet-backdrop'));
  draft = null;
}

function buildSheetStatics() {
  $('#f-shelf').innerHTML = settings.shelves
    .map(s => `<button type="button" class="chip" data-shelf="${esc(s.id)}"><img src="${shelfIconSrc(s.icon)}" alt="">${esc(s.name)}</button>`).join('');
  $('#f-unit').innerHTML = UNITS.map(u => `<button type="button" data-unit="${u}">${u}</button>`).join('');
  $('#f-stock').innerHTML = STOCK_LEVELS.map(s => `<button type="button" data-stock="${s.id}">${s.label}</button>`).join('');
  $('#f-stock-target').innerHTML = STOCK_LEVELS.filter(s => s.id !== 'full')
    .map(s => `<button type="button" data-stock-target="${s.id}">${s.label}</button>`).join('');
  renderPresetChips();
}

function renderPresetChips() {
  const chip = name => `<button type="button" class="chip" data-name="${esc(name)}">${esc(name)}</button>`;
  let html = '';
  if (recent.length) {
    html += `<div><div class="chip-group-name type-label">最近つかった</div>
      <div class="chip-row">${recent.slice(0, 8).map(chip).join('')}</div></div>`;
  }
  html += PRESETS.map(g => `<div>
    <div class="chip-group-name type-label">${esc(g.group)}</div>
    <div class="chip-row">${g.items.map(([n]) => chip(n)).join('')}</div></div>`).join('');
  $('#preset-chips').innerHTML = html;
}

function syncSheet(popQty) {
  $('#f-name').value = draft.name;
  $('#qty-block').hidden = draft.mode !== 'qty';
  $('#stock-block').hidden = draft.mode !== 'stock';

  const out = $('#f-qty');
  out.textContent = draft.qty;
  if (popQty && !calm()) { out.classList.remove('motion-pop'); void out.offsetWidth; out.classList.add('motion-pop'); }
  $('#f-expiry').value = draft.expiry;

  $('#qty-chips').innerHTML = qtyChoices(draft.unit)
    .map(q => `<button type="button" class="chip" data-qty="${q}">${q}${esc(draft.unit)}</button>`).join('');
  /* 目標数（機能A）。いまの量を基準に、ありそうな線だけ出す */
  const base = Math.max(1, draft.qty);
  const cands = isBulk(draft.unit) ? [50, 100, 200] : [1, 2, 3, Math.max(1, Math.floor(base / 2))];
  const uniq = [...new Set(cands)].sort((a, b) => a - b);
  $('#target-chips').innerHTML =
    `<button type="button" class="chip" data-target="">決めない</button>` +
    uniq.map(t => `<button type="button" class="chip" data-target="${t}">${t}${esc(draft.unit)}</button>`).join('');

  const mark = (sel, fn) => $$(sel).forEach(b => b.classList.toggle('is-on', fn(b)));
  mark('#f-shelf .chip',   b => b.dataset.shelf === draft.shelf);
  mark('#f-mode button',   b => b.dataset.mode === draft.mode);
  mark('#f-unit button',   b => b.dataset.unit === draft.unit);
  mark('#f-stock button',  b => b.dataset.stock === draft.stock);
  mark('#f-stock-target button', b => b.dataset.stockTarget === draft.stockTarget);
  mark('#qty-chips .chip', b => Number(b.dataset.qty) === draft.qty);
  mark('#target-chips .chip', b => (b.dataset.target === '' ? null : Number(b.dataset.target)) === draft.target);
  mark('#preset-chips .chip', b => b.dataset.name === draft.name);
  mark('#expiry-chips .chip', b => (b.dataset.days === '' ? '' : inDays(Number(b.dataset.days))) === draft.expiry);

  syncSegPills($('#sheet'));
}

$('#fab').onclick = () => openSheet();
$('#sheet-cancel').onclick = closeSheet;
$('#sheet-backdrop').onclick = closeSheet;
$('#f-name').addEventListener('input', e => { draft.name = e.target.value; syncSheet(); });

$('#f-shelf').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  draft.shelf = c.dataset.shelf;
  draft.mode = shelfOf(draft.shelf).mode || draft.mode;
  syncSheet();
});
$('#f-mode').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  draft.mode = b.dataset.mode; syncSheet();
});
$('#preset-chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const name = c.dataset.name, info = INFO[name];
  draft.name = name;
  if (info) {
    draft.unit = info.unit; draft.qty = info.qty;
    draft.expiry = info.days ? inDays(info.days) : '';
    if (settings.shelves.some(s => s.id === info.shelf)) draft.shelf = info.shelf;
  }
  syncSheet(true);
});
$('#qty-chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  draft.qty = Number(c.dataset.qty); syncSheet(true);
});
$('#target-chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  draft.target = c.dataset.target === '' ? null : Number(c.dataset.target);
  syncSheet();
});
$('#f-unit').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const was = isBulk(draft.unit);
  draft.unit = b.dataset.unit;
  if (isBulk(draft.unit) && !was) draft.qty = 100;
  if (!isBulk(draft.unit) && was) draft.qty = 1;
  draft.target = null;
  syncSheet();
});
$('#f-stock').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  draft.stock = b.dataset.stock; syncSheet();
});
$('#f-stock-target').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  draft.stockTarget = b.dataset.stockTarget; syncSheet();
});
$$('.step').forEach(b => b.onclick = () => {
  draft.qty = Math.max(stepOf(draft.unit), draft.qty + Number(b.dataset.step) * stepOf(draft.unit));
  syncSheet(true);
});
$('#expiry-chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  draft.expiry = c.dataset.days === '' ? '' : inDays(Number(c.dataset.days));
  syncSheet();
});
$('#f-expiry').addEventListener('change', e => { draft.expiry = e.target.value; syncSheet(); });

$('#sheet-save').onclick = () => {
  const name = draft.name.trim();
  if (!name) { toast('なにを入れるか書いてください'); $('#f-name').focus(); return; }
  const it = addItem({
    name, shelf: draft.shelf, mode: draft.mode, qty: draft.qty, unit: draft.unit,
    expiry: draft.expiry, target: draft.target, stock: draft.stock, stockTarget: draft.stockTarget,
  });
  if (draft.fromShopId) {
    const s = shop.find(x => x.id === draft.fromShopId);
    if (s) { s.deleted = true; touch(s); saveShop(); }
  }
  shelfId = it.shelf;
  closeSheet();
  setView('shelf'); renderAll();
  burst($('#fab'), 14);          // 1品なら控えめに
  fireMood('add-one', name);
  scheduleSync();
};

function addItem(fields, action = '入れた') {
  const now = Date.now();
  const it = normalize(Object.assign({
    id: uid(), by: settings.me, addedAt: now, updatedAt: now, dirty: true, history: [],
  }, fields));
  it.history = [{ at: now, by: settings.me || '', action }];
  items.unshift(it);
  pendingEnter.add(it.id);
  recent = [it.name, ...recent.filter(n => n !== it.name)].slice(0, 10);
  LS.set('recent', recent);
  saveItems();
  return it;
}

/* ============ 買うもの ============ */
$('#shop-list').addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  const s = shop.find(x => x.id === li.dataset.id);
  if (!s || s.deleted) return;
  const act = (e.target.closest('[data-act]') || {}).dataset?.act;

  if (act === 'toggle') {
    s.done = !s.done; touch(s, s.done ? '買った' : '戻した');
    hopChar(li);
    saveShop(); renderShop(); scheduleSync();
    if (s.done && !live(shop).some(x => !x.done)) {
      burst($('#shop-progress'));      // ぜんぶ買えた瞬間だけの、ごほうび
      fireMood('shop-all-done');
    }
  } else if (act === 'del') {
    removeCard(li, () => { s.deleted = true; touch(s); saveShop(); renderShop(); scheduleSync(); });
  } else if (act === 'toshelf') {
    openSheet({ name: s.name, fromShopId: s.id });
  }
});

$('#shop-quick').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#shop-input');
  const name = input.value.trim(); if (!name) return;
  const s = newShopItem(name);
  shop.unshift(s); pendingEnter.add(s.id);
  saveShop(); renderShop(); scheduleSync();
  input.value = '';
  fireMood('shop-added', name);
});

$('#btn-clear-done').onclick = () => {
  live(shop).filter(s => s.done).forEach(s => { s.deleted = true; touch(s); });
  saveShop(); renderShop(); scheduleSync();
};

/* ============ ことづて（機能C） ============ */
function sendChat(text) {
  const t = String(text || '').trim(); if (!t) return;
  const now = Date.now();
  chat.push(normalize({ id: uid(), name: t, by: settings.me || '', addedAt: now, updatedAt: now, dirty: true }));
  chat = chat.slice(-100);
  saveChat(); renderChat(); scheduleSync(300);
  fireMood('chat-sent');
}
$('#chat-form').addEventListener('submit', e => {
  e.preventDefault();
  sendChat($('#chat-input').value);
  $('#chat-input').value = '';
});
$('#chat-stamps').addEventListener('click', e => {
  const b = e.target.closest('[data-stamp]'); if (!b) return;
  sendChat(b.dataset.stamp);
});

/* ============ 写真から入れる（機能E も同じ入口） ============ */
let reviewRows = [];

/* 読み間違えにくい文字だけで家族コードを作る。
 * サーバー側が新しい家に12文字以上を求めるので、それより長くする */
function newHouseCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 14; i++) code += abc[Math.floor(Math.random() * abc.length)];
  return code;
}

/* 写真の読み取りや献立を頼む前に、この端末に家族コードがあることを確かめる。
 *
 * 以前はここで「先に設定を済ませてください」と設定画面へ追い返していた。
 * けれど入れたばかりの端末は棚が空で、それを埋めるための「パチリ」が
 * まさにこの入口。最初の一歩で追い返していたことになる。
 * ひとりで使うぶんには家族コードはただの目印なので、無ければ黙って作る。
 *
 * ここで await してはいけない。指で押した流れが切れると、
 * iPhone ではカメラが開かなくなる。合わせるのは後追いにして、
 * 間に合わなかったぶんは postAI が頼み直してくれる。 */
function needsAI() {
  if (!settings.url) {
    toast('つなぎ先が空です。「設定 > 共有」で共有URLを入れてください');
    openSettings('share');
    return true;
  }
  if (!settings.house) {
    setShare({ house: newHouseCode() });   // 中で同期も始まる
    toast('この端末の家族コードを作りました');
  }
  return false;
}

$('#btn-shoot').onclick = () => { if (!needsAI()) $('#file-shelf').click(); };
$('#btn-share-shop').onclick = () => shareText(shopAsText());
$('#btn-receipt').onclick = () => { if (!needsAI()) $('#file-receipt').click(); };

function showRecognizing(title, sub) {
  $('#recog-title').textContent = title;
  $('#recog-sub').textContent = sub;
  const c = settings.loadingCharMode === 'fixed' ? settings.loadingChar : 'star';
  $('#recog-char').src = charSrc(c);
  showLayer($('#recognizing'));
}
const hideRecognizing = () => hideLayer($('#recognizing'));
$('#recog-cancel').onclick = hideRecognizing;

$('#file-shelf').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  showRecognizing('なにがあるかな〜', 'じっくり見ています');
  try {
    const dataUrl = await shrinkImage(file);
    const res = await aiRecognize(dataUrl, shelfId);
    hideRecognizing();
    const found = (res.items || []).filter(x => x && x.name);
    if (!found.length) return fireMood('recognize-empty');
    openReview(found.map(x => ({
      name: String(x.name),
      qty: Number(x.qty) || 1,
      unit: x.unit || '個',
      shelf: settings.shelves.some(s => s.id === x.shelf) ? x.shelf : shelfId,
      expiry: x.expiry || '',
      confidence: Number(x.confidence ?? 1),
      on: true,
    })), 'shelf');
  } catch (err) {
    hideRecognizing();
    fireMood('recognize-fail');
    toast(String(err.message || err));
  }
});

$('#file-receipt').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  showRecognizing('レシート、読むね', '書いてあるものを拾っています');
  try {
    const dataUrl = await shrinkImage(file);
    const res = await aiReadReceipt(dataUrl);
    hideRecognizing();
    const found = (res.items || []).filter(x => x && x.name);
    if (!found.length) return fireMood('recognize-empty');
    openReview(found.map(x => ({
      name: String(x.name), qty: Number(x.qty) || 1, unit: x.unit || '個',
      shelf: settings.shelves.some(s => s.id === x.shelf) ? x.shelf : 'fridge',
      expiry: '', confidence: Number(x.confidence ?? 1), on: true,
    })), 'receipt');
  } catch (err) {
    hideRecognizing();
    fireMood('recognize-fail');
    toast(String(err.message || err));
  }
});

let reviewKind = 'shelf';
function openReview(rows, kind) {
  reviewRows = rows; reviewKind = kind;
  $('#review-title').textContent = `${rows.length}品 みつけた！`;
  $('#review-ok').textContent = kind === 'receipt' ? `${rows.length}品を片付ける` : `${rows.length}品を入れる`;
  renderReview();
  showLayer($('#review'));
  revealReview();
}
function renderReview() {
  $('#review-list').innerHTML = reviewRows.map((r, i) => {
    const unsure = r.confidence < 0.75;
    return `<li class="card ${unsure ? 'is-urgent' : ''}" data-i="${i}">
      <button class="check ${r.on ? 'is-on' : ''}" data-act="toggle" aria-label="入れる">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
      </button>
      <img class="card-char" src="${charSrc(charForItem(r.name))}" alt="">
      <div class="card-main">
        <div class="card-name">${esc(r.name)}</div>
        <div class="card-sub type-caption muted">${esc(shelfOf(r.shelf).name)} ・ ${r.qty}${esc(r.unit)}</div>
      </div>
      ${unsure ? '<i class="card-badge">たしかめて</i>' : ''}
    </li>`;
  }).join('');
  const n = reviewRows.filter(r => r.on).length;
  $('#review-ok').textContent = reviewKind === 'receipt' ? `${n}品を片付ける` : `${n}品を入れる`;
  $('#review-ok').disabled = n === 0;
}

/* 骨組み（認識中）から中身への差し替え。最初に出すときだけ演出する
 * （チェックを付け外しするたびに全部が出直すと、うるさいだけになる）。 */
let revealTimer;
function revealReview() {
  const list = $('#review-list');
  if (calm()) return;
  const rows = $$('#review-list .card');
  rows.forEach((li, i) => li.style.setProperty('--d', `calc(var(--dur-stagger) * ${i})`));
  list.classList.remove('is-revealing'); void list.offsetWidth; list.classList.add('is-revealing');
  /* 出し終わったら印を外す。付けっぱなしだと、チェックを付け外しして
   * 描き直すたびに全行が出直して、ちらついて見える。 */
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => list.classList.remove('is-revealing'), 420 + rows.length * 40);
}
$('#review-list').addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  const r = reviewRows[Number(li.dataset.i)];
  r.on = !r.on;
  renderReview();
});
const closeReview = () => { hideLayer($('#review')); reviewRows = []; };
$('#review-close').onclick = closeReview;
$('#review-retry').onclick = () => { closeReview(); (reviewKind === 'receipt' ? $('#file-receipt') : $('#file-shelf')).click(); };

$('#review-ok').onclick = () => {
  const picked = reviewRows.filter(r => r.on);
  if (reviewKind === 'receipt') {
    /* レシートは「買ってきたもの」。買い物リストの同名を買った印にし、棚にも入れる */
    let closed = 0;
    for (const r of picked) {
      const s = live(shop).find(x => !x.done && x.name === r.name);
      if (s) { s.done = true; touch(s, '買った'); closed++; }
      addItem({ name: r.name, shelf: r.shelf, mode: shelfOf(r.shelf).mode, qty: r.qty, unit: r.unit },
              'レシートから入れた');
    }
    saveShop();
    closeReview(); renderAll(); scheduleSync();
    burst($('#shop-progress'));
    fireMood('receipt-done', closed || picked.length);
  } else {
    for (const r of picked) {
      addItem({ name: r.name, shelf: r.shelf, mode: shelfOf(r.shelf).mode, qty: r.qty, unit: r.unit, expiry: r.expiry },
              '写真から入れた');
    }
    closeReview(); renderAll(); scheduleSync();
    burst($('#view-shelf'));
    fireMood('add-batch-success', picked.length);
  }
};

/* ============ レシピ（機能G） ============ */
/* 献立に渡す材料。食べものの棚にあるものだけ */
function foodOnHand() {
  const foodShelves = settings.shelves.filter(s => FOOD_SHELF_ICONS.includes(s.icon)).map(s => s.id);
  return live(items)
    .filter(i => foodShelves.includes(i.shelf))
    .map(i => ({ name: i.name, qty: i.qty, unit: i.unit, daysLeft: daysLeft(i.expiry) }));
}

/* 「ほかにも」＝今日の分 ／ 「考えてもらう」＝1週間分。押すボタンは同じ */
$('#btn-recipes').onclick = async () => {
  if (recipeTab === 'week') return planWeekNow();
  if (needsAI()) return;
  const have = foodOnHand();
  if (!have.length) { toast('食べものの棚がまだ空っぽです'); return; }

  showRecognizing('なに作ろっか〜', '棚の中を見ています');
  try {
    const res = await aiSuggestRecipes({ have, avoid: recipes.map(r => r.title) });
    hideRecognizing();
    /* 「あるもので作れる」を先に並べる。買い足し無しで動ける案から目に入るように */
    const order = { asis: 0, plus: 1 };
    recipes = (res.recipes || [])
      .slice(0, 4)
      .sort((a, b) => (order[a.kind] ?? 1) - (order[b.kind] ?? 1));
    LS.set('recipes', recipes);
    renderRecipes();
    if (recipes.length) {
      fireMood('recipe-ready');
    } else {
      /* 0件で返るのは、棚が調味料や飲みものばかりのとき。
       * 「思いつかなかった」だけだと打つ手が分からないので、次の一手を伝える */
      fireMood('recipe-fail');
      toast('棚に主な食材が少ないみたいです。野菜や肉を1つ2つ入れてから、もう一度どうぞ');
    }
  } catch (err) {
    hideRecognizing();
    fireMood('recipe-fail');
    toast(String(err.message || err));
  }
};

/* 1週間分。今日の分より時間がかかるので、待ち画面の言い方を変えている */
async function planWeekNow() {
  if (needsAI()) return;
  const have = foodOnHand();
  if (!have.length) { toast('食べものの棚がまだ空っぽです'); return; }
  if (weekPlan && !confirm('いまの1週間分を作り直しますか。\n前のものは消えます。')) return;

  showRecognizing('1週間ぶん、考えるね', '使い切る順番を組み立てています');
  try {
    const res = await aiPlanWeek({ have, people: settings.people || '2人' });
    hideRecognizing();
    const days = (res.days || []).slice(0, 7);
    if (!days.length) {
      fireMood('recipe-fail');
      toast('うまく組み立てられませんでした。棚に食材を少し足して、もう一度どうぞ');
      return;
    }
    weekPlan = { days, buyAll: res.buyAll || [], madeAt: Date.now() };
    LS.set('weekPlan', weekPlan);
    renderRecipes();
    fireMood('recipe-ready');
  } catch (err) {
    hideRecognizing();
    fireMood('recipe-fail');
    toast(String(err.message || err));
  }
}

/* まとめ買いを買うものへ。すでに同じ名前が並んでいるものは足さない */
$('#btn-week-to-shop').onclick = () => {
  const buys = (weekPlan && weekPlan.buyAll) || [];
  if (!buys.length) return;
  const already = new Set(live(shop).map(s => s.name));
  let added = 0;
  buys.forEach(b => {
    const name = String(b.name || '').trim();
    if (!name || already.has(name)) return;
    shop.push(newShopItem(name));
    already.add(name);
    added++;
  });
  if (!added) { toast('もう全部、買うものに入っています'); return; }
  saveShop(); renderShop(); renderHome(); scheduleSync();
  burst($('#btn-week-to-shop'), 14);
  toast(`${added}品を買うものに入れました`);
};

$('#recipe-tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  recipeTab = b.dataset.rtab;
  renderRecipes();
});

$('#recipe-list').addEventListener('click', e => {
  const card = e.target.closest('.recipe'); if (!card) return;
  const act = (e.target.closest('[data-act]') || {}).dataset?.act;
  if (act === 'steps') {
    const box = card.querySelector('.recipe-steps');
    box.hidden = !box.hidden;
    e.target.textContent = box.hidden ? '手順を見る' : '手順を閉じる';
  } else if (act === 'tobuy') {
    const r = recipes[Number(card.dataset.i)];
    let n = 0;
    for (const name of r.buy || []) {
      if (live(shop).some(s => !s.done && s.name === name)) continue;
      const s = newShopItem(name);
      shop.unshift(s); pendingEnter.add(s.id); n++;
    }
    saveShop(); renderShop(); scheduleSync();
    toast(n ? `${n}品を買い物リストに入れました` : 'もう全部リストにあります');
  }
});

/* ============ 通知（機能D：棚べつ ON/OFF） ============ */
const NOTIF_HOURS = { morning: [7, 10], anytime: [0, 23], evening: [16, 20] };

function notifyOn(shelfIdToCheck) {
  return settings.notifByShelf[shelfIdToCheck] !== false;
}

async function askNotifPermission() {
  if (!('Notification' in window)) { toast('この端末は通知に対応していません'); return false; }
  if (Notification.permission === 'granted') return true;
  const res = await Notification.requestPermission();
  if (res !== 'granted') toast('通知はブラウザの設定から許可してください');
  return res === 'granted';
}

/* アプリを開いたときに「今日ぶんの声かけ」をする。
 * バックグラウンドで鳴らすには Push サーバが要るので、そこは踏み込まない */
function maybeNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const [from, to] = NOTIF_HOURS[settings.notifTiming] || NOTIF_HOURS.anytime;
  const h = new Date().getHours();
  if (h < from || h > to) return;
  const today = ymd(new Date());
  if (LS.get('notifiedOn', '') === today) return;

  const targets = live(items).filter(i => isUrgent(i) && notifyOn(i.shelf));
  if (!targets.length) return;

  const names = targets.slice(0, 3).map(i => i.name).join('、');
  new Notification('アルノポケット', {
    body: `${names}${targets.length > 3 ? ' ほか' : ''}、気にしておいてね`,
    icon: 'icon-180.png', tag: 'arumo-daily',
  });
  LS.set('notifiedOn', today);
}

/* ============ 棚をつくる・なおす ============ */
let shelfDraft = null;

function openShelfEditor(existing) {
  shelfDraft = existing
    ? Object.assign({}, existing)
    : { id: 'shelf-' + uid(), name: '', icon: 'custom', color: 'custom', mode: 'qty', isCustom: true };
  openSettings('shelves');
  setTimeout(() => {
    const el = $('#shelf-editor-name');
    if (el) el.focus();
  }, 250);
}

/* ============ 設定シート（7つのタブ） ============ */
let setTab = 'basic';

function openSettings(tab) {
  if (tab) setTab = tab;
  $$('#set-tabs button').forEach(b => b.classList.toggle('is-on', b.dataset.t === setTab));
  renderSettings();
  showLayer($('#set-backdrop'), $('#set-sheet'));
  syncSegPills($('#set-sheet'));
}
const closeSettings = () => {
  commitShare();
  hideLayer($('#set-sheet'), $('#set-backdrop'));
  shelfDraft = null;
  renderAll();
};
$('#set-close').onclick = closeSettings;
$('#set-backdrop').onclick = closeSettings;
$('#house-chip').onclick = () => openSettings('basic');
$('#sync-chip').onclick = () => openSettings('share');
$('#set-tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  commitShare();
  setTab = b.dataset.t;
  openSettings();
});
/* 打ちかけのままアプリを閉じられても、そこまでは残す */
addEventListener('pagehide', commitShare);
document.addEventListener('visibilitychange', () => { if (document.hidden) commitShare(); });

const MEMBER_COLORS = ['mint','pink','butter','lavender','sky','peach'];

function renderSettings() {
  const body = $('#set-body');

  if (setTab === 'basic') {
    body.innerHTML = `
      <label class="field-label">あなたのお名前</label>
      <input id="s-me" type="text" class="field" value="${esc(settings.me)}" placeholder="例：あきえ" autocomplete="off">
      <p class="hint type-caption">誰が動かしたかが、履歴と分析に残ります。</p>

      <label class="field-label">家の名前</label>
      <input id="s-house-name" type="text" class="field" value="${esc(settings.houseName)}" placeholder="例：たかだ家" autocomplete="off">

      <label class="field-label">見た目</label>
      <div class="seg" id="s-theme">
        ${[['auto','端末に合わせる'],['light','ライト'],['dark','ダーク']]
          .map(([v, l]) => `<button type="button" data-theme="${v}" class="${settings.theme === v ? 'is-on' : ''}">${l}</button>`).join('')}
      </div>

      <label class="field-label">写真のたしかめ方</label>
      <div class="seg" id="s-review-mode">
        ${[['batch','一覧でまとめて'],['swipe','1品ずつ']]
          .map(([v, l]) => `<button type="button" data-rm="${v}" class="${settings.reviewMode === v ? 'is-on' : ''}">${l}</button>`).join('')}
      </div>`;

  } else if (setTab === 'names') {
    body.innerHTML = `
      <label class="field-label">家族</label>
      <ul class="member-list">${settings.members.map((m, i) => `
        <li data-i="${i}">
          <button class="member-dot" data-act="color" style="background:var(--brand-${m.color})" aria-label="色を変える"></button>
          <input class="field flat" data-act="name" value="${esc(m.name)}" placeholder="名前">
          <button class="mini" data-act="del" aria-label="消す">×</button>
        </li>`).join('')}</ul>
      <button id="s-member-add" class="btn-ghost wide">＋ 家族を足す</button>
      <p class="hint type-caption">名前は買い物リストや履歴の「誰が」に使われます。</p>`;

  } else if (setTab === 'shelves') {
    body.innerHTML = `
      ${shelfDraft ? `
        <div class="editor">
          <label class="field-label">棚の名前</label>
          <input id="shelf-editor-name" type="text" class="field" value="${esc(shelfDraft.name)}" placeholder="例：キャンプ道具">
          <label class="field-label">数え方</label>
          <div class="seg" id="shelf-editor-mode">
            ${[['qty','個数'],['stock','残量']].map(([v, l]) =>
              `<button type="button" data-mode="${v}" class="${shelfDraft.mode === v ? 'is-on' : ''}">${l}</button>`).join('')}
          </div>
          <label class="field-label">色</label>
          <div class="chip-row" id="shelf-editor-color">
            ${SHELF_COLORS.map(c => `<button type="button" class="swatch ${shelfDraft.color === c ? 'is-on' : ''}" data-color="${c}" style="background:var(--shelf-${c})" aria-label="${c}"></button>`).join('')}
          </div>
          <label class="field-label">アイコン</label>
          ${SHELF_ICONS.map(g => `<div class="chip-group-name type-label">${g.group}</div>
            <div class="icon-grid">${g.ids.map(id => `
              <button type="button" class="icon-pick ${shelfDraft.icon === id ? 'is-on' : ''}" data-icon="${id}" title="${esc(SHELF_ICON_NAMES[id])}">
                <img src="${shelfIconSrc(id)}" alt="${esc(SHELF_ICON_NAMES[id])}">
              </button>`).join('')}</div>`).join('')}
          <div class="row-between" style="margin-top:14px">
            <button id="shelf-editor-cancel" class="btn-text">やめる</button>
            <button id="shelf-editor-save" class="btn-primary sm">この棚をつくる</button>
          </div>
        </div>` : `
        <ul class="shelf-edit-list">${settings.shelves.map(s => `
          <li data-shelf="${esc(s.id)}">
            <img src="${shelfIconSrc(s.icon)}" alt="">
            <input class="field flat" data-act="name" value="${esc(s.name)}">
            <span class="type-caption muted">${s.mode === 'stock' ? '残量' : '個数'}</span>
            <button class="mini" data-act="edit" aria-label="なおす">…</button>
            ${settings.shelves.length > 1 ? '<button class="mini" data-act="del" aria-label="消す">×</button>' : ''}
          </li>`).join('')}</ul>
        <button id="s-shelf-add" class="btn-ghost wide">＋ 棚をつくる</button>
        <p class="hint type-caption">棚を消しても、中の品目は消えません（別の棚に移してから消すのがおすすめです）。</p>`}`;

  } else if (setTab === 'chars') {
    const block = (which, label) => `
      <label class="field-label">${label}</label>
      <div class="seg" data-charmode="${which}">
        ${[['auto','中身に合わせる'],['fixed','この子で固定']].map(([v, l]) =>
          `<button type="button" data-v="${v}" class="${settings[which + 'CharMode'] === v ? 'is-on' : ''}">${l}</button>`).join('')}
      </div>
      ${CHAR_GROUPS.map(g => `<div class="chip-group-name type-label">${g.group}</div>
        <div class="icon-grid">${g.ids.map(id => `
          <button type="button" class="icon-pick ${settings[which + 'Char'] === id ? 'is-on' : ''}" data-charpick="${which}" data-id="${id}" title="${esc(CHAR_NAMES[id])}">
            <img src="${charSrc(id)}" alt="${esc(CHAR_NAMES[id])}">
          </button>`).join('')}</div>`).join('')}`;
    body.innerHTML = block('hero', 'ホームの子') + block('loading', '待っているときの子');

  } else if (setTab === 'notif') {
    body.innerHTML = `
      <button id="s-notif-ask" class="btn-ghost wide">${
        ('Notification' in window && Notification.permission === 'granted') ? '通知は許可されています' : '通知を許可する'
      }</button>
      <label class="field-label">棚べつに知らせる</label>
      <ul class="switch-list">${settings.shelves.map(s => `
        <li>
          <img src="${shelfIconSrc(s.icon)}" alt="">
          <span>${esc(s.name)}</span>
          <button class="switch ${notifyOn(s.id) ? 'is-on' : ''}" data-notif="${esc(s.id)}" role="switch" aria-checked="${notifyOn(s.id)}"></button>
        </li>`).join('')}</ul>
      <label class="field-label">いつ知らせる</label>
      <div class="seg" id="s-notif-timing">
        ${[['morning','朝'],['anytime','いつでも'],['evening','夕方']].map(([v, l]) =>
          `<button type="button" data-timing="${v}" class="${settings.notifTiming === v ? 'is-on' : ''}">${l}</button>`).join('')}
      </div>
      <p class="hint type-caption">アプリを開いたときに、その時間帯なら1日1回だけ声をかけます。閉じている間に鳴らすには配信サーバが要るので、いまは入れていません。</p>`;

  } else if (setTab === 'share') {
    body.innerHTML = `
      <label class="field-label">家族コード</label>
      <div class="row-tight">
        <input id="s-house" type="text" class="field" value="${esc(settings.house)}" placeholder="家族コード" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button id="s-house-make" class="btn-ghost">新しく作る</button>
      </div>
      <p id="sync-detail" class="hint type-caption"></p>
      <div class="row-tight">
        <button id="s-sync-now" class="btn-ghost wide">いますぐ合わせる</button>
        <button id="s-house-copy" class="btn-ghost">コードをコピー</button>
      </div>
      <p class="hint type-caption"><strong>家族コードが同じ端末どうしが、同じ棚・同じ買い物リストになります。</strong>これは合言葉なので、家族以外には教えないでください。ひとりで使うときも目印として要るので、写真の読み取りを初めて使うときに自動で作られます。</p>
      ${IN_APP_BROWSER ? `
      <p class="hint type-caption"><strong>いまは LINE などアプリの中のブラウザで開いています。</strong>ここから「他のブラウザで開く」を選ぶと、いつも使うブラウザでも同じ家族コードのまま開けます。もし引き継がれなかったときは、上の「コードをコピー」で控えて、開いた先の同じ欄に貼り付けてください。</p>` : ''}

      <label class="field-label">家族を呼ぶ</label>
      <div class="row-tight">
        <button id="s-invite" class="btn-ghost wide">招待リンクを送る</button>
        <button id="s-invite-copy" class="btn-ghost">リンクをコピー</button>
      </div>
      <p class="hint type-caption">このリンクを開いた端末は、<strong>家族コードを打たずにそのまま仲間に入れます。</strong>合言葉が入ったリンクなので、家族にだけ送ってください。<br>受け取った家族が LINE の中で開いたときは、そのまま「他のブラウザで開く」を選んでもらえば、いつものブラウザにも引き継がれます。</p>

      <details class="fold">
        <summary>つなぎ先を変える（ふだんは触らない）</summary>
        <label class="field-label">共有URL</label>
        <input id="s-url" type="url" class="field" value="${esc(settings.url)}" placeholder="https://script.google.com/.../exec" inputmode="url" autocomplete="off">
        <p class="hint type-caption">写真の読み取りとレシピもここを通ります。最初から入っているので、ふつうは変更不要です。</p>
      </details>`;
    setSyncState(syncState, syncNote);

  } else if (setTab === 'data') {
    body.innerHTML = `
      <label class="field-label">そのまま送る</label>
      <button id="s-share-shop" class="btn-ghost wide">買うものを送る</button>
      <button id="s-share-shelf" class="btn-ghost wide">棚の中身を送る</button>
      <p class="hint type-caption">LINE やメールにそのまま貼れる文章で送ります。家族コードを知らない人にも渡せます。</p>

      <label class="field-label">表として出す</label>
      <button id="s-csv" class="btn-ghost wide">棚の中身を CSV で</button>
      <button id="s-csv-hist" class="btn-ghost wide">これまでの記録を CSV で</button>
      <button id="s-json" class="btn-ghost wide">まるごとバックアップ（JSON）</button>
      <p class="hint type-caption">CSV は Excel / Numbers / スプレッドシートでそのまま開けます。iPhone では共有シートが出るので、「ファイルに保存」を選んでください。</p>`;
  }

  syncSegPills($('#set-body'));
}

/* 家族コードと共有URLだけは、打っている途中の1文字ごとに切り替えない。
 *
 * 1文字ごとに setShare していたので、指が少し止まるたびに
 * 「頭だけのコード」で本当に繋ぎに行き、そこへ手元の中身をまるごと送っていた。
 * 14文字を携帯で打てば、途中の何個かは必ずそうなる。
 * 打ち終わって欄から離れたときに、はじめて切り替える。 */
let shareDraft = null;
const draftShare = patch => { shareDraft = Object.assign(shareDraft || {}, patch); };
function commitShare() {
  if (!shareDraft) return;
  const patch = shareDraft;
  shareDraft = null;
  setShare(patch);
}

/* --- 設定の中の操作（まとめて拾う） --- */
$('#set-body').addEventListener('input', e => {
  const t = e.target;
  if (t.id === 's-me') { settings.me = t.value.trim(); saveSettings(); }
  else if (t.id === 's-house-name') { settings.houseName = t.value.trim(); saveSettings(); renderHome(); }
  else if (t.id === 's-url') { draftShare({ url: t.value.trim() }); }
  else if (t.id === 's-house') { draftShare({ house: t.value.trim() }); }
  else if (t.dataset.act === 'name' && t.closest('.member-list')) {
    settings.members[Number(t.closest('li').dataset.i)].name = t.value;
    saveSettings();
  } else if (t.dataset.act === 'name' && t.closest('.shelf-edit-list')) {
    const sh = shelfOf(t.closest('li').dataset.shelf);
    if (sh) { sh.name = t.value; saveSettings(); }
  } else if (t.id === 'shelf-editor-name') {
    shelfDraft.name = t.value;
  }
});

/* 欄から離れた（＝打ち終わった）ら切り替える */
$('#set-body').addEventListener('change', e => {
  if (e.target.id === 's-house' || e.target.id === 's-url') commitShare();
});

$('#set-body').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  commitShare();   // 打ちかけのまま何か押されても取りこぼさない

  /* 基本 */
  if (b.dataset.theme) { settings.theme = b.dataset.theme; saveSettings(); applyTheme(); renderSettings(); return; }
  if (b.dataset.rm)    { settings.reviewMode = b.dataset.rm; saveSettings(); renderSettings(); return; }

  /* 名前 */
  if (b.id === 's-member-add') {
    settings.members.push({ id: uid(), name: '', color: MEMBER_COLORS[settings.members.length % MEMBER_COLORS.length] });
    saveSettings(); renderSettings(); return;
  }
  if (b.dataset.act === 'color' && b.closest('.member-list')) {
    const m = settings.members[Number(b.closest('li').dataset.i)];
    m.color = MEMBER_COLORS[(MEMBER_COLORS.indexOf(m.color) + 1) % MEMBER_COLORS.length];
    saveSettings(); renderSettings(); return;
  }
  if (b.dataset.act === 'del' && b.closest('.member-list')) {
    settings.members.splice(Number(b.closest('li').dataset.i), 1);
    saveSettings(); renderSettings(); return;
  }

  /* 棚 */
  if (b.id === 's-shelf-add') { openShelfEditor(); renderSettings(); return; }
  if (b.dataset.act === 'edit') { openShelfEditor(shelfOf(b.closest('li').dataset.shelf)); renderSettings(); return; }
  if (b.dataset.act === 'del' && b.closest('.shelf-edit-list')) {
    const id = b.closest('li').dataset.shelf;
    const n = itemsOf(id).length;
    if (n && !confirm(`この棚には ${n}品 入っています。棚だけ消して、品目は残しますか？`)) return;
    settings.shelves = settings.shelves.filter(s => s.id !== id);
    saveSettings(); renderSettings(); renderHome(); return;
  }
  if (b.id === 'shelf-editor-cancel') { shelfDraft = null; renderSettings(); return; }
  if (b.dataset.mode && b.closest('#shelf-editor-mode')) { shelfDraft.mode = b.dataset.mode; renderSettings(); return; }
  if (b.dataset.color) { shelfDraft.color = b.dataset.color; renderSettings(); return; }
  if (b.dataset.icon)  {
    shelfDraft.icon = b.dataset.icon;
    if (!shelfDraft.name) shelfDraft.name = SHELF_ICON_NAMES[b.dataset.icon];
    renderSettings(); return;
  }
  if (b.id === 'shelf-editor-save') {
    const name = (shelfDraft.name || '').trim();
    if (!name) { toast('棚の名前を書いてください'); return; }
    const found = settings.shelves.find(s => s.id === shelfDraft.id);
    if (found) Object.assign(found, shelfDraft, { name });
    else settings.shelves.push(Object.assign({}, shelfDraft, { name }));
    saveSettings();
    const created = shelfDraft;
    shelfDraft = null;
    renderSettings(); renderHome();
    burst(null, 20);
    fireMood('shelf-added', created.name);
    return;
  }

  /* キャラ */
  const modeSeg = b.closest('[data-charmode]');
  if (modeSeg && b.dataset.v) {
    settings[modeSeg.dataset.charmode + 'CharMode'] = b.dataset.v;
    saveSettings(); renderSettings(); renderHome(); return;
  }
  if (b.dataset.charpick) {
    settings[b.dataset.charpick + 'Char'] = b.dataset.id;
    settings[b.dataset.charpick + 'CharMode'] = 'fixed';
    saveSettings(); renderSettings(); renderHome(); return;
  }

  /* 通知 */
  if (b.id === 's-notif-ask') { askNotifPermission().then(() => renderSettings()); return; }
  if (b.dataset.notif) {
    settings.notifByShelf[b.dataset.notif] = !notifyOn(b.dataset.notif);
    saveSettings(); renderSettings(); return;
  }
  if (b.dataset.timing) { settings.notifTiming = b.dataset.timing; saveSettings(); renderSettings(); return; }

  /* 共有 */
  if (b.id === 's-invite') {
    if (!settings.house) { toast('先に家族コードを決めてください'); return; }
    shareText(`アルノポケットに招待します。\nこのリンクを開くと、そのまま同じ棚が見られます。\n\n${inviteUrl(settings.house)}\n\n（うまく入れないときは、家族コード「${settings.house}」を設定の「共有」に打ち込んでください）`);
    return;
  }
  if (b.id === 's-invite-copy') {
    if (!settings.house) { toast('先に家族コードを決めてください'); return; }
    copyText(inviteUrl(settings.house));
    return;
  }
  if (b.id === 's-house-copy') {
    if (!settings.house) { toast('先に家族コードを決めてください'); return; }
    copyText(settings.house);
    return;
  }
  if (b.id === 's-house-make') {
    setShare({ house: newHouseCode() });
    renderSettings();
    /* すぐ同期して、サーバー側の台帳に「この家は実在する」と載せる。
     * 載るまでは写真の読み取りとレシピが弾かれる（実績のある家だけ通す作りのため）。
     * 間に合わなかったぶんは postAI が頼み直すので、ここは待たなくていい。 */
    sync().catch(() => {});
    toast('新しい家族コードにしました。「招待リンクを送る」で家族に配ってください');
    return;
  }
  if (b.id === 's-sync-now') {
    if (!settings.url || !settings.house) { toast('共有URLと家族コードを入れてください'); return; }
    sync(); return;
  }

  /* データ */
  if (b.id === 's-share-shop')  { shareText(shopAsText()); return; }
  if (b.id === 's-share-shelf') { shareText(shelvesAsText()); return; }
  if (b.id === 's-csv')      { exportItemsCsv(); return; }
  if (b.id === 's-csv-hist') { exportHistoryCsv(); return; }
  if (b.id === 's-json')     { exportJson(); return; }
});

function setShare(patch) {
  const before = settings.url + '|' + settings.house;
  Object.assign(settings, patch);
  saveSettings();
  if (before !== settings.url + '|' + settings.house) {
    /* 相手が変わったら、手元のぶんは全部もう一度送り直す */
    since = 0; LS.set('since', 0);
    [items, shop, chat].forEach(list => list.forEach(i => { i.dirty = true; }));
    saveAll();
  }
  setSyncState(settings.url && settings.house ? (syncState === 'off' ? 'syncing' : syncState) : 'off');
  /* アプリ内ブラウザでは、URL 側の合言葉も追いかけさせる（別ブラウザへの引き継ぎ用） */
  if (IN_APP_BROWSER) { settings.house ? keepCodeInUrl() : stripCodeFromUrl(); }
  scheduleSync(300);
}

/* ============ 書き出しと共有（機能I） ============ */

/* iPhone の共有シートに渡す。
 * `<a download>` は iPhone のホーム画面から開いたとき（standalone）に当てにならず、
 * 何も起きないことがある。共有シートなら LINE・メール・ファイルのどれにも渡せる。
 * 使えない環境（PCのブラウザなど）では、これまでどおりダウンロードに落ちる。 */
async function shareFile(name, text, mime) {
  const blob = new Blob([mime.startsWith('text/csv') ? '\ufeff' + text : text], { type: mime });
  const file = new File([blob], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return true;   // 本人がやめただけ
    }
  }
  download(name, text, mime);
  return false;
}

/* 文章そのものを渡す。買うものを LINE に送る、がこれ。 */
async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return true; }
    catch (err) { if (err && err.name === 'AbortError') return true; }
  }
  /* 共有シートが無い環境では、せめて手元にコピーする */
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); return true; }
  catch { toast('この端末では共有できませんでした'); return false; }
}

/* ---- 人が読む形の文章 ---- */
function shopAsText() {
  const list = live(shop);
  const left = list.filter(s => !s.done);
  if (!left.length) return '買うものはありません。';
  return `買うもの（${left.length}件）\n` + left.map(s => '・' + s.name).join('\n');
}

function shelvesAsText() {
  const out = [`おうちの棚（${ymd(new Date())}）`];
  settings.shelves.forEach(sh => {
    const list = itemsOf(sh.id);
    if (!list.length) return;
    out.push('', `[${sh.name}] ${list.length}品`);
    list.slice().sort(byExpiry).forEach(it => {
      const amount = it.mode === 'stock' ? stockLabel(it.stock) : `${it.qty}${it.unit}`;
      const t = it.expiry ? `（${expiryTag(it.expiry).text}）` : '';
      out.push(`・${it.name} ${amount}${t}`);
    });
  });
  return out.length === 1 ? '棚にはまだ何も入っていません。' : out.join('\n');
}

function download(name, text, mime) {
  /* Excel が UTF-8 と分かるように BOM を先頭に付ける */
  const blob = new Blob([mime.startsWith('text/csv') ? '﻿' + text : text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvRows = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');
const stamp = () => ymd(new Date());

function exportItemsCsv() {
  const head = ['棚','品目','数え方','数量','単位','残量','目標','期限','あと何日','不足','入れた人','更新'];
  const rows = live(items).map(it => {
    const sh = shelfOf(it.shelf);
    return [
      sh ? sh.name : it.shelf, it.name, it.mode === 'stock' ? '残量' : '個数',
      it.mode === 'stock' ? '' : it.qty, it.mode === 'stock' ? '' : it.unit,
      it.mode === 'stock' ? stockLabel(it.stock) : '',
      it.mode === 'stock' ? stockLabel(it.stockTarget) : (it.target ?? ''),
      it.expiry, daysLeft(it.expiry) ?? '', isLacking(it) ? '不足' : '',
      it.by, new Date(it.updatedAt).toLocaleString('ja-JP'),
    ];
  });
  shareFile(`arumo-items-${stamp()}.csv`, csvRows([head, ...rows]), 'text/csv;charset=utf-8');
}

function exportHistoryCsv() {
  const head = ['日時','品目','棚','だれが','なにを','前','後'];
  const rows = [];
  for (const it of items) {
    const sh = shelfOf(it.shelf);
    for (const h of (it.history || [])) {
      rows.push([new Date(h.at).toLocaleString('ja-JP'), it.name, sh ? sh.name : it.shelf,
                 h.by, h.action, h.from ?? '', h.to ?? '']);
    }
  }
  rows.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  shareFile(`arumo-history-${stamp()}.csv`, csvRows([head, ...rows]), 'text/csv;charset=utf-8');
}

function exportJson() {
  shareFile(`arumo-backup-${stamp()}.json`,
    JSON.stringify({ items, shop, chat, settings, cycles, exportedAt: new Date().toISOString() }, null, 2),
    'application/json');
}

/* ============ 見た目 ============ */
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  requestAnimationFrame(() => {
    const meta = $('#meta-theme');
    const bg = getComputedStyle(document.body).backgroundColor;
    if (meta && bg) meta.setAttribute('content', bg);
  });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'auto') applyTheme();
});

/* ============ 起動 ============ */
applyTheme();
live(items).forEach(i => pendingEnter.add(i.id));
renderAll();
renderRecipes();
setView('home');
/* 招待リンク（?join=合言葉）で開かれたとき。
 * 家族は何も打たずに仲間に入れる。すでに別の家に入っている端末では、
 * 黙って乗り換えると手元の品目が別の家に混ざるので、必ず確かめる。 */
(function joinFromLink() {
  /* ?join= が本命。古いリンク（#join=）も拾う */
  const m = location.search.match(/[?&]join=([^&]*)/) || location.hash.match(/[#&]join=([^&]*)/);
  if (!m) return;
  let code = '';
  try { code = decodeURIComponent(m[1]).trim(); } catch { return; }
  if (!code) return;

  /* アプリ内ブラウザでは合言葉を URL に残す（後段の keepCodeInUrl が付け直す）。
   * LINE の「他のブラウザで開く」は、いま表示している URL をそのまま渡すので、
   * ここで消してしまうと、開き直した先に家族コードが引き継がれない。
   * ふつうのブラウザでは、リンクを履歴に残さないよう消す。 */
  if (!IN_APP_BROWSER) stripCodeFromUrl();

  if (code === settings.house) return;
  if (settings.house && !confirm(`いまの家族（${settings.house}）から、こちらに乗り換えますか。\n\n${code}\n\n手元の棚の中身は、乗り換えた先に合流します。`)) return;
  setShare({ house: code });
  renderAll();
  toast('家族に加わりました');
})();

/* URL から合言葉を落とす（履歴に残さない）。ほかの param と # は触らない */
function stripCodeFromUrl() {
  const u = new URL(location.href);
  u.searchParams.delete('join');
  u.hash = u.hash.replace(/([#&])join=[^&]*&?/, '$1').replace(/[#&]$/, '');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

/* アプリ内ブラウザのときは、家族コードを URL に載せたままにしておく。
 * LINE の「他のブラウザで開く」は URL しか渡さないので、これが唯一の引き継ぎ手段になる。
 * 招待リンクから来ていなくても（自分で打ち込んだ端末でも）同じように効く。 */
function keepCodeInUrl() {
  if (!IN_APP_BROWSER || !settings.house) return;
  const u = new URL(location.href);
  const hash = u.hash.replace(/([#&])join=[^&]*&?/, '$1').replace(/[#&]$/, '');   // 旧 #join= は二重になるので落とす
  if (u.searchParams.get('join') === settings.house && hash === u.hash) return;
  u.searchParams.set('join', settings.house);
  history.replaceState(null, '', u.pathname + u.search + hash);
}
keepCodeInUrl();

setSyncState(settings.url && settings.house ? 'syncing' : 'off');
saveAll();
scheduleSync(300);
maybeNotify();

/* 落ち着いた頃に「今日はどう？」を一度だけ出す */
setTimeout(() => {
  const lacking = live(items).filter(isLacking);
  const soon = live(items).filter(isSoonOut);
  if (lacking.length) fireMood('lack-found', lacking.length);
  else if (soon.length) fireMood('soon-out', soon[0].name);   /* 機能F */
  else if (live(items).length) fireMood('nothing-urgent');
}, 1200);

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
