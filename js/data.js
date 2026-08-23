/* アルノポケット — 土台（保存・棚・キャラ・品目モデル）
 *
 * 設計の芯：
 *  - 1レコード = 1品目 or 1買い物 or 1チャット。どれも同じ形で同期に流す
 *  - 消すときは行を消さず deleted 印を立てる（消したことを家族に伝えるため）
 *  - ぶつかったら updatedAt が新しいほうを採る（後勝ち）
 */

/* ============ 端末内の保存 ============ */
const LS = {
  key: k => 'arumo.' + k,
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

/* ============ 棚 ============ */
/* アイコンは assets/shelf-<id>.svg。3グループに分けて設定画面に出す */
const SHELF_ICONS = [
  { group: '台所', ids: ['fridge','freezer','pantry','spice','drink','snack','tool'] },
  { group: '生活', ids: ['daily','cleaning','laundry','medicine','closet','shoes'] },
  { group: 'その他', ids: ['desk','office','books','tools','car','baby','toy','pet','plant','hobby','custom'] },
];
const SHELF_ICON_NAMES = {
  fridge:'冷蔵庫', freezer:'冷凍庫', pantry:'食品棚', spice:'調味料', drink:'飲みもの',
  snack:'おやつ', tool:'調理道具', daily:'洗面台', cleaning:'掃除用品', laundry:'洗濯',
  medicine:'くすり箱', closet:'クローゼット', shoes:'玄関・靴', desk:'机まわり', office:'書類文具',
  books:'本棚', tools:'DIY工具', car:'車のトランク', baby:'ベビー', toy:'おもちゃ',
  pet:'ペット', plant:'園芸', hobby:'趣味', custom:'自由な棚',
};
const SHELF_COLORS = ['fridge','freezer','pantry','daily','tool','custom'];

/* 最初に用意しておく6棚。名前もアイコンも設定から変えられる */
const DEFAULT_SHELVES = [
  { id: 'fridge',  name: '冷蔵庫',   icon: 'fridge',  color: 'fridge',  mode: 'qty' },
  { id: 'freezer', name: '冷凍庫',   icon: 'freezer', color: 'freezer', mode: 'qty' },
  { id: 'pantry',  name: '食品棚',   icon: 'pantry',  color: 'pantry',  mode: 'qty' },
  { id: 'daily',   name: '日用品',   icon: 'daily',   color: 'daily',   mode: 'stock' },
  { id: 'tool',    name: '調理道具', icon: 'tool',    color: 'tool',    mode: 'qty' },
  { id: 'medicine',name: 'くすり箱', icon: 'medicine',color: 'custom',  mode: 'stock' },
];

/* 食べ物を置く棚（レシピ提案の材料はここから拾う） */
const FOOD_SHELF_ICONS = ['fridge','freezer','pantry','spice','drink','snack'];

/* ============ キャラクター ============ */
const CHAR_GROUPS = [
  { group: '食材', ids: ['egg','milk','butter','cabbage','carrot','onion','tomato','onigiri','bread','rice','fish','apple'] },
  { group: '日用品', ids: ['soap','toothbrush','tissue','detergent'] },
  { group: '気持ち', ids: ['heart','cloud','star','sleepy'] },
];
const CHAR_NAMES = {
  egg:'たまごくん', milk:'ミルクさん', butter:'バターさん', cabbage:'キャベツさん',
  carrot:'にんじんくん', onion:'たまねぎさん', tomato:'トマトさん', onigiri:'おにぎりちゃん',
  bread:'パンくん', rice:'お米ちゃん', fish:'おさかなくん', apple:'りんごちゃん',
  soap:'ソープくん', toothbrush:'はぶらしくん', tissue:'ティッシュちゃん', detergent:'せんざいさん',
  heart:'ハートちゃん', cloud:'くもさん', star:'キラリちゃん', sleepy:'ねむねむさん',
};

/* 品目名 → キャラ。部分一致で拾う。並び順が優先順位 */
const CHAR_MATCHERS = [
  ['egg', ['たまご','卵','玉子','エッグ']],
  ['milk', ['牛乳','ミルク','ヨーグルト','生クリーム','チーズ','豆乳']],
  ['butter', ['バター','マーガリン','マヨネーズ','油','オイル']],
  ['cabbage', ['キャベツ','レタス','白菜','ほうれん草','小松菜','ねぎ','ニラ','ブロッコリー','きゅうり','ピーマン','なす','もやし']],
  ['carrot', ['にんじん','人参','ニンジン','ごぼう','だいこん','大根','いも','芋','かぼちゃ','れんこん']],
  ['onion', ['たまねぎ','玉ねぎ','タマネギ','にんにく','しょうが','生姜']],
  ['tomato', ['トマト','ケチャップ','パプリカ','いちご','ミニトマト']],
  ['onigiri', ['おにぎり','弁当','海苔','のり','おかか','梅干']],
  ['bread', ['パン','食パン','トースト','ベーグル','ケーキ','クッキー','おやつ','菓子','チョコ']],
  ['rice', ['米','ごはん','ご飯','パスタ','スパゲ','うどん','そば','そうめん','ラーメン','麺','小麦粉']],
  ['fish', ['魚','鮭','さけ','さば','鯖','まぐろ','ツナ','えび','海老','いか','たら','ぶり','しらす','ちくわ','肉','鶏','豚','牛','ハム','ウインナー','ベーコン','ひき肉']],
  ['apple', ['りんご','リンゴ','みかん','バナナ','ぶどう','梨','桃','果物','フルーツ','キウイ','レモン']],
  ['soap', ['石けん','石鹸','ソープ','シャンプー','リンス','ボディ','ハンドソープ','洗顔']],
  ['toothbrush', ['歯ブラシ','はぶらし','歯磨き','ハミガキ','デンタル','カミソリ','髭剃']],
  ['tissue', ['ティッシュ','トイレット','ペーパー','キッチンペーパー','ラップ','ホイル','おむつ','ナプキン','綿棒']],
  ['detergent', ['洗剤','柔軟剤','漂白','ハイター','クリーナー','掃除','スポンジ','ゴミ袋','薬','くすり','サプリ']],
];

function pickCharForItem(name) {
  const s = String(name || '');
  for (const [char, keys] of CHAR_MATCHERS) {
    if (keys.some(k => k && s.includes(k))) return char;
  }
  return null;
}
/* 見つからない品目にも顔は付ける。名前から決めるので毎回同じ子が出る */
function charForItem(name) {
  const hit = pickCharForItem(name);
  if (hit) return hit;
  const pool = ['heart','star','cloud','sleepy'];
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return pool[h % pool.length];
}
const charSrc = id => `assets/char-${id}.svg`;
const shelfIconSrc = id => `assets/shelf-${id}.svg`;

/* ============ 品目の下ごしらえ ============ */
/* [名前, 単位, 既定の量, 既定の日持ち(日), 置き場のアイコン] */
const PRESETS = [
  { group: '野菜', shelf: 'fridge', items: [
    ['にんじん','本',1,14], ['玉ねぎ','個',1,30], ['じゃがいも','個',1,30], ['キャベツ','個',1,10],
    ['トマト','個',2,5], ['きゅうり','本',2,5], ['ほうれん草','袋',1,3], ['ねぎ','本',1,7],
    ['もやし','袋',1,2], ['ピーマン','袋',1,7],
  ]},
  { group: '肉・魚・卵', shelf: 'fridge', items: [
    ['鶏むね肉','g',300,3], ['鶏もも肉','g',300,3], ['豚こま','g',300,3], ['ひき肉','g',300,2],
    ['鮭','切',2,3], ['卵','個',6,14], ['ハム','パック',1,10], ['ウインナー','パック',1,14],
  ]},
  { group: '乳製品・大豆', shelf: 'fridge', items: [
    ['牛乳','ml',1000,7], ['ヨーグルト','パック',1,10], ['チーズ','パック',1,21],
    ['バター','g',200,60], ['豆腐','パック',1,5], ['納豆','パック',3,7],
  ]},
  { group: '主食・その他', shelf: 'pantry', items: [
    ['食パン','袋',1,4], ['うどん','袋',2,7], ['米','kg',5,180], ['パスタ','g',500,365],
    ['油揚げ','パック',1,7], ['きのこ','パック',1,7],
  ]},
  { group: '日用品', shelf: 'daily', items: [
    ['シャンプー','本',1,null], ['ハンドソープ','本',1,null], ['歯磨き粉','本',1,null],
    ['トイレットペーパー','個',12,null], ['ティッシュ','箱',5,null], ['洗剤','本',1,null],
  ]},
];

const INFO = {};
PRESETS.forEach(g => g.items.forEach(([name, unit, qty, days]) => {
  INFO[name] = { unit, qty, days, shelf: g.shelf };
}));

const UNITS = ['個','g','ml','パック','本','袋','切','箱','kg','ロール'];
const isBulk = u => u === 'g' || u === 'ml';
const stepOf = unit => isBulk(unit) ? 50 : 1;
const qtyChoices = unit => isBulk(unit) ? [50,100,200,300,500] : [1,2,3,6,10];

/* 残量モードの4段階。level は「どれくらい残っているか」の並び順 */
const STOCK_LEVELS = [
  { id: 'full',  level: 3, label: 'たっぷり' },
  { id: 'half',  level: 2, label: 'はんぶん' },
  { id: 'low',   level: 1, label: 'のこりわずか' },
  { id: 'empty', level: 0, label: 'きれた' },
];
const stockLevel = id => (STOCK_LEVELS.find(s => s.id === id) || STOCK_LEVELS[0]).level;
const stockLabel = id => (STOCK_LEVELS.find(s => s.id === id) || STOCK_LEVELS[0]).label;

/* ============ レコード ============ */
const TOMBSTONE_LIFE = 30 * 86400000;
const HISTORY_MAX = 20;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function normalize(it) {
  const mode = it.mode === 'stock' ? 'stock' : 'qty';
  return {
    id: it.id || uid(),
    name: it.name ?? '',
    shelf: it.shelf ?? 'fridge',
    mode,
    qty: Number(it.qty ?? 1),
    unit: it.unit ?? '個',
    expiry: it.expiry ?? '',
    target: it.target === null || it.target === undefined || it.target === '' ? null : Number(it.target),
    stock: it.stock ?? 'full',
    stockTarget: it.stockTarget ?? 'low',
    done: !!it.done,
    by: it.by ?? '',
    addedAt: Number(it.addedAt ?? Date.now()),
    updatedAt: Number(it.updatedAt ?? it.addedAt ?? Date.now()),
    deleted: !!it.deleted,
    dirty: it.dirty ?? true,
    history: Array.isArray(it.history) ? it.history.slice(-HISTORY_MAX) : [],
  };
}
const migrate = list => (Array.isArray(list) ? list : []).map(normalize);

function prune(list) {
  const now = Date.now();
  return list.filter(it => !(it.deleted && !it.dirty && now - it.updatedAt > TOMBSTONE_LIFE));
}

/* ============ 状態 ============ */
/* 旧「ウチの冷蔵庫」のデータがあれば、冷蔵庫の棚として引き継ぐ */
function inherit(oldKey, shelf) {
  try {
    const raw = localStorage.getItem('fridge.' + oldKey);
    if (!raw) return [];
    return migrate(JSON.parse(raw)).map(it => Object.assign(it, { shelf, dirty: true }));
  } catch { return []; }
}

let items = prune(migrate(LS.get('items', null) ?? inherit('fridge', 'fridge')));
let shop  = prune(migrate(LS.get('shop',  null) ?? inherit('shop', 'fridge')));
let chat  = prune(migrate(LS.get('chat', [])));

const DEFAULT_SETTINGS = {
  me: LS.get('me', '') || '',
  houseName: 'わが家',
  url: '', house: '',
  members: [],
  shelves: DEFAULT_SHELVES.map(s => Object.assign({}, s)),
  heroChar: 'heart',   heroCharMode: 'auto',   heroCharName: '',
  loadingChar: 'star', loadingCharMode: 'auto', loadingCharName: '',
  notifByShelf: {},
  notifTiming: 'morning',
  reviewMode: 'batch',
  theme: 'auto',
};

let settings = Object.assign({}, DEFAULT_SETTINGS, LS.get('settings', {}));
settings.shelves = (settings.shelves && settings.shelves.length ? settings.shelves : DEFAULT_SHELVES)
  .map(s => Object.assign({ mode: 'qty', color: 'custom', icon: 'custom' }, s));
/* 旧バージョンの設定からの引き取り */
if (!LS.get('settings', null)) {
  const oldCfg = LS.get('cfg', null) || (() => { try { return JSON.parse(localStorage.getItem('fridge.cfg')); } catch { return null; } })();
  if (oldCfg) { settings.url = oldCfg.url || ''; settings.house = oldCfg.house || ''; }
  try { settings.me = JSON.parse(localStorage.getItem('fridge.me')) || settings.me; } catch {}
  try { settings.theme = JSON.parse(localStorage.getItem('fridge.theme')) || 'auto'; } catch {}
}

let since  = LS.get('since', 0);
let recent = LS.get('recent', []);

const saveItems = () => LS.set('items', items);
const saveShop  = () => LS.set('shop', shop);
const saveChat  = () => LS.set('chat', chat);
const saveSettings = () => LS.set('settings', settings);
const saveAll = () => { saveItems(); saveShop(); saveChat(); LS.set('since', since); saveSettings(); };

const shelfOf = id => settings.shelves.find(s => s.id === id) || settings.shelves[0];
const live = list => list.filter(it => !it.deleted);
const itemsOf = shelfId => live(items).filter(i => i.shelf === shelfId);

/* 変更のたびに updatedAt を打ち直し、誰が何をしたかを履歴に足す（機能B） */
function touch(it, action, extra) {
  it.updatedAt = Date.now();
  it.dirty = true;
  if (action) {
    it.history = (it.history || []).concat([Object.assign({
      at: it.updatedAt, by: settings.me || '', action,
    }, extra || {})]).slice(-HISTORY_MAX);
  }
}

/* ============ 期限 ============ */
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const inDays = n => ymd(new Date(startOfToday().getTime() + n * 86400000));

function daysLeft(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = new Date(y, m - 1, d); t.setHours(0,0,0,0);
  return Math.round((t - startOfToday()) / 86400000);
}
function expiryTag(iso) {
  const n = daysLeft(iso);
  if (n === null) return { state: 'ok', text: '期限なし' };
  if (n < 0)   return { state: 'over', text: `${-n}日 すぎた` };
  if (n === 0) return { state: 'over', text: '今日まで' };
  if (n === 1) return { state: 'soon', text: 'あと1日' };
  if (n <= 3)  return { state: 'soon', text: `あと${n}日` };
  return { state: 'ok', text: `あと${n}日` };
}

/* ============ 不足の判定（機能A：目標数） ============ */
function isLacking(it) {
  if (it.mode === 'stock') return stockLevel(it.stock) <= stockLevel(it.stockTarget);
  if (it.target === null) return it.qty <= 0;
  return it.qty < it.target;
}
/* 「気になる子」= 不足 or 期限が今日までを過ぎている */
function isUrgent(it) {
  if (isLacking(it)) return true;
  const n = daysLeft(it.expiry);
  return n !== null && n <= 0;
}
function lackTag(it) {
  if (!isLacking(it)) return null;
  if (it.mode === 'stock') return it.stock === 'empty' ? 'きれた' : '不足';
  if (it.target !== null && it.qty > 0) return 'もうすぐ';
  return '不足';
}

/* ============ 小道具 ============ */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  if (typeof hideLayer === 'function') hideLayer($('#mood'));   /* 同じ場所に出るので重ねない */
  /* 前のトーストが閉じかけていたら、その印を外してから出し直す */
  el.classList.remove('is-closing');
  el.hidden = true;
  void el.offsetWidth;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideLayer(el), 2400);
}
