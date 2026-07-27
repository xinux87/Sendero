/* Sección `rutas` ("Mis Rutas"). Portado de la app multipágina
   (`git show v0.7.1:templates/app.html`).
   Markup en templates/sec/rutas.html, CSS en static/css/rutas.css.

   El cambio de fondo: el listado ya NO viene de `fetch('/api/routes')` cacheado
   en sessionStorage con TTL de 10 minutos, sino de `Store.routes()` (IndexedDB +
   sincronización delta). Consecuencias:

   - La lista se pinta sin conexión, con lo último que se sincronizó.
   - Desaparecen `sendero_routes_v4`, su TTL, `silentRefresh()` y el apaño
     `sendero_cache_dirty` que usaban las otras vistas para invalidarla: ahora la
     frescura la decide el servidor por `rev`, y un cambio hecho en otro sitio
     llega por `Store.onChange`.
   - Lo que sí sigue en sessionStorage son los FILTROS (actividad/fechas/orden/
     vista): son preferencias de la sesión, no datos.

   Contrato: mount(params, opts) / unmount(). unmount() DEBE destruir el mapa. */
(() => {
  'use strict';

  const MONTHS_LONG = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
                       'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul',
                        'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const PAGE_SIZE = 30;
  const FILTER_CACHE = 'sendero_filters_v1';
  const LINES_MINZOOM = 10, LINES_PREFETCH_ZOOM = LINES_MINZOOM - 2, POINTS_MAXZOOM = 12;

  let allRoutes = [], activeActs = null;
  let sortOrder = 'desc', viewMode = 'a', searchQ = '', dupOnly = false;
  let editMode = false, selectedIds = new Set(), visibleRoutes = [];
  let monthDomMap = new Map();
  let pendingRoutes = [], listObserver = null;
  let dpFrom = null, dpTo = null;

  let map = null, mapLoaded = false, mapRoutes = [];
  let fitTimer = null, userMoved = false;
  let basemap = null;                   // capa elegida; sobrevive a recrear el mapa
  let camera = null;                    // encuadre a restaurar al volver de un detalle
  let lineIds = new Set(), lineFeaturesAll = [], lineTimer = null, lineFetching = false;
  let clusterLabels = {};
  let _tok = 0, _unsub = null;

  const q = sel => document.querySelector('#sec-rutas ' + sel);
  const visible = () => {
    const el = document.getElementById('sec-rutas');
    return !!el && !el.classList.contains('hidden');
  };

  /* ── selector de fecha ─────────────────────────────────────────────────── */
  class DatePicker {
    constructor(wrap, placeholder, onChange) {
      this.onChange = onChange; this.value = null; this.ph = placeholder;
      const t = new Date().toISOString().slice(0, 7).split('-');
      this.viewY = +t[0]; this.viewM = +t[1] - 1;
      wrap.innerHTML = `<button class="dp-btn" type="button">${placeholder}</button>
        <div class="dp-pop hidden">
          <div class="dp-head">
            <button class="dp-nav dp-prev" type="button">‹</button>
            <span class="dp-title"></span>
            <button class="dp-nav dp-next" type="button">›</button>
          </div>
          <div class="dp-grid"></div>
          <button class="dp-clear-btn" type="button">Quitar fecha</button>
        </div>`;
      this.btn = wrap.querySelector('.dp-btn'); this.pop = wrap.querySelector('.dp-pop');
      this.title = wrap.querySelector('.dp-title'); this.grid = wrap.querySelector('.dp-grid');
      this.btn.onclick = e => { e.stopPropagation(); this.toggle(); };
      wrap.querySelector('.dp-prev').onclick = e => {
        e.stopPropagation(); this.viewM--;
        if (this.viewM < 0) { this.viewM = 11; this.viewY--; }
        this.renderGrid();
      };
      wrap.querySelector('.dp-next').onclick = e => {
        e.stopPropagation(); this.viewM++;
        if (this.viewM > 11) { this.viewM = 0; this.viewY++; }
        this.renderGrid();
      };
      wrap.querySelector('.dp-clear-btn').onclick = e => {
        e.stopPropagation(); this.set(null); this.close();
      };
      // Un solo listener por instancia, y la instancia se crea una vez por
      // documento (mount() reutiliza las que ya existen).
      this._docClick = e => { if (!wrap.contains(e.target)) this.close(); };
      document.addEventListener('click', this._docClick);
      this.renderGrid();
    }
    toggle() {
      const was = this.pop.classList.contains('hidden');
      this.pop.classList.toggle('hidden');
      if (was) {
        const r = this.btn.getBoundingClientRect();
        this.pop.style.top = (r.bottom + 6) + 'px';
        // clamp al viewport: en móvil el botón puede estar pegado al borde
        const w = this.pop.offsetWidth || 230;
        this.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        this.renderGrid();
      }
    }
    close() { this.pop.classList.add('hidden'); }
    set(val) {
      this.value = val;
      if (val) {
        const [y, m, d] = val.split('-');
        this.btn.textContent = `${+d} ${MONTHS_SHORT[+m - 1]} ${y}`;
        this.btn.classList.add('has-val');
      } else {
        this.btn.textContent = this.ph;
        this.btn.classList.remove('has-val');
      }
      this.onChange(val);
    }
    renderGrid() {
      const today = new Date().toISOString().slice(0, 10);
      this.title.textContent = `${MONTHS_LONG[this.viewM]} ${this.viewY}`;
      const firstDow = new Date(this.viewY, this.viewM, 1).getDay();
      const offset = (firstDow + 6) % 7;
      const days = new Date(this.viewY, this.viewM + 1, 0).getDate();
      let h = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => `<div class="dp-dow">${d}</div>`).join('');
      for (let i = 0; i < offset; i++) h += '<div class="dp-day empty"></div>';
      for (let d = 1; d <= days; d++) {
        const ymd = `${this.viewY}-${String(this.viewM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const cls = 'dp-day' + (ymd === this.value ? ' sel' : '') + (ymd === today ? ' today' : '');
        h += `<button class="${cls}" data-ymd="${ymd}" type="button">${d}</button>`;
      }
      this.grid.innerHTML = h;
      this.grid.querySelectorAll('.dp-day[data-ymd]').forEach(b => {
        b.onclick = e => {
          e.stopPropagation();
          const [y, m] = b.dataset.ymd.split('-');
          this.viewY = +y; this.viewM = +m - 1;
          this.set(b.dataset.ymd); this.close();
        };
      });
    }
  }

  /* ── filtros (preferencias, no datos: siguen en sessionStorage) ─────────── */
  function saveFilterState() {
    try {
      sessionStorage.setItem(FILTER_CACHE, JSON.stringify({
        acts: [...activeActs], from: dpFrom && dpFrom.value, to: dpTo && dpTo.value,
        sort: sortOrder, view: viewMode, q: searchQ, dup: dupOnly,
      }));
    } catch (e) {}
  }
  function loadFilterState() {
    try { const r = sessionStorage.getItem(FILTER_CACHE); return r ? JSON.parse(r) : null; }
    catch (e) { return null; }
  }

  const allSelected = () => activeActs.size === ACTIVITIES.length;

  /* Píldoras de actividad del rediseño: seleccionada = relleno sólido de su color
     con tinta oscura; sin seleccionar = su color sobre transparente con borde. */
  function buildPills() {
    const box = q('#act-pills');
    box.innerHTML = '';
    ACTIVITIES.forEach(a => {
      const on = activeActs.has(a.id);
      const p = document.createElement('button');
      p.className = 'pill' + (on ? ' on' : '');
      p.style.cssText = on
        ? `background:${a.color};border-color:${a.color};color:var(--bg)`
        : `background:transparent;border-color:${a.color};color:${a.color}`;
      p.textContent = a.label;
      p.onclick = () => {
        if (activeActs.has(a.id)) activeActs.delete(a.id); else activeActs.add(a.id);
        buildPills(); saveFilterState(); renderList();
      };
      box.appendChild(p);
    });
  }

  function clearFilters() {
    activeActs = new Set(ACTIVITIES.map(a => a.id));
    dpFrom.set(null); dpTo.set(null);
    searchQ = '';
    dupOnly = false;
    const s = q('#route-search');
    if (s) s.value = '';
    const d = q('#dup-filter');
    if (d) d.classList.remove('on');
    buildPills(); saveFilterState(); renderList();
  }

  function setSort(order) {
    sortOrder = order;
    q('#sort-desc').classList.toggle('on', order === 'desc');
    q('#sort-asc').classList.toggle('on', order === 'asc');
    saveFilterState(); renderList();
  }

  /* Tres vistas: 'a' cuadrícula de tarjetas, 'b' panel (lista + mapa grande),
     't' tabla densa (la variante del rediseño para los meses antiguos). */
  function setView(v) {
    // En móvil la Vista B "Panel" no aporta (todo acaba apilado): se fuerza la A
    // aunque venga 'b' guardada en el estado de filtros.
    if (v === 'b' && window.matchMedia('(max-width:600px)').matches) v = 'a';
    const cambia = v !== viewMode;
    viewMode = v;
    q('#dash-wrap').className = 'view-' + v;
    ['a', 'b', 't'].forEach(k => {
      const el = document.getElementById('view-' + k);
      if (el) el.classList.toggle('on', v === k);
    });
    if (map) setTimeout(() => { if (map) { map.resize(); fitMap(); } }, 60);
    saveFilterState();
    // Tarjetas ↔ tabla es otro markup: hay que repintar la lista.
    if (cambia && allRoutes.length) renderList();
  }

  function setSearch(texto) {
    searchQ = (texto || '').trim().toLowerCase();
    saveFilterState();
    renderList();
  }

  function toggleDupOnly() {
    dupOnly = !dupOnly;
    q('#dup-filter').classList.toggle('on', dupOnly);
    saveFilterState();
    renderList();
  }

  /* El filtro de duplicadas solo existe si hay algo que filtrar: si no queda
     ninguna marcada (porque se borraron o se descartó el aviso), desaparece y se
     apaga solo, o el listado se quedaría vacío sin explicación. */
  function updateDupFilter() {
    const n = allRoutes.filter(r => r.dup_suspect_of).length;
    const btn = q('#dup-filter');
    if (!btn) return;
    q('#dup-filter-count').textContent = n;
    btn.style.display = n ? '' : 'none';
    if (!n && dupOnly) { dupOnly = false; saveFilterState(); }
    btn.classList.toggle('on', dupOnly);
  }

  function passesFilter(r) {
    const from = dpFrom && dpFrom.value, to = dpTo && dpTo.value;
    if (!allSelected() && !activeActs.has(r.activity_type)) return false;
    if (from || to) {
      const d = r.started_at ? r.started_at.slice(0, 10) : null;
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
    }
    // Solo posibles duplicadas (las que marcó la ingesta automática).
    if (dupOnly && !r.dup_suspect_of) return false;
    // Buscador: nombre y localidad, que es lo que el listado trae (el nombre del
    // archivo no está en ROUTE_LIST_COLS).
    if (searchQ) {
      const hay = `${r.name || ''} ${r.locality || ''}`.toLowerCase();
      if (!hay.includes(searchQ)) return false;
    }
    return true;
  }

  /* ── tarjetas ──────────────────────────────────────────────────────────── */
  function pinSvg() {
    return '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
  }

  function camSvg() {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';
  }

  /* Nº de fotos: solo si hay alguna (un «0» en cada tarjeta sería ruido). */
  function photosHtml(r) {
    const n = r.n_photos || 0;
    if (!n) return '';
    return `<span class="card-photos" title="${n} ${n === 1 ? 'foto' : 'fotos'}">`
         + `${camSvg()}${n}</span>`;
  }

  /* Aviso de GPS. El listado NO trae los tramos (solo cuántos son y si alguno es
     grave, ver ROUTE_LIST_COLS): el detalle y el editor los desglosan. */
  function gpsWarnText(r) {
    const n = r.gps_issues_n || 0;
    if (!n) return null;
    return n === 1 ? '1 aviso GPS' : `${n} avisos GPS`;
  }

  /* Alterna la selección de una ruta en modo edición (lo comparten la tarjeta y
     la fila de la tabla). */
  function toggleSel(id, el, check) {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    const on = selectedIds.has(id);
    el.classList.toggle('selected', on);
    if (check) check.textContent = on ? '✓' : '';
    updateSelCount();
  }

  function makeCard(r) {
    const act = activityOf(r.activity_type);
    const sel = selectedIds.has(r.public_id);
    const c = document.createElement('div');
    c.className = 'card' + (editMode ? ' edit-mode' : '') + (sel ? ' selected' : '');
    c.dataset.id = r.public_id;
    c.style.borderLeftColor = act ? act.color : 'var(--line-strong)';
    if (editMode) {
      c.onclick = () => toggleSel(r.public_id, c, c.querySelector('.card-check'));
    } else {
      c.onclick = () => openRoute(r.public_id);
    }
    const thumbHtml = !editMode && r.thumb_file
      ? `<div class="card-thumb"><img src="/api/routes/${r.public_id}/thumb" alt="" loading="lazy"></div>` : '';
    const dupBadge = r.dup_suspect_of
      ? '<div class="card-badge card-dup" title="Importada automáticamente, se parece a otra ruta. Ábrela para revisarla.">⚠ posible duplicada</div>' : '';
    // Los avisos GPS se pintan en ámbar si alguno es grave y apagados si no, el
    // mismo criterio que «Calidad del track» del detalle (.warn.crit/.warn.info).
    const gpsTxt = gpsWarnText(r);
    const gpsBadge = gpsTxt
      ? `<div class="card-badge card-gps${r.gps_issues_high ? ' crit' : ''}"`
        + ` title="Tramos con datos GPS imposibles. Ábrela para verlos o corrígelos en el editor.">`
        + `⚠ ${gpsTxt}</div>` : '';
    const badges = (dupBadge || gpsBadge)
      ? `<div class="card-badges">${dupBadge}${gpsBadge}</div>` : '';
    const distHtml = r.distance_m ? `<span class="card-dist">${fmtKm(r.distance_m)} km</span>` : '';
    const locHtml = r.locality
      ? `<span class="card-loc" title="${esc(r.locality)}">${pinSvg()}${esc(r.locality)}</span>` : '';
    const phHtml = photosHtml(r);
    const metaHtml = (distHtml || locHtml || phHtml)
      ? `<div class="card-meta">${distHtml}${locHtml}${phHtml}</div>` : '';
    c.innerHTML = `${thumbHtml}
      ${editMode ? `<div class="card-check">${sel ? '✓' : ''}</div>`
                 : (act ? `<div class="card-act">${iconSvg(act, 26)}</div>` : '')}
      <div class="card-body">
        <h3>${esc(r.name)}</h3>
        <div class="date">${fmtDateLong(r.started_at)}</div>
        ${metaHtml}
        ${badges}
      </div>`;
    return c;
  }

  /* Fila de la vista ☰ Tabla. El "Estado" dice lo que trae el listado: si la
     importación automática la marcó como posible duplicada y si tiene avisos de
     GPS (gps_issues_n/gps_issues_high van en ROUTE_LIST_COLS). */
  function makeRow(r) {
    const act = activityOf(r.activity_type);
    const sel = selectedIds.has(r.public_id);
    const tr = document.createElement('tr');
    tr.className = sel ? 'selected' : '';
    tr.dataset.id = r.public_id;
    tr.onclick = editMode ? () => toggleSel(r.public_id, tr, null)
                          : () => openRoute(r.public_id);
    const gpsTxt = gpsWarnText(r);
    const estados = [];
    if (r.dup_suspect_of) {
      estados.push('<span class="t-state warn" title="Importada automáticamente, '
                 + 'se parece a otra ruta">⚠ DUPLICADA</span>');
    }
    if (gpsTxt) {
      estados.push(`<span class="t-state${r.gps_issues_high ? ' warn' : ' info'}"`
                 + ` title="${esc(gpsTxt)}: tramos con datos GPS imposibles">`
                 + `⚠ ${r.gps_issues_n} GPS</span>`);
    }
    const estado = estados.length ? estados.join('')
                                  : '<span class="t-state">OK</span>';
    tr.innerHTML = `
      <td class="t-name" title="${esc(r.name)}">${esc(r.name)}</td>
      <td class="t-zone">${esc(r.locality || '—')}</td>
      <td class="t-date">${_fechaCorta(r.started_at)}</td>
      <td class="num t-dist">${r.distance_m ? fmtKm(r.distance_m) + ' km' : '—'}</td>
      <td class="num t-asc">${r.ascent_m ? fmtNum(r.ascent_m) + ' m' : '—'}</td>
      <td class="num">${fmtHM(r.moving_s || r.duration_s)}</td>
      <td class="t-act">${act ? esc(act.label) : '—'}</td>
      <td>${estado}</td>`;
    return tr;
  }

  function _fechaCorta(iso) {
    if (!iso) return '—';
    const d = new Date(iso), p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
  }

  const TABLA_HEAD = `<colgroup>
      <col class="c-name"><col class="c-zone"><col class="c-date"><col class="c-dist">
      <col class="c-asc"><col class="c-time"><col class="c-act"><col class="c-state">
    </colgroup><thead><tr>
      <th>Ruta</th><th class="t-zone">Zona</th><th>Fecha</th>
      <th class="num">Dist.</th><th class="num t-asc">D+</th><th class="num">Tiempo</th>
      <th class="t-act">Actividad</th><th>Estado</th>
    </tr></thead><tbody></tbody>`;

  /* Abrir una ruta guarda el encuadre del mapa para restaurarlo al volver. */
  function openRoute(pid) {
    saveCamera();
    go('/Sendero/' + encodeURIComponent(pid));
  }

  /* ── listado con scroll infinito ───────────────────────────────────────── */
  function monthLabel(key) {
    if (key === 'sin-fecha') return 'Sin fecha';
    const [y, m] = key.split('-');
    return `${MONTHS_LONG[+m - 1]} ${y}`;
  }

  function createMonthSection(key) {
    const s = document.createElement('div');
    s.className = 'month-group';
    s.dataset.key = key;
    let selBtn = '';
    if (editMode) {
      const mRoutes = visibleRoutes.filter(r => (r.started_at ? r.started_at.slice(0, 7) : 'sin-fecha') === key);
      const allSel = mRoutes.length > 0 && mRoutes.every(r => selectedIds.has(r.public_id));
      selBtn = `<button class="month-sel-btn${allSel ? ' all-sel' : ''}" onclick="SEC.rutas.selectMonth('${key}')">`
        + (allSel ? '✓ Mes seleccionado' : 'Selec. mes') + '</button>';
    }
    const cuerpo = viewMode === 't'
      ? `<div class="table-scroll"><table class="rtable">${TABLA_HEAD}</table></div>`
      : '<div class="grid"></div>';
    s.innerHTML = `<div class="month-label">${monthLabel(key).toUpperCase()}`
      + `<span class="month-count"></span>${selBtn}</div>${cuerpo}`;
    return s;
  }

  function selectMonth(key) {
    const mr = visibleRoutes.filter(r => (r.started_at ? r.started_at.slice(0, 7) : 'sin-fecha') === key);
    const allSel = mr.length > 0 && mr.every(r => selectedIds.has(r.public_id));
    if (allSel) mr.forEach(r => selectedIds.delete(r.public_id));
    else mr.forEach(r => selectedIds.add(r.public_id));
    updateSelCount(); renderList();
  }

  function renderList() {
    monthDomMap.clear();
    const box = q('#routes');
    box.innerHTML = '';
    const filtered = allRoutes.filter(passesFilter).sort((a, b) => {
      const da = a.started_at || '', db = b.started_at || '';
      return sortOrder === 'asc' ? (da > db ? 1 : da < db ? -1 : 0)
                                 : (da < db ? 1 : da > db ? -1 : 0);
    });
    updateCountDisplay(allRoutes.length, filtered.length);
    q('#no-routes').classList.toggle('hidden', filtered.length > 0);
    visibleRoutes = [];
    pendingRoutes = filtered.slice();
    // En modo edición se renderiza todo de una vez: "Selec. mes" y "Seleccionar
    // todos" necesitan que cada tarjeta ya exista en el DOM.
    loadNextListPage(editMode ? pendingRoutes.length : PAGE_SIZE);
    renderMap(filtered);
  }

  function appendBatchToDOM(routes) {
    routes.forEach(r => {
      if (!passesFilter(r)) return;
      visibleRoutes.push(r);
      const key = r.started_at ? r.started_at.slice(0, 7) : 'sin-fecha';
      if (!monthDomMap.has(key)) {
        const section = createMonthSection(key);
        q('#routes').appendChild(section);
        monthDomMap.set(key, {section, count: 0,
          grid: section.querySelector(viewMode === 't' ? '.rtable tbody' : '.grid')});
      }
      const grp = monthDomMap.get(key);
      grp.grid.appendChild(viewMode === 't' ? makeRow(r) : makeCard(r));
      grp.count++;
      grp.section.querySelector('.month-count').textContent =
        `${grp.count} ruta${grp.count !== 1 ? 's' : ''}`;
    });
    q('#no-routes').classList.toggle('hidden', visibleRoutes.length > 0);
  }

  function loadNextListPage(n) {
    teardownSentinel();
    const slice = pendingRoutes.splice(0, n);
    if (slice.length) appendBatchToDOM(slice);
    setupSentinel();
  }

  function setupSentinel() {
    if (!pendingRoutes.length) return;
    const s = document.createElement('div');
    s.id = 'list-sentinel';
    s.style.cssText = 'height:1px';
    q('#routes').appendChild(s);
    if (!listObserver) {
      listObserver = new IntersectionObserver(es => {
        if (es[0].isIntersecting) loadNextListPage(PAGE_SIZE);
      }, {rootMargin: '800px'});
    }
    listObserver.observe(s);
  }

  function teardownSentinel() {
    if (listObserver) listObserver.disconnect();
    const s = document.getElementById('list-sentinel');
    if (s) s.remove();
  }

  function updateCountDisplay(loaded, shown) {
    const el = document.getElementById('count');
    if (!el) return;
    if (!loaded) { el.textContent = ''; return; }
    el.textContent = shown < loaded ? `${shown} de ${loaded} ruta(s)` : `${loaded} ruta(s)`;
  }

  /* ── modo edición ──────────────────────────────────────────────────────── */
  function toggleEdit() {
    editMode = !editMode;
    selectedIds.clear();
    q('#edit-toggle-btn').classList.toggle('on', editMode);
    q('#edit-bar').classList.toggle('on', editMode);
    updateDedupBtn(); updateSelCount(); renderList();
  }

  function updateDedupBtn() {
    const n = allRoutes.filter(r => r.dup_suspect_of).length;
    const btn = q('#dedup-btn');
    if (!btn) return;
    q('#dedup-count').textContent = n;
    btn.style.display = (editMode && n > 0) ? '' : 'none';
  }

  function updateSelCount() {
    const n = selectedIds.size;
    q('#sel-count').textContent = n;
    q('#rescan-count').textContent = n;
    q('#delete-sel-btn').style.opacity = n ? '1' : '0.5';
    q('#rescan-sel-btn').style.opacity = n ? '1' : '0.5';
  }

  function selectAllVisible() {
    visibleRoutes.forEach(r => selectedIds.add(r.public_id));
    updateSelCount(); renderList();
  }
  function deselectAll() { selectedIds.clear(); updateSelCount(); renderList(); }

  async function deleteDuplicates() {
    const dups = allRoutes.filter(r => r.dup_suspect_of);
    if (!dups.length) { toast('No hay rutas marcadas como posibles duplicadas'); return; }
    // Se seleccionan para que el usuario vea exactamente qué se va a borrar; la
    // confirmación con el recuento la hace deleteSelected().
    selectedIds = new Set(dups.map(r => r.public_id));
    updateSelCount(); renderList();
    await new Promise(r => setTimeout(r, 60));   // deja pintar antes del confirm
    deleteSelected();
  }

  async function deleteSelected() {
    if (!selectedIds.size) return;
    const n = selectedIds.size;
    if (!confirm(`¿Eliminar ${n} ruta${n !== 1 ? 's' : ''}? Esta acción no se puede deshacer.`)) return;
    if (!Store.isOnline()) { toast('Eliminar necesita conexión'); return; }
    const ids = [...selectedIds];
    const total = ids.length;
    let done = 0, errors = 0;
    const loader = document.createElement('div');
    loader.className = 'upload-loader';
    loader.innerHTML = `<div class="upload-loader-title">Eliminando rutas <span class="upload-loader-count" id="del-count">0 / ${total}</span></div>
      <div class="upload-bar-bg"><div class="upload-bar-fill del" id="del-bar"></div></div>
      <div class="upload-filename" id="del-status">Iniciando…</div>`;
    document.body.appendChild(loader);
    const prog = () => {
      const pct = Math.round((done / total) * 100);
      document.getElementById('del-bar').style.width = `${pct}%`;
      document.getElementById('del-count').textContent = `${done} / ${total}`;
      document.getElementById('del-status').textContent = `${pct}% completado`;
    };
    const removeCardNow = id => {
      allRoutes = allRoutes.filter(r => r.public_id !== id);
      const card = q(`.card[data-id="${id}"]`) || q(`.rtable tr[data-id="${id}"]`);
      if (card) {
        card.style.cssText += 'opacity:0;transform:scale(.95) translateY(-4px);transition:opacity .15s,transform .15s';
        setTimeout(() => card.remove(), 160);
      }
    };
    const CONCURRENCY = 4;
    let idx = 0;
    const worker = async () => {
      while (idx < ids.length) {
        const id = ids[idx++];
        try {
          const res = await fetch(`/api/routes/${id}`, {method: 'DELETE'});
          if (!res.ok) errors++; else removeCardNow(id);
        } catch (e) { errors++; }
        done++; prog();
      }
    };
    await Promise.all(Array.from({length: Math.min(CONCURRENCY, total)}, worker));
    document.getElementById('del-bar').style.width = '100%';
    document.getElementById('del-status').textContent =
      errors ? `Completado con ${errors} error(es)` : 'Completado';
    selectedIds.clear();
    await Store.syncNow({force: true});
    toggleEdit();
    setTimeout(() => loader.remove(), 1800);
    toast(errors ? `${done - errors} eliminada(s), ${errors} error(es)`
                 : `${total} ruta${total !== 1 ? 's' : ''} eliminada${total !== 1 ? 's' : ''}`);
  }

  async function rescanSelected() {
    if (!selectedIds.size) return;
    if (!Store.isOnline()) { toast('Re-escanear necesita conexión'); return; }
    const ids = [...selectedIds];
    const total = ids.length;
    let ok = 0;
    const errors = [];
    const loader = document.createElement('div');
    loader.className = 'upload-loader';
    loader.innerHTML = `<div class="upload-loader-title">Re-escaneando rutas <span class="upload-loader-count" id="rs-count">0 / ${total}</span></div>
      <div class="upload-bar-bg"><div class="upload-bar-fill" id="rs-bar"></div></div>
      <div class="upload-filename" id="rs-name">Iniciando…</div>`;
    document.body.appendChild(loader);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const route = allRoutes.find(r => r.public_id === id);
      document.getElementById('rs-count').textContent = `${i + 1} / ${total}`;
      document.getElementById('rs-bar').style.width = `${Math.round((i / total) * 100)}%`;
      document.getElementById('rs-name').textContent = route ? route.name : String(id);
      try {
        const res = await fetch(`/api/routes/${id}/rescan`, {method: 'POST'});
        if (res.ok) ok++;
        else {
          const j = await res.json().catch(() => ({}));
          errors.push(`${route ? route.name : id}: ${j.error || 'Error'}`);
        }
      } catch (e) { errors.push(`${route ? route.name : id}: Error de red`); }
    }
    document.getElementById('rs-bar').style.width = '100%';
    document.getElementById('rs-count').textContent = `${ok} / ${total}`;
    document.getElementById('rs-name').textContent =
      errors.length ? `${errors.length} error(es)` : 'Completado';
    selectedIds.clear();
    // El servidor cambió las rutas: la copia local se pone al día por el delta.
    await Store.syncNow({force: true});
    await reload();
    toggleEdit();
    setTimeout(() => loader.remove(), 1800);
    toast(errors.length ? errors[0]
                        : `${ok} ruta${ok !== 1 ? 's' : ''} re-escaneada${ok !== 1 ? 's' : ''}`);
  }

  /* ── subida de archivos ────────────────────────────────────────────────── */
  async function uploadFiles(files) {
    if (!files.length) return;
    if (!Store.isOnline()) { toast('Subir rutas necesita conexión'); return; }
    const total = files.length;
    let ok = 0;
    const dups = [], errors = [], softs = [];
    const loader = document.createElement('div');
    loader.className = 'upload-loader';
    loader.innerHTML = `<div class="upload-loader-title">Subiendo rutas <span class="upload-loader-count" id="up-count">0 / ${total}</span></div>
      <div class="upload-bar-bg"><div class="upload-bar-fill" id="up-bar"></div></div>
      <div class="upload-filename" id="up-name"></div>`;
    document.body.appendChild(loader);
    for (let i = 0; i < total; i++) {
      const f = files[i];
      document.getElementById('up-count').textContent = `${i + 1} / ${total}`;
      document.getElementById('up-bar').style.width = `${Math.round((i / total) * 100)}%`;
      document.getElementById('up-name').textContent = f.name;
      const fd = new FormData();
      fd.append('gpx', f);
      try {
        const res = await fetch('/api/routes', {method: 'POST', body: fd});
        if (res.ok) ok++;
        else {
          const j = await res.json().catch(() => ({}));
          if (j.soft_duplicate) softs.push({file: f, name: f.name, existing: j.existing_name});
          else if (j.duplicate) dups.push(f.name);
          else errors.push(`${f.name}: ${j.error || 'Error'}`);
        }
      } catch (e) { errors.push(`${f.name}: Error de red`); }
    }
    // Duplicados blandos (misma firma, bytes distintos): la subida manual
    // pregunta; si el usuario acepta, se reimportan con ?force=1 (entran limpias).
    if (softs.length) {
      const lista = softs.map(s => `• «${s.name}» se parece a «${s.existing || 'otra ruta'}»`).join('\n');
      if (confirm(`${softs.length} ruta${softs.length !== 1 ? 's' : ''} ya podría${softs.length !== 1 ? 'n' : ''} estar importada${softs.length !== 1 ? 's' : ''}:\n\n${lista}\n\n¿Importar de todos modos?`)) {
        for (const s of softs) {
          document.getElementById('up-name').textContent = s.name;
          const fd = new FormData();
          fd.append('gpx', s.file);
          try {
            const res = await fetch('/api/routes?force=1', {method: 'POST', body: fd});
            if (res.ok) ok++;
            else errors.push(`${s.name}: ${(await res.json().catch(() => ({}))).error || 'Error'}`);
          } catch (e) { errors.push(`${s.name}: Error de red`); }
        }
      } else {
        softs.forEach(s => dups.push(s.name));
      }
    }
    document.getElementById('up-bar').style.width = '100%';
    document.getElementById('up-count').textContent = `${ok} / ${total}`;
    const partes = [];
    if (ok) partes.push(`${ok} subida${ok !== 1 ? 's' : ''}`);
    if (dups.length) partes.push(`${dups.length} duplicada${dups.length !== 1 ? 's' : ''}`);
    if (errors.length) partes.push(`${errors.length} error${errors.length !== 1 ? 'es' : ''}`);
    document.getElementById('up-name').textContent = partes.join(' · ') || 'Completado';
    await Store.syncNow({force: true});
    await reload();
    setTimeout(() => loader.remove(), 2600);
    if (errors.length) {
      toast(errors[0]);
    } else if (dups.length && !ok) {
      toast(dups.length === 1 ? '1 ruta repetida, no se importó'
                              : `${dups.length} rutas repetidas, no se importaron`);
    } else if (dups.length) {
      toast(`${ok} ruta${ok !== 1 ? 's' : ''} añadida${ok !== 1 ? 's' : ''}`
        + (dups.length === 1 ? ' · 1 repetida descartada' : ` · ${dups.length} repetidas descartadas`));
    } else {
      toast(`${ok} ruta${ok !== 1 ? 's' : ''} añadida${ok !== 1 ? 's' : ''}`);
    }
  }

  /* ── mapa de visión general ────────────────────────────────────────────── */
  function routesGeoJSON(rows) {
    return {type: 'FeatureCollection', features: rows.map(r => ({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [r.start_lon, r.start_lat]},
      properties: {id: r.public_id, name: r.name,
                   color: (activityOf(r.activity_type) || {}).color || '#d24a3a',
                   activity: r.activity_type || 'otros',
                   dist: r.distance_m ? (r.distance_m / 1000).toFixed(1) + ' km' : ''},
    }))};
  }

  /* El endpoint /api/routes/geojson solo filtra por bbox, así que el filtrado por
     actividad/fecha de la lista es 100% cliente: se recalcula qué subconjunto de
     lo ya descargado mostrar, sin volver a pedir red. */
  function applyLineFilter() {
    if (!mapLoaded || !map) return;
    const ids = new Set(mapRoutes.map(r => r.public_id));
    map.getSource('ov-lines').setData({type: 'FeatureCollection',
      features: lineFeaturesAll.filter(f => ids.has(f.properties.id))});
    // Si la caché está vacía (recién invalidada) pero hay rutas que mostrar, se
    // vuelve a pedir la vista actual sin esperar a un moveend.
    if (!lineFeaturesAll.length && mapRoutes.length) loadLinesForView();
  }

  function scheduleLineLoad() {
    clearTimeout(lineTimer);
    lineTimer = setTimeout(loadLinesForView, 350);
  }

  async function loadLinesForView() {
    if (!mapLoaded || lineFetching || !map) return;
    if (map.getZoom() < LINES_PREFETCH_ZOOM) return;      // de lejos, solo bolitas
    const b = map.getBounds();
    const padLon = (b.getEast() - b.getWest()) * 0.5, padLat = (b.getNorth() - b.getSouth()) * 0.5;
    const bbox = [b.getWest() - padLon, b.getSouth() - padLat,
                  b.getEast() + padLon, b.getNorth() + padLat].join(',');
    lineFetching = true;
    try {
      const fc = await (await fetch('/api/routes/geojson?bbox=' + encodeURIComponent(bbox))).json();
      const fresh = fc.features.filter(f => !lineIds.has(f.properties.id));
      if (fresh.length) {
        fresh.forEach(f => lineIds.add(f.properties.id));
        lineFeaturesAll.push(...fresh);
        applyLineFilter();
      }
    } catch (e) {
      /* sin conexión: las bolitas siguen visibles */
    } finally { lineFetching = false; }
  }

  function invalidateLines() {
    lineIds = new Set();
    lineFeaturesAll = [];
    if (mapLoaded && map && map.getSource('ov-lines')) {
      map.getSource('ov-lines').setData({type: 'FeatureCollection', features: []});
    }
  }

  function saveCamera() {
    if (!map) return;
    const c = map.getCenter();
    camera = {lng: c.lng, lat: c.lat, zoom: map.getZoom(),
              bearing: map.getBearing(), pitch: map.getPitch()};
  }

  function syncClusterLabels() {
    if (!map || !map.getLayer('clusters')) return;
    const feats = map.queryRenderedFeatures({layers: ['clusters']});
    const seen = new Set();
    feats.forEach(f => {
      const id = f.properties.cluster_id, n = f.properties.point_count;
      seen.add(id);
      if (!clusterLabels[id]) {
        const el = document.createElement('div');
        el.style.cssText = 'pointer-events:none;color:#101a14;font-weight:800;font-size:14px;line-height:1;text-align:center;text-shadow:0 0 3px rgba(255,255,255,0.95)';
        const mk = new maplibregl.Marker({element: el, anchor: 'center'})
          .setLngLat(f.geometry.coordinates).addTo(map);
        mk.getElement().style.pointerEvents = 'none';
        clusterLabels[id] = mk;
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

  function renderMap(rows) {
    mapRoutes = rows.filter(r => r.start_lat != null && r.start_lon != null);
    if (!map) { initMap(); return; }
    if (!mapLoaded) return;              // el 'load' pintará con mapRoutes
    map.getSource('routes').setData(routesGeoJSON(mapRoutes));
    applyLineFilter();
    // Ni sobre lo que el usuario está explorando, ni sobre su ubicación: mientras
    // se la sigue, un repintado de la lista (filtro, sincronización) le devolvía
    // el mapa a las rutas.
    if (!userMoved && !geoTracking(map)) { clearTimeout(fitTimer); fitTimer = setTimeout(fitMap, 600); }
  }

  function initMap() {
    map = new maplibregl.Map({
      container: 'overview-map',
      style: buildStyle(basemap || (basemap = defaultBasemap('Satélite'))),
      center: [-84, 10], zoom: 8, attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
    // Seguir la ubicación cuenta como explorar: el auto-encuadre pendiente (hay
    // uno programado a 600 ms tras cada repintado) no debe robar la cámara.
    const geo = addGeolocate(map, 'top-right');
    if (geo) geo.on('trackuserlocationstart', () => { userMoved = true; clearTimeout(fitTimer); });
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');
    // selector de capas (top-left)
    map.addControl({
      onAdd() {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:var(--panel,#fff);color:var(--ink,#101a14);border:none;font-size:12px;cursor:pointer;padding:5px 7px;font-family:inherit;width:100%';
        basemapNames().forEach(c => {
          const o = document.createElement('option'); o.value = c; o.textContent = c;
          sel.appendChild(o);
        });
        sel.value = basemap;
        sel.onchange = () => {
          const prev = basemap;
          basemap = sel.value;
          // La capa offline es pmtiles:// (otro tipo de fuente y otro maxzoom):
          // no vale setTiles, hay que reconstruir el estilo, y eso borra
          // clusters, líneas e iconos. Se recrea el mapa conservando el encuadre.
          if (prev === OFFLINE_LAYER || basemap === OFFLINE_LAYER) {
            saveCamera();
            destroyMap();
            initMap();
          } else {
            applyBasemap(map, basemap);
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
        b.innerHTML = '⤢'; b.title = 'Centrar en las rutas';
        b.style.cssText = 'font-size:16px;width:29px;height:29px;cursor:pointer;border:none;background:none;padding:0;display:flex;align-items:center;justify-content:center';
        b.onclick = () => fitMap();
        c.appendChild(b);
        return c;
      }, onRemove() {},
    }, 'top-left');

    const tok = _tok;
    map.on('load', async () => {
      if (tok !== _tok || !map) return;
      // Líneas reales del track (igual que el dashboard): por debajo de los
      // puntos, visibles a partir de LINES_MINZOOM y cargadas por bbox.
      map.addSource('ov-lines', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
      map.addLayer({id: 'ov-lines', type: 'line', source: 'ov-lines', minzoom: LINES_MINZOOM,
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': activityLineColor(), 'line-width': 1.8, 'line-opacity': 0.8}});
      map.addLayer({id: 'ov-lines-hit', type: 'line', source: 'ov-lines', minzoom: LINES_MINZOOM,
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': '#000', 'line-width': 14, 'line-opacity': 0}});

      await _loadActImages(map);
      if (tok !== _tok || !map) return;
      map.addSource('routes', {
        type: 'geojson', data: routesGeoJSON(mapRoutes),
        cluster: true, clusterMaxZoom: 10, clusterRadius: 25,
      });
      map.addLayer({id: 'clusters', type: 'circle', source: 'routes',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#e8c44a', 10, '#d4863a', 50, '#d24a3a'],
          'circle-radius': ['step', ['get', 'point_count'], 18, 10, 24, 50, 32],
          'circle-opacity': 0.5, 'circle-stroke-opacity': 1,
          'circle-stroke-width': 2, 'circle-stroke-color': 'rgba(255,255,255,0.9)',
        }});
      // Los iconos de actividad desaparecen a partir de cierto zoom para dar
      // paso a las líneas reales (igual que en el dashboard).
      map.addLayer({id: 'unclustered', type: 'symbol', source: 'routes',
        maxzoom: POINTS_MAXZOOM, filter: ['!', ['has', 'point_count']],
        layout: {'icon-image': ['concat', 'act-', ['get', 'activity']], 'icon-size': 1,
                 'icon-allow-overlap': true, 'icon-ignore-placement': true}});
      mapLoaded = true;
      map.on('idle', syncClusterLabels);

      const pop = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 12});
      map.on('mouseenter', 'unclustered', e => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        pop.setLngLat(e.features[0].geometry.coordinates)
          .setHTML(`<strong>${esc(p.name)}</strong>${p.dist ? '<br><span style="color:var(--muted);font-size:11px">' + p.dist + '</span>' : ''}`)
          .addTo(map);
      });
      map.on('mouseleave', 'unclustered', () => { map.getCanvas().style.cursor = ''; pop.remove(); });
      map.on('click', 'unclustered', e => openRoute(e.features[0].properties.id));
      map.on('click', 'clusters', async e => {
        const src = map.getSource('routes');
        const cid = e.features[0].properties.cluster_id;
        const coords = e.features[0].geometry.coordinates.slice();
        try {
          const zoom = await src.getClusterExpansionZoom(cid);
          map.easeTo({center: coords, zoom: zoom + 2});
        } catch (_) {
          src.getClusterExpansionZoom(cid, (err, zoom) => {
            if (!err) map.easeTo({center: coords, zoom: zoom + 2});
          });
        }
      });
      ['clusters', 'ov-lines-hit'].forEach(capa => {
        map.on('mouseenter', capa, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', capa, () => { map.getCanvas().style.cursor = ''; });
      });
      map.on('click', 'ov-lines-hit', e => openRoute(e.features[0].properties.id));
      // No re-encuadrar una vez el usuario explora
      map.on('movestart', e => { if (e.originalEvent) userMoved = true; });
      map.on('moveend', scheduleLineLoad);

      // Al volver del detalle de una ruta se restaura el encuadre que había.
      if (camera) {
        map.jumpTo({center: [camera.lng, camera.lat], zoom: camera.zoom,
                    bearing: camera.bearing, pitch: camera.pitch});
        camera = null;
        userMoved = true;               // no re-encuadrar sobre lo restaurado
      } else {
        // Encuadre instantáneo: el centro/zoom del constructor son un
        // placeholder y no tiene sentido animar el vuelo desde ahí.
        fitMap(true);
      }
      // Repinta lo ya descargado: al recrear el mapa la fuente nace vacía y
      // loadLinesForView() no la rellenaría (esas rutas ya están en lineIds).
      applyLineFilter();
      loadLinesForView();
    });
  }

  function destroyMap() {
    clearTimeout(lineTimer);
    clearTimeout(fitTimer);
    clearClusterLabels();
    if (map) { try { map.remove(); } catch (e) {} }
    map = null;
    mapLoaded = false;
    lineFetching = false;
  }

  function fitMap(instant) {
    if (!map || !mapRoutes.length) return;
    const opts = instant ? {duration: 0} : {};
    if (mapRoutes.length === 1) {
      map.easeTo({center: [mapRoutes[0].start_lon, mapRoutes[0].start_lat], zoom: 13, ...opts});
      return;
    }
    let mnLo = Infinity, mxLo = -Infinity, mnLa = Infinity, mxLa = -Infinity;
    mapRoutes.forEach(r => {
      if (r.start_lon < mnLo) mnLo = r.start_lon;
      if (r.start_lon > mxLo) mxLo = r.start_lon;
      if (r.start_lat < mnLa) mnLa = r.start_lat;
      if (r.start_lat > mxLa) mxLa = r.start_lat;
    });
    map.fitBounds([[mnLo, mnLa], [mxLo, mxLa]], {padding: 50, maxZoom: 14, ...opts});
  }

  /* ── carga de datos ────────────────────────────────────────────────────── */
  async function reload() {
    const tok = _tok;
    let rows;
    try {
      rows = await Store.routes();
    } catch (e) {
      toast('No se pudo cargar el listado');
      return;
    }
    if (tok !== _tok) return;
    allRoutes = rows;
    invalidateLines();                   // pueden haber cambiado rutas
    updateDedupBtn();
    updateDupFilter();
    renderList();
  }

  /* ── montaje ───────────────────────────────────────────────────────────── */
  async function mount() {
    const tok = ++_tok;
    if (!activeActs) activeActs = new Set(ACTIVITIES.map(a => a.id));
    const savedF = loadFilterState();
    if (savedF) {
      if (savedF.acts) activeActs = new Set(savedF.acts);
      if (savedF.sort) sortOrder = savedF.sort;
      if (savedF.view) viewMode = savedF.view;
      if (savedF.q) searchQ = savedF.q;
      if (savedF.dup) dupOnly = true;
    }
    const buscador = q('#route-search');
    if (buscador) buscador.value = searchQ;
    // Los DatePicker se crean una sola vez por documento: su constructor añade
    // un listener de `document` y recrearlos en cada visita los acumularía.
    if (!dpFrom) {
      dpFrom = new DatePicker(q('#dp-from'), 'Desde', () => { saveFilterState(); renderList(); });
      dpTo = new DatePicker(q('#dp-to'), 'Hasta', () => { saveFilterState(); renderList(); });
      if (savedF && savedF.from) dpFrom.set(savedF.from);
      if (savedF && savedF.to) dpTo.set(savedF.to);
    }
    q('#sort-desc').classList.toggle('on', sortOrder === 'desc');
    q('#sort-asc').classList.toggle('on', sortOrder === 'asc');
    setView(viewMode);
    buildPills();
    await reload();
    if (tok !== _tok) return;
    if (!_unsub) {
      _unsub = Store.onChange(ev => {
        if (ev.type === 'synced' && ev.changed && visible()) reload();
      });
    }
    if (map) setTimeout(() => { if (map) { map.resize(); fitMap(); } }, 60);
  }

  function unmount() {
    _tok++;
    saveCamera();                        // para restaurarlo al volver
    destroyMap();
    teardownSentinel();
    if (_unsub) { _unsub(); _unsub = null; }
    if (editMode) {
      editMode = false;
      q('#edit-toggle-btn').classList.remove('on');
      q('#edit-bar').classList.remove('on');
      selectedIds.clear();
    }
    q('#drop-global').classList.remove('visible', 'over');
    mapRoutes = [];
    userMoved = false;
  }

  /* Listeners de documento y de la cabecera: una sola vez al cargar el archivo. */
  /* Buscador: filtra en cliente sobre lo que ya está en memoria, con un pequeño
     debounce para no repintar la lista en cada tecla. */
  (() => {
    const inp = q('#route-search');
    if (!inp) return;
    let t = null;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => setSearch(inp.value), 180);
    });
  })();
  const gpxInput = document.getElementById('gpx-input');
  if (gpxInput) {
    gpxInput.addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) await uploadFiles(files);
    });
  }
  const dropGlobal = q('#drop-global');
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!visible() || !e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (++dragDepth === 1) dropGlobal.classList.add('visible');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; dropGlobal.classList.remove('visible', 'over'); }
  });
  window.addEventListener('dragover', e => {
    if (!visible() || !e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dropGlobal.classList.add('over');
  });
  window.addEventListener('drop', async e => {
    if (!visible()) return;
    e.preventDefault();
    dragDepth = 0;
    dropGlobal.classList.remove('visible', 'over');
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]
      .filter(f => /\.(gpx|fit)$/i.test(f.name));
    if (files.length) await uploadFiles(files);
    else if (e.dataTransfer && e.dataTransfer.files.length) toast('Solo se aceptan archivos GPX o FIT');
  });

  window.SEC.rutas = {
    mount, unmount,
    setSort, setView, setSearch, toggleDupOnly, clearFilters, toggleEdit, selectMonth,
    selectAllVisible, deselectAll, deleteDuplicates, deleteSelected, rescanSelected,
  };
})();
