/* Sección `planes` ("Mis Planes"). Portado de la app multipágina
   (`git show v0.7.1:templates/app.html`).
   Markup en templates/sec/planes.html, CSS en static/css/planes.css.

   El listado viene de `Store.planned()` (IndexedDB + sincronización delta), así
   que se ve sin conexión. Y el mapa pasa por `buildStyle(defaultBasemap(...))`
   como los demás: en app.html era el único que llevaba las teselas de
   OpenTopoMap escritas a mano, lo que le hacía ignorar Ajustes → Mapas (y no
   tener capa offline). Regla 15 de CLAUDE.md.

   Contrato: mount(params, opts) / unmount(). unmount() DEBE destruir el mapa. */
(() => {
  'use strict';

  let map = null, mapLoaded = false;
  let markers = {}, plans = [];
  let basemap = null;
  let _tok = 0, _unsub = null;
  /* Trazas de los planes (features de LineString de /api/planned/geojson). En el
     ámbito del módulo y NO se vacían al desmontar: al volver a la sección se
     pintan al instante mientras la petición está en vuelo. */
  let lines = [];
  /* "Marcar como realizada": índice public_id → fila del listado de RUTAS, para
     poder enlazar (y nombrar) la ruta que cumplió cada plan, y el plan sobre el
     que está abierto el selector. */
  let routeIdx = {}, routesRows = [], doneTarget = null;
  /* Filtro por estado. Es una PREFERENCIA, no un dato: va en sessionStorage como
     los filtros de "Mis Rutas". Arranca en 'pendientes' porque esta vista es la
     lista de lo que queda por hacer ("Rutas preparadas, pendientes de pisar"). */
  const ESTADO_KEY = 'sendero_planes_estado_v1';
  const ESTADOS = ['pendientes', 'realizadas', 'todas'];
  let estado = 'pendientes';
  /* Los planes que el filtro deja ver ahora mismo. Lo usan la lista Y el mapa
     (marcadores y trazas), como el filtro de "Mis Rutas" con `ov-lines`: un
     filtro que solo escondiera tarjetas dejaría el mapa contando otra historia.
     Los KPIs de la cabecera NO se filtran, describen la colección entera. */
  const visiblePlans = rows => (rows || plans).filter(p =>
    estado === 'todas' || (estado === 'realizadas' ? !!p.completed_at : !p.completed_at));

  const q = sel => document.querySelector('#sec-planes ' + sel);
  const visible = () => {
    const el = document.getElementById('sec-planes');
    return !!el && !el.classList.contains('hidden');
  };

  /* ── mapa ──────────────────────────────────────────────────────────────── */
  function initMap() {
    if (map) return;
    map = new maplibregl.Map({
      container: 'plan-map',
      style: buildStyle(basemap || (basemap = defaultBasemap('Topográfico'))),
      center: [-3.7, 40.4], zoom: 6, attributionControl: false,
    });
    map.scrollZoom.disable();
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
    addGeolocate(map, 'top-right');
    // selector de capas, para poder usar la offline como en el resto de mapas
    map.addControl({
      onAdd() {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:var(--panel,#fff);color:var(--ink,#0b120e);border:none;font-size:12px;cursor:pointer;padding:5px 7px;font-family:inherit;width:100%';
        basemapNames().forEach(c => {
          const o = document.createElement('option'); o.value = c; o.textContent = c;
          sel.appendChild(o);
        });
        sel.value = basemap;
        sel.onchange = () => {
          const prev = basemap;
          basemap = sel.value;
          // Entrar/salir de la capa offline reconstruye el estilo y se lleva los
          // marcadores y las trazas por delante: los marcadores se recrean (son
          // DOM) y las capas de las trazas se vuelven a añadir (regla 15).
          applyBasemap(map, basemap);
          if (prev === OFFLINE_LAYER || basemap === OFFLINE_LAYER) {
            map.once('sendero:basemap', () => {
              markers = {}; syncMarkers(); addLineLayers();
            });
          }
        };
        const wrap = document.createElement('div');
        wrap.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        wrap.appendChild(sel);
        return wrap;
      }, onRemove() {},
    }, 'top-left');
    // Click y cursor sobre la traza: la capa puede no existir todavía (se añade
    // en 'load'), MapLibre consulta las capas en el momento del evento.
    map.on('click', 'pl-lines-hit', e => go('/Plan/' + encodeURIComponent(e.features[0].properties.id)));
    map.on('mouseenter', 'pl-lines-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pl-lines-hit', () => { map.getCanvas().style.cursor = ''; });
    map.on('load', () => { mapLoaded = true; addLineLayers(); });
  }

  function destroyMap() {
    Object.values(markers).forEach(m => { try { m.remove(); } catch (e) {} });
    markers = {};
    if (map) { try { map.remove(); } catch (e) {} }
    map = null;
    mapLoaded = false;
  }

  /* ── trazas de los planes ───────────────────────────────────────────────────
     El listado no trae `geojson` (PLANNED_LIST_COLS), así que las líneas vienen
     de /api/planned/geojson y se guardan en el Store (`planned_lines`) para que
     el mapa siga enseñando las rutas sin conexión, como los récords del
     dashboard. Los planes son unas decenas: se piden todas de una vez, sin bbox
     ni umbral de zoom (a diferencia de `ov-lines` en "Mis Rutas"). */
  function lineFC() {
    // Filtra por los planes VISIBLES: los que el listado tiene ahora mismo (si se
    // borró uno, su traza no debe quedarse pintada hasta que responda la
    // petición) y que pasan el filtro por estado.
    const ids = new Set(visiblePlans().map(p => p.public_id));
    return {type: 'FeatureCollection',
            features: plans.length ? lines.filter(f => ids.has(f.properties.id)) : lines};
  }

  function addLineLayers() {
    if (!map || map.getSource('pl-lines')) return;
    map.addSource('pl-lines', {type: 'geojson', data: lineFC()});
    map.addLayer({id: 'pl-lines', type: 'line', source: 'pl-lines',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': activityLineColor(), 'line-width': 2.2, 'line-opacity': .9}});
    // línea ancha invisible para que el click no exija acertar 2 px
    map.addLayer({id: 'pl-lines-hit', type: 'line', source: 'pl-lines',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': '#000000', 'line-width': 14, 'line-opacity': 0}});
  }

  function paintLines() {
    if (!map || !map.getSource('pl-lines')) return;
    map.getSource('pl-lines').setData(lineFC());
  }

  async function loadLines() {
    const tok = _tok;
    if (!lines.length) {                       // copia local: se ve sin conexión
      try {
        const cached = await Store.meta('planned_lines');
        if (tok !== _tok) return;
        if (cached && cached.features && cached.features.length) {
          lines = cached.features;
          paintLines(); fitPlans();
        }
      } catch (e) {}
    }
    if (!Store.isOnline()) return;
    try {
      const res = await fetch('/api/planned/geojson');
      if (!res.ok) return;
      const fc = await res.json();
      if (tok !== _tok) return;
      lines = fc.features || [];
      paintLines(); fitPlans();
      Store.setMeta('planned_lines', {features: lines});
    } catch (e) {
      /* sin conexión: quedan los marcadores (y las trazas guardadas, si había) */
    }
  }

  /* Marcadores de salida: se SINCRONIZAN, no solo se añaden. Un plan que el
     filtro por estado deja fuera (o que se borró en otro dispositivo) tiene que
     perder su marcador; si solo se añadieran, el mapa acumularía marcadores de
     planes que ya no están en la lista. */
  function syncMarkers() {
    if (!map) return;
    const rows = visiblePlans();
    const vivos = new Set(rows.filter(p => p.start_lat != null).map(p => p.public_id));
    Object.keys(markers).forEach(id => {
      if (vivos.has(id)) return;
      try { markers[id].remove(); } catch (e) {}
      delete markers[id];
    });
    rows.forEach(p => {
      if (markers[p.public_id] || p.start_lat == null) return;
      const a = activityOf(p.activity_type);
      const el = document.createElement('div');
      el.innerHTML = a ? iconSvg(a, 26) : genericIconSvg(26);
      el.style.cssText = 'cursor:pointer;line-height:0;width:26px;height:26px';
      el.title = p.name;
      el.onclick = () => go('/Plan/' + encodeURIComponent(p.public_id));
      markers[p.public_id] = new maplibregl.Marker({element: el, anchor: 'center'})
        .setLngLat([p.start_lon, p.start_lat]).addTo(map);
    });
  }

  /* Encuadre de la colección: los puntos de salida MÁS las trazas ya cargadas
     (si no, con una ruta larga se veía solo el arranque). Sin animación a
     propósito: el centro del constructor es un placeholder y animar desde él es
     el "vuelo" que se quitó del mapa de "Mis Rutas" (ver "Bugs corregidos"). */
  function fitPlans() {
    if (!map) return;
    // Todos los encuadres de esta vista son automáticos (no hay botón "centrar"),
    // así que basta pararlos aquí mientras se sigue la ubicación del usuario.
    if (geoTracking(map)) return;
    let mnLo = Infinity, mxLo = -Infinity, mnLa = Infinity, mxLa = -Infinity, any = false;
    const acc = (lo, la) => {
      if (lo == null || la == null) return;
      any = true;
      if (lo < mnLo) mnLo = lo;
      if (lo > mxLo) mxLo = lo;
      if (la < mnLa) mnLa = la;
      if (la > mxLa) mxLa = la;
    };
    lineFC().features.forEach(f => f.geometry.coordinates.forEach(c => acc(c[0], c[1])));
    visiblePlans().forEach(p => { if (p.start_lat != null) acc(p.start_lon, p.start_lat); });
    if (!any) return;
    const fit = () => {
      try { map.fitBounds([[mnLo, mnLa], [mxLo, mxLa]], {padding: 50, duration: 0}); } catch (e) {}
    };
    if (mapLoaded || map.loaded()) fit(); else map.once('load', fit);
  }

  /* ── tarjetas ────────────────────────────────────────────────────────────
     Mismo lenguaje que .card de `rutas`: borde izquierdo del color de la
     actividad, título en Oswald, fecha larga en mono y la línea .card-meta con
     la distancia en ámbar. Donde la ruta pone su miniatura PNG, el plan pone el
     glifo de la actividad como marca de agua: `planned_routes` no tiene
     thumb_file, y PLANNED_LIST_COLS no trae geojson ni elevation, así que la
     actividad es el único dato dibujable que llega en el listado. */
  function makeCard(p) {
    const a = activityOf(p.activity_type);
    const div = document.createElement('div');
    const done = !!p.completed_at;
    div.className = 'plan-card' + (done ? ' done' : '');
    div.style.borderLeftColor = a ? a.color : 'var(--line-strong)';
    div.onclick = () => go('/Plan/' + encodeURIComponent(p.public_id));
    const dist = p.distance_m ? `<span class="card-dist">${fmtKm(p.distance_m)} km</span>` : '';
    const asc  = p.ascent_m   ? `<span class="card-asc">↑ ${fmtNum(p.ascent_m)} m</span>` : '';
    const top  = p.ele_max != null ? `<span class="card-top">▲ ${fmtNum(p.ele_max)} m</span>` : '';
    const meta = (dist || asc || top) ? `<div class="card-meta">${dist}${asc}${top}</div>` : '';
    const pid = encodeURIComponent(p.public_id);
    /* Pie de la tarjeta: la chapa de fuente y, a la derecha, la acción. Los
       botones van con stopPropagation porque la tarjeta entera navega al plan. */
    const badges = [`<span class="source-badge">${p.source === 'wikiloc' ? 'Wikiloc' : 'GPX'}</span>`];
    if (done) badges.push(`<span class="done-badge">✔ Realizada ${esc(fmtDateShort(p.completed_at))}</span>`);
    const accion = done
      ? `<button class="plan-act-btn undo" title="Volver a marcarla como pendiente"
                 onclick="event.stopPropagation();SEC.planes.undoDone('${pid}')">Desmarcar</button>`
      : `<button class="plan-act-btn" title="Marcar este plan como realizado"
                 onclick="event.stopPropagation();SEC.planes.openDoneModal('${pid}')">✓ Marcar realizada</button>`;
    div.innerHTML = `
      <div class="plan-glyph">${a ? iconSvg(a, 150) : genericIconSvg(150)}</div>
      <div class="plan-act">${a ? iconSvg(a, 26) : genericIconSvg(26)}</div>
      <div class="plan-body">
        <h3>${esc(p.name)}</h3>
        <div class="date">${fmtDateLong(p.created_at)}</div>
        ${meta}
        ${doneRouteLink(p)}
        <div class="card-foot">
          <div class="card-badges">${badges.join('')}</div>
          ${accion}
        </div>
      </div>`;
    return div;
  }

  /* Enlace a la ruta real que cumplió el plan. El nombre sale del listado de
     rutas que ya tiene el Store (así el rename se refleja solo y no hace falta
     denormalizar nada); si aún no ha cargado, la tarjeta se repinta cuando
     `loadRoutesIndex()` termine. Si la ruta se borró, el servidor manda
     `completed_route_public` a NULL y aquí no se pinta nada. */
  function doneRouteLink(p) {
    const r = p.completed_route_public ? routeIdx[p.completed_route_public] : null;
    if (!r) return '';
    const href = '/Sendero/' + encodeURIComponent(r.public_id);
    return `<div class="done-route">→ <a href="${href}" data-nav="${href}"
              onclick="event.stopPropagation()">${esc(r.name)}</a>
              <span class="done-route-date">${esc(fmtDateShort(r.started_at || r.created_at))}</span></div>`;
  }

  /* "27 jul 2026": la fecha de la chapa, más corta que fmtDateLong. */
  function fmtDateShort(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('es-ES',
      {day: 'numeric', month: 'short', year: 'numeric'});
  }

  /* Resumen de la colección, a la derecha del título de vista. Sale del listado
     que ya tiene el Store, así que se ve igual sin conexión. */
  function renderKpis(rows) {
    const km  = rows.reduce((s, p) => s + (p.distance_m || 0), 0) / 1000;
    const asc = rows.reduce((s, p) => s + (p.ascent_m   || 0), 0);
    const items = [
      ['Planes', String(rows.length), '', false],
      // Con pocos planes el total cabe en decenas de km: redondear a entero
      // convertiría "5.93" en "6" y parecería un dato inventado.
      ['Distancia', km < 100 ? km.toFixed(1) : fmtNum(km), 'km', true],
      ['Desnivel +', fmtNum(asc), 'm', false],
    ];
    q('#pg-kpis').innerHTML = items.map(([l, v, u, amber]) =>
      `<div class="pg-kpi${amber ? ' amber' : ''}"><div class="l">${l}</div>` +
      `<div class="v">${v}${u ? ` <small>${u}</small>` : ''}</div></div>`).join('');
  }

  /* ── filtro por estado ────────────────────────────────────────────────────
     `visiblePlans()` está arriba, con el estado del módulo: lo usan también las
     funciones del mapa, declaradas antes de este bloque. */
  function setEstado(v) {
    if (!ESTADOS.includes(v)) return;
    estado = v;
    try { sessionStorage.setItem(ESTADO_KEY, v); } catch (e) {}
    render(plans);
    syncMarkers();
    paintLines();
    fitPlans();
  }

  function renderFilters(rows) {
    const hechas = rows.filter(p => p.completed_at).length;
    const n = {pendientes: rows.length - hechas, realizadas: hechas, todas: rows.length};
    const etiqueta = {pendientes: 'Pendientes', realizadas: 'Realizadas', todas: 'Todas'};
    q('#pg-filters').innerHTML = ESTADOS.map(e =>
      `<button class="pg-filter${e === estado ? ' on' : ''}"
               onclick="SEC.planes.setEstado('${e}')">${etiqueta[e]}
         <span class="n">${n[e]}</span></button>`).join('');
  }

  function render(rows) {
    const grid = q('#plan-grid'), empty = q('#no-plans');
    renderKpis(rows);                 // el resumen es de la colección entera
    renderFilters(rows);
    const vis = visiblePlans(rows);
    q('#pg-count').textContent = vis.length === 1 ? '1 ruta' : `${vis.length} rutas`;
    q('.pg-list-head').classList.toggle('hidden', !rows.length);
    grid.innerHTML = '';
    empty.classList.toggle('hidden', !!vis.length);
    if (!vis.length) {
      // Vacío por el filtro ≠ vacío de verdad: si no se distinguen, marcar el
      // último plan como realizado parece haber borrado la colección.
      empty.innerHTML = !rows.length
        ? 'No hay rutas planificadas todavía.'
        : (estado === 'pendientes'
            ? `No queda ningún plan pendiente. <button class="pg-empty-link"
                 onclick="SEC.planes.setEstado('realizadas')">Ver las realizadas</button>`
            : `Ningún plan realizado todavía. <button class="pg-empty-link"
                 onclick="SEC.planes.setEstado('pendientes')">Ver los pendientes</button>`);
      return;
    }
    vis.forEach(p => grid.appendChild(makeCard(p)));
  }

  async function reload() {
    const tok = _tok;
    let rows;
    try {
      rows = await Store.planned();
    } catch (e) {
      toast('No se pudo cargar la lista de planes');
      return;
    }
    if (tok !== _tok) return;
    plans = rows;
    render(plans);
    syncMarkers();
    paintLines();          // descarta la traza de un plan que ya no está
    fitPlans();
    loadLines();           // y trae las que falten (o las actualiza)
  }

  /* ── marcar un plan como realizado ────────────────────────────────────────
     Dos columnas en `planned_routes`: `completed_at` (cuándo se marcó) y la ruta
     real que lo cumplió, opcional. Se manda con Store.patch, así que **sin
     conexión se encola** y se envía al volver la red; por eso la FECHA la pone el
     cliente y no el servidor (si la pusiera el servidor al reenviar la cola, la
     marca llevaría la fecha en que volvió el wifi, no la del día que se hizo).
     Y por eso hace falta `Store.patchPlanRow`: sin actualizar la copia local, el
     cambio hecho sin conexión desaparecería al repintar. */

  /* ISO local sin zona, como los `created_at` que escribe el servidor. Con
     toISOString() a secas la marca sería UTC y un plan marcado a las 00:30
     aparecería con la fecha del día anterior. */
  function isoLocal(d) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  }

  function haversineM(la1, lo1, la2, lo2) {
    const R = 6371000, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const h = Math.sin(dLa / 2) ** 2
            + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* Listado de rutas del Store (local, también sin conexión): hace falta para
     nombrar la ruta asociada en la tarjeta y para el selector. */
  async function loadRoutesIndex() {
    const tok = _tok;
    let rows;
    try { rows = await Store.routes(); } catch (e) { return; }
    if (tok !== _tok) return;
    routesRows = rows;
    routeIdx = {};
    rows.forEach(r => { routeIdx[r.public_id] = r; });
    // Ahora sí se puede pintar el nombre de la ruta de los planes ya realizados.
    if (plans.some(p => p.completed_at && p.completed_route_public)) render(plans);
  }

  function openDoneModal(pid) {
    const p = plans.find(x => x.public_id === pid);
    if (!p) return;
    doneTarget = pid;
    q('#done-plan-name').textContent = p.name;
    q('#done-search').value = '';
    q('#done-modal').classList.remove('hidden');
    renderDoneList();
    if (!routesRows.length) loadRoutesIndex().then(() => { if (doneTarget) renderDoneList(); });
  }

  function closeDoneModal() {
    doneTarget = null;
    q('#done-modal').classList.add('hidden');
  }

  function filterDoneList() { renderDoneList(); }

  /* Las rutas que salen cerca del inicio del plan van arriba, en "Sugeridas":
     con unos cientos de rutas, buscar a mano la que cumplió el plan es lo tedioso
     de este flujo, y la distancia al punto de salida acierta casi siempre. */
  const NEAR_M = 3000;

  function renderDoneList() {
    const cont = q('#done-list');
    if (!cont) return;
    const plan = plans.find(x => x.public_id === doneTarget);
    if (!routesRows.length) {
      cont.innerHTML = '<div class="done-empty">No hay rutas en la copia local todavía.</div>';
      return;
    }
    const term = (q('#done-search').value || '').trim().toLowerCase();
    const match = r => !term
      || (r.name || '').toLowerCase().includes(term)
      || (r.locality || '').toLowerCase().includes(term);
    const cerca = [], resto = [];
    routesRows.filter(match).forEach(r => {
      const near = plan && plan.start_lat != null && r.start_lat != null
        && haversineM(plan.start_lat, plan.start_lon, r.start_lat, r.start_lon) <= NEAR_M;
      (near ? cerca : resto).push(r);
    });
    const fila = r => {
      const a = activityOf(r.activity_type);
      return `<div class="done-row" onclick="SEC.planes.markDone('${encodeURIComponent(r.public_id)}')">
        <span class="done-row-ico">${a ? iconSvg(a, 22) : genericIconSvg(22)}</span>
        <span class="done-row-body">
          <span class="done-row-name">${esc(r.name)}</span>
          <span class="done-row-meta">${esc(fmtDateShort(r.started_at || r.created_at))}
            · ${fmtKm(r.distance_m)} km${r.locality ? ' · ' + esc(r.locality) : ''}</span>
        </span></div>`;
    };
    let html = '';
    if (cerca.length) {
      html += '<div class="done-group">Sugeridas · empiezan cerca de este plan</div>'
            + cerca.map(fila).join('');
    }
    if (resto.length) {
      html += `<div class="done-group">${cerca.length ? 'Todas las demás' : 'Todas las rutas'}</div>`
            + resto.map(fila).join('');
    }
    cont.innerHTML = html || '<div class="done-empty">Ninguna ruta coincide con la búsqueda.</div>';
  }

  /* `routePublic` = public_id de la ruta que la cumplió, o null para marcarla sin
     ruta asociada (el botón de abajo del modal). */
  async function markDone(routePublic) {
    const pid = doneTarget;
    if (!pid) return;
    const ref = routePublic ? decodeURIComponent(routePublic) : null;
    closeDoneModal();
    const ts = isoLocal(new Date());
    const r = await Store.patch(`/api/planned/${encodeURIComponent(pid)}`,
                                {completed_at: ts, completed_route: ref},
                                {label: 'plan realizado'});
    if (!r.ok) { toast('Error al marcar el plan'); return; }
    await applyDoneLocally(pid, ts, ref);
    const nombre = ref && routeIdx[ref] ? ` · ${routeIdx[ref].name}` : '';
    toast((r.queued ? 'Marcada como realizada (se enviará al recuperar conexión)'
                    : 'Plan marcado como realizado' + nombre) + salioDeLaVista('realizadas'));
  }

  /* Si el filtro activo no incluye el estado nuevo, la tarjeta desaparece de la
     lista al marcarla: hay que decir DÓNDE está ahora, o parece un borrado. */
  function salioDeLaVista(nuevoEstado) {
    if (estado === 'todas' || estado === nuevoEstado) return '';
    return ` · ahora en «${nuevoEstado === 'realizadas' ? 'Realizadas' : 'Pendientes'}»`;
  }

  async function undoDone(pid) {
    pid = decodeURIComponent(pid);
    const r = await Store.patch(`/api/planned/${encodeURIComponent(pid)}`,
                                {completed_at: null, completed_route: null},
                                {label: 'plan pendiente'});
    if (!r.ok) { toast('Error al desmarcar el plan'); return; }
    await applyDoneLocally(pid, null, null);
    toast((r.queued ? 'Marcada como pendiente (se enviará al recuperar conexión)'
                    : 'Plan marcado como pendiente') + salioDeLaVista('pendientes'));
  }

  /* Copia local + repintado. El listado se guarda en el Store porque la sección
     lo relee de ahí en cada `reload()` (y sin conexión no llega nada del
     servidor que lo confirme). */
  async function applyDoneLocally(pid, ts, ref) {
    const cambios = {completed_at: ts, completed_route_public: ref};
    try { await Store.patchPlanRow(pid, cambios); } catch (e) {}
    const p = plans.find(x => x.public_id === pid);
    if (p) Object.assign(p, cambios);
    render(plans);
  }

  /* ── modal de alta ─────────────────────────────────────────────────────── */
  function openAddModal() { q('#add-modal').classList.remove('hidden'); }
  function closeAddModal() {
    q('#add-modal').classList.add('hidden');
    q('#drop-chosen').classList.add('hidden');
    q('#drop-chosen').textContent = '';
    q('#plan-file').value = '';
  }
  function openPlanner() { window.open(PLANNER_URL, '_blank', 'noopener'); }

  function showLoader(title, msg, pct) {
    q('#plan-loader').classList.remove('hidden');
    q('#loader-title').textContent = title;
    q('#loader-msg').textContent = msg;
    q('#loader-pct').textContent = pct !== null ? pct + '%' : '';
    q('#loader-bar').style.width = (pct == null ? 0 : pct) + '%';
  }
  function hideLoader() { q('#plan-loader').classList.add('hidden'); }

  async function uploadPlanGpx() {
    const f = q('#plan-file').files[0];
    if (!f) { toast('Elige un archivo GPX'); return; }
    if (!Store.isOnline()) { toast('Añadir un plan necesita conexión'); return; }
    closeAddModal();
    showLoader('Añadiendo ruta…', f.name, 30);
    const fd = new FormData();
    fd.append('gpx', f);
    try {
      const res = await fetch('/api/planned', {method: 'POST', body: fd});
      const data = await res.json();
      if (!res.ok) { hideLoader(); toast(data.error || 'Error al subir el archivo'); return; }
      showLoader('Listo', data.name, 100);
      await Store.syncNow({force: true});
      setTimeout(() => { hideLoader(); go('/Plan/' + encodeURIComponent(data.public_id)); }, 600);
    } catch (e) {
      hideLoader();
      toast('Error de red');
    }
  }

  /* ── montaje ───────────────────────────────────────────────────────────── */
  async function mount() {
    const tok = ++_tok;
    // El filtro se lee AQUÍ y no en la declaración: `loadOnce()` ejecuta este
    // archivo una sola vez, pero mount() puede correr decenas de veces y la
    // preferencia puede haber cambiado en otra pestaña.
    try {
      const g = sessionStorage.getItem(ESTADO_KEY);
      if (ESTADOS.includes(g)) estado = g;
    } catch (e) {}
    initMap();
    await reload();
    if (tok !== _tok) return;
    loadRoutesIndex();          // sin await: solo hace falta para el enlace y el selector
    if (!_unsub) {
      _unsub = Store.onChange(ev => {
        if (ev.type === 'synced' && ev.changed && visible()) reload();
      });
    }
    if (map) setTimeout(() => { if (map) map.resize(); }, 60);
  }

  function unmount() {
    _tok++;
    destroyMap();
    closeAddModal();
    closeDoneModal();
    hideLoader();
    if (_unsub) { _unsub(); _unsub = null; }
    plans = [];
  }

  /* Listeners de documento: una sola vez al cargar el archivo. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && visible()) { closeAddModal(); closeDoneModal(); }
  });
  q('#done-modal').addEventListener('click', e => {
    if (e.target.id === 'done-modal') closeDoneModal();
  });
  q('#add-modal').addEventListener('click', e => {
    if (e.target.id === 'add-modal') closeAddModal();
  });
  q('#plan-file').addEventListener('change', () => {
    const f = q('#plan-file').files[0];
    if (f) {
      q('#drop-chosen').textContent = f.name;
      q('#drop-chosen').classList.remove('hidden');
    }
  });
  ['dragover', 'dragleave', 'drop'].forEach(ev => {
    q('#drop-plan').addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'dragover') q('#drop-plan').classList.add('over');
      else q('#drop-plan').classList.remove('over');
      if (ev === 'drop' && e.dataTransfer.files[0]) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        q('#plan-file').files = dt.files;
        q('#drop-chosen').textContent = e.dataTransfer.files[0].name;
        q('#drop-chosen').classList.remove('hidden');
      }
    });
  });

  window.SEC.planes = {mount, unmount, openAddModal, closeAddModal, openPlanner, uploadPlanGpx,
                       openDoneModal, closeDoneModal, filterDoneList, markDone, undoDone,
                       setEstado};
})();
