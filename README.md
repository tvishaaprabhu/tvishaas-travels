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
   If some photos have no location (e.g. a digital camera), a pink box asks where they were taken:
   type the country (and optionally a city) once and it applies to all of them.
   Press **Publish**. Big batches go up 30 at a time; if it stops halfway, press Publish again to continue.
   The site updates about a minute later.
3. **Manage**: search, edit place/country/caption, or delete photos, then **Save changes**.

Only someone with a key for this repo can publish; everyone else just sees a login box.
Web copies are resized and have all hidden metadata (including GPS) removed. Only the
location on the map is public.

**iPhone tips**: open the admin page in Safari (it can read HEIC photos). If location is missing,
in the Photos picker tap *Options* → turn on *Location*, or just type the place name.

## Duplicates
Uploading the exact same file again is skipped ("Exact copy, skipped"). Nothing else is treated as a duplicate.

## How locations are worked out
- Photos with GPS: the city/country is looked up on OpenStreetMap (or reused from a nearby photo).
- Photos without GPS (e.g. a digital camera) borrow the location of GPS photos taken around the same time:
  if the GPS photos just before and after are in the same place, or one is within 6 hours.
  Otherwise they stay off the map (still in the grid). Typing a place name puts them on the map.

## Bulk import (big batches, from a computer)
```bash
npm install
# put photos in ./photos (subfolders fine), then:
npm run import
git add -A && git commit -m "Add photos" && git push
```

## Space
GitHub Pages sites can be up to about 1 GB. Each photo takes roughly 0.6 MB (a thumbnail + a 2000px copy),
so there's room for about 1,500 photos.

## Files
- `photos.json`: the list of photos (source of truth; the admin page edits it).
- `images/`: web-sized copies. Originals are never uploaded.
- `index.html`, `css/`, `js/app.js`: the site. `admin.html`, `js/admin.js`: the admin page.
- `js/locate.js`: location matching, shared by the admin page and the import script.

## Hosting (GitHub Pages)
Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`. Every publish from the
admin page is a commit, and Pages redeploys automatically.
