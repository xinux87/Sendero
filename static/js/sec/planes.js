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
          // marcadores por delante: se recrean (son marcadores DOM, no capas).
          applyBasemap(map, basemap);
          if (prev === OFFLINE_LAYER || basemap === OFFLINE_LAYER) {
            map.once('sendero:basemap', () => { markers = {}; addMarkers(plans); });
          }
        };
        const wrap = document.createElement('div');
        wrap.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        wrap.appendChild(sel);
        return wrap;
      }, onRemove() {},
    }, 'top-left');
    map.on('load', () => { mapLoaded = true; });
  }

  function destroyMap() {
    Object.values(markers).forEach(m => { try { m.remove(); } catch (e) {} });
    markers = {};
    if (map) { try { map.remove(); } catch (e) {} }
    map = null;
    mapLoaded = false;
  }

  function addMarkers(rows) {
    if (!map) return;
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
    const pts = rows.filter(p => p.start_lat != null);
    if (!pts.length) return;
    let mnLo = Infinity, mxLo = -Infinity, mnLa = Infinity, mxLa = -Infinity;
    pts.forEach(p => {
      if (p.start_lon < mnLo) mnLo = p.start_lon;
      if (p.start_lon > mxLo) mxLo = p.start_lon;
      if (p.start_lat < mnLa) mnLa = p.start_lat;
      if (p.start_lat > mxLa) mxLa = p.start_lat;
    });
    const fit = () => { try { map.fitBounds([[mnLo, mnLa], [mxLo, mxLa]], {padding: 50}); } catch (e) {} };
    if (mapLoaded || map.loaded()) fit(); else map.once('load', fit);
  }

  /* ── tarjetas ──────────────────────────────────────────────────────────── */
  function makeCard(p) {
    const a = activityOf(p.activity_type);
    const div = document.createElement('div');
    div.className = 'plan-card';
    div.style.borderLeftColor = a ? a.color : 'var(--line-strong)';
    div.onclick = () => go('/Plan/' + encodeURIComponent(p.public_id));
    div.innerHTML = `<div class="plan-act">${a ? iconSvg(a, 26) : genericIconSvg(26)}</div>
      <h3>${esc(p.name)}</h3><div class="date">${fmtDate(p.created_at)}</div>
      <span class="source-badge source-gpx">GPX</span>
      <div class="plan-metrics">
        <div class="pm"><span class="v">${fmtKm(p.distance_m)}</span><span class="l">km</span></div>
        ${p.ascent_m ? `<div class="pm"><span class="v">${Math.round(p.ascent_m)}<small> m</small></span><span class="l">↑ Desnivel</span></div>` : ''}
      </div>`;
    return div;
  }

  function render(rows) {
    const grid = q('#plan-grid'), empty = q('#no-plans');
    grid.innerHTML = '';
    if (!rows.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    rows.forEach(p => grid.appendChild(makeCard(p)));
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
    addMarkers(plans);
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
    initMap();
    await reload();
    if (tok !== _tok) return;
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
    hideLoader();
    if (_unsub) { _unsub(); _unsub = null; }
    plans = [];
  }

  /* Listeners de documento: una sola vez al cargar el archivo. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && visible()) closeAddModal();
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

  window.SEC.planes = {mount, unmount, openAddModal, closeAddModal, openPlanner, uploadPlanGpx};
})();
