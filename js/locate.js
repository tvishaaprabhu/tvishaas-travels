// Shared by the import script (Node) and the admin page (browser).
// Dates are local wall-clock strings like "2024-05-03T18:22:10" (no time zone),
// so we parse them as if UTC purely to do arithmetic.

export const HOUR = 3600e3;
export const toMs = (d) => (d ? Date.parse(d + 'Z') : NaN);
export const fromMs = (ms) => new Date(ms).toISOString().slice(0, 19);

export function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Turn exifr output into { date, lat, lng, camera }
export function normaliseExif(exif = {}) {
  const raw = String(exif.DateTimeOriginal || exif.CreateDate || '');
  const m = raw.match(/^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)/);
  const okGps = Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude) && !(exif.latitude === 0 && exif.longitude === 0);
  const make = String(exif.Make || '').trim(), model = String(exif.Model || '').trim();
  const camera = (make && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : `${make} ${model}`).trim();
  return {
    date: m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null,
    lat: okGps ? +exif.latitude.toFixed(5) : null,
    lng: okGps ? +exif.longitude.toFixed(5) : null,
    camera: camera || 'Unknown camera',
  };
}

export const EXIF_PICK = ['DateTimeOriginal', 'CreateDate', 'Make', 'Model'];

// Photos without GPS borrow the location of real-GPS photos taken around the same time.
// `known` = photos that may lend a location; `targets` = photos to fill in (mutated).
export function inferLocations(targets, known, {
  nearestMax = 6 * HOUR,   // nearest geotagged photo within this time
  bracketMax = 36 * HOUR,  // or geotagged photos before & after, at most this far apart...
  samePlaceKm = 50,        // ...taken in the same place
} = {}) {
  const geo = known.filter((p) => p.lat != null && !p.approx && p.date).sort((a, b) => toMs(a.date) - toMs(b.date));
  const times = geo.map((p) => toMs(p.date));
  const unmatched = [];
  let matched = 0;
  for (const p of targets) {
    if (p.lat != null) continue;
    const t = toMs(p.date);
    if (!geo.length || isNaN(t)) { unmatched.push(p); continue; }
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    const before = geo[lo - 1], after = geo[lo];
    const dB = before ? t - times[lo - 1] : Infinity;
    const dA = after ? times[lo] - t : Infinity;
    const nearest = dB <= dA ? before : after;
    let src = null;
    if (before && after && dB + dA <= bracketMax && km(before, after) <= samePlaceKm) src = nearest;
    else if (Math.min(dB, dA) <= nearestMax) src = nearest;
    if (!src) { unmatched.push(p); continue; }
    Object.assign(p, { lat: src.lat, lng: src.lng, approx: true });
    if (!p.place && src.place) { p.place = src.place; p.country = src.country; }
    matched++;
  }
  return { matched, unmatched };
}

// Reuse a place name from an existing photo within `maxKm`, so names stay consistent
export function nearbyPlace(p, photos, maxKm = 8) {
  let best = null, bestD = Infinity;
  for (const q of photos) {
    if (q === p || q.lat == null || !q.place) continue;
    const d = km(p, q);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best && bestD <= maxKm ? { place: best.place, country: best.country } : null;
}

// OpenStreetMap lookups (max 1 request/second per their policy)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function nominatim(url, headers) {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function reverseGeocode(lat, lng, cache = {}, headers = {}) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (cache[key]) return cache[key];
  const j = await nominatim(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lng}`, headers);
  const a = j.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.county || a.state || '';
  return (cache[key] = { place: city || a.country || '', country: a.country || '' });
}

export async function forwardGeocode(query, headers = {}) {
  const j = await nominatim(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=${encodeURIComponent(query)}`, headers);
  return j[0] ? { lat: +(+j[0].lat).toFixed(5), lng: +(+j[0].lon).toFixed(5) } : null;
}

// ---------- duplicate detection ----------
// A "difference hash": a 64-bit fingerprint of what the photo looks like. It survives resizing,
// re-compression and small edits. Input: 72x64 grayscale pixels (array of 0-255), row by row.
export const HASH_W = 72, HASH_H = 64;
export function dhash(gray) {
  const cols = 9, rows = 8, bw = HASH_W / cols, bh = HASH_H / rows;
  const cell = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let y = r * bh; y < (r + 1) * bh; y++) for (let x = c * bw; x < (c + 1) * bw; x++) sum += gray[y * HASH_W + x];
    cell.push(sum / (bw * bh));
  }
  let hex = '';
  for (let r = 0; r < rows; r++) {
    let byte = 0;
    for (let c = 0; c < 8; c++) byte = (byte << 1) | (cell[r * cols + c] > cell[r * cols + c + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
// Same-looking photo taken at the same moment (or with the date missing on one copy)
const aspectOf = (p) => p.aspect || (p.w && p.h ? p.w / p.h : null);
export function looksDuplicate(a, b) {
  if (!a.phash || !b.phash) return false;
  const ra = aspectOf(a), rb = aspectOf(b);
  if (ra && rb && Math.abs(ra - rb) / rb > 0.03) return false; // different shape: not a copy
  const d = hamming(a.phash, b.phash);
  if (!a.date || !b.date) return d <= 3; // one copy lost its date (e.g. sent via WhatsApp): must look near-identical
  return d <= 6 && Math.abs(toMs(a.date) - toMs(b.date)) <= 2000;
}
// Groups of look-alikes; the first photo in each group is the best one to keep
export function duplicateGroups(photos) {
  const score = (p) => (p.lat != null && !p.approx ? 4 : 0) + (p.caption ? 2 : 0) + (p.place ? 1 : 0) + (p.w * p.h) / 1e9;
  const seen = new Set(), groups = [];
  for (const p of photos) {
    if (seen.has(p.id) || !p.phash) continue;
    const g = photos.filter((q) => q === p || (!seen.has(q.id) && looksDuplicate(p, q)));
    if (g.length < 2) continue;
    g.forEach((q) => seen.add(q.id));
    groups.push(g.sort((a, b) => score(b) - score(a)));
  }
  return groups;
}
