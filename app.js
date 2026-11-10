'use strict';
/* 一致性出图画布：纯前端，数据全部存在本机浏览器（IndexedDB）。 */

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- 存储 ---------- */
let idb;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('nuv-canvas', 1);
    r.onupgradeneeded = () => { for (const s of ['kv', 'blobs', 'cards', 'nodes']) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = idb.transaction(store, mode); const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
  });
}
const dbGet = (s, k) => tx(s, 'readonly', o => o.get(k));
const dbPut = (s, k, v) => tx(s, 'readwrite', o => o.put(v, k));
const dbDel = (s, k) => tx(s, 'readwrite', o => o.delete(k));
const dbAll = s => tx(s, 'readonly', o => o.getAll());
const dbKeys = s => tx(s, 'readonly', o => o.getAllKeys());
const dbClear = s => tx(s, 'readwrite', o => o.clear());

const urlCache = new Map();
async function blobURL(id) {
  if (!id) return '';
  if (!urlCache.has(id)) { const b = await dbGet('blobs', id); if (!b) return ''; urlCache.set(id, URL.createObjectURL(b)); }
  return urlCache.get(id);
}
async function saveBlob(blob) { const id = uid(); await dbPut('blobs', id, blob); return id; }

/* ---------- 状态 ---------- */
const SCENES = [
  { id: 'main', name: '电商主图', tpl: '电商主图：干净的纯色或浅灰背景，产品居中、完整展示，柔和的棚拍光，无多余道具，画面中不要出现任何文字和水印。' },
  { id: 'wear', name: '模特上身图', tpl: '模特上身图：参考图中的人物穿着（或使用）参考图中的产品，全身或七分身，姿态自然，简洁的棚拍背景，重点突出产品的上身效果。' },
  { id: 'life', name: '场景种草图', tpl: '场景种草图：真实的生活场景，自然光，生活化抓拍感，人物自然地穿着（或使用）产品，有氛围感，适合社交平台种草。' },
  { id: 'story', name: '视频分镜', tpl: '视频分镜画面：电影感构图。这是同一支视频里的一个镜头，人物、服装、产品、光线和色调必须与其他镜头完全一致。' },
  { id: 'free', name: '自由', tpl: '' },
];
const DEFAULTS = { base: 'https://api.openai.com/v1', key: '', model: 'gpt-image-1', imgField: 'image[]' };
let settings = { ...DEFAULTS };
let view = { x: 80, y: 80, s: 1 };
let cards = [];                 // 资产卡
let nodes = new Map();          // 画布节点
let sel = new Set();            // 选中的节点
let panel = { scene: 'wear', cards: [], extra: [], prompt: '', size: '1024x1536', quality: 'auto', count: '1' };

const world = $('#world'), vp = $('#viewport');
const saveView = debounce(() => dbPut('kv', 'view', view), 300);
const savePanel = debounce(() => dbPut('kv', 'panel', panel), 300);
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------- 画布 ---------- */
function applyView() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
  vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
  vp.style.backgroundSize = `${24 * view.s}px ${24 * view.s}px`;
  $('#zoomPct').textContent = Math.round(view.s * 100) + '%';
  saveView();
}
function zoomAt(sx, sy, f) {
  const s = Math.min(6, Math.max(0.05, view.s * f));
  view.x = sx - (sx - view.x) * (s / view.s); view.y = sy - (sy - view.y) * (s / view.s); view.s = s; applyView();
}
function bbox(list) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const n of list) { a = Math.min(a, n.x); b = Math.min(b, n.y); c = Math.max(c, n.x + (n.w || 200)); d = Math.max(d, n.y + (n.h || 30)); }
  return list.length ? { x: a, y: b, w: c - a, h: d - b } : null;
}
function fit(list = [...nodes.values()]) {
  const bb = bbox(list); if (!bb) { view = { x: 80, y: 80, s: 1 }; return applyView(); }
  const r = vp.getBoundingClientRect(), pad = 60;
  view.s = Math.min(1.5, Math.max(0.05, Math.min((r.width - pad * 2) / bb.w, (r.height - pad * 2) / bb.h)));
  view.x = (r.width - bb.w * view.s) / 2 - bb.x * view.s; view.y = (r.height - bb.h * view.s) / 2 - bb.y * view.s; applyView();
}
const toWorld = (cx, cy) => { const r = vp.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.s, y: (cy - r.top - view.y) / view.s }; };

const nodeEls = new Map();
async function renderNode(n) {
  let e = nodeEls.get(n.id);
  if (!e) { e = h('div', { 'data-id': n.id }); nodeEls.set(n.id, e); world.append(e); }
  e.className = 'node ' + n.type + (n.status ? ' ' + n.status : '') + (sel.has(n.id) ? ' sel' : '');
  e.style.left = n.x + 'px'; e.style.top = n.y + 'px';
  if (n.type === 'label') { e.textContent = n.text; return; }
  e.style.width = n.w + 'px'; e.style.height = n.h + 'px';
  const key = (n.status || '') + '|' + (n.blobId || n.url || '') + '|' + (n.badge || '') + '|' + (n.error || '');
  if (e.dataset.key === key) return;
  e.dataset.key = key; e.textContent = '';
  if (n.status === 'loading') e.append(h('div', { class: 'state' }, '生成中…'));
  else if (n.status === 'error') e.append(h('div', { class: 'state' }, '生成失败：' + n.error));
  else e.append(h('img', { src: n.blobId ? await blobURL(n.blobId) : n.url, draggable: 'false' }));
  if (n.badge) e.append(h('div', { class: 'badge' }, n.badge));
  e.append(h('div', { class: 'rz' }));
}
function saveNode(n) { nodes.set(n.id, n); renderNode(n); refreshEmpty(); return dbPut('nodes', n.id, n); }
function removeNode(id) {
  nodes.delete(id); sel.delete(id); nodeEls.get(id)?.remove(); nodeEls.delete(id); refreshEmpty(); return dbDel('nodes', id);
}
function refreshEmpty() { $('#empty').hidden = nodes.size > 0; }
function setSel(ids) {
  sel = new Set(ids);
  for (const [id, e] of nodeEls) e.classList.toggle('sel', sel.has(id));
  const imgs = selImages();
  $('#selTools').hidden = sel.size === 0;
  $('#selCount').textContent = `已选 ${sel.size} 项`;
  for (const b of $('#selTools').querySelectorAll('button')) {
    const a = b.dataset.act;
    b.hidden = a !== 'del' && (imgs.length === 0 || ((a === 'cmpRef' || a === 'reuse' || a === 'toCard') && imgs.length !== 1));
    if (a === 'cmpRef' || a === 'reuse') b.hidden = b.hidden || !imgs[0]?.meta;
  }
}
const selImages = () => [...sel].map(i => nodes.get(i)).filter(n => n && n.type === 'image' && !n.status);

/* 指针交互：拖空白平移、拖节点移动、右下角缩放、Shift 框选 */
let drag = null;
vp.addEventListener('pointerdown', ev => {
  if (ev.button > 1) return;
  const ne = ev.target.closest('.node'), p = toWorld(ev.clientX, ev.clientY);
  vp.setPointerCapture(ev.pointerId);
  if (ne && ev.button === 0) {
    const id = ne.dataset.id;
    if (ev.shiftKey) setSel(sel.has(id) ? [...sel].filter(i => i !== id) : [...sel, id]);
    else if (!sel.has(id)) setSel([id]);
    if (ev.target.classList.contains('rz')) { const n = nodes.get(id); drag = { kind: 'resize', n, p, w: n.w, h: n.h }; }
    else drag = { kind: 'move', p, start: [...sel].map(i => ({ n: nodes.get(i), x: nodes.get(i).x, y: nodes.get(i).y })) };
  } else if (ev.shiftKey && ev.button === 0) {
    drag = { kind: 'marquee', p, cx: ev.clientX, cy: ev.clientY };
  } else {
    drag = { kind: 'pan', cx: ev.clientX, cy: ev.clientY, vx: view.x, vy: view.y, moved: false };
    vp.classList.add('panning');
  }
});
vp.addEventListener('pointermove', ev => {
  if (!drag) return;
  const p = toWorld(ev.clientX, ev.clientY);
  if (drag.kind === 'pan') {
    const dx = ev.clientX - drag.cx, dy = ev.clientY - drag.cy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.vx + dx; view.y = drag.vy + dy; applyView();
  } else if (drag.kind === 'move') {
    for (const s of drag.start) { s.n.x = s.x + p.x - drag.p.x; s.n.y = s.y + p.y - drag.p.y; renderNode(s.n); }
    drag.moved = true;
  } else if (drag.kind === 'resize') {
    const w = Math.max(60, drag.w + p.x - drag.p.x); drag.n.h = w * drag.h / drag.w; drag.n.w = w; renderNode(drag.n);
  } else if (drag.kind === 'marquee') {
    const r = vp.getBoundingClientRect(), m = $('#marquee'); m.hidden = false;
    m.style.left = Math.min(ev.clientX, drag.cx) - r.left + 'px'; m.style.top = Math.min(ev.clientY, drag.cy) - r.top + 'px';
    m.style.width = Math.abs(ev.clientX - drag.cx) + 'px'; m.style.height = Math.abs(ev.clientY - drag.cy) + 'px';
    const x1 = Math.min(p.x, drag.p.x), x2 = Math.max(p.x, drag.p.x), y1 = Math.min(p.y, drag.p.y), y2 = Math.max(p.y, drag.p.y);
    setSel([...nodes.values()].filter(n => n.x < x2 && n.x + (n.w || 100) > x1 && n.y < y2 && n.y + (n.h || 30) > y1).map(n => n.id));
  }
});
vp.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.kind === 'pan' && !drag.moved) setSel([]);
  if (drag.kind === 'move' && drag.moved) for (const s of drag.start) dbPut('nodes', s.n.id, s.n);
  if (drag.kind === 'resize') dbPut('nodes', drag.n.id, drag.n);
  $('#marquee').hidden = true; vp.classList.remove('panning'); drag = null;
});
vp.addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = vp.getBoundingClientRect();
  if (ev.ctrlKey || ev.metaKey) zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.01));
  else { view.x -= ev.deltaX; view.y -= ev.deltaY; applyView(); }
}, { passive: false });
vp.addEventListener('dblclick', ev => {
  const ne = ev.target.closest('.node'); if (!ne) return;
  const n = nodes.get(ne.dataset.id);
  if (n.type === 'label') { const t = prompt('修改备注文字', n.text); if (t) { n.text = t; saveNode(n); } }
  else if (!n.status) openLightbox([n]);
});
const centerZoom = f => { const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, f); };
$('#zoomIn').onclick = () => centerZoom(1.25);
$('#zoomOut').onclick = () => centerZoom(0.8);
$('#zoomFit').onclick = () => fit();
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') { $('#lightbox').hidden = true; if (!$('#modal').hidden) closeModal(); return; }
  if (/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName) || !$('#modal').hidden) return;
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel.size) deleteSelected();
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'a') { ev.preventDefault(); setSel([...nodes.keys()]); }
});

/* 把图片放上画布 */
function imgSize(blob) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = rej; i.src = URL.createObjectURL(blob); });
}
async function addImageFiles(files, at) {
  let x = at.x, ids = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const d = await imgSize(f), w = 320, n = { id: uid(), type: 'image', x, y: at.y, w, h: w * d.h / d.w, blobId: await saveBlob(f) };
    await saveNode(n); ids.push(n.id); x += w + 20;
  }
  if (ids.length) setSel(ids);
}
const viewCenter = () => { const r = vp.getBoundingClientRect(); return toWorld(r.left + r.width / 2 - 160, r.top + r.height / 2 - 160); };
vp.addEventListener('dragover', ev => ev.preventDefault());
vp.addEventListener('drop', ev => { ev.preventDefault(); addImageFiles([...ev.dataTransfer.files], toWorld(ev.clientX, ev.clientY)); });
document.addEventListener('paste', ev => {
  if (/INPUT|TEXTAREA/.test(ev.target.tagName)) return;
  const fs = [...ev.clipboardData.files]; if (fs.length) addImageFiles(fs, viewCenter());
});
let filePickCb = null;
function pickFiles(cb) { filePickCb = cb; $('#filePick').value = ''; $('#filePick').click(); }
$('#filePick').onchange = ev => filePickCb && filePickCb([...ev.target.files]);
$('#btnUpload').onclick = () => pickFiles(fs => addImageFiles(fs, viewCenter()));
$('#btnNote').onclick = () => {
  const t = prompt('备注文字'); if (!t) return;
  const c = viewCenter(); saveNode({ id: uid(), type: 'label', x: c.x, y: c.y, text: t });
};

/* ---------- 选中图片后的操作 ---------- */
async function deleteSelected() {
  const n = sel.size; if (n > 3 && !confirm(`确定删除这 ${n} 项吗？`)) return;
  for (const id of [...sel]) await removeNode(id);
  setSel([]);
}
$('#selTools').addEventListener('click', async ev => {
  const act = ev.target.dataset.act; if (!act) return;
  const imgs = selImages();
  if (act === 'del') return deleteSelected();
  if (act === 'view') return openLightbox(imgs);
  if (act === 'cmpRef') return openLightbox(imgs, true);
  if (act === 'asRef') {
    for (const n of imgs) if (n.blobId && !panel.extra.includes(n.blobId)) panel.extra.push(n.blobId);
    renderPanel(); return toast('已加入右侧“额外参考图”');
  }
  if (act === 'reuse') {
    const m = imgs[0].meta;
    Object.assign(panel, { scene: m.scene, prompt: m.userPrompt, size: m.size, quality: m.quality, extra: [...(m.extra || [])],
      cards: (m.cards || []).map(c => c.id).filter(id => cards.some(k => k.id === id)) });
    renderPanel(); renderCards(); return toast('已把这张图的参数填回右侧，可直接再生成');
  }
  if (act === 'toCard') return pickCardFor(imgs[0]);
  if (act === 'download') {
    for (const [i, n] of imgs.entries()) {
      const a = h('a', { href: n.blobId ? await blobURL(n.blobId) : n.url, download: `出图-${(n.badge || '') + (i + 1)}.png` });
      document.body.append(a); a.click(); a.remove();
    }
  }
});

async function openLightbox(imgs, withRefs) {
  if (!imgs.length) return;
  const row = h('div', { class: 'lbRow' });
  if (withRefs) {
    const m = imgs[0].meta || {};
    for (const c of m.cards || []) for (const b of c.imageIds || []) {
      const u = await blobURL(b); if (u) row.append(h('figure', { class: 'ref' }, h('img', { src: u }), h('figcaption', {}, `参考 · ${c.name} v${c.version}`)));
    }
    for (const b of m.extra || []) { const u = await blobURL(b); if (u) row.append(h('figure', { class: 'ref' }, h('img', { src: u }), h('figcaption', {}, '额外参考图'))); }
  }
  for (const n of imgs) {
    const cap = [n.badge, n.meta && SCENES.find(s => s.id === n.meta.scene)?.name, n.meta && (n.meta.cards || []).map(c => `${c.name} v${c.version}`).join(' + ')].filter(Boolean).join(' · ');
    row.append(h('figure', {}, h('img', { src: n.blobId ? await blobURL(n.blobId) : n.url }), h('figcaption', {}, cap || '图片')));
  }
  const lb = $('#lightbox'); lb.textContent = '';
  lb.append(h('div', { class: 'lbTop' }, h('span', {}, withRefs ? '左侧黄色标注为参考图，右侧为出图' : `共 ${imgs.length} 张`), h('button', { onclick: () => (lb.hidden = true) }, '关闭 (Esc)')), row);
  if (imgs.length === 1 && imgs[0].meta) lb.append(h('pre', { class: 'meta' }, `模型：${imgs[0].meta.model}　尺寸：${imgs[0].meta.size}　时间：${new Date(imgs[0].meta.time).toLocaleString()}\n\n${imgs[0].meta.fullPrompt}`));
  lb.hidden = false;
}

/* ---------- 弹窗 ---------- */
function openModal(...kids) { const b = $('#modalBox'); b.textContent = ''; b.append(...kids); $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('pointerdown', ev => { if (ev.target.id === 'modal') closeModal(); });

/* ---------- 资产卡 ---------- */
const KIND = { product: '产品卡', person: '人物卡' };
async function renderCards() {
  for (const kind of ['product', 'person']) {
    const box = $('#cards-' + kind); box.textContent = '';
    const list = cards.filter(c => c.kind === kind);
    if (!list.length) box.append(h('div', { class: 'emptyCards' }, kind === 'product' ? '还没有产品卡。上传产品的多角度图，出图时锁住款式和细节。' : '还没有人物卡。上传模特的正脸、侧脸、全身图，出图时锁住同一张脸。'));
    for (const c of list) {
      const u = await blobURL(c.imageIds[0]);
      box.append(h('div', { class: 'card' + (panel.cards.includes(c.id) ? ' on' : ''), onclick: () => toggleCard(c.id) },
        u ? h('img', { src: u }) : h('div', { class: 'ph' }),
        h('div', { class: 'info' }, h('div', { class: 'name' }, c.name), h('div', { class: 'sub' }, `v${c.version} · ${c.imageIds.length} 张图${c.tag ? ' · ' + c.tag : ''}`)),
        h('button', { class: 'edit', title: '编辑', onclick: ev => { ev.stopPropagation(); editCard(c); } }, '✎')));
    }
  }
}
function toggleCard(id) {
  panel.cards = panel.cards.includes(id) ? panel.cards.filter(i => i !== id) : [...panel.cards, id];
  renderCards(); renderPanel();
}
function editCard(card, presetBlobId) {
  const isNew = !card.id;
  const c = { name: '', tag: '', desc: '', imageIds: [], version: 0, ...card, imageIds: [...(card.imageIds || [])] };
  if (presetBlobId) c.imageIds.push(presetBlobId);
  const P = c.kind === 'product';
  const name = h('input', { type: 'text', value: c.name, placeholder: P ? '例如：米白色亚麻衬衫' : '例如：模特小林' });
  const tag = P ? h('input', { type: 'text', value: c.tag, placeholder: '例如：服装 / 上衣' })
    : h('select', {}, ...['真人模特', '虚拟模特'].map(t => h('option', { selected: c.tag === t }, t)));
  const desc = h('textarea', { rows: '4', placeholder: P ? '写下绝对不能变的地方，例如：米白色、亚麻面料、左胸有小刺绣 logo、木质纽扣 5 颗、宽松版型' : '写下固定特征，例如：25 岁亚洲女性、黑色及肩直发、鹅蛋脸、身高 170、偏瘦' });
  desc.value = c.desc;
  const tiles = h('div', { class: 'tiles' });
  async function drawTiles() {
    tiles.textContent = '';
    for (const id of c.imageIds) tiles.append(h('div', { class: 'tile' }, h('img', { src: await blobURL(id) }),
      h('div', { class: 'x', onclick: () => { c.imageIds = c.imageIds.filter(i => i !== id); drawTiles(); } }, '×')));
    tiles.append(h('div', { class: 'tile add', onclick: () => pickFiles(async fs => { for (const f of fs) c.imageIds.push(await saveBlob(f)); drawTiles(); }) }, '＋添加图片'));
  }
  drawTiles();
  const save = async () => {
    if (!name.value.trim()) return toast('请先填名称');
    if (!c.imageIds.length) return toast('请至少放一张参考图');
    Object.assign(c, { id: c.id || uid(), name: name.value.trim(), tag: tag.value.trim(), desc: desc.value.trim(), version: c.version + 1, updatedAt: Date.now() });
    await dbPut('cards', c.id, c);
    cards = cards.filter(k => k.id !== c.id).concat(c);
    if (isNew && !panel.cards.includes(c.id)) panel.cards.push(c.id);
    closeModal(); renderCards(); renderPanel(); toast(`已保存「${c.name}」v${c.version}`);
  };
  const del = async () => {
    if (!confirm(`删除「${c.name}」？已生成的图片不受影响。`)) return;
    await dbDel('cards', c.id); cards = cards.filter(k => k.id !== c.id); panel.cards = panel.cards.filter(i => i !== c.id);
    closeModal(); renderCards(); renderPanel();
  };
  openModal(
    h('h2', {}, (isNew ? '新建' : '编辑') + KIND[c.kind] + (isNew ? '' : `（当前 v${c.version}）`)),
    h('label', {}, '名称'), name,
    h('label', {}, P ? '品类' : '类型'), tag,
    h('label', {}, P ? '参考图（建议 2–4 张：正面、背面、细节，白底最好）' : '参考图（建议 2–4 张：正脸、侧脸、全身）'), tiles,
    h('label', {}, P ? '锁定要点' : '人物特征'), desc,
    h('div', { class: 'note' }, '每次保存版本号 +1。出的每张图都会记下用的是哪张卡的哪个版本，方便回查。前 4 张图会作为参考图发给模型。'),
    h('div', { class: 'actions' }, isNew ? null : h('button', { class: 'danger', onclick: del }, '删除此卡'), h('div', { class: 'spacer' }),
      h('button', { onclick: closeModal }, '取消'), h('button', { class: 'primary', onclick: save }, '保存')));
}
$('#library').addEventListener('click', ev => { const k = ev.target.dataset.new; if (k) editCard({ kind: k }); });
function pickCardFor(n) {
  openModal(h('h2', {}, '把这张图存入资产卡'), h('div', { class: 'dim' }, '例如：生成了满意的虚拟模特，存成人物卡，以后每次都引用它。'),
    h('button', { class: 'pick', onclick: () => editCard({ kind: 'person', tag: '虚拟模特' }, n.blobId) }, '＋ 新建人物卡'),
    h('button', { class: 'pick', onclick: () => editCard({ kind: 'product' }, n.blobId) }, '＋ 新建产品卡'),
    ...cards.map(c => h('button', { class: 'pick', onclick: () => editCard(c, n.blobId) }, `加入「${c.name}」（${KIND[c.kind]}）`)),
    h('div', { class: 'actions' }, h('div', { class: 'spacer' }), h('button', { onclick: closeModal }, '取消')));
}

/* ---------- 出图面板 ---------- */
const MAX_PER_CARD = 4;
async function renderPanel() {
  const sc = $('#scenes'); sc.textContent = '';
  for (const s of SCENES) sc.append(h('div', { class: 'chip' + (panel.scene === s.id ? ' on' : ''), onclick: () => { panel.scene = s.id; if (s.id === 'story') panel.size = '1536x1024'; renderPanel(); } }, s.name));
  const rc = $('#refCards'); rc.textContent = '';
  const chosen = panel.cards.map(id => cards.find(c => c.id === id)).filter(Boolean);
  if (!chosen.length) rc.append(h('div', { class: 'dim' }, '未引用。在左侧点击卡片即可引用。'));
  for (const c of chosen) rc.append(h('div', { class: 'refitem' }, h('img', { src: await blobURL(c.imageIds[0]) }), h('span', {}, `${c.name} v${c.version}`), h('span', { class: 'dim' }, KIND[c.kind]), h('span', { class: 'x', onclick: () => toggleCard(c.id) }, '×')));
  const ex = $('#extraRefs'); ex.textContent = '';
  if (!panel.extra.length) ex.append(h('div', { class: 'dim' }, '无'));
  for (const b of panel.extra) ex.append(h('div', { class: 'thumb' }, h('img', { src: await blobURL(b) }), h('div', { class: 'x', onclick: () => { panel.extra = panel.extra.filter(i => i !== b); renderPanel(); } }, '×')));
  const story = panel.scene === 'story';
  $('#promptLabel').textContent = story ? '分镜脚本（每行一个镜头，每行出一张）' : '画面描述（可留空）';
  $('#prompt').placeholder = story ? '镜头一：女孩推开咖啡店的门，全景\n镜头二：她在窗边坐下，中景\n镜头三：手拿咖啡杯特写' : '例如：站在海边木栈道上，回头微笑，傍晚暖光';
  $('#countLabel').textContent = story ? '每镜张数' : '张数';
  if ($('#prompt').value !== panel.prompt) $('#prompt').value = panel.prompt;
  $('#size').value = panel.size; $('#quality').value = panel.quality; $('#count').value = panel.count;
  $('#promptPreview').textContent = buildJob().shots.map(s => s.prompt).join('\n\n———\n\n');
  savePanel();
}
$('#prompt').oninput = ev => { panel.prompt = ev.target.value; $('#promptPreview').textContent = buildJob().shots.map(s => s.prompt).join('\n\n———\n\n'); savePanel(); };
for (const k of ['size', 'quality', 'count']) $('#' + k).onchange = ev => { panel[k] = ev.target.value; savePanel(); };

/* 把场景模板 + 资产卡锁定要点 + 用户描述拼成最终提示词 */
function buildJob() {
  const chosen = panel.cards.map(id => cards.find(c => c.id === id)).filter(Boolean);
  const scene = SCENES.find(s => s.id === panel.scene) || SCENES[0];
  const refs = [], lines = [];
  let idx = 1;
  for (const c of chosen) {
    const ids = c.imageIds.slice(0, MAX_PER_CARD), from = idx; idx += ids.length; refs.push(...ids);
    const range = ids.length > 1 ? `第 ${from}–${idx - 1} 张` : `第 ${from} 张`;
    lines.push(c.kind === 'product'
      ? `【产品一致性】参考图${range}是产品「${c.name}」。必须严格还原它的款式、版型、颜色、面料质感、图案以及 logo 的位置和细节，不得增加、删减或改动任何设计元素。${c.desc ? '锁定要点：' + c.desc + '。' : ''}`
      : `【人物一致性】参考图${range}是人物「${c.name}」。必须是同一个人：保持相同的脸型、五官、发型、肤色和身材比例，不得换脸，不得改变年龄感。${c.desc ? '人物特征：' + c.desc + '。' : ''}`);
  }
  if (panel.extra.length) { lines.push(`【额外参考】参考图第 ${idx}${panel.extra.length > 1 ? '–' + (idx + panel.extra.length - 1) : ''} 张用于参考整体风格、构图和光线。`); refs.push(...panel.extra); }
  const mk = t => [scene.tpl, ...lines, t ? '【画面】' + t : '', '照片级真实感，细节清晰。'].filter(Boolean).join('\n');
  const text = panel.prompt.trim();
  const shots = panel.scene === 'story'
    ? (text.split('\n').map(s => s.trim()).filter(Boolean)).map((t, i) => ({ prompt: mk(t), badge: '镜头 ' + (i + 1), user: t }))
    : [{ prompt: mk(text), badge: '', user: text }];
  if (!shots.length) shots.push({ prompt: mk(''), badge: '镜头 1', user: '' });
  return { scene, shots, refs: refs.slice(0, 16), cards: chosen.map(c => ({ id: c.id, name: c.name, version: c.version, kind: c.kind, imageIds: c.imageIds.slice(0, MAX_PER_CARD) })) };
}

/* 参考图统一缩到最长边 2048 的 PNG 再上传，避免过大 */
async function refFile(blobId, i) {
  const blob = await dbGet('blobs', blobId); if (!blob) return null;
  const bmp = await createImageBitmap(blob), k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const cv = h('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  const out = await new Promise(r => cv.toBlob(r, 'image/png'));
  return new File([out], `ref${i + 1}.png`, { type: 'image/png' });
}
function b64Blob(b64, type = 'image/png') {
  const bin = atob(b64), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type });
}
async function callApi(prompt, files, n, size, quality) {
  const base = settings.base.trim().replace(/\/+$/, ''), auth = { Authorization: 'Bearer ' + settings.key.trim() };
  let res;
  if (files.length) {
    const fd = new FormData(); fd.append('model', settings.model.trim()); fd.append('prompt', prompt);
    for (const f of files) fd.append(settings.imgField || 'image[]', f);
    if (n > 1) fd.append('n', n); if (size !== 'auto') fd.append('size', size); if (quality !== 'auto') fd.append('quality', quality);
    res = await fetch(base + '/images/edits', { method: 'POST', headers: auth, body: fd });
  } else {
    const body = { model: settings.model.trim(), prompt, n }; if (size !== 'auto') body.size = size; if (quality !== 'auto') body.quality = quality;
    res = await fetch(base + '/images/generations', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  const txt = await res.text(); let j; try { j = JSON.parse(txt); } catch { j = null; }
  if (!res.ok) throw new Error((j && (j.error?.message || j.message)) || `HTTP ${res.status} ${txt.slice(0, 200)}`);
  const out = [];
  for (const d of (j && j.data) || []) {
    if (d.b64_json) out.push({ blob: b64Blob(d.b64_json) });
    else if (d.url) { try { out.push({ blob: await (await fetch(d.url)).blob() }); } catch { out.push({ url: d.url }); } }
  }
  if (!out.length) throw new Error('接口没有返回图片');
  return out;
}
function explain(e) {
  const m = String(e.message || e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '连不上接口。请检查接口地址和网络；如果是第三方中转，可能不允许从浏览器直接调用。';
  return m;
}

let running = 0;
async function generate() {
  if (!settings.key.trim()) { toast('请先填写 API Key'); return openSettings(); }
  const job = buildJob(), n = +panel.count, size = panel.size, quality = panel.quality;
  const [sw, sh] = size === 'auto' ? [1, 1] : size.split('x').map(Number), W = 320, H = W * sh / sw, GAP = 20;
  const bb = bbox([...nodes.values()]), ox = bb ? bb.x : 0, oy = bb ? bb.y + bb.h + 110 : 0;
  const time = Date.now(), batch = uid();
  const title = `${new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${job.scene.name}${job.cards.length ? ' · ' + job.cards.map(c => `${c.name} v${c.version}`).join(' + ') : ''}`;
  const made = [{ id: uid(), type: 'label', x: ox, y: oy - 44, text: title }];
  await saveNode(made[0]);
  const groups = [];
  let col = 0;
  for (const shot of job.shots) {
    const ph = [];
    for (let k = 0; k < n; k++) {
      const node = { id: uid(), type: 'image', status: 'loading', x: ox + col++ * (W + GAP), y: oy, w: W, h: H, badge: shot.badge,
        meta: { batch, time, scene: job.scene.id, userPrompt: panel.prompt, fullPrompt: shot.prompt, model: settings.model, size, quality, cards: job.cards, extra: [...panel.extra] } };
      await saveNode(node); ph.push(node); made.push(node);
    }
    groups.push({ shot, ph });
  }
  fit(made);
  running++; updateGenMsg();
  try {
    const files = (await Promise.all(job.refs.map(refFile))).filter(Boolean);
    await Promise.all(groups.map(async ({ shot, ph }) => {
      try {
        const imgs = await callApi(shot.prompt, files, n, size, quality);
        for (const [i, node] of ph.entries()) {
          const r = imgs[i]; if (!r) { await removeNode(node.id); continue; }
          delete node.status;
          if (r.blob) { node.blobId = await saveBlob(r.blob); const d = await imgSize(r.blob); node.h = node.w * d.h / d.w; } else node.url = r.url;
          await saveNode(node);
        }
      } catch (e) { for (const node of ph) { node.status = 'error'; node.error = explain(e); await saveNode(node); } }
    }));
  } catch (e) { toast('出错：' + explain(e), 5000); }
  running--; updateGenMsg();
}
function updateGenMsg() { $('#genMsg').textContent = running ? `正在生成（${running} 批进行中），一张图通常需要 30–90 秒，可以继续操作画布。` : ''; }
$('#btnGen').onclick = generate;

/* ---------- 设置 ---------- */
function openSettings() {
  const f = {};
  const field = (k, label, type = 'text', ph = '') => [h('label', {}, label), f[k] = h('input', { type, value: settings[k], placeholder: ph, autocomplete: 'off' })];
  const msg = h('span', { class: 'dim' });
  const read = () => { for (const k in f) settings[k] = f[k].value.trim(); };
  const test = async () => {
    read(); msg.textContent = '测试中…';
    try {
      const r = await fetch(settings.base.replace(/\/+$/, '') + '/models', { headers: { Authorization: 'Bearer ' + settings.key } });
      msg.textContent = r.ok ? '✅ 连接成功' : r.status === 401 ? '❌ Key 无效（401）' : `⚠️ 接口返回 ${r.status}，不一定影响出图`;
    } catch (e) { msg.textContent = '❌ ' + explain(e); }
  };
  openModal(h('h2', {}, 'API 设置'),
    ...field('base', '接口地址', 'text', DEFAULTS.base), ...field('key', 'API Key', 'password', 'sk-...'), ...field('model', '模型名称', 'text', DEFAULTS.model),
    h('details', {}, h('summary', {}, '高级'), ...field('imgField', '参考图字段名（个别中转站需要改成 image）', 'text', 'image[]')),
    h('div', { class: 'note' }, '兼容 OpenAI 图像接口（/images/generations 和 /images/edits）的服务都能接。Key 只保存在这台电脑的浏览器里，只会发给你填的接口地址。注意：ChatGPT 会员订阅不含 API 额度，Key 需要在 platform.openai.com 单独开通并充值。'),
    h('div', { class: 'actions' }, h('button', { onclick: test }, '测试连接'), msg, h('div', { class: 'spacer' }), h('button', { onclick: closeModal }, '取消'),
      h('button', { class: 'primary', onclick: async () => { read(); for (const k in DEFAULTS) if (!settings[k] && k !== 'key') settings[k] = DEFAULTS[k]; await dbPut('kv', 'settings', settings); closeModal(); toast('已保存'); } }, '保存')));
}
$('#btnSettings').onclick = openSettings;

/* ---------- 备份 / 恢复 ---------- */
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function exportBackup() {
  toast('正在打包…');
  const blobs = {}; for (const k of await dbKeys('blobs')) blobs[k] = await blobToDataURL(await dbGet('blobs', k));
  const data = { app: 'nuv-canvas', v: 1, cards, nodes: [...nodes.values()], panel, view, blobs };
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: `画布备份-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}
async function importBackup(file) {
  let d; try { d = JSON.parse(await file.text()); } catch { return toast('不是有效的备份文件'); }
  if (d.app !== 'nuv-canvas') return toast('不是有效的备份文件');
  if (!confirm('恢复会覆盖当前画布和资产卡，确定吗？')) return;
  for (const s of ['blobs', 'cards', 'nodes']) await dbClear(s);
  for (const [k, v] of Object.entries(d.blobs)) await dbPut('blobs', k, await (await fetch(v)).blob());
  for (const c of d.cards) await dbPut('cards', c.id, c);
  for (const n of d.nodes) await dbPut('nodes', n.id, n);
  await dbPut('kv', 'panel', d.panel); await dbPut('kv', 'view', d.view);
  location.reload();
}
$('#btnBackup').onclick = () => openModal(h('h2', {}, '备份'),
  h('div', { class: 'note' }, '所有图片和资产卡都存在这台电脑的这个浏览器里。清除浏览器数据或换电脑前，请先导出备份。备份不包含 API Key。'),
  h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => { closeModal(); exportBackup(); } }, '导出备份文件'),
    h('button', { onclick: () => { closeModal(); $('#backupPick').value = ''; $('#backupPick').click(); } }, '从备份恢复'), h('div', { class: 'spacer' }), h('button', { onclick: closeModal }, '关闭')));
$('#backupPick').onchange = ev => ev.target.files[0] && importBackup(ev.target.files[0]);

/* ---------- 启动 ---------- */
(async function init() {
  idb = await openDB();
  settings = { ...DEFAULTS, ...(await dbGet('kv', 'settings') || {}) };
  view = (await dbGet('kv', 'view')) || view;
  panel = { ...panel, ...(await dbGet('kv', 'panel') || {}) };
  cards = (await dbAll('cards')).sort((a, b) => a.updatedAt - b.updatedAt);
  for (const n of await dbAll('nodes')) {
    if (n.status === 'loading') { n.status = 'error'; n.error = '页面在生成完成前被关闭了'; }
    nodes.set(n.id, n); renderNode(n);
  }
  if (navigator.storage?.persist) navigator.storage.persist();
  applyView(); refreshEmpty(); await renderCards(); await renderPanel(); setSel([]);
  window.__ready = true;
})();
