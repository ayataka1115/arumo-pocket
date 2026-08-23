/* アルノポケット — 画面を描くところ
 *
 * 描き方の約束：
 *  - パステルの面には白文字を載せない。濃い同系色（-deep）を載せる
 *  - カードの左に色帯は貼らない。上端 6px のストライプか右上バッジで示す
 *  - 絵文字は使わない。表情は assets のキャラ SVG に任せる
 */

let view = 'home';
let shelfId = 'fridge';
let shelfTab = 'all';
const pendingEnter = new Set();
const pendingPop = new Set();
/* 分析のバーを「開いたとき1回だけ」伸ばすための目印 */
let statsFresh = false;

/* ============ 気持ちのフキダシ ============ */
const MOOD_SCENES = {
  'add-one':            { char: 'star',   ease: 'joy',   text: n => `「${n}」入れたよ` },
  'add-batch-success':  { char: 'star',   ease: 'joy',   text: n => `${n}品ぜんぶ入ったよ！` },
  'recognize-fail':     { char: 'cloud',  ease: 'sorry', text: () => '明るいところで撮ってみて？' },
  'recognize-empty':    { char: 'cloud',  ease: 'sorry', text: () => '見つけられなかった…' },
  'use-up':             { char: 'heart',  ease: 'quiet', text: n => `「${n}」買い物に足しておくね` },
  'shop-all-done':      { char: 'star',   ease: 'joy',   text: () => 'ぜんぶ買えたね' },
  'shop-added':         { char: 'heart',  ease: 'joy',   text: n => `「${n}」おねがいしておくね` },
  'receipt-done':       { char: 'star',   ease: 'joy',   text: n => `${n}品 片付けたよ` },
  'recipe-ready':       { char: 'onigiri',ease: 'joy',   text: () => '今日はこれどう？' },
  'recipe-fail':        { char: 'cloud',  ease: 'sorry', text: () => 'うまく思いつかなかった…' },
  'sync-error':         { char: 'cloud',  ease: 'sorry', text: () => '家族とつながらないみたい' },
  'chat-sent':          { char: 'heart',  ease: 'joy',   text: () => 'ことづて、とどけたよ' },
  'shelf-added':        { char: 'star',   ease: 'joy',   text: n => `「${n}」の棚ができたよ` },
  'nothing-urgent':     { char: 'sleepy', ease: 'quiet', text: () => '今日はゆっくりできそう' },
  'lack-found':         { char: 'cloud',  ease: 'quiet', text: n => `${n}品、足りてないみたい` },
  'expired':            { char: 'cloud',  ease: 'sorry', text: n => `${n}、期限すぎちゃった` },
};

/* 達成したときに小さく弾ける。派手にしすぎない（12粒・0.7秒で消える） */
const BURST_COLORS = ['--brand-mint-deep', '--brand-pink-deep', '--brand-butter-deep', '--brand-lavender', '--brand-sky'];

function burst(el, n = 30) {
  if (calm()) return;
  const box = el ? el.getBoundingClientRect() : null;
  const cx = box ? box.left + box.width / 2 : innerWidth / 2;
  const cy = box ? box.top + box.height / 2 : innerHeight / 2;

  const layer = document.createElement('div');
  layer.className = 'burst';
  for (let i = 0; i < n; i++) {
    /* 二重の輪にして、内側は小さく近く、外側は大きく遠くへ飛ばす。
     * 全部同じ距離だときれいな円になりすぎて、かえって嘘っぽい */
    const ring = i % 2;
    const a = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.6;
    const d = (ring ? 150 : 95) + Math.random() * 90;
    const size = (ring ? 10 : 16) + Math.random() * 10;

    const dot = document.createElement('i');
    if (i % 3 === 0) dot.className = 'sq';
    dot.style.left = cx + 'px';
    dot.style.top = cy + 'px';
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    dot.style.background = `var(${BURST_COLORS[i % BURST_COLORS.length]})`;
    dot.style.setProperty('--dx', Math.cos(a) * d + 'px');
    dot.style.setProperty('--dy', Math.sin(a) * d - 30 + 'px');   // 少し上に噴き上げる
    dot.style.setProperty('--spin', (Math.random() * 720 - 360) + 'deg');
    dot.style.animationDelay = (i * 8) + 'ms';
    layer.appendChild(dot);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1400);
}

/* 触った品目のキャラをぴょこっと跳ねさせる */
function hopChar(li) {
  if (!li || calm()) return;
  const img = li.querySelector('.card-char');
  if (!img) return;
  img.classList.remove('motion-hop'); void img.offsetWidth; img.classList.add('motion-hop');
}

/* 買うものの数が「増えたとき」だけ弾ませる。
 * 減ったときまで弾むと、片付けたのに急かされているように見える。 */
function popBadge(badge, n) {
  if (!badge) return;
  const before = badge.hidden ? 0 : (+badge.textContent || 0);
  badge.textContent = n;
  badge.hidden = n === 0;
  if (n > before && !calm()) {
    badge.classList.remove('is-pop'); void badge.offsetWidth; badge.classList.add('is-pop');
  }
}

/* チェックを押した瞬間の演出（yui540「いいねアニメーション1」の移植）。
 * 輪がひろがって、10粒が放射状に飛ぶ。burst() より小さく、その場かぎりの手ごたえ。 */
const POP_COLORS = ['--brand-pink-deep', '--brand-mint-deep', '--brand-sky', '--brand-butter-deep'];

function popFx(el) {
  if (!el || calm()) return;
  const box = el.getBoundingClientRect();

  const layer = document.createElement('div');
  layer.className = 'pop-fx';
  layer.style.left = (box.left + box.width / 2) + 'px';
  layer.style.top  = (box.top + box.height / 2) + 'px';

  const ring = document.createElement('i');
  ring.className = 'pop-ring';
  layer.appendChild(ring);

  for (let i = 0; i < 10; i++) {
    /* 元ネタと同じで、粒ごとに大きさ・遅れ・飛距離をずらす。
     * 全部そろっていると花火ではなく歯車に見える */
    const dot = document.createElement('i');
    dot.className = 'pop-dot';
    dot.style.setProperty('--rotate', (i * 36) + 'deg');
    dot.style.setProperty('--size', [5, 4, 3][i % 3] + 'px');
    dot.style.setProperty('--d', (i % 3) * 0.1 + 's');
    dot.style.setProperty('--travel', -(30 + (i % 4) * 3) + 'px');
    dot.style.setProperty('--c', `var(${POP_COLORS[i % POP_COLORS.length]})`);
    layer.appendChild(dot);
  }

  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1300);
}

/* 押した所から波紋が立つ（yui540「波紋」の移植。元は無限ループ、こちらは1回だけ）。
 * 触った点からいちばん遠い角までを半径にすると、部品全体が過不足なく波に覆われる。 */
const RIPPLE_SEL = '.shelf-tile, .qbtn, .mini';

addEventListener('pointerdown', e => {
  if (calm()) return;
  const el = e.target.closest && e.target.closest(RIPPLE_SEL);
  if (!el) return;
  const box = el.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  const r = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));

  const w = document.createElement('i');
  w.className = 'ripple';
  w.style.left = (x - r) + 'px';
  w.style.top = (y - r) + 'px';
  w.style.width = w.style.height = (r * 2) + 'px';
  el.appendChild(w);
  setTimeout(() => w.remove(), 500);   /* 波紋は --dur-reveal(400ms) で終わる */
}, { passive: true });

/* ============ かぶせもの（シート・全画面・フキダシ）の出し入れ ============
 * 開くほうには animation が付いているのに、閉じるほうは hidden = true の一発で
 * パッと消えていた。閉じる動きを CSS 側（.is-closing）に出して、
 * 終わってから hidden にする。秒数は CSS のトークンから読むのでズレない。 */
const CLOSE_MS = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-2')) || 200;
const closeTimers = new WeakMap();

function showLayer(...els) {
  els.filter(Boolean).forEach(el => {
    clearTimeout(closeTimers.get(el));
    el.classList.remove('is-closing');
    el.hidden = false;
  });
}

function hideLayer(...els) {
  const list = els.filter(Boolean);
  if (calm()) { list.forEach(el => { el.hidden = true; }); return; }
  list.forEach(el => {
    if (el.hidden) return;
    el.classList.add('is-closing');
    clearTimeout(closeTimers.get(el));
    closeTimers.set(el, setTimeout(() => {
      el.hidden = true;
      el.classList.remove('is-closing');
    }, CLOSE_MS));
  });
}

let moodTimer;
function fireMood(key, arg) {
  const scene = MOOD_SCENES[key];
  if (!scene) return;
  const box = $('#mood');
  const img = $('#mood-char');
  img.src = charSrc(scene.char);
  img.className = 'mood-char ' + (scene.ease === 'sorry' ? 'motion-wobble' : 'motion-bob');
  $('#mood-text').textContent = scene.text(arg);
  box.dataset.ease = scene.ease;
  hideLayer($('#toast'));      /* 同じ場所に出るので重ねない */
  showLayer(box);
  box.classList.remove('motion-pop'); void box.offsetWidth; box.classList.add('motion-pop');
  clearTimeout(moodTimer);
  moodTimer = setTimeout(() => hideLayer(box), 3200);
}

/* 1行の切替（.seg）の白い面を、飛ばさずに滑らせる。
 * 折り返す .seg.wrap は行をまたぐので対象外（面はボタンに直に付けたまま）。
 *
 * 位置は「描いた直後」に測ると外れる。リストの中身が変わって高さが動くと
 * スクロールバーのぶん幅が変わり、古い幅のまま置いてしまうため。
 * 呼び出し順に頼らず、幅が変わったら測り直す（ResizeObserver）作りにしてある。
 * 最初の1回は transition を切って置く。切らないと幅0・左端から滑り込んでくる。 */
const segWatcher = typeof ResizeObserver === 'function'
  ? new ResizeObserver(entries => entries.forEach(e => placeSegPill(e.target)))
  : null;

function placeSegPill(seg) {
  const on = seg.querySelector('button.is-on');
  let pill = seg.querySelector(':scope > .seg-pill');
  if (!on) { if (pill) pill.remove(); return; }

  const box = seg.getBoundingClientRect();
  if (!box.width) return;                    // まだ表示されていない（シートが閉じている等）
  const r = on.getBoundingClientRect();

  const isNew = !pill;
  if (isNew) {
    pill = document.createElement('i');
    pill.className = 'seg-pill no-anim';
    seg.prepend(pill);
  }
  const w = r.width + 'px', t = `translateX(${r.left - box.left}px)`;
  if (pill.style.width === w && pill.style.transform === t) return;
  pill.style.width = w;
  pill.style.transform = t;
  if (isNew) { void pill.offsetWidth; pill.classList.remove('no-anim'); }
}

function syncSegPills(root = document) {
  /* querySelectorAll は子孫しか見ないので、渡されたものが .seg 本体のとき
   * （#shelf-tabs がまさにそれ）取りこぼす。自分自身も候補に入れる。 */
  const segs = [...root.querySelectorAll('.seg:not(.wrap)')];
  if (root.matches && root.matches('.seg:not(.wrap)')) segs.unshift(root);
  segs.forEach(seg => {
    placeSegPill(seg);
    if (segWatcher && !seg.dataset.segWatched) { seg.dataset.segWatched = '1'; segWatcher.observe(seg); }
  });
}

addEventListener('resize', () => syncSegPills());

/* ============ 画面切り替え ============ */
const VIEWS = ['home','shelf','shop','recipes','stats'];

function setView(v) {
  if (v === 'set') { openSettings(); return; }
  view = v;
  VIEWS.forEach(name => { $('#view-' + name).hidden = name !== v; });
  syncSegPills($('#view-' + v) || document);   /* 隠れている間は幅が0で置けないので、出してから */
  const shown = $('#view-' + v);
  if (shown && !calm()) { shown.style.animation = 'none'; void shown.offsetWidth; shown.style.animation = ''; }
  /* ＋入れる は #view-shelf の中に入ったので、画面ごとの出し分けは要らなくなった */
  const tabFor = v === 'shelf' ? 'home' : v;
  $$('.tab').forEach(b => b.classList.toggle('is-active', b.dataset.view === tabFor));
  /* 分析はここでしか描き直さない。バーを伸ばす動きは「開いたとき」だけにしたい
   * （同期のたびに再生されると、見ている最中にガタつく） */
  if (v === 'stats') { statsFresh = true; renderStats(); }
  scrollTo({ top: 0 });
}

function openShelf(id) {
  shelfId = id; shelfTab = 'all';
  itemsOf(id).forEach(i => pendingEnter.add(i.id));
  renderShelf();
  setView('shelf');
}

/* ============ 部品 ============ */
function removeCard(li, after) {
  if (!li || calm()) return after();
  li.classList.add('is-leaving');
  setTimeout(after, 290);
}
function applyEnter(root) {
  let i = 0;
  root.querySelectorAll('[data-id]').forEach(li => {
    if (pendingEnter.has(li.dataset.id)) {
      li.classList.add('is-enter');
      li.style.animationDelay = (i++ * 40) + 'ms';
    }
    if (pendingPop.has(li.dataset.id)) {
      const n = li.querySelector('.qnum');
      if (n) n.classList.add('motion-pop');
    }
  });
}

/* ============ ホーム ============ */
function greeting() {
  const h = new Date().getHours();
  if (h < 4)  return 'こんばんは';
  if (h < 11) return 'おはよう';
  if (h < 16) return 'こんにちは';
  if (h < 19) return 'ただいま';
  return 'こんばんは';
}

function renderHome() {
  const alive = live(items);
  const urgent = alive.filter(isUrgent);

  $('#house-name').textContent = settings.houseName || 'わが家';
  $('#house-initial').textContent = (settings.houseName || 'わ').trim().slice(0, 1);

  /* ヒーロー：時間帯 + 家の名前。誰かを名指ししない（誰が見ても自分ごとになるように） */
  $('#hero-greet').textContent = `${greeting()}、${settings.houseName || 'わが家'}`;

  const worst = urgent[0];
  $('#hero-sub').textContent =
    !alive.length ? 'まずは棚をひらいて、入っているものを教えてね' :
    worst ? `${worst.name}、${isLacking(worst) ? 'そろそろ足りないよ' : '期限が近いよ'}` :
    '今日はあわてる品はなさそう';

  const heroId = settings.heroCharMode === 'fixed' ? settings.heroChar
    : worst ? charForItem(worst.name)
    : (alive[0] ? charForItem(alive[0].name) : 'heart');
  $('#hero-char').src = charSrc(heroId);

  /* 気になる子たち（最大4件） */
  const box = $('#urgent');
  box.hidden = urgent.length === 0;
  if (urgent.length) {
    $('#urgent-count').textContent = urgent.length + '件';
    $('#urgent-list').innerHTML = urgent.slice(0, 4).map(it => {
      const sh = shelfOf(it.shelf);
      const tag = lackTag(it) || expiryTag(it.expiry).text;
      return `<li data-id="${it.id}" data-shelf="${esc(it.shelf)}">
        <img src="${charSrc(charForItem(it.name))}" alt="">
        <span class="u-name">${esc(it.name)}</span>
        <span class="u-shelf type-caption">${esc(sh ? sh.name : '')}</span>
        <span class="tag over">${esc(tag)}</span>
      </li>`;
    }).join('');
  }

  /* 棚グリッド */
  $('#shelf-grid').innerHTML = settings.shelves.map(sh => {
    const list = itemsOf(sh.id);
    const n = list.filter(isUrgent).length;
    return `<button class="shelf-tile" data-shelf="${esc(sh.id)}" style="--c:var(--shelf-${sh.color});--cd:var(--shelf-${sh.color}-deep)">
      <i class="stripe"></i>
      ${n ? `<i class="tile-badge">${n}</i>` : ''}
      <img src="${shelfIconSrc(sh.icon)}" alt="">
      <span class="tile-name">${esc(sh.name)}</span>
      <span class="tile-count type-mono">${list.length}品</span>
    </button>`;
  }).join('') + `<button class="shelf-tile is-add" id="tile-add">＋ 棚を追加</button>`;

  const left = live(shop).filter(s => !s.done).length;
  popBadge($('#shop-badge'), left);
  if (navigator.setAppBadge) {
    (urgent.length ? navigator.setAppBadge(urgent.length) : navigator.clearAppBadge()).catch(() => {});
  }
}

/* ============ 棚の中 ============ */
function stockDots(it) {
  const lv = stockLevel(it.stock);
  return `<span class="dots" data-act="stock" role="button" tabindex="0" aria-label="残量">${
    [3,2,1].map(i => `<i class="${lv >= i ? 'on' : ''}"></i>`).join('')
  }</span>`;
}

function itemCardHTML(it) {
  const t = expiryTag(it.expiry);
  const lack = lackTag(it);
  const state = lack ? 'over' : t.state;
  const target = it.mode === 'stock'
    ? `${stockLabel(it.stockTarget)}まで`
    : (it.target !== null ? `目標${it.target}${esc(it.unit)}` : '');

  const body = it.mode === 'stock'
    ? `<div class="card-qty">${stockDots(it)}</div>`
    : `<div class="card-qty">
         <button class="qbtn" data-act="dec" aria-label="減らす">−</button>
         <span class="qnum type-mono">${it.qty}${esc(it.unit)}</span>
         <button class="qbtn" data-act="inc" aria-label="増やす">＋</button>
       </div>`;

  return `<li class="card ${lack ? 'is-urgent' : ''}" data-id="${it.id}" data-state="${state}">
    <i class="stripe" style="background:var(--tag-${state})"></i>
    ${lack ? `<i class="card-badge">${esc(lack)}</i>` : ''}
    <img class="card-char" src="${charSrc(charForItem(it.name))}" alt="">
    <div class="card-main">
      <div class="card-name">${esc(it.name)}</div>
      <div class="card-sub">
        ${it.mode === 'qty' ? `<span class="tag ${t.state}">${t.text}</span>` : `<span class="tag ${state}">${stockLabel(it.stock)}</span>`}
        ${target ? `<span class="type-caption muted">${esc(target)}</span>` : ''}
      </div>
    </div>
    ${body}
    <div class="card-side">
      <button class="mini" data-act="hist" aria-label="これまで">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.8"/></svg>
      </button>
      <button class="mini" data-act="use" aria-label="使い切った">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
      </button>
    </div>
  </li>`;
}

const byExpiry = (a, b) => {
  const ua = isUrgent(a), ub = isUrgent(b);
  if (ua !== ub) return ua ? -1 : 1;
  const da = daysLeft(a.expiry), db = daysLeft(b.expiry);
  if (da === null && db === null) return b.addedAt - a.addedAt;
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
};

function renderShelf() {
  const sh = shelfOf(shelfId);
  if (!sh) { setView('home'); return; }
  const all = itemsOf(sh.id);
  const lacking = all.filter(isLacking);

  $('#shelf-head-icon').src = shelfIconSrc(sh.icon);
  $('#shelf-head-name').textContent = sh.name;
  $('#shelf-head-count').textContent = `${all.length}品`;
  document.documentElement.style.setProperty('--shelf-now', `var(--shelf-${sh.color})`);
  document.documentElement.style.setProperty('--shelf-now-deep', `var(--shelf-${sh.color}-deep)`);

  $('#tab-all-n').textContent = all.length;
  $('#tab-lack-n').textContent = lacking.length;
  $$('#shelf-tabs button').forEach(b => b.classList.toggle('is-on', b.dataset.tab === shelfTab));

  const shown = (shelfTab === 'lack' ? lacking : all).sort(byExpiry);
  $('#shelf-list').innerHTML = shown.map(itemCardHTML).join('');
  applyEnter($('#shelf-list'));
  pendingEnter.clear(); pendingPop.clear();

  const empty = $('#shelf-empty');
  empty.hidden = shown.length > 0;
  empty.innerHTML = shelfTab === 'lack'
    ? 'この棚は足りています。'
    : 'この棚はまだ空っぽです。<br>「棚をぱちり」か「＋ 入れる」から。';

  syncSegPills($('#shelf-tabs'));   /* 中身が確定してから測る */
}

/* ============ 買うもの ============ */
function renderShop() {
  const list = live(shop).sort((a, b) => (a.done - b.done) || (b.addedAt - a.addedAt));
  const left = list.filter(s => !s.done).length;

  $('#shop-left').textContent = left ? `あと${left}品` : '';
  $('#shop-empty').hidden = list.length > 0;

  /* 進み具合バー。全部買えたら顔が変わる */
  const box = $('#shop-progress');
  box.hidden = list.length === 0;
  if (list.length) {
    const done = list.length - left;
    const pct = Math.round(done / list.length * 100);
    const allDone = left === 0;
    box.classList.toggle('is-done', allDone);
    $('#shop-bar').style.width = pct + '%';
    $('#shop-ratio').textContent = `${done} / ${list.length}`;
    $('#shop-face').src = charSrc(allDone ? 'star' : left === list.length ? 'sleepy' : 'heart');
  }

  $('#shop-list').innerHTML = list.map(s => `
    <li class="card shop ${s.done ? 'is-done' : ''}" data-id="${s.id}">
      <button class="check" data-act="toggle" aria-label="買った">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>
      </button>
      <img class="card-char" src="${charSrc(charForItem(s.name))}" alt="">
      <div class="card-main">
        <div class="card-name">${esc(s.name)}</div>
        <div class="card-sub type-caption muted">${s.by ? esc(s.by) + 'がおねがい' : 'おねがい'}</div>
      </div>
      ${s.done ? '<button class="mini wide" data-act="toshelf">棚へ</button>' : ''}
      <button class="mini" data-act="del" aria-label="消す">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </li>`).join('');
  applyEnter($('#shop-list'));

  $('#btn-clear-done').hidden = !list.some(s => s.done);
  /* 買うものが0件なら「レシートで一気に消す」は消す対象が無い */
  $('#btn-receipt').hidden = list.length === 0;
  const badge = $('#shop-badge');
  popBadge(badge, left);
}

/* ============ 家族のことづて（機能C） ============ */
const CHAT_STAMPS = ['買ってきて', 'なくなったよ', 'ありがとう', 'かえるね'];

function renderChat() {
  $('#chat-stamps').innerHTML = CHAT_STAMPS
    .map(s => `<button type="button" class="chip" data-stamp="${esc(s)}">${esc(s)}</button>`).join('');

  const msgs = live(chat).sort((a, b) => a.addedAt - b.addedAt).slice(-30);
  $('#chat-list').innerHTML = msgs.length
    ? msgs.map(m => {
        const mine = (m.by || '') === (settings.me || '') && !!settings.me;
        return `<li class="msg ${mine ? 'mine' : ''}" data-id="${m.id}">
          <span class="msg-by type-caption">${esc(m.by || 'だれか')}</span>
          <span class="msg-body">${esc(m.name)}</span>
          <span class="msg-at type-caption">${new Date(m.addedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
        </li>`;
      }).join('')
    : '<li class="msg-empty type-body-sm muted">「シャンプー買ってきて」も、ここで完結します。</li>';

  const box = $('#chat-list');
  box.scrollTop = box.scrollHeight;
}

/* ============ レシピ（機能G） ============ */
let recipes = LS.get('recipes', []);

/* 本家のレシピサイトへの検索リンク。
 * 中身（手順・写真・文章）は取り込まない。クックパッドは外部向けAPIを公開しておらず、
 * 規約上も取り込みはできない。バズレシピも同様。だから「探しに行く入口」だけ置く。
 * 楽天だけは公式APIがあるので、実データを引く道も別に用意してある（settings.rakutenAppId）。 */
const RECIPE_SITES = [
  { name: 'クックパッド', short: 'クック', url: q => `https://cookpad.com/jp/search/${encodeURIComponent(q)}` },
  { name: '楽天レシピ',   short: '楽天',   url: q => `https://recipe.rakuten.co.jp/search/${encodeURIComponent(q)}/` },
  { name: 'バズレシピ',   short: 'バズ',   url: q => `https://bazurecipe.com/?s=${encodeURIComponent(q)}` },
];

/* 検索語の作り方。
 * AI が付ける献立名（「キャベツと人参のふんわり卵炒め」）をそのまま投げると、
 * 造語なのでどのサイトでも0件になる。実際に当たるのは「食材＋料理の種類」なので、
 * 食材を2つと、題名から拾った料理の種類だけにする。 */
const DISH_KINDS = ['炒め','煮','スープ','サラダ','焼き','揚げ','蒸し','汁','丼','鍋','和え',
  'あえ','漬け','グラタン','カレー','パスタ','チャーハン','炊き込み','マリネ','ナムル','おひたし'];

function recipeQuery(r) {
  const kind = DISH_KINDS.find(k => (r.title || '').includes(k)) || '';
  const mains = (r.have || []).slice(0, 2);
  const words = [...mains, kind].filter(Boolean);
  return words.length ? words.join(' ') : r.title;
}

/* short=true は「食材から探す」の1行に収めるための短い名前。
 * 献立カードのほうは幅に余裕があるので正式名で出す。 */
function siteLinksHTML(q, short) {
  return `<div class="chip-row tight">${RECIPE_SITES.map(site =>
    `<a class="chip is-link${short ? ' sm' : ''}" href="${esc(site.url(q))}" target="_blank" rel="noopener noreferrer"
        aria-label="${site.name}で「${esc(q)}」を探す">${short ? site.short : site.name}</a>`
  ).join('')}</div>`;
}

function recipeLinksHTML(r) {
  return `<div class="recipe-sec">
    <div class="type-label muted">本家のレシピを探す</div>
    ${siteLinksHTML(recipeQuery(r))}
  </div>`;
}

/* 献立とは別に、食材そのものから探せる入口。
 * 「キャベツが余っている」ときは、AI の献立を待たずに直接ここから飛べたほうが早い。
 * 期限が近いもの・足りないものから順に、最大5つまで。 */
function renderFromFood() {
  const box = $('#from-food');
  const alive = live(items);
  const picks = [...alive].sort(byExpiry).slice(0, 4);
  box.hidden = picks.length === 0;
  if (!picks.length) return;

  $('#from-food-list').innerHTML = picks.map(it => {
    const t = expiryTag(it.expiry);
    return `<div class="from-food-row">
      <img src="${charSrc(charForItem(it.name))}" alt="">
      <span class="ff-name">${esc(it.name)}</span>
      ${it.expiry ? `<span class="tag ${t.state}">${esc(t.text)}</span>` : ''}
      ${siteLinksHTML(it.name, true)}
    </div>`;
  }).join('');
}

function renderRecipes() {
  renderFromFood();
  const box = $('#recipe-list');
  const empty = $('#recipe-empty');

  if (!recipes.length) {
    box.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = settings.url
      ? '「ほかにも」を押すと、棚にあるものから考えます。'
      : '共有URLを設定すると、棚にあるものから献立を考えます。<br>（設定 &gt; 共有）';
    return;
  }
  empty.hidden = true;
  box.innerHTML = recipes.map((r, i) => {
    const plus = (r.buy || []).length > 0 || r.kind === 'plus';
    return `
    <article class="recipe" data-kind="${plus ? 'plus' : 'asis'}" data-i="${i}">
      <div class="recipe-flag">${plus
        ? `<img src="${charSrc('star')}" alt="">${(r.buy || []).length}品 買い足すと作れる`
        : `<img src="${charSrc('heart')}" alt="">あるもので作れる`}</div>
      <h3 class="recipe-title">${esc(r.title)}</h3>
      ${r.note ? `<p class="recipe-note type-body-sm">${esc(r.note)}</p>` : ''}
      <div class="chip-row tight">
        ${[r.level, r.time, r.serves].filter(Boolean).map(c => `<span class="chip is-flat">${esc(c)}</span>`).join('')}
      </div>
      ${(r.have || []).length ? `<div class="recipe-sec">
        <div class="type-label muted">棚から使う</div>
        <div class="chip-row tight">${r.have.map(n => `<span class="chip is-have"><img src="${charSrc(charForItem(n))}" alt="">${esc(n)}</span>`).join('')}</div>
      </div>` : ''}
      ${(r.buy || []).length ? `<div class="recipe-sec">
        <div class="type-label muted">買い足すもの</div>
        <div class="chip-row tight">${r.buy.map(n => `<span class="chip is-buy">${esc(n)}</span>`).join('')}</div>
      </div>` : ''}
      <div class="recipe-steps" hidden>
        <ol>${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
      </div>
      ${recipeLinksHTML(r)}
      <div class="recipe-foot">
        <button class="btn-text" data-act="steps">手順を見る</button>
        ${(r.buy || []).length ? '<button class="btn-ghost sm" data-act="tobuy">買い物に入れる</button>' : ''}
      </div>
    </article>`;
  }).join('');
}

/* ============ 分析（機能J） ============ */
function renderStats() {
  const alive = live(items);
  const lacking = alive.filter(isLacking);
  const expired = alive.filter(i => { const n = daysLeft(i.expiry); return n !== null && n < 0; });

  $('#stat-cards').innerHTML = [
    ['ぜんぶ', alive.length, 'mint'],
    ['不足', lacking.length, 'pink'],
    ['期限すぎ', expired.length, 'butter'],
  ].map(([label, n, c]) => `
    <div class="stat-card" style="--c:var(--brand-${c});--cd:var(--brand-${c}-deep)">
      <div class="stat-n type-h1">${n}</div>
      <div class="type-label">${label}</div>
    </div>`).join('');

  const max = Math.max(1, ...settings.shelves.map(sh => itemsOf(sh.id).length));
  const grow = statsFresh && !calm();
  statsFresh = false;
  $('#stat-shelves').innerHTML = settings.shelves.map((sh, i) => {
    const list = itemsOf(sh.id);
    const n = list.filter(isUrgent).length;
    const w = Math.round(list.length / max * 100);
    return `<div class="stat-row${grow ? ' is-grow' : ''}" style="--d:calc(var(--dur-stagger) * ${i})">
      <img src="${shelfIconSrc(sh.icon)}" alt="">
      <span class="stat-name">${esc(sh.name)}</span>
      <span class="type-mono muted">${list.length}品${n ? ` / 気になる ${n}` : ''}</span>
      <i class="bar"><b style="--w:${w}%;width:var(--w);background:var(--shelf-${sh.color}-deep)"></b></i>
    </div>`;
  }).join('');

  /* 誰が何回動かしたか。履歴（機能B）をそのまま数える */
  const tally = {};
  for (const it of items) for (const h of (it.history || [])) {
    const who = (h.by || '').trim(); if (!who) continue;
    tally[who] = (tally[who] || 0) + 1;
  }
  const rank = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('#stat-rank').innerHTML = rank.length
    ? rank.map(([name, n], i) => `<li class="${i === 0 ? 'top' : ''}">
        <i class="rank type-mono">${i + 1}</i><span>${esc(name)}</span><b class="type-mono">${n}回</b>
      </li>`).join('')
    : '<li class="muted type-body-sm">設定で名前を入れると、ここに出ます。</li>';
}

/* ============ まとめて描く ============ */
function renderAll() {
  renderHome();
  if (view === 'shelf') renderShelf();
  renderShop();
  renderChat();
  renderStats();
}
