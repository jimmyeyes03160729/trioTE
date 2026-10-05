'use strict';

/* ============================================================
   trioTE — 出差報銷懶人系統 (純前端)
   資料儲存：localStorage（結構資料）+ IndexedDB（發票圖片）
   ============================================================ */

// ---------- 常數 ----------
const BASE_CATEGORIES = ['交通', '住宿', '膳食', '其他'];
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
  if (d == null) d = (Math.abs(n) % 1 !== 0) ? 2 : 0;
  return Number(n || 0).toLocaleString('zh-Hant', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
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
    if (t > 0) chips.push({ lbl: cat + '費', val: fmt(t) });
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
    body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:24px">尚無資料，可到「上傳發票」分頁上傳，或點「手動新增一筆」</td></tr>';
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
    <td><input type="date" value="${esc(e.date || '')}" data-k="date" title="日期"></td>
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
    await addExpense({
      imgId,
      date: p.date || state.report.start || todayStr(),
      currency: p.currency || 'NTD',
      amount: num(p.amount),
      category: p.category || '其他',
      trans: '現金',
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
  renderAll();
  switchTab('tab-expense');
  toast('已新增 ' + count + ' 筆發票，請確認金額/幣別/類別');
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
// 匯出 Excel（SheetJS，對齊範本格式）
// ============================================================
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    s.onload = () => res();
    s.onerror = () => rej(new Error('SheetJS CDN 載入失敗'));
    document.head.appendChild(s);
  });
}

const XLSX_STYLE = {
  title: { font: { sz: 20, bold: true, name: '微軟正黑體' }, alignment: { horizontal: 'center', vertical: 'center' } },
  header: { font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' }, fill: { fgColor: { rgb: 'FFF2CC' } }, border: thinBorder() },
  cell: { border: thinBorder(), alignment: { vertical: 'center' } },
  center: { alignment: { horizontal: 'center', vertical: 'center' }, border: thinBorder() },
};
function thinBorder() {
  return { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
}

function buildWorkbook() {
  const wb = XLSX.utils.book_new();

  // ---- 1. 匯率表輸入 ----
  const wsRate = XLSX.utils.aoa_to_sheet([]);
  wsRate['!cols'] = [{ wch: 14 }, { wch: 25 }, { wch: 9 }, { wch: 11 }, { wch: 9 }];
  setCell(wsRate, 'A1', '幣別\n(可自行增列)', XLSX_STYLE.header);
  setCell(wsRate, 'B1', '報銷匯率\n(請向會計確認)\n非出納提供借支匯率', XLSX_STYLE.header);
  setCell(wsRate, 'D1', '消費模式\n(請勿異動)', XLSX_STYLE.header);
  wsRate['!merges'] = wsRate['!merges'] || [];
  state.rates.forEach((r, i) => {
    const row = i + 2;
    setCell(wsRate, addr(1, row), r.code, XLSX_STYLE.center);
    setCell(wsRate, addr(2, row), r.code === 'NTD' ? 1 : num(r.rate), XLSX_STYLE.cell);
  });
  setCell(wsRate, 'D2', '現金', XLSX_STYLE.cell);
  setCell(wsRate, 'D3', '信用卡', XLSX_STYLE.cell);
  XLSX.utils.book_append_sheet(wb, wsRate, '1. 匯率表輸入');

  // ---- 2. 出差報告暨旅費核銷明細表 ----
  const ws = XLSX.utils.aoa_to_sheet([]);
  buildReportSheet(ws);
  XLSX.utils.book_append_sheet(wb, ws, '2. 出差報告暨旅費核銷明細表');

  // ---- 膳食每日分頁 ----
  const mealByDay = groupByDay('膳食');
  Object.keys(mealByDay).sort().forEach(day => {
    const dayName = '膳食' + day.replace(/-/g, '').slice(4); // 0717
    const wsDay = XLSX.utils.aoa_to_sheet([]);
    wsDay['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }];
    setDateCell(wsDay, 'A2', day);
    const total = mealByDay[day].reduce((s, e) => s + num(e.amount), 0);
    setCell(wsDay, 'B35', total, { numFmt: '0.00' });
    // 圖片
    embedImages(wsDay, mealByDay[day]);
    XLSX.utils.book_append_sheet(wb, wsDay, dayName);
  });

  // ---- 類別分頁（非膳食，放對應發票圖）----
  const catSheetDefs = ['電信', '機票', '住宿', '大陸高鐵', '機場交通'];
  const catMap = {};
  catSheetDefs.forEach(name => catMap[name] = []);
  state.expenses.forEach(e => {
    if (e.category === '膳食') return;
    const name = sheetNameForExpense(e);
    if (catMap[name]) catMap[name].push(e);
    else catMap['機票'].push(e);
  });
  catSheetDefs.forEach(name => {
    const wsCat = XLSX.utils.aoa_to_sheet([]);
    wsCat['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    embedImages(wsCat, catMap[name]);
    XLSX.utils.book_append_sheet(wb, wsCat, name);
  });

  return wb;
}

// 依發票內容決定放哪個類別分頁
function sheetNameForExpense(e) {
  const t = ((e.desc || '') + (e.category || ''));
  if (/住宿|酒店|旅館|旅馆|飯店|饭店|民宿|房費|房费/.test(t)) return '住宿';
  if (/高鐵|高铁|火車|火车/.test(t)) return '大陸高鐵';
  if (/計程車|出租車|出租车|接送|機場交通|机场交通|打的|滴滴/.test(t)) return '機場交通';
  if (/電信|漫遊|通讯|通信|電話|电话|SIM/.test(t)) return '電信';
  if (/機票|机票|航空|航班|飛行|飞行/.test(t)) return '機票';
  return (e.category === '交通') ? '機票' : '機票';
}

function addr(colIdx, row) {
  return XLSX.utils.encode_cell({ c: colIdx - 1, r: row - 1 });
}
function setCell(ws, ref, value, style) {
  XLSX.utils.sheet_add_aoa(ws, [[value]], { origin: ref });
  if (style) {
    const c = ws[ref];
    if (c) c.s = style;
  }
}
function merge(ws, range) {
  if (!ws['!merges']) ws['!merges'] = [];
  ws['!merges'].push(XLSX.utils.decode_range(range));
}

function groupByDay(cat) {
  const map = {};
  state.expenses.forEach(e => {
    if (e.category !== cat || !e.date) return;
    (map[e.date] = map[e.date] || []).push(e);
  });
  return map;
}

function embedImages(ws, exps) {
  const imgs = [];
  exps.forEach((e, i) => {
    if (!e.imgId) return;
    // 非同步無法在此等待；改為先收集，於 export 前補
    imgs.push({ e, idx: i });
  });
  ws.__pendingImgs = imgs;
}

async function embedImagesAsync(ws) {
  const pending = ws.__pendingImgs || [];
  const images = [];
  for (let i = 0; i < pending.length; i++) {
    const { e } = pending[i];
    const blob = await idbGet(e.imgId);
    if (!blob) continue;
    const b64 = await blobToBase64(blob);
    images.push({
      name: 'img' + i,
      data: b64,
      opts: { type: e.imgId && blob.type.includes('png') ? 'png' : 'jpeg', position: { type: 'twoCellAnchor', from: { col: 1, row: 3 + i * 12 }, to: { col: 2, row: 10 + i * 12 } } },
    });
  }
  if (images.length) ws['!images'] = images;
}
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

function buildReportSheet(ws) {
  const r = state.report;
  // 欄寬
  ws['!cols'] = [
    { wch: 9.9 }, { wch: 5.9 }, { wch: 5.9 }, { wch: 5.9 }, { wch: 9.9 },
    { wch: 10.4 }, { wch: 3.1 }, { wch: 7.9 }, { wch: 3.1 }, { wch: 7.9 },
    { wch: 3.1 }, { wch: 7.9 }, { wch: 3.1 }, { wch: 7.9 }, { wch: 3.1 },
    { wch: 8.9 }, { wch: 8.9 },
  ];

  // 公司勾選列
  const coMark = (name) => (r.company === name) ? '■' : '□';
  const line1 = `       ${coMark('三集瑞科技集團')}三集瑞科技集團  ${coMark('塞席爾商三集瑞')}塞席爾商三集瑞  ${coMark('三積瑞科技蘇州')}三積瑞科技蘇州  ${coMark('東莞德泰利電子')}東莞德泰利電子`;
  const line2 = `       ${coMark('TRIO INT.')}TRIO INT.       ${coMark('APEC')}APEC            ${coMark('TRIO Seychelles')}TRIO Seychelles ${coMark('Wonstar')}Wonstar`;
  setCell(ws, 'A1', line1 + '\n' + line2, { font: { sz: 10 }, alignment: { vertical: 'center' } });
  merge(ws, 'A1:O1');

  setCell(ws, 'A2', '出差報告暨旅費核銷明細表', XLSX_STYLE.title);
  merge(ws, 'A2:O2');

  setCell(ws, 'A3', `□國內　■${r.tripType}`, { alignment: { vertical: 'center' } });
  merge(ws, 'A3:E3');
  setCell(ws, 'F3', '填寫日期', { alignment: { horizontal: 'right' } });
  merge(ws, 'F3:G3');
  setDateCell(ws, 'H3', r.fillDate);
  merge(ws, 'H3:O3');
  setCell(ws, 'A4', '出差人員');
  setCell(ws, 'B4', r.person || '', {});
  merge(ws, 'B4:E4');
  setCell(ws, 'F4', '部門名稱');
  merge(ws, 'F4:G4');
  setCell(ws, 'H4', r.dept || '');
  merge(ws, 'H4:O4');

  setCell(ws, 'A5', '出差地區');
  setCell(ws, 'B5', r.region || '');
  merge(ws, 'B5:O5');

  setCell(ws, 'A6', '出差期間');
  setCell(ws, 'B6', '開始日期');
  setDateCell(ws, 'C6', r.start);
  merge(ws, 'C6:D6');
  setCell(ws, 'E6', '結束日期');
  setDateCell(ws, 'F6', r.end);
  merge(ws, 'F6:I6');  setCell(ws, 'J6', '合計天數');
  merge(ws, 'J6:K6');
  const days = computeDaysNum(r.start, r.end);
  setCell(ws, 'L6', days, { alignment: { horizontal: 'center' } });
  merge(ws, 'L6:O6');

  setCell(ws, 'A7', '出差報告', { font: { bold: true } });
  merge(ws, 'A7:O7');
  setCell(ws, 'A8', '出差執行重點：', { font: { bold: true } });
  merge(ws, 'A8:O8');
  setCell(ws, 'A9', r.focus || '', { alignment: { wrapText: true, vertical: 'top' } });
  merge(ws, 'A9:O14');
  setCell(ws, 'A15', '問題整理及建議事項:', { font: { bold: true } });
  merge(ws, 'A15:O15');
  setCell(ws, 'A16', r.issue || '', { alignment: { wrapText: true, vertical: 'top' } });
  merge(ws, 'A16:O25');

  // ---- 旅費核銷明細 ----
  setCell(ws, 'A26', '旅費核銷明細', { font: { bold: true } });
  merge(ws, 'A26:O26');
  const heads = ['開始日期', '結束日期', '消費方式', '幣別', '適用匯率', '交通費', '', '膳食費', '', '住宿費', '', '其他費用', '', '本幣合計', '', '說明', '憑証編號'];
  heads.forEach((h, i) => {
    if (h) setCell(ws, addr(i + 1, 27), h, XLSX_STYLE.header);
  });
  merge(ws, 'F27:G27'); merge(ws, 'H27:I27'); merge(ws, 'J27:K27'); merge(ws, 'L27:M27'); merge(ws, 'N27:O27');

  // 資料列
  const rows = state.expenses;
  let rIdx = 28;
  rows.forEach(e => {
    writeExpenseRow(ws, rIdx, e);
    rIdx++;
  });
  // 膳食超限扣回列
  const overRows = mealOverLimitRows();
  overRows.forEach(o => {
    writeOverLimitRow(ws, rIdx, o);
    rIdx++;
  });

  // 旅費總計區
  const sumStart = 28, sumEnd = rIdx - 1;
  writeTotalSection(ws, rIdx, sumStart, sumEnd);
}

function computeDaysNum(s, e) {
  if (!s || !e) return '';
  const d1 = new Date(s), d2 = new Date(e);
  const days = Math.round((d2 - d1) / 86400000) + 1;
  return days > 0 ? days : '';
}
// 將 'YYYY-MM-DD' 轉為 Excel 日期序號
function dateSerial(str) {
  if (!str) return null;
  const [y, m, d] = String(str).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}
function setDateCell(ws, ref, str) {
  const serial = dateSerial(str);
  if (serial == null) { setCell(ws, ref, '', XLSX_STYLE.center); return; }
  setCell(ws, ref, serial, { numFmt: 'yyyy/mm/dd', alignment: { horizontal: 'center', vertical: 'center' }, border: thinBorder() });
}

function writeExpenseRow(ws, rIdx, e) {
  const local = localTotalOf(e);
  const fi = catToIndex(e.category);
  setDateCell(ws, addr(1, rIdx), e.date);
  setDateCell(ws, addr(2, rIdx), e.date);
  setCell(ws, addr(3, rIdx), e.trans || '現金', XLSX_STYLE.center);
  setCell(ws, addr(4, rIdx), e.currency, XLSX_STYLE.center);
  setCell(ws, addr(5, rIdx), num(e.rate || getRate(e.currency)), { numFmt: '0.0000', alignment: { horizontal: 'center' } });
  const fees = [0, 0, 0, 0];
  fees[fi] = num(e.amount);
  setCell(ws, addr(6, rIdx), fees[0] ? fees[0] : '', { numFmt: '0.00', alignment: { horizontal: 'right' } });
  setCell(ws, addr(7, rIdx), fees[0] ? '元' : '');
  setCell(ws, addr(8, rIdx), fees[1] ? fees[1] : '', { numFmt: '0.00', alignment: { horizontal: 'right' } });
  setCell(ws, addr(9, rIdx), fees[1] ? '元' : '');
  setCell(ws, addr(10, rIdx), fees[2] ? fees[2] : '', { numFmt: '0.00', alignment: { horizontal: 'right' } });
  setCell(ws, addr(11, rIdx), fees[2] ? '元' : '');
  setCell(ws, addr(12, rIdx), fees[3] ? fees[3] : '', { numFmt: '0.00', alignment: { horizontal: 'right' } });
  setCell(ws, addr(13, rIdx), fees[3] ? '元' : '');
  setCell(ws, addr(14, rIdx), local, { numFmt: '0.00', alignment: { horizontal: 'right' } });
  setCell(ws, addr(15, rIdx), '元');
  setCell(ws, addr(16, rIdx), e.desc || '', {});
  setCell(ws, addr(17, rIdx), e.receiptNo || '', XLSX_STYLE.center);
}

function mealOverLimitRows() {
  const dayMeals = {};
  state.expenses.forEach(e => {
    if (e.category !== '膳食' || !e.date) return;
    dayMeals[e.date] = (dayMeals[e.date] || 0) + localTotalOf(e);
  });
  const out = [];
  Object.entries(dayMeals).forEach(([d, t]) => {
    const limit = num(state.dailyLimit);
    if (t > limit) out.push({ date: d, excess: t - limit, limit });
  });
  return out;
}

function writeOverLimitRow(ws, rIdx, o) {
  setDateCell(ws, addr(1, rIdx), o.date);
  setDateCell(ws, addr(2, rIdx), o.date);
  setCell(ws, addr(3, rIdx), '現金', XLSX_STYLE.center);
  setCell(ws, addr(4, rIdx), 'NTD', XLSX_STYLE.center);
  setCell(ws, addr(5, rIdx), 1, { numFmt: '0.0000', alignment: { horizontal: 'center' } });
  setCell(ws, addr(14, rIdx), -o.excess, { numFmt: '0.00', alignment: { horizontal: 'right' } });
  setCell(ws, addr(15, rIdx), '元');
  setCell(ws, addr(16, rIdx), `膳食超限(每日${fmt(o.limit)}元)`, {});
}

function writeTotalSection(ws, rIdx, sumStart, sumEnd) {
  // 檢附憑證 / 旅費總計
  const totalRow = rIdx + 1; // 留一空白列
  const cur = [];
  state.rates.forEach(r => cur.push(r.code));
  const byCur = {};
  cur.forEach(c => byCur[c] = 0);
  state.expenses.forEach(e => { byCur[e.currency] = (byCur[e.currency] || 0) + num(e.amount); });
  const byCurTWD = {};
  state.expenses.forEach(e => { byCurTWD[e.currency] = (byCurTWD[e.currency] || 0) + localTotalOf(e); });

  const titleR = totalRow;
  setCell(ws, addr(1, titleR), '檢附憑證', { font: { bold: true } });
  setCell(ws, addr(2, titleR), state.expenses.length + ' 張');
  setCell(ws, addr(3, titleR), '旅費總計', { font: { bold: true } });
  setCell(ws, addr(4, titleR), '幣別', XLSX_STYLE.header);
  setCell(ws, addr(6, titleR), '原幣總計', XLSX_STYLE.header);
  setCell(ws, addr(8, titleR), '本幣金額', XLSX_STYLE.header);
  setCell(ws, addr(10, titleR), '備註', XLSX_STYLE.header);

  let rr = titleR + 1;
  Object.keys(byCur).forEach(c => {
    setCell(ws, addr(4, rr), c, XLSX_STYLE.center);
    setCell(ws, addr(6, rr), byCur[c], { numFmt: '0.00', alignment: { horizontal: 'right' } });
    setCell(ws, addr(7, rr), '元');
    const twd = byCurTWD[c] || 0;
    setCell(ws, addr(8, rr), c === 'NTD' ? byCur[c] : twd, { numFmt: '0.00', alignment: { horizontal: 'right' } });
    setCell(ws, addr(9, rr), '元');
    rr++;
  });
  const overRows = mealOverLimitRows();
  const overTotal = overRows.reduce((s, o) => s + o.excess, 0);
  setCell(ws, addr(4, rr), '本幣合計', { font: { bold: true } });
  const totalTWD = state.expenses.reduce((s, e) => s + localTotalOf(e), 0) - overTotal;
  setCell(ws, addr(6, rr), totalTWD, { numFmt: '0.00', alignment: { horizontal: 'right' }, font: { bold: true } });
  setCell(ws, addr(9, rr), '元');

  // 補充說明
  const noteRow = rr + 2;
  setCell(ws, addr(1, noteRow), '補充說明', { font: { bold: true } });
  setCell(ws, addr(2, noteRow), r_note_text(), { alignment: { wrapText: true, vertical: 'top' } });
  merge(ws, `B${noteRow}:O${noteRow}`);
  const useRow = noteRow + 1;
  setCell(ws, addr(1, useRow), '使用備註：', { font: { bold: true } });
  setCell(ws, addr(2, useRow), '1. 淺黃底套公式請勿更改；　2. 日期一律填西元年；　3. 報銷匯率請向會計確認(非出納提供借支匯率)');
  merge(ws, `B${useRow}:O${useRow}`);
}
function r_note_text() {
  const n = state.report.note || '';
  const totalTWD = state.expenses.reduce((s, e) => s + localTotalOf(e), 0);
  const over = mealOverLimitRows();
  const overTotal = over.reduce((s, o) => s + o.excess, 0);
  let t = `報銷請款合計台幣 ${fmt(totalTWD - overTotal)} 元。`;
  if (over.length) t += `（其中膳食每日上限 ${fmt(state.dailyLimit)} 元，超限共 ${fmt(overTotal)} 元已扣回）`;
  if (n) t += '\n' + n;
  return t;
}

async function doExport() {
  const btn = $('#btn-export');
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    await loadXLSX();
    const wb = buildWorkbook();
    // 圖片非同步補入（失敗不影響匯出）
    const wsDay = wb.Sheets;
    for (const name of Object.keys(wsDay)) {
      if (wsDay[name].__pendingImgs) {
        try { await embedImagesAsync(wsDay[name]); } catch (e) { console.warn('圖片嵌入跳過', e); }
      }
    }
    const fname = `出差報告暨旅費核銷_${state.report.person || '報銷'}_${todayStr().replace(/-/g, '')}.xlsx`;
    downloadWorkbook(wb, fname);
    toast('匯出完成，資料仍在本地端');
  } catch (err) {
    toast('匯出失敗：' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '匯出 Excel';
  }
}

function downloadWorkbook(wb, filename) {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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

// 新增自訂類別入口（放在核銷明細工具列）
function ensureCustomCatInput() {
  let bar = $('#cat-filter');
  if ($('#custom-cat-input')) return;
  const wrap = document.createElement('span');
  wrap.style.display = 'inline-flex';
  wrap.style.gap = '4px';
  wrap.innerHTML = `<input id="custom-cat-input" placeholder="新增類別…" style="padding:5px 10px;border:1px solid var(--line);border-radius:20px;font-size:12px;width:110px"><button class="btn" id="custom-cat-add" style="padding:4px 10px;font-size:12px">+</button>`;
  bar.parentNode.appendChild(wrap);
  $('#custom-cat-add').addEventListener('click', () => {
    const v = $('#custom-cat-input').value.trim();
    if (!v) return;
    if (BASE_CATEGORIES.includes(v) || state.customCategories.includes(v)) { toast('類別已存在'); return; }
    state.customCategories.push(v);
    $('#custom-cat-input').value = '';
    saveState();
    renderCatFilter();
    renderExpenses();
    toast('已新增類別「' + v + '」');
  });
  $('#custom-cat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#custom-cat-add').click();
  });
}

// 啟動
bindEvents();
ensureCustomCatInput();
renderAll();
renderUploadStack();
