/* Sección `detalle`: detalle de una ruta.
   Portado de templates/sendero.html (roadmap/spa-offline-sync.md §2-§3).
   Markup en templates/sec/detalle.html, CSS en static/css/detalle.css.

   Contrato (lo llama static/js/core/router.js):
     mount(params, {bootstrap, remount})  params.id = public_id de la ruta
     unmount()                            DEBE destruir el mapa y los 3 Charts

   Diferencias con la plantilla de la que sale, todas a propósito:

   - Los datos NO vienen inyectados por Jinja: los pide Store.route() en su
     variante ligera (?lite=1, track decimado y series remuestreadas), que es la
     misma que el servidor inyecta como bootstrap en la primera carga. Así la
     copia de IndexedDB coincide con lo que serviría la red y una segunda visita
     no gasta ni una petición.
   - Se puede navegar de un detalle a OTRO detalle (el enlace del aviso de
     duplicada), y el router no desmonta cuando la sección no cambia: mount()
     empieza por resetView() para no heredar mapa, gráficas ni marcadores.
   - Las escrituras pequeñas (nombre, notas, actividad, descartar aviso) van por
     Store.patch: sin conexión se encolan. Las que el cliente no puede simular
     (reescanear, subir fotos, Immich, borrar) exigen conexión y avisan.
*/
(() => {
  'use strict';

  let map = null, map3dMode = false;
  let elevChart = null, speedChart = null, hrChart = null;
  let current = null, pid = null, _lite = true;
  // Hover sincronizado mapa↔gráficos: hoverD es la distancia (km) resaltada
  // ahora mismo, o null si no hay hover activo.
  let hoverD = null, trackCumKm = [], hoverBoxEl = null;
  let photoMarkers = {}, lbIdx = 0;
  let immichCands = [], immichSel = new Set();
  let IMMICH = false, IMMICH_DIST_M = 100, _cfgLoaded = false;
  const NEAR_M = 500;
  /* Recuerda la capa base elegida entre re-creaciones del mapa: renderMap()
     destruye y recrea el mapa entero, y sin esto volvería siempre a la capa por
     defecto de Ajustes. */
  let curBasemap = null;
  // Token de montaje: si se navega a otra ruta mientras el fetch está en vuelo,
  // la respuesta vieja no debe pintar nada.
  let _tok = 0;

  const q = sel => document.querySelector('#sec-detalle ' + sel);

  function needOnline(msg) {
    if (Store.isOnline()) return true;
    toast(msg || 'Esta acción necesita conexión');
    return false;
  }

  /* ── actividad ─────────────────────────────────────────────────────────── */
  function renderActivity() {
    const a = activityOf(current.activity_type);
    const el = $('#d-activity-badge-sm');
    if (!el) return;
    el.innerHTML = a
      ? `<span class="act-badge" onclick="SEC.detalle.openActivityPicker()"
           style="background:${a.color}1a;border-color:${a.color};color:${a.color}">
           ${iconSvg(a, 18)} ${esc(a.label)}</span>`
      : `<span class="act-badge" onclick="SEC.detalle.openActivityPicker()"
           style="background:var(--panel-2);border-color:var(--line);color:var(--muted)">
           + Añadir tipo de actividad</span>`;
  }

  function openActivityPicker() {
    if (!current) return;
    const g = $('#d-act-picker-grid');
    g.innerHTML = '';
    ACTIVITIES.forEach(a => {
      const d = document.createElement('div');
      d.className = 'act-opt' + (current.activity_type === a.id ? ' on' : '');
      d.style.borderColor = current.activity_type === a.id ? a.color : '';
      d.innerHTML = `${iconSvg(a, 40)}
        <span class="act-lbl" style="color:${a.color}">${esc(a.label)}</span>`;
      d.onclick = () => setActivity(a.id);
      g.appendChild(d);
    });
    $('#d-activity-modal').classList.remove('hidden');
  }

  function closeActivityPicker() { $('#d-activity-modal').classList.add('hidden'); }

  async function setActivity(id) {
    const r = await Store.patch(`/api/routes/${pid}`, {activity_type: id},
                                {label: 'actividad de la ruta'});
    if (!r.ok) { toast('Error al guardar la actividad'); return; }
    current.activity_type = id;
    const a = activityOf(id);
    if (map && a && map.getLayer('ruta-linea')) {
      map.setPaintProperty('ruta-linea', 'line-color', a.color);
      if (map.getLayer('hover-point')) map.setPaintProperty('hover-point', 'circle-color', a.color);
    }
    renderActivity();
    renderStats();
    closeActivityPicker();
    await saveLocal();
    toast(r.queued ? 'Actividad guardada (se enviará al recuperar conexión)'
                   : 'Actividad guardada');
    if (!current.photos.length && IMMICH && !current.immich_checked) autoSearchImmich();
  }

  /* ── stats ─────────────────────────────────────────────────────────────── */
  function renderStats() {
    const r = current;
    const a = activityOf(r.activity_type);
    const actStat = a
      ? `<div class="stat" style="border-color:${a.color}40;cursor:pointer" onclick="SEC.detalle.openActivityPicker()">
           <div class="v" style="line-height:1">${iconSvg(a, 26)}</div>
           <div class="l" style="color:${a.color}">${esc(a.label)}</div></div>`
      : `<div class="stat" style="border-style:dashed;cursor:pointer" onclick="SEC.detalle.openActivityPicker()">
           <div class="v" style="font-size:20px;color:var(--muted)">＋</div>
           <div class="l">Actividad</div></div>`;
    const items = [
      ['Distancia', fmtKm(r.distance_m), 'km'],
      ['Desnivel +', r.ascent_m ? Math.round(r.ascent_m) : '–', 'm'],
      ['Desnivel −', r.descent_m ? Math.round(r.descent_m) : '–', 'm'],
      ['En movimiento', fmtDur(r.moving_s || r.duration_s), ''],
      ['Vel. media', r.avg_speed ? r.avg_speed.toFixed(1) : '–', 'km/h'],
      ['Altitud máx', r.ele_max != null ? Math.round(r.ele_max) : '–', 'm'],
    ];
    if (r.hr_avg) items.push(['FC media', r.hr_avg, 'bpm']);
    if (r.hr_max) items.push(['FC máx', r.hr_max, 'bpm']);
    $('#d-stats').innerHTML = actStat + items.map(([l, v, u]) =>
      `<div class="stat"><div class="v">${v} <small>${u}</small></div><div class="l">${l}</div></div>`
    ).join('');
  }

  /* ── mapa ──────────────────────────────────────────────────────────────── */
  function fitRoute() {
    const coords = current.geojson;
    if (!coords.length || !map) return;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    coords.forEach(([lo, la]) => {
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    });
    map.fitBounds([[minLon, minLat], [maxLon, maxLat]],
                  {padding: 40, pitch: map3dMode ? 60 : 0, duration: 600});
  }

  function toggle3D() {
    if (!map) return;
    map3dMode = !map3dMode;
    $('#d-btn3d').textContent = map3dMode ? 'Vista 2D' : 'Vista 3D';
    if (map3dMode) {
      map.setTerrain({source: 'terrain', exaggeration: 1.5});
      map.easeTo({pitch: 60, duration: 800});
    } else {
      map.setTerrain(null);
      map.easeTo({pitch: 0, bearing: 0, duration: 600});
    }
  }

  function destroyMap() {
    if (hoverBoxEl && hoverBoxEl.parentNode) hoverBoxEl.parentNode.removeChild(hoverBoxEl);
    hoverBoxEl = null;
    photoMarkers = {};
    if (!map) return;
    try { map.remove(); } catch (e) {}
    map = null;
  }

  function renderMap() {
    destroyMap();
    map3dMode = false;
    hoverD = null;
    const btn3d = $('#d-btn3d');
    if (btn3d) btn3d.textContent = 'Vista 3D';
    const coords = current.geojson;
    trackCumKm = _buildCumKm(coords);
    const color = (activityOf(current.activity_type) || {}).color || '#d24a3a';
    let cx = -1.6, cy = 42.5;
    if (coords.length) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      coords.forEach(([lo, la]) => {
        if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
        if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      });
      cx = (minLon + maxLon) / 2; cy = (minLat + maxLat) / 2;
    }
    map = new maplibregl.Map({
      container: 'd-map', style: buildStyle(curBasemap || (curBasemap = defaultBasemap())),
      center: [cx, cy], zoom: coords.length ? 12 : 6, attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: true}), 'top-right');
    // botón centrar
    map.addControl({
      onAdd() {
        const c = document.createElement('div');
        c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const b = document.createElement('button');
        b.innerHTML = '⤢'; b.title = 'Centrar en la ruta';
        b.style.cssText = 'font-size:16px;width:29px;height:29px;cursor:pointer;border:none;background:none;padding:0;display:flex;align-items:center;justify-content:center';
        b.onclick = () => fitRoute();
        c.appendChild(b); return c;
      }, onRemove() {},
    }, 'top-left');
    // selector de capas (top-left, debajo del botón centrar)
    map.addControl({
      onAdd() {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:var(--panel,#fff);color:var(--ink,#101a14);border:none;font-size:12px;cursor:pointer;padding:5px 7px;font-family:inherit;width:100%';
        basemapNames().forEach(c => {
          const o = document.createElement('option'); o.value = c; o.textContent = c;
          sel.appendChild(o);
        });
        sel.value = curBasemap;
        sel.onchange = () => {
          const prev = curBasemap;
          curBasemap = sel.value;
          // Entrar o salir de la capa offline cambia el TIPO de fuente
          // (pmtiles://), así que hay que reconstruir el estilo — y eso borra las
          // capas de datos. Se recrea el mapa entero (renderMap ya sabe
          // repintarlo todo) conservando la cámara.
          if (prev === OFFLINE_LAYER || curBasemap === OFFLINE_LAYER) {
            const cam = {center: map.getCenter(), zoom: map.getZoom(),
                         bearing: map.getBearing(), pitch: map.getPitch()};
            renderMap();
            map.once('load', () => map.jumpTo(cam));
          } else {
            applyBasemap(map, curBasemap);
          }
        };
        const wrap = document.createElement('div');
        wrap.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        wrap.appendChild(sel);
        return wrap;
      }, onRemove() {},
    }, 'top-left');

    const tok = _tok;
    map.on('load', () => {
      if (tok !== _tok || !map) return;      // se navegó a otra ruta mientras cargaba
      map.addSource('terrain', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium', tileSize: 256, maxzoom: 15,
      });
      if (!coords.length) return;
      map.addSource('ruta', {type: 'geojson',
        data: {type: 'Feature', geometry: {type: 'LineString', coordinates: coords}}});
      map.addLayer({id: 'ruta-linea', type: 'line', source: 'ruta',
        paint: {'line-color': color, 'line-width': 4, 'line-opacity': 0.9}});
      // Línea invisible más ancha encima, solo para que el hover sea más fácil
      // de acertar que sobre la línea real de 4px (patrón de dash-lines-hit).
      map.addLayer({id: 'ruta-linea-hit', type: 'line', source: 'ruta',
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': '#000', 'line-width': 16, 'line-opacity': 0}});
      map.addSource('hover-point', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
      map.addLayer({id: 'hover-point', type: 'circle', source: 'hover-point',
        paint: {'circle-radius': 7, 'circle-color': color,
                'circle-stroke-width': 2, 'circle-stroke-color': '#101a14'}});
      map.on('mousemove', 'ruta-linea-hit', e => {
        const {lng, lat} = e.lngLat;
        let best = Infinity, bestIdx = 0;
        for (let i = 0; i < coords.length; i++) {
          const dx = coords[i][0] - lng, dy = coords[i][1] - lat, d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; bestIdx = i; }
        }
        map.getCanvas().style.cursor = 'crosshair';
        setHoverD(trackCumKm[bestIdx]);
      });
      map.on('mouseleave', 'ruta-linea-hit', () => {
        map.getCanvas().style.cursor = '';
        setHoverD(null);
      });
      fitRoute();
      new maplibregl.Marker({color: '#e8c44a'})
        .setLngLat(coords[0])
        .setPopup(new maplibregl.Popup({offset: 20}).setText('Inicio')).addTo(map);
      new maplibregl.Marker({color: '#e0e0e0'})
        .setLngLat(coords[coords.length - 1])
        .setPopup(new maplibregl.Popup({offset: 20}).setText('Fin')).addTo(map);
      photoMarkers = {};
      current.photos.filter(p => p.lat && p.lon).forEach(p => {
        const idx = current.photos.findIndex(ph => ph.public_id === p.public_id);
        const el = document.createElement('div');
        el.className = 'photo-marker';
        el.innerHTML = '<svg width="13" height="11" viewBox="0 0 13 11" fill="#101a14"><rect x="0" y="2" width="13" height="9" rx="1.5"/><path d="M4 0h5l1 2H3z"/><circle cx="6.5" cy="6.5" r="2.3" fill="#e8c44a"/><circle cx="6.5" cy="6.5" r="1.1" fill="#101a14"/></svg>';
        el.onclick = e => { e.stopPropagation(); openLightbox(idx); };
        photoMarkers[p.public_id] = new maplibregl.Marker({element: el, anchor: 'center'})
          .setLngLat([p.lon, p.lat]).addTo(map);
      });
    });
  }

  /* ── hover sincronizado mapa↔gráficos ──────────────────────────────────── */
  function haversineM(la1, lo1, la2, lo2) {
    const R = 6371000, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function _buildCumKm(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      const [lo1, la1] = coords[i - 1], [lo2, la2] = coords[i];
      cum.push(cum[i - 1] + haversineM(la1, lo1, la2, lo2) / 1000);
    }
    return cum;
  }
  /* elevation/speed/heart_rate son series independientes, cada una con su propio
     muestreo de "d" (no todos los puntos del track tienen elevación/velocidad/
     FC): hay que buscar el más cercano por distancia, no vale el mismo índice. */
  function _nearestByD(arr, d) {
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].d < d) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(arr[lo - 1].d - d) < Math.abs(arr[lo].d - d)) lo--;
    return arr[lo];
  }
  function _lngLatAtD(d) {
    const cum = trackCumKm, coords = current.geojson;
    if (!cum.length || !coords.length) return null;
    if (d <= cum[0]) return coords[0];
    if (d >= cum[cum.length - 1]) return coords[coords.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
    if (lo === 0) return coords[0];
    const d0 = cum[lo - 1], d1 = cum[lo], t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
    const [lo0, la0] = coords[lo - 1], [lo1, la1] = coords[lo];
    return [lo0 + (lo1 - lo0) * t, la0 + (la1 - la0) * t];
  }
  function _ensureHoverBox() {
    if (!hoverBoxEl) {
      hoverBoxEl = document.createElement('div');
      hoverBoxEl.className = 'hover-infobox';
      map.getContainer().appendChild(hoverBoxEl);
    }
    return hoverBoxEl;
  }
  function _updateMapHover() {
    if (!map || !current) return;
    const box = _ensureHoverBox();
    const src = map.getSource && map.getSource('hover-point');
    if (hoverD == null || !src) {
      box.style.display = 'none';
      if (src) src.setData({type: 'FeatureCollection', features: []});
      return;
    }
    const ll = _lngLatAtD(hoverD);
    if (!ll) { box.style.display = 'none'; return; }
    src.setData({type: 'FeatureCollection',
      features: [{type: 'Feature', geometry: {type: 'Point', coordinates: ll}}]});
    const pt = map.project(ll);
    const e = _nearestByD(current.elevation, hoverD);
    const v = _nearestByD(current.speed, hoverD);
    const hr = _nearestByD(current.heart_rate, hoverD);
    const parts = [`<div class="hb-km">${hoverD.toFixed(2)} km</div>`];
    if (e) parts.push(`<div>Alt ${Math.round(e.e)} m</div>`);
    if (v) parts.push(`<div>Vel ${v.v.toFixed(1)} km/h</div>`);
    if (hr) parts.push(`<div>FC ${Math.round(hr.hr)} bpm</div>`);
    box.innerHTML = parts.join('');
    box.style.display = 'block';   // antes de medir: con display:none offsetWidth es 0
    // clamp al contenedor: el white-space:nowrap desborda por la derecha en
    // pantallas estrechas; si no cabe, el cuadro se pone a la izquierda del punto
    const cw = map.getContainer().clientWidth, bw = box.offsetWidth || 120;
    let left = pt.x + 14;
    if (left + bw > cw - 6) left = pt.x - 14 - bw;
    box.style.left = Math.max(6, left) + 'px';
    box.style.top = (pt.y - 10) + 'px';
  }
  /* Punto de entrada único del hover: lo llaman el mapa (mousemove sobre la
     línea) y los 3 gráficos (onHover), así se mantienen sincronizados. */
  function setHoverD(d) {
    hoverD = d;
    if (elevChart) elevChart.update('none');
    if (speedChart) speedChart.update('none');
    if (hrChart) hrChart.update('none');
    _updateMapHover();
  }
  function _crosshairPlugin() {
    return {id: 'hoverCrosshair',
      afterDatasetsDraw(chart) {
        if (hoverD == null) return;
        const xScale = chart.scales.x, yScale = chart.scales.y;
        if (hoverD < xScale.min || hoverD > xScale.max) return;
        const ds = chart.data.datasets[0].data;
        if (!ds || !ds.length) return;
        let lo = 0, hi = ds.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (ds[mid].x < hoverD) lo = mid + 1; else hi = mid; }
        if (lo > 0 && Math.abs(ds[lo - 1].x - hoverD) < Math.abs(ds[lo].x - hoverD)) lo--;
        const x = xScale.getPixelForValue(hoverD), y = yScale.getPixelForValue(ds[lo].y);
        const c = chart.ctx;
        c.save();
        c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x, chart.chartArea.top); c.lineTo(x, chart.chartArea.bottom); c.stroke();
        c.fillStyle = chart.data.datasets[0].borderColor;
        c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#101a14'; c.lineWidth = 1.5; c.stroke();
        c.restore();
      }};
  }

  /* ── gráficas ──────────────────────────────────────────────────────────── */
  function photoElevPoints() {
    const tr = current.geojson, el = current.elevation;
    if (!tr.length || !el.length) return [];
    const cum = [0];
    for (let i = 1; i < tr.length; i++) {
      const [lo1, la1] = tr[i - 1], [lo2, la2] = tr[i];
      cum.push(cum[i - 1] + haversineM(la1, lo1, la2, lo2));
    }
    const cos0 = Math.cos(tr[0][1] * Math.PI / 180);
    return current.photos.filter(p => p.lat && p.lon).map(p => {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < tr.length; i++) {
        const dx = (tr[i][0] - p.lon) * cos0, dy = tr[i][1] - p.lat, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
      const dKm = cum[bi] / 1000;
      const ep = el.reduce((a, b) => Math.abs(b.d - dKm) < Math.abs(a.d - dKm) ? b : a);
      return {x: dKm, y: ep.e, photoId: p.public_id};
    });
  }

  function destroyCharts() {
    [elevChart, speedChart, hrChart].forEach(c => { if (c) { try { c.destroy(); } catch (e) {} } });
    elevChart = speedChart = hrChart = null;
  }

  function renderElev() {
    const ctx = $('#d-elev');
    if (elevChart) { elevChart.destroy(); elevChart = null; }
    const data = current.elevation;
    if (!data.length) { ctx.closest('.section').style.display = 'none'; return; }
    ctx.closest('.section').style.display = '';

    const svg = `<svg width="26" height="26" xmlns="http://www.w3.org/2000/svg"><circle cx="13" cy="13" r="11" fill="#e8c44a" stroke="#101a14" stroke-width="2.5"/><g transform="translate(6.5,7.5)"><rect x="0" y="2" width="13" height="9" rx="1.5" fill="#101a14"/><path d="M4 0h5l1 2H3z" fill="#101a14"/><circle cx="6.5" cy="6.5" r="2.3" fill="#e8c44a"/><circle cx="6.5" cy="6.5" r="1.1" fill="#101a14"/></g></svg>`;
    const photoIcon = new Image(26, 26);
    photoIcon.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
    const ppts = photoElevPoints();
    const iconPlugin = {id: 'photoIcons',
      afterDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(1);
        if (!meta || !meta.data || !meta.data.length) return;
        const c = chart.ctx;
        meta.data.forEach(el => c.drawImage(photoIcon, el.x - 13, el.y - 28, 26, 26));
      },
    };
    const sets = [{
      data: data.map(d => ({x: d.d, y: d.e})), fill: true, borderColor: '#d24a3a',
      backgroundColor: 'rgba(210,74,58,.15)', pointRadius: 0, borderWidth: 2, tension: .3,
    }];
    if (ppts.length) sets.push({
      type: 'scatter', data: ppts.map(p => ({x: p.x, y: p.y})),
      pointRadius: 14, pointHoverRadius: 14,
      backgroundColor: 'transparent', borderColor: 'transparent',
    });
    elevChart = new Chart(ctx, {type: 'line', data: {datasets: sets},
      plugins: [iconPlugin, _crosshairPlugin()],
      options: {
        maintainAspectRatio: false,
        onClick(e, els) {
          if (!els.length || els[0].datasetIndex !== 1) return;
          const idx = current.photos.findIndex(p => p.public_id === ppts[els[0].index].photoId);
          if (idx >= 0) openLightbox(idx);
        },
        onHover(e, els, chart) {
          ctx.style.cursor = els.length && els[0].datasetIndex === 1 ? 'pointer' : 'default';
          const d = chart.scales.x.getValueForPixel(e.x);
          if (d != null && !isNaN(d)) setHoverD(Math.max(chart.scales.x.min, Math.min(chart.scales.x.max, d)));
        },
        plugins: {legend: {display: false}, tooltip: {callbacks: {
          label(c) {
            if (c.datasetIndex === 1) return `📷 ${Math.round(ppts[c.dataIndex].y)} m`;
            return `${Math.round(c.raw.y)} m`;
          },
          title(items) { return `${Number(items[0].raw.x).toFixed(2)} km`; },
        }}},
        scales: {
          x: {type: 'linear', min: 0, max: data[data.length - 1].d,
              title: {display: true, text: 'km', color: '#8aa394'},
              ticks: {color: '#8aa394', maxTicksLimit: 8}, grid: {color: '#2c4435'}},
          y: {title: {display: true, text: 'm', color: '#8aa394'},
              ticks: {color: '#8aa394'}, grid: {color: '#2c4435'}},
        },
      },
    });
    // Asignación directa, NO addEventListener: renderElev/renderSpeed/renderHR
    // destruyen y recrean el Chart en cada renderAll() reutilizando el mismo
    // <canvas>, así que los listeners se irían acumulando.
    ctx.onmouseleave = () => setHoverD(null);
    ctx.ontouchend = () => setHoverD(null);   // en táctil no hay mouseleave
  }

  function renderSpeed() {
    const section = q('#speed-section');
    const data = current.speed;
    if (speedChart) { speedChart.destroy(); speedChart = null; }
    if (!data || !data.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    const ctx = q('#speed-chart');
    speedChart = new Chart(ctx, {type: 'line', plugins: [_crosshairPlugin()],
      data: {datasets: [{
        data: data.map(d => ({x: d.d, y: d.v})), fill: true,
        borderColor: '#3a9ed8', backgroundColor: 'rgba(58,158,216,.12)',
        pointRadius: 0, borderWidth: 1.5, tension: .3,
      }]},
      options: {
        maintainAspectRatio: false,
        onHover(e, els, chart) {
          const d = chart.scales.x.getValueForPixel(e.x);
          if (d != null && !isNaN(d)) setHoverD(Math.max(chart.scales.x.min, Math.min(chart.scales.x.max, d)));
        },
        plugins: {legend: {display: false}, tooltip: {callbacks: {
          label(c) { return `${c.raw.y.toFixed(1)} km/h`; },
          title(items) { return `${Number(items[0].raw.x).toFixed(2)} km`; },
        }}},
        scales: {
          x: {type: 'linear', min: 0, max: data[data.length - 1].d,
              title: {display: true, text: 'km', color: '#8aa394'},
              ticks: {color: '#8aa394', maxTicksLimit: 8}, grid: {color: '#2c4435'}},
          y: {title: {display: true, text: 'km/h', color: '#8aa394'},
              ticks: {color: '#8aa394'}, grid: {color: '#2c4435'}},
        },
      }});
    ctx.onmouseleave = () => setHoverD(null);
    ctx.ontouchend = () => setHoverD(null);
  }

  function renderHR() {
    const section = q('#hr-section');
    const data = current.heart_rate;
    if (hrChart) { hrChart.destroy(); hrChart = null; }
    if (!data || !data.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    const ctx = q('#hr-chart');
    hrChart = new Chart(ctx, {type: 'line', plugins: [_crosshairPlugin()],
      data: {datasets: [{
        data: data.map(d => ({x: d.d, y: d.hr})), fill: true,
        borderColor: '#e05252', backgroundColor: 'rgba(224,82,82,.12)',
        pointRadius: 0, borderWidth: 1.5, tension: .3,
      }]},
      options: {
        maintainAspectRatio: false,
        onHover(e, els, chart) {
          const d = chart.scales.x.getValueForPixel(e.x);
          if (d != null && !isNaN(d)) setHoverD(Math.max(chart.scales.x.min, Math.min(chart.scales.x.max, d)));
        },
        plugins: {legend: {display: false}, tooltip: {callbacks: {
          label(c) { return `${Math.round(c.raw.y)} bpm`; },
          title(items) { return `${Number(items[0].raw.x).toFixed(2)} km`; },
        }}},
        scales: {
          x: {type: 'linear', min: 0, max: data[data.length - 1].d,
              title: {display: true, text: 'km', color: '#8aa394'},
              ticks: {color: '#8aa394', maxTicksLimit: 8}, grid: {color: '#2c4435'}},
          y: {title: {display: true, text: 'bpm', color: '#8aa394'},
              ticks: {color: '#8aa394'}, grid: {color: '#2c4435'}},
        },
      }});
    ctx.onmouseleave = () => setHoverD(null);
    ctx.ontouchend = () => setHoverD(null);
  }

  /* ── galería ───────────────────────────────────────────────────────────── */
  function renderGallery() {
    const g = $('#d-gallery');
    g.innerHTML = '';
    current.photos.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.dataset.photoid = p.public_id;
      d.onclick = () => openLightbox(i);
      d.innerHTML = `<img src="/api/photos/${encodeURIComponent(p.public_id)}/file" loading="lazy">
        ${p.lat ? '<span class="geo">GPS</span>' : ''}`;
      // El botón se engancha desde JS, no con onclick=: public_id es una cadena
      // opaca ("aB3_x9Qk"), y en un atributo quedaría como identificador suelto.
      const btn = document.createElement('button');
      btn.className = 'del';
      btn.textContent = '✕';
      btn.onclick = ev => delPhoto(p.public_id, ev);
      d.appendChild(btn);
      g.appendChild(d);
    });
  }

  /* ── aviso de posible duplicada ────────────────────────────────────────── */
  function renderDupBanner() {
    const b = q('#dup-banner');
    if (!current.dup_suspect_of) { b.style.display = 'none'; return; }
    const nm = current.dup_suspect_name || ('ruta #' + current.dup_suspect_of);
    // Enlace por public_id (URL canónica) y con data-nav: navega por el router
    // sin recargar, aunque sea de un detalle a otro.
    const link = current.dup_suspect_public
      ? `<a href="/Sendero/${encodeURIComponent(current.dup_suspect_public)}"
            data-nav="/Sendero/${encodeURIComponent(current.dup_suspect_public)}">«${esc(nm)}»</a>`
      : `«${esc(nm)}»`;
    b.innerHTML = `<span>⚠ Importada automáticamente y se parece mucho a ${link}. `
      + `Revísala: si es la misma, bórrala o fusiónala; si no, descarta el aviso.</span>`
      + `<button class="btn ghost sm" onclick="SEC.detalle.dismissDup()">Descartar aviso</button>`;
    b.style.display = 'flex';
  }

  async function dismissDup() {
    const r = await Store.patch(`/api/routes/${pid}`, {dup_suspect_of: null},
                                {label: 'descartar aviso de duplicada'});
    if (!r.ok) { toast('Error al descartar el aviso'); return; }
    current.dup_suspect_of = null;
    await saveLocal();
    renderDupBanner();
    toast(r.queued ? 'Aviso descartado (se enviará al recuperar conexión)' : 'Aviso descartado');
  }

  /* Persiste en local el detalle que acabamos de modificar y avisa al listado.
     Sin esto, un cambio hecho sin conexión se vería revertido al volver a la
     vista: el PATCH está en la cola, pero la copia local seguiría siendo la del
     servidor. */
  async function saveLocal() {
    try { await Store.putDetail(pid, current, {lite: _lite}); } catch (e) {}
  }

  /* Recarga el detalle desde el servidor. Lo usan las acciones cuyo resultado el
     cliente no puede calcular (reescanear, subir fotos, asociar Immich): el rev
     del listado aún no ha llegado por la sincronización, así que hay que forzar.
     Si la red falla a mitad se conserva lo que ya había en pantalla. */
  async function reload() {
    try {
      const data = await Store.route(pid, {lite: _lite, refresh: true});
      if (data) current = data;
    } catch (e) {
      toast('Guardado, pero no se pudo refrescar la ruta');
      return false;
    }
    Store.syncNow({force: true});
    return true;
  }

  /* ── acciones ──────────────────────────────────────────────────────────── */
  async function saveNotes() {
    const notes = $('#d-notes').value;
    const r = await Store.patch(`/api/routes/${pid}`, {notes}, {label: 'resumen de la ruta'});
    if (!r.ok) { toast('Error al guardar el resumen'); return; }
    current.notes = notes;
    await saveLocal();
    toast(r.queued ? 'Resumen guardado (se enviará al recuperar conexión)' : 'Resumen guardado');
  }

  async function rescanRoute(btn) {
    if (!needOnline('Reescanear necesita conexión')) return;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Escaneando…';
    try {
      const res = await fetch(`/api/routes/${pid}/rescan`, {method: 'POST'});
      if (!res.ok) {
        let j = {};
        try { j = await res.json(); } catch (e) {}
        toast(j.error || 'Error al reescanear');
        return;
      }
      if (!await reload()) return;
      renderAll();
      toast('Datos actualizados desde el archivo');
    } catch (e) { toast('Error de red'); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }

  async function renameRoute() {
    const n = prompt('Nuevo nombre:', current.name);
    if (!n || n === current.name) return;
    const r = await Store.patch(`/api/routes/${pid}`, {name: n}, {label: 'nombre de la ruta'});
    if (!r.ok) { toast('Error al renombrar'); return; }
    current.name = n;
    $('#d-name').textContent = n;
    document.title = `${n} – Sendero`;
    /* La URL canónica es el public_id: renombrar ya no cambia la URL (antes se
       hacía history.replaceState porque la ruta iba por nombre). */
    await saveLocal();
    toast(r.queued ? 'Nombre guardado (se enviará al recuperar conexión)' : 'Renombrada');
  }

  async function removeRoute() {
    if (!confirm('¿Eliminar esta ruta y sus fotos?')) return;
    // Un borrado no se encola: es destructivo y no se puede deshacer si el
    // servidor ya tenía otra cosa.
    if (!needOnline('Eliminar necesita conexión')) return;
    let res;
    try { res = await fetch(`/api/routes/${pid}`, {method: 'DELETE'}); }
    catch (e) { toast('Eliminar necesita conexión'); return; }
    if (!res.ok) { toast('Error al eliminar'); return; }
    Store.syncNow({force: true});
    go('/rutas');
  }

  async function delPhoto(id, ev) {
    if (ev) ev.stopPropagation();
    if (!needOnline('Borrar una foto necesita conexión')) return;
    const res = await fetch(`/api/photos/${encodeURIComponent(id)}`, {method: 'DELETE'});
    if (!res.ok) { toast('Error al borrar la foto'); return; }
    const el = q(`.thumb[data-photoid="${id}"]`);
    if (el) el.remove();
    const idx = current.photos.findIndex(p => p.public_id === id);
    if (idx !== -1) current.photos.splice(idx, 1);
    if (photoMarkers[id]) { try { photoMarkers[id].remove(); } catch (e) {} delete photoMarkers[id]; }
    if (!q('#lb-overlay').classList.contains('hidden')) closeLightbox();
    await saveLocal();
    Store.syncNow({force: true});
    toast('Foto eliminada');
  }

  function openEditor() { go(`/Sendero/${encodeURIComponent(pid)}/editor`); }

  function downloadGpx() {
    const a = document.createElement('a');
    a.href = `/api/routes/${encodeURIComponent(pid)}/gpx?download=1`;
    a.click();
  }

  /* ── subida de fotos ───────────────────────────────────────────────────── */
  async function uploadPhotos(files) {
    if (!files || !files.length || !current) return;
    if (!needOnline('Subir fotos necesita conexión')) return;
    const fd = new FormData();
    [...files].forEach(f => fd.append('photos', f));
    toast('Subiendo fotos…');
    try {
      const res = await fetch(`/api/routes/${pid}/photos`, {method: 'POST', body: fd});
      if (!res.ok) { toast('Error al subir las fotos'); return; }
    } catch (e) { toast('Error de red al subir las fotos'); return; }
    if (!await reload()) return;
    renderMap(); renderElev(); renderGallery();
    const pin = $('#d-photo-input');
    if (pin) pin.value = '';
  }

  /* ── Immich ────────────────────────────────────────────────────────────── */
  async function loadConfig() {
    if (_cfgLoaded) return;
    try {
      const c = await (await fetch('/api/config')).json();
      IMMICH = !!c.immich;
      if (c.immich_dist_m != null) IMMICH_DIST_M = c.immich_dist_m;
      _cfgLoaded = true;
    } catch (e) {}
    const btn = q('#immich-btn');
    if (btn) btn.classList.toggle('hidden', !IMMICH);
  }

  async function autoSearchImmich() {
    if (!Store.isOnline()) return;
    try {
      const res = await fetch(`/api/routes/${pid}/immich/candidates`);
      if (!res.ok) return;
      const data = await res.json();
      immichCands = data.candidates || [];
      if (!immichCands.length) return;
      // hay candidatos: autoseleccionar las que estén dentro de IMMICH_DIST_M
      immichSel.clear();
      immichCands.forEach((c, i) => {
        if (c.dist_m != null && c.dist_m <= IMMICH_DIST_M) immichSel.add(i);
      });
      q('#immich-modal').classList.remove('hidden');
      q('#immich-grid').innerHTML = '';
      const withGps = immichCands.filter(c => c.dist_m != null).length;
      q('#immich-status').textContent = `${immichCands.length} foto(s) durante la ruta · ${withGps} con GPS. Toca para seleccionar.`;
      q('#immich-count').textContent = immichSel.size ? `${immichSel.size} seleccionada(s) (≤${IMMICH_DIST_M} m)` : '';
      q('#near-wrap').classList.toggle('hidden', withGps === 0);
      q('#near-only').checked = false;
      renderImmich();
    } catch (e) {}
  }

  async function openImmich() {
    if (!needOnline('Buscar en Immich necesita conexión')) return;
    immichSel.clear();
    q('#immich-modal').classList.remove('hidden');
    q('#immich-grid').innerHTML = '';
    q('#near-wrap').classList.add('hidden');
    q('#immich-status').textContent = 'Buscando fotos en Immich…';
    q('#immich-count').textContent = '';
    const res = await fetch(`/api/routes/${pid}/immich/candidates`);
    const data = await res.json();
    if (!res.ok) { q('#immich-status').textContent = data.error || 'Error al consultar Immich'; return; }
    immichCands = data.candidates;
    if (!immichCands.length) {
      q('#immich-status').textContent = 'No hay fotos en Immich dentro del horario de esta ruta.';
      return;
    }
    const withGps = immichCands.filter(c => c.dist_m != null).length;
    q('#immich-status').textContent = `${immichCands.length} foto(s) durante la ruta · ${withGps} con GPS. Toca para seleccionar.`;
    q('#near-wrap').classList.toggle('hidden', withGps === 0);
    q('#near-only').checked = false;
    renderImmich();
  }

  function renderImmich() {
    const onlyNear = q('#near-only').checked;
    const g = q('#immich-grid');
    g.innerHTML = '';
    immichCands.forEach((c, i) => {
      if (onlyNear && c.dist_m != null && c.dist_m > NEAR_M) return;
      const d = document.createElement('div');
      d.className = 'pick' + (immichSel.has(i) ? ' on' : '');
      d.dataset.i = i;
      const label = c.dist_m == null ? 'sin GPS'
        : c.dist_m < 1000 ? `a ${c.dist_m} m` : `a ${(c.dist_m / 1000).toFixed(1)} km`;
      d.innerHTML = `<img loading="lazy" src="/api/immich/thumb/${c.immich_id}">
        <span class="check">✓</span><span class="gps">${label}</span>`;
      d.onclick = () => togglePick(i, d);
      g.appendChild(d);
    });
  }

  function togglePick(i, el) {
    if (immichSel.has(i)) { immichSel.delete(i); el.classList.remove('on'); }
    else { immichSel.add(i); el.classList.add('on'); }
    q('#immich-count').textContent = immichSel.size ? `${immichSel.size} seleccionada(s)` : '';
  }

  async function confirmImmich() {
    if (!immichSel.size) { closeImmich(); return; }
    const items = [...immichSel].map(i => immichCands[i]);
    const res = await fetch(`/api/routes/${pid}/immich/select`, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({items})});
    if (!res.ok) { toast('Error al añadir las fotos'); return; }
    closeImmich();
    toast(`${items.length} foto(s) añadidas`);
    if (!await reload()) return;
    renderMap(); renderElev(); renderGallery();
  }

  function closeImmich() {
    q('#immich-modal').classList.add('hidden');
    if (current && !current.immich_checked) {
      current.immich_checked = true;
      Store.patch(`/api/routes/${pid}`, {immich_checked: 1}, {label: 'Immich revisado'})
        .catch(() => {});
    }
  }

  function selectAllImmich() {
    const onlyNear = q('#near-only').checked;
    immichCands.forEach((c, i) => {
      if (onlyNear && c.dist_m != null && c.dist_m > NEAR_M) return;
      immichSel.add(i);
    });
    renderImmich();
    q('#immich-count').textContent = immichSel.size ? `${immichSel.size} seleccionada(s)` : '';
  }

  /* ── lightbox ──────────────────────────────────────────────────────────── */
  function openLightbox(idx) {
    lbIdx = idx;
    const p = current.photos[lbIdx];
    if (!p) return;
    q('#lb-img').src = `/api/photos/${encodeURIComponent(p.public_id)}/file`;
    q('#lb-counter').textContent = `${lbIdx + 1} / ${current.photos.length}`;
    const mul = current.photos.length > 1;
    q('.lb-prev').style.display = mul ? '' : 'none';
    q('.lb-next').style.display = mul ? '' : 'none';
    q('#lb-overlay').classList.remove('hidden');
  }
  function closeLightbox() { q('#lb-overlay').classList.add('hidden'); }
  function lbNav(dir) {
    if (!current || !current.photos.length) return;
    lbIdx = (lbIdx + dir + current.photos.length) % current.photos.length;
    openLightbox(lbIdx);
  }
  async function lbDelete() {
    if (!current || !current.photos[lbIdx]) return;
    const id = current.photos[lbIdx].public_id;
    if (!needOnline('Borrar una foto necesita conexión')) return;
    const res = await fetch(`/api/photos/${encodeURIComponent(id)}`, {method: 'DELETE'});
    if (!res.ok) { toast('Error al borrar la foto'); return; }
    const el = q(`.thumb[data-photoid="${id}"]`);
    if (el) el.remove();
    current.photos.splice(lbIdx, 1);
    if (photoMarkers[id]) { try { photoMarkers[id].remove(); } catch (e) {} delete photoMarkers[id]; }
    await saveLocal();
    Store.syncNow({force: true});
    toast('Foto eliminada');
    if (current.photos.length === 0) { closeLightbox(); return; }
    lbIdx = Math.min(lbIdx, current.photos.length - 1);
    openLightbox(lbIdx);
  }

  /* ── montaje ───────────────────────────────────────────────────────────── */
  function showMessage(msg) {
    $('#d-name').textContent = msg;
    $('#d-stats').innerHTML = '';
    $('#d-auto').textContent = '';
    $('#d-gallery').innerHTML = '';
  }

  function renderAll() {
    $('#d-name').textContent = current.name;
    document.title = `${current.name} – Sendero`;
    $('#d-date').textContent = fmtDate(current.started_at);
    const loc = $('#d-loc');
    if (current.locality) { $('#d-loc-text').textContent = current.locality; loc.style.display = 'inline-flex'; }
    else { loc.style.display = 'none'; }
    const dev = $('#d-device');
    if (current.device) { dev.textContent = '· ' + current.device; dev.style.display = ''; }
    else { dev.style.display = 'none'; }
    $('#d-auto').textContent = current.auto_summary || '';
    $('#d-notes').value = current.notes || '';
    const ibtn = q('#immich-btn');
    if (ibtn) ibtn.classList.toggle('hidden', !IMMICH);
    renderActivity(); renderDupBanner();
    renderStats(); renderMap(); renderElev(); renderSpeed(); renderHR(); renderGallery();
    window.scrollTo(0, 0);
  }

  /* Deja la sección como recién cargada. Necesario también al montar, no solo al
     desmontar: se puede ir de un detalle a otro (enlace del aviso de duplicada)
     y el router no desmonta cuando la sección es la misma. */
  function resetView() {
    destroyMap();
    destroyCharts();
    closeActivityPicker();
    closeLightbox();
    q('#immich-modal').classList.add('hidden');
    q('#dup-banner').style.display = 'none';
    q('#d-actions-more').classList.remove('open');
    immichCands = []; immichSel = new Set();
    hoverD = null; trackCumKm = []; lbIdx = 0;
    map3dMode = false;
  }

  async function mount(params, opts) {
    const tok = ++_tok;
    resetView();
    pid = params.id;
    current = null;
    showMessage('Cargando…');
    // La config de Immich hace falta antes del flujo automático, pero no debe
    // bloquear el pintado del detalle.
    const cfgP = loadConfig();
    let data;
    try {
      const bootstrap = (opts && opts.bootstrap) || null;
      data = await Store.route(pid, {lite: true, bootstrap});
    } catch (e) {
      if (tok === _tok) showMessage('No se pudo cargar esta ruta sin conexión.');
      return;
    }
    if (tok !== _tok) return;                  // se navegó a otra vista mientras cargaba
    if (!data) { showMessage('Ruta no encontrada.'); return; }
    current = data;
    _lite = !!data.lite;
    renderAll();
    await cfgP;
    if (tok !== _tok || !current) return;
    const ibtn = q('#immich-btn');
    if (ibtn) ibtn.classList.toggle('hidden', !IMMICH);
    // flujo de incorporación automática
    if (!current.activity_type) {
      // tras elegir, setActivity() dispara autoSearchImmich si procede
      openActivityPicker();
    } else if (!current.photos.length && IMMICH && !current.immich_checked) {
      autoSearchImmich();
    }
  }

  function unmount() {
    _tok++;                                    // invalida cualquier carga en vuelo
    resetView();
    current = null; pid = null;
  }

  /* Listeners de documento: se registran UNA vez (loader.js ejecuta este script
     una sola vez), nunca por montaje, para no acumularlos en cada visita. */
  document.addEventListener('keydown', e => {
    const lb = q('#lb-overlay');
    if (!lb || lb.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') lbNav(-1);
    else if (e.key === 'ArrowRight') lbNav(1);
    else if (e.key === 'Escape') closeLightbox();
  });
  document.addEventListener('keydown', e => {
    const lb = q('#lb-overlay');
    if (e.key !== 'Escape' || !lb || !lb.classList.contains('hidden')) return;
    if (!q('#immich-modal').classList.contains('hidden')) closeImmich();
    else if (!$('#d-activity-modal').classList.contains('hidden')) closeActivityPicker();
  });
  // Cierre por tap/click en el fondo y swipe táctil en el lightbox
  q('#lb-overlay').addEventListener('click', e => {
    if (e.target.id === 'lb-overlay') closeLightbox();
  });
  let _lbTx = null, _lbTy = null;
  q('#lb-overlay').addEventListener('touchstart', e => {
    const t = e.touches[0]; _lbTx = t.clientX; _lbTy = t.clientY;
  }, {passive: true});
  q('#lb-overlay').addEventListener('touchend', e => {
    if (_lbTx == null || !current) return;
    const t = e.changedTouches[0], dx = t.clientX - _lbTx, dy = t.clientY - _lbTy;
    _lbTx = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && current.photos.length > 1) {
      lbNav(dx < 0 ? 1 : -1);
    }
  }, {passive: true});
  q('#immich-modal').addEventListener('click', e => {
    if (e.target.id === 'immich-modal') closeImmich();
  });
  $('#d-activity-modal').addEventListener('click', e => {
    if (e.target.id === 'd-activity-modal') closeActivityPicker();
  });
  // zona de subida de fotos
  (() => {
    const drop = $('#d-drop'), pin = $('#d-photo-input');
    if (!drop || !pin) return;
    drop.onclick = () => pin.click();
    pin.onchange = () => uploadPhotos(pin.files);
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', e => uploadPhotos(e.dataTransfer.files));
  })();

  window.SEC.detalle = {
    mount, unmount,
    openActivityPicker, closeActivityPicker, setActivity,
    toggle3D, saveNotes, rescanRoute, renameRoute, removeRoute, downloadGpx,
    openEditor, dismissDup, delPhoto,
    openImmich, closeImmich, renderImmich, confirmImmich, selectAllImmich,
    openLightbox, closeLightbox, lbNav, lbDelete,
  };
})();
