import exifr from '../vendor/exifr/exifr.mjs';
import { EXIF_PICK, HOUR, toMs, fromMs, normaliseExif, inferLocations, nearbyPlace, reverseGeocode, forwardGeocode, dhash, looksDuplicate, duplicateGroups, HASH_W, HASH_H } from './locate.js';

// ---------- config ----------
// On GitHub Pages (https://<owner>.github.io/<repo>/) the repo is detected automatically.
const FALLBACK = { owner: 'tvishaaprabhu', repo: 'tvishaas-travels' };
const REPO = (() => {
  const h = location.hostname;
  if (h.endsWith('.github.io')) {
    const owner = h.replace('.github.io', '');
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return { owner, repo: seg && !seg.endsWith('.html') ? seg : h };
  }
  return FALLBACK;
})();
const API = 'https://api.github.com';
const THUMB_W = 1100, LARGE_W = 2000;
const TOKEN_KEY = 'travels-admin-token';
const GEO_KEY = 'travels-geocache';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const geocache = (() => { try { return JSON.parse(store.get(GEO_KEY)) || {}; } catch { return {}; } })();
const saveGeocache = () => store.set(GEO_KEY, JSON.stringify(geocache));
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No date');

let token = store.get(TOKEN_KEY);
let branch = 'main';
let manifest = [];  // photos.json as currently published

function toast(msg, bad = false, ms = 4500) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(...(Array.isArray(msg) ? msg : [msg]));
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- GitHub API ----------
async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}
const repoPath = (p) => `/repos/${REPO.owner}/${REPO.repo}${p}`;

async function readManifest(ref) {
  try {
    const res = await fetch(API + repoPath(`/contents/photos.json?ref=${ref}`), {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return await res.json();
  } catch (e) { throw new Error(`Couldn't read photos.json (${e.message})`); }
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const textToB64 = (t) => bytesToB64(new TextEncoder().encode(t));

// One commit: `prepare(manifest)` returns { manifest, files: [{path, b64}], deletes: [path] }.
// Builds on the latest commit, retrying if something else was pushed meanwhile.
async function commit(message, prepare, onProgress = () => {}, blobCache = new Map()) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(repoPath(`/git/ref/heads/${branch}`));
    const head = ref.object.sha;
    const headCommit = await gh(repoPath(`/git/commits/${head}`));
    const current = await readManifest(head);
    const { manifest: next, files = [], deletes = [] } = await prepare(current);

    const tree = [];
    for (const [i, f] of files.entries()) {
      onProgress(`Uploading ${i + 1} of ${files.length}…`);
      if (!blobCache.has(f.path)) blobCache.set(f.path, (await gh(repoPath('/git/blobs'), { method: 'POST', body: JSON.stringify({ content: f.b64, encoding: 'base64' }) })).sha);
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blobCache.get(f.path) });
    }
    const json = JSON.stringify(next, null, 1);
    const mBlob = await gh(repoPath('/git/blobs'), { method: 'POST', body: JSON.stringify({ content: textToB64(json), encoding: 'base64' }) });
    tree.push({ path: 'photos.json', mode: '100644', type: 'blob', sha: mBlob.sha });
    for (const p of deletes) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });

    onProgress('Saving…');
    const newTree = await gh(repoPath('/git/trees'), { method: 'POST', body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
    const newCommit = await gh(repoPath('/git/commits'), { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) });
    try {
      await gh(repoPath(`/git/refs/heads/${branch}`), { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }) });
      manifest = next;
      return;
    } catch (e) {
      if (e.status !== 422 || attempt === 2) throw e; // 422 = someone else pushed first; rebuild on top
    }
  }
}

// ---------- login ----------
async function unlock(t) {
  token = t;
  const info = await gh(repoPath(''));
  if (!info.permissions?.push) throw new Error("This key can't edit the repo. Give it Contents: Read and write.");
  branch = info.default_branch || 'main';
  manifest = await readManifest(branch);
}

async function showApp() {
  $('#login').hidden = true;
  $('#tabs').hidden = false;
  $('#logout').hidden = false;
  showTab(location.hash === '#manage' ? 'manage' : 'add');
}
function showLogin(msg = '') {
  $('#login').hidden = false;
  $('#tabs').hidden = true;
  $('#logout').hidden = true;
  $('#tab-add').hidden = $('#tab-manage').hidden = true;
  $('#login-err').textContent = msg;
  document.querySelectorAll('.repo-name').forEach((e) => (e.textContent = `${REPO.owner}/${REPO.repo}`));
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('#token').value.trim();
  if (!t) return;
  $('#login-err').textContent = 'Checking…';
  try {
    await unlock(t);
    store.set(TOKEN_KEY, t);
    $('#token').value = '';
    showApp();
  } catch (err) {
    $('#login-err').textContent = err.status === 401 ? "That key didn't work. Check it was copied fully and hasn't expired."
      : err.status === 404 ? `Can't see ${REPO.owner}/${REPO.repo}. Make sure the key has access to this repository.` : err.message;
  }
};
$('#logout').onclick = () => { store.del(TOKEN_KEY); token = null; showLogin(); };

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#tab-add').hidden = name !== 'add';
  $('#tab-manage').hidden = name !== 'manage';
  history.replaceState(null, '', name === 'manage' ? '#manage' : '#');
  if (name === 'manage') renderManage();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- images ----------
async function sha1(buf) {
  const h = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Visual fingerprint (see dhash in locate.js) from anything drawable
function hashOf(pic) {
  const c = document.createElement('canvas');
  c.width = HASH_W; c.height = HASH_H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(pic, 0, 0, HASH_W, HASH_H);
  const d = g.getImageData(0, 0, HASH_W, HASH_H).data;
  const gray = new Array(HASH_W * HASH_H);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return dhash(gray);
}
async function fingerprintUrl(url) {
  const pic = new Image(); pic.src = url; await pic.decode();
  return hashOf(pic);
}
// Decode a photo once: small preview for the card (keeps memory low with big batches) + fingerprint
async function analyse(file) {
  const full = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const aspect = full.width / full.height;
  const PW = Math.min(480, full.width), PH = Math.max(1, Math.round(PW / aspect));
  let small = full;
  try { small = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: PW, resizeHeight: PH, resizeQuality: 'high' }); } catch {}
  const c = document.createElement('canvas');
  c.width = PW; c.height = PH;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, PW, PH);
  if (small !== full) small.close?.();
  full.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  return { phash: hashOf(c), aspect, preview: URL.createObjectURL(blob) };
}
const skip = (i) => i.dupe || i.lookalike; // exact copy, or looks like one

// Resize with good quality (halving steps), returns { blob, w, h }. Output has no metadata.
async function resize(file, maxW, maxH, quality) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  const W = Math.round(bmp.width * scale), H = Math.round(bmp.height * scale);
  let src = bmp, sw = bmp.width, sh = bmp.height;
  while (sw / 2 >= W * 1.2) {
    const c = document.createElement('canvas');
    c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    src = c; sw = c.width; sh = c.height;
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, W, H);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return { blob, w: W, h: H };
}

// ---------- add photos ----------
let items = [];          // photos being added
const clockFix = {};     // camera -> hours

$('#files').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files].filter((f) => /^image\/|\.hei[cf]$/i.test(f.type || f.name))); };

async function addFiles(files) {
  if (!files.length) return;
  const known = new Set([...manifest.map((p) => p.id), ...items.map((i) => i.id)]);
  for (const [n, file] of files.entries()) {
    toast(`Reading photo ${n + 1} of ${files.length}…`, false, 0);
    const buf = await file.arrayBuffer();
    const id = await sha1(buf);
    let exif = {};
    try { exif = { ...(await exifr.parse(buf, { reviveValues: false, pick: EXIF_PICK })), ...(await exifr.gps(buf)) }; } catch {}
    const meta = normaliseExif(exif);
    let fp = {};
    try { fp = await analyse(file); } catch {}
    items.push({
      file, id, raw: meta, camera: meta.camera, phash: fp.phash || null, aspect: fp.aspect, preview: fp.preview || URL.createObjectURL(file),
      dupe: known.has(id), place: '', country: '', caption: '', edited: {},
    });
    known.add(id);
  }
  $('#toast').hidden = true;
  await locateAll();
}

// Work out dates (with clock fixes) and locations for everything in the batch
async function locateAll() {
  for (const it of items) {
    const fix = +clockFix[it.camera] || 0;
    it.date = it.raw.date && fix ? fromMs(toMs(it.raw.date) + fix * HOUR) : it.raw.date;
    it.lat = it.raw.lat; it.lng = it.raw.lng; it.approx = false;
    if (!it.edited.place) it.place = '';
    if (!it.edited.country) it.country = '';
  }
  // look-alikes of photos already on the site, or earlier in this batch
  for (const [k, it] of items.entries()) {
    it.lookalike = false;
    if (it.dupe || it.keep) continue;
    const twin = manifest.find((p) => looksDuplicate(it, p)) || items.slice(0, k).find((q) => !skip(q) && looksDuplicate(it, q));
    if (twin) { it.lookalike = true; it.twin = twin.place ? `a photo from ${twin.place}` : twin.file ? twin.file.name : 'a photo on the site'; }
  }
  const live = items.filter((i) => !skip(i));
  // names for photos with GPS: reuse a nearby name first, then look up online
  for (const it of live) {
    if (it.lat == null || it.place) continue;
    const near = nearbyPlace(it, [...manifest, ...live]);
    if (near) { it.place = near.place; it.country = near.country; }
  }
  renderAdd();
  const toLookup = live.filter((i) => i.lat != null && !i.place);
  for (const [n, it] of toLookup.entries()) {
    toast(`Finding place names… ${n + 1}/${toLookup.length}`, false, 0);
    const near = nearbyPlace(it, [...manifest, ...live]);
    try {
      const g = near || (await reverseGeocode(it.lat, it.lng, geocache));
      if (!it.edited.place) it.place = g.place;
      if (!it.edited.country) it.country = g.country;
    } catch { /* leave blank; can be typed in */ }
    renderAdd();
  }
  saveGeocache();
  if (toLookup.length) $('#toast').hidden = true;
  // camera shots: borrow location by time
  const targets = live.filter((i) => i.lat == null);
  const pool = [...manifest, ...live.filter((i) => i.lat != null).map((i) => ({ ...i }))];
  const before = targets.map((t) => [t.place, t.country]);
  inferLocations(targets, pool);
  targets.forEach((t, i) => { if (t.edited.place) t.place = before[i][0]; if (t.edited.country) t.country = before[i][1]; });
  renderAdd();
}

function badgeFor(it) {
  if (it.dupe) return ['dupe', 'Already on the site'];
  if (it.lookalike) return ['dupe', 'Looks like a duplicate'];
  if (it.error) return ['err', it.error];
  if (it.lat != null && !it.approx) return ['gps', 'GPS'];
  if (it.approx) return ['approx', 'Matched by time'];
  if (it.place) return ['approx', 'Placed by name'];
  return ['none', 'No location yet'];
}

function renderAdd() {
  const list = $('#add-list');
  list.innerHTML = '';
  for (const it of items) {
    const card = el('article', 'pc');
    const img = el('div', 'pc-img');
    img.style.backgroundImage = `url("${it.preview}")`;
    const x = el('button', 'pc-x', '×'); x.title = 'Remove';
    x.onclick = () => { items = items.filter((i) => i !== it); URL.revokeObjectURL(it.preview); locateAll(); };
    const badges = el('div', 'pc-badges');
    const [cls, txt] = badgeFor(it);
    badges.append(el('span', `badge ${cls}`, txt));
    img.append(x, badges);
    card.append(img);
    if (it.lookalike) {
      card.classList.add('deleted');
      const body = el('div', 'pc-body');
      body.append(el('p', 'pc-note', `Looks the same as ${it.twin} and was taken at the same moment, so it won't be published.`));
      const keep = el('button', 'btn ghost', 'Keep anyway');
      keep.onclick = () => { it.keep = true; locateAll(); };
      body.append(keep);
      card.append(body);
    } else if (!it.dupe) {
      const body = el('div', 'pc-body');
      body.append(el('div', 'pc-date', `${fmtDate(it.date)} · ${it.camera}`));
      const row = el('div', 'pc-row');
      row.append(input(it, 'place', 'Place'), input(it, 'country', 'Country'));
      body.append(row, input(it, 'caption', 'Caption (optional)'));
      card.append(body);
    }
    list.append(card);
  }
  renderCams();
  const noLoc = items.filter((i) => !skip(i) && i.lat == null && !i.place);
  $('#batch-place').hidden = !noLoc.length;
  $('#bp-count').textContent = `${noLoc.length} photo${noLoc.length === 1 ? ' has' : 's have'} no location.`;
  const n = items.filter((i) => !skip(i)).length;
  const unplaced = items.filter((i) => !skip(i) && i.lat == null && !i.place).length;
  const dupes = items.filter(skip).length;
  $('#add-dock').hidden = !items.length;
  $('#add-summary').textContent = `${n} new photo${n === 1 ? '' : 's'}` + (dupes ? ` · ${dupes} duplicate${dupes === 1 ? '' : 's'} skipped` : '') + (unplaced ? ` · ${unplaced} without a place (still fine)` : '');
  $('#publish').disabled = !n;
  $('#publish').textContent = n ? `Publish ${n}` : 'Publish';
}

function input(obj, key, ph, onChange) {
  const i = el('input');
  i.type = 'text'; i.placeholder = ph; i.value = obj[key] || '';
  i.oninput = () => {
    obj[key] = i.value; obj.edited && (obj.edited[key] = true);
    onChange?.(i);
  };
  return i;
}

function renderCams() {
  const live = items.filter((i) => !skip(i));
  const cams = [...new Set(live.filter((i) => i.raw.lat == null && i.raw.date).map((i) => i.camera))];
  const box = $('#cams');
  box.hidden = !cams.length;
  if (!cams.length) return;
  if (box.dataset.cams === cams.join('|')) return; // don't rebuild while typing
  box.dataset.cams = cams.join('|');
  box.innerHTML = '';
  box.append(el('h3', null, 'Camera clocks'), el('p', null, "Photos without GPS are matched to your phone photos by time. If a camera's clock was wrong (e.g. still on home time), enter how many hours to add or subtract."));
  for (const cam of cams) {
    const row = el('div', 'cam-row');
    const n = live.filter((i) => i.camera === cam).length;
    row.append(el('b', null, cam), el('span', null, `${n} photo${n === 1 ? '' : 's'} · clock fix (hours)`));
    const inp = el('input'); inp.type = 'number'; inp.step = '0.5'; inp.value = clockFix[cam] || 0;
    inp.onchange = () => { clockFix[cam] = +inp.value || 0; locateAll(); };
    row.append(inp);
    box.append(row);
  }
}

$('#batch-place').onsubmit = (e) => {
  e.preventDefault();
  const place = $('#bp-place').value.trim(), country = $('#bp-country').value.trim();
  if (!place && !country) return;
  let n = 0;
  for (const it of items) {
    if (skip(it) || it.lat != null) continue;
    it.place = place || country; it.country = country;
    it.edited.place = it.edited.country = true;
    n++;
  }
  renderAdd();
  toast(`✿ Set ${n} photo${n === 1 ? '' : 's'} to ${[place, country].filter(Boolean).join(', ')}. They'll go on the map there.`, false, 5000);
};

$('#add-clear').onclick = () => { items.forEach((i) => URL.revokeObjectURL(i.preview)); items = []; renderAdd(); };

const CHUNK = 30; // photos per commit: keeps memory low and lets a big upload resume if it stops halfway

$('#publish').onclick = async () => {
  const todo = items.filter((i) => !skip(i));
  if (!todo.length) return;
  const btn = $('#publish');
  btn.disabled = true;
  let added = 0, already = 0;
  try {
    // photos with only a typed-in place: look up coordinates (once per name) so they appear on the map
    const coords = new Map();
    for (const it of todo) {
      if (it.lat != null || !(it.place || it.country)) continue;
      const q = [it.place, it.country].filter(Boolean).join(', ');
      if (!coords.has(q)) {
        toast(`Finding “${q}” on the map…`, false, 0);
        try { coords.set(q, await forwardGeocode(q)); } catch { coords.set(q, null); }
      }
      if (coords.get(q)) Object.assign(it, coords.get(q), { approx: true });
    }
    const kept = new Set(todo.filter((i) => i.keep).map((i) => i.id));
    const clean = (v) => (v == null ? '' : String(v)).trim() || null;

    for (let start = 0; start < todo.length; start += CHUNK) {
      const chunk = todo.slice(start, start + CHUNK);
      const files = [], entries = [];
      for (const [n, it] of chunk.entries()) {
        toast(`Preparing photo ${start + n + 1} of ${todo.length}…`, false, 0);
        let t, l;
        try {
          t = await resize(it.file, THUMB_W, THUMB_W * 3, 0.82);
          l = await resize(it.file, LARGE_W, LARGE_W, 0.85);
        } catch {
          it.error = /hei[cf]/i.test(it.file.name) ? 'HEIC: open this page in Safari, or export as JPEG' : "Couldn't read this image";
          continue;
        }
        const thumb = `images/thumbs/${it.id}.jpg`, large = `images/large/${it.id}.jpg`;
        files.push({ path: thumb, b64: bytesToB64(new Uint8Array(await t.blob.arrayBuffer())) });
        files.push({ path: large, b64: bytesToB64(new Uint8Array(await l.blob.arrayBuffer())) });
        entries.push({
          id: it.id, src: it.file.name, thumb, large, w: t.w, h: t.h, date: it.date,
          lat: it.lat, lng: it.lng, place: clean(it.place), country: clean(it.country),
          caption: clean(it.caption), camera: it.camera, phash: it.phash, ...(it.approx ? { approx: true } : {}),
        });
      }
      if (!entries.length) continue;
      let fresh = [];
      const range = todo.length > CHUNK ? ` (${start + 1}–${Math.min(start + CHUNK, todo.length)} of ${todo.length})` : '';
      await commit(`Add ${entries.length} photo${entries.length === 1 ? '' : 's'}`, (cur) => {
        const ids = new Set(cur.map((p) => p.id));
        // last check in case the same photos were just published from another device
        fresh = entries.filter((e) => !ids.has(e.id) && (kept.has(e.id) || !cur.some((p) => looksDuplicate(e, p))));
        const next = [...cur, ...fresh].sort((a, b) => (toMs(a.date) || 0) - (toMs(b.date) || 0));
        return { manifest: next, files: files.filter((f) => fresh.some((e) => f.path.includes(e.id))) };
      }, (msg) => toast(msg + range, false, 0));
      added += fresh.length; already += entries.length - fresh.length;
      // published: take them off the list, so pressing Publish again only does what's left
      const done = new Set(entries.map((e) => e.id));
      items.filter((i) => done.has(i.id)).forEach((i) => URL.revokeObjectURL(i.preview));
      items = items.filter((i) => !done.has(i.id));
      renderAdd();
    }
    items.filter(skip).forEach((i) => URL.revokeObjectURL(i.preview));
    items = items.filter((i) => !skip(i)); // anything left failed to read
    renderAdd();
    const a = el('a', null, 'View site'); a.href = './'; a.target = '_blank';
    const failed = items.length;
    toast([`✿ Published ${added} photo${added === 1 ? '' : 's'}${already ? ` (${already} were already on the site)` : ''}${failed ? `. ${failed} couldn't be read` : ''}! The site updates in about a minute. `, a], !!failed && !added, 10000);
  } catch (e) {
    toast(`Stopped: ${e.message}. ${added ? `${added} photos were published. ` : ''}Press Publish again to continue with the rest.`, true, 0);
  } finally {
    btn.disabled = false;
  }
};

// ---------- manage ----------
let changes = new Map(); // id -> { place, country, caption, deleted }

let dupView = null; // ids to show while reviewing duplicates, in group order

function renderManage() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#m-list');
  list.innerHTML = '';
  $('#find-dupes').textContent = dupView ? 'Show all photos' : 'Find duplicates';
  const byId = new Map(manifest.map((p) => [p.id, p]));
  const shown = (dupView ? dupView.map((id) => byId.get(id)).filter(Boolean) : manifest.slice().reverse()).filter((p) =>
    !q || [p.place, p.country, p.caption, p.date, fmtDate(p.date)].some((v) => v && String(v).toLowerCase().includes(q)));
  $('#m-count').textContent = `${shown.length} of ${manifest.length} photos`;
  for (const p of shown.slice(0, 300)) list.append(manageCard(p));
  if (shown.length > 300) list.append(el('p', 'muted', 'Showing the first 300. Search to narrow down.'));
  updateManageDock();
}

function manageCard(p) {
  const ch = changes.get(p.id) || {};
  const card = el('article', 'pc' + (ch.deleted ? ' deleted' : ''));
  const img = el('div', 'pc-img');
  img.style.backgroundImage = `url("${p.thumb}")`;
  const x = el('button', 'pc-x', ch.deleted ? '↺' : '×');
  x.title = ch.deleted ? 'Keep this photo' : 'Delete this photo';
  x.onclick = () => {
    const c = changes.get(p.id) || {};
    c.deleted = !c.deleted;
    changes.set(p.id, c);
    card.replaceWith(manageCard(p));
    updateManageDock();
  };
  const badges = el('div', 'pc-badges');
  if (ch.deleted) badges.append(el('span', 'badge err', 'Will be deleted'));
  else if (p.lat == null) badges.append(el('span', 'badge none', 'Not on map'));
  else if (p.approx) badges.append(el('span', 'badge approx', 'Approx. location'));
  img.append(x, badges);
  const body = el('div', 'pc-body');
  body.append(el('div', 'pc-date', fmtDate(p.date)));
  const field = (key, ph) => {
    const view = { [key]: key in ch ? ch[key] : p[key] || '' };
    const i = input(view, key, ph, (inp) => {
      const c = changes.get(p.id) || {};
      if (inp.value === (p[key] || '')) delete c[key]; else c[key] = inp.value;
      changes.set(p.id, c);
      inp.classList.toggle('changed', key in c);
      updateManageDock();
    });
    if (key in ch) i.classList.add('changed');
    return i;
  };
  const row = el('div', 'pc-row');
  row.append(field('place', 'Place'), field('country', 'Country'));
  body.append(row, field('caption', 'Caption'));
  card.append(img, body);
  return card;
}

function pendingChanges() {
  return [...changes].filter(([, c]) => c.deleted || ['place', 'country', 'caption'].some((k) => k in c));
}
function updateManageDock() {
  const pend = pendingChanges();
  const del = pend.filter(([, c]) => c.deleted).length;
  $('#m-dock').hidden = !pend.length;
  $('#m-summary').textContent = [pend.length - del && `${pend.length - del} edited`, del && `${del} to delete`].filter(Boolean).join(' · ');
}

$('#search').oninput = () => renderManage();
$('#find-dupes').onclick = async () => {
  if (dupView) { dupView = null; renderManage(); return; }
  const btn = $('#find-dupes');
  btn.disabled = true;
  try {
    // older photos may not have a fingerprint yet: work it out from their thumbnail
    const missing = manifest.filter((p) => !p.phash);
    for (const [n, p] of missing.entries()) {
      toast(`Checking photos… ${n + 1}/${missing.length}`, false, 0);
      try { p.phash = await fingerprintUrl(p.thumb); } catch {}
    }
    const groups = duplicateGroups(manifest);
    if (!groups.length) { toast('✿ No duplicates found.', false, 5000); return; }
    for (const g of groups) for (const p of g.slice(1)) { const c = changes.get(p.id) || {}; c.deleted = true; changes.set(p.id, c); }
    dupView = groups.flat().map((p) => p.id);
    const extra = dupView.length - groups.length;
    toast(`Found ${groups.length} set${groups.length === 1 ? '' : 's'} of duplicates. ${extra} extra cop${extra === 1 ? 'y is' : 'ies are'} marked for deletion: check, then Save changes.`, false, 9000);
    renderManage();
  } finally { btn.disabled = false; }
};
$('#m-undo').onclick = () => { changes = new Map(); dupView = null; renderManage(); };
$('#m-save').onclick = async () => {
  const pend = new Map(pendingChanges());
  if (!pend.size) return;
  const del = [...pend.values()].filter((c) => c.deleted).length;
  if (del && !confirm(`Delete ${del} photo${del === 1 ? '' : 's'} from the site?`)) return;
  const btn = $('#m-save');
  btn.disabled = true;
  try {
    // renamed photos without real GPS: move their pin to the new place
    const coords = new Map();
    for (const [id, c] of pend) {
      const p = manifest.find((x) => x.id === id);
      if (!p || c.deleted || !('place' in c || 'country' in c)) continue;
      if (p.lat != null && !p.approx) continue;
      const place = 'place' in c ? c.place : p.place, country = 'country' in c ? c.country : p.country;
      if (!place && !country) continue;
      toast(`Finding “${place || country}” on the map…`, false, 0);
      try { const g = await forwardGeocode([place, country].filter(Boolean).join(', ')); if (g) coords.set(id, g); } catch {}
    }
    await commit(`Edit ${pend.size} photo${pend.size === 1 ? '' : 's'}`, (cur) => {
      const deletes = [];
      const next = [];
      for (const p of cur) {
        const c = pend.get(p.id);
        if (!c) { next.push(p); continue; }
        if (c.deleted) { deletes.push(p.thumb, p.large); continue; }
        const q = { ...p };
        for (const k of ['place', 'country', 'caption']) if (k in c) q[k] = String(c[k] ?? '').trim() || null;
        if (coords.has(p.id)) Object.assign(q, coords.get(p.id), { approx: true });
        next.push(q);
      }
      return { manifest: next, deletes };
    }, (m) => toast(m, false, 0));
    changes = new Map();
    dupView = null;
    renderManage();
    toast('✿ Saved! The site updates in about a minute.', false, 7000);
  } catch (e) {
    toast(`Couldn't save: ${e.message}`, true, 9000);
  } finally {
    btn.disabled = false;
  }
};

// ---------- start ----------
(async () => {
  if (!token) return showLogin();
  try { await unlock(token); showApp(); }
  catch (e) { showLogin(e.status === 401 ? 'Your key has expired. Paste a new one.' : e.message); }
})();
