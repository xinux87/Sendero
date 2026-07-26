/* Almacén local y sincronización delta.

   Sustituye al caché de sessionStorage con TTL de 10 min (`sendero_routes_v4`)
   por IndexedDB:
     - persiste al cerrar la pestaña (sessionStorage no) y admite cientos de MB,
     - la frescura no la decide un TTL sino el servidor, vía /api/sync/state:
       mientras el ETag no cambie no se descarga nada, y cuando cambia se
       descarga SOLO la diferencia.

   Regla de oro: ninguna sección llama a fetch() para leer rutas o planes. Todas
   pasan por aquí, y este módulo decide red o local. Así una sección no tiene que
   saber si hay conexión.

   `rev` es un cursor opaco del servidor: no es una fecha, no se muestra en la UI
   y no sirve para ordenar. Solo para saber si lo que tengo guardado sigue valiendo.
*/
const Store = (() => {
  'use strict';

  const DB_NAME = 'sendero';
  // Subir la versión vacía los almacenes cuyo formato cambie (equivalente a
  // cambiar la clave de sessionStorage, regla 11 de CLAUDE.md).
  /* Sube al cambiar los campos que devuelve /api/routes o el detalle
     (regla 11 de CLAUDE.md): onupgradeneeded vacía los almacenes y los clientes
     se rehacen la copia. 2 = el detalle trae `n_points` (rediseño 0.9.0), y un
     detalle ya guardado no lo recibiría nunca: su rev no cambia, así que el
     Store seguiría sirviendo la copia vieja. */
  const DB_VERSION = 2;
  const STORES = {
    meta:     {keyPath: 'k'},
    routes:   {keyPath: 'public_id'},
    detail:   {keyPath: 'public_id'},
    planned:  {keyPath: 'public_id'},
    outbox:   {keyPath: 'id', autoIncrement: true},
  };

  let _db = null;
  let _online = navigator.onLine !== false;
  const _listeners = new Set();

  /* ── infraestructura IndexedDB ─────────────────────────────────────────── */

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [name, opts] of Object.entries(STORES)) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
          db.createObjectStore(name, opts);
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(names, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(names, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
      out = fn(...[].concat(names).map(n => t.objectStore(n)));
    }));
  }

  const get      = (s, k) => tx(s, 'readonly',  st => { const r = st.get(k); return new Promise(res => r.onsuccess = () => res(r.result)); });
  const getAll   = s      => tx(s, 'readonly',  st => { const r = st.getAll(); return new Promise(res => r.onsuccess = () => res(r.result)); });
  const put      = (s, v) => tx(s, 'readwrite', st => { st.put(v); });
  const del      = (s, k) => tx(s, 'readwrite', st => { st.delete(k); });
  const clearAll = ss     => tx(ss, 'readwrite', (...sts) => sts.forEach(st => st.clear()));

  const meta    = k        => get('meta', k).then(r => (r ? r.v : undefined));
  const setMeta = (k, v)   => put('meta', {k, v});

  /* ── estado de conexión ────────────────────────────────────────────────── */

  function onChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
  function emit(ev) { _listeners.forEach(fn => { try { fn(ev); } catch (e) {} }); }
  function isOnline() { return _online; }

  function setOnline(v) {
    if (_online === v) return;
    _online = v;
    emit({type: 'online', online: v});
  }
  window.addEventListener('online',  () => { setOnline(true); flushOutbox(); syncNow(); });
  window.addEventListener('offline', () => setOnline(false));

  /* fetch que distingue "el servidor dice que no" de "no hay servidor".
     Un 4xx/5xx es una respuesta y se propaga; un fallo de red marca offline. */
  async function netFetch(url, opts) {
    try {
      const res = await fetch(url, opts);
      setOnline(true);
      return res;
    } catch (e) {
      setOnline(false);
      throw Object.assign(new Error('sin conexión'), {offline: true, cause: e});
    }
  }

  /* ── sincronización ────────────────────────────────────────────────────── */

  /* ¿Ha cambiado algo? Una sola petición condicional; si el servidor contesta
     304 no se descarga nada más. Devuelve null si no hay cambios. */
  async function checkState() {
    const epoch = await meta('epoch');
    const cursor = (await meta('cursor')) || 0;
    const headers = {};
    if (epoch) headers['If-None-Match'] = `"${epoch}:${cursor}"`;
    const res = await netFetch('/api/sync/state', {headers, cache: 'no-store'});
    if (res.status === 304) return null;
    if (!res.ok) throw new Error('estado de sincronización: ' + res.status);
    return res.json();
  }

  let _syncing = null;

  /* Trae e aplica las diferencias. Idempotente y con reentrada protegida: dos
     llamadas concurrentes comparten la misma promesa. */
  function syncNow(opts) {
    if (_syncing) return _syncing;
    _syncing = _sync(opts || {}).finally(() => { _syncing = null; });
    return _syncing;
  }

  async function _sync({force = false} = {}) {
    let changed = false;
    try {
      if (!force) {
        const state = await checkState();
        if (!state) return {changed: false, upToDate: true};
      }
      emit({type: 'syncing'});
      let guard = 0;
      for (;;) {
        const since = (await meta('cursor')) || 0;
        const epoch = (await meta('epoch')) || '';
        const url = `/api/sync/changes?since=${since}&epoch=${encodeURIComponent(epoch)}`;
        const res = await netFetch(url, {cache: 'no-store'});
        if (!res.ok) throw new Error('cambios: ' + res.status);
        const d = await res.json();

        if (d.reset) {
          // Otra BD, restaurada de un backup, o tombstones purgadas: la copia
          // local no es reconciliable, se tira y se empieza de cero.
          await clearAll(['routes', 'detail', 'planned']);
          await setMeta('cursor', 0);
        }
        await setMeta('epoch', d.epoch);
        changed = changed || await applyChanges(d);
        await setMeta('cursor', d.cursor);
        if (d.complete) break;
        if (++guard > 200) break;        // backfill absurdo: corta y reintenta luego
      }
      await setMeta('synced_at', Date.now());
      emit({type: 'synced', changed});
      return {changed, upToDate: !changed};
    } catch (e) {
      emit({type: 'sync-error', error: e, offline: !!e.offline});
      if (!e.offline) console.warn('[sync]', e);
      return {changed, error: e};
    }
  }

  async function applyChanges(d) {
    let n = 0;
    for (const [key, storeName] of [['routes', 'routes'], ['planned', 'planned']]) {
      const part = d[key];
      if (!part) continue;
      if (part.upserted.length) {
        n += part.upserted.length;
        await tx(storeName, 'readwrite', st => part.upserted.forEach(r => st.put(r)));
      }
      if (part.deleted.length) {
        n += part.deleted.length;
        await tx(storeName, 'readwrite', st => part.deleted.forEach(id => st.delete(id)));
        // El detalle cacheado de algo borrado no debe sobrevivir.
        if (storeName === 'routes') {
          await tx('detail', 'readwrite', st => part.deleted.forEach(id => st.delete(id)));
        }
      }
    }
    return n > 0;
  }

  /* Corrobora la copia local contra el manifiesto del servidor y repara SOLO lo
     que divergía. Es la operación de "comprobar sincronización":
     detecta lo que un delta por cursor no puede ver (una tombstone perdida, un
     delta cortado a medias, un detalle obsoleto). */
  async function verify() {
    const res = await netFetch('/api/sync/manifest', {cache: 'no-store'});
    if (!res.ok) throw new Error('manifiesto: ' + res.status);
    const man = await res.json();
    const report = {};
    for (const [key, storeName] of [['routes', 'routes'], ['planned', 'planned']]) {
      const remote = {};
      (man[key] || []).forEach(([pid, rev]) => { remote[pid] = rev; });
      const local = {};
      (await getAll(storeName)).forEach(r => { local[r.public_id] = r.rev; });
      const diff = diffManifest(local, remote);
      report[key] = diff;
      // Sobrantes: fuera del almacén local.
      if (diff.extra.length) {
        await tx(storeName, 'readwrite', st => diff.extra.forEach(id => st.delete(id)));
        if (storeName === 'routes') {
          await tx('detail', 'readwrite', st => diff.extra.forEach(id => st.delete(id)));
        }
      }
      // Faltantes y divergentes: el cursor local no es de fiar, así que se
      // reconstruye desde cero (el delta ya solo trae metadatos, es barato).
      if (diff.missing.length || diff.stale.length) {
        await setMeta('cursor', 0);
      }
    }
    if (Object.values(report).some(d => d.missing.length || d.stale.length)) {
      await syncNow({force: true});
    }
    await setMeta('epoch', man.epoch);
    emit({type: 'verified', report});
    return report;
  }

  /* Misma lógica que core/sync.py::diff_manifest (allí está el test). */
  function diffManifest(local, remote) {
    const missing = [], stale = [];
    for (const pid in remote) {
      if (!(pid in local)) missing.push(pid);
      else if (local[pid] !== remote[pid]) stale.push(pid);
    }
    const extra = Object.keys(local).filter(pid => !(pid in remote));
    return {missing: missing.sort(), stale: stale.sort(), extra: extra.sort()};
  }

  /* ── lecturas que usan las secciones ──────────────────────────────────── */

  /* Listado de rutas. Devuelve lo local al instante y sincroniza en segundo
     plano; si no hay nada local, espera a la primera sincronización. */
  async function routes({sync = true} = {}) {
    let rows = await getAll('routes');
    if (!rows.length) {
      await syncNow({force: true});
      rows = await getAll('routes');
    } else if (sync) {
      syncNow();                        // sin await: la UI ya puede pintar
    }
    return rows.sort(byDateDesc);
  }

  async function planned({sync = true} = {}) {
    let rows = await getAll('planned');
    if (!rows.length) {
      await syncNow({force: true});
      rows = await getAll('planned');
    } else if (sync) {
      syncNow();
    }
    return rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  function byDateDesc(a, b) {
    return String(b.started_at || b.created_at || '')
      .localeCompare(String(a.started_at || a.created_at || ''));
  }

  const routeRow = pid => get('routes', pid);
  const planRow  = pid => get('planned', pid);

  /* Detalle de una ruta.

     El caso bueno no toca la red: si el `rev` del detalle guardado coincide con
     el del listado (que la sincronización mantiene al día), lo que hay en
     IndexedDB es exactamente lo que serviría el servidor. Cualquier cambio en la
     ruta —incluidas altas y bajas de fotos— sube su rev vía triggers, así que la
     igualdad de rev es garantía suficiente.

     `lite` pide la variante ligera (track decimado y series remuestreadas): ~85%
     menos de bytes, suficiente para mapa, perfil y stats. */
  async function route(pid, {lite = false, bootstrap = null, refresh = false} = {}) {
    if (bootstrap && bootstrap.public_id === pid) {
      // El `lite` se toma del propio bootstrap, no del argumento: el servidor
      // inyecta la variante que le toca (hoy la ligera, ver sendero_page) y si
      // se guardase con la otra etiqueta la siguiente visita lo descartaría.
      await put('detail', {public_id: pid, rev: bootstrap.rev || 0,
                           lite: !!bootstrap.lite, data: bootstrap});
      return bootstrap;
    }
    const [row, cached] = await Promise.all([routeRow(pid), get('detail', pid)]);
    const expected = row && row.rev;
    if (!refresh && cached && cached.data && (!expected || cached.rev === expected) && cached.lite === lite) {
      return cached.data;               // 0 peticiones
    }
    try {
      // `refresh` fuerza traer el detalle de nuevo: lo usan las acciones que
      // cambian la ruta por un camino que el cliente no puede replicar (subir
      // fotos, reescanear, asociar fotos de Immich). Sin él, el rev del listado
      // aún no ha llegado por la sincronización y se serviría la copia vieja.
      const headers = {};
      if (!refresh && cached && cached.rev) {
        headers['If-None-Match'] = `"${cached.rev}${cached.lite ? '-lite' : ''}"`;
      }
      const res = await netFetch(`/api/routes/${encodeURIComponent(pid)}${lite ? '?lite=1' : ''}`,
                                {headers});
      if (res.status === 304 && cached) return cached.data;
      if (res.status === 404) { await del('detail', pid); return null; }
      if (!res.ok) throw new Error('detalle: ' + res.status);
      const data = await res.json();
      await put('detail', {public_id: pid, rev: data.rev || 0, lite: !!lite, data});
      return data;
    } catch (e) {
      if (cached && cached.data) return cached.data;   // offline: lo que haya
      throw e;
    }
  }

  /* Guarda en local un detalle que la sección acaba de modificar (notas, nombre,
     actividad…). Sin esto, un cambio hecho sin conexión se vería revertido al
     volver a la vista: el PATCH está en la cola, pero la copia local del detalle
     seguiría siendo la del servidor. Se conserva el `rev` que ya tenía: cuando el
     servidor confirme el cambio subirá el rev y el detalle se re-descargará. */
  async function putDetail(pid, data, {lite = false} = {}) {
    const cached = await get('detail', pid);
    await put('detail', {public_id: pid, rev: (cached && cached.rev) || data.rev || 0,
                         lite: !!lite, data});
  }

  async function plan(pid, {bootstrap = null} = {}) {
    if (bootstrap && bootstrap.public_id === pid) return bootstrap;
    try {
      const res = await netFetch(`/api/planned/${encodeURIComponent(pid)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('plan: ' + res.status);
      const data = await res.json();
      await put('detail', {public_id: pid, rev: data.rev || 0, lite: false, data});
      return data;
    } catch (e) {
      const cached = await get('detail', pid);
      if (cached && cached.data) return cached.data;
      throw e;
    }
  }

  /* Descarga por adelantado el detalle ligero de todas las rutas, para poder
     abrirlas sin conexión. Con ~48 rutas son unos pocos MB; el modo por defecto
     sigue siendo "a demanda" (ver Ajustes → Offline). */
  async function prefetchAll(onProgress) {
    const rows = await getAll('routes');
    let done = 0, failed = 0;
    for (const r of rows) {
      try { await route(r.public_id, {lite: true}); }
      catch (e) { failed++; if (e.offline) break; }
      if (onProgress) onProgress(++done, rows.length, failed);
    }
    return {done, failed, total: rows.length};
  }

  /* Cuánto ocupa la copia local (aproximado, lo estima el navegador). */
  async function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const est = await navigator.storage.estimate();
    const detail = await getAll('detail');
    return {usage: est.usage, quota: est.quota, cachedDetails: detail.length};
  }

  async function clearLocal() {
    await clearAll(['routes', 'detail', 'planned', 'meta']);
    emit({type: 'cleared'});
  }

  /* ── cola de escrituras ───────────────────────────────────────────────── */

  /* Solo mutaciones pequeñas e idempotentes (PATCH de nombre/notas/actividad).
     Las subidas de GPX/fotos y los guardados del editor NO se encolan: la dedup
     por hash y el 409 por base_version son decisiones del servidor que el cliente
     no puede simular. Esos botones se deshabilitan sin conexión. */
  async function patch(url, body, {label = ''} = {}) {
    const init = {method: 'PATCH', headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify(body)};
    try {
      const res = await netFetch(url, init);
      if (res.ok) { syncNow(); return {ok: true, queued: false}; }
      return {ok: false, queued: false, status: res.status};
    } catch (e) {
      if (!e.offline) throw e;
      await put('outbox', {url, body, label, ts: Date.now()});
      emit({type: 'queued', pending: await pendingCount()});
      return {ok: true, queued: true};
    }
  }

  const pendingCount = () => getAll('outbox').then(r => r.length);

  /* Reenvía la cola. Last-write-wins a propósito: son campos de texto que edita
     una sola persona. Un 404 (la ruta se borró mientras no había conexión) o un
     409 descartan el ítem con aviso, en vez de reintentar para siempre. */
  async function flushOutbox() {
    const items = await getAll('outbox');
    if (!items.length) return {sent: 0, dropped: 0};
    let sent = 0, dropped = 0;
    for (const it of items) {
      try {
        const res = await netFetch(it.url, {
          method: 'PATCH', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(it.body),
        });
        if (res.ok) { await del('outbox', it.id); sent++; }
        else if (res.status === 404 || res.status === 409) { await del('outbox', it.id); dropped++; }
      } catch (e) {
        if (e.offline) break;           // sigue sin conexión: se reintenta luego
      }
    }
    if (sent || dropped) { emit({type: 'flushed', sent, dropped, pending: await pendingCount()}); }
    if (sent) syncNow({force: true});
    return {sent, dropped};
  }

  return {
    open, meta, setMeta, onChange, isOnline,
    syncNow, checkState, verify, diffManifest,
    routes, planned, route, plan, routeRow, planRow, putDetail,
    prefetchAll, usage, clearLocal,
    patch, flushOutbox, pendingCount,
    _get: get, _put: put, _del: del, _getAll: getAll,
  };
})();
