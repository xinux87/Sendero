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
  /* Capa base que se está viendo. En el ámbito del módulo, no dentro de
     initMap(), porque el botón "Mapa sin conexión" necesita saber de qué capa
     descargar las teselas. */
  let capa = null;
  // Token de montaje: si se navega a otro plan mientras el fetch está en vuelo,
  // la respuesta vieja no debe pintar nada.
  let _tok = 0;

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
    if (b && map) map.fitBounds(b, {padding: 40, duration: instant ? 0 : 600});
  }

  /* Pinta el track y sus extremos. Se llama en 'load' y OTRA VEZ tras cambiar de
     capa base a/desde la offline: ese salto reconstruye el estilo entero
     (applyBasemap → setStyle) y se lleva por delante fuentes y capas de datos. */
  function drawTrack() {
    const coords = (current && current.geojson) || [];
    if (!map || !coords.length || map.getSource('pl-ruta')) return;
    map.addSource('pl-ruta', {type: 'geojson',
      data: {type: 'Feature', geometry: {type: 'LineString', coordinates: coords}}});
    map.addLayer({id: 'pl-ruta-linea', type: 'line', source: 'pl-ruta',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': '#e8c44a', 'line-width': 3, 'line-opacity': .9}});
    // inicio (verde) y fin (rojo) como capas circle, no como marcadores DOM
    map.addSource('pl-ruta-extremos', {type: 'geojson', data: {type: 'FeatureCollection', features: [
      {type: 'Feature', properties: {tipo: 'Inicio'}, geometry: {type: 'Point', coordinates: coords[0]}},
      {type: 'Feature', properties: {tipo: 'Final'},  geometry: {type: 'Point', coordinates: coords[coords.length - 1]}},
    ]}});
    map.addLayer({id: 'pl-ruta-extremos', type: 'circle', source: 'pl-ruta-extremos',
      paint: {'circle-radius': 6,
        'circle-color': ['match', ['get', 'tipo'], 'Inicio', '#5ab87a', '#d24a3a'],
        'circle-stroke-width': 2.5, 'circle-stroke-color': '#101a14'}});
  }

  function initMap() {
    const b = trackBounds();
    const cx = b ? (b[0][0] + b[1][0]) / 2 : -1.6;
    const cy = b ? (b[0][1] + b[1][1]) / 2 : 42.5;
    if (!capa) capa = defaultBasemap();
    map = new maplibregl.Map({
      container: 'pl-map', style: buildStyle(capa),
      center: [cx, cy], zoom: b ? 12 : 6, attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'bottom-right');
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
    // selector de capas base
    map.addControl({
      onAdd() {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:var(--panel,#fff);color:var(--ink,#101a14);border:none;font-size:12px;cursor:pointer;padding:5px 7px;font-family:inherit;width:100%';
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
    map.on('load', () => { drawTrack(); fitRoute(true); });
    map.on('sendero:basemap', () => drawTrack());
  }

  function destroyMap() {
    if (!map) return;
    try { map.remove(); } catch (e) {}
    map = null;
  }

  /* ── gráfico de elevación ──────────────────────────────────────────────── */
  function drawElevation() {
    const elev = (current && current.elevation) || [];
    if (!elev.length) return;
    const ctx = $('#pl-elev').getContext('2d');
    const labels = elev.map(p => p.d);
    const data   = elev.map(p => p.e);
    const grad = ctx.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, 'rgba(232,196,74,.35)');
    grad.addColorStop(1, 'rgba(232,196,74,.02)');
    elevChart = new Chart(ctx, {
      type: 'line',
      data: {labels, datasets: [{
        data, fill: true, backgroundColor: grad,
        borderColor: '#e8c44a', borderWidth: 2, pointRadius: 0, tension: .35,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {legend: {display: false}, tooltip: {callbacks: {
          title: i => `${i[0].label} km`,
          label: i => `${i.raw} m`,
        }}},
        scales: {
          x: {ticks: {color: '#8aa394', font: {size: 10},
              callback: (v, i) => i % Math.ceil(labels.length / 8) === 0 ? labels[i].toFixed(1) : ''},
              grid: {color: '#2c4435'}},
          y: {ticks: {color: '#8aa394', font: {size: 10}, callback: v => `${v}m`},
              grid: {color: '#2c4435'}},
        },
      },
    });
  }

  function destroyChart() {
    if (!elevChart) return;
    try { elevChart.destroy(); } catch (e) {}
    elevChart = null;
  }

  /* ── stats ─────────────────────────────────────────────────────────────── */
  function renderStats() {
    const r = current;
    const stats = [
      {v: fmtKm(r.distance_m), l: 'km'},
      r.ascent_m  ? {v: `${Math.round(r.ascent_m)}<small> m</small>`,  l: '↑ Desnivel'} : null,
      r.descent_m ? {v: `${Math.round(r.descent_m)}<small> m</small>`, l: '↓ Bajada'} : null,
      r.ele_max !== null ? {v: `${Math.round(r.ele_max)}<small> m</small>`, l: 'Altitud máx.'} : null,
      r.ele_min !== null ? {v: `${Math.round(r.ele_min)}<small> m</small>`, l: 'Altitud mín.'} : null,
    ].filter(Boolean);
    $('#pl-stats').innerHTML = stats.map(s =>
      `<div class="stat"><div class="v">${s.v}</div><div class="l">${s.l}</div></div>`
    ).join('');
  }

  /* ── cabecera ──────────────────────────────────────────────────────────── */
  function renderHead() {
    document.title = `Sendero – ${current.name}`;
    $('#pl-d-name').textContent = current.name;
    const d = current.created_at ? new Date(current.created_at) : null;
    $('#pl-d-date').textContent = d
      ? d.toLocaleDateString('es-ES', {day: '2-digit', month: 'long', year: 'numeric'})
      : '';
    $('#pl-d-source').innerHTML = current.source === 'wikiloc'
      ? '<span class="source-badge source-wikiloc">Wikiloc</span>'
      : '<span class="source-badge source-gpx">GPX</span>';

    $('#pl-download-btn').style.display = current.has_gpx ? '' : 'none';

    const sec = $('#pl-source-section');
    if (current.source === 'wikiloc' && current.source_url) {
      sec.classList.remove('hidden');
      $('#pl-source-info').innerHTML =
        `Ruta importada de <a href="${esc(current.source_url)}" target="_blank" rel="noopener">Wikiloc</a>. ` +
        `Consulta la página original para información adicional sobre el itinerario.`;
    } else {
      sec.classList.add('hidden');
      $('#pl-source-info').innerHTML = '';
    }
  }

  /* ── actividad ─────────────────────────────────────────────────────────── */
  function renderActivityBadge() {
    const a = activityOf(current.activity_type);
    const badge = $('#pl-activity-badge-sm');
    if (!badge) return;
    badge.innerHTML = a
      ? `<div class="act-badge" style="color:${a.color};border-color:${a.color}"
           onclick="SEC.plan.openActivityPicker()">${iconSvg(a, 18)} ${esc(a.label)}</div>`
      : `<div class="act-badge" style="color:var(--muted);border-color:var(--muted)"
           onclick="SEC.plan.openActivityPicker()">Sin tipo</div>`;
  }

  function openActivityPicker() {
    const grid = $('#pl-act-picker-grid');
    grid.innerHTML = '';
    ACTIVITIES.forEach(a => {
      const d = document.createElement('div');
      d.className = 'act-opt' + (current.activity_type === a.id ? ' on' : '');
      d.style.borderColor = current.activity_type === a.id ? a.color : '';
      d.innerHTML = `<div class="act-ico-lg">${iconSvg(a, 36)}</div>
        <div class="act-lbl" style="color:${a.color}">${esc(a.label)}</div>`;
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
    renderActivityBadge();
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

  /* ── acciones ──────────────────────────────────────────────────────────── */
  function downloadGpx() { window.location = `/api/planned/${pid}/gpx`; }

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
  function showMessage(msg) {
    $('#pl-d-name').textContent = msg;
    $('#pl-stats').innerHTML = '';
    $('#pl-auto').textContent = '';
  }

  function render() {
    renderHead();
    renderStats();
    renderActivityBadge();
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
    current = null;
    showMessage('Cargando…');
    let data;
    try {
      data = await Store.plan(pid, {bootstrap: (opts && opts.bootstrap) || null});
    } catch (e) {
      if (tok === _tok) showMessage('No se pudo cargar este plan sin conexión.');
      return;
    }
    if (tok !== _tok) return;              // se navegó a otra vista mientras cargaba
    if (!data) { showMessage('Ruta no encontrada.'); return; }
    current = data;
    render();
  }

  function unmount() {
    _tok++;                                // invalida cualquier carga en vuelo
    destroyMap();
    destroyChart();
    closeActivityPicker();
    current = null; pid = null;
  }

  /* Listeners de documento: se registran UNA vez (loader.js ejecuta este script
     una sola vez), nunca por montaje, para no acumularlos en cada visita. */
  document.addEventListener('keydown', e => {
    const m = $('#pl-activity-modal');
    if (e.key === 'Escape' && m && !m.classList.contains('hidden')) closeActivityPicker();
  });
  document.getElementById('pl-activity-modal').addEventListener('click', e => {
    if (e.target.id === 'pl-activity-modal') closeActivityPicker();
  });

  window.SEC.plan = {
    mount, unmount,
    openActivityPicker, closeActivityPicker, pickActivity,
    saveNotes, downloadGpx, renamePlan, removePlan, downloadMap,
  };
})();
