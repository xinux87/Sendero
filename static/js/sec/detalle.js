/* Sección `detalle`: detalle de una ruta.
   Portado de la app multipágina (`git show v0.7.1:templates/sendero.html`).
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

  /* ── actividad ─────────────────────────────────────────────────────────────
     El chip vive SOBRE el mapa cabecera (rediseño 2a/2d), así que lleva fondo
     translúcido oscuro: encima de una capa satélite el color solo no se leería. */
  function renderActivity() {
    const a = activityOf(current.activity_type);
    const el = $('#d-activity-badge-sm');
    if (!el) return;
    el.innerHTML = a
      ? `<span class="act-badge" onclick="SEC.detalle.openActivityPicker()"
           style="background:rgba(11,18,14,.55);color:${a.color}">
           <span class="ico">${iconSvg(a, 24)}</span>${esc(a.label)}</span>`
      : `<span class="act-badge" onclick="SEC.detalle.openActivityPicker()"
           style="background:rgba(11,18,14,.55);border-color:var(--line-strong);color:var(--muted)">
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

  /* ── banda de métricas ─────────────────────────────────────────────────────
     Siete tarjetas en el orden del rediseño (Distancia · Desnivel + · Desnivel −
     · Altitud máx · En movimiento · Vel. media · FC). La primera lleva el borde
     izquierdo del color de la actividad y la cifra en ámbar (clase .acc).
     La actividad ya no es una tarjeta: se cambia desde el chip de la cabecera. */
  function renderStats() {
    const r = current;
    const a = activityOf(r.activity_type);
    const items = [
      ['Distancia', fmtKm(r.distance_m), 'km', true],
      ['Desnivel +', fmtNum(r.ascent_m), 'm'],
      ['Desnivel −', fmtNum(r.descent_m), 'm'],
      ['Altitud máx', fmtNum(r.ele_max), 'm'],
      ['En movimiento', fmtHM(r.moving_s || r.duration_s), ''],
      ['Vel. media', r.avg_speed ? r.avg_speed.toFixed(1) : '–', 'km/h'],
    ];
    if (r.hr_avg) items.push(['FC media', Math.round(r.hr_avg), 'bpm']);
    if (r.hr_max) items.push(['FC máx', Math.round(r.hr_max), 'bpm']);
    $('#d-stats').innerHTML = items.map(([l, v, u, acc]) =>
      `<div class="stat${acc ? ' acc' : ''}"${acc ? ` style="border-left-color:${(a || {}).color || 'var(--pr-yellow)'}"` : ''}>
         <div class="l">${l}</div>
         <div class="v">${v}${u ? ` <small>${u}</small>` : ''}</div></div>`
    ).join('');
  }

  /* ── datos técnicos ───────────────────────────────────────────────────────
     Solo campos que la ruta tiene de verdad: los que el modelo no guarda
     (cadencia, temperatura) no se inventan, se omiten. */
  function renderTech() {
    const r = current;
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '' && v !== '–') rows.push([k, v]); };
    add('Tiempo total', r.duration_s ? fmtHMS(r.duration_s) : null);
    if (r.duration_s && r.moving_s && r.duration_s - r.moving_s > 30) {
      add('En pausa', fmtHMS(r.duration_s - r.moving_s));
    }
    if (r.distance_m && r.moving_s) add('Ritmo medio', fmtPace(r.moving_s / (r.distance_m / 1000)));
    const vmax = _maxOf(r.speed, 'v');
    add('Vel. máx', vmax != null ? `${vmax.toFixed(1)} km/h` : null);
    add('Altitud mín', r.ele_min != null ? `${fmtNum(r.ele_min)} m` : null);
    add('Puntos GPS', r.n_points ? fmtNum(r.n_points) : null);
    add('Formato', /\.fit$/i.test(r.gpx_file || '') ? 'FIT' : 'GPX');
    add('Versión', r.version ? `v${r.version}` : 'Archivo original');
    add('Importada', r.created_at ? fmtDate(r.created_at) : null);
    $('#d-tech').innerHTML = rows.map(([k, v]) =>
      `<div class="kv-row"><span class="kv-k">${esc(k)}</span>` +
      `<span class="kv-v" title="${esc(String(v))}">${esc(String(v))}</span></div>`).join('');
  }

  function _maxOf(arr, key) {
    if (!arr || !arr.length) return null;
    let m = -Infinity;
    arr.forEach(p => { if (p[key] > m) m = p[key]; });
    return isFinite(m) ? m : null;
  }

  /* ── calidad del track ────────────────────────────────────────────────────
     Los avisos son los `gps_issues` que calcula core/gps_analysis.py con los
     umbrales de la actividad (Ajustes → "GPS incorrecto"); quien los arregla es
     el editor, así que la acción de cada aviso lleva allí. */
  const _ISSUE_TXT = {
    speed: i => `Salto de GPS: <b>${Math.round(i.value_max)} km/h</b> en el km `
              + `${i.d_from.toFixed(1)}–${i.d_to.toFixed(1)} (umbral ${Math.round(i.threshold)})`,
    elevation: i => `Pico de elevación: <b>${i.value_max.toFixed(1)} m/s</b> de ascenso en el km `
              + `${i.d_from.toFixed(1)}–${i.d_to.toFixed(1)} (umbral ${i.threshold})`,
    altitude: i => `Altitud imposible: <b>${fmtNum(i.value_max)} m</b> en el km `
              + `${i.d_from.toFixed(1)}–${i.d_to.toFixed(1)} (máx ${fmtNum(i.threshold)})`,
  };
  const _ICO_WARN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#e3b23c" stroke-width="1.9"><path d="M12 9v5m0 3.5v.01M10.3 3.9 2.5 18a1.7 1.7 0 0 0 1.5 2.6h16a1.7 1.7 0 0 0 1.5-2.6L13.7 3.9a1.7 1.7 0 0 0-3.4 0z"/></svg>';
  const _ICO_INFO = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8fb69f" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/></svg>';

  function renderQuality() {
    const issues = current.gps_issues || [];
    const badge = q('#d-quality-badge'), body = q('#d-quality-body');
    if (!issues.length) {
      badge.textContent = '';
      badge.style.display = 'none';
      body.innerHTML = '<div class="d-ok">Sin errores detectados.</div>';
      return;
    }
    badge.style.display = '';
    badge.textContent = issues.length === 1 ? '1 AVISO' : `${issues.length} AVISOS`;
    body.innerHTML = issues.map(i => {
      const txt = (_ISSUE_TXT[i.type] || (x => `Aviso en el km ${x.d_from.toFixed(1)}`))(i);
      const crit = i.severity === 'high';
      return `<div class="warn ${crit ? 'crit' : 'info'}">${crit ? _ICO_WARN : _ICO_INFO}
        <div>${txt}<br>
        <button class="link-btn" onclick="SEC.detalle.openEditor()">Corregir en el editor</button></div></div>`;
    }).join('');
  }

  /* ── cabecera del bloque de fotos ─────────────────────────────────────── */
  function renderPhotosHead() {
    const n = current.photos.length;
    const deImmich = current.photos.filter(p => p.immich_id).length;
    const cnt = q('#d-photos-count'), link = q('#d-gallery-link'), all = q('#d-photos-all');
    cnt.textContent = !n ? 'Ninguna todavía'
      : `${n} · ${deImmich === n ? 'REFERENCIADAS DESDE IMMICH'
                : deImmich ? `${deImmich} DESDE IMMICH` : 'LOCALES'}`;
    link.style.display = n ? '' : 'none';
    all.textContent = n === 1 ? 'Ver la foto' : `Ver las ${n} fotos`;
    all.style.display = n ? '' : 'none';
  }

  /* ── pestañas del móvil ───────────────────────────────────────────────────
     En pantalla grande no se ven (el CSS solo las activa por debajo de 768 px),
     así que cambiar de pestaña ahí no tiene efecto visible. Tras mostrar un
     panel oculto hay que redimensionar sus Charts: mientras estuvo en
     display:none su canvas medía 0. */
  function setTab(name) {
    const sec = document.getElementById('sec-detalle');
    if (!sec) return;
    sec.dataset.tab = name;
    sec.querySelectorAll('.d-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'perfil') {
      [elevChart, speedChart, hrChart].forEach(c => { if (c) { try { c.resize(); } catch (e) {} } });
    }
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
      /* OJO, y esto costó un bug de meses: NO se puede mover la cámara en el
         mismo tick en el que se activa el terreno. Haciendo
             map.setTerrain(...); map.easeTo({pitch:60});
         el mapa se queda COMPLETAMENTE NEGRO y no se recupera — el terreno
         todavía no tiene su primera tesela de DEM cuando la cámara se
         reproyecta, y la transformación queda en un estado inservible. Da igual
         la duración de la animación: con duration:0 pasa lo mismo.

         Así que primero se inclina y el relieve se enciende al acabar el
         movimiento. De paso queda mejor (el mapa se ladea y luego "crece" el
         relieve), y si el DEM no llegara nunca —sin internet— lo peor que pasa
         es que se queda la vista inclinada en 2D en vez de un rectángulo negro. */
      map.easeTo({pitch: 60, duration: 800});
      map.once('moveend', () => {
        if (map3dMode && map) map.setTerrain({source: 'terrain', exaggeration: 1.5});
      });
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
    addGeolocate(map, 'top-right');
    // selector de capas (top-left, arriba: es lo que pide el rediseño)
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
    // botón centrar (top-left, debajo del selector)
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
    // botón mapa ampliado al 80 % del alto de la pantalla (top-left, debajo del
    // centrar). Alterna la clase d-hero-full: el mapa sigue en el flujo del
    // documento, así que la página no pierde el scroll. El estado vive en el DOM
    // (.d-hero sobrevive a renderMap), por eso paint() lo lee en vez de guardarlo aquí.
    // Iconos en SVG inline (no glifos Unicode: ⛶ falta en muchas fuentes).
    const ICO_FULL = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 1.5h11M2 13.5h11M7.5 4.5v6M5.5 6.5l2-2 2 2M5.5 8.5l2 2 2-2"/></svg>';
    const ICO_BACK = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7.5h11M7.5 1.5v3M5.5 3l2 2 2-2M7.5 13.5v-3M5.5 12l2-2 2 2"/></svg>';
    map.addControl({
      onAdd() {
        const c = document.createElement('div');
        c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const b = document.createElement('button');
        b.style.cssText = 'width:29px;height:29px;cursor:pointer;border:none;background:none;padding:0;display:flex;align-items:center;justify-content:center';
        const paint = () => {
          const full = q('.d-hero').classList.contains('d-hero-full');
          b.innerHTML = full ? ICO_BACK : ICO_FULL;
          b.title = full ? 'Restaurar la altura del mapa' : 'Ampliar el mapa al 80 % de la pantalla';
        };
        b.onclick = () => {
          const hero = q('.d-hero');
          const full = hero.classList.toggle('d-hero-full');
          paint();
          if (map) map.resize();
          if (full) hero.scrollIntoView({behavior: 'smooth', block: 'start'});
        };
        paint();
        c.appendChild(b); return c;
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

  /* ── estilo común de las 3 gráficas (rediseño) ───────────────────────────
     Rejilla casi invisible, ejes en mono y sin títulos: la unidad ya la dice el
     título del panel ("Velocidad · km/h"). */
  const GRID = 'rgba(236,229,216,.07)';
  const TICK = {color: '#68786d', font: {family: "'IBM Plex Mono',monospace", size: 10}};
  function _scales(data, xKey, yKey, {yTicks = true} = {}) {
    return {
      x: {type: 'linear', min: 0, max: data[data.length - 1][xKey],
          ticks: {...TICK, maxTicksLimit: 8}, grid: {color: GRID, drawTicks: false},
          border: {display: false}},
      y: {ticks: yTicks ? {...TICK, callback: v => fmtNum(v)} : {display: false},
          grid: {color: GRID, drawTicks: false}, border: {display: false}},
    };
  }
  /* Relleno del perfil: degradado del color de la actividad (.38 → 0), como el
     prototipo. Scriptable porque necesita el chartArea, que no existe hasta el
     primer layout. */
  function _areaGradient(chart, hex) {
    const {ctx, chartArea} = chart;
    if (!chartArea) return 'transparent';
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, hex + '61');      // 0x61 ≈ 38 %
    g.addColorStop(1, hex + '00');
    return g;
  }
  /* Subtítulo del perfil: "2 083 m salida · 3 404 m cima · pendiente máx. 34 %".
     La pendiente se mide sobre tramos de al menos 30 m para que el ruido del GPS
     no dé porcentajes absurdos. */
  function _elevSub(data) {
    if (!data.length) return '';
    let max = data[0].e, slope = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i].e > max) max = data[i].e;
      const dx = (data[i].d - data[i - 1].d) * 1000;
      if (dx >= 30) slope = Math.max(slope, (data[i].e - data[i - 1].e) / dx * 100);
    }
    return `${fmtNum(data[0].e)} m salida · ${fmtNum(max)} m cima`
         + (slope > 0 ? ` · pendiente máx. ${Math.round(slope)} %` : '');
  }

  function renderElev() {
    const ctx = $('#d-elev');
    if (elevChart) { elevChart.destroy(); elevChart = null; }
    const data = current.elevation;
    const panel = ctx.closest('.panel');
    if (!data.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    q('#d-elev-sub').textContent = _elevSub(data);
    const actColor = (activityOf(current.activity_type) || {}).color || '#e8863c';

    const svg = `<svg width="26" height="26" xmlns="http://www.w3.org/2000/svg"><circle cx="13" cy="13" r="11" fill="#e3b23c" stroke="#0b120e" stroke-width="2.5"/><g transform="translate(6.5,7.5)"><rect x="0" y="2" width="13" height="9" rx="1.5" fill="#0b120e"/><path d="M4 0h5l1 2H3z" fill="#0b120e"/><circle cx="6.5" cy="6.5" r="2.3" fill="#e3b23c"/><circle cx="6.5" cy="6.5" r="1.1" fill="#0b120e"/></g></svg>`;
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
      data: data.map(d => ({x: d.d, y: d.e})), fill: true, borderColor: '#f0b070',
      backgroundColor: c => _areaGradient(c.chart, actColor),
      pointRadius: 0, borderWidth: 2, tension: .3,
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
        scales: _scales(data, 'd', 'e'),
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
    // Pie del panel: "media 3.1 · máx 9.4 · en movimiento 84 %"
    const vmax = _maxOf(data, 'v');
    const mov = (current.duration_s && current.moving_s)
      ? ` · en movimiento ${Math.round(current.moving_s / current.duration_s * 100)} %` : '';
    q('#d-speed-foot').textContent =
      `media ${current.avg_speed ? current.avg_speed.toFixed(1) : '–'}`
      + (vmax != null ? ` · máx ${vmax.toFixed(1)}` : '') + mov;
    const ctx = q('#speed-chart');
    speedChart = new Chart(ctx, {type: 'line', plugins: [_crosshairPlugin()],
      data: {datasets: [{
        data: data.map(d => ({x: d.d, y: d.v})), fill: false,
        borderColor: '#3d9be9', pointRadius: 0, borderWidth: 1.7, tension: .3,
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
        scales: _scales(data, 'd', 'v', {yTicks: false}),
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
    q('#d-hr-foot').textContent =
      `media ${current.hr_avg ? Math.round(current.hr_avg) : '–'}`
      + (current.hr_max ? ` · máx ${Math.round(current.hr_max)}` : '');
    const ctx = q('#hr-chart');
    hrChart = new Chart(ctx, {type: 'line', plugins: [_crosshairPlugin()],
      data: {datasets: [{
        data: data.map(d => ({x: d.d, y: d.hr})), fill: false,
        borderColor: '#e34b4b', pointRadius: 0, borderWidth: 1.7, tension: .3,
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
        scales: _scales(data, 'd', 'hr', {yTicks: false}),
      }});
    ctx.onmouseleave = () => setHoverD(null);
    ctx.ontouchend = () => setHoverD(null);
  }

  /* ── galería ───────────────────────────────────────────────────────────── */
  /* Pie de cada miniatura: "09:02" (hora de la foto), como el prototipo. Sin
     hora no se pone nada. */
  function _photoCap(p) {
    if (!p.taken_at) return '';
    const d = new Date(p.taken_at);
    if (isNaN(d)) return '';
    const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `<span class="cap">${hora}</span>`;
  }

  function renderGallery() {
    const g = $('#d-gallery');
    g.innerHTML = '';
    current.photos.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.dataset.photoid = p.public_id;
      d.onclick = () => openLightbox(i);
      d.innerHTML = `<img src="/api/photos/${encodeURIComponent(p.public_id)}/file" loading="lazy">
        ${p.lat ? '<span class="geo">GPS</span>' : ''}${_photoCap(p)}`;
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
    renderPhotosHead();
    await saveLocal();
    Store.syncNow({force: true});
    toast('Foto eliminada');
  }

  function openEditor() { go(`/Sendero/${encodeURIComponent(pid)}/editor`); }

  /* Mapa sin conexión de ESTA ruta: la franja de teselas que
     cubre el track, no una región. Útil para repetir una ruta ya hecha. */
  function downloadMap() {
    Tiles.downloadForTrack({
      coords: (current && current.geojson) || [],
      capa: curBasemap || defaultBasemap(), infoEl: q('#d-offline-info'),
      nombre: current && current.name,
    });
  }

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
    renderMap(); renderElev(); renderGallery(); renderPhotosHead();
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
    renderMap(); renderElev(); renderGallery(); renderPhotosHead();
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
    renderPhotosHead();
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
    $('#d-date').textContent = '';
    $('#d-file').textContent = '';
    $('#d-tech').innerHTML = '';
    $('#d-elev-sub').textContent = '';
  }

  function renderAll() {
    $('#d-name').textContent = current.name;
    document.title = `${current.name} – Sendero`;
    // Línea meta de la cabecera: fecha · hora | archivo | dispositivo
    $('#d-date').textContent = fmtDateTime(current.started_at);
    $('#d-file').textContent = current.gpx_file || '';
    const loc = $('#d-loc');
    if (current.locality) { $('#d-loc-text').textContent = current.locality; loc.style.display = 'inline-flex'; }
    else { loc.style.display = 'none'; }
    const dev = $('#d-device'), devSep = $('#d-device-sep');
    if (current.device) { dev.textContent = current.device; dev.style.display = ''; devSep.style.display = ''; }
    else { dev.style.display = 'none'; devSep.style.display = 'none'; }
    $('#d-auto').textContent = current.auto_summary || '';
    $('#d-notes').value = current.notes || '';
    const ibtn = q('#immich-btn');
    if (ibtn) ibtn.classList.toggle('hidden', !IMMICH);
    renderActivity(); renderDupBanner();
    renderStats(); renderTech(); renderQuality();
    renderMap(); renderElev(); renderSpeed(); renderHR();
    renderGallery(); renderPhotosHead();
    // Si el mapa de esta ruta ya está descargado, decirlo sin que haya que pulsar.
    Tiles.statusForTrack({coords: current.geojson, capa: curBasemap || defaultBasemap(),
                          infoEl: q('#d-offline-info')});
    window.scrollTo(0, 0);
  }

  /* Deja la sección como recién cargada. Necesario también al montar, no solo al
     desmontar: se puede ir de un detalle a otro (enlace del aviso de duplicada)
     y el router no desmonta cuando la sección es la misma. */
  function resetView() {
    destroyMap();
    destroyCharts();
    // El modo pantalla completa del mapa no debe heredarse al navegar a otra ruta.
    const hero = q('.d-hero');
    if (hero) hero.classList.remove('d-hero-full');
    closeActivityPicker();
    closeLightbox();
    q('#immich-modal').classList.add('hidden');
    q('#dup-banner').style.display = 'none';
    q('#d-actions-more').classList.remove('open');
    immichCands = []; immichSel = new Set();
    hoverD = null; trackCumKm = []; lbIdx = 0;
    map3dMode = false;
    setTab('perfil');            // en móvil, siempre se entra por el perfil
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
    mount, unmount, setTab,
    openActivityPicker, closeActivityPicker, setActivity,
    toggle3D, saveNotes, rescanRoute, renameRoute, removeRoute, downloadGpx, downloadMap,
    openEditor, dismissDup, delPhoto,
    openImmich, closeImmich, renderImmich, confirmImmich, selectAllImmich,
    openLightbox, closeLightbox, lbNav, lbDelete,
  };
})();
