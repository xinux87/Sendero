/* Sección `dashboard`. Portado de la app multipágina
   (`git show v0.7.1:templates/app.html`).
   Markup en templates/sec/dashboard.html, CSS en static/css/dashboard.css.

   Dos cambios de fondo respecto a la versión de app.html:

   - Las rutas del mapa las da `Store.routes()` (IndexedDB + sincronización
     delta), no un `fetch('/api/routes')` suelto. Así el mapa se pinta sin
     conexión y no hay dos cachés de lo mismo.
   - Las estadísticas siguen viniendo de `/api/stats` (las calcula el servidor y
     duplicar ese agregado en el cliente sería pedir que divergieran), pero se
     guardan en el Store: sin conexión se muestran las últimas conocidas,
     avisando de que lo son. Recalcularlas aquí tampoco sería posible del todo:
     `avg_speed` no está en las columnas del listado.

   Contrato: mount(params, opts) / unmount(). unmount() DEBE destruir el mapa. */
(() => {
  'use strict';

  let map = null, mapLoaded = false;
  let routes = null;                    // listado ligero (Store.routes())
  let lineIds = new Set(), lineFeatures = [], lineTimer = null, fetching = false;
  let clusterLabels = {};
  let _tok = 0;
  let _unsub = null;

  const CLUSTER_MAXZOOM = 9, POINTS_MAXZOOM = 11, LINES_MINZOOM = 9;
  // Por debajo de este zoom no se piden líneas: de lejos no aportan y serían
  // todas las rutas completas. Dos niveles de colchón para que estén listas
  // antes de volverse visibles.
  const LINES_PREFETCH_ZOOM = LINES_MINZOOM - 2;

  const q = sel => document.querySelector('#sec-dashboard ' + sel);
  const visible = () => {
    const el = document.getElementById('sec-dashboard');
    return !!el && !el.classList.contains('hidden');
  };

  /* ── estadísticas ──────────────────────────────────────────────────────── */
  function actRow(a, t, total) {
    const pct = Math.round((t.count / total) * 100);
    const row = document.createElement('div');
    row.className = 'act-row';
    row.innerHTML = `<div class="act-label"><div class="act-dot" style="background:${a.color}"></div>${esc(a.label)}</div>
      <div class="act-bar-bg"><div class="act-bar-fill" style="width:${pct}%;background:${a.color}"></div></div>
      <div class="act-meta">${t.km.toLocaleString('es-ES', {maximumFractionDigits: 0})} km</div>
      <div class="act-count">${t.count} ruta${t.count !== 1 ? 's' : ''}</div>`;
    return row;
  }

  function renderStats(d, fromCache) {
    q('#ov-loading').classList.add('hidden');
    q('#ov-content').classList.remove('hidden');
    const stale = q('#ov-stale');
    if (fromCache) {
      stale.textContent = 'Sin conexión: estadísticas de la última sincronización.';
      stale.classList.remove('hidden');
    } else {
      stale.classList.add('hidden');
    }
    renderTotals(d);

    const actBox = q('#ov-act-rows');
    actBox.innerHTML = '';
    const total = d.total_routes || 1;
    ACTIVITIES.forEach(a => {
      const t = d.by_type[a.id];
      if (t) actBox.appendChild(actRow(a, t, total));
    });

    const yearBox = q('#ov-year-chart');
    yearBox.innerHTML = '';
    const years = Object.entries(d.by_year || {});
    if (!years.length) {
      yearBox.innerHTML = '<span style="color:var(--muted);font-size:13px;padding:16px 0">Sin datos de fecha</span>';
    } else {
      const maxC = Math.max(...years.map(([, c]) => c));
      years.forEach(([year, count]) => {
        const h = Math.max(4, Math.round((count / maxC) * 100));
        const col = document.createElement('div');
        col.className = 'year-col';
        col.title = `${year}: ${count} ruta${count !== 1 ? 's' : ''}`;
        col.innerHTML = `<div class="year-count">${count}</div>
          <div class="year-bar" style="height:${h}px"></div>
          <div class="year-num">${year}</div>`;
        yearBox.appendChild(col);
      });
    }

    const rec = d.records || {};
    const recGrid = q('#ov-records-grid');
    recGrid.innerHTML = '';
    if (!rec.longest && !rec.highest && !rec.fastest) {
      q('#ov-records-section').classList.add('hidden');
      return;
    }
    q('#ov-records-section').classList.remove('hidden');
    const card = (label, value, unit, name) => {
      if (!name) return;
      const c = document.createElement('div');
      c.className = 'record-card';
      // Por NOMBRE a propósito: el caché de stats de settings solo guarda el
      // nombre, y el servidor redirige 302 al public_id.
      c.onclick = () => go('/Sendero/' + encodeURIComponent(name));
      c.innerHTML = `<div class="rl">${esc(label)}</div>
        <div class="rv">${value}<small> ${unit}</small></div>
        <div class="rn">${esc(name)}</div>`;
      recGrid.appendChild(c);
    };
    if (rec.longest) card('Ruta más larga',
      rec.longest.km.toLocaleString('es-ES', {maximumFractionDigits: 1}), 'km', rec.longest.name);
    if (rec.highest) card('Mayor desnivel ↑',
      rec.highest.ascent_m.toLocaleString('es-ES', {maximumFractionDigits: 0}), 'm↑', rec.highest.name);
    if (rec.fastest) card('Vel. media más alta',
      rec.fastest.avg_speed.toFixed(1), 'km/h', rec.fastest.name);
  }

  function renderTotals(d) {
    if (!q('#ov-total-routes')) return;
    q('#ov-total-routes').textContent = d.total_routes;
    q('#ov-total-km').innerHTML =
      `${d.total_km.toLocaleString('es-ES', {maximumFractionDigits: 0})}<small> km</small>`;
    q('#ov-total-asc').innerHTML =
      `${d.total_ascent_m.toLocaleString('es-ES', {maximumFractionDigits: 0})}<small> m</small>`;
    q('#ov-total-time').textContent = fmtDur(d.total_moving_s);
  }

  async function loadStats() {
    const tok = _tok;
    let data;
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) throw new Error('stats ' + res.status);
      data = await res.json();
      if (data.dirty && !data.total_routes) {
        // El servidor no tiene caché todavía: pedir el cálculo y reintentar.
        q('#ov-loading').classList.remove('hidden');
        q('#ov-loading').textContent = 'Cargando estadísticas…';
        try { await fetch('/api/stats/refresh', {method: 'POST'}); } catch (e) {}
        if (tok !== _tok) return;
        return loadStats();
      }
      await Store.setMeta('stats', data);
    } catch (e) {
      const cache = await Store.meta('stats');
      if (tok !== _tok) return;
      if (!cache) {
        q('#ov-loading').textContent =
          'No hay estadísticas guardadas en este dispositivo. Conéctate una vez para calcularlas.';
        return;
      }
      renderStats(cache, true);
      return;
    }
    if (tok !== _tok) return;
    renderStats(data, false);
    if (data.dirty) regenInBackground();
  }

  /* El servidor marcó las stats como sucias (se importó o borró algo): se
     recalculan por detrás, sin ocultar lo que ya se está mostrando. */
  function regenInBackground() {
    if (document.getElementById('stats-regen-loader')) return;
    const tok = _tok;
    const loader = document.createElement('div');
    loader.id = 'stats-regen-loader';
    loader.className = 'upload-loader';
    loader.innerHTML = `<div class="upload-loader-title">Regenerando estadísticas</div>
      <div class="upload-bar-bg"><div class="upload-bar-fill" id="stats-regen-bar"></div></div>
      <div class="upload-filename">Calculando…</div>`;
    document.body.appendChild(loader);
    const bar = document.getElementById('stats-regen-bar');
    let pct = 0;
    const iv = setInterval(() => { pct = Math.min(pct + 2, 90); bar.style.width = pct + '%'; }, 120);
    fetch('/api/stats/refresh', {method: 'POST'}).then(() => {
      clearInterval(iv);
      bar.style.width = '100%';
      setTimeout(() => {
        loader.remove();
        fetch('/api/stats').then(r => r.json()).then(d => {
          if (d.dirty) return;
          Store.setMeta('stats', d);
          if (tok === _tok) renderTotals(d);
        }).catch(() => {});
      }, 600);
    }).catch(() => { clearInterval(iv); loader.remove(); });
  }

  async function refreshStats() {
    const btn = document.getElementById('refresh-btn');
    if (!Store.isOnline()) { toast('Recalcular las estadísticas necesita conexión'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '↻ Calculando…'; }
    try {
      await fetch('/api/stats/refresh', {method: 'POST'});
      q('#ov-content').classList.add('hidden');
      q('#ov-loading').textContent = 'Cargando estadísticas…';
      q('#ov-loading').classList.remove('hidden');
      await Store.syncNow({force: true});
      await loadStats();
      await reloadRoutes();
    } catch (e) {
      toast('No se pudieron recalcular las estadísticas');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Actualizar'; }
    }
  }

  /* ── mapa ──────────────────────────────────────────────────────────────── */
  function pointsGeoJSON() {
    return {type: 'FeatureCollection', features: (routes || []).map(r => ({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [r.start_lon, r.start_lat]},
      properties: {id: r.public_id, name: r.name, activity: r.activity_type || 'otros',
                   year: (r.started_at || '').slice(0, 4) || null,
                   km: (r.distance_m || 0) / 1000},
    }))};
  }

  function fitToPoints() {
    if (!routes || !routes.length || !map) return;
    let mnLo = 180, mxLo = -180, mnLa = 90, mxLa = -90;
    routes.forEach(r => {
      if (r.start_lon < mnLo) mnLo = r.start_lon;
      if (r.start_lon > mxLo) mxLo = r.start_lon;
      if (r.start_lat < mnLa) mnLa = r.start_lat;
      if (r.start_lat > mxLa) mxLa = r.start_lat;
    });
    if (mnLo < mxLo && mnLa < mxLa) {
      map.fitBounds([[mnLo, mnLa], [mxLo, mxLa]], {padding: 30, maxZoom: 12, duration: 0});
    }
  }

  function scheduleLineLoad() {
    clearTimeout(lineTimer);
    lineTimer = setTimeout(loadLinesForView, 350);
  }

  async function loadLinesForView() {
    if (!mapLoaded || fetching || !map) return;
    if (map.getZoom() < LINES_PREFETCH_ZOOM) return;      // de lejos, solo bolitas
    const b = map.getBounds();
    // Margen del 50% del viewport a cada lado: los paneos pequeños dentro de esa
    // zona no disparan otra petición (lineIds ya las tendrá).
    const padLon = (b.getEast() - b.getWest()) * 0.5, padLat = (b.getNorth() - b.getSouth()) * 0.5;
    const bbox = [b.getWest() - padLon, b.getSouth() - padLat,
                  b.getEast() + padLon, b.getNorth() + padLat].join(',');
    fetching = true;
    const loader = q('#dash-map-loader'), bar = q('#dash-map-loader-bar');
    if (loader) { loader.classList.remove('hidden'); bar.style.width = '30%'; }
    try {
      const fc = await (await fetch('/api/routes/geojson?bbox=' + encodeURIComponent(bbox))).json();
      const fresh = fc.features.filter(f => !lineIds.has(f.properties.id));
      if (fresh.length && map && map.getSource('dash-routes')) {
        fresh.forEach(f => lineIds.add(f.properties.id));
        lineFeatures.push(...fresh);
        map.getSource('dash-routes').setData({type: 'FeatureCollection', features: lineFeatures});
      }
      if (bar) bar.style.width = '100%';
    } catch (e) {
      /* sin conexión o error: las bolitas siguen visibles */
    } finally {
      fetching = false;
      if (loader) setTimeout(() => loader.classList.add('hidden'), 250);
    }
  }

  /* Etiquetas de los clusters como marcadores DOM: para pintar texto MapLibre
     necesitaría un servidor de glyphs, que no hay (ni tendría sin conexión). */
  function syncClusterLabels() {
    if (!map || !map.getLayer('dash-clusters')) return;
    const feats = map.queryRenderedFeatures({layers: ['dash-clusters']});
    const seen = new Set();
    feats.forEach(f => {
      const id = f.properties.cluster_id, n = f.properties.point_count;
      seen.add(id);
      if (!clusterLabels[id]) {
        const el = document.createElement('div');
        el.style.cssText = 'pointer-events:none;color:#101a14;font-weight:800;font-size:12px;line-height:1;text-align:center;text-shadow:0 0 3px rgba(255,255,255,0.95)';
        clusterLabels[id] = new maplibregl.Marker({element: el, anchor: 'center'})
          .setLngLat(f.geometry.coordinates).addTo(map);
      }
      const txt = n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
      if (clusterLabels[id].getElement().textContent !== txt) {
        clusterLabels[id].getElement().textContent = txt;
      }
    });
    Object.keys(clusterLabels).forEach(id => {
      if (!seen.has(+id)) { clusterLabels[id].remove(); delete clusterLabels[id]; }
    });
  }

  function clearClusterLabels() {
    Object.values(clusterLabels).forEach(m => { try { m.remove(); } catch (e) {} });
    clusterLabels = {};
  }

  function initMap() {
    if (map) return;
    map = new maplibregl.Map({
      container: 'dash-map',
      // Por buildStyle(), no con las teselas a mano: si no, este mapa sería el
      // único que ignoraría la capa de Ajustes → Mapas (la offline incluida).
      // Sigue sin selector propio; su capa por defecto es Oscuro.
      style: buildStyle(defaultBasemap('Oscuro')),
      center: [-84, 10], zoom: 4, attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');

    const tok = _tok;
    map.on('load', async () => {
      if (tok !== _tok || !map) return;
      // Líneas del track real: solo visibles a partir de cierto zoom, pedidas
      // por bbox en segundo plano.
      map.addSource('dash-routes', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
      map.addLayer({id: 'dash-lines', type: 'line', source: 'dash-routes', minzoom: LINES_MINZOOM,
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': activityLineColor(), 'line-width': 1.8, 'line-opacity': 0.8}});
      // Línea invisible más ancha encima, solo para acertar el click/hover.
      map.addLayer({id: 'dash-lines-hit', type: 'line', source: 'dash-routes', minzoom: LINES_MINZOOM,
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': '#000', 'line-width': 14, 'line-opacity': 0}});

      // Bolitas/clusters: un punto por ruta, es lo que se ve "de lejos".
      await _loadActImages(map);
      if (tok !== _tok || !map) return;
      map.addSource('dash-points', {type: 'geojson', data: {type: 'FeatureCollection', features: []},
        cluster: true, clusterMaxZoom: CLUSTER_MAXZOOM, clusterRadius: 30});
      map.addLayer({id: 'dash-clusters', type: 'circle', source: 'dash-points',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#e8c44a', 10, '#d4863a', 50, '#d24a3a'],
          'circle-radius': ['step', ['get', 'point_count'], 14, 10, 20, 50, 28],
          'circle-opacity': 0.55, 'circle-stroke-opacity': 1,
          'circle-stroke-width': 2, 'circle-stroke-color': 'rgba(255,255,255,0.85)',
        }});
      map.addLayer({id: 'dash-unclustered', type: 'symbol', source: 'dash-points',
        maxzoom: POINTS_MAXZOOM, filter: ['!', ['has', 'point_count']],
        layout: {'icon-image': ['concat', 'act-', ['get', 'activity']], 'icon-size': 0.85,
                 'icon-allow-overlap': true, 'icon-ignore-placement': true}});

      map.on('idle', syncClusterLabels);
      map.on('click', 'dash-clusters', async e => {
        const src = map.getSource('dash-points');
        const cid = e.features[0].properties.cluster_id;
        const coords = e.features[0].geometry.coordinates.slice();
        try {
          const zoom = await src.getClusterExpansionZoom(cid);
          map.easeTo({center: coords, zoom: zoom + 1.5});
        } catch (_) {
          src.getClusterExpansionZoom(cid, (err, zoom) => {
            if (!err) map.easeTo({center: coords, zoom: zoom + 1.5});
          });
        }
      });
      ['dash-clusters', 'dash-unclustered', 'dash-lines-hit'].forEach(capa => {
        map.on('mouseenter', capa, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', capa, () => { map.getCanvas().style.cursor = ''; });
      });
      // La URL canónica es el public_id, y properties.id lo trae tanto la fuente
      // de puntos como /api/routes/geojson.
      const abrir = e => go('/Sendero/' + encodeURIComponent(e.features[0].properties.id));
      map.on('click', 'dash-unclustered', abrir);
      map.on('click', 'dash-lines-hit', abrir);
      map.on('moveend', scheduleLineLoad);

      mapLoaded = true;
      paintRoutes(true);
    });
  }

  function destroyMap() {
    clearTimeout(lineTimer);
    clearClusterLabels();
    if (map) { try { map.remove(); } catch (e) {} }
    map = null;
    mapLoaded = false;
    lineIds = new Set();
    lineFeatures = [];
    fetching = false;
  }

  function paintRoutes(fit) {
    if (!map || !mapLoaded) return;
    // Las líneas de la vista anterior ya no valen (pueden apuntar a rutas
    // borradas o quedarse cortas con rutas nuevas): se limpian y se repiden.
    lineIds = new Set();
    lineFeatures = [];
    map.getSource('dash-routes').setData({type: 'FeatureCollection', features: []});
    if (!routes || !routes.length) {
      map.getSource('dash-points').setData({type: 'FeatureCollection', features: []});
      q('#ov-map-section').classList.add('hidden');
      return;
    }
    q('#ov-map-section').classList.remove('hidden');
    map.getSource('dash-points').setData(pointsGeoJSON());
    if (fit) fitToPoints();
    loadLinesForView();
  }

  /* Relee el listado del Store y repinta el mapa y "Por actividad". Las stats
     globales no: las calcula el servidor y tienen su propio camino. */
  async function reloadRoutes() {
    const tok = _tok;
    try {
      const rows = await Store.routes();
      if (tok !== _tok) return;
      routes = rows.filter(r => r.start_lat != null && r.start_lon != null);
    } catch (e) {
      routes = routes || [];
    }
    paintRoutes(false);
    refreshActRows();
  }

  /* "Por actividad" desde el listado (no del geojson pesado), que es lo que
     permite que siga al día sin recalcular las stats del servidor. */
  function refreshActRows() {
    if (!routes || !routes.length) return;
    const byAct = {};
    routes.forEach(r => {
      const a = r.activity_type || 'otros';
      if (!byAct[a]) byAct[a] = {count: 0, km: 0};
      byAct[a].count++;
      byAct[a].km += (r.distance_m || 0) / 1000;
    });
    const total = routes.length || 1;
    const box = q('#ov-act-rows');
    box.innerHTML = '';
    ACTIVITIES.forEach(a => {
      const t = byAct[a.id];
      if (t) box.appendChild(actRow(a, t, total));
    });
  }

  /* ── montaje ───────────────────────────────────────────────────────────── */
  async function mount() {
    const tok = ++_tok;
    q('#ov-loading').textContent = 'Cargando estadísticas…';
    q('#ov-loading').classList.remove('hidden');
    q('#ov-records-section').classList.remove('hidden');
    q('#ov-map-section').classList.remove('hidden');

    // Mapa y estadísticas son dos caminos independientes: ninguno espera al otro.
    initMap();
    const lista = Store.routes().then(rows => {
      if (tok !== _tok) return;
      routes = rows.filter(r => r.start_lat != null && r.start_lon != null);
      paintRoutes(true);
      refreshActRows();
    }).catch(() => {});
    await loadStats();
    await lista;
    if (tok !== _tok) return;
    // Una sincronización posterior (otro dispositivo, el watcher, mifit) repinta.
    if (!_unsub) {
      _unsub = Store.onChange(ev => {
        if (ev.type === 'synced' && ev.changed && visible()) reloadRoutes();
      });
    }
    if (map) setTimeout(() => { if (map) map.resize(); }, 60);
  }

  function unmount() {
    _tok++;
    destroyMap();
    if (_unsub) { _unsub(); _unsub = null; }
    routes = null;
  }

  window.SEC.dashboard = {mount, unmount, refreshStats};
})();
