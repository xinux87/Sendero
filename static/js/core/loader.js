/* Carga a demanda de los módulos de sección (roadmap/spa-offline-sync.md §3.3).

   Sin build step y sin módulos ES: se inyecta un <script src> clásico y se espera
   su onload. El motivo de usar scripts clásicos en vez de import() está en §2 —
   hay 121 atributos onclick= en las plantillas y un módulo ES no expone sus
   funciones al ámbito global, así que todos se romperían. Cada sección se envuelve
   en su propio IIFE y publica lo que la plantilla necesita en window.SEC.<sec>.

   loadOnce() memoiza por URL: al volver a una sección ya visitada no se
   re-descarga ni se re-ejecuta el script (el estado vive en su IIFE). */
window.SEC = window.SEC || {};

const _loaded = new Map();          // url → Promise<void>

function loadOnce(url) {
  if (_loaded.has(url)) return _loaded.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = false;                // preserva el orden entre cargas encadenadas
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar ' + url));
    document.head.appendChild(s);
  });
  _loaded.set(url, p);
  return p;
}

/* Carga el CSS de una sección (una sola vez). Los <link> se añaden al final del
   head para que ganen a las reglas de base.html con igual especificidad. */
function loadCssOnce(url) {
  if (_loaded.has(url)) return _loaded.get(url);
  const p = new Promise(resolve => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = url;
    // Resolver también en error: una sección sin CSS debe poder montarse igual.
    l.onload = l.onerror = () => resolve();
    document.head.appendChild(l);
  });
  _loaded.set(url, p);
  return p;
}
