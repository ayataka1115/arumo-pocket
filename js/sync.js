/* アルノポケット — 家族と合わせる（同期）と、AI への取り次ぎ
 *
 * 通信の作法：
 *  - 操作はまず手元に保存する。通信は後追い。圏外でも普通に使える
 *  - Content-Type ヘッダは付けない。付けると事前確認(preflight)が飛んで GAS が答えられない
 *  - 送った変更は、サーバーが弾いたぶんも必ず返してもらう（返さないと圏外の端末だけずれ続ける）
 */

let syncing = false, syncAgain = false, syncTimer = null;
let syncState = 'off', syncNote = '';

function setSyncState(state, note = '') {
  syncState = state; syncNote = note;
  const label = { off: 'この端末だけ', syncing: '合わせ中', ok: '合わせ済み', error: '合わせられず' }[state];
  const text = $('#sync-text'), chip = $('#sync-chip');
  if (text) text.textContent = label;
  if (chip) chip.dataset.state = state;

  const detail = $('#sync-detail');
  if (detail) {
    detail.textContent =
      state === 'error'   ? `合わせられませんでした：${note}` :
      state === 'ok'      ? `最後に合わせたのは ${new Date(LS.get('syncedAt', Date.now())).toLocaleString('ja-JP')}` :
      state === 'syncing' ? '合わせています…' :
      '共有URLと家族コードを入れると、家族の端末と同じ中身になります。';
  }
}

function scheduleSync(delay = 900) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

/* 送る形。棚・モード・目標数・履歴は ext にまとめる（表の列を増やさずに済む） */
const forSend = (it, kind) => ({
  kind, id: it.id, name: it.name, qty: it.qty, unit: it.unit, expiry: it.expiry,
  addedAt: it.addedAt, updatedAt: it.updatedAt, deleted: !!it.deleted,
  by: it.by || '', done: !!it.done,
  ext: JSON.stringify({
    shelf: it.shelf, mode: it.mode, target: it.target,
    stock: it.stock, stockTarget: it.stockTarget, history: it.history || [],
  }),
});

function fromRow(row) {
  let ext = {};
  try { ext = row.ext ? JSON.parse(row.ext) : {}; } catch {}
  return normalize({
    id: row.id, name: row.name, qty: row.qty, unit: row.unit, expiry: row.expiry,
    done: !!row.done, by: row.by, addedAt: row.addedAt, updatedAt: row.updatedAt,
    deleted: !!row.deleted, dirty: false,
    shelf: ext.shelf, mode: ext.mode, target: ext.target,
    stock: ext.stock, stockTarget: ext.stockTarget, history: ext.history,
  });
}

const LISTS = [['item', () => items, v => { items = v; }],
               ['shop', () => shop,  v => { shop = v; }],
               ['chat', () => chat,  v => { chat = v; }]];

async function post(payload, timeoutMs = 60000) {
  if (!settings.url) throw new Error('共有URLが設定されていません');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(settings.url, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      body: JSON.stringify(Object.assign({ house: settings.house }, payload)),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'サーバーがエラーを返しました');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('時間がかかりすぎました');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sync() {
  if (!settings.url || !settings.house) { setSyncState('off'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; setSyncState('syncing');

  try {
    const pending = [];
    for (const [kind, get] of LISTS) {
      for (const it of get()) if (it.dirty) pending.push(forSend(it, kind));
    }
    const sentAt = new Map(pending.map(p => [p.kind + p.id, p.updatedAt]));

    const data = await post({ action: 'sync', since, changes: pending }, 30000);

    /* 送った時刻のまま返ってきたものだけ「送信済み」にする。
     * 送ったあとに手元でもう一度触っていたら dirty は立てたままにする */
    for (const [kind, get] of LISTS) {
      for (const it of get()) {
        if (it.dirty && sentAt.get(kind + it.id) === it.updatedAt) it.dirty = false;
      }
    }

    let arrived = 0;
    for (const row of data.rows || []) {
      const entry = LISTS.find(l => l[0] === row.kind);
      if (!entry) continue;
      const list = entry[1]();
      const incoming = fromRow(row);
      const i = list.findIndex(x => x.id === incoming.id);
      if (i < 0) { list.push(incoming); pendingEnter.add(incoming.id); arrived++; }
      else if ((list[i].updatedAt || 0) < incoming.updatedAt) { list[i] = incoming; arrived++; }
    }

    since = data.now;
    for (const [, get, set] of LISTS) set(prune(get()));
    LS.set('syncedAt', Date.now());
    saveAll();
    if (arrived) renderAll();
    setSyncState('ok');
  } catch (err) {
    setSyncState('error', !navigator.onLine ? 'オフラインです' : String(err.message || err));
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(400); }
  }
}

/* ============ AI への取り次ぎ ============
 * 画像も献立も、鍵を端末に置かずに済むよう GAS 経由で Gemini に渡す。
 */
const aiRecognize     = (dataUrl, shelfId) => post({ action: 'recognize', image: dataUrl, shelf: shelfId });
const aiReadReceipt   = dataUrl => post({ action: 'recognize-receipt', image: dataUrl });
const aiSuggestRecipes = payload => post(Object.assign({ action: 'suggest-recipes' }, payload));
const aiPlanWeek       = payload => post(Object.assign({ action: 'plan-week' }, payload));

/* 送る前に長辺1024pxまで縮める。Gemini に渡す量を減らすため */
function shrinkImage(file, max = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('写真を読めませんでした')); };
    img.src = url;
  });
}

addEventListener('online', () => scheduleSync(200));
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(200); });
setInterval(() => { if (!document.hidden) sync(); }, 60000);
