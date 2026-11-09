(() => {
  const $ = (s) => document.querySelector(s);
  const BATCH = 48;

  const state = { photos: [], mode: null, sort: 'shuffle', list: [], gridList: [], rendered: 0, lbList: [], lbIndex: 0 };
  let map = null;
  let shuffled = null;

  // ---------- helpers ----------
  const fmtDate = (iso, opts = { day: 'numeric', month: 'long', year: 'numeric' }) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', opts) : '';
  const placeOf = (p) => [p.place, p.country && p.country !== p.place ? p.country : null].filter(Boolean).join(', ');
  const time = (p) => (p.date ? Date.parse(p.date) : 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function dateRange(items) {
    const ds = items.filter((p) => p.date).map(time).sort((a, b) => a - b);
    if (!ds.length) return '';
    const f = (t) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    const a = f(ds[0]), b = f(ds[ds.length - 1]);
    return a === b ? a : `${a} – ${b}`;
  }

  function renderStats() {
    const ps = state.photos;
    const places = new Set(ps.map((p) => p.place).filter(Boolean)).size;
    const countries = new Set(ps.map((p) => p.country).filter(Boolean)).size;
    const years = ps.filter((p) => p.date).map((p) => +p.date.slice(0, 4));
    const stats = [plural(ps.length, 'photograph')];
    if (places) stats.push(plural(places, 'place'));
    if (countries) stats.push(countries === 1 ? '1 country' : `${countries} countries`);
    if (years.length) {
      const lo = Math.min(...years), hi = Math.max(...years);
      stats.push(lo === hi ? `${lo}` : `${lo} – ${hi}`);
    }
    $('#stats').innerHTML = '';
    if (!ps.length) return;
    for (const s of stats) { const el = document.createElement('span'); el.className = 'stat'; el.textContent = s; $('#stats').append(el); }
  }

  // Returns [{ title, tag, sub, items }] for the current sort
  function buildGroups() {
    const ps = state.photos;
    if (state.sort === 'shuffle') {
      shuffled ||= shuffle(ps);
      return [{ items: shuffled }];
    }
    const groups = new Map();
    const add = (key, p, make) => {
      if (!groups.has(key)) groups.set(key, { key, items: [], ...make() });
      groups.get(key).items.push(p);
    };
    if (state.sort === 'date') {
      for (const p of ps.slice().sort((a, b) => time(b) - time(a))) {
        if (!p.date) add('~', p, () => ({ title: 'Undated' }));
        else add(p.date.slice(0, 7), p, () => ({ title: fmtDate(p.date, { month: 'long' }), tag: p.date.slice(0, 4) }));
      }
      const out = [...groups.values()];
      for (const g of out) {
        const where = [...new Set(g.items.map((p) => p.place).filter(Boolean))];
        g.sub = [where.slice(0, 3).join(', ') + (where.length > 3 ? '…' : ''), plural(g.items.length, 'photo')].filter(Boolean).join(' · ');
      }
      return out;
    }
    // by place
    for (const p of ps) {
      if (!p.place && !p.country) add('~', p, () => ({ title: 'Somewhere' }));
      else add(`${p.country || ''}|${p.place || ''}`, p, () => ({
        title: p.place || p.country,
        tag: p.place && p.country && p.country !== p.place ? p.country : null,
      }));
    }
    const out = [...groups.values()].sort((a, b) => (a.key === '~' ? 1 : b.key === '~' ? -1 : a.key.localeCompare(b.key)));
    for (const g of out) {
      g.items.sort((a, b) => time(a) - time(b));
      g.sub = [dateRange(g.items), plural(g.items.length, 'photo')].filter(Boolean).join(' · ');
    }
    return out;
  }

  // ---------- grid (endless scroll) ----------
  const grid = $('#grid');
  const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && renderMore(), { rootMargin: '1200px' });
  const imgIO = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { e.target.src = e.target.dataset.src; imgIO.unobserve(e.target); }
  }, { rootMargin: '800px' });

  function resetGrid() {
    state.list = [];
    state.gridList = [];
    for (const g of buildGroups()) {
      if (g.title) state.list.push({ head: g });
      for (const p of g.items) { state.list.push({ photo: p, idx: state.gridList.length }); state.gridList.push(p); }
    }
    state.rendered = 0;
    grid.innerHTML = '';
    renderMore();
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderMore() {
    if (state.mode !== 'grid') return;
    let tiles = grid.lastElementChild?.classList.contains('tiles') ? grid.lastElementChild : null;
    let count = 0;
    while (state.rendered < state.list.length && count < BATCH) {
      const entry = state.list[state.rendered++];
      if (entry.head) {
        const h = el('h2', 'group-head');
        h.append(el('span', 't', entry.head.title));
        if (entry.head.tag) h.append(el('span', 'tag', entry.head.tag));
        if (entry.head.sub) h.append(el('span', 's', entry.head.sub));
        tiles = el('div', 'tiles');
        grid.append(h, tiles);
        continue;
      }
      if (!tiles) { tiles = el('div', 'tiles'); grid.append(tiles); }
      tiles.append(makeTile(entry.photo, entry.idx));
      count++;
    }
    requestAnimationFrame(() => {
      const s = $('#sentinel').getBoundingClientRect();
      if (state.rendered < state.list.length && s.top < innerHeight + 1200) renderMore();
    });
  }

  function makeTile(p, idx) {
    const r = p.w && p.h ? p.w / p.h : 1.5;
    const fig = el('figure', 'tile');
    fig.style.flex = `${r} 1 calc(var(--row) * ${r})`;
    const img = new Image();
    img.alt = placeOf(p);
    img.decoding = 'async';
    img.dataset.src = p.thumb;
    img.onload = () => img.classList.add('loaded');
    imgIO.observe(img);
    fig.append(img);
    const label = [p.place, fmtDate(p.date, { month: 'short', year: 'numeric' })].filter(Boolean).join(' · ');
    if (label) fig.append(el('div', 'tag', label));
    fig.onclick = () => openLightbox(state.gridList, idx);
    return fig;
  }

  // ---------- map ----------
  // The world is drawn from Natural Earth data stored in the site (no map service, no API key).
  // Countries with photos get a lavender tint.
  const WORLD = { coarse: 'vendor/world/countries-50m.json', fine: 'vendor/world/countries-10m.json' };
  const MAP_COLORS = { sea: '#CFE1F3', land: '#FBF3DE', visited: '#D8CCF0', border: '#FFFFFF', visitedBorder: '#B9ACDD' };
  const NAME_ALIASES = { 'united states': 'united states of america', 'czechia': 'czech republic', 'bosnia and herzegovina': 'bosnia and herz.', 'dominican republic': 'dominican rep.', 'south korea': 'south korea', 'türkiye': 'turkey', 'the netherlands': 'netherlands', 'united kingdom': 'united kingdom' };

  function inRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inFeature(lng, lat, g) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.some((poly) => [lng, lng + 360, lng - 360].some((x) => inRing(x, lat, poly[0]) && !poly.slice(1).some((h) => inRing(x, lat, h))));
  }
  // Rings that cross the 180° line would be drawn as stripes across the map: keep them continuous instead
  function unwrap(fc) {
    const fixRing = (ring) => {
      let shift = 0;
      return ring.map(([x, y], i) => {
        if (i) { const prev = ring[i - 1][0]; if (x - prev > 180) shift -= 360; else if (prev - x > 180) shift += 360; }
        return [x + shift, y];
      });
    };
    fc.features = fc.features.filter((f) => f.properties.name !== 'Antarctica');
    for (const f of fc.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === 'Polygon') g.coordinates = g.coordinates.map(fixRing);
      if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map((p) => p.map(fixRing));
    }
    return fc;
  }
  function visitedCountries(fc, geo) {
    const names = new Set();
    const photoCountries = new Set(geo.map((p) => (p.country || '').toLowerCase()).filter(Boolean).map((c) => NAME_ALIASES[c] || c));
    for (const f of fc.features) if (photoCountries.has(f.properties.name.toLowerCase())) names.add(f.properties.name);
    for (const p of geo) {
      // inside a country, or just off its (simplified) coast
      for (const [dx, dy] of [[0, 0], [0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
        const f = fc.features.find((f) => f.geometry && inFeature(p.lng + dx, p.lat + dy, f.geometry));
        if (f) { names.add(f.properties.name); break; }
      }
    }
    return names;
  }

  async function drawWorld(geo) {
    const renderer = L.canvas({ padding: 0.5 });
    let layer = null, visited = null;
    const load = async (url) => {
      const topo = await (await fetch(url)).json();
      const fc = unwrap(topojson.feature(topo, topo.objects.countries));
      visited ||= visitedCountries(fc, geo);
      const next = L.geoJSON(fc, {
        renderer, interactive: false,
        style: (f) => {
          const v = visited.has(f.properties.name);
          return { fillColor: v ? MAP_COLORS.visited : MAP_COLORS.land, fillOpacity: 1, color: v ? MAP_COLORS.visitedBorder : MAP_COLORS.border, weight: v ? 1 : 0.8 };
        },
      }).addTo(map);
      next.bringToBack();
      if (layer) map.removeLayer(layer);
      layer = next;
    };
    try { await load(WORLD.coarse); } catch (e) { console.warn('world map failed to load', e); return; }
    // sharper coastlines once zoomed in
    const upgrade = () => { if (map.getZoom() >= 5) { map.off('zoomend', upgrade); load(WORLD.fine).catch(() => {}); } };
    map.on('zoomend', upgrade);
    upgrade();
  }

  function initMap() {
    if (map) { setTimeout(() => map.invalidateSize(), 0); return; }
    map = L.map('map', {
      zoomSnap: 0.5, minZoom: 1.5, maxZoom: 9,
      maxBounds: [[-75, -220], [85, 220]], maxBoundsViscosity: 0.8,
    }).setView([25, 10], 2);
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution('Map data: <a href="https://www.naturalearthdata.com/">Natural Earth</a>');

    const geo = state.photos.filter((p) => p.lat != null && p.lng != null).sort((a, b) => time(a) - time(b));
    const pinIcon = (p, n, size) => {
      const rot = (hash(p.id) % 9) - 4;
      const c = n > 1 ? ` c${Math.abs(hash(p.id + n)) % 3}` : '';
      return L.divIcon({
        className: 'pin', iconSize: [size, size * 1.12], iconAnchor: [size / 2, size * 0.56],
        html: `<div class="polaroid" style="--r:${rot}deg"><div class="ph" style="background-image:url('${p.thumb}')"></div></div>${n > 1 ? `<span class="n${c}">${n}</span>` : ''}`,
      });
    };

    const clusters = L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 80, spiderfyDistanceMultiplier: 2.4,
      iconCreateFunction: (cl) => {
        const ms = cl.getAllChildMarkers();
        const n = ms.length;
        return pinIcon(ms[0].photo, n, n > 50 ? 84 : n > 10 ? 76 : 68);
      },
    });
    geo.forEach((p, i) => {
      const m = L.marker([p.lat, p.lng], { icon: pinIcon(p, 1, 60), title: placeOf(p) });
      m.photo = p;
      m.on('click', () => openLightbox(geo, i));
      clusters.addLayer(m);
    });
    map.addLayer(clusters);
    drawWorld(geo);
    if (geo.length) map.fitBounds(clusters.getBounds(), { padding: [70, 70], maxZoom: 10 });

    const missing = state.photos.length - geo.length;
    if (missing && state.photos.length) {
      $('#map-note').hidden = false;
      $('#map-note').textContent = `${plural(missing, 'photo')} without location ${missing === 1 ? 'is' : 'are'} only in the grid`;
    }
  }

  // ---------- lightbox ----------
  const lb = $('#lightbox');
  function openLightbox(list, i) { state.lbList = list; state.lbIndex = i; showLb(); lb.hidden = false; document.body.style.overflow = 'hidden'; }
  function closeLightbox() { lb.hidden = true; document.body.style.overflow = ''; }
  function showLb() {
    const p = state.lbList[state.lbIndex];
    const img = $('#lb-img');
    img.src = p.thumb; // instant preview, then swap in the large version
    const big = new Image();
    big.onload = () => { if (state.lbList[state.lbIndex] === p) img.src = p.large; };
    big.src = p.large;
    img.alt = placeOf(p);

    const cap = $('#lb-cap');
    cap.innerHTML = '';
    cap.append(el('div', 'lb-place', placeOf(p) || 'Somewhere'));
    const meta = el('div', 'lb-meta', fmtDate(p.date));
    if (p.approx) meta.append(el('span', 'approx', 'approx. location'));
    meta.append(el('span', null, `${state.lbIndex + 1} / ${state.lbList.length}`));
    cap.append(meta);
    if (p.caption) cap.append(el('div', 'lb-caption', p.caption));

    for (const d of [1, -1]) { const n = state.lbList[state.lbIndex + d]; if (n) new Image().src = n.large; }
  }
  const step = (d) => { state.lbIndex = (state.lbIndex + d + state.lbList.length) % state.lbList.length; showLb(); };
  $('.lb-prev').onclick = (e) => { e.stopPropagation(); step(-1); };
  $('.lb-next').onclick = (e) => { e.stopPropagation(); step(1); };
  $('.lb-close').onclick = closeLightbox;
  lb.onclick = (e) => { if (e.target === lb || e.target.tagName === 'FIGURE') closeLightbox(); };
  addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
  let touchX = null;
  lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    touchX = null;
  });

  // ---------- modes / routing (#grid/date, #map ...) ----------
  function apply() {
    const [mode, sort] = location.hash.slice(1).split('/');
    const newMode = mode === 'map' ? 'map' : 'grid';
    const newSort = ['shuffle', 'date', 'location'].includes(sort) ? sort : state.sort;
    const changed = newMode !== state.mode || newSort !== state.sort;
    const sortChanged = newSort !== state.sort;
    state.mode = newMode;
    state.sort = newSort;
    document.body.classList.toggle('mode-map', state.mode === 'map');
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    document.querySelectorAll('[data-sort]').forEach((b) => b.classList.toggle('active', b.dataset.sort === state.sort));
    $('#sorts').style.visibility = state.mode === 'grid' ? '' : 'hidden';
    $('#grid-view').hidden = state.mode !== 'grid';
    $('#map-view').hidden = state.mode !== 'map';
    if (state.mode === 'map') { window.scrollTo(0, 0); initMap(); }
    else if (changed) {
      resetGrid();
      if (sortChanged) {
        const top = $('#bar').offsetTop;
        if (scrollY > top) window.scrollTo({ top, behavior: 'instant' });
      }
    }
  }
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    location.hash = b.dataset.mode === 'map' ? 'map' : `grid/${state.sort}`;
  }));
  document.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => {
    if (b.dataset.sort === 'shuffle' && state.sort === 'shuffle') { shuffled = null; resetGrid(); return; } // click again = reshuffle
    location.hash = `grid/${b.dataset.sort}`;
  }));
  addEventListener('hashchange', apply);

  // subtle shadow under the bar once it sticks
  addEventListener('scroll', () => $('#bar').classList.toggle('stuck', scrollY > $('#bar').offsetTop - 1 && scrollY > 0), { passive: true });

  io.observe($('#sentinel'));

  fetch('photos.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((photos) => {
      state.photos = photos;
      renderStats();
      $('#empty').hidden = photos.length > 0;
      apply();
    });
})();
