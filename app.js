'use strict';

/* ============================================================
   trioTE — 出差報銷懶人系統 (純前端)
   資料儲存：localStorage（結構資料）+ IndexedDB（發票圖片）
   ============================================================ */

// ---------- 常數 ----------
const BASE_CATEGORIES = ['交通', '住宿', '膳食', '其他', '交際費'];
const ENT_CATEGORY = '交際費'; // 交際費：匯出到範本下方「交際費」區塊
const COMPANIES = [
  '三集瑞科技集團', '塞席爾商三集瑞', '三積瑞科技蘇州', '東莞德泰利電子',
  'TRIO INT.', 'APEC', 'TRIO Seychelles', 'Wonstar',
];
const DEFAULT_RATES = [
  { code: 'NTD', rate: 1, locked: true },
  { code: 'RMB', rate: 4.705, locked: false },
  { code: 'USD', rate: 30, locked: false },
  { code: 'THB', rate: 1.0107, locked: false },
  { code: 'HKD', rate: 1, locked: false },
];
const FEE_COLS = ['交通費', '膳食費', '住宿費', '其他費用'];
const LS_KEY = 'trioTE.state.v1';

// ---------- 狀態 ----------
let state = loadState();
let catFilter = '全部';
let cropCtx = null; // 目前裁切的圖片資料

function defaultState() {
  return {
    rates: JSON.parse(JSON.stringify(DEFAULT_RATES)),
    dailyLimit: 600,
    report: {
      company: '塞席爾商三集瑞',
      tripType: '國外',
      fillDate: todayStr(),
      person: '',
      dept: '',
      region: '',
      start: '',
      end: '',
      focus: '',
      issue: '',
      note: '',
    },
    customCategories: [],
    expenses: [],
    pending: [],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaultState();
      // 舊版 companies(array) 遷移為 company(string)
      if (s.report && Array.isArray(s.report.companies)) {
        s.report.company = s.report.companies[0] || d.report.company;
        delete s.report.companies;
      }
      return Object.assign(d, s);
    }
  } catch (e) { console.warn('loadState', e); }
  return defaultState();
}

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (e) { console.warn('saveState', e); toast('儲存失敗：' + e.message); }
}

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ---------- IndexedDB (圖片) ----------
const DB_NAME = 'trioTE_img';
const DB_VER = 1;
let db = null;
function idb() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('img')) d.createObjectStore('img');
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}
async function idbPut(id, blob) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction('img', 'readwrite');
    tx.objectStore('img').put(blob, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(id) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction('img', 'readonly');
    const rq = tx.objectStore('img').get(id);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbDel(id) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction('img', 'readwrite');
    tx.objectStore('img').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbClear() {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction('img', 'readwrite');
    tx.objectStore('img').clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---------- 工具 ----------
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function round6(v) { return Math.round((num(v) + Number.EPSILON) * 1000000) / 1000000; }
function round2(v) { return Math.round((num(v) + Number.EPSILON) * 100) / 100; }
function fmt(n, d) {
  if (d == null) d = 2;
  return Number(n || 0).toLocaleString('zh-Hant', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function getRate(code) {
  const r = state.rates.find(x => x.code === code);
  return r ? num(r.rate) : 1;
}
function localTotalOf(exp) { return round6(num(exp.amount) * num(exp.rate || getRate(exp.currency))); }
function catToFeeCol(cat) {
  if (cat === ENT_CATEGORY) return '其他費用';
  if (BASE_CATEGORIES.includes(cat)) return cat + '費';
  return '其他費用';
}
function catToIndex(cat) { // 對應 交通/膳食/住宿/其他 索引
  if (cat === '交通') return 0;
  if (cat === '膳食') return 1;
  if (cat === '住宿') return 2;
  return 3;
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
function dataURLToBlob(dataURL) {
  const [head, body] = dataURL.split(',');
  const mime = (head.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---------- 渲染：整體 ----------
function renderAll() {
  renderRates();
  renderReport();
  renderSummary();
  renderCatFilter();
  renderExpenses();
  renderPending();
  renderUploadCats();
}

// ---------- 匯率 ----------
function renderRates() {
  const body = $('#rate-body');
  body.innerHTML = '';
  state.rates.forEach((r, i) => {
    const tr = document.createElement('tr');
    const codeInput = r.locked
      ? `<input value="${esc(r.code)}" readonly title="NTD 固定">`
      : `<input value="${esc(r.code)}" data-i="${i}" data-k="code" placeholder="幣別代碼">`;
    const rateInput = r.locked
      ? `<input value="${fmt(r.rate)}" readonly title="NTD 固定 1:1">`
      : `<input value="${r.rate}" data-i="${i}" data-k="rate" type="number" step="0.0001" min="0">`;
    const del = r.locked ? '' : `<button class="del" data-i="${i}" title="刪除">✕</button>`;
    tr.innerHTML = `<td>${codeInput}</td><td>${rateInput}</td><td>${del}</td>`;
    body.appendChild(tr);
  });
  $('#daily-limit').value = state.dailyLimit;
}

// ---------- 出差報告 ----------
function renderReport() {
  const r = state.report;
  const list = $('#company-list');
  list.innerHTML = '';
  COMPANIES.forEach(c => {
    const on = r.company === c;
    const lb = document.createElement('label');
    lb.className = on ? 'on' : '';
    lb.innerHTML = `<input type="radio" name="company" value="${esc(c)}" ${on ? 'checked' : ''}> ${esc(c)}`;
    lb.querySelector('input').addEventListener('change', updateCompany);
    list.appendChild(lb);
  });
  $('#f-fill-date').value = r.fillDate || '';
  $('#f-person').value = r.person || '';
  $('#f-dept').value = r.dept || '';
  $('#f-region').value = r.region || '';
  $('#f-start').value = r.start || '';
  $('#f-end').value = r.end || '';
  $('#f-focus').value = r.focus || '';
  $('#f-issue').value = r.issue || '';
  $('#f-note').value = r.note || '';
  $$('input[name="trip-type"]').forEach(x => x.checked = (x.value === r.tripType));
  computeDays();
}
function updateCompany() {
  const sel = $('#company-list input:checked');
  state.report.company = sel ? sel.value : '';
  $$('#company-list label').forEach(lb => {
    const cb = lb.querySelector('input');
    lb.classList.toggle('on', cb.checked);
  });
  saveState();
}
function computeDays() {
  const s = $('#f-start').value, e = $('#f-end').value;
  if (s && e) {
    const d1 = new Date(s), d2 = new Date(e);
    const days = Math.round((d2 - d1) / 86400000) + 1;
    $('#f-days').value = days > 0 ? days : '';
  } else {
    $('#f-days').value = '';
  }
}

// ---------- 摘要 ----------
function renderSummary() {
  const bar = $('#summary-bar');
  const totalTWD = state.expenses.reduce((s, e) => s + localTotalOf(e), 0);
  const chips = [
    { lbl: '憑證張數', val: state.expenses.length + ' 張' },
    { lbl: '本幣合計', val: 'NTD ' + fmt(totalTWD) },
  ];
  // 分類小計（本幣台幣）
  BASE_CATEGORIES.forEach(cat => {
    const t = state.expenses.filter(e => e.category === cat).reduce((s, e) => s + localTotalOf(e), 0);
    if (t > 0) chips.push({ lbl: cat.endsWith('費') ? cat : cat + '費', val: fmt(t) });
  });
  state.customCategories.forEach(cat => {
    const t = state.expenses.filter(e => e.category === cat).reduce((s, e) => s + localTotalOf(e), 0);
    if (t > 0) chips.push({ lbl: cat, val: fmt(t) });
  });
  // 每日膳食上限檢查
  const dayMeals = {};
  state.expenses.forEach(e => {
    if (e.category !== '膳食' || !e.date) return;
    const t = localTotalOf(e);
    dayMeals[e.date] = (dayMeals[e.date] || 0) + t;
  });
  const over = Object.entries(dayMeals).filter(([, t]) => t > num(state.dailyLimit));
  if (over.length) {
    chips.push({
      lbl: '膳食超限',
      val: over.map(([d, t]) => `${d.slice(5)}(${fmt(t)})`).join('、'),
      warn: true,
    });
  }
  bar.innerHTML = chips.map(c =>
    `<div class="summary-chip"><span class="lbl">${c.lbl}</span><b style="${c.warn ? 'color:var(--danger)' : ''}">${esc(c.val)}</b></div>`
  ).join('');
}

// ---------- 類別篩選 ----------
function renderCatFilter() {
  const box = $('#cat-filter');
  const cats = ['全部', ...BASE_CATEGORIES, ...state.customCategories];
  box.innerHTML = cats.map(c =>
    `<button class="${c === catFilter ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`
  ).join('');
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    catFilter = b.dataset.cat;
    renderCatFilter();
    renderExpenses();
  }));
}

// ---------- 核銷明細 ----------
function allCats() { return [...BASE_CATEGORIES, ...state.customCategories]; }

function renderExpenses() {
  const body = $('#expense-body');
  const list = state.expenses.filter(e => catFilter === '全部' || e.category === catFilter);
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--muted);padding:24px">尚無資料，可到「上傳發票」分頁上傳，或點「手動新增一筆」</td></tr>';
    return;
  }
  list.forEach(e => {
    body.appendChild(renderExpenseRow(e));
  });
}

function renderExpenseRow(e) {
  const tr = document.createElement('tr');
  const over = isOverLimit(e);
  if (over) tr.classList.add('over-limit');
  const idx = state.expenses.indexOf(e);

  const thumb = `<div class="thumb" data-img="${esc(e.imgId || '')}" style="${e.imgId ? '' : 'background-image:none;display:flex;align-items:center;justify-content:center;color:#cbd5e1'}">${e.imgId ? '' : '無圖'}</div>`;

  const cats = allCats();
  const catOpts = cats.map(c => `<option ${c === e.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const curOpts = state.rates.map(r => `<option ${r.code === e.currency ? 'selected' : ''}>${esc(r.code)}</option>`).join('');

  tr.innerHTML = `
    <td>${thumb}</td>
    <td><input type="date" value="${esc(e.date || '')}" data-k="date" title="開始日期"></td>
    <td><input type="date" value="${esc(e.dateEnd || '')}" data-k="dateEnd" title="結束日期（住宿、機票等跨日才需要填，空白=同開始日期）"></td>
    <td><select data-k="currency" title="幣別">${curOpts}</select></td>
    <td><select data-k="category" title="類別">${catOpts}</select></td>
    <td><input type="number" step="0.01" class="num" value="${e.amount}" data-k="amount" title="金額(原幣)"></td>
    <td><input type="number" step="0.0001" class="num" value="${e.rate}" data-k="rate" title="適用匯率"></td>
    <td class="local-total"></td>
    <td><select data-k="trans" title="消費方式"><option ${e.trans === '現金' ? 'selected' : ''}>現金</option><option ${e.trans === '信用卡' ? 'selected' : ''}>信用卡</option></select></td>
    <td><input value="${esc(e.desc || '')}" data-k="desc" title="說明" placeholder="說明"></td>
    <td><input value="${esc(e.receiptNo || '')}" data-k="receiptNo" title="憑證編號" style="width:90px"></td>
    <td><button class="del" data-del="${idx}" title="刪除">✕</button></td>
  `;

  updateFeeCells(tr, e);

  // 圖片縮圖載入
  const thumbEl = tr.querySelector('.thumb');
  if (e.imgId) {
    idbGet(e.imgId).then(b => {
      if (b) blobToDataURL(b).then(u => thumbEl.style.backgroundImage = `url(${u})`).catch(() => {});
    });
  }
  thumbEl.addEventListener('click', () => {
    if (e.imgId) openImagePreview(e.imgId);
  });

  // 編輯事件
  tr.querySelectorAll('[data-k]').forEach(inp => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      let v = inp.value;
      if (k === 'amount' || k === 'rate') v = num(v);
      e[k] = v;
      if (k === 'currency') e.rate = getRate(v); // 換幣別自動帶匯率
      updateFeeCells(tr, e);
      saveState();
      renderSummary();
    });
  });

  // 刪除
  tr.querySelector('[data-del]').addEventListener('click', () => {
    deleteExpense(idx);
  });

  return tr;
}

function updateFeeCells(tr, e) {
  const local = localTotalOf(e);
  tr.querySelector('.local-total').textContent = fmt(local);
  tr.classList.toggle('over-limit', isOverLimit(e));
}

function isOverLimit(e) {
  if (e.category !== '膳食' || !e.date) return false;
  const dayTotal = state.expenses
    .filter(x => x.category === '膳食' && x.date === e.date)
    .reduce((s, x) => s + localTotalOf(x), 0);
  return dayTotal > num(state.dailyLimit);
}

function deleteExpense(idx) {
  const e = state.expenses[idx];
  if (!e) return;
  if (e.imgId) idbDel(e.imgId).catch(() => {});
  state.expenses.splice(idx, 1);
  saveState();
  renderAll();
  toast('已刪除');
}

async function addExpense(data) {
  const imgId = data.imgId || null;
  const e = {
    id: uid(),
    date: data.date || state.report.start || todayStr(),
    currency: data.currency || 'NTD',
    amount: num(data.amount),
    rate: num(data.rate != null ? data.rate : getRate(data.currency || 'NTD')),
    category: data.category || '其他',
    trans: data.trans || '現金',
    desc: data.desc || '',
    receiptNo: data.receiptNo || '',
    imgId,
  };
  state.expenses.push(e);
  saveState();
  renderAll();
  return e;
}

// ============================================================
// 上傳 + 裁切
// ============================================================
const uploadStack = $('#upload-stack');
let uploadEntries = []; // {imgId, dataURL, width, height}

async function handleFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const dataURL = await blobToDataURL(file);
    const imgId = uid();
    const blob = dataURLToBlob(dataURL);
    await idbPut(imgId, blob).catch(() => {});
    uploadEntries.push({ imgId, dataURL });
    renderUploadStack();
  }
  toast('圖片已加入（僅存本地端）');
}

function renderUploadStack() {
  uploadStack.innerHTML = '';
  uploadEntries.forEach((u, i) => {
    const card = document.createElement('div');
    card.className = 'upload-card';
    card.innerHTML = `
      <div class="thumb" style="background-image:url(${u.dataURL})" title="點擊開啟裁切"></div>
      <div class="meta">
        <button class="btn" data-crop="${i}">裁切 / 辨識</button>
        <button class="btn danger" data-remove="${i}">移除</button>
      </div>`;
    card.querySelector('.thumb').addEventListener('click', () => openCrop(i));
    card.querySelector('[data-crop]').addEventListener('click', () => openCrop(i));
    card.querySelector('[data-remove]').addEventListener('click', () => {
      idbDel(u.imgId).catch(() => {});
      uploadEntries.splice(i, 1);
      renderUploadStack();
    });
    uploadStack.appendChild(card);
  });
}

// ---------- 待確認（已裁切）發票清單，依日期排列 ----------
function renderPending() {
  const box = $('#pending-list');
  if (!box) return;
  const sorted = [...state.pending].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  box.innerHTML = '';
  if (!sorted.length) {
    box.innerHTML = '<p class="hint small" style="margin:8px 0 0">尚未裁切發票，上傳圖片後點圖裁切。</p>';
    return;
  }
  sorted.forEach((p, si) => {
    const idx = state.pending.indexOf(p);
    const cats = allCats();
    const catOpts = cats.map(c => `<option ${c === p.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const curOpts = state.rates.map(r => `<option ${r.code === p.currency ? 'selected' : ''}>${esc(r.code)}</option>`).join('');
    const item = document.createElement('div');
    item.className = 'pending-item';
    item.innerHTML = `
      <div class="thumb" data-img="${esc(p.imgId || '')}"></div>
      <div><span class="lbl">日期</span><br><input type="date" value="${esc(p.date || '')}" data-k="date"></div>
      <div><span class="lbl">幣別</span><br><select data-k="currency">${curOpts}</select></div>
      <div><span class="lbl">類別</span><br><select data-k="category">${catOpts}</select></div>
      <div><span class="lbl">金額(原幣)</span><br><input type="number" step="0.01" class="num" value="${p.amount}" data-k="amount"></div>
      <div><span class="lbl">說明</span><br><input value="${esc(p.desc || '')}" data-k="desc" placeholder="說明"></div>
      <button class="del" data-del="${idx}" title="刪除">✕</button>
    `;
    // 縮圖
    const thumbEl = item.querySelector('.thumb');
    if (p.imgId) {
      idbGet(p.imgId).then(b => { if (b) blobToDataURL(b).then(u => thumbEl.style.backgroundImage = `url(${u})`).catch(() => {}); });
    }
    thumbEl.addEventListener('click', () => { if (p.imgId) openImagePreview(p.imgId); });
    // 編輯
    item.querySelectorAll('[data-k]').forEach(inp => {
      inp.addEventListener('change', () => {
        const k = inp.dataset.k;
        let v = inp.value;
        if (k === 'amount') v = num(v);
        if (p) {
          p[k] = v;
          if (k === 'currency') p.rate = getRate(v);
        }
        saveState();
      });
    });
    item.querySelector('[data-del]').addEventListener('click', () => {
      if (p.imgId) idbDel(p.imgId).catch(() => {});
      state.pending.splice(idx, 1);
      saveState();
      renderPending();
    });
    box.appendChild(item);
  });
}

// 顯示上傳分頁已有的類別（新增類別左側）
function renderUploadCats() {
  const box = $('#upload-cats');
  if (!box) return;
  const cats = allCats();
  box.innerHTML = cats.map(c => {
    const isCustom = !BASE_CATEGORIES.includes(c);
    return `<span class="tag ${isCustom ? 'custom' : ''}">${esc(c)}</span>`;
  }).join('');
}

// 將「待確認」全部加入核銷明細
function commitPending() {
  if (!state.pending.length) { toast('尚未有已裁切的發票'); return; }
  const n = state.pending.length;
  state.expenses.push(...state.pending);
  state.pending = [];
  saveState();
  renderAll();
  switchTab('tab-expense');
  toast('已加入 ' + n + ' 筆發票到核銷明細');
}

// ---------- 裁切 modal ----------
const cropModal = $('#crop-modal');
const cropCanvas = $('#crop-canvas');
let cropImage = null;        // HTMLImageElement
let cropImgId = null;
let cropScale = 1;           // canvas 顯示縮放
let cropRect = [];           // 已畫的框 {x,y,w,h} 於顯示座標
let cropDrawing = null;      // 正在畫的框
let cropPending = [];        // {dataURL(裁切後), amount, currency, date, category}

function openCrop(uploadIdx) {
  const u = uploadEntries[uploadIdx];
  if (!u) return;
  const img = new Image();
  img.onload = () => {
    cropImage = img;
    cropImgId = u.imgId;
    cropRect = [];
    cropPending = [];
    fitCanvas();
    drawCropCanvas();
    cropModal.classList.add('open');
    setCropGuide('正在自動偵測發票位置…');
    // 自動偵測（找不到就整張當一框）
    autoDetectRects();
    // 自動辨識金額/幣別/日期
    autoRunOCR();
  };
  img.src = u.dataURL;
}

function setCropGuide(msg) {
  const g = $('#crop-guide');
  if (g) g.textContent = msg;
}

function fitCanvas() {
  const maxW = 980, maxH = 560;
  const scale = Math.min(maxW / cropImage.naturalWidth, maxH / cropImage.naturalHeight, 1);
  cropScale = scale;
  cropCanvas.width = Math.round(cropImage.naturalWidth * scale);
  cropCanvas.height = Math.round(cropImage.naturalHeight * scale);
}

function drawCropCanvas() {
  const ctx = cropCanvas.getContext('2d');
  ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  ctx.drawImage(cropImage, 0, 0, cropCanvas.width, cropCanvas.height);
  // 已確認的框
  cropRect.forEach((r, i) => {
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = 'rgba(34,197,94,.8)';
    ctx.fillText('#' + (i + 1), r.x + 3, r.y + 14);
  });
  // 正在畫的框
  if (cropDrawing) {
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.strokeRect(cropDrawing.x, cropDrawing.y, cropDrawing.w, cropDrawing.h);
  }
}

function getPos(e) {
  const rect = cropCanvas.getBoundingClientRect();
  const sx = cropCanvas.width / rect.width;
  const sy = cropCanvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

cropCanvas.addEventListener('mousedown', (e) => {
  const p = getPos(e);
  cropDrawing = { x: p.x, y: p.y, w: 0, h: 0 };
});
cropCanvas.addEventListener('mousemove', (e) => {
  if (!cropDrawing) return;
  const p = getPos(e);
  cropDrawing.w = p.x - cropDrawing.x;
  cropDrawing.h = p.y - cropDrawing.y;
  drawCropCanvas();
});
cropCanvas.addEventListener('mouseup', () => {
  if (!cropDrawing) return;
  const r = cropDrawing;
  cropDrawing = null;
  if (Math.abs(r.w) > 8 && Math.abs(r.h) > 8) {
    const norm = {
      x: r.w < 0 ? r.x + r.w : r.x,
      y: r.h < 0 ? r.y + r.h : r.y,
      w: Math.abs(r.w),
      h: Math.abs(r.h),
    };
    cropRect.push(norm);
  }
  drawCropCanvas();
  renderCropPreviews();
});

// 自動偵測多張發票（基於亮度分割的簡單啟發式）
function autoDetectRects() {
  if (!cropImage) return;
  const ctx = cropCanvas.getContext('2d');
  const W = cropCanvas.width, H = cropCanvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const step = 4; // 每 4px 取樣加速
  const gw = Math.ceil(W / step), gh = Math.ceil(H / step);
  const grid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = Math.min(gx * step, W - 1), py = Math.min(gy * step, H - 1);
      const i = (py * W + px) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      grid[gy * gw + gx] = lum > 140 ? 1 : 0; // 亮區(紙張)標記
    }
  }
  const visited = new Uint8Array(gw * gh);
  const comps = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const idx = gy * gw + gx;
      if (!grid[idx] || visited[idx]) continue;
      // flood fill
      const q = [[gx, gy]]; visited[idx] = 1;
      let minx = gx, maxx = gx, miny = gy, maxy = gy, cnt = 0;
      while (q.length) {
        const [cx, cy] = q.pop(); cnt++;
        if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        for (const [dx, dy] of dirs) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (grid[ni] && !visited[ni]) { visited[ni] = 1; q.push([nx, ny]); }
        }
      }
      const w = (maxx - minx + 1) * step, h = (maxy - miny + 1) * step;
      const area = w * h;
      // 過濾：面積夠大（至少 8% 畫面）且不是全畫面
      if (area > (W * H * 0.06) && area < (W * H * 0.98)) {
        comps.push({ x: minx * step, y: miny * step, w, h, area });
      }
    }
  }
  comps.sort((a, b) => b.area - a.area);
  const picked = comps.slice(0, 12);
  if (picked.length) {
    cropRect = picked.map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
    setCropGuide(`自動偵測到 ${picked.length} 個發票區塊。綠色框可拖曳調整，或直接重新畫框。`);
  } else {
    // 找不到就整張當一框
    cropRect = [{ x: 0, y: 0, w: W, h: H }];
    setCropGuide('未偵測到多張發票，已預設整張為一框。可在圖上拖曳畫框調整。');
  }
  drawCropCanvas();
  renderCropPreviews();
}

function cropRectToNatural(r) {
  const s = 1 / cropScale;
  return { x: Math.round(r.x * s), y: Math.round(r.y * s), w: Math.round(r.w * s), h: Math.round(r.h * s) };
}

function renderCropPreviews() {
  const box = $('#crop-previews');
  // 重建 pending（保留已辨識的值，重新裁切圖片）
  const old = cropPending;
  cropPending = cropRect.map((r, i) => {
    const nat = cropRectToNatural(r);
    const c = document.createElement('canvas');
    c.width = nat.w; c.height = nat.h;
    c.getContext('2d').drawImage(cropImage, nat.x, nat.y, nat.w, nat.h, 0, 0, nat.w, nat.h);
    return {
      dataURL: c.toDataURL('image/jpeg', 0.9),
      amount: old[i] ? old[i].amount : '',
      currency: old[i] ? old[i].currency : 'NTD',
      date: old[i] ? old[i].date : (state.report.start || todayStr()),
      category: old[i] ? old[i].category : '其他',
    };
  });
  box.innerHTML = '';
  cropPending.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'cp';
    const catOpts = allCats().map(c => `<option ${c === p.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const curOpts = state.rates.map(r => `<option ${r.code === p.currency ? 'selected' : ''}>${esc(r.code)}</option>`).join('');
    div.innerHTML = `
      <img src="${p.dataURL}" alt="">
      <button class="rm" data-rm="${i}" title="移除此框">✕</button>
      <div class="cp-fields">
        <input type="number" step="0.01" placeholder="金額" value="${esc(p.amount)}" data-f="amount">
        <select data-f="currency">${curOpts}</select>
        <input type="date" value="${esc(p.date)}" data-f="date">
        <select data-f="category">${catOpts}</select>
      </div>`;
    div.querySelector('[data-rm]').addEventListener('click', () => {
      cropRect.splice(i, 1);
      drawCropCanvas();
      renderCropPreviews();
    });
    div.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        const k = inp.dataset.f;
        const v = (k === 'amount') ? num(inp.value) : inp.value;
        if (cropPending[i]) cropPending[i][k] = v;
        if (k === 'currency' && cropPending[i]) {
          cropPending[i].currency = v;
        }
      });
    });
    box.appendChild(div);
  });
}

// ---------- OCR ----------
let tessWorker = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => res();
    s.onerror = () => rej(new Error('Tesseract CDN 載入失敗'));
    document.head.appendChild(s);
  });
}
async function runOCR() {
  if (!cropPending.length) { toast('請先框選發票'); return; }
  const btn = $('#btn-ocr');
  const status = $('#crop-status');
  if (btn) { btn.disabled = true; btn.textContent = '辨識中…'; }
  try {
    if (status) status.textContent = '下載辨識引擎中（首次較久，請稍候）…';
    await loadTesseract();
    for (let i = 0; i < cropPending.length; i++) {
      const p = cropPending[i];
      if (status) status.textContent = `辨識中… (${i + 1}/${cropPending.length})`;
      const result = await Tesseract.recognize(p.dataURL, 'chi_tra+chi_sim+eng', {});
      const text = result.data.text;
      const parsed = parseReceipt(text);
      if (parsed.amount) p.amount = parsed.amount;
      if (parsed.currency) p.currency = parsed.currency;
      if (parsed.date) p.date = parsed.date;
      if (parsed.category) p.category = parsed.category;
    }
    renderCropPreviews();
    setCropGuide('辨識完成。請確認下方各張的金額、幣別、日期是否正確（可直接修改），再按「完成」。');
    if (status) status.textContent = '辨識完成';
  } catch (err) {
    setCropGuide('自動辨識失敗（可能網路無法載入辨識引擎），請手動填寫金額/幣別/日期。');
    if (status) status.textContent = '辨識失敗';
    console.warn(err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新辨識金額/幣別/日期'; }
  }
}

// 開啟裁切後自動執行辨識
let autoOCRStarted = false;
async function autoRunOCR() {
  if (autoOCRStarted) return;
  autoOCRStarted = true;
  try {
    await runOCR();
  } finally {
    autoOCRStarted = false;
  }
}

// 用文字規則解析發票
function parseReceipt(text) {
  const out = { amount: null, currency: null, date: null, category: null };
  // ---------- 日期（支援各國格式）----------
  // 西元：2019/10/16、2019年10月16日、2019-10-16、2019.10.16
  // 民國：108/10/12、108年10月12日、108.10.12（108 → 2019）
  out.date = parseDateText(text);

  // ---------- 幣別 ----------
  if (/NT\$|新臺幣|新台幣|台幣|新台币/.test(text)) out.currency = 'NTD';
  else if (/HK\$|港幣|港元|港币/.test(text)) out.currency = 'HKD';
  else if (/￥|¥|人民幣|人民币|RMB|CNY|RMB|圓/.test(text)) out.currency = 'RMB';
  else if (/฿|泰銖|泰铢|泰幣|THB/.test(text)) out.currency = 'THB';
  else if (/\$[ ]?\d/.test(text) || /USD|美元/.test(text)) out.currency = 'USD';
  else if (/[¥￥]/.test(text)) out.currency = 'RMB';
  else if (/元/.test(text)) out.currency = 'RMB'; // 台灣發票常見「總計 元」
  else if (/NT/.test(text)) out.currency = 'NTD';

  // ---------- 金額 ----------
  // 優先：幣別符號/總計關鍵字 緊鄰的數字
  const amtPatterns = [
    /(?:總計|合計|共计|合计|應付|应付|实付|實付|價稅合計|价税合计|金額|金额|小计|小計|TOTAL|Total|AMOUNT|Grand\s*Total)[^\d]{0,8}([0-9][0-9,]*\.?\d{0,2})/,
    /[¥￥]\s*([0-9][0-9,]*\.?\d{0,2})/,
    /NT\$?\s*([0-9][0-9,]*\.?\d{0,2})/,
    /\$\s*([0-9][0-9,]*\.?\d{0,2})/,
    /([0-9]{1,3}(?:,[0-9]{3})+\.\d{1,2})/,
    /([0-9]{2,7}\.\d{1,2})/,
  ];
  for (const re of amtPatterns) {
    const mm = text.match(re);
    if (mm) {
      const v = parseFloat(mm[1].replace(/,/g, ''));
      if (v > 0) { out.amount = v; break; }
    }
  }
  // 後備：取文字中「看似金額」的最大數字（排除 4 位數年份、日期）
  if (!out.amount) {
    const nums = [];
    const re = /[0-9][0-9,]*(?:\.\d{1,2})?/g;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const v = parseFloat(mm[0].replace(/,/g, ''));
      if (v > 0 && v < 1000000 && !(v >= 1900 && v <= 2099)) nums.push(v);
    }
    if (nums.length) out.amount = Math.max(...nums);
  }

  // ---------- 類別（關鍵字）----------
  if (/機票|高鐵|高铁|火車|火车|計程車|出租車|出租车|地铁|地鐵|公車|公交|加油|燃油|停車|停车|交通|打的|滴滴|航空|航班|TAXI|Taxi|机票/.test(text)) out.category = '交通';
  else if (/住宿|酒店|旅館|旅馆|飯店|饭店|民宿|房費|房费|訂房|订房|HOTEL|Hotel/.test(text)) out.category = '住宿';
  else if (/餐|食堂|餐廳|餐厅|便當|便当|小吃|咖啡|外賣|外卖|麦当劳|麥當勞|肯德基|飯|饭|麵|面|美食|早餐|午餐|晚餐|宵夜|膳食/.test(text)) out.category = '膳食';
  return out;
}

// 解析日期文字（支援西元/民國）
function parseDateText(text) {
  if (!text) return null;
  // 完整年/月/日
  let m = text.match(/(\d{2,4})\s*[年\/\-\.]\s*(\d{1,2})\s*[月\/\-\.]\s*(\d{1,2})\s*日?/);
  if (m) {
    let y = parseInt(m[1], 10);
    if (y < 1912) y += 1911; // 民國年 → 西元
    const mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // 純 月/日（無年）
  m = text.match(/(\d{1,2})\s*[月\/\-\.]\s*(\d{1,2})\s*日?/);
  if (m) {
    const mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const y = (state.report.start && state.report.start.slice(0, 4)) || String(new Date().getFullYear());
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

// ---------- 裁切完成 ----------
async function finishCrop() {
  if (!cropPending.length) {
    toast('請至少框選一張發票');
    return;
  }
  const count = cropPending.length;
  for (const p of cropPending) {
    const blob = dataURLToBlob(p.dataURL);
    const imgId = uid();
    await idbPut(imgId, blob).catch(() => {});
    // 加入「待確認」清單（仍在「上傳發票」分頁，依日期排列）
    state.pending.push({
      id: uid(),
      date: p.date || state.report.start || todayStr(),
      currency: p.currency || 'NTD',
      amount: num(p.amount),
      rate: num(p.rate != null ? p.rate : getRate(p.currency || 'NTD')),
      category: p.category || '其他',
      trans: '現金',
      desc: '',
      receiptNo: '',
      imgId,
    });
  }
  // 移除原圖 entry
  if (cropImgId) {
    idbDel(cropImgId).catch(() => {});
    const idx = uploadEntries.findIndex(u => u.imgId === cropImgId);
    if (idx >= 0) uploadEntries.splice(idx, 1);
    renderUploadStack();
  }
  closeCrop();
  saveState();
  renderPending();
  toast('已裁切 ' + count + ' 張發票，請確認下方明細後按「完成」');
}
function closeCrop() {
  cropModal.classList.remove('open');
  cropImage = null;
  cropImgId = null;
  cropRect = [];
  cropPending = [];
}

// 大圖預覽
function openImagePreview(imgId) {
  idbGet(imgId).then(b => {
    if (!b) return;
    blobToDataURL(b).then(u => {
      const w = window.open('', '_blank');
      if (w) { w.document.write(`<title>發票預覽</title><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center"><img src="${u}" style="max-width:100vw;max-height:100vh"></body>`); }
      else toast('無法開啟預覽視窗');
    });
  });
}

// ============================================================
// 匯出 Excel（ExcelJS + template-spec.js：樣式逐格取自公司範本）
//   - 字型/框線/底色/列高/欄寬/合併/數字格式/列印設定 全部照範本
//   - 適用匯率、本幣合計、合計天數、幣別彙總 寫成範本同款公式
//   - 消費方式、幣別 下拉選單
//   - 交際費：有資料才產生範本下方的交際費區塊
//   - 發票圖片嵌入 類別分頁 / 膳食每日分頁
// ============================================================
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const MAIN_SHEET = '2. 出差報告暨旅費核銷明細表';
const RATE_SHEET = '1. 匯率表輸入';
const DETAIL_START = 28; // 範本明細從第 28 列開始

function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = EXCELJS_URL;
    s.onload = () => res();
    s.onerror = () => rej(new Error('ExcelJS 載入失敗（需要網路）'));
    document.head.appendChild(s);
  });
}

// ---------- 小工具 ----------
function colL(i) { // 1 → A
  let s = '';
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function tplStyle(id) { return JSON.parse(JSON.stringify(window.TEMPLATE_SPEC.styles[id])); }
function toXlDate(str) { // 'YYYY-MM-DD' → UTC Date（避免時區位移）
  if (!str) return null;
  const [y, m, d] = String(str).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}
// 依範本某列的樣式/固定文字鋪一列（只鋪樣式與「元」等固定字；資料另外填）
function putRow(ws, r, spec, height) {
  const row = ws.getRow(r);
  row.height = height || spec.h || undefined;
  spec.cells.forEach(([sid, v], i) => {
    const c = row.getCell(i + 1);
    c.style = tplStyle(sid);
    if (v != null) c.value = v;
  });
}
function setV(ws, addr, value) { ws.getCell(addr).value = value; }
function setF(ws, addr, formula, result) {
  ws.getCell(addr).value = (result === undefined) ? { formula } : { formula, result };
}

// ---------- 資料整理 ----------
function expenseRateInfo(e) {
  const table = getRate(e.currency);
  const used = num(e.rate) || table;
  return { table, used, custom: Math.abs(used - table) > 1e-9 };
}
function sortByDate(list) {
  return list.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}
function mealOverLimitRows() {
  const dayMeals = {};
  state.expenses.forEach(e => {
    if (e.category !== '膳食' || !e.date) return;
    dayMeals[e.date] = (dayMeals[e.date] || 0) + localTotalOf(e);
  });
  const limit = num(state.dailyLimit);
  return Object.keys(dayMeals).sort()
    .filter(d => dayMeals[d] > limit)
    .map(d => ({ date: d, excess: round2(dayMeals[d] - limit), limit }));
}
function currencyCodes() {
  const out = [];
  state.rates.forEach(r => { const c = String(r.code || '').trim(); if (c && !out.includes(c)) out.push(c); });
  state.expenses.forEach(e => { if (e.currency && !out.includes(e.currency)) out.push(e.currency); });
  return out;
}

// ---------- 1. 匯率表輸入 ----------
function buildRateSheet(wb) {
  const R = window.TEMPLATE_SPEC.rate;
  const ws = wb.addWorksheet(RATE_SHEET, { properties: { defaultColWidth: 8.875, defaultRowHeight: 17 } });
  ws.columns = R.widths.map(w => ({ width: w }));
  putRow(ws, 1, R.header);
  const codes = currencyCodes();
  codes.forEach((code, i) => {
    const r = i + 2;
    const row = ws.getRow(r);
    [1, 2].forEach(ci => { row.getCell(ci).style = tplStyle(R.row.cells[ci - 1][0]); });
    row.getCell(1).value = code;
    row.getCell(2).value = code === 'NTD' ? 1 : getRate(code);
  });
  // 消費模式（範本 D2:D3，主表下拉選單參照這裡）
  ['現金', '信用卡'].forEach((t, i) => {
    const c = ws.getCell('D' + (i + 2));
    c.style = tplStyle(R.row.cells[3][0]);
    c.value = t;
  });
  return codes;
}

// ---------- 2. 主表 ----------
function companyLine() {
  const m = (n) => (state.report.company === n) ? '■' : '□';
  return `       ${m('三集瑞科技集團')}三集瑞科技集團  ${m('塞席爾商三集瑞')}塞席爾商三集瑞  ${m('三積瑞科技蘇州')}三積瑞科技蘇州  ${m('東莞德泰利電子')}東莞德泰利電子\n` +
         `       ${m('TRIO INT.')}TRIO INT.       ${m('APEC')}APEC            ${m('TRIO Seychelles')}TRIO Seychelles ${m('Wonstar')}Wonstar`;
}

function rateFormula(r) {
  const ref = `'${RATE_SHEET}'`;
  return `IF(C${r}="","",IF(C${r}="信用卡",IFERROR(ROUND(N${r}/SUM(F${r}:M${r}),6),""),` +
    `IF(_xlfn.XLOOKUP(D${r},${ref}!A:A,${ref}!B:B,"")="","請至1.匯率表輸入",_xlfn.XLOOKUP(D${r},${ref}!A:A,${ref}!B:B,""))))`;
}

// 寫一筆明細列；回傳該列本幣（供彙總快取值）
function writeDetailRow(ws, r, spec, e, dv) {
  const desc = e.desc || '';
  putRow(ws, r, spec, desc.length > 12 ? 26.5 : undefined);
  const { used, custom } = expenseRateInfo(e);
  const fees = [0, 0, 0, 0];
  fees[catToIndex(e.category)] = num(e.amount);
  const local = num(e.amount) * used;

  const d1 = toXlDate(e.date), d2 = toXlDate(e.dateEnd || e.date);
  if (d1) setV(ws, 'A' + r, d1);
  if (d2) setV(ws, 'B' + r, d2);
  setV(ws, 'C' + r, e.trans || '現金');
  setV(ws, 'D' + r, e.currency || 'NTD');
  ['F', 'H', 'J', 'L'].forEach((c, i) => setV(ws, c + r, fees[i]));

  if (e.trans === '信用卡') {
    // 範本：信用卡填實際刷卡台幣，適用匯率反推
    setV(ws, 'N' + r, local);
    setF(ws, 'E' + r, rateFormula(r), round6(used));
  } else {
    if (custom) setV(ws, 'E' + r, used); // 手動改過匯率 → 寫死數值
    else setF(ws, 'E' + r, rateFormula(r), used);
    setF(ws, 'N' + r, `E${r}*(F${r}+H${r}+J${r}+L${r})`, local);
  }
  setV(ws, 'P' + r, desc);
  setV(ws, 'Q' + r, e.receiptNo || '');
  Object.assign(dv, { [r]: true });
  return { cur: e.currency || 'NTD', local, orig: num(e.amount) };
}

function writeDeductRow(ws, r, spec, o, dv) {
  putRow(ws, r, spec);
  const d = toXlDate(o.date);
  if (d) { setV(ws, 'A' + r, d); setV(ws, 'B' + r, d); }
  setV(ws, 'C' + r, '現金');
  setV(ws, 'D' + r, 'NTD');
  setF(ws, 'E' + r, rateFormula(r), 1);
  setV(ws, 'F' + r, 0); setV(ws, 'H' + r, -o.excess); setV(ws, 'J' + r, 0); setV(ws, 'L' + r, 0);
  setF(ws, 'N' + r, `E${r}*(F${r}+H${r}+J${r}+L${r})`, -o.excess);
  setV(ws, 'P' + r, `膳食超限扣回(每日上限${fmt(o.limit, 0)}元)`);
  dv[r] = true;
  return { cur: 'NTD', local: -o.excess, orig: -o.excess };
}

// 檢附憑證/幣別彙總區（範本 42~48 列；交際費 58~62 列同結構）
function writeTotalsBlock(ws, r0, roles, d1, d2, allCodes, rows, count, merges) {
  const T = window.TEMPLATE_SPEC.roles;
  // 只列出這一區實際有用到的幣別（依匯率表順序）；完全沒資料時保留 NTD 一列
  const usedCur = new Set(rows.map(x => x.cur));
  let codes = allCodes.filter(c => usedCur.has(c));
  if (!codes.length) codes = ['NTD'];
  const k = codes.length;
  putRow(ws, r0, T[roles.head]);
  setV(ws, 'B' + r0, `${count} 張`);
  merges.push(`D${r0}:E${r0}`, `F${r0}:G${r0}`, `H${r0}:I${r0}`, `J${r0}:O${r0}`);

  const D = `$D$${d1}:$D$${d2}`;
  const sums = {};
  codes.forEach((c, i) => {
    const r = r0 + 1 + i;
    const role = i === 0 ? roles.first : (i === k - 1 ? roles.last : roles.mid);
    putRow(ws, r, T[role]);
    merges.push(`D${r}:E${r}`);
    setV(ws, 'D' + r, c);
    const its = rows.filter(x => x.cur === c);
    const orig = its.reduce((s, x) => s + x.orig, 0);
    const loc = Math.round(its.reduce((s, x) => s + x.local, 0));
    sums[c] = loc;
    setF(ws, 'F' + r,
      `SUM(SUMIF(${D},$D${r},$H$${d1}:$H$${d2}),SUMIF(${D},$D${r},$J$${d1}:$J$${d2}),SUMIF(${D},$D${r},$L$${d1}:$L$${d2}),SUMIF(${D},$D${r},$F$${d1}:$F$${d2}))`,
      round2(orig));
    setF(ws, 'H' + r, `IFERROR(ROUND(SUMIF(${D},D${r},$N$${d1}:$N$${d2}),0),"錯誤")`, loc);
  });
  // 備註欄合併：第一個幣別一格、其餘合併成一大格（同範本 J43:O43 / J44:O47）
  if (k >= 1) merges.push(`J${r0 + 1}:O${r0 + 1}`);
  if (k >= 2) merges.push(`J${r0 + 2}:O${r0 + k}`);

  const rs = r0 + k + 1;
  putRow(ws, rs, T[roles.sum]);
  const total = Object.values(sums).reduce((s, v) => s + v, 0);
  setF(ws, 'F' + rs, `SUM(H${r0 + 1}:H${r0 + k})`, total);
  merges.push(`D${rs}:E${rs}`, `F${rs}:H${rs}`, `J${rs}:O${rs}`);
  // 左側 檢附憑證 / 張數 / 旅費總計 直向合併
  merges.push(`A${r0}:A${rs}`, `B${r0}:B${rs}`, `C${r0}:C${rs}`);
  return { sumRow: rs, next: rs + 1, total };
}

function suppText(travelTotal, entTotal, hasEnt, over) {
  const lines = [];
  lines.push(`差旅費報銷，台幣${fmt(travelTotal, 0)}元。`);
  if (over.length) {
    const t = over.reduce((s, o) => s + o.excess, 0);
    lines.push(`膳食費每日上限台幣${fmt(state.dailyLimit, 0)}元，超限共台幣${fmt(t, 0)}元已於明細扣回。`);
  }
  if (hasEnt) {
    lines.push(`交際費報銷，台幣${fmt(entTotal, 0)}元。`);
    lines.push(`請款合計台幣${fmt(travelTotal + entTotal, 0)}元。`);
  }
  String(state.report.note || '').split('\n').map(s => s.trim()).filter(Boolean).forEach(s => lines.push(s));
  return lines.map((s, i) => `${i + 1}.${s}`).join('\n');
}

function buildMainSheet(wb, codes) {
  const S = window.TEMPLATE_SPEC;
  const T = S.roles;
  const r = state.report;
  const ws = wb.addWorksheet(MAIN_SHEET, { properties: { defaultColWidth: 8.875, defaultRowHeight: 16.3 } });
  ws.columns = S.widths.map(w => ({ width: w }));
  const merges = S.headerMerges.slice();
  const dvRows = {};

  // ---- 表頭 1~27 列（樣式 + 固定標籤直接取自範本）----
  S.header.forEach((spec, i) => putRow(ws, i + 1, spec));
  setV(ws, 'A1', companyLine());
  setV(ws, 'A3', (r.tripType === '國內' ? '■國內　□國外' : '□國內　■國外') + '　'.repeat(11) + ' '.repeat(23));
  const fd = toXlDate(r.fillDate); if (fd) setV(ws, 'H3', fd);
  setV(ws, 'B4', r.person || '');
  setV(ws, 'H4', r.dept || '');
  setV(ws, 'B5', r.region || '');
  const sd = toXlDate(r.start), ed = toXlDate(r.end);
  if (sd) setV(ws, 'C6', sd);
  if (ed) setV(ws, 'F6', ed);
  const days = computeDaysNum(r.start, r.end);
  setF(ws, 'L6', 'IF(AND(C6<>"",F6<>""),_xlfn.DAYS(F6,C6)+1,"")', days === '' ? '' : days);
  setV(ws, 'A9', r.focus || '');
  setV(ws, 'A16', r.issue || '');

  // ---- 旅費明細 ----
  const travel = sortByDate(state.expenses.filter(e => e.category !== ENT_CATEGORY));
  const ent = sortByDate(state.expenses.filter(e => e.category === ENT_CATEGORY));
  const over = mealOverLimitRows();
  const rows = [];
  let row = DETAIL_START;
  travel.forEach(e => { rows.push(writeDetailRow(ws, row, T.detail, e, dvRows)); row++; });
  over.forEach(o => { rows.push(writeDeductRow(ws, row, T.deduct, o, dvRows)); row++; });
  if (row === DETAIL_START) { putRow(ws, row, T.detail); dvRows[row] = true; row++; } // 至少留一列空白明細
  const d1 = DETAIL_START, d2 = row - 1;

  // 小計
  putRow(ws, row, T.subtotal);
  setF(ws, 'N' + row, `SUM(N${d1}:N${d2})`, rows.reduce((s, x) => s + x.local, 0));
  merges.push(`L${row}:M${row}`);
  row++;

  // 檢附憑證 / 旅費總計
  const tot = writeTotalsBlock(ws, row,
    { head: 'totHead', first: 'totFirst', mid: 'totMid', last: 'totLast', sum: 'totSum' },
    d1, d2, codes, rows, travel.length, merges);
  row = tot.next;

  // 使用備註 / 補充說明 / 使用備註
  const noteRow1 = row, suppRow = row + 1, noteRow2 = row + 2;
  putRow(ws, noteRow1, T.note1);
  putRow(ws, suppRow, T.supp);
  putRow(ws, noteRow2, T.note2);
  merges.push(`B${noteRow1}:O${noteRow1}`, `B${suppRow}:O${suppRow}`, `B${noteRow2}:O${noteRow2}`);
  row = noteRow2 + 1;

  // ---- 交際費（有資料才產生）----
  let entTotal = 0;
  if (ent.length) {
    putRow(ws, row, T.gap); row++;
    putRow(ws, row, T.entTitle);
    merges.push(`A${row}:O${row}`);
    row++;
    const e1 = row;
    const entRows = [];
    ent.forEach(e => { entRows.push(writeDetailRow(ws, row, T.entDetail, e, dvRows)); row++; });
    const e2 = row - 1;
    const entTot = writeTotalsBlock(ws, row,
      { head: 'entHead', first: 'entFirst', mid: 'entMid', last: 'entLast', sum: 'entSum' },
      e1, e2, codes, entRows, ent.length, merges);
    entTotal = entTot.total;
    row = entTot.next;
    putRow(ws, row, T.grand);
    setF(ws, 'F' + row, `F${entTot.sumRow}+F${tot.sumRow}`, tot.total + entTotal);
    merges.push(`A${row}:E${row}`, `F${row}:H${row}`, `J${row}:O${row}`);
    row++;
  }
  setV(ws, 'B' + suppRow, suppText(tot.total, entTotal, ent.length > 0, over));
  const lastRow = row - 1;

  // 合併（不覆蓋各格樣式，保留範本框線）
  merges.forEach(m => ws.mergeCellsWithoutStyle(m));

  // 下拉選單（同範本：消費方式→匯率表 D2:D3；幣別→匯率表 A 欄）
  const curRange = `'${RATE_SHEET}'!$A$2:$A$${codes.length + 1}`;
  Object.keys(dvRows).forEach(r2 => {
    ws.getCell('C' + r2).dataValidation = {
      type: 'list', allowBlank: true, formulae: [`'${RATE_SHEET}'!$D$2:$D$3`],
      showErrorMessage: true, errorStyle: 'warning', error: '請挑選下拉式選單，以利匯率自動代入。',
    };
    ws.getCell('D' + r2).dataValidation = { type: 'list', allowBlank: true, formulae: [curRange], showErrorMessage: true };
  });

  // 列印設定（A4 直印、縮放、邊界、列印範圍同範本）
  const P = S.page;
  ws.pageSetup = {
    paperSize: P.paperSize, orientation: P.orientation, scale: P.scale, fitToPage: false,
    margins: P.margins, printArea: `A1:P${lastRow}`,
  };
  return ws;
}

function computeDaysNum(s, e) {
  if (!s || !e) return '';
  const d1 = new Date(s), d2 = new Date(e);
  const days = Math.round((d2 - d1) / 86400000) + 1;
  return days > 0 ? days : '';
}

// ---------- 分頁結構（照公司範本）----------
// 出差費用種類 → 1. 匯率表輸入 → 2. 出差報告暨旅費核銷明細表 → 出差日報及交際費明細
// → 交通費憑證 → 膳食費憑證 → 膳食費發票 → 通訊費憑證 → 其他憑證拍照或掃瞄（有資料才產生）
//   膳食費憑證：依日期的膳食明細表格（只有表格）
//   膳食費發票：膳食發票/收據照片（依日期分組）
//   其他憑證頁：同範本，只放照片
const COST_SHEET = '出差費用種類';
const DAILY_SHEET = '出差日報及交際費明細';
const RECEIPT_SHEETS = ['交通費憑證', '膳食費憑證', '通訊費憑證', '其他憑證拍照或掃瞄'];
const MEAL_PHOTO_SHEET = '膳食費發票';

function receiptSheetFor(e) {
  if (e.category === '膳食') return '膳食費憑證';
  if (e.category === '交通') return '交通費憑證';
  const t = (e.desc || '') + (e.category || '');
  if (/電信|漫遊|漫游|通訊|通讯|通信|電話|电话|網路|网络|上網|SIM|eSIM/i.test(t)) return '通訊費憑證';
  return '其他憑證拍照或掃瞄'; // 住宿、其他、交際費、自訂類別
}
function safeSheetName(name, used) {
  let n = String(name).replace(/[\[\]:*?/\\]/g, '').slice(0, 31) || '分頁';
  let k = 2;
  const base = n;
  while (used.has(n)) n = (base.slice(0, 28) + '_' + (k++));
  used.add(n);
  return n;
}
function mdText(day) { return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`; }

// ---------- 出差費用種類（整頁照範本）----------
function buildCostSheet(wb) {
  const C = window.TEMPLATE_SPEC.cost;
  const ws = wb.addWorksheet(COST_SHEET);
  ws.columns = C.widths.map(w => ({ width: w }));
  C.rows.forEach((spec, i) => putRow(ws, i + 1, spec));
  C.merges.forEach(m => ws.mergeCellsWithoutStyle(m));
}

// ---------- 出差日報及交際費明細 ----------
// 依出差期間每天一列（客戶/產品等欄位留給業務填），當天的交際費自動帶入
function tripDays() {
  const r = state.report;
  let s = r.start, e = r.end;
  const dates = state.expenses.map(x => x.date).filter(Boolean).sort();
  if (!s) s = dates[0];
  if (!e) e = dates[dates.length - 1] || s;
  if (!s) return [];
  const out = [];
  const d = toXlDate(s), end = toXlDate(e) || d;
  for (let t = d.getTime(), n = 0; t <= end.getTime() && n < 120; t += 86400000, n++) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
function buildDailySheet(wb) {
  const D = window.TEMPLATE_SPEC.daily;
  const ws = wb.addWorksheet(DAILY_SHEET, { views: [{ zoomScale: D.zoom }] });
  ws.columns = D.widths.map(w => ({ width: w }));
  putRow(ws, 1, D.title);
  putRow(ws, 2, D.head);
  ws.mergeCellsWithoutStyle('A1:M1');

  const ent = state.expenses.filter(e => e.category === ENT_CATEGORY);
  const entLine = e => {
    const { used } = expenseRateInfo(e);
    return `餐費 : ${fmt(num(e.amount))} ${e.currency}*${fmt(used, 6)}= ${fmt(Math.round(num(e.amount) * used), 0)} TWD`;
  };
  let r = 3;
  tripDays().forEach(day => {
    putRow(ws, r, D.row);
    const c = ws.getCell('B' + r);
    c.value = toXlDate(day);
    c.numFmt = 'm"月"d"日"';
    const todays = ent.filter(e => e.date === day);
    if (todays.length) {
      ws.getCell('L' + r).value = todays.map(entLine).join('\n');
      ws.getCell('M' + r).value = todays.map(e => e.desc || '').filter(Boolean).join('\n');
      ws.getRow(r).height = Math.max(34, 20 * todays.length);
    }
    r++;
  });
  // 交際費總計（有交際費才產生）
  if (ent.length) {
    putRow(ws, r, D.total);
    const byCur = {};
    ent.forEach(e => {
      const { used } = expenseRateInfo(e);
      const k = e.currency + '|' + used;
      byCur[k] = byCur[k] || { cur: e.currency, rate: used, amt: 0 };
      byCur[k].amt += num(e.amount);
    });
    const parts = Object.values(byCur).map(x => `${fmt(x.amt)} ${x.cur}*${fmt(x.rate, 6)}`);
    const twd = ent.reduce((s, e) => s + num(e.amount) * expenseRateInfo(e).used, 0);
    ws.getCell('L' + r).value = `交際費總計${parts.join(' + ')}=${fmt(Math.round(twd), 0)} TWD`;
    ws.getRow(r).height = 49.6;
    r++;
  }
  ws.pageSetup = {
    paperSize: 9, orientation: D.orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    printArea: `B1:M${Math.max(r - 1, 2)}`, margins: window.TEMPLATE_SPEC.page.margins,
  };
}

// ---------- 憑證頁：上方明細表格，下方附發票/收據 ----------
const RC = (() => {
  const F = '標楷體';
  const thin = { style: 'thin' };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const yellow = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
  const gray = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  return {
    title: { font: { name: F, size: 14, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } },
    head: { font: { name: F, size: 11, bold: true }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: box, fill: gray },
    txt: { font: { name: F, size: 11 }, alignment: { vertical: 'middle', wrapText: true }, border: box },
    ctr: { font: { name: F, size: 11 }, alignment: { horizontal: 'center', vertical: 'middle' }, border: box },
    date: { font: { name: F, size: 11 }, alignment: { horizontal: 'center', vertical: 'middle' }, border: box, numFmt: 'yyyy/mm/dd' },
    amt: { font: { name: 'Calibri', size: 11 }, alignment: { horizontal: 'right', vertical: 'middle' }, border: box, numFmt: '#,##0.00' },
    calc: { font: { name: 'Calibri', size: 11 }, alignment: { horizontal: 'right', vertical: 'middle' }, border: box, numFmt: '#,##0.00', fill: yellow },
    red: { font: { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFF0000' } }, alignment: { horizontal: 'right', vertical: 'middle' }, border: box, numFmt: '#,##0.00', fill: yellow },
    lab: { font: { name: F, size: 11, bold: true }, alignment: { horizontal: 'right', vertical: 'middle' }, border: box, fill: gray },
    labRed: { font: { name: F, size: 11, bold: true, color: { argb: 'FFFF0000' } }, alignment: { horizontal: 'right', vertical: 'middle' }, border: box, fill: gray },
    section: { font: { name: F, size: 12, bold: true }, alignment: { vertical: 'middle' } },
  };
})();
const RC_COLS = [{ h: '日期', w: 11.5 }, { h: '類別', w: 8 }, { h: '說明', w: 24 }, { h: '消費方式', w: 9 },
  { h: '幣別', w: 6.5 }, { h: '金額(原幣)', w: 11.5 }, { h: '適用匯率', w: 9 }, { h: '本幣合計(NTD)', w: 13 }, { h: '憑證編號', w: 11 }];

function rcPut(ws, addr, value, style) {
  const c = ws.getCell(addr);
  c.style = JSON.parse(JSON.stringify(style));
  if (value !== undefined) c.value = value;
}
function rcItemRow(ws, r, e) {
  const { used } = expenseRateInfo(e);
  const local = round2(num(e.amount) * used);
  rcPut(ws, 'A' + r, toXlDate(e.date), RC.date);
  rcPut(ws, 'B' + r, e.category || '', RC.ctr);
  rcPut(ws, 'C' + r, e.desc || '', RC.txt);
  rcPut(ws, 'D' + r, e.trans || '現金', RC.ctr);
  rcPut(ws, 'E' + r, e.currency || 'NTD', RC.ctr);
  rcPut(ws, 'F' + r, num(e.amount), RC.amt);
  rcPut(ws, 'G' + r, used, { ...RC.ctr, numFmt: 'General' });
  rcPut(ws, 'H' + r, { formula: `ROUND(F${r}*G${r},2)`, result: local }, RC.calc);
  rcPut(ws, 'I' + r, e.receiptNo || '', RC.ctr);
  ws.getRow(r).height = (e.desc || '').length > 14 ? 32 : 20;
  return local;
}
// 合計類的列：A~G 合併放標籤，H 放金額
function rcSumRow(ws, r, label, formula, result, isRed) {
  ws.mergeCells(`A${r}:G${r}`);
  for (let i = 1; i <= 7; i++) rcPut(ws, colL(i) + r, i === 1 ? label : undefined, isRed ? RC.labRed : RC.lab);
  rcPut(ws, 'H' + r, { formula, result }, isRed ? RC.red : RC.calc);
  rcPut(ws, 'I' + r, '元', RC.ctr);
  ws.getRow(r).height = 20;
}

// 圖片一列最多 perRow 張，放不下就換列；回傳下一個可用列(1-based)
async function placeImageGrid(wb, ws, exps, startRow, maxW, maxH, perRow) {
  let row0 = startRow - 1; // ExcelJS 錨點是 0-based
  let col = 0, n = 0, tallest = 0, placed = 0;
  for (const e of exps) {
    if (!e.imgId) continue;
    let info = null;
    try { info = await imageInfo(e.imgId); } catch (err) { console.warn('圖片讀取失敗', err); }
    if (!info) continue;
    if (n === perRow) { row0 += Math.ceil(tallest / 20) + 1; col = 0; n = 0; tallest = 0; }
    const s = Math.min(1, maxW / info.w, maxH / info.h);
    const width = Math.round(info.w * s), height = Math.round(info.h * s);
    const id = wb.addImage({ base64: info.base64, extension: info.ext });
    ws.addImage(id, { tl: { col, row: row0 }, ext: { width, height }, editAs: 'oneCell' });
    let px = 0;
    while (px < width + 12) { px += colPx(ws, col); col++; }
    tallest = Math.max(tallest, height);
    n++; placed++;
  }
  return placed ? row0 + Math.ceil(tallest / 20) + 2 : startRow;
}

// 膳食費憑證：依日期分組的明細表格，每天小計，超過每日上限加一列扣回
function buildMealTableSheet(wb, list) {
  const ws = wb.addWorksheet('膳食費憑證');
  ws.columns = RC_COLS.map(c => ({ width: c.w }));
  ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: window.TEMPLATE_SPEC.page.margins };
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  ws.mergeCells('A1:I1');
  rcPut(ws, 'A1', '膳食費明細（依日期）', RC.title);
  ws.getRow(1).height = 26;
  RC_COLS.forEach((c, i) => rcPut(ws, colL(i + 1) + '2', c.h, RC.head));
  ws.getRow(2).height = 30;

  const limit = num(state.dailyLimit);
  const sorted = sortByDate(list);
  const sumRefs = []; let grand = 0; let r = 3;
  [...new Set(sorted.map(e => e.date || ''))].forEach(day => {
    const first = r; let dayTotal = 0;
    sorted.filter(e => (e.date || '') === day).forEach(e => { dayTotal += rcItemRow(ws, r, e); r++; });
    dayTotal = round2(dayTotal);
    rcSumRow(ws, r, (day ? mdText(day) : '未填日期') + `　小計（每日上限 ${fmt(limit, 0)} 元）`, `SUM(H${first}:H${r - 1})`, dayTotal);
    sumRefs.push('H' + r); grand += dayTotal; r++;
    if (day && dayTotal > limit) {
      const over = round2(dayTotal - limit);
      rcSumRow(ws, r, `${mdText(day)}　超限扣回`, `-(H${r - 1}-${limit})`, -over, true);
      sumRefs.push('H' + r); grand -= over; r++;
    }
  });
  rcSumRow(ws, r, '膳食費合計（已扣除超限）', sumRefs.join('+') || '0', round2(grand));
}

// 照片頁：只放發票/收據照片。byDate=true 時每天先放一列日期標題
async function buildPhotoSheet(wb, name, list, byDate) {
  const withImg = sortByDate(list).filter(e => e.imgId);
  if (!withImg.length) return;
  const ws = wb.addWorksheet(name);
  if (!byDate) { await placeImageGrid(wb, ws, withImg, 1, 300, 520, 3); return; }
  let r = 1;
  for (const day of [...new Set(withImg.map(e => e.date || ''))]) {
    const c = ws.getCell('A' + r);
    c.value = day ? mdText(day) : '未填日期';
    c.style = { font: { name: '標楷體', size: 12, bold: true }, alignment: { vertical: 'middle' } };
    r = await placeImageGrid(wb, ws, withImg.filter(e => (e.date || '') === day), r + 1, 300, 520, 3);
  }
}

async function buildReceiptSheets(wb) {
  const groups = {};
  state.expenses.forEach(e => { const n = receiptSheetFor(e); (groups[n] = groups[n] || []).push(e); });
  for (const n of RECEIPT_SHEETS) {
    const list = groups[n] || [];
    if (!list.length) continue;
    if (n === '膳食費憑證') {
      buildMealTableSheet(wb, list);
      await buildPhotoSheet(wb, MEAL_PHOTO_SHEET, list, true);
    } else {
      await buildPhotoSheet(wb, n, list, false);
    }
  }
}

async function buildWorkbook() {
  if (!window.TEMPLATE_SPEC) throw new Error('找不到 template-spec.js');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'trioTE';
  wb.calcProperties.fullCalcOnLoad = true; // 開檔時重算公式
  buildCostSheet(wb);
  const codes = buildRateSheet(wb);
  buildMainSheet(wb, codes);
  buildDailySheet(wb);
  await buildReceiptSheets(wb);
  // 開檔時停在主表
  wb.views = [{ activeTab: 2, firstSheet: 0, visibility: 'visible' }];
  return wb;
}

async function imageInfo(imgId) {
  const blob = await idbGet(imgId);
  if (!blob) return null;
  const dataURL = await blobToDataURL(blob);
  let w = 0, h = 0;
  try {
    const bmp = await createImageBitmap(blob);
    w = bmp.width; h = bmp.height; bmp.close && bmp.close();
  } catch (err) {
    await new Promise(res => { const im = new Image(); im.onload = () => { w = im.naturalWidth; h = im.naturalHeight; res(); }; im.onerror = res; im.src = dataURL; });
  }
  if (!w || !h) return null;
  const ext = /png/i.test(blob.type) ? 'png' : (/gif/i.test(blob.type) ? 'gif' : 'jpeg');
  return { base64: dataURL.split(',')[1], ext, w, h };
}
function colPx(ws, ci) { // 欄寬(字元) → 約略像素
  const w = (ws.getColumn(ci + 1).width) || 8.43;
  return Math.round(w * 7 + 5);
}

function exportFileName() {
  const r = state.report;
  const s = (r.start || '').replace(/-/g, ''), e = (r.end || '').replace(/-/g, '');
  const range = s ? (e && e !== s ? `${s}-${e.slice(4)}` : s) : todayStr().replace(/-/g, '');
  return `${r.person || ''}出差報告暨旅費核銷${range}.xlsx`.replace(/[\\/:*?"<>|]/g, '');
}

async function doExport() {
  const btn = $('#btn-export');
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    await loadExcelJS();
    const wb = await buildWorkbook();
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), exportFileName());
    toast('匯出完成，資料仍在本地端');
  } catch (err) {
    toast('匯出失敗：' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '匯出 Excel';
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ============================================================
// 事件綁定
// ============================================================
function switchTab(id) {
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === id));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === id));
}

function bindEvents() {
  // Tab 切換
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    switchTab(t.dataset.tab);
  }));

  // 匯率表
  $('#rate-body').addEventListener('input', (e) => {
    const inp = e.target;
    if (inp.dataset.k === 'rate' || inp.dataset.k === 'code') {
      const i = Number(inp.dataset.i);
      const r = state.rates[i];
      if (!r) return;
      r[inp.dataset.k] = inp.dataset.k === 'rate' ? num(inp.value) : inp.value;
      saveState();
      renderExpenses();
      renderSummary();
    }
  });
  $('#rate-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.del');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    state.rates.splice(i, 1);
    saveState();
    renderRates();
    renderExpenses();
  });
  $('#btn-add-rate').addEventListener('click', () => {
    state.rates.push({ code: '', rate: 1, locked: false });
    saveState();
    renderRates();
  });
  $('#daily-limit').addEventListener('change', (e) => {
    state.dailyLimit = num(e.target.value);
    saveState();
    renderSummary();
    renderExpenses();
  });

  // 出差報告
  const reportInputs = [
    ['#f-fill-date', 'fillDate'], ['#f-person', 'person'], ['#f-dept', 'dept'],
    ['#f-region', 'region'], ['#f-start', 'start'], ['#f-end', 'end'],
    ['#f-focus', 'focus'], ['#f-issue', 'issue'], ['#f-note', 'note'],
  ];
  reportInputs.forEach(([sel, key]) => {
    $(sel).addEventListener('change', (e) => {
      state.report[key] = e.target.value;
      saveState();
      if (key === 'start' || key === 'end') computeDays();
    });
  });
  $$('input[name="trip-type"]').forEach(x => x.addEventListener('change', () => {
    if (x.checked) { state.report.tripType = x.value; saveState(); }
  }));

  // 上傳
  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    handleFiles(e.target.files).then(() => { e.target.value = ''; });
  });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    handleFiles(e.dataTransfer.files);
  });

  // 裁切 modal
  $('#btn-crop-done').addEventListener('click', finishCrop);
  $('#btn-crop-cancel').addEventListener('click', closeCrop);
  $('#btn-ocr').addEventListener('click', runOCR);
  $('#btn-autodetect').addEventListener('click', () => { autoDetectRects(); autoRunOCR(); });

  // 手動新增
  $('#btn-add-manual').addEventListener('click', () => {
    addExpense({ date: state.report.start || todayStr(), currency: 'NTD', amount: 0, category: '其他', trans: '現金' });
    toast('已新增一筆，請填寫金額/類別');
  });

  // 匯出 / 全清
  $('#btn-export').addEventListener('click', doExport);
  $('#btn-clear-all').addEventListener('click', () => {
    if (!confirm('確定要清除所有資料（發票、明細、報告）嗎？此動作無法復原。')) return;
    state.expenses = [];
    state.pending = [];
    state.report = defaultState().report;
    state.customCategories = [];
    state.rates = JSON.parse(JSON.stringify(DEFAULT_RATES));
    saveState();
    idbClear().catch(() => {});
    uploadEntries = [];
    renderUploadStack();
    renderAll();
    toast('已全部清除');
  });
}

// 新增自訂類別（共用：核銷明細與上傳分頁連動）
function addCustomCat(name) {
  name = (name || '').trim();
  if (!name) return false;
  if (BASE_CATEGORIES.includes(name) || state.customCategories.includes(name)) { toast('類別已存在'); return false; }
  state.customCategories.push(name);
  saveState();
  renderCatFilter();
  renderExpenses();
  renderPending();
  renderUploadCats();
  toast('已新增類別「' + name + '」');
  return true;
}

// 新增自訂類別入口（核銷明細工具列）
function ensureCustomCatInput() {
  let bar = $('#cat-filter');
  if ($('#custom-cat-input')) return;
  const wrap = document.createElement('span');
  wrap.style.display = 'inline-flex';
  wrap.style.gap = '4px';
  wrap.innerHTML = `<input id="custom-cat-input" placeholder="新增類別…" style="padding:5px 10px;border:1px solid var(--line);border-radius:20px;font-size:12px;width:110px"><button class="btn" id="custom-cat-add" style="padding:4px 10px;font-size:12px">+</button>`;
  bar.parentNode.appendChild(wrap);
  $('#custom-cat-add').addEventListener('click', () => {
    if (addCustomCat($('#custom-cat-input').value)) $('#custom-cat-input').value = '';
  });
  $('#custom-cat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#custom-cat-add').click();
  });
}

// 上傳分頁：新增類別 + 完成按鈕
function ensureUploadCatInput() {
  const inp = $('#upload-cat-input');
  const addBtn = $('#upload-cat-add');
  if (!inp || !addBtn) return;
  addBtn.addEventListener('click', () => {
    if (addCustomCat(inp.value)) inp.value = '';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });
  $('#btn-commit').addEventListener('click', commitPending);
}

// 啟動
bindEvents();
ensureCustomCatInput();
ensureUploadCatInput();
renderAll();
renderUploadStack();
