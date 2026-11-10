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


// Read date/camera/GPS from any photo. `exifr` is passed in (Node and the browser load it differently).
// Some HEIC files store their position table in a way exifr misreads, so if it finds nothing we look
// for the "Exif\0\0" + TIFF block ourselves and read that directly.
export async function readExif(exifr, buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const read = async (data) => ({
    ...((await exifr.parse(data, { reviveValues: false, pick: EXIF_PICK })) || {}),
    ...((await exifr.gps(data)) || {}),
  });
  const useful = (r) => r && (r.DateTimeOriginal || r.CreateDate || Number.isFinite(r.latitude));
  try { const r = await read(u8); if (useful(r)) return r; } catch {}
  for (let i = 0; i < u8.length - 8; i++) {
    if (u8[i] === 0x45 && u8[i + 1] === 0x78 && u8[i + 2] === 0x69 && u8[i + 3] === 0x66 && u8[i + 4] === 0 && u8[i + 5] === 0 &&
        ((u8[i + 6] === 0x4d && u8[i + 7] === 0x4d) || (u8[i + 6] === 0x49 && u8[i + 7] === 0x49))) {
      try { const r = await read(u8.slice(i + 6)); if (useful(r)) return r; } catch {}
    }
  }
  return {};
}
