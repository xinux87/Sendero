/* Sección `plan`: detalle de una ruta planificada.
   Extraído de la app multipágina (`git show v0.7.1:templates/plan_detalle.html`).
   Markup en templates/sec/plan.html, CSS en static/css/plan.css.

   Es la primera vista que se convierte en sección de la SPA, a propósito: era la
   más corta de las tres que recargaban página, así que sirve para validar el
   contrato mount()/unmount() antes de tocar el detalle de ruta y el editor.

   Contrato (lo llama static/js/core/router.js):
     mount(params, {bootstrap, remount})  params.id = public_id del plan
     unmount()                            DEBE destruir el mapa y el Chart

   Sin ese unmount, cada visita dejaría una instancia de MapLibre viva (con su
   contexto WebGL y sus listeners) y navegar arriba y abajo degradaría el
   navegador poco a poco — la fuga nº 1 de esta conversión.

   Los datos NO vienen inyectados por Jinja: los pide Store.plan(), que decide
   red o copia local. Así la vista funciona sin conexión si el plan ya se visitó. */
(() => {
  'use strict';

  let map = null, elevChart = null, current = null, pid = null;
  /* ¿hay clave de la API del IBP en Ajustes? Lo dice /api/config, y sin ella el
     panel explica cómo activarlo en vez de ofrecer un botón que fallaría. Se
     pregunta una vez por carga de página (_cfgLoaded), como IMMICH en `detalle`. */
  let IBP = false, _cfgLoaded = false;
  /* Capa base que se está viendo. En el ámbito del módulo, no dentro de
     initMap(), porque el botón "Mapa sin conexión" necesita saber de qué capa
     descargar las teselas. */
  let capa = null;
  // Token de montaje: si se navega a otro plan mientras el fetch está en vuelo,
  // la respuesta vieja no debe pintar nada.
  let _tok = 0;
  /* Hover sincronizado mapa↔perfil (mismo diseño que sec/detalle.js): hoverD es
     la distancia (km) resaltada ahora mismo, o null si no hay hover activo. Un
     plan solo tiene elevación (ni velocidad ni FC: no se ha hecho todavía), así
     que el cuadro flotante enseña km y altitud. */
  let hoverD = null, trackCumKm = [], hoverBoxEl = null;
  /* ¿está puesta la vista 3D? Vive en el módulo (no en el DOM) porque hay que
     consultarla desde el 'moveend' que enciende el terreno y desde el repintado
     que sigue a un cambio de capa base. */
  let map3dMode = false;
  /* Selector de «¿qué ruta la cumplió?»: copia local del listado de rutas
     (Store.routes(), o sea también sin conexión) y su índice por public_id.
     `doneRoute` es la fila de la ruta asociada a ESTE plan, para poder poner su
     nombre en «Datos técnicos». */
  let routesRows = [], routeIdx = {}, doneRoute = null;

  const needOnline = msg => {
    if (Store.isOnline()) return true;
    toast(msg || 'Esta acción necesita conexión');
    return false;
  };

  /* ── mapa ──────────────────────────────────────────────────────────────── */
  /* Bounding box del track, para encuadrar (MapLibre no tiene el getBounds() de
     una polyline de Leaflet). */
  function trackBounds() {
    const c = (current && current.geojson) || [];
    if (!c.length) return null;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    c.forEach(([lo, la]) => {
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    });
    return [[minLon, minLat], [maxLon, maxLat]];
  }

  function fitRoute(instant) {
    const b = trackBounds();
    // El encuadre respeta la inclinación: en 3D, volver a pitch 0 sería deshacer
    // la vista que el usuario acaba de pedir.
    if (b && map) map.fitBounds(b, {padding: 40, pitch: map3dMode ? 60 : 0,
                                    duration: instant ? 0 : 600});
  }

  /* ── vista 3D ──────────────────────────────────────────────────────────────
     La fuente del DEM (Terrarium de AWS) se añade aparte del track, porque hay
     que reponerla en cada reconstrucción del estilo: entrar o salir de la capa
     offline hace setStyle() y se lleva por delante TODAS las fuentes (regla 15).
     Si el usuario estaba en 3D cuando eso pasa, el terreno se apaga solo, así que
     aquí se vuelve a encender sobre la fuente recién repuesta. */
  function ensureTerrain() {
    if (!map) return;
    if (!map.getSource('terrain')) {
      map.addSource('terrain', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium', tileSize: 256, maxzoom: 15,
      });
    }
    if (map3dMode) map.setTerrain({source: 'terrain', exaggeration: 1.5});
  }

  function toggle3D() {
    if (!map) return;
    map3dMode = !map3dMode;
    $('#pl-btn3d').textContent = map3dMode ? 'Vista 2D' : 'Vista 3D';
    if (map3dMode) {
      /* OJO, y esto costó un bug de meses en el detalle de ruta (de donde está
         copiada esta secuencia, ver «Bugs corregidos» en CLAUDE.md): NO se puede
         mover la cámara en el mismo tick en el que se activa el terreno. Haciendo
             map.setTerrain(...); map.easeTo({pitch:60});
         el mapa se queda COMPLETAMENTE NEGRO y no se recupera — el terreno
         todavía no tiene su primera tesela de DEM cuando la cámara se reproyecta,
         y la transformación queda en un estado inservible. Da igual la duración
         de la animación: con duration:0 pasa lo mismo.

         Así que primero se inclina y el relieve se enciende al acabar el
         movimiento. Y si el DEM no llegara nunca —sin internet— lo peor que pasa
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

  /* Pinta el track y sus extremos. Se llama en 'load' y OTRA VEZ tras cambiar de
     capa base a/desde la offline: ese salto reconstruye el estilo entero
     (applyBasemap → setStyle) y se lleva por delante fuentes y capas de datos. */
  function drawTrack() {
    const coords = (current && current.geojson) || [];
    if (!map || !coords.length || map.getSource('pl-ruta')) return;
    /* lineMetrics:true es lo que habilita ['line-progress'], o sea el degradado
       por pendiente de abajo. Sin él MapLibre ignora line-gradient. */
    map.addSource('pl-ruta', {type: 'geojson', lineMetrics: true,
      data: {type: 'Feature', geometry: {type: 'LineString', coordinates: coords}}});
    const actColor = (activityOf(current.activity_type) || {}).color || '#e3b23c';
    /* La traza va coloreada por lo empinado del terreno (verde llano → rojo
       pared, ver «Escala de pendiente» en shared.js), la misma escala que el
       perfil. Sin elevación se queda del color de la actividad, como antes. */
    const grad = slopeGradientExpr(current.elevation);
    /* Ribete oscuro DEBAJO de la traza, por el mismo motivo que en el detalle de
       una ruta: el verde de la escala se pierde sobre el mapa topográfico. */
    map.addLayer({id: 'pl-ruta-casing', type: 'line', source: 'pl-ruta',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': '#0b120e', 'line-width': 6.4, 'line-opacity': .45}});
    map.addLayer({id: 'pl-ruta-linea', type: 'line', source: 'pl-ruta',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: grad ? {'line-gradient': grad, 'line-width': 3.4, 'line-opacity': .95}
                  : {'line-color': actColor, 'line-width': 3, 'line-opacity': .95}});
    /* Cortes entre <trkseg> (un plan unido con «Unir» deja el corte a propósito
       para no fabricar distancia): se tapan y se marcan con una línea punteada,
       o la recta que MapLibre traza entre segmentos parecería camino. Va
       DESPUÉS de la traza para dibujarse encima; como esto es drawTrack(), se
       repone solo tras 'sendero:basemap' (regla 15). */
    addGapLayers(map, coords, current.seg_starts, 'pl-');
    // inicio (verde) y fin (rojo) como capas circle, no como marcadores DOM
    map.addSource('pl-ruta-extremos', {type: 'geojson', data: {type: 'FeatureCollection', features: [
      {type: 'Feature', properties: {tipo: 'Inicio'}, geometry: {type: 'Point', coordinates: coords[0]}},
      {type: 'Feature', properties: {tipo: 'Final'},  geometry: {type: 'Point', coordinates: coords[coords.length - 1]}},
    ]}});
    map.addLayer({id: 'pl-ruta-extremos', type: 'circle', source: 'pl-ruta-extremos',
      paint: {'circle-radius': 6,
        'circle-color': ['match', ['get', 'tipo'], 'Inicio', '#43b97f', '#e2492c'],
        'circle-stroke-width': 2.5, 'circle-stroke-color': '#0b120e'}});
    /* Línea invisible más ancha encima, solo para que el hover sea más fácil de
       acertar que sobre la línea real de 3 px (patrón de ruta-linea-hit en el
       detalle de ruta y de ov-lines-hit en Mis Rutas). */
    map.addLayer({id: 'pl-ruta-hit', type: 'line', source: 'pl-ruta',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': '#000', 'line-width': 16, 'line-opacity': 0}});
    // Punto que sigue al cursor (una fuente de un solo Point, se mueve con
    // setData: más barato que un Marker DOM en cada mousemove).
    map.addSource('pl-hover-point', {type: 'geojson',
      data: {type: 'FeatureCollection', features: []}});
    map.addLayer({id: 'pl-hover-point', type: 'circle', source: 'pl-hover-point',
      paint: {'circle-radius': 7, 'circle-color': actColor,
              'circle-stroke-width': 2, 'circle-stroke-color': '#101a14'}});
  }

  function initMap() {
    /* Idempotente: ir de un plan a OTRO plan es un remount sin unmount (el router
       no desmonta si la sección no cambia), y sin esto quedarían dos mapas sobre
       el mismo contenedor y dos cuadros de hover huérfanos. */
    destroyMap();
    /* El mapa se recrea entero: la vista 3D no se hereda del plan anterior (ni
       del repintado anterior de éste), así que el botón vuelve a decir «Vista 3D». */
    map3dMode = false;
    const btn3d = $('#pl-btn3d');
    if (btn3d) btn3d.textContent = 'Vista 3D';
    const b = trackBounds();
    const cx = b ? (b[0][0] + b[1][0]) / 2 : -1.6;
    const cy = b ? (b[0][1] + b[1][1]) / 2 : 42.5;
    trackCumKm = buildCumKm((current && current.geojson) || []);
    if (!capa) capa = defaultBasemap();
    map = new maplibregl.Map({
      container: 'pl-map', style: buildStyle(capa),
      center: [cx, cy], zoom: b ? 12 : 6, attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'bottom-right');
    addGeolocate(map, 'bottom-right');
    // botón centrar (mismo idioma que el detalle de ruta y Mis Rutas)
    map.addControl({
      onAdd() {
        const c = document.createElement('div');
        c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const btn = document.createElement('button');
        btn.innerHTML = '⤢'; btn.title = 'Centrar en la ruta';
        btn.style.cssText = 'font-size:16px;width:29px;height:29px;cursor:pointer;border:none;background:none;padding:0;display:flex;align-items:center;justify-content:center';
        btn.onclick = () => fitRoute();
        c.appendChild(btn); return c;
      }, onRemove() {},
    }, 'top-left');
    // botón mapa ampliado al 80 % del alto de la pantalla (mismo idioma que
    // sec/detalle.js). Alterna la clase pl-hero-full: el mapa sigue en el flujo
    // del documento, así que la página no pierde el scroll. El estado vive en el
    // DOM (.pl-hero sobrevive a initMap), por eso paint() lo lee en vez de guardarlo aquí.
    // Iconos en SVG inline (no glifos Unicode: ⛶ falta en muchas fuentes).
    const ICO_FULL = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 1.5h11M2 13.5h11M7.5 4.5v6M5.5 6.5l2-2 2 2M5.5 8.5l2 2 2-2"/></svg>';
    const ICO_BACK = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7.5h11M7.5 1.5v3M5.5 3l2 2 2-2M7.5 13.5v-3M5.5 12l2-2 2 2"/></svg>';
    map.addControl({
      onAdd() {
        const c = document.createElement('div');
        c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const btn = document.createElement('button');
        btn.style.cssText = 'width:29px;height:29px;cursor:pointer;border:none;background:none;padding:0;display:flex;align-items:center;justify-content:center';
        const paint = () => {
          const full = $('#sec-plan .pl-hero').classList.contains('pl-hero-full');
          btn.innerHTML = full ? ICO_BACK : ICO_FULL;
          btn.title = full ? 'Restaurar la altura del mapa' : 'Ampliar el mapa al 80 % de la pantalla';
        };
        btn.onclick = () => {
          const hero = $('#sec-plan .pl-hero');
          const full = hero.classList.toggle('pl-hero-full');
          paint();
          if (map) map.resize();
          if (full) hero.scrollIntoView({behavior: 'smooth', block: 'start'});
        };
        paint();
        c.appendChild(btn); return c;
      }, onRemove() {},
    }, 'top-left');
    // selector de capas base
    map.addControl({
      onAdd() {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:var(--panel,#fff);color:var(--ink,#0b120e);border:none;font-size:12px;cursor:pointer;padding:5px 7px;font-family:inherit;width:100%';
        basemapNames().forEach(c => {
          const o = document.createElement('option'); o.value = c; o.textContent = c;
          sel.appendChild(o);
        });
        sel.value = capa;
        sel.onchange = () => { capa = sel.value; applyBasemap(map, capa); };
        const wrap = document.createElement('div');
        wrap.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        wrap.appendChild(sel);
        return wrap;
      }, onRemove() {},
    }, 'top-left');

    const pop = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 10});
    map.on('mouseenter', 'pl-ruta-extremos', e => {
      map.getCanvas().style.cursor = 'pointer';
      pop.setLngLat(e.features[0].geometry.coordinates)
         .setText(e.features[0].properties.tipo).addTo(map);
    });
    map.on('mouseleave', 'pl-ruta-extremos', () => {
      map.getCanvas().style.cursor = ''; pop.remove();
    });
    /* Hover sobre la traza → resalta la misma distancia en el perfil. Se registra
       AQUÍ y no en drawTrack(), que se vuelve a ejecutar tras cada cambio de
       estilo y acumularía handlers; MapLibre admite escuchar una capa que
       todavía no existe (es lo que hace pl-ruta-extremos justo arriba). */
    map.on('mousemove', 'pl-ruta-hit', e => {
      const coords = (current && current.geojson) || [];
      if (!coords.length) return;
      const {lng, lat} = e.lngLat;
      let best = Infinity, bestIdx = 0;
      for (let i = 0; i < coords.length; i++) {
        const dx = coords[i][0] - lng, dy = coords[i][1] - lat, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bestIdx = i; }
      }
      map.getCanvas().style.cursor = 'crosshair';
      setHoverD(trackCumKm[bestIdx]);
    });
    map.on('mouseleave', 'pl-ruta-hit', () => {
      map.getCanvas().style.cursor = '';
      setHoverD(null);
    });
    map.on('load', () => { ensureTerrain(); drawTrack(); fitRoute(true); });
    /* Tras un cambio de capa base que reconstruye el estilo hay que reponer las
       dos cosas: las capas del track y la fuente del DEM (con el terreno otra vez
       encendido si estábamos en 3D). */
    map.on('sendero:basemap', () => { ensureTerrain(); drawTrack(); });
  }

  function destroyMap() {
    /* El cuadro flotante del hover vive en el contenedor del mapa: si no se
       quita, cada render() dejaría uno huérfano (el mapa se recrea entero). */
    if (hoverBoxEl && hoverBoxEl.parentNode) hoverBoxEl.parentNode.removeChild(hoverBoxEl);
    hoverBoxEl = null;
    hoverD = null;
    if (!map) return;
    try { map.remove(); } catch (e) {}
    map = null;
  }

  /* ── hover sincronizado mapa↔perfil ──────────────────────────────────────
     Port del de sec/detalle.js, con la única diferencia de que un plan solo
     tiene elevación (ni velocidad ni FC: no se ha hecho todavía). Punto de
     entrada único: setHoverD(d), d en km o null. */
  function haversineM(la1, lo1, la2, lo2) {
    const R = 6371000, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  /* Distancia acumulada (km) por punto del track: es lo que traduce un punto del
     mapa a la "d" de la serie de elevación, y al revés. */
  function buildCumKm(coords) {
    const cum = coords.length ? [0] : [];
    for (let i = 1; i < coords.length; i++) {
      const [lo1, la1] = coords[i - 1], [lo2, la2] = coords[i];
      cum.push(cum[i - 1] + haversineM(la1, lo1, la2, lo2) / 1000);
    }
    return cum;
  }
  /* La serie de elevación tiene su propio muestreo (no hay un punto por trkpt),
     así que hay que buscar el más cercano por distancia: no vale el índice. */
  function nearestByD(arr, d) {
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].d < d) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(arr[lo - 1].d - d) < Math.abs(arr[lo].d - d)) lo--;
    return arr[lo];
  }
  /* Posición interpolada en el track a los d km. */
  function lngLatAtD(d) {
    const cum = trackCumKm, coords = (current && current.geojson) || [];
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
  function ensureHoverBox() {
    if (!hoverBoxEl) {
      hoverBoxEl = document.createElement('div');
      hoverBoxEl.className = 'hover-infobox';
      map.getContainer().appendChild(hoverBoxEl);
    }
    return hoverBoxEl;
  }
  function updateMapHover() {
    if (!map || !current) return;
    const src = map.getSource && map.getSource('pl-hover-point');
    if (!src && hoverD == null) return;      // aún no hay capas: nada que limpiar
    const box = ensureHoverBox();
    if (hoverD == null || !src) {
      box.style.display = 'none';
      if (src) src.setData({type: 'FeatureCollection', features: []});
      return;
    }
    const ll = lngLatAtD(hoverD);
    if (!ll) { box.style.display = 'none'; return; }
    src.setData({type: 'FeatureCollection',
      features: [{type: 'Feature', geometry: {type: 'Point', coordinates: ll}}]});
    const pt = map.project(ll);
    const e = nearestByD(current.elevation, hoverD);
    const parts = [`<div class="hb-km">${hoverD.toFixed(2)} km</div>`];
    if (e) parts.push(`<div>Alt ${fmtNum(Math.round(e.e))} m</div>`);
    box.innerHTML = parts.join('');
    box.style.display = 'block';   // antes de medir: con display:none offsetWidth es 0
    /* clamp al contenedor: el white-space:nowrap desborda por la derecha en
       pantallas estrechas; si no cabe, el cuadro se pone a la izquierda. */
    const cw = map.getContainer().clientWidth, bw = box.offsetWidth || 120;
    let left = pt.x + 14;
    if (left + bw > cw - 6) left = pt.x - 14 - bw;
    box.style.left = Math.max(6, left) + 'px';
    box.style.top = (pt.y - 10) + 'px';
  }
  /* Lo llaman el mapa (mousemove sobre la traza) y el perfil (onHover), y así
     los dos quedan sincronizados.

     El cerrojo NO es opcional: el update() de Chart.js REENVÍA el último evento
     de ratón (`_lastEvent`, un replay interno) y con él vuelve a llamar a
     onHover, o sea a esta misma función. Sin el cerrojo, setHoverD(null) —el
     mouseleave— se deshacía a sí mismo: el replay reponía la distancia anterior y
     el cuadro se quedaba pegado en el mapa para siempre. */
  let _syncing = false;
  function setHoverD(d) {
    if (_syncing) return;
    _syncing = true;
    hoverD = d;
    /* render() y NO update('none'): el crosshair solo necesita repintar. Ver el
       comentario de setHoverD en sec/detalle.js. */
    try { if (elevChart) elevChart.render(); }
    finally { _syncing = false; }
    updateMapHover();
  }
  /* Línea vertical + punto en el perfil, a la distancia resaltada. Lee hoverD del
     ámbito del módulo y el valor del propio dataset, así no necesita nada más. */
  function crosshairPlugin(colorAt) {
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
        c.fillStyle = (colorAt && colorAt(lo)) || chart.data.datasets[0].borderColor;
        c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#101a14'; c.lineWidth = 1.5; c.stroke();
        c.restore();
      }};
  }

  /* ── gráfico de elevación ────────────────────────────────────────────────
     Mismas convenciones que el perfil del detalle de ruta (sec/detalle.js):
     rejilla y marcas en mono apagado, sin títulos de eje (la unidad la dice el
     título del panel), relleno con degradado del color de la ACTIVIDAD y línea
     naranja de la serie de elevación. */
  const GRID = 'rgba(236,229,216,.07)';
  const TICK = {color: '#68786d', font: {family: "'IBM Plex Mono',monospace", size: 10}};


  /* "1 240 m salida · 2 380 m cima · pendiente máx. 21 %". La pendiente se mide
     sobre tramos de al menos 30 m para que el ruido del GPS no dé porcentajes
     absurdos (mismo criterio que _elevSub del detalle). */
  function elevSub(data) {
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


  function drawElevation() {
    destroyChart();
    const elev = (current && current.elevation) || [];
    const panel = $('#pl-elev-panel');
    /* Se esconde con estilo INLINE, no con la clase .hidden: en móvil el panel
       lleva data-dtab y la regla de la pestaña activa empata en especificidad con
       `#sec-plan .panel.hidden`, así que un panel sin datos volvería a verse. El
       inline gana siempre (mismo apaño que #speed-section en el detalle de ruta). */
    if (!elev.length) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    $('#pl-elev-sub').textContent = elevSub(elev);
    $('#pl-slope-legend').innerHTML = slopeLegendHtml();
    const ctx = $('#pl-elev');
    /* Perfil coloreado por pendiente, igual que la traza del mapa: cada tramo va
       del color de lo empinado que sea (ver «Escala de pendiente» en shared.js).
       Tanto la línea como el relleno son el mismo degradado, uno opaco y otro
       translúcido. */
    const prof = slopeProfile(elev);
    elevChart = new Chart(ctx, {
      type: 'line',
      plugins: [crosshairPlugin(i => slopeColor(prof[i])), slopeGradientPlugin(elev)],
      data: {datasets: [{
        data: elev.map(p => ({x: p.d, y: p.e})), fill: true,
        /* Valores de arranque: el degradado lo pone slopeGradientPlugin como
           VALOR concreto (ver el comentario del plugin: como opción scriptable se
           resolvería una vez por punto en cada repintado). */
        borderColor: '#f0b070', backgroundColor: 'transparent',
        borderWidth: 2.4, pointRadius: 0, tension: .3,
      }]},
      options: {
        maintainAspectRatio: false,
        interaction: {mode: 'nearest', axis: 'x', intersect: false},
        /* Posición interpolada del cursor, no snapeada al punto de dato más
           cercano: por eso se lee de la escala y no de `els`. */
        onHover(e, els, chart) {
          /* Chart.js llama a onHover TAMBIÉN con el mouseout, y encima diferido a
             la siguiente animación: llega DESPUÉS del onmouseleave del canvas y,
             como trae la última posición, volvería a encender el cuadro. Aquí es
             donde se apaga de verdad. */
          if (!e || e.type === 'mouseout') { setHoverD(null); return; }
          const d = chart.scales.x.getValueForPixel(e.x);
          if (d != null && !isNaN(d)) {
            setHoverD(Math.max(chart.scales.x.min, Math.min(chart.scales.x.max, d)));
          }
        },
        plugins: {legend: {display: false}, tooltip: {callbacks: {
          title: i => `${(+i[0].parsed.x).toFixed(2)} km`,
          label: i => `${fmtNum(i.parsed.y)} m`,
        }}},
        scales: {
          x: {type: 'linear', min: 0, max: elev[elev.length - 1].d,
              ticks: {...TICK, maxTicksLimit: 8}, grid: {color: GRID, drawTicks: false},
              border: {display: false}},
          y: {ticks: {...TICK, callback: v => fmtNum(v)},
              grid: {color: GRID, drawTicks: false}, border: {display: false}},
        },
      },
    });
    /* Asignación directa, NO addEventListener: drawElevation() destruye y recrea
       el Chart reutilizando el mismo <canvas> (lo llama pickActivity()), así que
       los listeners se irían acumulando. */
    ctx.onmouseleave = () => setHoverD(null);
    ctx.ontouchend = () => setHoverD(null);   // en táctil no hay mouseleave
  }

  function destroyChart() {
    if (!elevChart) return;
    try { elevChart.destroy(); } catch (e) {}
    elevChart = null;
  }

  /* ── banda de métricas ───────────────────────────────────────────────────
     Igual que la del detalle de ruta: la 1ª tarjeta lleva .acc con el borde del
     color de la actividad y la cifra en ámbar. Solo lo que el plan tiene: no
     hay tiempos ni velocidad, que un plan no se ha hecho todavía. */
  function renderStats() {
    const r = current;
    const a = activityOf(r.activity_type);
    const items = [
      ['Distancia', fmtKm(r.distance_m), 'km', true],
      ['Desnivel +', fmtNum(r.ascent_m), 'm'],
      ['Desnivel −', fmtNum(r.descent_m), 'm'],
      ['Altitud máx', fmtNum(r.ele_max), 'm'],
      ['Altitud mín', fmtNum(r.ele_min), 'm'],
    ];
    /* El IBP solo si lo tiene: la unidad es el acrónimo de la modalidad (HKG/BYC/
       RNG), porque el mismo track puntúa distinto a pie y en bici. */
    if (r.ibp_index != null) items.push(['IBP', fmtNum(r.ibp_index), r.ibp_modality || '']);
    $('#pl-stats').innerHTML = items.map(([l, v, u, acc]) =>
      `<div class="stat${acc ? ' acc' : ''}"${acc ? ` style="border-left-color:${(a || {}).color || 'var(--pr-yellow)'}"` : ''}>
         <div class="l">${l}</div>
         <div class="v">${v}${u ? ` <small>${u}</small>` : ''}</div></div>`
    ).join('');
  }

  /* ── datos técnicos ──────────────────────────────────────────────────────
     Solo campos que el plan tiene de verdad; lo que no está no se inventa. */
  function renderTech() {
    const r = current;
    const rows = [];
    const add = (k, v) => {
      if (v != null && v !== '' && v !== '–') {
        rows.push([k, `<span class="kv-v" title="${esc(String(v))}">${esc(String(v))}</span>`]);
      }
    };
    // Para las filas que llevan un enlace: el valor va en crudo, no escapado.
    const addHtml = (k, html) => rows.push([k, `<span class="kv-v">${html}</span>`]);
    const n = (r.geojson || []).length;
    add('Puntos del track', n ? fmtNum(n) : null);
    add('Desnivel neto', (r.ascent_m != null && r.descent_m != null)
      ? `${r.ascent_m - r.descent_m >= 0 ? '+' : '−'}${fmtNum(Math.abs(r.ascent_m - r.descent_m))} m` : null);
    add('Origen', r.source === 'wikiloc' ? 'Wikiloc' : (r.source === 'dibujada' ? 'Dibujada' : 'Archivo GPX'));
    add('Archivo', r.has_gpx ? 'GPX guardado' : 'Sin archivo');
    add('Añadida', r.created_at ? fmtDate(r.created_at) : null);
    /* Versión del track: solo si el plan se ha editado alguna vez (0 = nunca). Si
       el servidor no manda el campo, no se pinta nada. */
    if (r.version) add('Versión del track', 'v' + r.version);
    if (r.completed_at) {
      /* fmtDate y no fmtDateLong: es la misma fecha larga pero sin versalitas,
         que es como va la fila «Añadida» justo encima (fmtDateLong va en MAYÚSCULAS
         y en esta lista cantaría). */
      add('Realizada', fmtDate(r.completed_at));
      if (r.completed_route_public) {
        /* El nombre sale de la copia LOCAL del listado de rutas (loadDoneRoute):
           así un renombrado se refleja sin denormalizar nada, y mientras no esté
           cargada se enseña el enlace igual. data-nav lo navega el router. */
        const nombre = (doneRoute && doneRoute.name) || 'ver ruta';
        addHtml('Ruta', `<a class="pl-done-link" data-nav="/Sendero/${
          encodeURIComponent(r.completed_route_public)}">${esc(nombre)} →</a>`);
      }
    }
    $('#pl-tech').innerHTML = rows.map(([k, v]) =>
      `<div class="kv-row"><span class="kv-k">${esc(k)}</span>${v}</div>`).join('');
  }

  /* ── dificultad IBP (ibpindex.com) ───────────────────────────────────────
     Solo lo llevan los planes: el IBP sirve para decidir si te metes en una ruta.
     El número lo calcula un tercero (su algoritmo es cerrado, ver core/ibp.py), así
     que el panel tiene tres estados y ninguno miente: con índice, sin índice pero
     con clave (botón), y sin configurar (cómo activarlo). Y NO se interpreta la
     cifra en una escala de dificultad: ibpindex.com no publica los cortes, así que
     inventarlos sería peor que no decir nada. */
  const IBP_ACRO = {hiking: 'HKG', bicycle: 'BYC', running: 'RNG'};
  /* Actividad de Sendero → modalidad del IBP. Ya NO es una copia de la tabla del
     servidor: sale del mismo catálogo (core/activities.py, campo "ibp") que
     usa core/ibp.py, así que no pueden desincronizarse. El servidor hace el
     mismo cambio al recibir el PATCH; esto es para que la vista lo refleje al
     instante (y sin conexión, cuando el PATCH está en la cola). */
  const IBP_MOD_BY_ACT = Object.fromEntries(
    ACTIVITIES.filter(a => a.ibp).map(a => [a.id, a.ibp]));
  const IBP_WEB = 'https://www.ibpindex.com/index.php/es/';

  async function loadConfig() {
    if (_cfgLoaded) return;
    try {
      const c = await (await fetch('/api/config')).json();
      IBP = !!c.ibp;
      _cfgLoaded = true;
    } catch (e) {}                 // sin conexión: se queda como estaba
  }

  function renderIbp() {
    const body = $('#pl-ibp-body'), sub = $('#pl-ibp-sub');
    if (!body || !current) return;
    const n = current.ibp_index;
    if (n != null) {
      sub.textContent = current.ibp_at ? `calculado el ${fmtDate(current.ibp_at)}` : '';
      // Las otras dos modalidades vinieron en la misma llamada: enseñarlas es
      // gratis y explica por qué el número cambia al cambiar la actividad.
      const otras = Object.entries(current.ibp_all || {})
        .filter(([m]) => IBP_ACRO[m] && IBP_ACRO[m] !== current.ibp_modality)
        .map(([m, v]) => `<span class="pl-ibp-alt">${fmtNum(v)} <small>${IBP_ACRO[m]}</small></span>`)
        .join('');
      body.innerHTML = `
        <div class="pl-ibp-fig">
          <span class="pl-ibp-n">${fmtNum(n)}</span>
          <span class="pl-ibp-mod mono">${esc(current.ibp_modality || '')}</span>
        </div>
        ${otras ? `<div class="pl-ibp-otras mono">Otras modalidades ${otras}</div>` : ''}
        <div class="pl-ibp-foot">
          <button class="btn ghost sm" onclick="SEC.plan.computeIbp()">↻ Recalcular</button>
          <a class="pl-ibp-link" href="${IBP_WEB}" target="_blank" rel="noopener">¿Qué es el IBP? ↗</a>
        </div>`;
      return;
    }
    sub.textContent = '';
    body.innerHTML = IBP
      ? `<div class="pl-ibp-none">Este plan aún no tiene índice.</div>
         <div class="pl-ibp-foot">
           <button class="btn sm" onclick="SEC.plan.computeIbp()">Calcular índice IBP</button>
         </div>
         <div class="pl-ibp-warn mono">Sube el GPX de este plan a ibpindex.com.</div>`
      : `<div class="pl-ibp-none">Sin configurar. El índice lo calcula
           <a class="pl-ibp-link" href="${IBP_WEB}" target="_blank" rel="noopener">ibpindex.com</a>:
           pega su clave de API en <strong>Ajustes → IBP Index</strong>.</div>`;
  }

  /* Pedir el índice es de las acciones que EXIGEN conexión (como reescanear o
     Immich en el detalle de una ruta): el número lo decide un servidor ajeno, el
     cliente no puede simularlo, así que no se encola. */
  async function computeIbp() {
    if (!Store.isOnline()) { toast('Calcular el IBP necesita conexión'); return; }
    const tok = _tok;
    $('#pl-ibp-body').innerHTML = '<div class="pl-ibp-none">Analizando en ibpindex.com…</div>';
    let res, j = {};
    try {
      res = await fetch(`/api/planned/${encodeURIComponent(pid)}/ibp`, {method: 'POST'});
      j = await res.json().catch(() => ({}));
    } catch (e) {
      if (tok === _tok) { toast('Calcular el IBP necesita conexión'); renderIbp(); }
      return;
    }
    if (tok !== _tok) return;               // se navegó a otro plan mientras tanto
    if (!res.ok) { toast(j.error || 'No se pudo calcular el IBP'); renderIbp(); return; }
    current.ibp_index    = j.ibp_index;
    current.ibp_modality = j.ibp_modality;
    current.ibp_all      = j.ibp_all || {};
    current.ibp_at       = new Date().toISOString();
    /* Copia local del detalle Y de la fila del listado: sin la segunda, la chapa
       de la tarjeta en «Mis Planes» no aparecería hasta la siguiente
       sincronización con cambios. */
    try {
      await Store.putDetail(pid, current);
      await Store.patchPlanRow(pid, {ibp_index: j.ibp_index, ibp_modality: j.ibp_modality});
    } catch (e) {}
    Store.syncNow({force: true});
    renderIbp();
    renderStats();
    toast(`IBP ${j.ibp_index} ${j.ibp_modality}`);
  }

  /* ── cabecera (dentro del mapa cabecera) ───────────────────────────────── */
  function renderHead() {
    document.title = `Sendero – ${current.name}`;
    $('#pl-d-name').textContent = current.name;
    const d = current.created_at ? new Date(current.created_at) : null;
    $('#pl-d-date').textContent = d
      ? `Añadida el ${d.toLocaleDateString('es-ES', {day: '2-digit', month: 'long', year: 'numeric'})}`
      : '';
    $('#pl-d-source').innerHTML = current.source === 'wikiloc'
      ? '<span class="source-badge">Wikiloc</span>'
      : '<span class="source-badge">GPX</span>';

    $('#pl-download-btn').style.display = current.has_gpx ? '' : 'none';

    const sec = $('#pl-source-section');
    if (current.source === 'wikiloc' && current.source_url) {
      // display inline y no la clase .hidden, por lo mismo que el panel del
      // perfil: el panel lleva data-dtab y la regla de la pestaña activa empata.
      sec.style.display = '';
      $('#pl-source-info').innerHTML =
        `Ruta importada de <a href="${esc(current.source_url)}" target="_blank" rel="noopener">Wikiloc</a>. ` +
        `Consulta la página original para información adicional sobre el itinerario.`;
    } else {
      sec.style.display = 'none';
      $('#pl-source-info').innerHTML = '';
    }
  }

  /* ── plan realizado ───────────────────────────────────────────────────────
     Dos columnas en `planned_routes`: `completed_at` (cuándo se marcó) y la ruta
     real que lo cumplió, opcional. Es el mismo flujo que la tarjeta de «Mis
     Planes», reimplementado aquí con ids pl-: aquello vive en la IIFE de
     sec/planes.js y no se puede llamar desde ésta (puede no estar cargada).

     Se manda con Store.patch, o sea que SIN CONEXIÓN SE ENCOLA. Por eso la fecha
     la pone el cliente: si la pusiera el servidor al vaciar la cola, la marca
     llevaría la fecha en que volvió el wifi, no la del día que se hizo. */

  /* ISO local sin zona, como los `created_at` que escribe el servidor. Con
     toISOString() a secas la marca sería UTC y un plan marcado a las 00:30
     aparecería con la fecha del día anterior. */
  function isoLocal(d) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  }

  function renderDoneBadge() {
    const el = $('#pl-done-badge');
    if (!el) return;
    el.innerHTML = (current && current.completed_at)
      ? '<span class="pl-done-chip">✔ Realizada</span>' : '';
  }

  function renderDoneBtn() {
    const b = $('#pl-done-btn');
    if (!b) return;
    b.textContent = (current && current.completed_at) ? 'Desmarcar' : '✔ Marcar realizada';
  }

  /* Nombre de la ruta que cumplió el plan, desde la copia local del listado (no
     de la red: así la ficha también lo dice sin conexión). Repinta «Datos
     técnicos» cuando llega. */
  async function loadDoneRoute() {
    const tok = _tok;
    const ref = current && current.completed_route_public;
    if (!ref) { doneRoute = null; return; }
    if (doneRoute && doneRoute.public_id === ref) return;
    let row = null;
    try { row = await Store.routeRow(ref); } catch (e) {}
    if (tok !== _tok || !row) return;
    doneRoute = row;
    renderTech();
  }

  /* Listado de rutas del Store (local, también sin conexión): es lo que alimenta
     el selector del modal. */
  async function loadRoutesIndex() {
    const tok = _tok;
    let rows;
    try { rows = await Store.routes(); } catch (e) { return; }
    if (tok !== _tok) return;
    routesRows = rows || [];
    routeIdx = {};
    routesRows.forEach(r => { routeIdx[r.public_id] = r; });
  }

  function toggleDone() {
    if (!current) return;
    $('#pl-actions-more').classList.remove('open');
    if (current.completed_at) undoDone(); else openDoneModal();
  }

  function openDoneModal() {
    if (!current) return;
    $('#pl-done-plan-name').textContent = current.name || '';
    $('#pl-done-search').value = '';
    $('#pl-done-modal').classList.remove('hidden');
    renderDoneList();
    if (!routesRows.length) loadRoutesIndex().then(() => renderDoneList());
  }

  function closeDoneModal() { $('#pl-done-modal').classList.add('hidden'); }

  function filterDoneList() { renderDoneList(); }

  /* Las rutas que salen cerca del inicio del plan van arriba, en «Sugeridas»: con
     unos cientos de rutas, buscar a mano la que lo cumplió es lo tedioso de este
     flujo, y la distancia al punto de salida acierta casi siempre. */
  const NEAR_M = 3000;

  function renderDoneList() {
    const cont = $('#pl-done-list');
    if (!cont) return;
    if (!routesRows.length) {
      cont.innerHTML = '<div class="done-empty">No hay rutas en la copia local todavía.</div>';
      return;
    }
    const term = ($('#pl-done-search').value || '').trim().toLowerCase();
    const match = r => !term
      || (r.name || '').toLowerCase().includes(term)
      || (r.locality || '').toLowerCase().includes(term);
    const cerca = [], resto = [];
    routesRows.filter(match).forEach(r => {
      const near = current && current.start_lat != null && r.start_lat != null
        && haversineM(current.start_lat, current.start_lon, r.start_lat, r.start_lon) <= NEAR_M;
      (near ? cerca : resto).push(r);
    });
    const fila = r => {
      const a = activityOf(r.activity_type);
      return `<div class="done-row" onclick="SEC.plan.markDone('${encodeURIComponent(r.public_id)}')">
        <span class="done-row-ico">${a ? iconSvg(a, 22) : genericIconSvg(22)}</span>
        <span class="done-row-body">
          <span class="done-row-name">${esc(r.name)}</span>
          <span class="done-row-meta">${esc(fmtDate(r.started_at || r.created_at))}
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

  /* `routePublic` = public_id de la ruta que lo cumplió, o null para marcarlo sin
     ruta asociada (no todo plan hecho tiene un track subido). */
  async function markDone(routePublic) {
    if (!current) return;
    const ref = routePublic ? decodeURIComponent(routePublic) : null;
    closeDoneModal();
    const ts = isoLocal(new Date());
    const r = await Store.patch(`/api/planned/${encodeURIComponent(pid)}`,
                                {completed_at: ts, completed_route: ref},
                                {label: 'plan realizado'});
    if (!r.ok) { toast('Error al marcar el plan'); return; }
    await applyDoneLocally(ts, ref);
    const nombre = ref && routeIdx[ref] ? ` · ${routeIdx[ref].name}` : '';
    toast(r.queued ? 'Marcada como realizada (se enviará al recuperar conexión)'
                   : 'Plan marcado como realizado' + nombre);
  }

  async function undoDone() {
    if (!current) return;
    const r = await Store.patch(`/api/planned/${encodeURIComponent(pid)}`,
                                {completed_at: null, completed_route: null},
                                {label: 'plan pendiente'});
    if (!r.ok) { toast('Error al desmarcar el plan'); return; }
    await applyDoneLocally(null, null);
    toast(r.queued ? 'Marcada como pendiente (se enviará al recuperar conexión)'
                   : 'Plan marcado como pendiente');
  }

  /* Hay que escribir LAS DOS copias locales: la del detalle (esta ficha) y la de
     la fila del listado (la tarjeta de «Mis Planes»). Sin la segunda, un cambio
     hecho sin conexión desaparecería al repintar aquella sección, porque la relee
     de IndexedDB y ahí seguiría el estado del servidor. */
  async function applyDoneLocally(ts, ref) {
    current.completed_at = ts;
    current.completed_route_public = ref;
    doneRoute = ref ? (routeIdx[ref] || null) : null;
    try { await Store.putDetail(pid, current); } catch (e) {}
    try {
      await Store.patchPlanRow(pid, {completed_at: ts, completed_route_public: ref});
    } catch (e) {}
    renderDoneBadge();
    renderDoneBtn();
    renderTech();
    if (ref && !doneRoute) loadDoneRoute();
  }

  /* ── actividad ───────────────────────────────────────────────────────────
     El chip va sobre el mapa cabecera: fondo translúcido oscuro a propósito, el
     color solo no se leería sobre una capa satélite (igual que en el detalle de
     ruta). Pulsarlo es la ÚNICA forma de cambiar la actividad del plan. */
  function renderActivityBadge() {
    const a = activityOf(current.activity_type);
    const badge = $('#pl-activity-badge-sm');
    if (!badge) return;
    badge.innerHTML = a
      ? `<span class="act-badge" onclick="SEC.plan.openActivityPicker()"
           style="background:rgba(11,18,14,.55);color:${a.color}">
           <span class="ico">${iconSvg(a, 24)}</span>${esc(a.label)}</span>`
      : `<span class="act-badge" onclick="SEC.plan.openActivityPicker()"
           style="background:rgba(11,18,14,.55);border-color:var(--line-strong);color:var(--muted)">
           + Añadir tipo de actividad</span>`;
  }

  function openActivityPicker() {
    if (!current) return;
    const grid = $('#pl-act-picker-grid');
    grid.innerHTML = '';
    ACTIVITIES.forEach(a => {
      const d = document.createElement('div');
      d.className = 'act-opt' + (current.activity_type === a.id ? ' on' : '');
      d.style.borderColor = current.activity_type === a.id ? a.color : '';
      d.innerHTML = `${iconSvg(a, 40)}
        <span class="act-lbl" style="color:${a.color}">${esc(a.label)}</span>`;
      d.onclick = () => pickActivity(a.id);
      grid.appendChild(d);
    });
    $('#pl-activity-modal').classList.remove('hidden');
  }

  function closeActivityPicker() { $('#pl-activity-modal').classList.add('hidden'); }

  async function pickActivity(actId) {
    closeActivityPicker();
    const r = await Store.patch(`/api/planned/${pid}`, {activity_type: actId},
                                {label: 'actividad del plan'});
    if (!r.ok) { toast('Error al guardar la actividad'); return; }
    current.activity_type = actId;
    /* La actividad tiñe el track, el acento de la 1ª métrica y el relleno del
       perfil: los tres se repintan aquí, sin volver a pedir nada. */
    const a = activityOf(actId);
    /* Solo si la traza va del color de la actividad: cuando hay elevación va
       por pendiente (line-gradient) y line-color no pinta nada. */
    if (map && a && map.getLayer('pl-ruta-linea') && !slopeGradientExpr(current.elevation)) {
      map.setPaintProperty('pl-ruta-linea', 'line-color', a.color);
      // y el punto del hover, que va del color de la traza
      if (map.getLayer('pl-hover-point')) {
        map.setPaintProperty('pl-hover-point', 'circle-color', a.color);
      }
    }
    /* El IBP es por modalidad: al cambiar la actividad, el índice efectivo pasa a
       ser el de la modalidad nueva si la API lo trajo (las tres vienen en la misma
       llamada, así que no hace falta red). El servidor hace lo mismo al aplicar
       este PATCH. */
    const mod = IBP_MOD_BY_ACT[actId];
    if (mod && current.ibp_all && current.ibp_all[mod] != null) {
      current.ibp_index    = current.ibp_all[mod];
      current.ibp_modality = IBP_ACRO[mod];
    }
    renderActivityBadge();
    renderStats();
    renderIbp();
    drawElevation();
    toast(r.queued ? 'Actividad guardada (se enviará al recuperar conexión)'
                   : 'Actividad actualizada');
  }

  /* ── notas ─────────────────────────────────────────────────────────────── */
  async function saveNotes() {
    const notes = $('#pl-notes').value;
    const r = await Store.patch(`/api/planned/${pid}`, {notes}, {label: 'notas del plan'});
    if (!r.ok) { toast('Error al guardar las notas'); return; }
    current.notes = notes;
    toast(r.queued ? 'Notas guardadas (se enviarán al recuperar conexión)' : 'Notas guardadas');
  }

  /* ── pestañas del móvil ───────────────────────────────────────────────────
     En pantalla grande no se ven (el CSS solo las activa por debajo de 768 px),
     así que cambiar de pestaña ahí no tiene efecto visible. Tras mostrar un panel
     oculto hay que redimensionar su Chart: mientras estuvo en display:none su
     canvas medía 0. */
  function setTab(name) {
    const sec = document.getElementById('sec-plan');
    if (!sec) return;
    sec.dataset.tab = name;
    sec.querySelectorAll('.pl-tab').forEach(b =>
      b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'perfil' && elevChart) { try { elevChart.resize(); } catch (e) {} }
  }

  /* ── acciones ──────────────────────────────────────────────────────────── */
  function downloadGpx() { window.location = `/api/planned/${pid}/gpx`; }

  /* El editor opera sobre el estado guardado en el servidor y cada guardado lleva
     su base_version: no se puede encolar sin conexión, así que se avisa en vez de
     navegar a una vista que no podría cargar. */
  function openEditor() {
    if (!pid) return;
    if (!needOnline('El editor necesita conexión')) return;
    go(`/Plan/${encodeURIComponent(pid)}/editor`);
  }

  /* «Unir» tiene pantalla propia desde que salió del editor. Mismo motivo que
     openEditor() para exigir conexión: la pantalla trabaja sobre el estado
     guardado en el servidor y sin él no podría ni cargar. */
  function openUnir() {
    if (!pid) return;
    if (!needOnline('Unir necesita conexión con el servidor')) return;
    go(`/Plan/${encodeURIComponent(pid)}/unir`);
  }

  /* Re-parsea el GPX guardado del plan y devuelve el dict completo, igual que
     GET /api/planned/<pid>. Necesita conexión: lo hace el servidor. */
  async function rescanPlan(btn) {
    if (!current) return;
    if (!needOnline('Reanalizar necesita conexión')) return;
    const tok = _tok, orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Analizando…';
    try {
      const res = await fetch(`/api/planned/${encodeURIComponent(pid)}/rescan`, {method: 'POST'});
      if (tok !== _tok) return;
      if (!res.ok) {
        let j = {};
        try { j = await res.json(); } catch (e) {}
        toast(j.error || 'Error al reanalizar');
        return;
      }
      const data = await res.json();
      if (tok !== _tok) return;
      current = data;
      try { await Store.putDetail(pid, current); } catch (e) {}
      if (tok !== _tok) return;
      render();
      Store.syncNow({force: true});
      toast('Datos actualizados desde el archivo');
    } catch (e) {
      if (tok === _tok) toast('Error de red');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  /* Mapa sin conexión de ESTA ruta: descarga la franja de
     teselas por la que pasa el track, no una región. Es el caso de uso de esta
     vista: una ruta que vas a hacer, guardada antes de salir de casa. */
  function downloadMap() {
    Tiles.downloadForTrack({
      coords: (current && current.geojson) || [],
      capa: capaActual(), infoEl: $('#pl-offline-info'),
      nombre: current && current.name,
    });
  }
  /* La capa que se está viendo ahora mismo en el mapa de esta sección. */
  const capaActual = () => capa || defaultBasemap();

  async function renamePlan() {
    const name = prompt('Nuevo nombre:', current.name);
    if (!name || name === current.name) return;
    const r = await Store.patch(`/api/planned/${pid}`, {name}, {label: 'nombre del plan'});
    if (!r.ok) { toast('Error al renombrar'); return; }
    current.name = name;
    $('#pl-d-name').textContent = name;
    document.title = `Sendero – ${name}`;
    /* la URL canónica es el public_id: renombrar no cambia la URL */
    toast(r.queued ? 'Nombre guardado (se enviará al recuperar conexión)' : 'Ruta renombrada');
  }

  async function removePlan() {
    if (!confirm(`¿Eliminar "${current.name}"?`)) return;
    // Un borrado no se encola sin conexión: es destructivo y no se puede
    // deshacer si el servidor ya lo tenía cambiado.
    if (!Store.isOnline()) { toast('Eliminar necesita conexión'); return; }
    let res;
    try { res = await fetch(`/api/planned/${pid}`, {method: 'DELETE'}); }
    catch (e) { toast('Eliminar necesita conexión'); return; }
    if (!res.ok) { toast('Error al eliminar'); return; }
    Store.syncNow({force: true});
    go('/planificacion');
  }

  /* ── montaje ───────────────────────────────────────────────────────────── */
  /* ── estado de carga ──────────────────────────────────────────────────────
     Mismo diseño que en sec/detalle.js, y por el mismo motivo: los paneles vacíos
     parecían la app colgada y con un servidor que acepta y no contesta lo estaban
     de verdad (ver el tope de tiempo de store.js). El shimmer se retrasa para que
     un plan que ya está en IndexedDB no dé un parpadeo gris. */
  const SKEL_DELAY_MS = 140;
  let _skelTimer = null, _lastParams = null;

  function skeletonOn() {
    const sec = document.getElementById('sec-plan');
    if (sec) sec.classList.add('is-loading');
    const st = $('#pl-stats');
    if (st) st.innerHTML = Array.from({length: 5}, () =>
      '<div class="skel-stat"><div class="skel"></div><div class="skel b"></div></div>').join('');
    const tech = $('#pl-tech');
    if (tech) tech.innerHTML = Array.from({length: 5}, () =>
      '<div class="skel-row"><span class="skel k"></span><span class="skel v"></span></div>').join('');
    const ibp = $('#pl-ibp-body');
    if (ibp) ibp.innerHTML = '<div class="skel-row"><span class="skel k"></span><span class="skel v"></span></div>';
  }
  function skeletonOff() {
    if (_skelTimer) { clearTimeout(_skelTimer); _skelTimer = null; }
    const sec = document.getElementById('sec-plan');
    if (sec) sec.classList.remove('is-loading');
  }
  function skeletonSoon(tok) {
    if (_skelTimer) clearTimeout(_skelTimer);
    _skelTimer = setTimeout(() => { if (tok === _tok) skeletonOn(); }, SKEL_DELAY_MS);
  }
  function loadErrorMsg(e) {
    if (e && e.timeout)   return 'El servidor tardó demasiado en responder.';
    if (e && e.dbBlocked) return 'Otra ventana de Sendero retiene la copia local. Ciérrala y reintenta.';
    if (e && e.offline)   return 'Sin conexión, y este plan no está guardado en este dispositivo.';
    return 'No se pudo cargar este plan.';
  }
  function showLoadError(e) {
    skeletonOff();
    const box = $('#pl-load-error');
    if (!box) return;
    box.querySelector('.le-msg').textContent = loadErrorMsg(e);
    box.classList.remove('hidden');
  }
  function hideLoadError() {
    const box = $('#pl-load-error');
    if (box) box.classList.add('hidden');
  }
  function retry() {
    if (_lastParams) mount(_lastParams, {});
  }

  function showMessage(msg) {
    $('#pl-d-name').textContent = msg;
    $('#pl-stats').innerHTML = '';
    $('#pl-tech').innerHTML = '';
    $('#pl-auto').textContent = '';
    $('#pl-activity-badge-sm').innerHTML = '';
    $('#pl-d-source').innerHTML = '';
    $('#pl-d-date').textContent = '';
    $('#pl-ibp-body').innerHTML = '';
    $('#pl-ibp-sub').textContent = '';
    $('#pl-done-badge').innerHTML = '';
    renderDoneBtn();     // con current a null vuelve a decir "Marcar realizada"
  }

  function render() {
    renderHead();
    renderStats();
    renderTech();
    renderIbp();
    renderActivityBadge();
    renderDoneBadge();
    renderDoneBtn();
    /* Sin await: el nombre de la ruta que cumplió el plan es un adorno de «Datos
       técnicos» y llega de la copia local; cuando esté, repinta esa lista sola. */
    loadDoneRoute();
    $('#pl-auto').textContent = current.auto_summary || '';
    $('#pl-notes').value      = current.notes || '';
    initMap();            // el track se dibuja en map.on('load')
    drawElevation();
    // Si el mapa de esta ruta ya está descargado, decirlo sin que haya que pulsar.
    Tiles.statusForTrack({coords: current.geojson, capa: capaActual(),
                          infoEl: $('#pl-offline-info')});
  }

  async function mount(params, opts) {
    const tok = ++_tok;
    pid = params.id;
    _lastParams = params;
    current = null;
    skeletonOff();
    hideLoadError();
    $('#pl-actions-more').classList.remove('open');
    closeDoneModal();
    doneRoute = null;
    setTab('perfil');          // en móvil, siempre se entra por el perfil
    // El modo pantalla completa del mapa no debe heredarse al montar otro plan.
    const hero = $('#sec-plan .pl-hero');
    if (hero) hero.classList.remove('pl-hero-full');
    showMessage('Cargando…');
    skeletonSoon(tok);
    let data;
    try {
      data = await Store.plan(pid, {bootstrap: (opts && opts.bootstrap) || null});
    } catch (e) {
      if (tok === _tok) { showMessage('No se pudo cargar el plan'); showLoadError(e); }
      return;
    }
    if (tok !== _tok) return;              // se navegó a otra vista mientras cargaba
    if (!data) { skeletonOff(); showMessage('Ruta no encontrada.'); return; }
    current = data;
    skeletonOff();
    render();
    /* Saber si el IBP está configurado no bloquea el pintado: el panel se repinta
       cuando llegue la respuesta (sin conexión no llega y se queda como estaba). */
    loadConfig().then(() => { if (tok === _tok) renderIbp(); });
  }

  function unmount() {
    _tok++;                                // invalida cualquier carga en vuelo
    skeletonOff();
    hideLoadError();
    destroyMap();
    destroyChart();
    closeActivityPicker();
    closeDoneModal();
    $('#pl-actions-more').classList.remove('open');
    setTab('perfil');
    current = null; pid = null; doneRoute = null;
  }

  /* Listeners de documento: se registran UNA vez (loader.js ejecuta este script
     una sola vez), nunca por montaje, para no acumularlos en cada visita. */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const m = $('#pl-activity-modal');
    if (m && !m.classList.contains('hidden')) closeActivityPicker();
    const d = $('#pl-done-modal');
    if (d && !d.classList.contains('hidden')) closeDoneModal();
  });
  document.getElementById('pl-activity-modal').addEventListener('click', e => {
    if (e.target.id === 'pl-activity-modal') closeActivityPicker();
  });
  document.getElementById('pl-done-modal').addEventListener('click', e => {
    if (e.target.id === 'pl-done-modal') closeDoneModal();
  });

  window.SEC.plan = {
    mount, unmount, retry, setTab,
    openActivityPicker, closeActivityPicker, pickActivity,
    saveNotes, downloadGpx, renamePlan, removePlan, downloadMap, computeIbp,
    openEditor, openUnir, toggle3D, rescanPlan,
    toggleDone, openDoneModal, closeDoneModal, filterDoneList, markDone, undoDone,
  };
})();
