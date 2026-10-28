// 旅遊阿焙焙：跟家人一起看、一起改的旅遊行程。版面和小工具沿用小助手阿焙焙手機版。
// 資料是一筆一筆的「項目」（旅程設定、行程、清單、花費、資訊），每筆帶 at（最後修改時間），
// 雲端（旅遊雲端同步\Code.gs）一筆一筆合併，好幾個人同時改不同的東西不會互相蓋掉。
'use strict';

const STORAGE_KEY = 'trip-baozi-v1';
const SYNC_STORAGE_KEY = 'trip-baozi-sync';
// 測試用 ?ns=test，資料會存到雲端另一個檔案，不會動到正式的旅程
const SYNC_NS = (() => {
  const value = new URLSearchParams(location.search).get('ns') || '';
  return /^[a-z0-9_-]{1,20}$/.test(value) ? value : 'main';
})();
const SYNC_POLL_MS = 20000;
const MAX_TRIP_DAYS = 60;
const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
const AVATAR_PALETTE = ['#FF93B3', '#B9A6FF', '#7FDDB8', '#7FCBEE', '#FFB366'];

const PLAN_CATS = {
  sight: { icon: '🏯', label: '景點', color: '#B9A6FF' },
  food: { icon: '🍜', label: '美食', color: '#FF93B3' },
  move: { icon: '🚗', label: '交通', color: '#7FCBEE' },
  stay: { icon: '🏨', label: '住宿', color: '#7FDDB8' },
  shop: { icon: '🛍️', label: '購物', color: '#FFB366' },
  other: { icon: '📌', label: '其他', color: '#C9C2D6' },
};
const LISTS = {
  pack: { icon: '🧳', label: '行李', short: '行李', placeholder: '例如：護照、充電器' },
  todo: { icon: '✅', label: '出發前待辦', short: '待辦', placeholder: '例如：換外幣、訂餐廳' },
  buy: { icon: '🎁', label: '伴手禮・想買', short: '伴手禮', placeholder: '例如：抹茶餅乾' },
};
const INFO_CATS = {
  flight: { icon: '✈️', label: '航班・交通' },
  stay: { icon: '🏨', label: '住宿' },
  contact: { icon: '📞', label: '聯絡・緊急' },
  other: { icon: '📝', label: '其他' },
};
const TYPE_LABELS = { trip: '旅程設定', plan: '行程', check: '清單', expense: '花費', info: '資訊' };
// 分頁和資料種類的對應，用來判斷分頁上要不要亮紅點（別人改過、自己還沒點進去看）
const TAB_TYPES = { plan: 'plan', list: 'check', money: 'expense', info: 'info' };
const TAB_SUBTITLES = {
  home: '一起出去玩吧 ✈️',
  plan: '每天要去哪裡 🗺️',
  list: '東西都帶齊了嗎 🧳',
  money: '誰付了多少 💰',
  info: '航班、住宿、電話 📒',
};
const CURRENCY_SUGGESTIONS = ['台幣', '日圓', '韓元', '泰銖', '美元', '歐元', '港幣', '人民幣', '新加坡幣', '越南盾'];

// ───────────────────────── 小工具 ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function uid() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayIso() { return isoDate(new Date()); }
function nowTime() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function parseIso(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
    - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

// 「2026-11-20」→「11/20（五）」
function friendlyDate(text) {
  const d = parseIso(text);
  if (!d) return text || '';
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_CHARS[d.getDay()]}）`;
}

function avatarColor(seed) {
  let h = 0;
  for (const ch of (seed || '?')) h += ch.codePointAt(0);
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function avatarHtml(name, size = '') {
  return `<span class="avatar ${size}" style="background:${avatarColor(name)}">${esc([...(name || '?')][0])}</span>`;
}

function agoText(at) {
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtNumber(n) {
  return Number(n || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}

// 網址變成可以點的連結（先 esc 再換，不會被塞 HTML）
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

// 只讓 http／https 的網址變成連結，雲端資料被塞 javascript: 之類的也不會被執行
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch (e) {
    return '';
  }
}

function mapUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

// ───────────────────────── 焙子（家裡的倉鼠）─────────────────────────
const CHEERS = ['吱吱～又準備好一樣了！🐹', '焙子說：好棒！🌻', '焙子幫你把它放進行李箱了 🧳', '吱～出發倒數又近一步！✈️'];
function cheer() { toast(CHEERS[Math.floor(Math.random() * CHEERS.length)]); }

const SLEEP_IMG = '<img class="sleep-art" src="art/sleep.png" alt="">';
function emptyArtHtml(text) {
  return `<div class="empty-art">${SLEEP_IMG}<p>${text}</p></div>`;
}

let toastTimer = null;
function toast(text, duration = 1800) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// iOS 網頁裡不能用 confirm()，刪除類按鈕改成「按第一次變紅字確認，3 秒內再按一次才真的執行」
let confirmState = { key: null, timer: null };
function confirmTwice(button, key, action) {
  if (confirmState.key === key) {
    clearTimeout(confirmState.timer);
    confirmState = { key: null, timer: null };
    action();
    return;
  }
  clearTimeout(confirmState.timer);
  document.querySelectorAll('.confirming').forEach(el => {
    el.classList.remove('confirming');
    el.textContent = el.dataset.origText;
  });
  button.dataset.origText = button.textContent;
  button.textContent = button.dataset.confirmText || '再按一次確定';
  button.classList.add('confirming');
  confirmState = {
    key,
    timer: setTimeout(() => {
      button.classList.remove('confirming');
      button.textContent = button.dataset.origText;
      confirmState = { key: null, timer: null };
    }, 3000),
  };
}

// ───────────────────────── 資料 ─────────────────────────
// store.items：雲端最新的資料再蓋上自己還沒傳上去的修改；store.pending：還沒收到雲端確認的修改
function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY + ':' + SYNC_NS));
    if (saved && saved.items && saved.pending) return saved;
  } catch (e) { /* 壞掉就重新開始 */ }
  return { items: {}, pending: {}, loaded: false };
}

function saveStore() {
  localStorage.setItem(STORAGE_KEY + ':' + SYNC_NS, JSON.stringify(store));
}

// 連線資訊和「我是誰」只存在這台裝置
function loadSync() {
  try {
    const saved = JSON.parse(localStorage.getItem(SYNC_STORAGE_KEY + ':' + SYNC_NS));
    if (saved && typeof saved === 'object') return Object.assign({ url: '', key: '', me: '', seen: {} }, saved);
  } catch (e) { /* 壞掉就重新設定 */ }
  return { url: '', key: '', me: '', seen: {} };
}

function saveSync() {
  localStorage.setItem(SYNC_STORAGE_KEY + ':' + SYNC_NS, JSON.stringify(sync));
}

let store = loadStore();
let sync = loadSync();
const ui = { tab: 'home', day: null, list: 'pack', mineOnly: false, joinError: '', joining: false, addingMember: false };

function trip() {
  const t = store.items.trip;
  return t && !t.deleted ? t : null;
}

function members() { return (trip() && trip().members) || []; }

function itemsOf(type) {
  return Object.values(store.items).filter(item => !item.deleted && item.type === type);
}

function tripDays() {
  const t = trip();
  const start = t && parseIso(t.start);
  const end = t && parseIso(t.end);
  if (!start || !end || end < start) return start ? [isoDate(start)] : [];
  const days = [];
  for (let d = new Date(start); d <= end && days.length < MAX_TRIP_DAYS; d.setDate(d.getDate() + 1)) days.push(isoDate(d));
  return days;
}

// 旅程進行到哪裡：before（還沒出發）／during（玩到第幾天）／after（回來了）／none（還沒填日期）
function tripPhase() {
  const days = tripDays();
  if (!days.length) return { phase: 'none' };
  const today = new Date();
  const first = parseIso(days[0]);
  const last = parseIso(days[days.length - 1]);
  if (today < first && daysBetween(today, first) > 0) return { phase: 'before', left: daysBetween(today, first) };
  if (daysBetween(last, today) > 0) return { phase: 'after', ago: daysBetween(last, today) };
  return { phase: 'during', dayNo: daysBetween(first, today) + 1, total: days.length };
}

function dayLabel(iso) {
  const idx = tripDays().indexOf(iso);
  return idx >= 0 ? `第 ${idx + 1} 天` : '';
}

function isForeign() {
  const cur = (trip() && trip().currency || '').trim();
  return !!cur && cur !== '台幣';
}

// 改一筆資料：at 一定比舊的大（手機時間不準也不會比自己上一次舊），存起來、重畫、排隊上傳。
// base 記「這次是改哪一版雲端資料」：雲端看到 base 對得上就一定收，不會因為手機時間比別人慢被丟掉
function put(item, act = '修改') {
  const old = store.items[item.id];
  const base = store.pending[item.id] ? store.pending[item.id].base : (old ? old.at : 0);
  const next = Object.assign({}, item, { at: Math.max(Date.now(), old ? old.at + 1 : 0), base, by: sync.me || '', act });
  store.items[next.id] = next;
  store.pending[next.id] = next;
  saveStore();
  render();
  schedulePush();
}

function removeItem(id) {
  const old = store.items[id];
  put({ id, type: old && old.type, deleted: true }, '刪除');
}

// ───────────────────────── 雲端同步 ─────────────────────────
const syncRun = { busy: false, again: false, lastPull: 0, unloading: false };
let pushTimer = null;

function setSyncStatus(kind, text) {
  const el = $('#sync-status');
  if (!el) return;
  el.textContent = text;
  el.className = `sync-status ${kind}`;
}

async function cloudRequest(payload, conn = sync) {
  // body 用純文字字串，fetch 會送 text/plain，Apps Script 才不會卡在跨網域預檢
  const resp = payload === undefined
    ? await fetch(`${conn.url}?key=${encodeURIComponent(conn.key)}&ns=${SYNC_NS}`, { cache: 'no-store' })
    : await fetch(conn.url, { method: 'POST', body: JSON.stringify(Object.assign({ key: conn.key, ns: SYNC_NS }, payload)) });
  return resp.json();
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), 400);
}

// 有還沒上傳的修改就 POST（雲端合併完會回傳整份最新資料），沒有就只 GET
async function syncNow() {
  if (!sync.key) return;
  if (syncRun.busy) { syncRun.again = true; return; }
  syncRun.busy = true;
  syncRun.lastPull = Date.now();
  const ops = Object.values(store.pending);
  const conn = sync;
  setSyncStatus('busy', '同步中…');
  let result;
  try {
    result = await cloudRequest(ops.length ? { ops } : undefined, conn);
  } catch (e) {
    syncRun.busy = false;
    // App 被關掉時中斷的請求不算離線；沒傳上去的修改還在 pending，下次打開會再送
    if (!syncRun.unloading) setSyncStatus('offline', ops.length ? '⚠️ 離線，稍後上傳' : '⚠️ 離線');
    return;
  }
  syncRun.busy = false;
  // 等回應的時候換了旅程（點了另一個邀請連結），這份結果就不要了
  if (conn !== sync) return;
  if (!result.ok) {
    setSyncStatus('offline', result.error === 'bad key' ? '⚠️ 連線碼不對' : '⚠️ 雲端出錯');
    return;
  }
  // 雲端沒收的（同一筆被別人用比較新的版本改過）就改用雲端的版本，並告訴她
  const rejected = (result.rejected || []).filter(id => ops.some(op => op.id === id));
  if (rejected.length) toast(`有 ${rejected.length} 筆修改跟旅伴同時改到，已改用對方較新的版本`, 3200);
  // 傳上去之後又改過的（at 不一樣）要留著下一輪再送
  ops.forEach(op => {
    if (store.pending[op.id] && store.pending[op.id].at === op.at) delete store.pending[op.id];
  });
  applyCloud(result.items || {});
  if (syncRun.again || Object.keys(store.pending).length) {
    syncRun.again = false;
    schedulePush();
  } else {
    setSyncStatus('ok', '☁️ 已同步');
  }
}

function applyCloud(items) {
  const before = JSON.stringify(store.items);
  store.items = Object.assign({}, items, store.pending);
  const firstLoad = !store.loaded;
  store.loaded = true;
  saveStore();
  if (firstLoad || JSON.stringify(store.items) !== before) render();
}

function pullFromCloud(minInterval = 0) {
  if (!sync.key || Date.now() - syncRun.lastPull < minInterval) return Promise.resolve();
  return syncNow();
}

// 邀請連結：網址 #j= 後面放 base64 的 {u: 雲端網址, k: 連線碼}，家人點開就自動連上
function inviteLink() {
  const code = btoa(JSON.stringify({ u: sync.url, k: sync.key })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}${SYNC_NS !== 'main' ? `?ns=${SYNC_NS}` : ''}#j=${code}`;
}

function parseInvite(text) {
  const m = /#j=([A-Za-z0-9_-]+)/.exec(text || '');
  if (!m) return null;
  try {
    const data = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    return data.u && data.k ? { url: data.u, key: data.k } : null;
  } catch (e) {
    return null;
  }
}

async function connect(conn) {
  ui.joining = true;
  ui.joinError = '';
  render();
  let result;
  try {
    result = await cloudRequest(undefined, conn);
  } catch (e) {
    result = { ok: false, error: 'network' };
  }
  ui.joining = false;
  if (!result.ok) {
    ui.joinError = result.error === 'bad key' ? '連線碼不對，再跟傳連結給你的人確認一下～' : '連不上雲端，檢查一下網路或網址再試一次';
    render();
    return;
  }
  // 換了一個旅程，舊的資料就不要了
  if (conn.url !== sync.url || conn.key !== sync.key) {
    store = { items: {}, pending: {}, loaded: false };
    sync = { url: conn.url, key: conn.key, me: '', seen: {} };
  }
  markAllSeen();
  saveSync();
  applyCloud(result.items || {});
  setSyncStatus('ok', '☁️ 已同步');
}

// ───────────────────────── 紅點：別人改過、我還沒點進去看 ─────────────────────────
function markAllSeen() {
  Object.values(TAB_TYPES).forEach(type => { sync.seen[type] = Date.now(); });
}

function hasUnseen(type) {
  const seen = sync.seen[type] || 0;
  return Object.values(store.items).some(item => item.type === type && item.at > seen && item.by && item.by !== sync.me);
}

// ───────────────────────── 總覽 ─────────────────────────
function itemTitle(item) {
  return item.title || item.text || '';
}

function renderTicket() {
  const t = trip();
  const days = tripDays();
  const p = tripPhase();
  let stub;
  if (p.phase === 'before') stub = `<small>還有</small><b>${p.left}</b><small>天出發</small>`;
  else if (p.phase === 'during') stub = `<small>旅程第</small><b>${p.dayNo}</b><small>天 / 共 ${p.total} 天</small>`;
  else if (p.phase === 'after') stub = `<img class="ticket-stamp" src="art/stamp.png" alt=""><small>玩回來了～</small>`;
  else stub = '<small>出發日</small><b>？</b><small>還沒設定</small>';
  const dates = days.length ? `${friendlyDate(days[0])}<span class="arrow">✈</span>${friendlyDate(days[days.length - 1])}` : '到「旅程設定」填日期';
  return `
    <section class="ticket">
      <div class="ticket-main">
        <div class="ticket-label">BOARDING PASS</div>
        <h2 class="ticket-name">${esc(t.name || '我們的旅行')}</h2>
        <div class="ticket-dates">${dates}</div>
        <div class="ticket-meta">
          <span>👨‍👩‍👧 ${members().length} 位旅伴</span>
          ${days.length ? `<span>🗓️ ${days.length} 天</span>` : ''}
          ${t.currency ? `<span>💱 ${esc(t.currency)}</span>` : ''}
        </div>
      </div>
      <div class="ticket-stub">${stub}</div>
      <img class="ticket-baozi" src="art/avatar.png" alt="">
    </section>`;
}

function renderDayStrip() {
  const days = tripDays();
  if (!days.length) return '';
  const today = todayIso();
  const plans = itemsOf('plan');
  return `
    <div class="day-strip">
      ${days.map((iso, i) => {
        const count = plans.filter(p => p.day === iso).length;
        const past = iso < today;
        const stamp = past ? `<img class="stamp" src="art/stamp.png" alt="" style="transform:rotate(${-((i * 37) % 4) * 9 + 12}deg)">` : '';
        return `
          <button class="day-pill${iso === today ? ' today' : ''}${past ? ' past' : ''}" data-go-day="${iso}">
            ${stamp}
            <small>D${i + 1}</small>
            <b>${parseIso(iso).getMonth() + 1}/${parseIso(iso).getDate()}</b>
            <small>週${WEEKDAY_CHARS[parseIso(iso).getDay()]}</small>
            <span class="day-count">${count ? `${count} 個行程` : '－'}</span>
          </button>`;
      }).join('')}
    </div>`;
}

function sortPlans(list) {
  return list.slice().sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.at - b.at);
}

function renderHomePlans() {
  const p = tripPhase();
  const days = tripDays();
  let day;
  let title;
  if (p.phase === 'during') { day = todayIso(); title = `☀️ 今天的行程（第 ${p.dayNo} 天）`; }
  else if (p.phase === 'before') { day = days[0]; title = '🎒 第一天的行程'; }
  else return '';
  const plans = sortPlans(itemsOf('plan').filter(item => item.day === day));
  const now = nowTime();
  const nextId = p.phase === 'during' ? (plans.find(item => item.time && item.time >= now) || {}).id : null;
  return `
    <section class="card">
      <h2 class="card-title">${title}<button class="btn small ghost" data-go-day="${day}">看全部</button></h2>
      ${plans.length ? plans.map(item => {
        const cat = PLAN_CATS[item.cat] || PLAN_CATS.other;
        return `
          <div class="mini-plan${item.id === nextId ? ' next' : ''}" data-edit-plan="${item.id}">
            <span class="mini-time">${esc(item.time || '－')}</span>
            <span class="mini-icon" style="background:${cat.color}33">${cat.icon}</span>
            <span class="mini-title">${esc(item.title)}</span>
            ${item.id === nextId ? '<span class="next-tag">下一站</span>' : ''}
          </div>`;
      }).join('') : '<p class="empty">這天還沒有安排，到「行程」分頁新增吧～</p>'}
    </section>`;
}

function renderHomeLists() {
  const checks = itemsOf('check');
  const mine = checks.filter(c => !c.done && c.who === sync.me).length;
  return `
    <section class="card">
      <h2 class="card-title">🧳 準備進度<button class="btn small ghost" data-tab-go="list">打開清單</button></h2>
      ${Object.entries(LISTS).map(([key, list]) => {
        const all = checks.filter(c => c.list === key);
        const done = all.filter(c => c.done).length;
        const ratio = all.length ? Math.round(done / all.length * 100) : 0;
        return `
          <button class="progress-row" data-go-list="${key}">
            <span class="pr-label">${list.icon} ${list.label}</span>
            <span class="bar"><span class="${all.length && done === all.length ? 'full' : ''}" style="width:${ratio}%"></span></span>
            <span class="pr-num">${done}/${all.length}</span>
          </button>`;
      }).join('')}
      ${mine ? `<p class="notice">🐹 你負責的還有 <b>${mine}</b> 項沒完成</p>` : ''}
    </section>`;
}

function renderHomeMoney() {
  const s = moneySummary();
  if (!s.count) return '';
  const meBal = s.groups.map(g => {
    const v = g.balance[sync.me] || 0;
    if (Math.abs(v) < 0.5) return '';
    return v > 0 ? `大家要還你 ${moneyText(v, g.cur)}` : `你還要給別人 ${moneyText(-v, g.cur)}`;
  }).filter(Boolean).join('、');
  return `
    <section class="card">
      <h2 class="card-title">💰 花費<button class="btn small ghost" data-tab-go="money">看明細</button></h2>
      <div class="money-big">${s.groups.map(g => moneyText(g.total, g.cur)).join(' ＋ ')}</div>
      <p class="hint">共 ${s.count} 筆${meBal ? `・${meBal}` : ''}</p>
    </section>`;
}

function renderFeed() {
  const recent = Object.values(store.items)
    .filter(item => item.by && item.by !== sync.me && item.type)
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);
  if (!recent.length) return '';
  return `
    <section class="card">
      <h2 class="card-title pink">📣 旅伴最近更新</h2>
      ${recent.map(item => `
        <div class="feed-row">
          ${avatarHtml(item.by, 'small')}
          <span class="feed-text"><b>${esc(item.by)}</b> ${esc(item.act || '修改')}了${TYPE_LABELS[item.type] || ''}${item.deleted || item.type === 'trip' ? '' : `「${esc(itemTitle(item))}」`}</span>
          <span class="feed-time">${agoText(item.at)}</span>
        </div>`).join('')}
    </section>`;
}

function renderHome() {
  return `
    ${renderTicket()}
    ${renderDayStrip()}
    <div class="home-grid">
      <div>${renderHomePlans()}${renderHomeLists()}</div>
      <div>
        ${renderHomeMoney()}
        <section class="card">
          <h2 class="card-title">👨‍👩‍👧 旅伴<button class="btn small ghost" data-action="share-invite">📤 邀請</button></h2>
          <div class="member-row">
            ${members().map(name => `<span class="member">${avatarHtml(name)}<span>${esc(name)}${name === sync.me ? '<small>（我）</small>' : ''}</span></span>`).join('')}
          </div>
        </section>
        ${renderFeed()}
      </div>
    </div>`;
}

// ───────────────────────── 行程 ─────────────────────────
function currentDay() {
  const days = tripDays();
  if (ui.day !== null && (ui.day === '' || days.includes(ui.day))) return ui.day;
  const today = todayIso();
  return days.includes(today) ? today : (days[0] || '');
}

function renderPlan() {
  const days = tripDays();
  const day = currentDay();
  const plans = itemsOf('plan');
  const dayButtons = days.map((iso, i) => {
    const count = plans.filter(p => p.day === iso).length;
    return `
      <button class="day-tab${iso === day ? ' selected' : ''}${iso === todayIso() ? ' today' : ''}" data-day="${iso}">
        <b>D${i + 1}</b><span>${friendlyDate(iso)}</span>${count ? `<em>${count}</em>` : ''}
      </button>`;
  }).join('');
  const wishCount = plans.filter(p => !p.day).length;
  const list = sortPlans(plans.filter(p => (p.day || '') === day));
  const now = nowTime();
  const nextId = day === todayIso() ? (list.find(item => item.time && item.time >= now) || {}).id : null;
  const heading = day
    ? `<h2 class="plan-heading">${dayLabel(day)}<small>${friendlyDate(day)}</small></h2>`
    : '<h2 class="plan-heading">💡 想去的地方<small>還沒排進哪一天的</small></h2>';
  return `
    <div class="plan-layout">
      <div class="day-tabs">
        ${dayButtons}
        <button class="day-tab wish${day === '' ? ' selected' : ''}" data-day=""><b>💡</b><span>想去的地方</span>${wishCount ? `<em>${wishCount}</em>` : ''}</button>
      </div>
      <div class="plan-main">
        ${heading}
        ${!days.length ? '<p class="notice">還沒設定旅行日期～右上角「⚙️ 旅程設定」填好，就會出現每天的分頁</p>' : ''}
        ${list.length ? `<div class="timeline">${list.map(item => planItemHtml(item, item.id === nextId)).join('')}</div>`
          : emptyArtHtml(day ? '這天還沒有安排～按右下角「＋」新增' : '看到想去的店或景點，先記在這裡')}
      </div>
    </div>`;
}

function planItemHtml(item, isNext) {
  const cat = PLAN_CATS[item.cat] || PLAN_CATS.other;
  return `
    <article class="tl-item${isNext ? ' next' : ''}" data-edit-plan="${item.id}" style="--c:${cat.color}">
      <div class="tl-time">${esc(item.time || '')}</div>
      <div class="tl-dot">${cat.icon}</div>
      <div class="tl-card">
        <div class="tl-head"><b>${esc(item.title)}</b>${isNext ? '<span class="next-tag">下一站</span>' : ''}<span class="tl-cat">${cat.label}</span></div>
        ${item.place ? `<a class="tl-place" href="${mapUrl(item.place)}" target="_blank" rel="noopener">📍 ${esc(item.place)}</a>` : ''}
        ${item.note ? `<p class="tl-note">${linkify(item.note)}</p>` : ''}
        ${safeUrl(item.url) ? `<a class="tl-link" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener">🔗 相關連結</a>` : ''}
        <span class="tl-by">${item.by ? `${esc(item.by)} · ` : ''}${agoText(item.at)}${item.act === '新增' ? '新增' : '更新'}</span>
      </div>
    </article>`;
}

function dayOptions(selected, { wish = true, before = false } = {}) {
  const days = tripDays();
  const opts = days.map((iso, i) => `<option value="${iso}"${iso === selected ? ' selected' : ''}>第 ${i + 1} 天 ${friendlyDate(iso)}</option>`);
  if (before) opts.unshift(`<option value=""${!selected ? ' selected' : ''}>出發前（訂票、訂房等）</option>`);
  if (wish) opts.push(`<option value=""${!selected ? ' selected' : ''}>💡 想去的地方（還沒排日期）</option>`);
  return opts.join('');
}

function chipsHtml(name, options, selected) {
  return `<div class="chips" data-chip-group="${name}">${Object.entries(options).map(([key, opt]) => `
    <button type="button" class="chip${key === selected ? ' selected' : ''}" data-chip="${key}">${opt.icon} ${opt.label}</button>`).join('')}</div>`;
}

function bindChips(overlay, single = true) {
  overlay.querySelectorAll('[data-chip-group]').forEach(group => {
    group.addEventListener('click', e => {
      const chip = e.target.closest('[data-chip]');
      if (!chip) return;
      const multi = group.dataset.multi === '1';
      if (multi) chip.classList.toggle('selected');
      else group.querySelectorAll('[data-chip]').forEach(c => c.classList.toggle('selected', c === chip));
      group.dispatchEvent(new Event('chipchange'));
    });
  });
}

function chipValue(overlay, name) {
  const chip = overlay.querySelector(`[data-chip-group="${name}"] .chip.selected`);
  return chip ? chip.dataset.chip : '';
}

function chipValues(overlay, name) {
  return Array.from(overlay.querySelectorAll(`[data-chip-group="${name}"] .chip.selected`), c => c.dataset.chip);
}

function openPlanSheet(id) {
  const old = id ? store.items[id] : null;
  const item = old || { cat: 'sight', day: currentDay(), time: '', title: '', place: '', url: '', note: '' };
  const overlay = openSheet({
    title: old ? '編輯行程' : '新增行程',
    body: `
      <label class="field-label">類型</label>
      ${chipsHtml('cat', PLAN_CATS, item.cat || 'other')}
      <label class="field-label" for="f-title">名稱</label>
      <input id="f-title" class="input" value="${esc(item.title)}" placeholder="例如：清水寺、一蘭拉麵">
      <div class="two-col">
        <div>
          <label class="field-label" for="f-day">哪一天</label>
          <select id="f-day" class="select">${dayOptions(item.day)}</select>
        </div>
        <div>
          <label class="field-label" for="f-time">時間（可不填）</label>
          <input id="f-time" class="input" type="time" value="${esc(item.time)}">
        </div>
      </div>
      <label class="field-label" for="f-place">地點（會變成 Google 地圖連結）</label>
      <input id="f-place" class="input" value="${esc(item.place)}" placeholder="店名或地址">
      <label class="field-label" for="f-note">備註</label>
      <textarea id="f-note" class="textarea" placeholder="例如：要先預約、門票 600 円、記得帶零錢">${esc(item.note)}</textarea>
      <label class="field-label" for="f-url">相關連結（訂位、官網，可不填）</label>
      <input id="f-url" class="input" type="url" value="${esc(item.url)}" placeholder="https://">
      ${old ? `<p class="hint">最後由 ${esc(old.by || '某人')} 在 ${agoText(old.at)}更新</p>
        <button class="btn danger block" data-delete>🗑️ 刪除這個行程</button>` : ''}`,
    footer: formFooter,
    onMount: overlay => {
      bindChips(overlay);
      if (!old) setTimeout(() => $('#f-title', overlay).focus(), 250);
    },
  });
  bindFormButtons(overlay, () => {
    const title = $('#f-title', overlay).value.trim();
    if (!title) { toast('先填名稱喔'); return false; }
    let url = $('#f-url', overlay).value.trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (url && !safeUrl(url)) { toast('連結看起來不對，檢查一下'); return false; }
    const day = $('#f-day', overlay).value;
    put({
      id: old ? old.id : uid(), type: 'plan', cat: chipValue(overlay, 'cat') || 'other', title,
      day, time: $('#f-time', overlay).value, place: $('#f-place', overlay).value.trim(),
      note: $('#f-note', overlay).value.trim(), url,
    }, old ? '修改' : '新增');
    ui.day = day;
    render();
    toast(old ? '改好了 ✨' : '行程加好了 🐹');
  });
  bindDelete(overlay, old, '行程刪掉了');
}

function bindDelete(overlay, old, message) {
  const btn = overlay.querySelector('[data-delete]');
  if (!btn || !old) return;
  btn.addEventListener('click', () => confirmTwice(btn, 'delete-' + old.id, () => {
    removeItem(old.id);
    closeSheet();
    toast(message);
  }));
}

// ───────────────────────── 清單 ─────────────────────────
function renderList() {
  const checks = itemsOf('check');
  const all = checks.filter(c => c.list === ui.list);
  const shown = all.filter(c => !ui.mineOnly || c.who === sync.me || !c.who)
    .sort((a, b) => (a.done - b.done) || (a.created || a.at) - (b.created || b.at));
  const done = all.filter(c => c.done).length;
  const list = LISTS[ui.list];
  return `
    <div class="segmented big">
      ${Object.entries(LISTS).map(([key, l]) => {
        const n = checks.filter(c => c.list === key && !c.done).length;
        return `<button class="${key === ui.list ? 'selected' : ''}" data-list="${key}">${l.icon} ${l.short}${n ? `<em>${n}</em>` : ''}</button>`;
      }).join('')}
    </div>
    <section class="card">
      <div class="list-progress">
        <span class="bar"><span class="${all.length && done === all.length ? 'full' : ''}" style="width:${all.length ? done / all.length * 100 : 0}%"></span></span>
        <span>${done}/${all.length} 完成</span>
      </div>
      <div class="input-row quick-add">
        <input id="quick-add" class="input" placeholder="${list.placeholder}" enterkeyhint="done">
        <select id="quick-who" class="select who-select">
          <option value="">大家</option>
          ${members().map(name => `<option value="${esc(name)}"${name === ui.lastWho ? ' selected' : ''}>${esc(name)}</option>`).join('')}
        </select>
        <button class="btn primary" data-action="quick-add">加入</button>
      </div>
      <label class="check filter-check">
        <input type="checkbox" data-action="mine-only"${ui.mineOnly ? ' checked' : ''}><span class="box"></span>
        <span class="label">只看「我」和「大家」的</span>
      </label>
    </section>
    ${shown.length ? shown.map(c => `
      <div class="list-row${c.done ? ' is-done' : ''}">
        <label class="check">
          <input type="checkbox" data-toggle-check="${c.id}"${c.done ? ' checked' : ''}><span class="box"></span>
          <span class="label strike">${esc(c.text)}</span>
        </label>
        ${c.done && c.doneBy ? `<span class="done-by">✓ ${esc(c.doneBy)}</span>` : ''}
        <span class="who-pill${c.who === sync.me ? ' me' : ''}">${esc(c.who || '大家')}</span>
        <button class="icon-btn" data-edit-check="${c.id}" aria-label="編輯">✏️</button>
      </div>`).join('') : emptyArtHtml(all.length ? '都完成啦，焙子幫你拍拍 🐹' : '清單空空的～在上面輸入新增')}`;
}

function quickAdd() {
  const input = $('#quick-add');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const who = $('#quick-who').value;
  ui.lastWho = who;
  input.value = '';
  put({ id: uid(), type: 'check', list: ui.list, text, who, done: false, doneBy: '', created: Date.now() }, '新增');
  $('#quick-add').focus();
}

function openCheckSheet(id) {
  const old = store.items[id];
  if (!old) return;
  const overlay = openSheet({
    title: '編輯清單項目',
    body: `
      <label class="field-label" for="f-text">內容</label>
      <input id="f-text" class="input" value="${esc(old.text)}">
      <label class="field-label">放在哪個清單</label>
      ${chipsHtml('list', LISTS, old.list)}
      <label class="field-label" for="f-who">誰負責</label>
      <select id="f-who" class="select">
        <option value="">大家</option>
        ${members().map(name => `<option value="${esc(name)}"${name === old.who ? ' selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      <p class="hint" style="margin-top:12px">最後由 ${esc(old.by || '某人')} 在 ${agoText(old.at)}更新</p>
      <button class="btn danger block" data-delete>🗑️ 刪除</button>`,
    footer: formFooter,
    onMount: overlay => bindChips(overlay),
  });
  bindFormButtons(overlay, () => {
    const text = $('#f-text', overlay).value.trim();
    if (!text) { toast('內容不能空白'); return false; }
    put(Object.assign({}, old, { text, list: chipValue(overlay, 'list') || old.list, who: $('#f-who', overlay).value }));
  });
  bindDelete(overlay, old, '刪掉了');
}

// ───────────────────────── 花費 ─────────────────────────
function curLabel(cur) {
  return cur === 'TWD' ? '台幣' : (trip() && trip().currency) || '當地幣';
}

function moneyText(amount, cur) {
  return cur === 'TWD' ? `NT$ ${fmtNumber(Math.round(amount))}` : `${fmtNumber(amount)} ${curLabel(cur)}`;
}

// 有填匯率就全部換成台幣一起算；沒填匯率的外幣花費另外算一組
function moneySummary() {
  const rate = Number(trip() && trip().rate) || 0;
  const expenses = itemsOf('expense');
  const groups = {};
  expenses.forEach(e => {
    const local = isForeign() && e.cur !== 'TWD';
    const cur = local && !rate ? 'local' : 'TWD';
    const amount = local && rate ? e.amount * rate : e.amount;
    const g = groups[cur] || (groups[cur] = { cur, total: 0, balance: {}, paid: {} });
    g.total += amount;
    g.balance[e.payer] = (g.balance[e.payer] || 0) + amount;
    g.paid[e.payer] = (g.paid[e.payer] || 0) + amount;
    const split = e.split && e.split.length ? e.split : members();
    split.forEach(name => { g.balance[name] = (g.balance[name] || 0) - amount / split.length; });
  });
  const list = Object.values(groups).sort((a, b) => (a.cur === 'TWD' ? -1 : 1));
  list.forEach(g => { g.transfers = settle(g.balance); });
  return { count: expenses.length, groups: list, needRate: isForeign() && !rate && expenses.some(e => e.cur !== 'TWD') };
}

// 最少轉帳次數的近似：每次讓欠最多的人還給被欠最多的人
function settle(balance) {
  const people = Object.entries(balance).map(([name, v]) => ({ name, v }));
  const transfers = [];
  for (let guard = 0; guard < 50; guard++) {
    people.sort((a, b) => a.v - b.v);
    const debtor = people[0];
    const creditor = people[people.length - 1];
    if (!debtor || debtor.v > -0.5 || creditor.v < 0.5) break;
    const amount = Math.min(-debtor.v, creditor.v);
    transfers.push({ from: debtor.name, to: creditor.name, amount });
    debtor.v += amount;
    creditor.v -= amount;
  }
  return transfers;
}

function renderMoney() {
  const s = moneySummary();
  const expenses = itemsOf('expense').sort((a, b) => (b.day || '').localeCompare(a.day || '') || b.at - a.at);
  const byDay = {};
  expenses.forEach(e => { (byDay[e.day || ''] = byDay[e.day || ''] || []).push(e); });
  const summary = s.groups.map(g => `
    <section class="card money-card">
      <h2 class="card-title">${g.cur === 'TWD' ? '💰 總花費（台幣）' : `💴 ${esc(curLabel('local'))}花費`}</h2>
      <div class="money-big">${moneyText(g.total, g.cur)}</div>
      <div class="paid-list">
        ${Object.entries(g.paid).sort((a, b) => b[1] - a[1]).map(([name, v]) => `
          <span class="paid">${avatarHtml(name, 'small')}<span>${esc(name)} 付了<br><b>${moneyText(v, g.cur)}</b></span></span>`).join('')}
      </div>
      <h3 class="sub-title">🤝 結算建議</h3>
      ${g.transfers.length ? g.transfers.map(t => `
        <div class="transfer">${avatarHtml(t.from, 'small')}<b>${esc(t.from)}</b><span class="t-arrow">給</span>${avatarHtml(t.to, 'small')}<b>${esc(t.to)}</b><span class="t-amount">${moneyText(t.amount, g.cur)}</span></div>`).join('')
        : '<p class="empty">大家剛好打平 🎉</p>'}
    </section>`).join('');
  return `
    ${s.needRate ? '<p class="notice">💡 到「⚙️ 旅程設定」填匯率，外幣和台幣的花費就能合在一起算</p>' : ''}
    ${s.count ? `<div class="money-grid">${summary}</div>` : ''}
    ${Object.keys(byDay).length ? Object.entries(byDay).map(([day, list]) => `
      <h2 class="section-title">${day ? `${dayLabel(day) || ''} ${friendlyDate(day)}` : '出發前'}</h2>
      ${list.map(e => `
        <div class="expense-row" data-edit-expense="${e.id}">
          ${avatarHtml(e.payer)}
          <span class="ex-text"><b>${esc(e.title)}</b><small>${esc(e.payer)} 付・${e.split && e.split.length && e.split.length !== members().length ? `${e.split.length} 人分` : '大家分'}</small></span>
          <span class="ex-amount">${moneyText(e.amount, isForeign() && e.cur !== 'TWD' ? 'local' : 'TWD')}</span>
        </div>`).join('')}`).join('')
      : emptyArtHtml('還沒有記花費～按右下角「＋」記一筆')}`;
}

function memberChips(name, selected, multi) {
  return `<div class="chips" data-chip-group="${name}"${multi ? ' data-multi="1"' : ''}>${members().map(m => `
    <button type="button" class="chip person${selected.includes(m) ? ' selected' : ''}" data-chip="${esc(m)}">${avatarHtml(m, 'tiny')}${esc(m)}</button>`).join('')}</div>`;
}

function openExpenseSheet(id) {
  const old = id ? store.items[id] : null;
  const p = tripPhase();
  const e = old || {
    title: '', amount: '', cur: isForeign() ? 'local' : 'TWD', payer: sync.me,
    split: members().slice(), day: p.phase === 'during' ? todayIso() : '',
  };
  const overlay = openSheet({
    title: old ? '編輯花費' : '記一筆花費',
    body: `
      <label class="field-label" for="f-title">買了什麼</label>
      <input id="f-title" class="input" value="${esc(e.title)}" placeholder="例如：晚餐燒肉、機票">
      <label class="field-label" for="f-amount">金額</label>
      <div class="input-row">
        <input id="f-amount" class="input" inputmode="decimal" value="${esc(e.amount)}" placeholder="0">
        ${isForeign() ? `<div class="segmented cur-toggle" data-chip-group="cur">
          <button type="button" class="chip${e.cur !== 'TWD' ? ' selected' : ''}" data-chip="local">${esc(curLabel('local'))}</button>
          <button type="button" class="chip${e.cur === 'TWD' ? ' selected' : ''}" data-chip="TWD">台幣</button>
        </div>` : ''}
      </div>
      <label class="field-label" for="f-day">日期</label>
      <select id="f-day" class="select">${dayOptions(e.day, { wish: false, before: true })}</select>
      <label class="field-label">誰付的</label>
      ${memberChips('payer', [e.payer], false)}
      <label class="field-label">分給誰<button type="button" class="link-btn" data-all-split>全選</button></label>
      ${memberChips('split', e.split && e.split.length ? e.split : members(), true)}
      ${old ? `<p class="hint">最後由 ${esc(old.by || '某人')} 在 ${agoText(old.at)}更新</p>
        <button class="btn danger block" data-delete>🗑️ 刪除這筆</button>` : ''}`,
    footer: formFooter,
    onMount: overlay => {
      bindChips(overlay);
      overlay.querySelector('[data-all-split]').addEventListener('click', () => {
        overlay.querySelectorAll('[data-chip-group="split"] .chip').forEach(c => c.classList.add('selected'));
      });
      if (!old) setTimeout(() => $('#f-title', overlay).focus(), 250);
    },
  });
  bindFormButtons(overlay, () => {
    const title = $('#f-title', overlay).value.trim();
    const cur = isForeign() ? (chipValue(overlay, 'cur') || 'local') : 'TWD';
    // 台幣沒有小數，存整數，結算加起來才會剛好
    let amount = Number($('#f-amount', overlay).value.replace(/,/g, ''));
    if (cur === 'TWD') amount = Math.round(amount);
    const payer = chipValue(overlay, 'payer');
    const split = chipValues(overlay, 'split');
    if (!title) { toast('先寫買了什麼喔'); return false; }
    if (!(amount > 0)) { toast('金額要大於 0'); return false; }
    if (!payer) { toast('選一下是誰付的'); return false; }
    if (!split.length) { toast('至少選一個人分'); return false; }
    put({
      id: old ? old.id : uid(), type: 'expense', title, amount,
      cur,
      day: $('#f-day', overlay).value, payer, split,
    }, old ? '修改' : '新增');
    toast(old ? '改好了 ✨' : '記下來了 💰');
  });
  bindDelete(overlay, old, '這筆刪掉了');
}

// ───────────────────────── 資訊 ─────────────────────────
function renderInfo() {
  const infos = itemsOf('info');
  if (!infos.length) return emptyArtHtml('航班時間、飯店地址、緊急電話⋯⋯<br>記在這裡大家都看得到，按右下角「＋」新增');
  return `<div class="info-grid">${Object.entries(INFO_CATS).map(([key, cat]) => {
    const list = infos.filter(i => (i.cat || 'other') === key).sort((a, b) => (a.created || a.at) - (b.created || b.at));
    if (!list.length) return '';
    return `
      <section class="info-section">
        <h2 class="section-title">${cat.icon} ${cat.label}</h2>
        ${list.map(i => `
          <article class="card info-card">
            <h3>${esc(i.title)}</h3>
            ${i.body ? `<p class="info-body">${linkify(i.body)}</p>` : ''}
            <div class="btn-row">
              <button class="btn small" data-copy-info="${i.id}">📋 複製</button>
              <button class="btn small ghost" data-edit-info="${i.id}">✏️ 編輯</button>
            </div>
            <span class="tl-by">${i.by ? `${esc(i.by)} · ` : ''}${agoText(i.at)}更新</span>
          </article>`).join('')}
      </section>`;
  }).join('')}</div>`;
}

function openInfoSheet(id) {
  const old = id ? store.items[id] : null;
  const i = old || { cat: 'flight', title: '', body: '' };
  const overlay = openSheet({
    title: old ? '編輯資訊' : '新增資訊',
    body: `
      <label class="field-label">分類</label>
      ${chipsHtml('cat', INFO_CATS, i.cat || 'other')}
      <label class="field-label" for="f-title">標題</label>
      <input id="f-title" class="input" value="${esc(i.title)}" placeholder="例如：去程航班、第一晚飯店">
      <label class="field-label" for="f-body">內容</label>
      <textarea id="f-body" class="textarea tall" placeholder="例如：&#10;長榮 BR132 11/20 08:50 桃園 T2 → 關西&#10;訂位代號 ABC123">${esc(i.body)}</textarea>
      ${old ? `<button class="btn danger block" data-delete>🗑️ 刪除</button>` : ''}`,
    footer: formFooter,
    onMount: overlay => bindChips(overlay),
  });
  bindFormButtons(overlay, () => {
    const title = $('#f-title', overlay).value.trim();
    if (!title) { toast('先填標題喔'); return false; }
    put({
      id: old ? old.id : uid(), type: 'info', cat: chipValue(overlay, 'cat') || 'other',
      title, body: $('#f-body', overlay).value.trim(), created: old ? old.created : Date.now(),
    }, old ? '修改' : '新增');
    toast('存好了 📒');
  });
  bindDelete(overlay, old, '刪掉了');
}

// ───────────────────────── 第一次使用：加入旅程 → 建立旅程 → 我是誰 ─────────────────────────
function renderJoin() {
  return `
    <section class="card welcome-card">
      <img class="welcome-avatar" src="art/avatar.png" alt="">
      <h2 class="welcome-title">歡迎來到旅遊阿焙焙 ✈️</h2>
      <p class="welcome-lead">跟旅伴一起排行程、對清單、記花費，<br>大家的手機和電腦都會自動同步。</p>
    </section>
    <section class="card">
      <h2 class="card-title">🔗 加入旅程</h2>
      <p class="hint">請找傳旅程給你的人要「邀請連結」，直接點開就會自動加入；或是把連結貼在下面。</p>
      <textarea id="join-link" class="textarea short" placeholder="貼上邀請連結"></textarea>
      <details class="advanced">
        <summary>我是建立旅程的人（貼雲端網址和連線碼）</summary>
        <label class="field-label" for="join-url">雲端網址</label>
        <input id="join-url" class="input" placeholder="https://script.google.com/macros/s/.../exec">
        <label class="field-label" for="join-key">連線碼</label>
        <input id="join-key" class="input" autocomplete="off">
      </details>
      ${ui.joinError ? `<p class="notice danger-text">${esc(ui.joinError)}</p>` : ''}
      <button class="btn primary block" style="margin-top:12px" data-action="join"${ui.joining ? ' disabled' : ''}>${ui.joining ? '焙子連線中…' : '加入'}</button>
    </section>`;
}

function renderCreateTrip() {
  return `
    <section class="card welcome-card">
      <img class="welcome-avatar" src="art/avatar.png" alt="">
      <h2 class="welcome-title">建立新的旅程 🧳</h2>
      <p class="welcome-lead">連上雲端了！先填幾個基本資料，之後都可以在「旅程設定」改。</p>
    </section>
    <section class="card">
      <label class="field-label" for="c-name">旅程名稱</label>
      <input id="c-name" class="input" placeholder="例如：京都大阪五日遊">
      <div class="two-col">
        <div><label class="field-label" for="c-start">出發日</label><input id="c-start" class="input" type="date"></div>
        <div><label class="field-label" for="c-end">回程日</label><input id="c-end" class="input" type="date"></div>
      </div>
      <label class="field-label" for="c-me">你的名字（旅伴看到的稱呼）</label>
      <input id="c-me" class="input" placeholder="例如：阿明">
      <label class="field-label" for="c-members">其他旅伴（用空白或逗號分開）</label>
      <input id="c-members" class="input" placeholder="例如：小美 爸爸 媽媽">
      <label class="field-label" for="c-currency">當地使用的錢（國內旅遊填台幣）</label>
      <input id="c-currency" class="input" list="currency-list" value="台幣">
      <datalist id="currency-list">${CURRENCY_SUGGESTIONS.map(c => `<option value="${c}">`).join('')}</datalist>
      <button class="btn primary block" style="margin-top:16px" data-action="create-trip">🐹 建立旅程</button>
    </section>`;
}

function renderWhoAmI() {
  return `
    <section class="card welcome-card">
      <img class="welcome-avatar" src="art/avatar.png" alt="">
      <h2 class="welcome-title">「${esc(trip().name || '我們的旅行')}」</h2>
      <p class="welcome-lead">你是哪一位旅伴呢？</p>
      <div class="who-grid">
        ${members().map(name => `<button class="who-btn" data-pick-me="${esc(name)}">${avatarHtml(name, 'big')}<span>${esc(name)}</span></button>`).join('')}
      </div>
    </section>
    <section class="card">
      <h2 class="card-title">🙋 名單上沒有我</h2>
      <div class="input-row">
        <input id="new-me" class="input" placeholder="輸入你的名字">
        <button class="btn primary" data-action="add-me">加入</button>
      </div>
    </section>`;
}

function splitNames(text) {
  return Array.from(new Set((text || '').split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean)));
}

// ───────────────────────── 旅程設定 ─────────────────────────
function openSettingsSheet() {
  const t = trip();
  let draftMembers = members().slice();
  const membersHtml = () => draftMembers.map(name => `
    <span class="member-chip">${avatarHtml(name, 'tiny')}${esc(name)}<button type="button" data-remove-member="${esc(name)}" aria-label="移除">✕</button></span>`).join('');
  const overlay = openSheet({
    title: '⚙️ 旅程設定',
    tall: true,
    body: `
      <section class="card">
        <h2 class="card-title">🧳 旅程</h2>
        <label class="field-label" for="s-name">旅程名稱</label>
        <input id="s-name" class="input" value="${esc(t.name)}">
        <div class="two-col">
          <div><label class="field-label" for="s-start">出發日</label><input id="s-start" class="input" type="date" value="${esc(t.start)}"></div>
          <div><label class="field-label" for="s-end">回程日</label><input id="s-end" class="input" type="date" value="${esc(t.end)}"></div>
        </div>
        <div class="two-col">
          <div>
            <label class="field-label" for="s-currency">當地的錢</label>
            <input id="s-currency" class="input" list="currency-list2" value="${esc(t.currency || '台幣')}">
            <datalist id="currency-list2">${CURRENCY_SUGGESTIONS.map(c => `<option value="${c}">`).join('')}</datalist>
          </div>
          <div>
            <label class="field-label" for="s-rate">匯率（1 元當地幣＝?台幣）</label>
            <input id="s-rate" class="input" inputmode="decimal" value="${esc(t.rate || '')}" placeholder="例如：0.21">
          </div>
        </div>
        <label class="field-label">旅伴</label>
        <div class="member-chips" id="s-members">${membersHtml()}</div>
        <div class="input-row" style="margin-top:8px">
          <input id="s-new-member" class="input" placeholder="新增旅伴的名字">
          <button type="button" class="btn" data-add-member>＋ 新增</button>
        </div>
      </section>
      <section class="card">
        <h2 class="card-title">🙋 這台裝置是誰在用</h2>
        <select id="s-me" class="select">${draftMembers.map(name => `<option${name === sync.me ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>
        <p class="hint" style="margin-top:6px">新增、修改的東西會顯示是誰改的，每台手機各自設定</p>
      </section>
      <section class="card">
        <h2 class="card-title">📤 邀請旅伴</h2>
        <p class="hint">把邀請連結用 LINE 傳給家人，點開就能一起看、一起改（拿到連結的人都能編輯，不要貼在公開的地方喔）</p>
        <button type="button" class="btn primary block" data-action="share-invite">📤 分享邀請連結</button>
      </section>
      <section class="card">
        <h2 class="card-title">📱 放到手機桌面</h2>
        <ul class="help-list">
          <li><b>iPhone：</b>用 Safari 打開 → 下方「分享」按鈕 → 往下滑「加入主畫面」。從 LINE 點開的話，先按右下角選「用 Safari 開啟」</li>
          <li><b>Android：</b>用 Chrome 打開 → 右上角 ⋮ →「加到主畫面」或「安裝應用程式」</li>
          <li><b>電腦：</b>用 Chrome 打開 → 網址列右邊的「安裝」圖示，就會變成一個獨立的視窗</li>
        </ul>
      </section>
      <section class="card">
        <h2 class="card-title">☁️ 雲端同步</h2>
        <p class="hint">每 20 秒自動同步一次，沒網路時改的東西會先存在這台，有網路時再自動上傳</p>
        <div class="btn-row">
          <button type="button" class="btn" data-action="sync-now">🔄 立刻同步</button>
          <button type="button" class="btn danger" data-action="disconnect" data-confirm-text="再按一次登出">登出這個旅程</button>
        </div>
        <p class="hint" style="margin-top:12px">字型：jf open 粉圓（SIL Open Font License 1.1）</p>
      </section>`,
    footer: formFooter,
  });
  const refreshMembers = () => {
    $('#s-members', overlay).innerHTML = membersHtml();
    const me = $('#s-me', overlay).value;
    $('#s-me', overlay).innerHTML = draftMembers.map(name => `<option${name === me ? ' selected' : ''}>${esc(name)}</option>`).join('');
  };
  overlay.addEventListener('click', e => {
    const rm = e.target.closest('[data-remove-member]');
    if (rm) {
      if (draftMembers.length <= 1) { toast('至少要留一位旅伴'); return; }
      draftMembers = draftMembers.filter(n => n !== rm.dataset.removeMember);
      refreshMembers();
    }
    if (e.target.closest('[data-add-member]')) {
      const input = $('#s-new-member', overlay);
      splitNames(input.value).forEach(name => { if (!draftMembers.includes(name)) draftMembers.push(name); });
      input.value = '';
      refreshMembers();
    }
  });
  bindFormButtons(overlay, () => {
    const start = $('#s-start', overlay).value;
    let end = $('#s-end', overlay).value;
    if (start && end && end < start) { toast('回程日比出發日還早喔'); return false; }
    if (start && !end) end = start;
    if (start && daysBetween(parseIso(start), parseIso(end)) >= MAX_TRIP_DAYS) { toast(`最多 ${MAX_TRIP_DAYS} 天喔`); return false; }
    const pendingName = splitNames($('#s-new-member', overlay).value);
    pendingName.forEach(name => { if (!draftMembers.includes(name)) draftMembers.push(name); });
    const me = $('#s-me', overlay).value;
    if (me && me !== sync.me) { sync.me = me; saveSync(); }
    put(Object.assign({}, t, {
      name: $('#s-name', overlay).value.trim() || '我們的旅行', start, end,
      currency: $('#s-currency', overlay).value.trim() || '台幣',
      rate: Number($('#s-rate', overlay).value.replace(/,/g, '')) || '',
      members: draftMembers,
    }));
    toast('設定存好了 ✨');
  });
}

async function shareInvite() {
  const link = inviteLink();
  const text = `一起用「旅遊阿焙焙」看「${trip() ? trip().name : '旅程'}」的行程吧！點開連結就能加入 🐹`;
  if (navigator.share) {
    try {
      await navigator.share({ title: '旅遊阿焙焙', text, url: link });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  await copyText(`${text}\n${link}`);
  toast('邀請連結複製好了，貼到 LINE 給家人吧', 2600);
}

// ───────────────────────── 由下往上滑出的表單 ─────────────────────────
function openSheet({ title, body, footer, tall = false, onMount }) {
  closeSheet();
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="sheet-overlay" data-sheet-overlay>
      <div class="sheet${tall ? ' tall' : ''}" role="dialog" aria-label="${esc(title)}">
        <div class="sheet-header"><h2>${esc(title)}</h2></div>
        <div class="sheet-body">${body}</div>
        ${footer ? `<div class="sheet-footer">${footer}</div>` : ''}
      </div>
    </div>`;
  document.body.style.overflow = 'hidden';
  const overlay = root.firstElementChild;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSheet(); });
  if (onMount) onMount(overlay);
  return overlay;
}

function closeSheet() {
  $('#sheet-root').innerHTML = '';
  document.body.style.overflow = '';
}

const formFooter = '<button class="btn ghost" data-sheet-cancel>取消</button><button class="btn primary" data-sheet-save>儲存</button>';

function bindFormButtons(overlay, onSave) {
  overlay.querySelector('[data-sheet-cancel]').addEventListener('click', closeSheet);
  overlay.querySelector('[data-sheet-save]').addEventListener('click', () => {
    if (onSave() !== false) closeSheet();
  });
}

// ───────────────────────── 事件 ─────────────────────────
function goTab(tab) {
  ui.tab = tab;
  if (TAB_TYPES[tab]) { sync.seen[TAB_TYPES[tab]] = Date.now(); saveSync(); }
  render();
  window.scrollTo({ top: 0 });
}

const actions = {
  'open-settings': () => openSettingsSheet(),
  'share-invite': () => shareInvite(),
  'quick-add': () => quickAdd(),
  'sync-now': () => { syncNow(); toast('同步中…'); },
  'disconnect': btn => confirmTwice(btn, 'disconnect', () => {
    sync = { url: '', key: '', me: '', seen: {} };
    store = { items: {}, pending: {}, loaded: false };
    saveSync();
    saveStore();
    closeSheet();
    setSyncStatus('', '');
    render();
  }),
  'join': () => {
    const conn = parseInvite($('#join-link').value)
      || ($('#join-url').value.trim() && $('#join-key').value.trim() ? { url: $('#join-url').value.trim(), key: $('#join-key').value.trim() } : null);
    if (!conn) { ui.joinError = '這不像邀請連結～請確認有完整貼上（裡面會有 #j=）'; render(); return; }
    connect(conn);
  },
  'create-trip': () => {
    const me = $('#c-me').value.trim();
    if (!me) { toast('先填你的名字喔'); $('#c-me').focus(); return; }
    const start = $('#c-start').value;
    let end = $('#c-end').value || start;
    if (start && end < start) { toast('回程日比出發日還早喔'); return; }
    sync.me = me;
    saveSync();
    put({
      id: 'trip', type: 'trip', name: $('#c-name').value.trim() || '我們的旅行', start, end,
      members: [me, ...splitNames($('#c-members').value).filter(n => n !== me)],
      currency: $('#c-currency').value.trim() || '台幣', rate: '',
    }, '建立');
    toast('旅程建立好了！記得分享邀請連結給家人 🐹', 2600);
  },
  'add-me': () => {
    const name = $('#new-me').value.trim();
    if (!name) { $('#new-me').focus(); return; }
    sync.me = name;
    saveSync();
    if (!members().includes(name)) put(Object.assign({}, trip(), { members: [...members(), name] }), '加入');
    else render();
    toast(`歡迎 ${name}！🐹`);
  },
};

document.addEventListener('click', e => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn && actionBtn.tagName !== 'INPUT' && actions[actionBtn.dataset.action]) {
    actions[actionBtn.dataset.action](actionBtn);
    return;
  }
  // 卡片裡的地圖、連結直接打開，不要觸發編輯
  if (e.target.closest('a')) return;
  const el = e.target.closest('[data-tab],[data-tab-go],[data-go-day],[data-day],[data-list],[data-go-list],[data-edit-plan],[data-edit-check],[data-edit-expense],[data-edit-info],[data-copy-info],[data-pick-me],[data-fab]');
  if (!el) return;
  const d = el.dataset;
  if (d.tab) goTab(d.tab);
  else if (d.tabGo) goTab(d.tabGo);
  else if (d.goDay !== undefined) { ui.day = d.goDay; goTab('plan'); }
  else if (d.day !== undefined) { ui.day = d.day; render(); }
  else if (d.list) { ui.list = d.list; render(); }
  else if (d.goList) { ui.list = d.goList; goTab('list'); }
  else if (d.editPlan) openPlanSheet(d.editPlan);
  else if (d.editCheck) openCheckSheet(d.editCheck);
  else if (d.editExpense) openExpenseSheet(d.editExpense);
  else if (d.editInfo) openInfoSheet(d.editInfo);
  else if (d.copyInfo) {
    const info = store.items[d.copyInfo];
    copyText(`${info.title}\n${info.body || ''}`.trim()).then(() => toast('複製好了 📋'));
  } else if (d.pickMe) { sync.me = d.pickMe; saveSync(); render(); toast(`歡迎 ${d.pickMe}！🐹`); }
  else if (d.fab) ({ plan: () => openPlanSheet(), money: () => openExpenseSheet(), info: () => openInfoSheet() })[d.fab]();
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.toggleCheck) {
    const item = store.items[t.dataset.toggleCheck];
    if (!item) return;
    put(Object.assign({}, item, { done: t.checked, doneBy: t.checked ? sync.me : '' }), t.checked ? '完成' : '取消完成');
    if (t.checked) cheer();
  } else if (t.dataset.action === 'mine-only') {
    ui.mineOnly = t.checked;
    render();
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.target.id === 'quick-add') { e.preventDefault(); quickAdd(); }
  if (e.target.id === 'new-me') { e.preventDefault(); actions['add-me'](); }
});

// ───────────────────────── 畫面 ─────────────────────────
function renderLoading() {
  return `<div class="empty-art loading">${SLEEP_IMG}<p>焙子正在打包行李…</p></div>`;
}

function render() {
  const view = $('#view');
  // 整頁重畫時保留輸入到一半的文字（例如雲端剛好同步進來）
  const drafts = {};
  view.querySelectorAll('input[id], textarea[id]').forEach(el => { drafts[el.id] = el.value; });
  const focusedId = document.activeElement && view.contains(document.activeElement) ? document.activeElement.id : '';
  let screen;
  if (!sync.key) screen = renderJoin();
  else if (!store.loaded) screen = renderLoading();
  else if (!trip()) screen = renderCreateTrip();
  else if (!sync.me || !members().includes(sync.me)) screen = renderWhoAmI();
  const setup = !!screen;
  const renderers = { home: renderHome, plan: renderPlan, list: renderList, money: renderMoney, info: renderInfo };
  view.innerHTML = screen || renderers[ui.tab]();
  view.className = setup ? 'setup' : `tab-${ui.tab}`;
  Object.entries(drafts).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el && view.contains(el)) el.value = value;
  });
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  document.querySelector('.tabbar').hidden = setup;
  document.body.classList.toggle('has-rail', !setup);
  document.querySelectorAll('[data-action="open-settings"]').forEach(btn => { btn.hidden = setup; });
  document.querySelectorAll('.tabbar [data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === ui.tab);
    const type = TAB_TYPES[btn.dataset.tab];
    btn.classList.toggle('unseen', !setup && !!type && btn.dataset.tab !== ui.tab && hasUnseen(type));
  });
  if (!setup && TAB_TYPES[ui.tab]) { sync.seen[TAB_TYPES[ui.tab]] = Date.now(); saveSync(); }
  const fabTab = { plan: '＋ 新增行程', money: '＋ 記一筆', info: '＋ 新增資訊' }[ui.tab];
  $('#fab-root').innerHTML = !setup && fabTab ? `<button class="fab" data-fab="${ui.tab}">${fabTab}</button>` : '';
  const p = setup ? {} : tripPhase();
  $('#topbar-sub').textContent = setup ? '一起出去玩吧 ✈️'
    : ui.tab === 'home' && p.phase === 'during' ? `旅程第 ${p.dayNo} 天，玩得開心 🎒`
    : ui.tab === 'home' && p.phase === 'before' ? `再 ${p.left} 天就出發 ✈️`
    : TAB_SUBTITLES[ui.tab];
}

// 打開時處理邀請連結（#j=...），處理完把它從網址列拿掉，避免被截圖或轉傳出去
(() => {
  const conn = parseInvite(location.hash);
  if (!conn) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (conn.url === sync.url && conn.key === sync.key) return;
  connect(conn);
})();

render();

if (sync.key) {
  setSyncStatus(Object.keys(store.pending).length ? 'offline' : 'busy', Object.keys(store.pending).length ? '⚠️ 稍後上傳' : '同步中…');
  syncNow();
}
setInterval(() => { if (document.visibilityState === 'visible') pullFromCloud(); }, SYNC_POLL_MS);
// 每分鐘重畫一次，「下一站」「3 分鐘前」才會跟著時間走（表單開著或正在打字時先不動）
setInterval(() => {
  if (document.visibilityState !== 'visible' || $('#sheet-root').children.length) return;
  if (document.activeElement && document.activeElement.matches('input, textarea, select')) return;
  render();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pullFromCloud(3000);
});
window.addEventListener('online', () => pullFromCloud());
window.addEventListener('pagehide', () => { syncRun.unloading = true; });
window.addEventListener('pageshow', () => { syncRun.unloading = false; pullFromCloud(3000); });
// 同一台電腦開了兩個視窗（例如 exe 和瀏覽器分頁）：另一個視窗存檔時把它的資料併進來，
// 自己還沒上傳、而且比較新的修改留著，才不會互相蓋掉
window.addEventListener('storage', e => {
  if (e.key !== STORAGE_KEY + ':' + SYNC_NS || !e.newValue) return;
  let other;
  try { other = JSON.parse(e.newValue); } catch (err) { return; }
  if (!other || !other.items || !other.pending) return;
  const pending = Object.assign({}, other.pending);
  Object.values(store.pending).forEach(mine => {
    const theirs = other.items[mine.id];
    if (!theirs || theirs.at < mine.at) pending[mine.id] = mine;
  });
  // 兩邊的資料逐筆比，留 at 比較新的那份（不整份換掉，自己有、另一個視窗還沒抓到的也會留著）
  const items = Object.assign({}, store.items);
  Object.values(other.items).forEach(item => {
    if (!items[item.id] || items[item.id].at < item.at) items[item.id] = item;
  });
  store = { items: Object.assign(items, pending), pending, loaded: store.loaded || other.loaded };
  render();
});

// 出國網路不穩：用 service worker 把畫面檔案存起來，沒網路也打得開（只在正式網址 https 啟用）
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}
