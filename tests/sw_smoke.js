/* Prueba de humo del Service Worker.  Ejecutar:  node tests/sw_smoke.js
   (solo necesita Node; sin npm, sin dependencias y sin paso de build — regla 1.
   pytest ignora los .js, así que no interfiere con `python -m pytest`.)

   Ejecuta static/sw.js en Node con un entorno de Service Worker simulado
   (caches, fetch, clients) y comprueba install/activate y el enrutado de
   estrategias del handler fetch. No sustituye a una prueba en navegador, pero
   pilla los errores de lógica, que es lo que un `node --check` no ve. */
const fs = require('fs');
const assert = require('assert');

let NETWORK_UP = true;
const netLog = [];

class Res {
  constructor(body, init = {}) {
    this.body = body; this.status = init.status ?? 200;
    this.headers = new Map(Object.entries(init.headers || {}));
    this.ok = this.status >= 200 && this.status < 300;
    this._from = init._from || 'network';
  }
  clone() { const r = new Res(this.body, {status: this.status, _from: this._from}); return r; }
}
class Req {
  constructor(url, init = {}) {
    this.url = url.startsWith('http') ? url : 'https://sendero.local' + url;
    this.method = init.method || 'GET';
    this.mode = init.mode || 'no-cors';
    this._h = new Map(Object.entries(init.headers || {}));
    this.headers = {has: k => this._h.has(k), get: k => this._h.get(k)};
  }
}
class Cache {
  constructor() { this.m = new Map(); }
  key(r) { return typeof r === 'string' ? new URL(r, 'https://sendero.local').pathname : new URL(r.url).pathname; }
  async put(r, res) { this.m.set(this.key(r), res); }
  async match(r) { return this.m.get(this.key(r)); }
  async add(r) {
    const res = await fetch(r);
    if (!res.ok) throw new Error('add: ' + res.status);
    return this.put(r, res);
  }
}
const CACHES = new Map();
global.caches = {
  async open(n) { if (!CACHES.has(n)) CACHES.set(n, new Cache()); return CACHES.get(n); },
  async keys() { return [...CACHES.keys()]; },
  async delete(n) { return CACHES.delete(n); },
  async match(r) { for (const c of CACHES.values()) { const v = await c.match(r); if (v) return v; } },
};
global.fetch = async r => {
  const url = typeof r === 'string' ? r : r.url;
  netLog.push(url);
  if (!NETWORK_UP) throw new TypeError('Failed to fetch');
  return new Res('cuerpo de ' + url, {status: 200});
};
global.Request = Req;
global.Response = Res;
global.URL = URL;

const handlers = {};
let claimed = false, skipped = false;
global.self = {
  location: new URL('https://sendero.local/sw.js'),
  addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
  skipWaiting: async () => { skipped = true; },
  clients: {claim: async () => { claimed = true; }},
  APP_VERSION: '0.6.0',
};
global.console.warn = () => {};      // silencia los avisos de precache

eval(fs.readFileSync('static/sw.js', 'utf8'));

const waits = [];
const ev = extra => ({waitUntil: p => waits.push(p), ...extra});
const fire = async (type, e) => { for (const fn of handlers[type] || []) fn(e); await Promise.all(waits.splice(0)); };

(async () => {
  /* ── install: precachea todo ─────────────────────────────────────────── */
  await fire('install', ev({}));
  const shellCache = CACHES.get('sendero-shell-0.6.0');
  assert.ok(shellCache, 'la caché de precache lleva la versión');
  assert.ok(shellCache.m.has('/app-shell'), 'el shell está precacheado');
  assert.ok(shellCache.m.has('/static/js/sec/detalle.js'), 'el módulo detalle está precacheado');
  assert.ok(skipped, 'install hace skipWaiting');
  console.log(`OK install: ${shellCache.m.size} entradas precacheadas`);

  /* ── un 404 en el precache no debe abortar la instalación ────────────── */
  CACHES.clear();
  const realFetch = global.fetch;
  global.fetch = async r => {
    const url = typeof r === 'string' ? r : r.url;
    if (url.includes('chart-')) return new Res('', {status: 404});
    return realFetch(r);
  };
  await fire('install', ev({}));
  const c2 = CACHES.get('sendero-shell-0.6.0');
  assert.ok(c2.m.size > 20 && !c2.m.has('/static/vendor/chart-4.4.1.umd.min.js'),
            'un 404 se salta, el resto se precachea');
  console.log('OK install tolerante a un 404 (' + c2.m.size + ' entradas)');
  global.fetch = realFetch;

  /* ── activate: borra las cachés de versiones anteriores ──────────────── */
  CACHES.set('sendero-shell-0.5.2', new Cache());
  CACHES.set('sendero-doc-0.5.2', new Cache());
  CACHES.set('sendero-media-v1', new Cache());
  CACHES.set('otra-cosa', new Cache());
  await fire('activate', ev({}));
  const left = [...CACHES.keys()].sort();
  assert.ok(!left.includes('sendero-shell-0.5.2'), 'borra el precache viejo');
  assert.ok(!left.includes('sendero-doc-0.5.2'), 'borra los documentos viejos');
  assert.ok(left.includes('sendero-media-v1'), 'conserva las imágenes entre versiones');
  assert.ok(left.includes('otra-cosa'), 'no toca cachés ajenas');
  assert.ok(claimed, 'activate hace clients.claim');
  console.log('OK activate: quedan', left.join(', '));

  /* ── enrutado del handler fetch ──────────────────────────────────────── */
  async function route(url, init) {
    let promise = null;
    const e = {request: new Req(url, init), respondWith: p => { promise = p; }};
    for (const fn of handlers['fetch'] || []) fn(e);
    return promise ? {handled: true, res: await promise} : {handled: false};
  }

  assert.equal((await route('/api/routes')).handled, false, '/api/routes no se intercepta');
  assert.equal((await route('/api/sync/state')).handled, false, '/api/sync/* no se intercepta');
  assert.equal((await route('/tiles/basemap.pmtiles')).handled, false, '/tiles no se intercepta');
  assert.equal((await route('/api/immich/thumb/abc')).handled, false, 'el proxy Immich no se intercepta');
  assert.equal((await route('/static/js/core/store.js', {headers: {range: 'bytes=0-99'}})).handled,
               false, 'una petición por rangos pasa intacta');
  assert.equal((await route('/api/routes/abc/thumb', {method: 'POST'})).handled, false, 'solo GET');
  assert.equal((await route('https://s3.amazonaws.com/x.png')).handled, false, 'otro origen no se toca');
  assert.equal((await route('/static/css/detalle.css')).handled, true, 'los estáticos sí');
  assert.equal((await route('/api/routes/abc/thumb')).handled, true, 'las miniaturas sí');
  assert.equal((await route('/api/photos/abc/file')).handled, true, 'las fotos sí');
  console.log('OK enrutado de estrategias');

  /* ── vendor (nombre con versión): caché primero, sin red ─────────────── */
  netLog.length = 0;
  const r1 = await route('/static/vendor/maplibre-gl-4.7.1.js');
  assert.equal(netLog.length, 0, 'el vendor precacheado no toca la red');
  assert.ok(r1.res.body.includes('maplibre-gl-4.7.1.js'));
  console.log('OK vendor desde caché (0 peticiones)');

  /* ── nuestro código (nombre SIN versión): copia local + revalidación ─── */
  netLog.length = 0;
  const r2 = await route('/static/js/sec/detalle.js');
  assert.ok(r2.res.body.includes('detalle.js'), 'se pinta la copia local al instante');
  await new Promise(r => setImmediate(r));
  assert.equal(netLog.length, 1,
    'y se revalida por detrás: editar detalle.js sin subir APP_VERSION debe llegar');
  netLog.length = 0;
  await route('/static/css/detalle.css');
  await new Promise(r => setImmediate(r));
  assert.equal(netLog.length, 1, 'lo mismo con el CSS de las secciones');
  console.log('OK código propio: caché + revalidación por detrás');

  /* ── documentos: red primero, y se guarda la copia ───────────────────── */
  netLog.length = 0;
  const nav = {mode: 'navigate'};
  await route('/Sendero/A0h5J7Ia8cg', nav);
  assert.equal(netLog.length, 1, 'con red, el documento se pide al servidor');
  const docs = CACHES.get('sendero-doc-0.6.0');
  assert.ok(!docs || !docs.m.has('/Sendero/A0h5J7Ia8cg'),
            'un documento del shell NO se cachea: su HTML lleva los datos dentro');
  netLog.length = 0;
  // Ninguna vista guarda su documento: las 6 las aloja el shell, y su HTML puede
  // llevar datos dentro (bootstrap_json). Lo que se cachea es /app-shell.
  await route('/rutas', nav);
  await route('/Sendero/A0h5J7Ia8cg/editor', nav);
  const docs2 = CACHES.get('sendero-doc-0.6.0');
  assert.ok(!docs2 || docs2.m.size === 0,
            'no se cachea ningún documento de vista: todas las aloja el shell');
  // Una URL que no es una vista sí cae a la caché de documentos (red primero).
  await route('/algo-que-no-es-una-vista', nav);
  assert.ok(CACHES.get('sendero-doc-0.6.0').m.has('/algo-que-no-es-una-vista'),
            'una URL que no es vista guarda su documento como respaldo');
  console.log('OK documento con red (network-first; solo cachea lo que no lleva datos)');

  /* ── sin conexión ────────────────────────────────────────────────────── */
  NETWORK_UP = false;
  const d2 = await route('/Sendero/A0h5J7Ia8cg', nav);
  assert.ok(d2.res.body.includes('app-shell'),
            'sin red, una vista del shell se sirve desde el shell sin datos');
  console.log('OK sin conexión: ruta ya visitada → shell + Store');

  const d3 = await route('/Sendero/NUNCAVISITADA', nav);
  assert.ok(d3.res.body.includes('app-shell'), 'lo mismo con una ruta nunca visitada');
  console.log('OK sin conexión: ruta nueva → shell precacheado');

  for (const url of ['/rutas', '/dashboard', '/planificacion', '/Plan/xyz',
                     '/Sendero/abc/editor']) {
    const d = await route(url, nav);
    assert.ok(d.res.body.includes('app-shell'), `${url} sin red → shell sin datos`);
  }
  console.log('OK sin conexión: las 6 vistas se sirven desde /app-shell');

  const d6 = await route('/otra-cosa-cualquiera', nav);
  assert.ok(d6.res.body.includes('Sin conexión'),
            'una URL que no es vista y no está cacheada → página de aviso');
  console.log('OK sin conexión: URL desconocida → aviso');

  // 'abc' ya se cacheó en la comprobación de enrutado (con red): sirve para ver
  // que una miniatura ya vista se sigue pintando sin conexión.
  const t0 = await route('/api/routes/abc/thumb');
  assert.ok(t0.res.status === 200 && t0.res.body.includes('abc/thumb'),
            'una miniatura ya vista se sirve sin red');
  const t1 = await route('/api/routes/SINCACHEAR/thumb');
  assert.ok(t1.res.status === 504, 'una miniatura nunca vista devuelve 504, no explota');
  console.log('OK sin conexión: miniatura cacheada se pinta; la nueva da 504 controlado');

  console.log('\nTODO OK');
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
