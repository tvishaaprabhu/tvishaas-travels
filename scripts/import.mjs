// Bulk import: adds every new photo in ./photos to the site.
// (For day-to-day uploads, use the admin page instead: /admin.html)
//
//   npm run import            -> add new photos, look up place names online
//   npm run import -- --offline   -> skip the place-name lookup
//
// photos.json is the site's source of truth; this script only ADDS to it and never
// changes photos already there. Camera clock corrections go in scripts/camera-clocks.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import exifr from 'exifr';
import sharp from 'sharp';
import { EXIF_PICK, HOUR, fromMs, toMs, normaliseExif, inferLocations, nearbyPlace, reverseGeocode } from '../js/locate.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const INBOX = path.join(ROOT, 'photos');
const MANIFEST = path.join(ROOT, 'photos.json');
const CLOCKS = path.join(ROOT, 'scripts', 'camera-clocks.json');
const GEOCACHE = path.join(ROOT, 'scripts', '.geocache.json');
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const OFFLINE = process.argv.includes('--offline');
const THUMB_W = 1100, LARGE_W = 2400;

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}
const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };

async function main() {
  await fs.mkdir(path.join(ROOT, 'images/thumbs'), { recursive: true });
  await fs.mkdir(path.join(ROOT, 'images/large'), { recursive: true });
  const existing = await readJson(MANIFEST, []);
  const have = new Set(existing.map((p) => p.id));
  const clocks = await readJson(CLOCKS, {});
  const geocache = await readJson(GEOCACHE, {});
  const files = (await walk(INBOX).catch(() => [])).sort();
  const added = [], skipped = [], failed = [];

  for (const [i, file] of files.entries()) {
    process.stdout.write(`\r${i + 1}/${files.length} ${path.basename(file).slice(-40).padEnd(40)}`);
    const buf = await fs.readFile(file);
    const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    if (have.has(id)) { skipped.push(file); continue; }
    try {
      const thumb = `images/thumbs/${id}.webp`, large = `images/large/${id}.jpg`;
      // sharp drops all metadata (incl. GPS) from the web copies
      const t = await sharp(buf).rotate().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(ROOT, thumb));
      await sharp(buf).rotate().resize({ width: LARGE_W, height: LARGE_W, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(ROOT, large));
      let exif = {};
      try { exif = { ...(await exifr.parse(buf, { reviveValues: false, pick: EXIF_PICK })), ...(await exifr.gps(buf)) }; } catch {}
      const meta = normaliseExif(exif);
      const folder = path.relative(INBOX, path.dirname(file)).split(path.sep)[0] || null;
      added.push({ id, src: path.basename(file), thumb, large, w: t.width, h: t.height, ...meta, place: null, country: null, caption: null, folder });
      have.add(id);
    } catch (e) {
      failed.push(`${file}: ${e.message}`);
    }
  }
  console.log();

  // camera clocks
  const cams = new Map();
  for (const p of added) {
    const c = cams.get(p.camera) || { n: 0, gps: 0 }; c.n++; if (p.lat != null) c.gps++; cams.set(p.camera, c);
    if (!(p.camera in clocks)) clocks[p.camera] = 0;
    const fix = +clocks[p.camera] || 0;
    if (fix && p.date) p.date = fromMs(toMs(p.date) + fix * HOUR);
  }

  // place names for photos with GPS: reuse a nearby existing name, else look it up
  const all = [...existing, ...added];
  for (const p of added) {
    if (p.lat == null) continue;
    const near = nearbyPlace(p, all);
    if (near) { Object.assign(p, near); continue; }
    if (!OFFLINE) {
      try { Object.assign(p, await reverseGeocode(p.lat, p.lng, geocache, { 'User-Agent': 'tvishaas-travels/1.0' })); }
      catch (e) { console.warn(`place lookup failed (${e.message}); rerun later or fix the name on the admin page`); }
    }
  }
  // photos without GPS: borrow location by time
  const inf = inferLocations(added, all);
  for (const p of added) { p.place ||= p.folder; delete p.folder; }

  const out = [...existing, ...added].sort((a, b) => (toMs(a.date) || 0) - (toMs(b.date) || 0));
  await fs.writeFile(MANIFEST, JSON.stringify(out, null, 1));
  await fs.writeFile(CLOCKS, JSON.stringify(clocks, null, 2));
  await fs.writeFile(GEOCACHE, JSON.stringify(geocache));

  console.log(`\nAdded ${added.length} photos (${skipped.length} already on the site${failed.length ? `, ${failed.length} failed` : ''}).`);
  if (cams.size) {
    console.log('\nCameras:');
    for (const [name, c] of cams) console.log(`  ${name.padEnd(30)} ${String(c.n).padStart(5)} photos, ${c.gps} with GPS${clocks[name] ? `, clock fixed by ${clocks[name]}h` : ''}`);
  }
  const noGps = added.filter((p) => p.approx).length + inf.unmatched.length;
  if (noGps) {
    console.log(`\n${noGps} without GPS: ${inf.matched} placed by time, ${inf.unmatched.length} not placed:`);
    for (const p of inf.unmatched.slice(0, 15)) console.log(`  - ${p.src} (${p.date || 'no date'})`);
  }
  for (const f of failed) console.log(`  ! ${f}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
