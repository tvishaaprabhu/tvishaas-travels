# Tvishaa's travels

Travel photos in two views:
- **Grid**: endless grid, ordered by **Shuffle** (click again to reshuffle), **By date** or **By place**.
- **Map**: world map with photos as polaroids, clustered by area. Zoom in to split them, click to open.

Live at **https://tvishaaprabhu.github.io/tvishaas-travels/** (once GitHub Pages is on).

## Adding photos: the admin page
Go to **`/admin.html`** on the site (it isn't linked from anywhere).

1. **First time on a device**: unlock it with a GitHub key (instructions are on the page):
   github.com → Settings → Developer settings → Fine-grained tokens → Generate new token →
   only this repository → Repository permissions → **Contents: Read and write**.
   The key is saved on that device only. Press **Lock** to remove it.
2. **Add photos**: drop or pick photos. The page reads date + GPS, names the place,
   matches camera photos without GPS to phone photos by time, and lets you fix names or add captions.
   Press **Publish**. The site updates about a minute later.
3. **Manage**: search, edit place/country/caption, or delete photos, then **Save changes**.

Only someone with a key for this repo can publish; everyone else just sees a login box.
Web copies are resized and have all hidden metadata (including GPS) removed. Only the
location on the map is public.

**iPhone tips**: open the admin page in Safari (it can read HEIC photos). If location is missing,
in the Photos picker tap *Options* → turn on *Location*, or just type the place name.

## Duplicates
- Uploading the exact same file twice: skipped ("Already on the site").
- A copy that *looks* the same and was taken at the same moment (re-saved, resized, sent via WhatsApp, exported twice)
  is marked "Looks like a duplicate" and skipped. Tap **Keep anyway** if it's actually a different shot (e.g. a burst).
- **Manage → Find duplicates** scans the whole site, keeps the best copy of each (real GPS > caption > place),
  marks the rest for deletion, and you confirm with **Save changes**.
- The bulk import skips look-alikes the same way.

## How locations are worked out
- Photos with GPS: the city/country is looked up on OpenStreetMap (or reused from a nearby photo).
- Photos without GPS (e.g. a digital camera) borrow the location of GPS photos taken around the same time:
  if the GPS photos just before and after are in the same place, or one is within 6 hours.
  Otherwise they stay off the map (still in the grid). Typing a place name puts them on the map.
- **Camera clock wrong?** The admin page shows a "clock fix" box per camera when needed.

## Bulk import (big batches, from a computer)
```bash
npm install
# put photos in ./photos (subfolders fine), then:
npm run import
git add -A && git commit -m "Add photos" && git push
```
Camera clock corrections for bulk imports go in `scripts/camera-clocks.json` (hours, e.g. `"Canon PowerShot SX620 HS": -5`).

## Files
- `photos.json`: the list of photos (source of truth; the admin page edits it).
- `images/`: web-sized copies. Originals are never uploaded.
- `index.html`, `css/`, `js/app.js`: the site. `admin.html`, `js/admin.js`: the admin page.
- `js/locate.js`: location matching, shared by the admin page and the import script.

## Hosting (GitHub Pages)
Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`. Every publish from the
admin page is a commit, and Pages redeploys automatically.
