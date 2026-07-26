/* Service Worker de Sendero (roadmap/spa-offline-sync.md §5).

   Se sirve desde `/sw.js` (ver api/pwa.py), NO como archivo estático: la ruta
   Flask le pone delante `self.APP_VERSION = "X.Y.Z"` leyéndolo de
   core/config.py, que es la única fuente de verdad de la versión. Eso hace dos
   cosas imprescindibles:

     1. El nombre de la caché lleva la versión, así que publicar una versión
        nueva invalida el precache. Sin esto quedarían usuarios con el JS viejo
        hablando con la API nueva, que es el fallo más difícil de diagnosticar
        de toda esta fase (§5.3).
     2. El byte a byte del archivo cambia al cambiar la versión, y el navegador
        solo instala un SW nuevo si el archivo difiere.

   Qué se cachea y qué no, y por qué:

   - Los DATOS de rutas y planes NO se cachean aquí. De eso se encarga el Store
     (IndexedDB, §4): la sincronización delta sabe qué está obsoleto y qué no,
     una caché HTTP no. Las peticiones a /api/ pasan de largo; si fallan, el
     Store responde con su copia local.
   - `/tiles/*.pmtiles` tampoco: se pide por rangos (206) y una respuesta
     parcial cacheada rompería el mapa.
   - Las teselas del mapa de fondo SÍ, pero solo las que el usuario descarga a
     mano para una ruta concreta (§6.2, ver static/js/core/tiles.js): viven en
     `sendero-tiles-v1`, que no lleva versión y `activate` no borra.
   - Sí se cachean el documento, el código, las fuentes, y las imágenes que ya
     son inmutables o revalidables (miniaturas y fotos).
*/
const VERSION  = self.APP_VERSION || 'dev';
const PRECACHE = 'sendero-shell-' + VERSION;
const RUNTIME  = 'sendero-doc-' + VERSION;
/* Las imágenes no dependen de la versión de la app: sobreviven a las
   actualizaciones a propósito (son cientos de fotos y miniaturas). */
const MEDIA    = 'sendero-media-v1';
/* Teselas del mapa descargadas por ruta (static/js/core/tiles.js). Tampoco
   dependen de la versión: son datos que el usuario pidió a mano, no código, y
   borrarlos al publicar sería tirar el mapa que se llevó al monte. */
const TILES    = 'sendero-tiles-v1';
const KEEP     = [PRECACHE, RUNTIME, MEDIA, TILES];

/* El shell sin datos: es lo que se sirve al navegar sin conexión a una vista que
   la SPA aloja. El router lee location.pathname y monta la sección, y los datos
   los pone el Store. Por eso no hace falta cachear una copia por ruta. */
const SHELL = '/app-shell';

const PRECACHE_URLS = [
  SHELL,
  '/manifest.webmanifest',
  '/static/shared.js',
  '/static/icon.svg',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/icon-maskable-512.png',
  '/static/js/core/chrome.js',
  '/static/js/core/loader.js',
  '/static/js/core/store.js',
  '/static/js/core/tiles.js',
  '/static/js/core/router.js',
  '/static/js/sec/dashboard.js',
  '/static/js/sec/rutas.js',
  '/static/js/sec/planes.js',
  '/static/js/sec/plan.js',
  '/static/js/sec/detalle.js',
  '/static/js/sec/editor.js',
  '/static/css/dashboard.css',
  '/static/css/rutas.css',
  '/static/css/planes.css',
  '/static/css/plan.css',
  '/static/css/detalle.css',
  '/static/css/editor.css',
  '/static/vendor/maplibre-gl-4.7.1.js',
  '/static/vendor/maplibre-gl-4.7.1.css',
  '/static/vendor/chart-4.4.1.umd.min.js',
  '/static/vendor/pmtiles-3.0.6.js',
  '/static/fonts/fonts.css',
  // Solo los subconjuntos "latin": son los que usa el español. Los "-ext" se
  // cachean solos la primera vez que el navegador los pide.
  '/static/fonts/inter-400-latin.woff2',
  '/static/fonts/inter-500-latin.woff2',
  '/static/fonts/inter-600-latin.woff2',
  '/static/fonts/saira-condensed-500-latin.woff2',
  '/static/fonts/saira-condensed-600-latin.woff2',
  '/static/fonts/saira-condensed-700-latin.woff2',
  '/static/fonts/space-mono-400-latin.woff2',
  '/static/fonts/space-mono-700-latin.woff2',
];

/* Vistas que aloja el shell: TODAS. Al navegar a cualquiera de ellas sin
   conexión se sirve SHELL y el router monta la sección; los datos los pone el
   Store. El editor está incluido aunque no funcione sin conexión: así al menos
   se abre y explica por qué no puede trabajar, en vez de dar una página de error. */
const SHELL_PATHS = [
  /^\/dashboard\/?$/,
  /^\/rutas\/?$/,
  /^\/planificacion\/?$/,
  /^\/Sendero\/[^/]+\/editor\/?$/,
  /^\/Sendero\/[^/]+\/?$/,
  /^\/Plan\/[^/]+\/?$/,
];
const hostedByShell = path => SHELL_PATHS.some(re => re.test(path));

const OFFLINE_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sin conexión – Sendero</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#101a14;color:#e8efe6;font-family:system-ui,sans-serif;text-align:center;padding:24px}
h1{font-size:22px;margin:0 0 8px}p{color:#8aa394;margin:0 0 18px;line-height:1.5}
a{display:inline-block;color:#e8c44a;text-decoration:none;border:1px solid #2c4435;
border-radius:8px;padding:9px 16px}</style></head><body><div>
<h1>Sin conexión</h1>
<p>Esta pantalla no está guardada en este dispositivo.<br>
Las rutas que ya has abierto sí se pueden consultar.</p>
<a href="/rutas">Ir a Mis rutas</a></div></body></html>`;

const offlineResponse = () => new Response(OFFLINE_HTML, {
  status: 200, headers: {'Content-Type': 'text/html; charset=utf-8'},
});

/* ── instalación / activación ─────────────────────────────────────────────── */

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // Uno a uno y tolerando fallos: con cache.addAll(), un solo 404 (un vendor
    // renombrado, por ejemplo) aborta la instalación entera y la app se queda
    // sin Service Worker sin decir por qué.
    await Promise.all(PRECACHE_URLS.map(url =>
      cache.add(new Request(url, {cache: 'reload'}))
        .catch(err => console.warn('[sw] no se pudo precachear', url, err))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Fuera las cachés de versiones anteriores (§5.3).
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith('sendero-') && !KEEP.includes(n))
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

/* ── estrategias ──────────────────────────────────────────────────────────── */

/* Documentos: red primero (el servidor manda cuando está), copia local si no.
   No al revés: servir el documento cacheado primero dejaría al usuario con el
   HTML de la versión anterior aunque el servidor esté delante. */
async function handleDocument(req) {
  const url = new URL(req.url);
  const hosted = hostedByShell(url.pathname);
  try {
    const res = await fetch(req);
    // Los documentos de las vistas que aloja el shell NO se cachean, y es
    // deliberado: /Sendero/<id> lleva la ruta dentro como `bootstrap_json`, así
    // que su HTML es una copia de los DATOS. Guardarlo significaría que al
    // recargar sin conexión ese bootstrap viejo pisaría en IndexedDB una
    // edición hecha sin conexión (Store.route confía en el bootstrap). Para
    // esas vistas ya está precacheado el shell sin datos, que es lo correcto:
    // los datos los pone el Store.
    if (res && res.ok && !url.search && !hosted) {
      const cache = await caches.open(RUNTIME);
      cache.put(url.pathname, res.clone());
    }
    return res;
  } catch (e) {
    if (hosted) {
      const shell = await caches.match(SHELL);
      if (shell) return shell;
    }
    const cached = await caches.match(url.pathname, {ignoreSearch: true});
    if (cached) return cached;
    return offlineResponse();
  }
}

/* Caché primero, sin revalidar: solo para lo que lleva la versión en el nombre
   (`maplibre-gl-4.7.1.js`) o no cambia nunca (fuentes, iconos). */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req, {ignoreVary: true});
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    const cache = await caches.open(cacheName);
    cache.put(req, res.clone());
  }
  return res;
}

/* Copia local al instante + revalidación por detrás. Se usa para dos cosas:

   - Las miniaturas de track, que se regeneran con el MISMO nombre al reescanear
     o editar (y ya llevan ETag/304, así que revalidar es casi gratis).
   - Nuestro propio código: `static/js/**`, `static/css/**` y `shared.js` NO
     llevan la versión en el nombre, a diferencia de `static/vendor/**`. Con
     caché primero, editar `detalle.js` y no subir `APP_VERSION` dejaría al
     navegador con el archivo viejo para siempre — justo el fallo que la
     checklist de publicar versión intenta evitar. Con esto, un cambio llega en
     la siguiente carga aunque nadie toque la versión, y sin conexión se sigue
     sirviendo la copia guardada. */
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, {ignoreVary: true});
  const network = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { network.catch(() => {}); return cached; }
  const res = await network;
  return res || new Response('', {status: 504, statusText: 'sin conexión'});
}

/* /{z}/{x}/{y} con o sin extensión: sirve para las 4 capas base y para el DEM. */
const ES_TESELA = /\/\d{1,2}\/\d{1,7}\/\d{1,7}(\.\w+)?$/;

/* Red primero y caché de teselas como respaldo. Al revés no: con conexión se
   prefiere la tesela real (la descargada puede ser de hace meses), y sin
   conexión la guardada es lo único que hay. */
async function tileFirstNetwork(req) {
  try {
    return await fetch(req);
  } catch (e) {
    const c = await caches.open(TILES);
    const hit = await c.match(req.url);
    if (hit) return hit;
    // Sin tesela: un 504 vacío. MapLibre lo trata como hueco y sigue pintando
    // el resto del mapa (el track incluido), que es lo que importa.
    return new Response('', {status: 504, statusText: 'tesela no descargada'});
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Petición por rangos (PMTiles): tiene que llegar intacta a la red. Una
  // respuesta 206 no se puede cachear y devolver una completa rompe el lector.
  if (req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Teselas de otro host: si son de una ruta que el usuario descargó para
    // usar sin conexión, se sirven de su caché. Solo se mira la caché para URLs
    // con forma /{z}/{x}/{y}, para no meter un caches.match() en CADA petición
    // externa. Con red, la red gana: así una tesela vieja no se queda pegada.
    if (ES_TESELA.test(url.pathname)) { e.respondWith(tileFirstNetwork(req)); }
    return;                                             // resto: red y nada más
  }

  if (req.mode === 'navigate') { e.respondWith(handleDocument(req)); return; }

  // Nuestro código: nombre sin versión ⇒ revalidar por detrás (ver arriba).
  if (/^\/static\/(js|css)\//.test(url.pathname) || url.pathname === '/static/shared.js') {
    e.respondWith(staleWhileRevalidate(req, PRECACHE));
    return;
  }
  // Vendor (nombre con versión), fuentes, iconos y manifiesto: caché primero.
  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(cacheFirst(req, PRECACHE));
    return;
  }
  if (/^\/api\/routes\/[^/]+\/thumb$/.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req, MEDIA));
    return;
  }
  if (/^\/api\/photos\/[^/]+\/file$/.test(url.pathname)) {
    e.respondWith(cacheFirst(req, MEDIA));
    return;
  }
  // Resto de /api/, /tiles/ y el proxy de Immich: red y nada más. Los datos los
  // guarda el Store, que sabe cuándo su copia sigue siendo válida.
});
