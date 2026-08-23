/**
 * ウチの冷蔵庫 — 家族共有バックエンド
 *
 * スプレッドシートに紐づいた（拡張機能 > Apps Script で作った）スクリプトとして動かす。
 *
 * 差分同期方式：
 *   - 1品目 = 1行。行は消さず「消した印」(deleted) を立てる（削除も相手に伝えるため）
 *   - updatedAt はクライアントが打った時刻。ぶつかったら新しいほうを採る（後勝ち）
 *   - srv はサーバーが打った時刻。「前回の続きから」を取るための目印。
 *     端末の時計がずれていても取りこぼさないよう、目印は必ずサーバー時刻を使う
 */

var SHEET_NAME = 'data';
var HEADERS = ['house', 'kind', 'id', 'name', 'qty', 'unit', 'expiry',
               'addedAt', 'updatedAt', 'srv', 'deleted', 'by', 'done'];

/** 動作確認用。ブラウザで /exec を開くとこれが返る */
function doGet(e) {
  return json({ ok: true, message: 'ウチの冷蔵庫 共有API 稼働中' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: '中身が空のリクエストです' });
    }
    var req = JSON.parse(e.postData.contents);
    if (req.action !== 'sync') return json({ ok: false, error: '不明な action です' });

    var house = String(req.house || '').trim();
    if (house.length < 4) return json({ ok: false, error: '家族コードが短すぎます（4文字以上）' });

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return json({ ok: false, error: '混み合っています。少しあとでもう一度' });
    try {
      return json(syncImpl(house, Number(req.since) || 0, req.changes || []));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

function syncImpl(house, since, changes) {
  var sh = getSheet();
  var last = sh.getLastRow();
  var values = last < 2 ? [] : sh.getRange(2, 1, last - 1, HEADERS.length).getValues();

  // house + kind + id  ->  values の添字
  var index = {};
  for (var i = 0; i < values.length; i++) {
    index[key(values[i][0], values[i][1], values[i][2])] = i;
  }

  var now = Date.now();
  var appends = [];
  // 送られてきた品目は、採用しなかったものも含めて必ず返す。
  // そうしないと「古いから弾いた」ことが送り主に伝わらず、ずれたまま残る
  var touched = {};

  for (var c = 0; c < changes.length; c++) {
    var ch = changes[c];
    if (!ch || !ch.id || (ch.kind !== 'fridge' && ch.kind !== 'shop')) continue;

    var row = [
      house,
      String(ch.kind),
      String(ch.id),
      String(ch.name || ''),
      Number(ch.qty) || 0,
      String(ch.unit || ''),
      String(ch.expiry || ''),
      Number(ch.addedAt) || now,
      Number(ch.updatedAt) || now,
      now,
      ch.deleted ? 1 : 0,
      String(ch.by || ''),
      ch.done ? 1 : 0
    ];

    var k = key(house, ch.kind, ch.id);
    touched[k] = true;
    if (k in index) {
      var at = index[k];
      // 後勝ち。サーバー側のほうが新しければ受け取らない
      if ((Number(values[at][8]) || 0) <= row[8]) {
        values[at] = row;
        sh.getRange(at + 2, 1, 1, HEADERS.length).setValues([row]);
      }
    } else {
      index[k] = values.length;
      values.push(row);
      appends.push(row);
    }
  }

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, HEADERS.length).setValues(appends);
  }

  // 前回の続き（srv > since）だけ返す
  var rows = [];
  for (var j = 0; j < values.length; j++) {
    var v = values[j];
    if (String(v[0]) !== house) continue;
    if ((Number(v[9]) || 0) <= since && !touched[key(v[0], v[1], v[2])]) continue;
    rows.push({
      kind: String(v[1]),
      id: String(v[2]),
      name: String(v[3]),
      qty: Number(v[4]) || 0,
      unit: String(v[5]),
      expiry: String(v[6] || ''),
      addedAt: Number(v[7]) || 0,
      updatedAt: Number(v[8]) || 0,
      deleted: !!Number(v[10]),
      by: String(v[11] || ''),
      done: !!Number(v[12])
    });
  }

  return { ok: true, now: now, rows: rows };
}

/* ---------- 小道具 ---------- */

function key(house, kind, id) {
  return String(house) + '\t' + String(kind) + '\t' + String(id);
}

function getSheet() {
  var ss = SpreadsheetApp.getActive();
  if (!ss) {
    throw new Error('スプレッドシートに紐づいていません。'
      + 'スプレッドシートの「拡張機能 > Apps Script」から作り直してください');
  }
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    // 日付や長い数値を勝手に変換されないよう、全部「書式なしテキスト」にしておく
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/** 初回に1回だけエディタから実行して、シートを用意する（任意） */
function setup() {
  getSheet();
  Logger.log('準備できました: ' + SpreadsheetApp.getActive().getUrl());
}
