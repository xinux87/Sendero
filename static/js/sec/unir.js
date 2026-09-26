/* Sección `unir`: unir DOS O MÁS tracks (hasta MAX_INPUTS) en uno nuevo, a
   pantalla completa.
   Markup en templates/sec/unir.html, CSS en static/css/unir.css.

   Hasta la v0.10.0 esto era una herramienta DENTRO del editor («⛓ Unir con
   otra…»): un <select> y un bloque de ajuste apretados en la columna de 330 px,
   compartiendo mapa con la edición de puntos. La lógica es la misma —toda la
   decisión la toma el servidor y aquí solo se pinta su informe—, lo que cambia
   es que ahora tiene la pantalla entera: mapa a la izquierda y los pasos a la
   derecha (propuestas · ajustes · resultado). Elegir CON QUÉ unir no gasta un
   panel: es el popup #un-pick-modal (openPick/closePick) y el chip
   #un-pick-chip de la cabecera. El popup es de SELECCIÓN MÚLTIPLE: la entrada
   0 (A) es siempre la que se está uniendo, y las elegidas son B, C, D… en el
   orden en que se marcaron (`sels`). Ese orden solo da las letras: el del
   recorrido lo decide el servidor mirando la geometría.

   Sirve para DOS entidades, como el editor: una RUTA (/Sendero/<pid>/unir) y un
   PLAN (/Plan/<pid>/unir). El router pasa `params.kind` ('route' | 'plan') y
   todo lo que difiere —URLs de la API, de dónde sale la lista de candidatos, a
   dónde vuelve «← Volver» y los textos con género— vive en el objeto `K`. En
   este archivo NO se escribe «/api/routes» ni «/Sendero/» a mano.

   Cómo funciona la unión (lo decide el servidor, ver core/editing.py::smart_merge):
   se manda POST K.mergeApi con {ids, name, preview?, options?}; con
   `preview:true` no se crea nada y vuelve el informe + las métricas del
   resultado. Cuando un extremo de una entrada cae sobre un punto INTERIOR de la
   otra, el servidor la parte por esa junta y enumera los ensamblajes posibles en
   `report.proposals[]` (≤5, la 0 es la mejor).

   Tres cosas que no son opcionales si tocas esto:
   - `report.reversed`/`order`/`trimmed_m`/`tracks` van por PIEZA ensamblada, no
     por entrada: con una junta interior `order` puede repetir un índice o
     dejarse uno fuera. Lo que va POR ENTRADA es el `reversed_inputs` de cada
     propuesta — de ahí salen los toggles «Invertir X» (revFromReport), y un
     `null` ahí significa «esa entrada se usa por trozos»: el toggle se muestra
     «parcial» y deshabilitado.
   - Forzar la orientación (`reverse`) hace que el servidor NO enumere nada: hay
     una sola propuesta y `proposal` debe ser 0. Por eso al pulsar «Invertir X»
     las tarjetas desaparecen y sale «↩ Volver a las propuestas».
   - Cada cambio relanza la previsualización con debounce y TOKEN: sin el token,
     una respuesta lenta de la opción anterior pinta encima de la nueva y el mapa
     deja de describir lo que dicen los controles.
   - El perfil de elevación del RESULTADO (debajo del mapa) sale de `elevation`
     de la previsualización y comparte hover con el mapa en las dos direcciones.
     Las dos trampas de Chart.js valen aquí igual que en los dos detalles: el
     cerrojo `_syncing` (update() reenvía el último mousemove) y descartar el
     `mouseout` dentro de `onHover` (llega DESPUÉS del onmouseleave del canvas).
     El degradado por pendiente entra como VALOR desde `slopeGradientPlugin`,
     nunca como opción scriptable: eso se resuelve una vez por punto y el hover
     repinta en cada movimiento del ratón.
   - `options.start`/`options.end` fuerzan por dónde empieza y acaba el
     recorrido unido: '' = automático, o '<i><e>' (i = entrada, e = s|e). El
     servidor contesta si pudo cumplirlo en `report.endpoints_applied`.

   Contrato: mount(params, opts) / unmount(). params.id = public_id,
   params.kind = 'route' (por defecto) | 'plan'. */
(() => {
  'use strict';

  let _tok = 0;
  const q = sel => document.querySelector('#sec-unir ' + sel);

  /* ── ruta o plan: lo único que cambia ───────────────────────────────────── */
  const KINDS = {
    route: {
      mergeApi: '/api/routes/merge',
      detailUrl: pid => '/Sendero/' + encodeURIComponent(pid),
      listUrl: '/rutas',
      list: () => Store.routes(),
      load: pid => Store.route(pid, {lite: true}),
      titulo: 'Unir ruta',
      unirCon: 'Con qué rutas unir',
      okN: n => n ? `Unir con ${n} ruta${n === 1 ? '' : 's'}` : 'Elige al menos una',
      buscarPh: 'Buscar por nombre o localidad…',
      sinOtras: 'No hay otras rutas con las que unir.',
      elige: 'Elige con qué rutas unir.',
      crear: 'Crear ruta unida',
      nombrePh: 'Nombre de la ruta unida',
      creando: 'Creando la ruta…',
      creada: 'Creada',
      noEncontrada: 'Ruta no encontrada.',
      noCargada: 'No se pudo cargar esta ruta.',
      estaEl: 'esta ruta',            // leyenda A de la previsualización
      laOtra: 'la otra ruta',         // …y leyenda B (solo si son dos)
      invertidaN: 'invertida',        // resumen del informe: «B invertida»
      invertidasN: 'invertidas',
      entera: 'entera',               // pieza que usa la entrada completa
      parcialTip: 'La propuesta elegida usa esta ruta por trozos: ' +
                  'invertirla entera no significa nada.',
      offline: 'Unir necesita conexión: la unión la calcula el servidor. ' +
               'Puedes mirar la ruta, pero no previsualizar ni crear nada.',
      perfilVacio: 'Elige con qué rutas unir para ver el perfil del resultado.',
      // modo «Montaje»
      eligeMontaje: 'Elige con qué rutas unir para montar el recorrido.',
      sinTrozos: 'Añade al menos un trozo.',
      noCargadaB: 'No se pudo cargar una de las rutas elegidas.',
    },
    plan: {
      mergeApi: '/api/planned/merge',
      detailUrl: pid => '/Plan/' + encodeURIComponent(pid),
      listUrl: '/planificacion',
      list: () => Store.planned(),
      load: pid => Store.plan(pid),
      titulo: 'Unir plan',
      unirCon: 'Con qué planes unir',
      okN: n => n ? `Unir con ${n} plan${n === 1 ? '' : 'es'}` : 'Elige al menos uno',
      buscarPh: 'Buscar por nombre…',
      sinOtras: 'No hay otros planes con los que unir.',
      elige: 'Elige con qué planes unir.',
      crear: 'Crear plan unido',
      nombrePh: 'Nombre del plan unido',
      creando: 'Creando el plan…',
      creada: 'Creado',
      noEncontrada: 'Plan no encontrado.',
      noCargada: 'No se pudo cargar este plan.',
      estaEl: 'este plan',
      laOtra: 'el otro plan',
      invertidaN: 'invertido',
      invertidasN: 'invertidos',
      entera: 'entero',
      parcialTip: 'La propuesta elegida usa este plan por trozos: ' +
                  'invertirlo entero no significa nada.',
      offline: 'Unir necesita conexión: la unión la calcula el servidor. ' +
               'Puedes mirar el plan, pero no previsualizar ni crear nada.',
      perfilVacio: 'Elige con qué planes unir para ver el perfil del resultado.',
      eligeMontaje: 'Elige con qué planes unir para montar el recorrido.',
      sinTrozos: 'Añade al menos un trozo.',
      noCargadaB: 'No se pudo cargar uno de los planes elegidos.',
    },
  };
  let kind = 'plan';
  let K = KINDS.plan;

  /* ── estado ─────────────────────────────────────────────────────────────── */
  let pid = null;              // public_id de la entidad que se está uniendo (A)
  let current = null;          // su dict (geojson, name…)
  let _lastParams = null;      // para «↻ Reintentar»
  let items = [];              // candidatos (del Store), ya ordenados por cercanía
  let search = '';             // texto del buscador
  let searchTimer = null;
  /* Las entradas ELEGIDAS, en orden: sels[0] es B, sels[1] es C… (la A es
     `pid`). `pickDraft` es la selección que se está haciendo en el popup, que
     solo pasa a `sels` al pulsar «Unir con N» (cerrar la descarta). `selGen`
     sube con cada cambio de selección: invalida las cargas de fuentes en vuelo
     que eran de la selección anterior, como `_tok` las del montaje. */
  let sels = [], pickDraft = [], selGen = 0;
  let pickOpen = false;        // ¿está abierto el popup «con qué unir»?
  let map = null, capa = null;
  let mapRO = null;        // ResizeObserver del mapa: la columna crece con el panel derecho
  let creating = false;

  /* Previsualización: `opts` son las opciones que manda el usuario (null = nada
     elegido todavía); `rep`/`stats`, la última respuesta de `preview:true`. El
     token descarta respuestas viejas, como el `_tok` del montaje: cada control
     relanza la previsualización y la red no garantiza el orden de llegada. */
  let opts = null, rep = null, stats = null;
  let prevTimer = null, prevTok = 0, fitted = false;
  /* «La próxima previsualización que llegue, reencuádrala». Lo pone el
     conmutador de modo: al volver a automático el informe se rehace entero y la
     rejilla cambia con él, así que el encuadre bueno no se sabe hasta que llega
     esa respuesta. Es de un solo uso: el resto del tiempo, cambiar una opción
     no debe moverle la cámara al usuario. */
  let refitNext = false;
  /* Propuestas de ensamblaje. `props` es la última lista recibida; `hadProps`
     recuerda si en modo AUTOMÁTICO había más de una (para ofrecer «volver a las
     propuestas» tras forzar una orientación, que deja una sola); `partial[i]`
     marca la entrada que la propuesta elegida usa por trozos. */
  let props = [], hadProps = false, partial = [];
  /* Inicio y fin FORZADOS. '' = automático (lo decide el servidor mirando la
     geometría); si no, '<i><e>' con i = índice de entrada (0 = la que se está
     uniendo, 1… = las elegidas) y e = 's' (inicio) | 'e' (fin): '0s','0e','1s'…
     Viajan en `options.start`/`options.end`, y el servidor contesta en
     `report.endpoints_applied` si ha podido cumplirlos (si no, además manda su
     aviso en `warnings` y las propuestas son las de siempre).
     `endsBad` guarda cuál de los dos desplegables está en conflicto —el usuario
     ha pedido el mismo extremo dos veces— para no mandar nada hasta que lo
     arregle: sería un 400 seguro. */
  let ends = {start: '', end: ''}, endsBad = '';
  /* Perfil de elevación del RESULTADO y hover sincronizado mapa↔perfil. Mismo
     diseño que la ficha de un plan (sec/plan.js): una unión, como un plan, solo
     tiene elevación. `resCoords`/`resCum` son el resultado ensamblado aplanado y
     su distancia acumulada en km — es lo que traduce un punto del mapa a la «d»
     de la serie de elevación y al revés. `resBreak` marca los índices donde
     empieza un segmento nuevo: ahí NO se interpola (el hueco entre segmentos no
     es camino, y la distancia tampoco lo cuenta, igual que en analyse_gpx). */
  let elevChart = null, resElev = [], resCoords = [], resCum = [], resBreak = null;
  let hoverD = null, hoverBoxEl = null;
  /* Hover sobre una de las ENTRADAS (solo en montaje): {i, d} en km, o null.
     Es el hermano de `hoverD`, que es el del resultado; si los dos estuvieran
     vivos manda el del resultado (ver updateSrcMapHover). */
  let srcHover = null;
  /* Marcadores DOM de inicio/fin del resultado y de los extremos
     originales. DOM y no capas a propósito: sobreviven al setStyle() de un
     cambio de capa base, así que no hay que reponerlos (regla 15). */
  let endMarkers = [];

  /* ── modo «Montaje» ───────────────────────────────────────────────────────
     El modo AUTOMÁTICO es el de siempre: el servidor enumera los ensamblajes
     posibles y el usuario elige uno. El modo MONTAJE es lo contrario: el
     usuario dice exactamente qué trozo de cada entrada quiere y en qué orden
     (como un editor de vídeo) y el servidor solo arregla las costuras. Viaja en
     `options.pieces` y, con él, el servidor ignora proposal/start/end/reverse.

     `srcs[i]` es la entrada i (0 = la que se está uniendo, 1… = las elegidas) ya
     aplanada: sus coordenadas, su distancia acumulada en km punto a punto y su
     serie de elevación. Es lo que traduce «km 4,1» a un punto del mapa y al
     revés, y de ahí salen los `from_m`/`to_m` que se mandan (en METROS).

     `pieces` es el montaje: {track, from_m, to_m}, con `from_m > to_m` cuando el
     trozo va invertido — que es como lo entiende el servidor. */
  const MODE_KEY = 'sendero_unir_modo_v1';
  let mode = 'auto';                 // 'auto' | 'montaje'
  let srcs = [];                     // por entrada: {name, coords, cum, total, elev}
  let srcCharts = [];
  let selRange = [];                 // por entrada: selección por arrastre {a, b} en km
  /* Por entrada, el panel de su perfil fuente (lo crea srcEl() la primera vez
     y se reutiliza): {panel, title, sub, canvas, range, add, addr}. */
  const srcEls = [];
  let pieces = [];                   // el montaje, en orden
  let hiPiece = null;                // clip resaltado por el ratón (índice)
  /* Memo del cálculo de «Ajustar» (el par de vértices más cercano de cada
     costura): es O(n·m) y se consulta dos veces por repintado (línea de tiempo
     y panel). La firma cubre lo único que puede cambiarlo: los trozos, la
     tolerancia y la escala de las fuentes. */
  let fitCache = {sig: null, arr: []};
  /* Longitudes REALES de cada entrada según el servidor (`track_lengths_m`). La
     serie ligera de elevación puede quedarse unos metros corta, y los `from_m`
     que se mandan tienen que hablar en la misma escala que el servidor: en
     cuanto llega, se reescalan las fuentes (y los trozos ya puestos, una sola
     vez por entrada, comparando con tolerancia para que no oscile). */
  let trackLens = null;

  /* Cuántos tracks se pueden unir de una vez, contando el que se está uniendo.
     El servidor admite algo más (`_MAX_INPUTS` de core/editing.py); aquí manda
     lo que se puede leer: seis colores distintos y seis perfiles fuente. */
  const MAX_INPUTS = 6;
  /* Colores de serie, uno por entrada, no tokens de CSS: van en el JS que
     pinta, como el resto de colores de serie. A y B son los de siempre
     (elevación y velocidad de las gráficas); C… salen de la paleta del
     catálogo de actividades, lejos del rojo del marcador de fin. */
  const SRC_COLOR = ['#f0b070', '#3d9be9', '#43b97f', '#a86ee0', '#e055c0', '#23bfc4'];
  const MG_A_COLOR = SRC_COLOR[0];
  const srcColor = i => SRC_COLOR[i % SRC_COLOR.length];
  const MG_INK = '#0b120e';     // tinta oscura del contorno de las flechas
  /* Gris apagado (= --muted) para la propuesta que se está SOLO mirando: tiene
     que leerse como «esta no es la elegida» al lado de las dos de color. */
  const MG_HOVER_COLOR = '#8b9a8f';
  /* Hueco por debajo del cual la unión lo cose en recta sin que se note: es el
     `gap_join_m` de core/editing.py::smart_merge (que no viaja en el informe).
     Solo se usa para decidir si la chapa «hueco X» de una propuesta merece
     salir; lo que se une de verdad lo decide el servidor. */
  const MG_GAP_JOIN_M = 50;
  const EMPTY_FC = {type: 'FeatureCollection', features: []};
  const NEAR_M = 3000;          // «Cercanos»: a menos de 3 km de un extremo
  /* Por debajo de esto, inicio y fin del resultado son el MISMO sitio (un
     circuito): dos chapas encima la una de la otra no se leen, así que se pone
     una sola «INICIO / FIN». */
  const ENDS_SAME_M = 30;
  const NAME_MAX = 28;          // recorte de los nombres en los desplegables
  const TL_MIN_PX = 56;         // ancho mínimo de un clip de la línea de tiempo
  /* Trozo más corto que esto (en metros) no tiene costura que arreglar: el
     servidor lo rechaza con un 400 (es 2·tol_m), así que aquí ni se añade. */
  const PIECE_MIN_FACTOR = 2;
  /* «Ajustar» una costura: ventana de búsqueda (metros) a cada lado y mejora
     mínima para que el botón valga la pena. La ventana es a propósito — sin
     ella, dos tracks que se cruzan varias veces engancharían la costura en un
     cruce lejano y se comerían medio trozo. Nunca pasa de la mitad del trozo. */
  const FIT_WIN_M = 3000;
  /* Mejora por debajo de la cual el BOTÓN ya no ofrece nada (sale
     deshabilitado): media docena de metros no se ven en un mapa. */
  const FIT_MIN_GAIN_M = 5;
  /* …pero una vez pulsado se apura hasta el final. Con el umbral de 5 m como
     criterio de parada, el caso invertido se quedaba en el vértice de al lado
     (5,8 m en vez de 0,9) y el servidor, que ahí sí recorta, devolvía un hueco
     de 69 m donde el mismo montaje sin invertir daba «costura limpia». */
  const FIT_STEP_GAIN_M = 0.5;
  /* Tope de comparaciones del par más cercano: por encima se hace una pasada
     gruesa a paso fijo y se afina alrededor del mejor. Con los tracks reales
     (unos cientos de vértices por ventana) no se llega nunca. */
  const FIT_MAX_PAIRS = 250000;
  const FIT_TIP = 'Recortar los dos trozos hasta el par de puntos más cercanos ' +
    'entre ambos tracks, para que la costura quede lo más pegada posible';
  const FIT_TIP_OK = 'La costura ya está en el punto más cercano';

  function fmt(n, dec = 0) { return (n || 0).toLocaleString('es-ES', {maximumFractionDigits: dec}); }

  /* Los colores de serie son hex; el relleno de un perfil y la banda de
     selección los quieren translúcidos. Se derivan aquí en vez de escribir otra
     constante que se pueda desfasar del color de la línea. */
  function rgba(hex, a) {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* Local al módulo, como en sec/planes.js y sec/detalle.js: son diez líneas y
     compartirlas obligaría a un helper global por tres usos. */
  function haversineM(la1, lo1, la2, lo2) {
    const R2 = 6371000, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R2 * Math.asin(Math.sqrt(a));
  }

  /* ── el mapa ────────────────────────────────────────────────────────────── */
  /* Flecha de sentido como IMAGEN (el estilo raster no trae glyphs, así que un
     `text-field` no pintaría nada). Apunta a la derecha: con
     symbol-placement:'line' MapLibre alinea el eje X del icono con el sentido
     de la línea. */
  function _arrowImage(color) {
    const s = 18, c = document.createElement('canvas');
    c.width = s; c.height = s;
    const g = c.getContext('2d');
    g.fillStyle = color; g.strokeStyle = MG_INK; g.lineWidth = 1.6; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(4, 3); g.lineTo(15, 9); g.lineTo(4, 15); g.closePath();
    g.fill(); g.stroke();
    return g.getImageData(0, 0, s, s);
  }

  function trackA() { return (current && current.geojson) || []; }

  /* Fuentes y capas de datos. Se llaman en `load` Y en cada `sendero:basemap`:
     entrar o salir de la capa offline reconstruye el estilo entero y se lleva
     todas las fuentes por delante (regla 15). Idempotente a propósito. */
  function addDataLayers() {
    /* Solo la comprobación de idempotencia, NUNCA `isStyleLoaded()`: al volver de
       `sendero:basemap` (que se dispara en el `styledata` del estilo nuevo) esa
       función todavía devuelve false, así que guardarse con ella dejaba el mapa
       SIN las trazas y sin forma de recuperarlas — salir de la capa offline
       borraba la previsualización entera. Las fuentes se pueden añadir en cuanto
       el estilo está puesto, que es justo lo que dice ese evento. */
    if (!map || map.getSource('un-s0')) return;
    for (let i = 0; i < MAX_INPUTS; i++) {
      if (!map.hasImage('mg-arrow-' + i)) map.addImage('mg-arrow-' + i, _arrowImage(srcColor(i)));
    }

    /* Una traza por ENTRADA (`un-s<i>`, del color de su serie), con ribete
       oscuro debajo por el mismo motivo que la traza por pendiente de los dos
       detalles (el color claro se pierde sobre el topográfico). En automático
       solo se ve la de A, mientras no hay previsualización; en MONTAJE se ven
       todas ENTERAS y atenuadas debajo del resultado, porque de ellas es de
       donde se recortan los trozos. Se crean las MAX_INPUTS de una vez (vacías)
       para que añadir un track a la selección no tenga que tocar el estilo.
       `un-s<i>-hit` es la línea ancha invisible del hover de la fuente (modo
       Montaje), mismo patrón que `mg-keep-hit`; va DEBAJO de `mg-keep-hit`, que
       se añade más abajo: donde el resultado se monte sobre la traza atenuada
       manda el resultado (lo comprueba el handler con queryRenderedFeatures). */
    for (let i = 0; i < MAX_INPUTS; i++) {
      const id = 'un-s' + i;
      map.addSource(id, {type: 'geojson', data: EMPTY_FC});
      map.addLayer({id: id + '-casing', type: 'line', source: id,
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': MG_INK, 'line-width': 7, 'line-opacity': .45}});
      map.addLayer({id: id + '-line', type: 'line', source: id,
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': srcColor(i), 'line-width': 4, 'line-opacity': .95}});
      map.addLayer({id: id + '-hit', type: 'line', source: id,
        layout: {'line-join': 'round', 'line-cap': 'round'},
        paint: {'line-color': MG_INK, 'line-width': 18, 'line-opacity': 0}});
    }

    /* Previsualización: una sola fuente con todo (las partes que se conservan,
       lo que se va a descartar y el hueco), separadas por `kind` con un filtro
       por capa. */
    map.addSource('mg', {type: 'geojson', data: EMPTY_FC});
    map.addLayer({id: 'mg-keep-line', type: 'line', source: 'mg',
      filter: ['==', ['get', 'kind'], 'keep'],
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': ['get', 'color'], 'line-width': 4.5, 'line-opacity': .95}});
    /* Línea ancha invisible sobre el resultado, solo para que el hover sea más
       fácil de acertar que sobre los 4,5 px reales (mismo patrón que
       `pl-ruta-hit` en la ficha de un plan y `ov-lines-hit` en Mis Rutas). */
    map.addLayer({id: 'mg-keep-hit', type: 'line', source: 'mg',
      filter: ['==', ['get', 'kind'], 'keep'],
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': MG_INK, 'line-width': 18, 'line-opacity': 0}});
    /* Lo que se descarta va ENCIMA de lo que se conserva, no debajo: el solape
       de una costura cae justo sobre la otra traza (para eso es un solape), y
       por debajo no se vería nunca — que es el caso normal. Y
       `line-cap:'butt'` (como las capas de hueco de shared.js): con 'round'
       cada trazo crece media anchura por lado, el punteado se cierra y acaba
       pareciendo una línea continua — lo contrario de lo que dice. */
    map.addLayer({id: 'mg-trim-line', type: 'line', source: 'mg',
      filter: ['==', ['get', 'kind'], 'trim'],
      layout: {'line-join': 'round', 'line-cap': 'butt'},
      paint: {'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': .75,
        'line-dasharray': [2, 2.5]}});
    // hueco que NO se une: la recta que quedaría, punteada
    map.addLayer({id: 'mg-gap-line', type: 'line', source: 'mg',
      filter: ['==', ['get', 'kind'], 'gap'],
      layout: {'line-join': 'round', 'line-cap': 'butt'},
      paint: {'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 2.5],
        'line-opacity': .9}});
    // sentido de cada track: iconos (no texto: el estilo raster no trae glyphs)
    map.addLayer({id: 'mg-arrows', type: 'symbol', source: 'mg',
      filter: ['==', ['get', 'kind'], 'keep'],
      layout: {'symbol-placement': 'line', 'symbol-spacing': 110,
        'icon-image': ['get', 'arrow'], 'icon-size': .75,
        'icon-allow-overlap': true, 'icon-rotation-alignment': 'map'}});
    map.addSource('mg-junc', {type: 'geojson', data: EMPTY_FC});
    map.addLayer({id: 'mg-junc-circ', type: 'circle', source: 'mg-junc',
      paint: {'circle-radius': 8, 'circle-color': '#0b120e', 'circle-opacity': .55,
        'circle-stroke-color': '#e3b23c', 'circle-stroke-width': 2.5}});
    /* El tramo que se está eligiendo por arrastre en un perfil fuente, o el
       clip que el ratón está señalando en la línea de tiempo: la misma capa,
       gruesa y del color de SU fuente, encima de las dos trazas atenuadas. Así
       «km 4,1 → 9,5» tiene dónde mirarse en el mapa. */
    map.addSource('un-sel', {type: 'geojson', data: EMPTY_FC});
    map.addLayer({id: 'un-sel-line', type: 'line', source: 'un-sel',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': ['get', 'color'], 'line-width': 7, 'line-opacity': .9}});

    /* La propuesta que el ratón está SOLO mirando (tarjeta no elegida): línea
       fina punteada gris ENCIMA de todo, para comparar sin cambiar la elección. */
    map.addSource('mg-hover', {type: 'geojson', data: EMPTY_FC});
    map.addLayer({id: 'mg-hover-casing', type: 'line', source: 'mg-hover',
      layout: {'line-join': 'round', 'line-cap': 'round'},
      paint: {'line-color': MG_INK, 'line-width': 5, 'line-opacity': .45}});
    map.addLayer({id: 'mg-hover-line', type: 'line', source: 'mg-hover',
      layout: {'line-join': 'round', 'line-cap': 'butt'},
      paint: {'line-color': MG_HOVER_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 2],
        'line-opacity': 1}});
    /* Punto que sigue al cursor por el resultado (una fuente de un solo Point,
       se mueve con setData: más barato que un Marker DOM en cada mousemove).
       Se añade el ÚLTIMO para que quede encima de todo lo demás. */
    map.addSource('mg-hover-point', {type: 'geojson', data: EMPTY_FC});
    map.addLayer({id: 'mg-hover-point', type: 'circle', source: 'mg-hover-point',
      paint: {'circle-radius': 7, 'circle-color': MG_A_COLOR,
        'circle-stroke-width': 2, 'circle-stroke-color': '#101a14'}});
    /* El mismo punto, pero para el hover sobre una de las dos FUENTES (modo
       Montaje): otra fuente para no pisarse con el del resultado, y el color lo
       trae la propia feature porque puede ser el de A o el de B. */
    map.addSource('un-src-hover-point', {type: 'geojson', data: EMPTY_FC});
    map.addLayer({id: 'un-src-hover-point', type: 'circle', source: 'un-src-hover-point',
      paint: {'circle-radius': 6.5, 'circle-color': ['get', 'color'],
        'circle-stroke-width': 2, 'circle-stroke-color': '#101a14'}});
  }

  /* Repinta lo que haya: el informe si ya hubo previsualización, y si no el
     track A solo. Lo llaman `load` y `sendero:basemap`. */
  function repaint() {
    if (!map) return;
    addDataLayers();
    paintSources();
    /* Las fuentes se acaban de recrear vacías (regla 15): el punto del hover de
       una entrada hay que reponerlo, o se pierde al cambiar de capa base. */
    updateSrcMapHover();
    if (rep) paintReport(rep); else clearMap(false);
  }

  /* Las trazas de entrada, enteras. Quién se ve y con qué fuerza depende del
     modo:
     - AUTOMÁTICO: A sola mientras no hay previsualización; con informe a la
       vista sobra, porque sus piezas ya se pintan (y recortadas) en `tracks`.
     - MONTAJE: todas siempre, atenuadas — son el material del que se recortan
       los trozos, así que tienen que verse aunque el resultado esté encima.
     Se llama desde repaint(), paintReport() y clearMap(): un solo sitio decide. */
  function paintSources() {
    if (!map || !map.getSource('un-s0')) return;
    const montaje = mode === 'montaje';
    const linea = c => (c && c.length > 1)
      ? {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: c}}
      : EMPTY_FC;
    const dim = montaje ? .38 : .95;
    for (let i = 0; i < MAX_INPUTS; i++) {
      const id = 'un-s' + i;
      const coords = i === 0 ? trackA() : ((i < nIn() && srcs[i] && srcs[i].coords) || []);
      const s = map.getSource(id);
      if (!s) continue;
      const visible = montaje ? true : (i === 0 && !rep);
      s.setData(visible ? linea(coords) : EMPTY_FC);
      try {
        map.setPaintProperty(id + '-line', 'line-opacity', dim);
        map.setPaintProperty(id + '-casing', 'line-opacity', montaje ? .3 : .45);
      } catch (e) {}
    }
  }

  function initMap() {
    destroyMap();
    const c = trackA();
    if (!capa) capa = defaultBasemap();
    let cx = -1.6, cy = 42.5, z = 6;
    if (c.length) { cx = c[0][0]; cy = c[0][1]; z = 12; }
    map = new maplibregl.Map({
      container: 'un-map', style: buildStyle(capa),
      center: [cx, cy], zoom: z, attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({compact: true}), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
    addGeolocate(map, 'top-right');
    /* La columna del mapa mide lo mismo que el panel derecho (align-items:stretch),
       así que su alto cambia cuando llegan las propuestas o se pliega «Con qué
       unir». MapLibre no se entera solo: sin esto, el lienzo se queda con el alto
       de la creación y el resto sale en negro. */
    if (typeof ResizeObserver !== 'undefined') {
      const wrap = document.getElementById('un-map');
      mapRO = new ResizeObserver(() => { if (map) requestAnimationFrame(() => map && map.resize()); });
      if (wrap) mapRO.observe(wrap);
    }
    // botón centrar (mismo idioma que el editor, el detalle y Mis Rutas)
    map.addControl({
      onAdd() {
        const box = document.createElement('div');
        box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const b = document.createElement('button');
        b.innerHTML = '⤢'; b.title = 'Centrar en lo que se ve';
        b.style.cssText = 'font-size:16px;width:29px;height:29px;cursor:pointer;border:none;background:none;padding:0;display:flex;align-items:center;justify-content:center';
        b.onclick = () => fitCurrent();
        box.appendChild(b); return box;
      }, onRemove() {},
    }, 'top-left');
    // selector de capas base (regla 15: siempre por applyBasemap)
    map.addControl({
      onAdd() {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:var(--panel,#fff);color:var(--ink,#0b120e);border:none;font-size:12px;cursor:pointer;padding:5px 7px;font-family:inherit;width:100%';
        basemapNames().forEach(n => {
          const o = document.createElement('option'); o.value = n; o.textContent = n;
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

    /* Hover sobre el resultado → resalta la misma distancia en el perfil. Se
       registra AQUÍ y no en addDataLayers(), que se vuelve a ejecutar tras cada
       cambio de estilo y acumularía handlers; MapLibre admite escuchar una capa
       que todavía no existe. */
    map.on('mousemove', 'mg-keep-hit', e => {
      if (!resCoords.length) return;
      const {lng, lat} = e.lngLat;
      let best = Infinity, bestIdx = 0;
      for (let i = 0; i < resCoords.length; i++) {
        const dx = resCoords[i][0] - lng, dy = resCoords[i][1] - lat, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bestIdx = i; }
      }
      map.getCanvas().style.cursor = 'crosshair';
      setHoverD(resCum[bestIdx]);
    });
    map.on('mouseleave', 'mg-keep-hit', () => {
      map.getCanvas().style.cursor = '';
      setHoverD(null);
    });

    /* Lo mismo para las trazas fuente, que es lo que se mira en montaje:
       pasar el ratón por A, B, C… en el mapa mueve el crosshair de SU perfil y
       pone el punto sobre esa traza. Se registra AQUÍ, una sola vez, por el
       mismo motivo que el del resultado: `addDataLayers()` repone las capas tras
       cada `sendero:basemap` (regla 15) y registrarlo allí acumularía handlers. */
    const HIT = Array.from({length: MAX_INPUTS}, (_, i) => 'un-s' + i + '-hit');
    const hitLayers = () => HIT.filter(l => map.getLayer(l));
    /* El MISMO handler para todas las capas, y decide él cuál es: las entradas
       se solapan largos tramos (para eso se unen), así que en esos metros los eventos
       se disparan y el último registrado ganaría siempre — el ratón sobre A
       señalaba B. Aquí se mira el vértice más cercano de CADA entrada que esté
       bajo el cursor y gana el más cerca, así el resultado no depende del orden
       en que MapLibre reparta los eventos. */
    const srcHoverMove = e => {
      if (mode !== 'montaje') return;          // en automático manda el resultado
      /* Donde el resultado se monta sobre la traza atenuada gana el resultado:
         su hover describe lo que se va a crear, que es la pregunta. */
      if (map.getLayer('mg-keep-hit') &&
          map.queryRenderedFeatures(e.point, {layers: ['mg-keep-hit']}).length) {
        setSrcHover(null);
        return;
      }
      const {lng, lat} = e.lngLat;
      let bi = -1, bk = 0, bd = Infinity;
      for (let i = 0; i < Math.min(nIn(), MAX_INPUTS); i++) {
        const s = srcs[i];
        if (!s || !s.coords.length || !map.getLayer(HIT[i])) continue;
        if (!map.queryRenderedFeatures(e.point, {layers: [HIT[i]]}).length) continue;
        for (let k = 0; k < s.coords.length; k++) {
          const dx = s.coords[k][0] - lng, dy = s.coords[k][1] - lat, d2 = dx * dx + dy * dy;
          if (d2 < bd) { bd = d2; bi = i; bk = k; }
        }
      }
      if (bi < 0) { setSrcHover(null); return; }
      map.getCanvas().style.cursor = 'crosshair';
      setSrcHover(bi, srcs[bi].cum[bk]);
    };
    /* Salir de UNA traza no es salir de todas: si el cursor sigue sobre otra,
       se deja que su propio mousemove lo resuelva. */
    const srcHoverOut = e => {
      if (mode !== 'montaje') return;
      if (e && e.point && map.queryRenderedFeatures(e.point, {layers: hitLayers()}).length) return;
      map.getCanvas().style.cursor = '';
      setSrcHover(null);
    };
    HIT.forEach(lid => {
      map.on('mousemove', lid, srcHoverMove);
      map.on('mouseleave', lid, srcHoverOut);
    });

    map.on('load', () => { repaint(); fitA(); });
    /* Entrar o salir de la capa offline reconstruye el estilo y se lleva todas
       las fuentes: hay que volver a crearlas y repintar (regla 15). */
    map.on('sendero:basemap', () => repaint());
  }

  function destroyMap() {
    /* El cuadro flotante del hover vive en el contenedor del mapa: si no se
       quita, cada initMap() dejaría uno huérfano (el mapa se recrea entero). */
    if (hoverBoxEl && hoverBoxEl.parentNode) hoverBoxEl.parentNode.removeChild(hoverBoxEl);
    hoverBoxEl = null;
    hoverD = null;
    srcHover = null;
    clearEndMarkers();
    if (mapRO) { try { mapRO.disconnect(); } catch (e) {} mapRO = null; }
    if (!map) return;
    try { map.remove(); } catch (e) {}
    map = null;
  }

  function fitA() {
    if (!map || geoTracking(map)) return;   // la cámara es del usuario mientras se sigue
    const c = trackA();
    if (!c.length) return;
    let mnLo = Infinity, mxLo = -Infinity, mnLa = Infinity, mxLa = -Infinity;
    c.forEach(([lo, la]) => {
      if (lo < mnLo) mnLo = lo; if (lo > mxLo) mxLo = lo;
      if (la < mnLa) mnLa = la; if (la > mxLa) mxLa = la;
    });
    if (mnLo === Infinity) return;
    // duration:0: el centro del constructor es un placeholder y animar desde él
    // es el «vuelo» que se quitó del mapa de «Mis Rutas».
    map.fitBounds([[mnLo, mnLa], [mxLo, mxLa]], {padding: 50, duration: 0});
  }

  /* Todas las entradas enteras. Es el encuadre del modo «Montaje» mientras no
     hay informe: ahí se ven todas las trazas a la vez (son el material del que
     se recortan los trozos), así que mirar solo A deja media tarea fuera. */
  function fitAll() {
    if (!map || geoTracking(map)) return;
    let mnLo = Infinity, mxLo = -Infinity, mnLa = Infinity, mxLa = -Infinity;
    [trackA()].concat(srcs.slice(1, nIn()).map(x => (x && x.coords) || [])).forEach(c => c.forEach(([lo, la]) => {
      if (lo < mnLo) mnLo = lo; if (lo > mxLo) mxLo = lo;
      if (la < mnLa) mnLa = la; if (la > mxLa) mxLa = la;
    }));
    if (mnLo === Infinity) return;
    map.fitBounds([[mnLo, mnLa], [mxLo, mxLa]], {padding: 60, duration: 0});
  }

  /* A dónde toca mirar AHORA: al resultado si ya hay informe; si no, a todas
     las entradas cuando se están viendo (montaje con alguna elegida ya
     cargada); y si no, a A sola. En automático las elegidas no se pintan, así
     que encuadrarlas dejaría medio mapa vacío. Lo usa el botón «centrar» y el
     reencuadre del conmutador de modo. */
  function fitCurrent() {
    if (!map) return;
    if (rep) { fitReport(rep); return; }
    if (mode === 'montaje' && srcs.slice(1, nIn()).some(x => x && x.coords && x.coords.length > 1)) {
      fitAll();
      return;
    }
    fitA();
  }

  /* Encuadrar DESPUÉS de que el lienzo haya cambiado de tamaño. Cambiar de modo
     cambia la rejilla entera (ver «MONTAJE: disposición propia» en unir.css),
     así que el mapa pasa de una caja a otra: encuadrar en el mismo tick calcula
     la cámara para el tamaño VIEJO y deja el track descentrado o fuera de
     pantalla. Dos requestAnimationFrame: el primero corre ya con el estilo
     nuevo aplicado (ahí se hace el resize real) y el segundo, sobre el lienzo
     ya redimensionado, es donde se encuadra. El ResizeObserver hace lo mismo por
     su cuenta, pero no avisa a nadie de cuándo. */
  function afterResize(fn) {
    if (!map) return;
    if (typeof requestAnimationFrame !== 'function') { fn(); return; }
    requestAnimationFrame(() => {
      if (!map) return;
      try { map.resize(); } catch (e) {}
      requestAnimationFrame(() => {
        if (!map) return;
        try { map.resize(); } catch (e) {}
        fn();
      });
    });
  }

  function fitReport(r) {
    if (!map || geoTracking(map)) return;
    let mnLo = Infinity, mxLo = -Infinity, mnLa = Infinity, mxLa = -Infinity;
    (r.segments || []).forEach(s => s.forEach(([lo, la]) => {
      if (lo < mnLo) mnLo = lo; if (lo > mxLo) mxLo = lo;
      if (la < mnLa) mnLa = la; if (la > mxLa) mxLa = la;
    }));
    if (mnLo === Infinity) return;
    map.fitBounds([[mnLo, mnLa], [mxLo, mxLa]], {padding: 50, duration: 400});
  }

  function paintReport(r) {
    if (!map || !map.getSource('mg')) return;
    paintSources();
    const col = ei => srcColor(ei);
    const arr = ei => 'mg-arrow-' + (ei % MAX_INPUTS);
    const feats = [];
    const line = (coords, p) => {
      if (coords && coords.length > 1)
        feats.push({type: 'Feature', properties: p,
          geometry: {type: 'LineString', coordinates: coords}});
    };
    (r.tracks || []).forEach(t => {
      line(t.coords, {kind: 'keep', color: col(t.idx), arrow: arr(t.idx)});
      line(t.trimmed_head, {kind: 'trim', color: col(t.idx)});
      line(t.trimmed_tail, {kind: 'trim', color: col(t.idx)});
    });
    /* El hueco que NO se une: la recta entre el final de una parte y el
       principio de la siguiente (el informe da el punto medio en `junctions`,
       que sirve para la chapa pero no para dibujar el tramo). */
    /* En montaje `gaps` se salta las costuras «sin costura», así que su índice
       no es el de `tracks`: se usa el mapa que lo corrige (ver seamGaps). */
    const gl = (mode === 'montaje' && pieces.length) ? seamGaps() : (r.gaps || []);
    gl.forEach((g, k) => {
      if (!g || g.seamless || g.joined) return;
      const x = (r.tracks || [])[k], y = (r.tracks || [])[k + 1];
      if (!x || !y || !x.coords || !y.coords || !x.coords.length || !y.coords.length) return;
      line([x.coords[x.coords.length - 1], y.coords[0]], {kind: 'gap'});
    });
    map.getSource('mg').setData({type: 'FeatureCollection', features: feats});
    map.getSource('mg-junc').setData({type: 'FeatureCollection',
      features: (r.junctions || []).map(p => ({type: 'Feature', properties: {},
        geometry: {type: 'Point', coordinates: p}}))});
    /* Inicio/fin del resultado y los cuatro extremos originales. Va aquí (y no
       en preview()) porque repaint() vuelve a llamar a paintReport tras un
       cambio de capa base, y así las chapas no dependen de que llegue otra
       respuesta del servidor. paintEndMarkers() limpia antes de poner. */
    paintEndMarkers(r);
    updateMapHover();
    paintSelection();
  }

  /* Quita las capas de previsualización y devuelve la traza de A. `refit`
     devuelve también el encuadre (solo si había algo pintado: si no, movería el
     mapa sin motivo). */
  function clearMap(refit) {
    if (map && map.getSource('mg')) {
      map.getSource('mg').setData(EMPTY_FC);
      map.getSource('mg-junc').setData(EMPTY_FC);
      paintSources();
    }
    hoverClear();
    paintSelection();
    clearEndMarkers();
    clearElevation();
    if (refit) fitA();
  }

  function hoverProposal(k) {
    if (!map || !map.getSource('mg-hover')) return;
    const p = props[k];
    if (!p || (opts && (opts.proposal | 0) === k)) { hoverClear(); return; }
    const feats = (p.segments_lite || []).filter(s => s && s.length > 1)
      .map(s => ({type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: s}}));
    map.getSource('mg-hover').setData({type: 'FeatureCollection', features: feats});
  }
  function hoverClear() {
    if (map && map.getSource('mg-hover')) map.getSource('mg-hover').setData(EMPTY_FC);
  }

  /* ── inicio y fin: marcadores en el mapa ──────────────────────────────────
     Dos puntos (verde = inicio, rojo = fin) sobre los extremos del resultado, y
     cuatro puntitos sobre los extremos ORIGINALES de cada entrada — que son
     justo las cuatro opciones de los desplegables, así que sin ellos «Inicio de
     PARTE B» no se sabe dónde cae.
     Marcadores DOM y no capas: sobreviven al setStyle() de un cambio de capa
     base (regla 15), como el punto de «Mi ubicación». */
  function tok(nombre, porDefecto) {
    // MapLibre y un estilo inline necesitan un color literal, no una variable
    // CSS: se lee del :root de base.html, que sigue siendo la fuente de verdad.
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(nombre);
      if (v && v.trim()) return v.trim();
    } catch (e) {}
    return porDefecto;
  }

  function clearEndMarkers() {
    endMarkers.forEach(m => { try { m.remove(); } catch (e) {} });
    endMarkers = [];
  }

  function markerEl(cls, color, txt, titulo) {
    const el = document.createElement('div');
    el.className = cls;
    if (el.style && el.style.setProperty) el.style.setProperty('--c', color);
    if (txt) el.textContent = txt;
    if (titulo) el.title = titulo;
    return el;
  }

  function addMarker(el, lngLat) {
    if (!map || !lngLat || !maplibregl || !maplibregl.Marker) return;
    try {
      endMarkers.push(new maplibregl.Marker({element: el}).setLngLat(lngLat).addTo(map));
    } catch (e) {}
  }

  function paintEndMarkers(r) {
    clearEndMarkers();
    if (!map || !r) return;
    const sage = tok('--sage', '#8fb69f'), red = tok('--gr-red', '#e2492c');
    // Crema, no gris: un punto de 11 px en `--muted` se pierde sobre el
    // topográfico, que ya es verde claro (mismo motivo que el ribete oscuro de
    // la traza por pendiente en los dos detalles).
    const crema = tok('--ink', '#ece5d8');
    const s = r.start_point, e = r.end_point;
    /* «El mismo sitio» es o bien la distancia, o bien que el servidor ya haya
       dicho que el recorrido CIERRA circuito: `_closes()` usa
       max(tol, gap_join) = 50 m, y el caso real de los dos GPX de Wikiloc cierra
       a 30,4 m — con solo los 30 m de aquí saldrían dos chapas pisándose en un
       recorrido que el propio informe llama circular. */
    const juntos = s && e && (r.closed_loop === true ||
      haversineM(s[1], s[0], e[1], e[0]) < ENDS_SAME_M);
    /* Los cuatro extremos originales, como puntitos: si dos coinciden (un bucle
       empieza y acaba en el mismo sitio) se pintan igual, uno encima del otro —
       esconder uno haría que su opción del desplegable no tuviera dónde mirarse.
       Van ANTES que las chapas: MapLibre apila los marcadores en el orden en que
       se añaden y el inicio/fin tiene que quedar encima. */
    (r.endpoints || []).forEach(ep => {
      const L = mgLabel(ep.track), nm = ep.name || '';
      if (ep.s) addMarker(markerEl('un-edot', crema, '', `${L}·ini${nm ? ' · ' + nm : ''}`), ep.s);
      if (ep.e) addMarker(markerEl('un-edot', crema, '', `${L}·fin${nm ? ' · ' + nm : ''}`), ep.e);
    });
    /* Puntos, no chapas: una etiqueta «INICIO» de 60 px tapaba justo el trozo de
       traza que se quería ver. El punto mide poco más que la línea (4,5 px) y
       el texto va en el `title`. Si inicio y fin coinciden, un solo punto a dos
       colores (`--c2` pinta la mitad derecha). */
    if (s && juntos) {
      const el = markerEl('un-emark', sage, '', 'Inicio y fin del recorrido unido (circuito)');
      if (el.style && el.style.setProperty) el.style.setProperty('--c2', red);
      addMarker(el, s);
    } else {
      if (s) addMarker(markerEl('un-emark', sage, '', 'Inicio del recorrido unido'), s);
      if (e) addMarker(markerEl('un-emark', red, '', 'Final del recorrido unido'), e);
    }
  }

  /* ── hover sincronizado mapa↔perfil ───────────────────────────────────────
     Port del de sec/plan.js: una unión, como un plan, solo tiene elevación (no
     se ha hecho todavía), así que el cuadro flotante enseña km y altitud. Punto
     de entrada único: setHoverD(d), d en km o null. */

  /* Aplana los segmentos del resultado y calcula su distancia acumulada en km.
     El salto ENTRE segmentos no suma: es el hueco que la unión dejó a propósito
     para no fabricar distancia, y `analyse_gpx` tampoco lo cuenta — que es de
     donde sale la serie de elevación con la que hay que casar. */
  function buildResult(r) {
    resCoords = []; resCum = []; resBreak = new Set();
    const segs = (r && r.segments) || [];
    let cum = 0;
    segs.forEach(s => {
      if (!s || !s.length) return;
      if (resCoords.length) resBreak.add(resCoords.length);   // arranca segmento
      for (let i = 0; i < s.length; i++) {
        if (i > 0) {
          const [lo1, la1] = s[i - 1], [lo2, la2] = s[i];
          cum += haversineM(la1, lo1, la2, lo2) / 1000;
        }
        resCoords.push(s[i]); resCum.push(cum);
      }
    });
    /* Las trazas del informe vienen DECIMADAS (`_dec` en core/editing.py), así
       que su longitud queda unas milésimas por debajo de la real. Se escala al
       total de la serie de elevación para que «d» signifique lo mismo en el
       mapa y en el perfil; sin esto el punto se iría desplazando hacia el final
       del track (unos metros, pero el crosshair se nota). */
    const total = resCum.length ? resCum[resCum.length - 1] : 0;
    const objetivo = resElev.length ? resElev[resElev.length - 1].d : 0;
    if (total > 0 && objetivo > 0) {
      const k = objetivo / total;
      for (let i = 0; i < resCum.length; i++) resCum[i] *= k;
    }
  }

  /* La serie de elevación tiene su propio muestreo (≤500 puntos remuestreados),
     así que hay que buscar el más cercano por distancia: no vale el índice. */
  function nearestByD(arr, d) {
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].d < d) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(arr[lo - 1].d - d) < Math.abs(arr[lo].d - d)) lo--;
    return arr[lo];
  }

  /* Posición interpolada en el resultado a los d km. */
  function lngLatAtD(d) {
    if (!resCum.length) return null;
    if (d <= resCum[0]) return resCoords[0];
    if (d >= resCum[resCum.length - 1]) return resCoords[resCoords.length - 1];
    let lo = 0, hi = resCum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (resCum[mid] < d) lo = mid + 1; else hi = mid; }
    if (lo === 0) return resCoords[0];
    // En un corte de segmento no hay camino entre lo-1 y lo: se queda en el borde.
    if (resBreak && resBreak.has(lo)) return resCoords[lo];
    const d0 = resCum[lo - 1], d1 = resCum[lo], t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
    const [lo0, la0] = resCoords[lo - 1], [lo1, la1] = resCoords[lo];
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

  /* Coloca el cuadro flotante junto a un punto del mapa. OJO: la clase trae
     `display:none`, así que hay que forzar 'block' (limpiar el estilo inline lo
     devolvería a ese none) y hacerlo ANTES de medir, o offsetWidth es 0. */
  function placeHoverBox(box, ll, html) {
    box.innerHTML = html;
    box.style.display = 'block';
    const pt = map.project(ll);
    const cw = map.getContainer().clientWidth, bw = box.offsetWidth || 120;
    let left = pt.x + 14;
    if (left + bw > cw - 6) left = pt.x - 14 - bw;
    box.style.left = Math.max(6, left) + 'px';
    box.style.top = (pt.y - 10) + 'px';
  }

  function updateMapHover() {
    if (!map) return;
    const src = map.getSource && map.getSource('mg-hover-point');
    if (!src && hoverD == null) return;      // aún no hay capas: nada que limpiar
    const box = ensureHoverBox();
    if (hoverD == null || !src || !resCum.length) {
      // El cuadro es uno solo: si lo está usando el hover de una fuente, se deja.
      if (!srcHover) box.style.display = 'none';
      if (src) src.setData(EMPTY_FC);
      return;
    }
    const ll = lngLatAtD(hoverD);
    if (!ll) { if (!srcHover) box.style.display = 'none'; return; }
    src.setData({type: 'FeatureCollection',
      features: [{type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: ll}}]});
    const e = nearestByD(resElev, hoverD);
    const parts = [`<div class="hb-km">${hoverD.toFixed(2)} km</div>`];
    if (e) parts.push(`<div>Alt ${fmtNum(Math.round(e.e))} m</div>`);
    placeHoverBox(box, ll, parts.join(''));
  }

  /* ── hover sobre una de las FUENTES (solo modo Montaje) ────────────────────
     El del resultado dice «dónde cae el km 4,1 de lo que voy a crear»; este dice
     «dónde cae el km 4,1 de A», que es la pregunta mientras se recortan trozos.
     Misma mecánica y mismo cuadro flotante, pero con su propia fuente de punto
     (el color es el de la entrada) y su propio crosshair en SU perfil.
     `srcHover` = {i, d} o null; el del resultado manda si los dos están vivos. */
  function srcLngLatAtD(s, d) {
    const cum = s.cum, co = s.coords;
    if (!cum.length || !co.length) return null;
    if (d <= cum[0]) return co[0];
    if (d >= cum[cum.length - 1]) return co[co.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
    if (lo === 0) return co[0];
    const d0 = cum[lo - 1], d1 = cum[lo], t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
    const [x0, y0] = co[lo - 1], [x1, y1] = co[lo];
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  }

  function updateSrcMapHover() {
    if (!map) return;
    const src = map.getSource && map.getSource('un-src-hover-point');
    if (!src && !srcHover) return;
    const box = ensureHoverBox();
    const s = srcHover ? srcs[srcHover.i] : null;
    const ll = s ? srcLngLatAtD(s, srcHover.d) : null;
    if (!ll || !src) {
      if (src) src.setData(EMPTY_FC);
      if (hoverD == null) box.style.display = 'none';
      return;
    }
    src.setData({type: 'FeatureCollection', features: [{type: 'Feature',
      properties: {color: srcColor(srcHover.i)},
      geometry: {type: 'Point', coordinates: ll}}]});
    if (hoverD != null) return;          // el cuadro lo está escribiendo el resultado
    const e = nearestByD(s.elev, srcHover.d);
    const parts = [`<div class="hb-km">${mgLabel(srcHover.i)} · ${srcHover.d.toFixed(2)} km</div>`];
    if (e) parts.push(`<div>Alt ${fmtNum(Math.round(e.e))} m</div>`);
    placeHoverBox(box, ll, parts.join(''));
  }

  /* Punto de entrada único del hover de fuente, como `setHoverD` lo es del
     resultado. `i == null` (o `d` inválida) lo apaga. Solo repinta los perfiles
     que cambian de estado, y con render() — nunca update(), que reconstruye
     escalas y reenvía el último evento de ratón. */
  function setSrcHover(i, d) {
    const next = (i == null || d == null || isNaN(d)) ? null : {i: i, d: d};
    const prev = srcHover;
    if (!next && !prev) return;
    if (next && prev && prev.i === next.i && Math.abs(prev.d - next.d) < 1e-9) return;
    if (_syncing) return;
    _syncing = true;
    srcHover = next;
    try {
      for (let k = 0; k < srcCharts.length; k++) {
        if (!srcCharts[k]) continue;
        if ((next && next.i === k) || (prev && prev.i === k)) {
          try { srcCharts[k].render(); } catch (e) {}
        }
      }
    } finally { _syncing = false; }
    updateSrcMapHover();
  }

  /* Lo llaman el mapa (mousemove sobre el resultado) y el perfil (onHover).

     El cerrojo NO es opcional: el update() de Chart.js REENVÍA el último evento
     de ratón (`_lastEvent`, un replay interno) y con él vuelve a llamar a
     onHover, o sea a esta misma función. Sin él, setHoverD(null) se deshacía a
     sí mismo y el cuadro se quedaba pegado en el mapa para siempre. */
  let _syncing = false;
  function setHoverD(d) {
    if (_syncing) return;
    _syncing = true;
    hoverD = d;
    /* El cuadro flotante es uno solo: si se enciende el del resultado, el de las
       fuentes se apaga (y se repintan sus perfiles para llevarse el crosshair). */
    const apagaSrc = (d != null && !!srcHover);
    if (apagaSrc) srcHover = null;
    /* render() y NO update('none'): el crosshair solo necesita repintar el
       lienzo. update() reconstruye escalas, resuelve las opciones de todos los
       puntos y reenvía el último evento de ratón (ver «Rendimiento del hover»). */
    try {
      if (elevChart) elevChart.render();
      if (apagaSrc) for (let k = 0; k < srcCharts.length; k++) {
        if (srcCharts[k]) { try { srcCharts[k].render(); } catch (e) {} }
      }
    } finally { _syncing = false; }
    if (apagaSrc) updateSrcMapHover();
    updateMapHover();
  }

  /* Línea vertical + punto en el perfil, a la distancia resaltada. Lee hoverD del
     ámbito del módulo y el valor del propio dataset. */
  function drawCrosshair(chart, d, colorAt) {
    if (d == null) return;
    const xScale = chart.scales.x, yScale = chart.scales.y;
    if (d < xScale.min || d > xScale.max) return;
    const ds = chart.data.datasets[0].data;
    if (!ds || !ds.length) return;
    let lo = 0, hi = ds.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ds[mid].x < d) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(ds[lo - 1].x - d) < Math.abs(ds[lo].x - d)) lo--;
    const x = xScale.getPixelForValue(d), y = yScale.getPixelForValue(ds[lo].y);
    const c = chart.ctx;
    c.save();
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, chart.chartArea.top); c.lineTo(x, chart.chartArea.bottom); c.stroke();
    c.fillStyle = (colorAt && colorAt(lo)) || chart.data.datasets[0].borderColor;
    c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#101a14'; c.lineWidth = 1.5; c.stroke();
    c.restore();
  }

  function crosshairPlugin(colorAt) {
    return {id: 'hoverCrosshair',
      afterDatasetsDraw(chart) { drawCrosshair(chart, hoverD, colorAt); }};
  }

  /* El mismo crosshair en un perfil FUENTE, pero leyendo `srcHover` y solo si
     el que está señalado es este (cada perfil se repinta por separado). */
  function srcCrosshairPlugin(i) {
    return {id: 'unSrcCrosshair',
      afterDatasetsDraw(chart) {
        if (!srcHover || srcHover.i !== i) return;
        drawCrosshair(chart, srcHover.d, () => srcColor(i));
      }};
  }

  /* ── perfil de elevación del resultado ───────────────────────────────────
     Mismas convenciones que el perfil de la ficha de un plan: rejilla y marcas
     en mono apagado, sin títulos de eje (la unidad la dice el título del panel)
     y línea + relleno con el degradado POR PENDIENTE de shared.js. */
  const GRID = 'rgba(236,229,216,.07)';
  const TICK = {color: '#68786d', font: {family: "'IBM Plex Mono',monospace", size: 10}};

  function elevSub(data) {
    if (!data.length) return '';
    let max = data[0].e;
    for (let i = 1; i < data.length; i++) if (data[i].e > max) max = data[i].e;
    return `${fmtNum(Math.round(data[0].e))} m salida · ${fmtNum(Math.round(max))} m cima`;
  }

  function destroyChart() {
    if (!elevChart) return;
    try { elevChart.destroy(); } catch (e) {}
    elevChart = null;
  }

  function drawElevation() {
    destroyChart();
    const panel = q('#un-elev-panel');
    const sub = q('#un-elev-sub'), leg = q('#un-slope-legend');
    const elev = resElev;
    if (!elev.length) {
      if (panel) panel.classList.add('is-empty');
      if (sub) sub.textContent = '';
      if (leg) leg.innerHTML = '';
      return;
    }
    if (panel) panel.classList.remove('is-empty');
    if (sub) sub.textContent = elevSub(elev);
    if (leg) leg.innerHTML = slopeLegendHtml();
    const ctx = q('#un-elev');
    if (!ctx || typeof Chart !== 'function') return;
    const prof = slopeProfile(elev);
    elevChart = new Chart(ctx, {
      type: 'line',
      /* El degradado por pendiente entra como VALOR desde el plugin, NUNCA como
         opción scriptable: Chart.js las resuelve una vez POR PUNTO y aquí se
         repinta en cada mousemove (ver «Rendimiento del hover» en CLAUDE.md). */
      plugins: [crosshairPlugin(i => slopeColor(prof[i])), slopeGradientPlugin(elev)],
      data: {datasets: [{
        data: elev.map(p => ({x: p.d, y: p.e})), fill: true,
        borderColor: MG_A_COLOR, backgroundColor: 'transparent',
        borderWidth: 2.2, pointRadius: 0, tension: .3,
      }]},
      options: {
        maintainAspectRatio: false,
        animation: false,
        interaction: {mode: 'nearest', axis: 'x', intersect: false},
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
          label: i => `${fmtNum(Math.round(i.parsed.y))} m`,
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
    /* Asignación directa, NO addEventListener: cada previsualización destruye y
       recrea el Chart reutilizando el mismo <canvas>, así que con
       addEventListener los listeners se irían acumulando. */
    ctx.onmouseleave = () => setHoverD(null);
    ctx.ontouchend = () => setHoverD(null);   // en táctil no hay mouseleave
  }

  /* Deja el perfil y el hover como si no hubiera habido previsualización. */
  function clearElevation() {
    destroyChart();
    resElev = []; resCoords = []; resCum = []; resBreak = null;
    hoverD = null;
    updateMapHover();
    updateSrcMapHover();
    drawElevation();
  }

  /* ══ MODO «MONTAJE» ════════════════════════════════════════════════════════
     El modo AUTOMÁTICO enseña lo que el servidor propone; el MONTAJE hace lo
     contrario: el usuario recorta un tramo de cada perfil y los ordena en una
     línea de tiempo, como en un editor de vídeo, y el servidor solo arregla las
     costuras (recorte del solape, hueco cosido o dejado como corte, cierre de
     circular y los tiempos). Viaja en `options.pieces`, y con él el servidor
     ignora `proposal`/`start`/`end`/`reverse` — por eso ni se mandan.

     Todo lo que se manda son METROS a lo largo del track ORIGINAL de cada
     entrada, y `from_m > to_m` significa «invertido». La traducción km↔punto
     del mapa la lleva `srcs[i].cum`, la distancia acumulada punto a punto, y la
     referencia de longitud es la serie de elevación (que sale del track
     completo) hasta que el servidor manda la suya en `track_lengths_m`. */

  function loadMode() {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage) {
        const v = sessionStorage.getItem(MODE_KEY);
        if (v === 'montaje' || v === 'auto') return v;
      }
    } catch (e) {}
    return 'auto';
  }
  function saveMode(m) {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage) sessionStorage.setItem(MODE_KEY, m);
    } catch (e) {}
  }

  function tolM() {
    const t = parseFloat(opts ? opts.tol : 30);
    return isNaN(t) ? 30 : Math.max(5, Math.min(200, t));
  }

  /* Aplana una entrada: coordenadas + distancia acumulada (km) + elevación.
     `?lite=1` decima el geojson, así que su longitud en bruto queda corta: se
     escala al total de la serie de elevación, que es la del track completo —
     misma técnica que `buildResult()` con el resultado. */
  function buildSrc(d) {
    const coords = (d && d.geojson) || [];
    const elev = (d && Array.isArray(d.elevation)) ? d.elevation : [];
    const cum = [];
    let c = 0;
    for (let i = 0; i < coords.length; i++) {
      if (i > 0) {
        const [lo1, la1] = coords[i - 1], [lo2, la2] = coords[i];
        c += haversineM(la1, lo1, la2, lo2) / 1000;
      }
      cum.push(c);
    }
    const bruto = cum.length ? cum[cum.length - 1] : 0;
    const s = {name: (d && d.name) || '', coords, elev, cum, total: bruto};
    scaleSrc(s, elev.length ? elev[elev.length - 1].d : bruto);
    return s;
  }

  function scaleSrc(s, total) {
    const bruto = s.cum.length ? s.cum[s.cum.length - 1] : 0;
    if (bruto > 0 && total > 0) {
      const k = total / bruto;
      for (let i = 0; i < s.cum.length; i++) s.cum[i] *= k;
    }
    s.total = total > 0 ? total : bruto;
  }

  /* `track_lengths_m` del informe: la longitud REAL de cada entrada según el
     servidor, que es quien de verdad corta. Manda sobre el último `d` de la
     serie ligera, así que al llegar se reescalan la fuente, los trozos ya
     puestos y la selección con el mismo factor. Con tolerancia (0,2 %) para que
     no oscile: la siguiente previsualización devuelve el mismo número y ya no
     cambia nada. Devuelve true si movió algo. */
  function applyTrackLens(lens) {
    if (!Array.isArray(lens)) return false;
    trackLens = lens;
    let cambia = false;
    for (let i = 0; i < srcs.length; i++) {
      const s = srcs[i], L = lens[i];
      if (!s || !(L > 0)) continue;
      const nuevo = L / 1000, viejo = s.total || nuevo;
      if (Math.abs(nuevo - viejo) <= Math.max(0.002, viejo * 0.002)) continue;
      const k = nuevo / viejo;
      /* Se reescala TODO con el mismo factor, la serie de elevación incluida:
         si solo se tocara `cum`, el eje X del perfil seguiría llegando al 9,8
         de la serie ligera mientras «Todo» seleccionaría hasta el 9,5 del
         servidor, y la banda no llegaría al borde de su propia gráfica. */
      for (let j = 0; j < s.cum.length; j++) s.cum[j] *= k;
      s.elev = s.elev.map(p => ({d: p.d * k, e: p.e}));
      s.total = nuevo;
      pieces.forEach(p => { if (p.track === i) { p.from_m *= k; p.to_m *= k; } });
      if (selRange[i]) { selRange[i].a *= k; selRange[i].b *= k; }
      cambia = true;
    }
    return cambia;
  }

  function srcIdxAtD(s, d) {
    const cum = s.cum;
    if (!cum.length) return 0;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* Las coordenadas de la entrada `i` entre `a` y `b` km (en cualquier orden:
     para pintar el resalte da igual el sentido). */
  function srcSlice(i, a, b) {
    const s = srcs[i];
    if (!s || s.coords.length < 2) return [];
    const lo = Math.max(0, Math.min(a, b)), hi = Math.min(s.total, Math.max(a, b));
    const i0 = srcIdxAtD(s, lo), i1 = srcIdxAtD(s, hi);
    const out = s.coords.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
    return out.length > 1 ? out : [];
  }

  /* El tramo resaltado en el mapa: el clip que señala el ratón si lo hay, y si
     no las selecciones vivas de los perfiles. Solo en modo montaje. */
  function paintSelection() {
    if (!map || !map.getSource('un-sel')) return;
    const feats = [];
    const add = (i, a, b) => {
      const c = srcSlice(i, a, b);
      if (c.length > 1) feats.push({type: 'Feature', properties: {color: srcColor(i)},
        geometry: {type: 'LineString', coordinates: c}});
    };
    if (mode === 'montaje') {
      const p = (hiPiece != null) ? pieces[hiPiece] : null;
      if (p) add(p.track, p.from_m / 1000, p.to_m / 1000);
      else for (let i = 0; i < selRange.length; i++) if (selRange[i]) add(i, selRange[i].a, selRange[i].b);
    }
    map.getSource('un-sel').setData({type: 'FeatureCollection', features: feats});
  }

  /* ── los perfiles fuente (uno por entrada) ─────────────────────────────────
     El markup solo trae el contenedor `#un-srcs`: el panel de cada entrada lo
     crea srcEl(i) la PRIMERA vez que hace falta y se queda (se esconde con
     style.display cuando sobra). Reutilizarlo no es un detalle: el <canvas> se
     engancha una sola vez (bindSrcDrag, que pone listeners en `window`), y
     recrearlo en cada montaje los iría acumulando. Los elementos se buscan
     dentro del propio panel, nunca por id: son seis copias del mismo markup. */
  function srcEl(i) {
    if (srcEls[i]) return srcEls[i];
    const box = q('#un-srcs');
    if (!box || i >= MAX_INPUTS) return null;
    const p = document.createElement('div');
    p.className = 'panel un-src-panel';
    p.style.display = 'none';
    p.innerHTML =
      '<div class="panel-head"><span class="panel-title" data-r="title"></span>' +
      '<span class="panel-sub mono" data-r="sub"></span></div>' +
      '<div class="chart-box src"><canvas data-r="canvas"></canvas></div>' +
      '<div class="un-src-foot"><span class="un-src-range mono" data-r="range"></span>' +
      '<span class="un-src-btns">' +
      `<button class="btn ghost sm" type="button" onclick="SEC.unir.srcAll(${i})">Todo</button>` +
      `<button class="btn ghost sm" type="button" data-r="addr" onclick="SEC.unir.srcAdd(${i},true)">＋ Añadir invertido</button>` +
      `<button class="btn sm" type="button" data-r="add" onclick="SEC.unir.srcAdd(${i},false)">＋ Añadir trozo</button>` +
      '</span></div>';
    box.appendChild(p);
    const r = k => p.querySelector(`[data-r="${k}"]`);
    srcEls[i] = {panel: p, title: r('title'), sub: r('sub'), canvas: r('canvas'),
      range: r('range'), add: r('add'), addr: r('addr')};
    return srcEls[i];
  }

  /* Qué paneles fuente se ven: los de las entradas que hay y ya están cargadas,
     y solo en montaje. Con más de dos, perfiles más bajos (`.many`). */
  function showSrcPanels() {
    const montaje = mode === 'montaje';
    const box = q('#un-srcs');
    if (box) {
      box.style.display = (montaje && !!srcs[0]) ? '' : 'none';
      box.classList.toggle('many', nIn() > 2);
    }
    for (let i = 0; i < MAX_INPUTS; i++) {
      const el = (i < nIn() && montaje && srcs[i]) ? srcEl(i) : srcEls[i];
      if (el && el.panel) el.panel.style.display = (montaje && i < nIn() && srcs[i]) ? '' : 'none';
    }
  }

  /* Ámbar de la selección: es `--pr-yellow`, literal porque un <canvas> necesita
     un color concreto — el mismo criterio (y el mismo dibujo) que la banda A–B
     del perfil del editor. */
  const SEL_FILL = 'rgba(227,178,60,.18)', SEL_EDGE = '#e3b23c';

  function selBandPlugin(i) {
    return {id: 'unSelBand', afterDatasetsDraw(c) {
      const p = (hiPiece != null) ? pieces[hiPiece] : null;
      const hi = (p && p.track === i) ? {a: p.from_m / 1000, b: p.to_m / 1000} : null;
      const r = hi || selRange[i];
      if (!r || !c.chartArea) return;
      const x1 = c.scales.x.getPixelForValue(Math.min(r.a, r.b));
      const x2 = c.scales.x.getPixelForValue(Math.max(r.a, r.b));
      const ctx = c.ctx, area = c.chartArea;
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      ctx.clip();
      ctx.fillStyle = SEL_FILL;
      ctx.fillRect(Math.min(x1, x2), area.top, Math.abs(x2 - x1), area.bottom - area.top);
      ctx.strokeStyle = SEL_EDGE; ctx.lineWidth = 1.5;
      [x1, x2].forEach(x => {
        ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom); ctx.stroke();
      });
      ctx.restore();
    }};
  }

  function destroySrcChart(i) {
    if (!srcCharts[i]) return;
    try { srcCharts[i].destroy(); } catch (e) {}
    srcCharts[i] = null;
  }
  function destroySrcCharts() { for (let i = 0; i < srcCharts.length; i++) destroySrcChart(i); }

  function drawSrcChart(i) {
    destroySrcChart(i);
    const s = srcs[i];
    const el = s ? srcEl(i) : null;
    const ctx = el && el.canvas;
    if (!s || !ctx || typeof Chart !== 'function' || !s.elev.length) return;
    const elev = s.elev;
    srcCharts[i] = new Chart(ctx, {
      type: 'line',
      plugins: [selBandPlugin(i), srcCrosshairPlugin(i)],
      /* Sin degradado por pendiente a propósito: estos perfiles son el
         MATERIAL (cada uno del color de su entrada, que es como se identifican
         en el mapa y en los clips), no el resultado. El color por pendiente se
         queda para el perfil del resultado, donde describe el recorrido. */
      data: {datasets: [{
        data: elev.map(p => ({x: p.d, y: p.e})), fill: true,
        borderColor: srcColor(i), backgroundColor: rgba(srcColor(i), .14),
        borderWidth: 1.8, pointRadius: 0, tension: .3,
      }]},
      options: {
        maintainAspectRatio: false,
        animation: false,
        /* Chart.js no escucha NADA: aquí hay dos gestos sobre el mismo lienzo
           (arrastrar para elegir un tramo y pasar el ratón para señalar) y los
           dos los lleva el propio <canvas> en bindSrcDrag(). Así se esquivan de
           raíz las dos trampas de `onHover` que sí se pagan en el perfil del
           resultado: el replay del último evento en cada update() y el
           `mouseout` diferido que llega DESPUÉS del mouseleave del lienzo. */
        events: [],
        plugins: {legend: {display: false}, tooltip: {enabled: false}},
        scales: {
          x: {type: 'linear', min: 0, max: elev[elev.length - 1].d,
              ticks: {...TICK, maxTicksLimit: 6}, grid: {color: GRID, drawTicks: false},
              border: {display: false}},
          y: {ticks: {...TICK, maxTicksLimit: 4, callback: v => fmtNum(v)},
              grid: {color: GRID, drawTicks: false}, border: {display: false}},
        },
      },
    });
    bindSrcDrag(ctx, i);
  }

  /* Arrastrar sobre el perfil = elegir un tramo. Mismo gesto que la selección
     A–B del editor, y con las mismas dos precauciones: el movimiento y el
     soltar se escuchan en `window` (o soltar fuera del lienzo dejaría el
     arrastre pegado) y el enganche se hace UNA sola vez por <canvas> — los
     paneles se reutilizan (srcEl) y `mount()` puede correr decenas de veces. */
  let dragI = null;
  function bindSrcDrag(canvas, i) {
    if (canvas._unBound) return;
    canvas._unBound = true;
    const evX = ev => (ev.touches && ev.touches.length ? ev.touches[0].clientX : ev.clientX);
    const kmAt = ev => {
      const c = srcCharts[i], s = srcs[i];
      if (!c || !s || typeof canvas.getBoundingClientRect !== 'function') return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect || !rect.width) return null;
      const cx = (evX(ev) - rect.left) *
        ((canvas.width || rect.width) / (window.devicePixelRatio || 1)) / rect.width;
      const km = c.scales.x.getValueForPixel(cx);
      if (km == null || isNaN(km)) return null;
      return Math.max(0, Math.min(km, s.total));
    };
    const down = ev => {
      if (mode !== 'montaje' || !srcs[i]) return;
      const km = kmAt(ev);
      if (km == null) return;
      dragI = i; selRange[i] = {a: km, b: km}; hiPiece = null;
      if (ev.preventDefault) ev.preventDefault();
      refreshSrc(i);
    };
    const move = ev => {
      if (dragI !== i || !selRange[i]) return;
      const km = kmAt(ev);
      if (km == null) return;
      selRange[i].b = km;
      if (ev.preventDefault) ev.preventDefault();
      refreshSrc(i);
    };
    const up = () => {
      if (dragI !== i) return;
      dragI = null;
      // Un click suelto no es una selección (como en el editor): se descarta.
      if (selRange[i] && Math.abs(selRange[i].b - selRange[i].a) < 1e-4) selRange[i] = null;
      refreshSrc(i);
    };
    /* Pasar el ratón (sin arrastrar) señala esa distancia en el mapa: punto
       sobre ESTA traza + crosshair en este perfil. Mientras hay arrastre
       (`dragI !== null`) el hover no actúa: el gesto es elegir un tramo, y
       encender además un punto que persigue al cursor solo estorba. */
    const hover = ev => {
      if (mode !== 'montaje' || dragI !== null || !srcs[i]) return;
      const km = kmAt(ev);
      if (km == null) { setSrcHover(null); return; }
      setSrcHover(i, km);
    };
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', hover);
    canvas.addEventListener('mouseleave', () => setSrcHover(null));
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', down, {passive: false});
    canvas.addEventListener('touchmove', move, {passive: false});
    canvas.addEventListener('touchend', up);
    canvas.addEventListener('dblclick', () => { if (mode === 'montaje') srcAll(i); });
  }

  /* render() y no update(): solo hay que repintar la banda (ver «Rendimiento
     del hover»: update() reconstruye escalas y vuelve a resolver las opciones). */
  function refreshSrc(i) {
    if (srcCharts[i]) { try { srcCharts[i].render(); } catch (e) {} }
    renderSrcFoot(i);
    paintSelection();
  }

  function srcName(i) {
    const s = srcs[i];
    if (s && s.name) return s.name;
    return i === 0 ? ((current && current.name) || K.estaEl) : (selName(i) || K.laOtra);
  }

  function renderSrcHead(i) {
    const s = srcs[i];
    const el = s ? srcEl(i) : srcEls[i];
    if (!el) return;
    const t = el.title, sub = el.sub;
    if (t) t.textContent = `${mgLabel(i)} · ${srcName(i)}` +
      (s ? ` · ${fmt(s.total, 1)} km` : '');
    const n = pieces.filter(p => p.track === i).length;
    if (sub) sub.textContent = n ? `${n} trozo${n === 1 ? '' : 's'}` : '';
  }

  function renderSrcFoot(i) {
    const s = srcs[i], r = selRange[i];
    const el = s ? srcEl(i) : srcEls[i];
    if (!el) return;
    const lab = el.range;
    /* El sentido del ARRASTRE cuenta: de derecha a izquierda es el tramo al
       revés, y «＋ Añadir trozo» lo mete ya invertido. «＋ Añadir invertido»
       le da la vuelta a lo que diga la selección. */
    if (lab) lab.textContent = (s && r)
      ? `km ${fmt(r.a, 1)} → ${fmt(r.b, 1)} · ${fmt(Math.abs(r.b - r.a), 1)} km` +
        (r.b < r.a ? ' · invertido' : '')
      : 'Arrastra sobre el perfil para elegir un tramo (doble click: entero).';
    [el.add, el.addr].forEach(b => { if (b) b.disabled = !(s && r); });
  }

  function srcAll(i) {
    const s = srcs[i];
    if (!s) return;
    selRange[i] = {a: 0, b: s.total};
    hiPiece = null;
    refreshSrc(i);
  }

  /* Añade el tramo elegido al final de la línea de tiempo. `rev` lo mete con el
     sentido cambiado, que para el servidor es `from_m > to_m`. */
  function srcAdd(i, rev) {
    const s = srcs[i], r = selRange[i];
    if (!s) return;
    if (!r) { toast('Arrastra sobre el perfil para elegir un tramo.'); return; }
    // El sentido del arrastre ya es el del trozo; `rev` le da la vuelta.
    const a = r.a * 1000, b = r.b * 1000;
    /* Por debajo de 2·tol el servidor devuelve 400 (un trozo así no tiene
       costura que arreglar): se avisa aquí en vez de gastar la petición. */
    const min = PIECE_MIN_FACTOR * tolM();
    if (Math.abs(b - a) < min) { toast(`Un trozo tiene que medir más de ${fmt(min)} m.`); return; }
    pieces.push(rev ? {track: i, from_m: b, to_m: a} : {track: i, from_m: a, to_m: b});
    afterPieces();
  }

  function pieceAct(k, act) {
    const p = pieces[k];
    if (!p) return;
    if (act === 'del') pieces.splice(k, 1);
    else if (act === 'rev') { const t = p.from_m; p.from_m = p.to_m; p.to_m = t; }
    else if (act === 'left' && k > 0) { pieces[k] = pieces[k - 1]; pieces[k - 1] = p; }
    else if (act === 'right' && k < pieces.length - 1) { pieces[k] = pieces[k + 1]; pieces[k + 1] = p; }
    else return;
    afterPieces();
  }

  function clearPieces() {
    if (!pieces.length) return;
    pieces = [];
    afterPieces();
  }

  /* Un solo sitio tras cualquier cambio del montaje: repintar la línea de
     tiempo y el panel, y relanzar la previsualización con el debounce y el
     token de siempre. Sin trozos no se pide nada: no hay qué unir. */
  function afterPieces() {
    hiPiece = null;
    renderTimeline();
    renderPiecesPanel();
    for (let i = 0; i < nIn(); i++) renderSrcHead(i);
    paintSelection();
    elevEmptyText();
    if (pieces.length) { showSkeleton(); schedule(); }
    else {
      if (prevTimer) { clearTimeout(prevTimer); prevTimer = null; }
      prevTok++;
      rep = null; stats = null; props = [];
      clearMap(false);
      showEmpty(sels.length ? K.sinTrozos : K.eligeMontaje);
    }
  }

  /* ── la línea de tiempo ───────────────────────────────────────────────────
     Un clip por trozo, de ancho proporcional a su longitud (con mínimo, o un
     trozo corto no tendría dónde poner sus botones), y entre clips el estado de
     la costura según el informe. Las piezas REALES (ya recortadas por el
     servidor) salen de `report.proposals[0].pieces`. */
  function realPieces() {
    const p = (rep && (rep.proposals || [])[0]);
    return (p && p.pieces) || [];
  }

  function actBtn(k, act, txt, tit, dis) {
    return `<button class="un-pact" type="button" data-k="${k}" data-act="${act}"` +
      ` title="${esc(tit)}"${dis ? ' disabled' : ''}>${txt}</button>`;
  }

  /* ── «Ajustar» una costura ────────────────────────────────────────────────
     Recorta los dos trozos de una costura hasta el par de vértices más cercano
     entre sus dos tracks. Todo pasa por el ESTADO del montaje (`pieces`), no
     por el informe: el servidor recibe los `from_m`/`to_m` nuevos y vuelve a
     decidir él lo que hace con ellos.

     Orientación: el FINAL efectivo de un trozo es siempre `to_m` y su INICIO
     efectivo siempre `from_m` — lo que cambia con `from_m > to_m` (trozo
     invertido) es hacia dónde queda «lo ya recorrido». De ahí `fitWindow()`:
     mirar hacia atrás desde la cola de un trozo invertido es ir hacia metros
     MAYORES. Y el ajuste solo puede RECORTAR: la ventana de cada pasada va
     dentro del trozo y, como mucho, hasta su mitad. */

  /* La ventana de búsqueda de un trozo, en metros del track y ya ordenada
     [lo, hi]. `cola` = el final efectivo (el trozo ANTERIOR de la costura);
     si no, el inicio efectivo (el trozo SIGUIENTE). `orig` es el trozo tal como
     estaba al pulsar el botón: la ventana llega SIEMPRE hasta su borde
     original, o sea que lo ya recortado en pasadas anteriores sigue siendo
     candidato. Sin eso la búsqueda es un descenso ciego y se queda en un mínimo
     local: medido con los dos tracks reales, el trozo B se recortaba 400 m en
     la primera pasada y ya no podía volver a su inicio, que era justo el punto
     de encuentro (264 m de costura en vez de 5). */
  function fitWindow(p, orig, cola) {
    const rev = p.to_m < p.from_m;
    const len = Math.abs(p.to_m - p.from_m);
    const w = Math.min(len / 2, FIT_WIN_M);
    const borde = cola ? p.to_m : p.from_m;
    const limite = cola ? p.from_m : p.to_m;   // el otro extremo del trozo
    // hacia dentro del trozo: en sentido normal la cola mira a metros menores
    const dentro = (cola ? -1 : 1) * (rev ? -1 : 1);
    let otro = borde + dentro * w;
    otro = dentro > 0 ? Math.min(otro, limite) : Math.max(otro, limite);
    const ancla = orig ? (cola ? orig.to_m : orig.from_m) : borde;
    return [Math.min(otro, borde, ancla), Math.max(otro, borde, ancla)];
  }

  /* Los índices de vértice de la fuente `s` que caen en [lo, hi] metros. */
  function fitIdxRange(s, lo, hi) {
    const n = s.cum.length;
    const i0 = Math.max(0, Math.min(n - 1, srcIdxAtD(s, lo / 1000)));
    const i1 = Math.max(0, Math.min(n - 1, srcIdxAtD(s, hi / 1000)));
    return [Math.min(i0, i1), Math.max(i0, i1)];
  }

  /* Par de vértices a distancia mínima entre dos ventanas. O(n·m) a pelo
     mientras quepa en FIT_MAX_PAIRS; si no, pasada gruesa a paso fijo y afinado
     alrededor del mejor (el resultado es el mismo salvo en cruces patológicos,
     y ahí sigue siendo una costura buena). */
  function nearestPair(ca, a0, a1, cb, b0, b1) {
    const n = a1 - a0 + 1, m = b1 - b0 + 1;
    if (n < 1 || m < 1) return null;
    const paso = Math.max(1, Math.ceil(Math.sqrt(n * m / FIT_MAX_PAIRS)));
    const scan = (x0, x1, y0, y1, st) => {
      let mejor = null;
      for (let i = x0; i <= x1; i += st) {
        const [lo1, la1] = ca[i];
        for (let j = y0; j <= y1; j += st) {
          const [lo2, la2] = cb[j];
          const d = haversineM(la1, lo1, la2, lo2);
          if (!mejor || d < mejor.d) mejor = {i, j, d};
        }
      }
      return mejor;
    };
    let mejor = scan(a0, a1, b0, b1, paso);
    if (mejor && paso > 1) {
      const fino = scan(Math.max(a0, mejor.i - paso), Math.min(a1, mejor.i + paso),
        Math.max(b0, mejor.j - paso), Math.min(b1, mejor.j + paso), 1);
      if (fino && fino.d < mejor.d) mejor = fino;
    }
    return mejor;
  }

  /* El plan de ajuste de UNA pasada sobre la costura k (entre los trozos P y N),
     o null si no se puede calcular. `corto` = número de trozo (1-based, como lo
     ve el usuario) que quedaría por debajo de 2·tol; 0 = ninguno. */
  function fitPlan(P, N, k, oP, oN) {
    if (!P || !N) return null;
    const sp = srcs[P.track], sn = srcs[N.track];
    if (!sp || !sn || sp.coords.length < 2 || sn.coords.length < 2) return null;
    const wp = fitWindow(P, oP, true), wn = fitWindow(N, oN, false);
    const rp = fitIdxRange(sp, wp[0], wp[1]), rn = fitIdxRange(sn, wn[0], wn[1]);
    const mejor = nearestPair(sp.coords, rp[0], rp[1], sn.coords, rn[0], rn[1]);
    if (!mejor) return null;
    const ip = fitIdxRange(sp, P.to_m, P.to_m)[0], iN = fitIdxRange(sn, N.from_m, N.from_m)[0];
    const cur = haversineM(sp.coords[ip][1], sp.coords[ip][0],
      sn.coords[iN][1], sn.coords[iN][0]);
    const toM = sp.cum[mejor.i] * 1000, fromM = sn.cum[mejor.j] * 1000;
    const min = PIECE_MIN_FACTOR * tolM();
    const lenP = Math.abs(toM - P.from_m), lenN = Math.abs(N.to_m - fromM);
    return {k, cur, best: mejor.d, gain: cur - mejor.d, toM, fromM,
      corto: lenP < min ? k : (lenN < min ? k + 1 : 0)};
  }

  function fitSig() {
    return pieces.map(p => `${p.track}:${Math.round(p.from_m)}:${Math.round(p.to_m)}`).join('|') +
      '#' + tolM() + '#' + srcs.map(x => x ? `${x.cum.length},${x.total}` : '-').join(';');
  }

  /* Un plan por separador (pieces.length-1), `null` donde no hay costura que
     ajustar: las uniones sin costura (mismo track, contiguos y en el mismo
     sentido) son justo las que el servidor encadena — misma regla que
     `seamGaps()`, que es la que decide qué gap le toca a cada separador. */
  function seamFits() {
    const sig = fitSig();
    if (fitCache.sig === sig) return fitCache.arr;
    const tol = tolM();
    const arr = [];
    for (let k = 1; k < pieces.length; k++) {
      const a = pieces[k - 1], b = pieces[k];
      const ra = a.to_m < a.from_m, rb = b.to_m < b.from_m;
      const sinCostura = a.track === b.track && ra === rb && Math.abs(a.to_m - b.from_m) <= tol;
      arr.push(sinCostura ? null : fitPlan(a, b, k));
    }
    fitCache = {sig, arr};
    return arr;
  }

  function fitBtn(k, f) {
    const dis = !f || f.gain < FIT_MIN_GAIN_M;
    return `<button class="un-seam-fit" type="button" data-k="${k}"` +
      ` title="${esc(dis ? FIT_TIP_OK : FIT_TIP)}"${dis ? ' disabled' : ''}>Ajustar</button>`;
  }

  /* Ajustar de verdad. Se repite la pasada sobre el estado ya recortado hasta
     que no mejore: con una sola, el punto de encuentro que está a más de la
     ventana (el caso real: la junta cae en el km 4,1 de un track de 9,5, o sea
     a 5,4 km del final) se quedaría a medio camino y habría que pulsar el botón
     varias veces. Cada pasada es local y reduce estrictamente la distancia de
     la costura, así que la cadena converge y no puede saltar a un cruce lejano
     de golpe — que es lo que la ventana existe para evitar. El tope es la red
     de seguridad, no el criterio de parada. */
  const FIT_MAX_PASSES = 12;

  function fitSeam(k) {
    const f0 = seamFits()[k - 1];
    if (!f0 || f0.gain < FIT_MIN_GAIN_M) return;
    /* Sobre copias: si la primera pasada ya deja un trozo demasiado corto no se
       toca nada y se avisa (el servidor lo rechazaría con un 400). */
    const oP = pieces[k - 1], oN = pieces[k];
    const P = Object.assign({}, oP), N = Object.assign({}, oN);
    let hecho = false;
    for (let it = 0; it < FIT_MAX_PASSES; it++) {
      const f = fitPlan(P, N, k, oP, oN);
      if (!f || f.gain < FIT_STEP_GAIN_M || f.corto) {
        if (f && f.corto && !hecho) {
          toast(`El ajuste dejaría el trozo ${f.corto} demasiado corto.`);
          return;
        }
        break;
      }
      P.to_m = f.toM; N.from_m = f.fromM; hecho = true;
    }
    if (!hecho) return;
    pieces[k - 1].to_m = P.to_m;
    pieces[k].from_m = N.from_m;
    afterPieces();
  }

  /* `report.gaps` NO lleva las costuras «sin costura»: dos trozos seguidos del
     MISMO track, contiguos y en el mismo sentido, el servidor los encadena y no
     publica junta ninguna (`seamless` en smart_merge). El cliente aplica la
     misma regla para saber qué gap le toca a cada separador — si no, un montaje
     con dos trozos seguidos de A desplazaría todos los avisos un sitio.
     Devuelve un array de pieces.length-1: el gap, o {seamless:true}. */
  function seamGaps() {
    const gs = (rep && rep.gaps) || [];
    const tol = tolM();
    const out = [];
    let j = 0;
    for (let k = 1; k < pieces.length; k++) {
      const a = pieces[k - 1], b = pieces[k];
      const ra = a.to_m < a.from_m, rb = b.to_m < b.from_m;
      if (a.track === b.track && ra === rb && Math.abs(a.to_m - b.from_m) <= tol) {
        out.push({seamless: true});
      } else {
        out.push(gs[j] || null);
        j++;
      }
    }
    return out;
  }

  /* El separador entre el trozo k y el k+1 (k desde 1 = «antes del trozo k»). */
  function seamInfo(k, real, gmap) {
    if (!rep) return {cls: '', txt: '·', tip: 'Todavía sin previsualizar.'};
    const g = gmap[k - 1];
    if (g && g.seamless) return {cls: 'ok', txt: '✓',
      tip: 'Los dos trozos son contiguos y del mismo track: no hay costura que arreglar.'};
    if (g && g.joined === false) return {cls: 'warn', txt: '⚠ ' + mgDist(g.gap_m),
      tip: `Hueco de ${mgDist(g.gap_m)} entre el trozo ${k} y el ${k + 1}: se deja como corte de segmento.`};
    const rp = real[k - 1], rn = real[k];
    const cut = ((rp && rp.trimmed_tail_m) || 0) + ((rn && rn.trimmed_head_m) || 0);
    if (cut >= 1) return {cls: 'cut', txt: '✂ ' + mgDist(cut),
      tip: `Se recortan ${mgDist(cut)} de solape entre el trozo ${k} y el ${k + 1}.`};
    return {cls: 'ok', txt: '✓', tip: (g && g.gap_m >= 1)
      ? `Costura cosida: el hueco de ${mgDist(g.gap_m)} se une en recta.`
      : 'Costura limpia: los dos trozos se tocan.'};
  }

  const TL_SPAN_PX = 520;       // ancho de referencia del reparto proporcional

  function renderTimeline() {
    const sub = q('#un-tl-sub');
    if (sub) sub.textContent = pieces.length
      ? `${pieces.length} trozo${pieces.length === 1 ? '' : 's'} · ${pieceLen(totalPieceM())}` : '';
    const box = q('#un-timeline');
    if (!box) return;
    if (!pieces.length) {
      box.innerHTML = '<div class="un-tl-none">Selecciona un tramo en un perfil y ' +
        'pulsa «＋ Añadir trozo».</div>';
      return;
    }
    const real = realPieces();
    const gmap = seamGaps();
    const fits = seamFits();
    const tot = totalPieceM() || 1;
    let html = '';
    pieces.forEach((p, k) => {
      if (k) {
        const s = seamInfo(k, real, gmap);
        html += `<div class="un-seam ${s.cls}">` +
          `<span class="un-seam-txt" title="${esc(s.tip)}">${esc(s.txt)}</span>` +
          (fits[k - 1] ? fitBtn(k, fits[k - 1]) : '') + '</div>';
      }
      const len = Math.abs(p.to_m - p.from_m);
      const w = Math.max(TL_MIN_PX, Math.round(len / tot * TL_SPAN_PX));
      const rev = p.to_m < p.from_m;
      html += `<div class="un-clip" data-k="${k}" style="width:${w}px;` +
        `background:${rgba(srcColor(p.track), .7)}" title="${esc(srcName(p.track))}">` +
        '<div class="un-clip-top">' +
        `<span class="un-clip-lbl">${mgLabel(p.track)} · ${fmt(p.from_m / 1000, 1)}→${fmt(p.to_m / 1000, 1)}</span>` +
        `<span class="un-clip-dir" title="${rev ? 'Invertido' : 'Sentido original'}">${rev ? '←' : '→'}</span>` +
        '</div><div class="un-clip-acts">' +
        actBtn(k, 'left', '◀', 'Mover a la izquierda', k === 0) +
        actBtn(k, 'rev', '↔', 'Invertir el sentido', false) +
        actBtn(k, 'right', '▶', 'Mover a la derecha', k === pieces.length - 1) +
        actBtn(k, 'del', '✕', 'Quitar el trozo', false) +
        `</div><div class="un-clip-len">${esc(pieceLen(len))}</div></div>`;
    });
    box.innerHTML = html;
    bindClips(box);
  }

  function totalPieceM() {
    return pieces.reduce((a, p) => a + Math.abs(p.to_m - p.from_m), 0);
  }

  /* La longitud de un trozo, con el mismo decimal que la etiqueta del rango del
     perfil («km 9,5 → 4,1 · 5,4 km»): con los dos decimales de mgDist, el clip
     decía 5,38 km de lo que el perfil llamaba 5,4. Por debajo del kilómetro sí
     manda mgDist, que ahí dice metros. */
  function pieceLen(m) {
    return m >= 1000 ? `${fmt(m / 1000, 1)} km` : mgDist(m);
  }

  function renderPiecesPanel() {
    const sub = q('#un-pieces-sub');
    if (sub) sub.textContent = pieces.length
      ? `${pieces.length} trozo${pieces.length === 1 ? '' : 's'}` : '';
    const box = q('#un-pieces-list');
    if (!box) return;
    if (!pieces.length) { box.innerHTML = `<div class="un-none">${esc(K.sinTrozos)}</div>`; return; }
    const real = realPieces();
    const gmap = seamGaps();
    const fits = seamFits();
    box.innerHTML = pieces.map((p, k) => {
      const rev = p.to_m < p.from_m, len = Math.abs(p.to_m - p.from_m);
      const rp = real[k];
      const rec = [];
      if (rp && (rp.trimmed_head_m || 0) >= 1) rec.push(`recortados ${mgDist(rp.trimmed_head_m)} al inicio`);
      if (rp && (rp.trimmed_tail_m || 0) >= 1) rec.push(`recortados ${mgDist(rp.trimmed_tail_m)} al final`);
      /* El mismo separador que la línea de tiempo, con su «Ajustar»: desde aquí
         también se puede arreglar la costura sin bajar a los clips. */
      const sep = k ? (() => {
        const s = seamInfo(k, real, gmap);
        return `<div class="un-pc-seam ${s.cls}">` +
          `<span class="un-seam-txt" title="${esc(s.tip)}">${esc(s.txt)}</span>` +
          (fits[k - 1] ? fitBtn(k, fits[k - 1]) : '') + '</div>';
      })() : '';
      return sep + `<div class="un-pc" data-k="${k}">` +
        `<span class="un-pc-t">${k + 1}. ${mgLabel(p.track)} km ` +
        `${fmt(p.from_m / 1000, 1)}→${fmt(p.to_m / 1000, 1)}` +
        (rev ? ' (invertido)' : '') + ` · ${esc(pieceLen(len))}` +
        `<em>${esc(srcName(p.track))}</em>` +
        (rec.length ? `<i>${esc(rec.join(' · '))}</i>` : '') + '</span>' +
        '<span class="un-pc-acts">' +
        actBtn(k, 'left', '◀', 'Mover arriba', k === 0) +
        actBtn(k, 'rev', '↔', 'Invertir el sentido', false) +
        actBtn(k, 'right', '▶', 'Mover abajo', k === pieces.length - 1) +
        actBtn(k, 'del', '✕', 'Quitar el trozo', false) +
        '</span></div>';
    }).join('');
    bindClips(box);
  }

  /* Los listeners van en los nodos que se acaban de crear (se recrean en cada
     repintado, así que no se acumulan), no en `document`. */
  function bindClips(box) {
    if (!box || !box.querySelectorAll) return;
    box.querySelectorAll('.un-clip,.un-pc').forEach(el => {
      const k = +el.dataset.k;
      el.addEventListener('mouseenter', () => setHiPiece(k));
      el.addEventListener('mouseleave', () => setHiPiece(null));
    });
    box.querySelectorAll('.un-pact').forEach(el => {
      el.addEventListener('click', ev => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        pieceAct(+el.dataset.k, el.dataset.act);
      });
    });
    box.querySelectorAll('.un-seam-fit').forEach(el => {
      el.addEventListener('click', ev => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        fitSeam(+el.dataset.k);
      });
    });
  }

  /* Señalar un clip lo ilumina en el mapa Y en su perfil fuente: es lo que
     explica de dónde sale cada trozo sin tener que leer los km. */
  function setHiPiece(k) {
    if (hiPiece === k) return;
    hiPiece = k;
    paintSelection();
    for (let i = 0; i < srcCharts.length; i++) if (srcCharts[i]) { try { srcCharts[i].render(); } catch (e) {} }
    ['#un-timeline', '#un-pieces-list'].forEach(id => {
      const box = q(id);
      if (!box || !box.querySelectorAll) return;
      box.querySelectorAll('.un-clip,.un-pc').forEach(el => {
        el.classList.toggle('hi', k != null && (+el.dataset.k) === k);
      });
    });
  }

  /* ── el conmutador de modo ─────────────────────────────────────────────── */
  function elevEmptyText() {
    const el = q('#un-elev-empty');
    if (!el) return;
    el.textContent = mode === 'montaje'
      ? (sels.length ? K.sinTrozos : K.eligeMontaje) : K.perfilVacio;
  }

  function applyModeUI() {
    const montaje = mode === 'montaje';
    const a = q('#un-mode-auto'), b = q('#un-mode-man');
    if (a) a.classList.toggle('on', !montaje);
    if (b) b.classList.toggle('on', montaje);
    const show = (id, on) => { const el = q(id); if (el) el.style.display = on ? '' : 'none'; };
    showSrcPanels();
    show('#un-tl-panel', montaje && sels.length > 0);
    show('#un-pieces-panel', montaje && sels.length > 0);
    /* En montaje, «Propuestas» e «Inicio y fin» no aplican: el orden y los
       extremos los pone el montaje, y el servidor los ignora. */
    if (montaje) {
      show('#un-props-panel', false);
      show('#un-ends', false);
      show('#un-back-props', false);
    }
    // «Invertir X» tampoco: cada trozo lleva su propio sentido.
    const revs = q('#un-revs');
    if (revs) revs.style.display = montaje ? 'none' : '';
    const sec = document.getElementById('sec-unir');
    if (sec) sec.classList.toggle('is-montaje', montaje);
    elevEmptyText();
    // La columna izquierda cambia de alto al aparecer o irse varios paneles.
    if (map && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { if (map) map.resize(); });
    }
  }

  /* Carga lo que falte de las entradas y deja los perfiles pintados. A ya
     está en `current`; las elegidas se piden al Store (que da geojson +
     elevation), como hace el detalle, y a la vez. Dos llamadas solapadas (el
     conmutador de modo y un cambio de selección) pueden pedir la misma: se
     guarda la primera que llegue (`!srcs[i]`), porque la segunda ya no
     llevaría el reescalado de `track_lengths_m` y los trozos se reescalarían
     dos veces. `selGen` descarta lo que era de otra selección. */
  async function ensureSources() {
    if (!srcs[0] && current) srcs[0] = buildSrc(current);
    const falta = [];
    sels.forEach((p, j) => { if (!srcs[j + 1]) falta.push([p, j + 1]); });
    if (falta.length) {
      const tok = _tok, gen = selGen;
      const got = await Promise.all(falta.map(([p]) =>
        Promise.resolve().then(() => K.load(p)).catch(() => null)));
      if (tok !== _tok || gen !== selGen) return;
      let fallo = false;
      got.forEach((d, k) => {
        const i = falta[k][1];
        if (!d) fallo = true;
        else if (!srcs[i]) srcs[i] = buildSrc(d);
      });
      if (fallo) toast(K.noCargadaB);
    }
    if (trackLens) applyTrackLens(trackLens);
    for (let i = 0; i < nIn(); i++) { renderSrcHead(i); drawSrcChart(i); renderSrcFoot(i); }
    applyModeUI();
    paintSources();
    paintSelection();
    /* Con las elegidas ya cargadas el mapa enseña todas las trazas y, además,
       acaban de aparecer sus paneles (la rejilla cambia otra vez): se
       reencuadra tras el resize. */
    if (mode === 'montaje') afterResize(fitCurrent);
  }

  function setMode(m) {
    m = (m === 'montaje') ? 'montaje' : 'auto';
    if (m === mode) return;
    mode = m;
    saveMode(m);
    hiPiece = null;
    if (prevTimer) { clearTimeout(prevTimer); prevTimer = null; }
    prevTok++;                       // lo que venga en vuelo es de otro modo
    refitNext = false;                // lo pone, si toca, la rama de automático
    applyModeUI();
    /* Cambiar de modo cambia la rejilla, así que el mapa cambia de tamaño: el
       encuadre hay que rehacerlo DESPUÉS del resize (afterResize), o se queda
       el de la caja anterior. Se hace ya con lo que se sabe, y otra vez cuando
       ensureSources() termine de traer las elegidas (que es cuando hay varias trazas). */
    if (montajeActivo()) {
      afterResize(fitCurrent);
      ensureSources().then(() => { if (mode === 'montaje') afterPieces(); });
      return;
    }
    if (mode === 'montaje') {        // todavía sin candidato: solo el perfil de A
      afterResize(fitCurrent);
      ensureSources();
      showEmpty(K.eligeMontaje);
      return;
    }
    // …de vuelta a automático: los trozos se guardan por si se vuelve.
    /* El informe se tira (se vuelve a pedir con las opciones de automático),
       pero su encuadre sigue siendo el bueno: se guarda antes de vaciarlo, o el
       reencuadre acabaría mirando solo a A. */
    const prevRep = rep;
    setSrcHover(null);               // el hover de fuente es solo de montaje
    destroySrcCharts();
    paintSources();
    paintSelection();
    /* El encuadre de aquí abajo es el de mientras tanto (con el informe viejo,
       que es el de otro ensamblaje): el definitivo lo pone la previsualización
       que viene, que trae el informe de automático y llega con la rejilla ya
       asentada. */
    if (sels.length && opts) { rep = null; refitNext = true; showSkeleton(); preview(); }
    else { clearMap(false); showEmpty(K.elige); }
    afterResize(() => { if (prevRep) fitReport(prevRep); else fitA(); });
  }

  function montajeActivo() { return mode === 'montaje' && sels.length > 0; }

  /* ── la lista de candidatos ───────────────────────────────────────────────
     Del Store, no de la red: funciona con la copia local y no repite una
     petición que el listado ya tiene hecha. Se ordenan por CERCANÍA a los
     extremos del track actual, que es lo que de verdad se busca al unir: los
     candidatos que enganchan salen arriba, y los que están a 200 km, abajo. */
  function endpointsA() {
    const c = trackA();
    if (!c.length) return [];
    return [c[0], c[c.length - 1]];
  }

  function distToA(r) {
    const ends = endpointsA();
    if (!ends.length || r.start_lat == null || r.start_lon == null) return Infinity;
    return Math.min(...ends.map(([lo, la]) => haversineM(la, lo, r.start_lat, r.start_lon)));
  }

  async function loadItems() {
    const list = q('#un-list');
    if (!list) return;
    let rows = [];
    try { rows = await K.list(); } catch (e) { rows = []; }
    items = rows.filter(r => r.public_id && r.public_id !== pid)
      .map(r => Object.assign({}, r, {_d: distToA(r)}))
      .sort((a, b) => a._d - b._d);
    renderList();
  }

  function itemMatches(r) {
    if (!search) return true;
    const s = search.toLowerCase();
    return String(r.name || '').toLowerCase().includes(s)
        || String(r.locality || '').toLowerCase().includes(s);
  }

  /* Una fila del popup. La casilla de la izquierda dice, si está marcada, qué
     LETRA tendrá esa entrada (B, C, D…) y va del color de su serie: es como se
     la va a reconocer luego en el mapa, la leyenda y los perfiles. Con el cupo
     lleno (MAX_INPUTS) las no marcadas salen deshabilitadas. */
  function itemRow(r) {
    const act = activityOf(r.activity_type);
    const km = fmt((r.distance_m || 0) / 1000, 1) + ' km';
    const dist = r._d === Infinity ? '' : mgDist(r._d);
    // iconSvg ya trae su círculo del color de la actividad (el catálogo es la
    // única fuente de verdad del color): aquí solo se le da tamaño.
    const chip = act ? `<span class="un-act" title="${esc(act.label)}">${iconSvg(act, 18)}</span>` : '';
    const k = pickDraft.indexOf(r.public_id);
    const on = k >= 0;
    const lleno = !on && pickDraft.length >= MAX_INPUTS - 1;
    const ck = on
      ? `<span class="un-row-ck" style="background:${srcColor(k + 1)}">${mgLabel(k + 1)}</span>`
      : '<span class="un-row-ck"></span>';
    return `<button class="un-row${on ? ' on' : ''}" data-pid="${esc(r.public_id)}"` +
      (lleno ? ` disabled title="Como mucho ${MAX_INPUTS} a la vez"` : '') + '>' + ck +
      `<span class="un-row-main"><span class="un-row-name">${chip}${esc(r.name || '(sin nombre)')}</span>` +
      `<span class="un-row-meta">${esc(km)}` +
      (r.locality ? ` · ${esc(r.locality)}` : '') + '</span></span>' +
      (dist ? `<span class="un-row-d">a ${esc(dist)}</span>` : '') + '</button>';
  }

  function renderList() {
    const list = q('#un-list');
    if (!list) return;
    const sub = q('#un-pick-sub');
    if (sub) sub.textContent = items.length
      ? `${items.length} disponible${items.length === 1 ? '' : 's'} · hasta ${MAX_INPUTS - 1}` : '';
    /* Sin nada con lo que unir, el popup lo dice y ofrece la única salida que
       tiene sentido: volver. Ese botón es de este caso y de ningún otro, y el
       buscador sobra (no hay nada que buscar). */
    const back = q('#un-pick-back');
    if (back) back.style.display = items.length ? 'none' : '';
    const sb = q('#un-search');
    if (sb) sb.style.display = items.length ? '' : 'none';
    renderPickOk();
    if (!items.length) { list.innerHTML = `<div class="un-none">${esc(K.sinOtras)}</div>`; return; }
    const vis = items.filter(itemMatches);
    if (!vis.length) { list.innerHTML = '<div class="un-none">Nada coincide con la búsqueda.</div>'; return; }
    const cerca = vis.filter(r => r._d <= NEAR_M);
    const lejos = vis.filter(r => r._d > NEAR_M);
    const grupo = (t, rs) => rs.length
      ? `<div class="un-group">${esc(t)}</div>` + rs.map(itemRow).join('') : '';
    list.innerHTML = grupo('Cercanos', cerca) + grupo('Todos', lejos);
    /* Los listeners van en las filas que se crean aquí —se recrean en cada
       repintado, así que no se acumulan— y no en `document`. Click = marcar o
       desmarcar; doble click = unir SOLO con esa (el atajo del caso de siempre,
       que antes era un click). */
    list.querySelectorAll('.un-row').forEach(el => {
      el.addEventListener('click', () => toggleDraft(el.dataset.pid));
      el.addEventListener('dblclick', () => { pickDraft = [el.dataset.pid]; applyPick(); });
    });
  }

  /* «Unir con N»: aplica la selección. Sin nada marcado no hay qué aplicar. */
  function renderPickOk() {
    const ok = q('#un-pick-ok');
    if (!ok) return;
    ok.style.display = items.length ? '' : 'none';
    ok.disabled = !pickDraft.length;
    ok.textContent = K.okN(pickDraft.length);
  }

  function toggleDraft(p) {
    if (!p) return;
    const k = pickDraft.indexOf(p);
    if (k >= 0) pickDraft.splice(k, 1);
    else if (pickDraft.length < MAX_INPUTS - 1) pickDraft.push(p);
    else { toast(`Como mucho se pueden unir ${MAX_INPUTS} a la vez.`); return; }
    /* Se repinta la lista entera (y no solo la fila): quitar una cambia la
       letra de todas las que van detrás, y llenar el cupo deshabilita el resto. */
    const list = q('#un-list');
    const top = list ? list.scrollTop : 0;
    renderList();
    if (list) list.scrollTop = top;
  }

  function searchChanged() {
    const el = q('#un-search');
    const v = el ? el.value : '';
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; search = v.trim(); renderList(); }, 180);
  }

  /* Cuántas entradas hay (A + las elegidas) y el nombre de la entrada i ≥ 1. */
  function nIn() { return 1 + sels.length; }
  function itemOf(p) { return items.find(x => x.public_id === p) || null; }
  function selName(i) {
    const r = itemOf(sels[i - 1]);
    return r ? (r.name || '') : '';
  }

  /* Aplicar la selección del popup: se previsualiza AL INSTANTE (no hay botón
     «Previsualizar»: el usuario ya ha dicho lo único que hacía falta).

     Cambiar la selección NO tira el montaje entero: los tracks que siguen
     conservan su perfil cargado y sus trozos (con el índice nuevo, porque
     quitar B convierte la C en B), y solo se pierden los trozos de los que se
     quitan. Lo que sí vuelve a cero es lo que depende del CONJUNTO: el informe,
     las propuestas, la orientación forzada y los extremos pedidos (sus índices
     ya no significan lo mismo). La tolerancia, el recorte y el hueco se
     conservan: son preferencias del usuario, no del conjunto. */
  function applyPick() {
    if (!Store.isOnline()) { toast(K.offline); return; }
    const next = pickDraft.filter(p => p && p !== pid).slice(0, MAX_INPUTS - 1);
    if (!next.length) return;
    closePick();
    if (next.length === sels.length && next.every((p, k) => p === sels[k]) && opts) return;
    setSelection(next);
  }

  function setSelection(next) {
    const prev = sels;
    // índice viejo → nuevo de cada entrada (0 = A siempre es 0)
    const remap = [0].concat(prev.map(p => { const k = next.indexOf(p); return k < 0 ? -1 : k + 1; }));
    const nsrcs = [srcs[0] || null], nsel = [selRange[0] || null];
    next.forEach((p, k) => {
      const old = prev.indexOf(p);
      nsrcs[k + 1] = old >= 0 ? (srcs[old + 1] || null) : null;
      nsel[k + 1] = old >= 0 ? (selRange[old + 1] || null) : null;
    });
    pieces = pieces.filter(p => remap[p.track] >= 0)
      .map(p => Object.assign({}, p, {track: remap[p.track]}));
    setSrcHover(null);
    destroySrcCharts();
    srcs = nsrcs; selRange = nsel; srcCharts = [];
    sels = next.slice();
    selGen++;
    hiPiece = null; trackLens = null;
    const base = opts || {trim: true, gap: 'auto', tol: 30};
    opts = {revManual: false, reverse: new Array(nIn()).fill(false), proposal: 0,
      trim: base.trim, gap: base.gap, tol: base.tol};
    rep = null; stats = null; fitted = false;
    resetProps();
    // Otras entradas = otros extremos posibles: los desplegables vuelven a
    // «Automático» (mantener «Inicio de C» apuntando a otra C no significa nada).
    resetEnds();
    clearElevation();
    const t = q('#un-trim'); if (t) t.checked = !!opts.trim;
    const tol = q('#un-tol'); if (tol) tol.value = opts.tol;
    setGapUI();
    renderToggles();
    renderEnds();
    syncName();
    renderPickChip();
    paintSources();
    if (mode === 'montaje') {
      ensureSources().then(() => { if (mode === 'montaje') afterPieces(); });
      return;
    }
    preview();                    // sin debounce: es la primera y la pide el click
  }

  /* ── el popup «con qué unir» ──────────────────────────────────────────────
     Elegir con qué unir se hace UNA vez y luego estorba. Al principio era un
     panel fijo de la columna (plegado a una fila con `.is-picked` en cuanto
     había candidato) y, en modo Montaje, una celda entera de la rejilla; ahora
     es un popup y en la cabecera solo queda el chip de lo elegido.

     Es de selección MÚLTIPLE: se trabaja sobre un borrador (`pickDraft`, copia
     de `sels` al abrir) y solo «Unir con N» lo aplica. Se cierra sin aplicar
     con ✕, «Cancelar», un click en el velo y Escape (ese listener se registra
     una sola vez al cargar este archivo, al final). */
  function openPick() {
    if (!Store.isOnline()) { toast(K.offline); return; }
    const ov = q('#un-pick-modal');
    if (!ov) return;
    pickDraft = sels.slice();
    ov.classList.remove('hidden');
    pickOpen = true;
    renderList();               // repinta con las filas elegidas marcadas
    const s = q('#un-search');
    if (s) { try { s.focus(); s.select(); } catch (e) {} }
  }

  function closePick() {
    const ov = q('#un-pick-modal');
    if (ov) ov.classList.add('hidden');
    pickOpen = false;
  }

  /* Click en el VELO, no en la caja: el popup ocupa la pantalla entera, así que
     hay que distinguir uno de otro (`e.target` es el overlay solo si el click
     cayó fuera de `.un-modal`). */
  function veilClick(e) { if (e && e.target && e.target.id === 'un-pick-modal') closePick(); }

  /* Sin nada con lo que unir, el popup no ofrece ninguna salida útil: se vuelve
     a la ficha de lo que se estaba uniendo (o al listado, si aún no ha cargado). */
  function backFromPick() {
    closePick();
    go(pid ? K.detailUrl(pid) : K.listUrl);
  }

  /* El chip de la cabecera: «Con: <nombre> · 11,4 km · a 2,98 km» con una sola
     elegida, y «Con: B + C (3) · 31,2 km» con varias (los km son la suma, el
     `title` los nombra todos). Sin candidato dice «Sin elegir» y el botón pasa
     a ámbar («Elegir con qué unir»), que es lo único que queda por hacer. Sin
     conexión el botón se deshabilita: la unión la calcula el servidor y el
     aviso #un-offline ya lo explica. */
  function renderPickChip() {
    const chip = q('#un-pick-chip'), btn = q('#un-change');
    const rs = sels.map(itemOf).filter(Boolean);
    if (chip) {
      if (rs.length === 1) {
        const r = rs[0];
        const km = fmt((r.distance_m || 0) / 1000, 1) + ' km';
        const dist = (r._d == null || r._d === Infinity) ? '' : ' · a ' + mgDist(r._d);
        const nom = r.name || '(sin nombre)';
        chip.innerHTML = `Con: ${esc(nom)} <span class="un-pick-km">· ${esc(km)}</span>${esc(dist)}`;
        chip.title = `Con: ${nom} · ${km}${dist}`;
        chip.classList.add('on');
      } else if (rs.length > 1) {
        const tot = rs.reduce((a, r) => a + (r.distance_m || 0), 0);
        const km = fmt(tot / 1000, 1) + ' km';
        const noms = rs.map(r => r.name || '(sin nombre)');
        chip.innerHTML = `Con: ${esc(noms.join(' + '))} (${rs.length}) ` +
          `<span class="un-pick-km">· ${esc(km)}</span>`;
        chip.title = 'Con: ' + noms.map((n, k) => `${mgLabel(k + 1)} · ${n}`).join(', ');
        chip.classList.add('on');
      } else {
        chip.textContent = 'Sin elegir';
        chip.title = '';
        chip.classList.remove('on');
      }
    }
    if (btn) {
      btn.textContent = sels.length ? 'Cambiar' : 'Elegir con qué unir';
      btn.classList.toggle('need', !sels.length);
      btn.disabled = !Store.isOnline();
    }
    // «Cancelar» solo con candidato: sin uno, cancelar no deja nada en pantalla.
    const cancel = q('#un-pick-cancel');
    if (cancel) cancel.style.display = sels.length ? '' : 'none';
  }

  /* Se mantiene el nombre viejo («Cambiar» del panel de antes) porque es el que
     conocen el markup y la documentación: hoy no pliega nada, abre el popup. */
  function changePick() { openPick(); }

  function syncName() {
    const el = q('#un-name');
    if (el) el.value = [(current && current.name) || '']
      .concat(sels.map((_, k) => selName(k + 1))).join(' + ');
  }

  /* ── opciones (lo que viaja en `options`) ─────────────────────────────── */
  function body(preview_) {
    if (!sels.length || !pid) return null;
    const nameEl = q('#un-name');
    const o = {
      trim: !!opts.trim,
      join_gap: opts.gap === 'auto' ? null : (opts.gap === 'join'),
      tol_m: tolM(),
    };
    if (mode === 'montaje') {
      /* Con `pieces` el servidor ignora proposal/start/end/reverse (y lo avisa
         en `warnings`): no se mandan siquiera. El montaje ya lo dice todo, el
         sentido incluido — va en el orden de from_m/to_m. */
      if (!pieces.length) return null;
      o.pieces = pieces.map(p => ({track: p.track, from_m: p.from_m, to_m: p.to_m}));
    } else {
      // null = automático; con toggles tocados, la orientación la manda el usuario
      o.reverse = opts.revManual ? opts.reverse.slice() : null;
      /* Cuál de los ensamblajes de `proposals[]` se quiere. Con `reverse`
         explícita el servidor solo ofrece la 0, así que ahí va siempre 0. */
      o.proposal = opts.revManual ? 0 : (opts.proposal | 0);
      /* Extremos forzados: null = automático (el servidor los decide con la
         geometría). El formato es '<i><e>', ver el comentario de `ends`. */
      o.start = ends.start || null;
      o.end = ends.end || null;
    }
    const b = {ids: [pid].concat(sels), name: nameEl ? nameEl.value.trim() : '', options: o};
    if (preview_) b.preview = true;
    return b;
  }

  /* Deja el bloque de propuestas como si no hubiera habido ninguna. Vacía el
     contenedor (y con él los mouseenter/leave de sus tarjetas, que viven en los
     nodos y se van con ellos). */
  function resetProps() {
    props = []; hadProps = false; partial = [];
    const box = q('#un-proposals'); if (box) box.innerHTML = '';
    const pcs = q('#un-pieces'); if (pcs) pcs.innerHTML = '';
    const back = q('#un-back-props'); if (back) back.style.display = 'none';
    const panel = q('#un-props-panel'); if (panel) panel.style.display = 'none';
    hoverClear();
  }

  /* Qué orientación lleva cada ENTRADA de `ids` (0 = A, la que se está uniendo;
     1… = las elegidas).
     Sale de `proposals[proposal].reversed_inputs`, que es lo único del informe
     que va por entrada: `order`/`reversed` van por PIEZA ensamblada y con una
     junta interior pueden repetir un índice o dejarse uno fuera.
     `null` = esa entrada se usa por trozos ⇒ el toggle se muestra «parcial» y
     deshabilitado (invertirla entera no significa nada). */
  function revFromReport(r) {
    const pr = (r.proposals || [])[r.proposal | 0];
    const ri = pr && pr.reversed_inputs;
    const n = nIn();
    if (Array.isArray(ri)) {
      partial = Array.from({length: n}, (_, i) => ri[i] == null);
      return Array.from({length: n}, (_, i) => ri[i] === true);
    }
    partial = new Array(n).fill(false);
    const out = new Array(n).fill(false);
    (r.order || []).forEach((ei, k) => { if (ei >= 0 && ei < n) out[ei] = !!(r.reversed || [])[k]; });
    return out;
  }

  function toggleRev(i) {
    if (!opts) return;
    if (partial[i]) { toast(K.parcialTip); return; }
    opts.revManual = true;
    // Con `reverse` explícita el servidor deja una sola propuesta: la 0.
    opts.proposal = 0;
    opts.reverse[i] = !opts.reverse[i];
    hoverClear();
    renderToggles();
    schedule();
  }

  /* Deshacer el «Invertir X»: vuelve a la orientación automática y, con ella,
     a la lista de propuestas (el servidor solo las enumera si nadie fuerza la
     orientación). El botón solo está a la vista si antes hubo más de una. */
  function backToProposals() {
    if (!opts) return;
    opts.revManual = false;
    opts.reverse = new Array(nIn()).fill(false);
    opts.proposal = 0;
    partial = [];
    hoverClear();
    renderToggles();
    schedule();
  }

  /* Elegir una propuesta: se marca al instante (la previsualización tarda) y se
     relanza con el mismo debounce y el mismo token que el resto de controles. */
  function pickProposal(k) {
    if (!opts) return;
    k = k | 0;
    opts.proposal = k;
    hoverClear();
    markPicked(k);
    schedule();
  }

  function setGap(v) {
    if (!opts) return;
    opts.gap = v;
    setGapUI();
    schedule();
  }
  function setGapUI() {
    const g = opts ? opts.gap : 'auto';
    [['#un-gap-auto', 'auto'], ['#un-gap-join', 'join'], ['#un-gap-cut', 'cut']].forEach(([id, v]) => {
      const el = q(id);
      if (el) el.classList.toggle('on', g === v);
    });
  }

  /* ── inicio y fin ─────────────────────────────────────────────────────────
     Dos extremos posibles por entrada y dos desplegables. Los nombres salen de
     `report.endpoints` en cuanto hay informe —es lo que el servidor dice que
     son las entradas— y, mientras tanto, del Store. */
  function endKeys() {
    const out = [];
    for (let i = 0; i < nIn(); i++) out.push(i + 's', i + 'e');
    return out;
  }

  function corta(s) {
    s = String(s || '');
    return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
  }

  /* Nombre de cada entrada: del informe si ya lo hay, y si no del Store. */
  function inputName(i) {
    const eps = (rep && rep.endpoints) || [];
    const ep = eps.find(x => x && x.track === i);
    if (ep && ep.name) return ep.name;
    const t = ((rep && rep.tracks) || []).find(x => x.idx === i);
    if (t && t.name) return t.name;
    if (i === 0) return (current && current.name) || K.estaEl;
    return selName(i) || K.laOtra;
  }

  function endLabel(key) {
    const i = parseInt(key, 10) || 0;
    return (key[key.length - 1] === 's' ? 'Inicio de ' : 'Fin de ') + inputName(i);
  }

  /* Rellena los dos desplegables conservando lo elegido. Se llama al elegir
     candidato y tras cada previsualización (los nombres pueden mejorar cuando
     llega `report.endpoints`). */
  function renderEnds() {
    const panel = q('#un-ends');
    // En montaje los extremos los pone el propio montaje: el panel no aplica.
    if (panel) panel.style.display = (sels.length && mode !== 'montaje') ? '' : 'none';
    if (!sels.length || mode === 'montaje') return;
    const html = '<option value="">Automático</option>' + endKeys().map(k => {
      const full = endLabel(k);
      return `<option value="${k}" title="${esc(full)}">${esc(corta(full))}</option>`;
    }).join('');
    [['#un-start', 'start'], ['#un-end', 'end']].forEach(([id, campo]) => {
      const el = q(id);
      if (!el) return;
      el.innerHTML = html;
      el.value = ends[campo] || '';
    });
    renderEndsState();
  }

  /* Ámbar en los desplegables por dos motivos distintos, y los dos significan lo
     mismo para el usuario: lo que se ve en el mapa NO es lo que dicen estos
     controles. (a) ha pedido el mismo extremo en los dos, así que no se manda
     nada; (b) el servidor no ha podido cumplirlo (`endpoints_applied:false`) y
     ha caído a las propuestas de siempre, con su aviso en `#un-warns`. */
  function renderEndsState() {
    const noAplicado = !!(rep && (ends.start || ends.end) && rep.endpoints_applied === false);
    [['#un-start', 'start'], ['#un-end', 'end']].forEach(([id, campo]) => {
      const el = q(id);
      if (!el) return;
      el.classList.toggle('mg-warn', endsBad === campo || noAplicado);
    });
    const err = q('#un-ends-err');
    if (err) err.textContent = endsBad
      ? 'Inicio y fin no pueden ser el mismo extremo.' : '';
    const sub = q('#un-ends-sub');
    if (sub) sub.textContent = (ends.start || ends.end) ? 'forzado' : 'automático';
  }

  function resetEnds() {
    ends = {start: '', end: ''};
    endsBad = '';
    ['#un-start', '#un-end'].forEach(id => { const el = q(id); if (el) el.value = ''; });
  }

  function endsChanged(campo) {
    if (!opts) return;
    const sEl = q('#un-start'), eEl = q('#un-end');
    const s = sEl ? sEl.value : '', e = eEl ? eEl.value : '';
    /* El mismo extremo en los dos es un 400 seguro: no se manda nada y se marca
       el desplegable que acaba de tocar, que es el que puede arreglarlo. */
    if (s && e && s === e) {
      endsBad = campo === 'end' ? 'end' : 'start';
      renderEndsState();
      return;
    }
    endsBad = '';
    ends = {start: s, end: e};
    /* Forzar los extremos cambia qué ensamblajes existen, así que la propuesta
       elegida ya no es «la misma» (mismo motivo que la tolerancia). */
    opts.proposal = 0;
    renderEndsState();
    schedule();
  }

  function optsChanged() {
    if (!opts) return;
    const t = q('#un-trim');
    opts.trim = t ? t.checked : true;
    const tolEl = q('#un-tol');
    const tol = tolEl ? tolEl.value : opts.tol;
    /* La tolerancia decide POR DÓNDE se parten los tracks, así que cambiarla
       enumera otras propuestas: la elegida ya no es «la misma» (y podría ni
       existir). El recorte del solape, en cambio, se aplica después: ese no las
       toca y conserva la elección. */
    if (String(tol) !== String(opts.tol)) opts.proposal = 0;
    opts.tol = tol;
    schedule();
  }

  function schedule() {
    if (prevTimer) clearTimeout(prevTimer);
    prevTimer = setTimeout(() => { prevTimer = null; preview(); }, 250);
  }

  /* ── previsualizar ─────────────────────────────────────────────────────── */
  function busy(on) {
    const p = q('#un-result-sub');
    if (p) p.textContent = on ? 'Calculando…' : '';
    const sec = document.getElementById('sec-unir');
    if (sec) sec.classList.toggle('is-loading', !!on);
  }

  async function preview() {
    if (!opts) return;
    if (!Store.isOnline()) { toast(K.offline); return; }
    /* Inicio y fin iguales: el servidor lo rechaza con un 400, así que ni se
       pide. El aviso ya está a la vista en el bloque «Inicio y fin». */
    if (endsBad && mode !== 'montaje') { busy(false); return; }
    // En montaje, sin trozos no hay nada que unir: no se gasta la petición.
    if (mode === 'montaje' && !pieces.length) { busy(false); showEmpty(K.sinTrozos); return; }
    if (prevTimer) { clearTimeout(prevTimer); prevTimer = null; }
    const b = body(true);
    if (!b) return;
    const tok = ++prevTok, mtok = _tok;
    busy(true);
    showSkeleton();
    let res = null, d = {};
    try {
      res = await fetch(K.mergeApi, {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(b)});
      d = await res.json().catch(() => ({}));
    } catch (e) {
      if (tok === prevTok && mtok === _tok) { busy(false); showEmpty(K.elige);
        toast('Error de red al previsualizar la unión'); }
      return;
    }
    if (tok !== prevTok || mtok !== _tok) return;   // respuesta vieja: otra opción ya la pisó
    busy(false);
    if (!res.ok) {
      /* Red de seguridad: si la propuesta elegida ya no existe (la tolerancia
         cambió antes de que llegara esta respuesta), se vuelve a la recomendada
         en vez de dejar el panel con un error que el usuario no puede deshacer. */
      if (opts.proposal && !opts.revManual) {
        opts.proposal = 0;
        toast('Esa propuesta ya no existe: se vuelve a la recomendada');
        preview();
        return;
      }
      showEmpty(d.error || 'No se pudo previsualizar la unión');
      toast(d.error || 'No se pudo previsualizar la unión');
      return;
    }
    rep = d.report || {}; stats = d.stats || {};
    // Perfil del resultado: la serie la manda la previsualización (≤500 puntos).
    resElev = Array.isArray(d.elevation) ? d.elevation : [];
    props = Array.isArray(rep.proposals) ? rep.proposals : [];
    /* La longitud real de cada entrada según el servidor manda sobre el último
       `d` de la serie ligera: si mueve algo, los perfiles fuente se rehacen. */
    if (applyTrackLens(rep.track_lengths_m) && mode === 'montaje') {
      // El eje, el título («… · 9,5 km») y la etiqueta del rango hablan de la
      // misma escala que los `from_m`: se rehacen los tres.
      for (let i = 0; i < nIn(); i++) { drawSrcChart(i); renderSrcHead(i); renderSrcFoot(i); }
    }
    if (mode === 'montaje') {
      /* En montaje la única «propuesta» es el montaje mismo (el servidor la
         devuelve como la 0, con las piezas ya recortadas): ni toggles ni
         alternativas que elegir. `hadProps` no se toca, para que al volver a
         automático se recuerde si las había. */
      partial = [];
    } else if (opts.revManual) {
      // La orientación la manda el usuario; y sin partir nada, nada es parcial.
      partial = [];
    } else {
      /* Solo el modo automático dice si HAY alternativas: con `reverse` forzada
         el servidor devuelve una sola y no querríamos olvidar que las había. */
      hadProps = props.length > 1;
      opts.reverse = revFromReport(rep);
      opts.proposal = rep.proposal | 0;
    }
    /* El perfil y la traza del resultado se rehacen juntos: `resCum` es lo que
       traduce la «d» de la serie a un punto del mapa, así que tiene que salir
       de ESTE informe (buildResult() lee `resElev` para escalarse a su total). */
    buildResult(rep);
    hoverD = null;
    drawElevation();
    renderEnds();
    renderTune();
    paintReport(rep);
    if (!fitted) { fitted = true; fitReport(rep); }
    else if (refitNext) {
      /* Tras el resize: el panel de resultado acaba de pasar del shimmer a sus
         cuatro cifras y la rejilla (con ella, el alto del mapa) todavía está
         cambiando en este mismo tick. */
      refitNext = false;
      const r = rep;
      afterResize(() => fitReport(r));
    }
  }

  /* ── el informe, en el panel ───────────────────────────────────────────── */
  /* A, B, C…: la letra de cada entrada (la de `_letter` en core/editing.py, que
     es la que usan las etiquetas de las propuestas). */
  const mgLabel = ei => String.fromCharCode(65 + (ei | 0));
  /* Metros, o kilómetros cuando son tantos que «253.234 m» no se lee (unir dos
     rutas de valles distintos deja huecos de cientos de km). */
  function mgDist(m) {
    m = Math.round((m || 0) * 10) / 10;
    return m >= 1000 ? `${fmt(m / 1000, 2)} km` : `${fmt(m, m < 100 ? 1 : 0)} m`;
  }

  /* Un toggle «↔ Invertir X» por entrada, pintados aquí (cuántos hay depende de
     cuántas se unen). Con muchas el texto se acorta a «↔ X», que es lo que cabe
     en la columna de 380 px; el `title` lo dice entero. */
  function renderToggles() {
    const box = q('#un-revs');
    if (!box) return;
    const n = nIn();
    const rv = opts ? opts.reverse : [];
    const corto = n > 3;
    box.innerHTML = Array.from({length: n}, (_, i) => {
      const part = !!partial[i];
      const L = mgLabel(i);
      const txt = part ? `↔ ${L}: parcial` : (corto ? `↔ ${L}` : `↔ Invertir ${L}`);
      const tit = part ? K.parcialTip : `Invertir ${L} · ${inputName(i)}`;
      return `<button class="mg-tgl${part ? ' partial' : (rv[i] ? ' on' : '')}" type="button"` +
        ` title="${esc(tit)}"${part ? ' disabled' : ''}` +
        ` onclick="SEC.unir.toggleRev(${i})">${esc(txt)}</button>`;
    }).join('');
  }

  function chips(p) {
    const c = [];
    c.push(`<span class="mg-chip km">${esc(mgDist(p.distance_m))}</span>`);
    if (p.closed_loop) c.push('<span class="mg-chip loop">circular</span>');
    c.push((p.repeated_m || 0) >= 1
      ? `<span class="mg-chip rep">repite ${esc(mgDist(p.repeated_m))}</span>`
      : '<span class="mg-chip norep">sin repeticiones</span>');
    // El hueco solo importa si NO se une en recta: por debajo del umbral se
    // cose solo y no se nota. (MG_GAP_JOIN_M = `gap_join_m` de smart_merge.)
    if ((p.gap_m || 0) > MG_GAP_JOIN_M)
      c.push(`<span class="mg-chip">hueco ${esc(mgDist(p.gap_m))}</span>`);
    const n = p.n_pieces || 0;
    if (n) c.push(`<span class="mg-chip">${n} pieza${n === 1 ? '' : 's'}</span>`);
    return c.join('');
  }

  function markPicked(k) {
    const box = q('#un-proposals');
    if (!box) return;
    box.querySelectorAll('.mg-prop').forEach(el => {
      const on = (+el.dataset.k) === k;
      el.classList.toggle('on', on);
      const r = el.querySelector('input');
      if (r) r.checked = on;
    });
  }

  /* Solo se pintan si hay MÁS DE UNA: con una sola (el caso normal, sin junta
     interior) el panel entero se esconde. */
  function renderProposals() {
    const box = q('#un-proposals');
    const back = q('#un-back-props');
    const panel = q('#un-props-panel');
    if (!box) return;
    const manual = !!(opts && opts.revManual);
    // Forzar la orientación deja una sola propuesta: se esconden y se ofrece volver.
    const volver = manual && hadProps;
    if (back) back.style.display = volver ? '' : 'none';
    if (manual || props.length < 2) {
      box.innerHTML = '';
      if (panel) panel.style.display = volver ? '' : 'none';
      hoverClear();
      return;
    }
    if (panel) panel.style.display = '';
    const sel = opts ? (opts.proposal | 0) : 0;
    box.innerHTML = props.map((p, k) =>
      `<label class="mg-prop${k === sel ? ' on' : ''}" data-k="${k}">` +
      `<input type="radio" name="un-prop"${k === sel ? ' checked' : ''}>` +
      '<span class="mg-prop-main">' +
      `<span class="mg-prop-lbl">${esc(p.label || ('Propuesta ' + (k + 1)))}` +
      (k === 0 ? '<span class="mg-prop-best">recomendada</span>' : '') + '</span>' +
      `<span class="mg-chips">${chips(p)}</span></span></label>`).join('');
    box.querySelectorAll('.mg-prop').forEach(el => {
      const k = +el.dataset.k;
      el.addEventListener('click', () => pickProposal(k));
      // …y el `change` del radio, que es lo que dispara moverse con las flechas
      // del teclado (ahí no hay click que escuchar).
      const r = el.querySelector('input');
      if (r) r.addEventListener('change', () => pickProposal(k));
      el.addEventListener('mouseenter', () => hoverProposal(k));
      el.addEventListener('mouseleave', () => hoverClear());
    });
  }

  /* Las PIEZAS de la propuesta elegida: con una junta interior la leyenda de colores
     puede mentir («A» es media A), así que se dicen en orden y con sus km. */
  function renderPieces() {
    const box = q('#un-pieces');
    if (!box) return;
    const p = props[(opts ? opts.proposal | 0 : 0)] || props[0];
    const pcs = (p && p.pieces) || [];
    const ri = (p && p.reversed_inputs) || [];
    const partido = ri.some(v => v == null) || pcs.length !== ri.length;
    if (!pcs.length || !partido) { box.innerHTML = ''; return; }
    const cnt = {};
    pcs.forEach(x => { cnt[x.track] = (cnt[x.track] || 0) + 1; });
    const km = m => fmt((m || 0) / 1000, 1);
    const txt = pcs.map((x, i) => {
      const entera = cnt[x.track] === 1 && ri[x.track] != null;
      const det = (entera ? K.entera : `km ${km(x.from_m)}→${km(x.to_m)}`) +
                  (x.reversed ? ', ' + K.invertidaN : '');
      return `${i + 1}. ${esc(x.name || mgLabel(x.track))} (${esc(det)})`;
    }).join(' · ');
    box.innerHTML = `<span class="t">Piezas de la propuesta elegida</span>${txt}`;
  }

  function renderTune() {
    const r = rep || {}, s = stats || {};
    if (mode === 'montaje') {
      /* En montaje no hay propuestas que elegir ni orientación entera que
         invertir: lo que se repinta es la línea de tiempo (con el estado de
         cada costura, que sale de ESTE informe) y su panel de texto. */
      renderTimeline();
      renderPiecesPanel();
      applyModeUI();
    } else {
      renderProposals();
      renderPieces();
      renderToggles();
    }
    const tune = q('#un-tune');
    if (tune) tune.style.display = '';
    // leyenda: qué color es cada una en el mapa (los nombres, del informe)
    const nm = i => {
      const t = (r.tracks || []).find(x => x.idx === i);
      if (t && t.name) return t.name;
      if (i === 0) return (current && current.name) || K.estaEl;
      return selName(i) || K.laOtra;
    };
    /* «(esta ruta)» siempre en A; «(la otra ruta)» solo cuando son dos — con
       más, «la otra» ya no dice cuál. */
    const cual = i => i === 0 ? K.estaEl : (nIn() === 2 ? K.laOtra : '');
    const leg = q('#un-legend');
    if (leg) leg.innerHTML = Array.from({length: nIn()}, (_, i) =>
      `<div class="mg-leg"><b style="background:${srcColor(i)}"></b>` +
      `<span>${mgLabel(i)} · ${esc(nm(i))}${cual(i) ? ' (' + esc(cual(i)) + ')' : ''}</span></div>`).join('');
    // recortes, por entrada (los del informe ya son metros)
    const rec = (r.tracks || []).map(t => [t.idx, (t.trimmed_head_m || 0) + (t.trimmed_tail_m || 0)])
      .filter(([, m]) => m >= 1).map(([i, m]) => `${mgDist(m)} de ${mgLabel(i)}`);
    if ((r.closed_trim_m || 0) >= 1) rec.push(`${mgDist(r.closed_trim_m)} del cierre`);
    const ti = q('#un-trim-info');
    if (ti) ti.textContent = rec.length ? ('Se recortan ' + rec.join(' · ')) : 'No hay solape que recortar.';
    // hueco
    const g = (r.gaps && r.gaps.length) ? r.gaps[0] : null;
    const gl = q('#un-gap-lbl');
    if (gl) gl.textContent = g
      ? `Hueco: ${mgDist(g.gap_m)}${g.joined ? ' (unido en recta)' : ' (corte de segmento)'}`
      : 'Hueco: —';
    setGapUI();
    // resultado: las cuatro cifras grandes, como la banda del detalle
    const st = q('#un-stats');
    if (st) st.innerHTML = [
      ['Distancia', `${fmt((s.distance_m || 0) / 1000, 2)} <small>km</small>`, true],
      ['Desnivel +', `${fmt(s.ascent_m || 0)} <small>m</small>`, false],
      ['Desnivel −', `${fmt(s.descent_m || 0)} <small>m</small>`, false],
      ['Puntos GPS', fmt(s.n_points || 0), false],
    ].map(([l, v, acc]) =>
      `<div class="stat${acc ? ' acc' : ''}"><div class="l">${esc(l)}</div><div class="v">${v}</div></div>`).join('');
    // resumen
    const orden = (r.tracks || []).map(t => mgLabel(t.idx) + (t.reversed ? ' ↔' : '')).join(' → ');
    const li = [];
    if (r.manual || mode === 'montaje') {
      const n = (r.proposals && r.proposals[0] && r.proposals[0].pieces || pieces).length;
      li.push(`Montaje de ${n} trozo${n === 1 ? '' : 's'}.`);
    }
    if (orden) li.push(`Orden: ${esc(orden)}`);
    if (r.closed_loop) li.push('Cierra circuito.');
    if (timeLoss(r)) li.push('Se descartan las marcas de tiempo.');
    const sum = q('#un-summary');
    if (sum) sum.innerHTML = li.map(t => `<div class="mg-line">${t}</div>`).join('');
    const w = q('#un-warns');
    if (w) w.innerHTML = (r.warnings || []).map(x => `<div>⚠ ${esc(x)}</div>`).join('');
    showResult();
  }

  /* ¿se PIERDEN marcas de tiempo? `times_kept:false` también sale cuando no
     había ninguna (un plan casi nunca las trae), y anunciar ahí que «se
     descartan los tiempos» es ruido. smart_merge avisa siempre que se pierda
     algo de verdad (solape de rangos o track invertido), así que el aviso es
     la señal buena. Devuelve el motivo o ''. */
  function timeLoss(r) {
    if (!r || r.times_kept !== false) return '';
    const w = (r.warnings || []).filter(x => x.indexOf('marcas de tiempo') >= 0);
    if (!w.length) return '';
    return w.some(x => x.indexOf('solapan') >= 0)
      ? 'tiempos descartados: se solapaban' : 'tiempos descartados';
  }

  /* Resumen del informe en UNA línea, para el toast de «Crear». Solo usa campos
     que trae también el informe SIN trazas (merge_report_lean). */
  function reportLine(r) {
    if (!r) return '';
    const p = [];
    // El montaje manual se dice primero: es lo que explica el resultado entero.
    if (r.manual || mode === 'montaje') {
      const n = (r.proposals && r.proposals[0] && r.proposals[0].pieces || pieces).length;
      p.push(`montaje de ${n} trozo${n === 1 ? '' : 's'}`);
    }
    /* La propuesta elegida, por su etiqueta, cuando había varias: es lo que
       explica por qué el resultado es ese y no otro. */
    const ps = r.proposals || [];
    const pr = ps[r.proposal | 0];
    const conLabel = ps.length > 1 && pr && pr.label;
    if (conLabel) p.push(pr.label);
    /* La etiqueta de la propuesta ya dice qué va invertido, y con piezas
       `order`/`reversed` van por PIEZA (podrían repetir «A y A»): solo se
       resume así cuando no hay etiqueta que lo cuente. */
    if (!conLabel) {
      const rv = (r.order || []).filter((ei, k) => (r.reversed || [])[k]).map(mgLabel);
      if (rv.length) p.push(rv.join(' y ') + ' ' + (rv.length > 1 ? K.invertidasN : K.invertidaN));
    }
    const tr = (r.trimmed_m || []).reduce((a, b) => a + (b || 0), 0) + (r.closed_trim_m || 0);
    if (tr >= 1) p.push(`${mgDist(tr)} duplicados recortados`);
    if ((r.repeated_m || 0) >= 1) p.push(`repite ${mgDist(r.repeated_m)}`);
    (r.gaps || []).forEach(g => {
      if (g.gap_m >= 1 || !g.joined)
        p.push(`hueco de ${mgDist(g.gap_m)} ${g.joined ? 'unido' : 'dejado como corte'}`);
    });
    if (r.closed_loop) p.push('circuito cerrado');
    /* Extremos forzados: solo se cuentan si el servidor los pudo cumplir
       (`endpoints_applied`), o el resumen diría algo que no pasó. */
    if ((ends.start || ends.end) && r.endpoints_applied !== false) {
      const de = ends.start ? endLabel(ends.start).toLowerCase() : null;
      const a = ends.end ? endLabel(ends.end).toLowerCase() : null;
      if (de && a) p.push(`desde ${de} hasta ${a}`);
      else if (de) p.push(`desde ${de}`);
      else if (a) p.push(`hasta ${a}`);
    }
    const t = timeLoss(r);
    if (t) p.push(t);
    return p.join(' · ');
  }

  /* ── crear ─────────────────────────────────────────────────────────────── */
  async function doMerge() {
    if (!opts || creating) return;
    if (!Store.isOnline()) { toast(K.offline); return; }
    if (!rep) { preview(); return; }   // sin informe no hay nada que crear
    const b = body(false);
    if (!b) return;
    const btn = q('#un-create');
    creating = true;
    if (btn) { btn.disabled = true; btn.textContent = K.creando; }
    let res, d = {};
    try {
      res = await fetch(K.mergeApi, {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(b)});
      d = await res.json().catch(() => ({}));
    } catch (e) {
      creating = false;
      if (btn) { btn.disabled = false; btn.textContent = K.crear; }
      toast('Error de red al unir');
      return;
    }
    creating = false;
    if (btn) { btn.disabled = false; btn.textContent = K.crear; }
    if (!res.ok) { toast(d.error || 'Error al unir'); return; }
    Store.syncNow({force: true});   // el servidor cambió: pon al día la copia local
    const linea = reportLine(d.report || rep);
    toast(`${K.creada} «${d.name}»` + (linea ? `: ${linea}` : ''));
    // Directo a la ficha nueva: es lo que el usuario acaba de pedir, y quedarse
    // aquí dejaría en pantalla una previsualización de algo que ya existe.
    go(K.detailUrl(d.public_id));
  }

  /* ── estados del panel de resultado ──────────────────────────────────────
     Tres: sin elegir nada (texto), cargando (shimmer) y con informe. Mismo
     diseño que el shimmer de los dos detalles, y por el mismo motivo: un panel
     vacío mientras el servidor calcula parece la app colgada. */
  function showEmpty(msg) {
    const e = q('#un-empty'), r = q('#un-result');
    if (e) { e.textContent = msg || K.elige; e.classList.remove('hidden'); }
    if (r) r.classList.add('hidden');
    const tune = q('#un-tune'); if (tune) tune.style.display = 'none';
    const leg = q('#un-legend'); if (leg) leg.innerHTML = '';
    // Sin resultado no hay perfil que enseñar: el panel vuelve a su texto.
    clearElevation();
  }
  function showSkeleton() {
    const e = q('#un-empty'), r = q('#un-result');
    if (e) e.classList.add('hidden');
    if (r) r.classList.remove('hidden');
    const st = q('#un-stats');
    if (st && !rep) st.innerHTML = Array.from({length: 4}, () =>
      '<div class="skel-stat"><div class="skel"></div><div class="skel b"></div></div>').join('');
  }
  function showResult() {
    const e = q('#un-empty'), r = q('#un-result');
    if (e) e.classList.add('hidden');
    if (r) r.classList.remove('hidden');
  }

  /* ── aviso de fallo de carga ─────────────────────────────────────────────
     Los mensajes distinguen los tres casos (sin red, el servidor no contesta y
     otra ventana retiene la copia local) porque se arreglan de formas distintas. */
  function loadErrorMsg(e) {
    if (e && e.timeout)   return 'El servidor tardó demasiado en responder.';
    if (e && e.dbBlocked) return 'Otra ventana de Sendero retiene la copia local. Ciérrala y reintenta.';
    if (e && e.offline)   return 'Sin conexión, y esto no está guardado en este dispositivo.';
    return K.noCargada;
  }
  function showLoadError(e) {
    const box = q('#un-load-error');
    if (!box) return;
    box.querySelector('.le-msg').textContent = loadErrorMsg(e);
    box.classList.remove('hidden');
  }
  function hideLoadError() {
    const box = q('#un-load-error');
    if (box) box.classList.add('hidden');
  }
  function retry() { if (_lastParams) mount(_lastParams, {}); }

  /* ── montaje ───────────────────────────────────────────────────────────── */
  function resetState() {
    if (prevTimer) { clearTimeout(prevTimer); prevTimer = null; }
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    prevTok++;
    destroyMap();          // se lleva los marcadores y el cuadro de hover
    destroyChart();        // …y el Chart del perfil, que es de esta vista
    destroySrcCharts();    // …y los perfiles fuente del modo montaje
    srcs = []; srcCharts = []; selRange = []; pieces = []; hiPiece = null;
    trackLens = null; dragI = null; selGen++;
    ['#un-timeline', '#un-pieces-list'].forEach(id => {
      const el = q(id); if (el) el.innerHTML = '';
    });
    ['#un-srcs', '#un-tl-panel', '#un-pieces-panel'].forEach(id => {
      const el = q(id); if (el) el.style.display = 'none';
    });
    srcEls.forEach(el => { if (el && el.panel) el.panel.style.display = 'none'; });
    const revs = q('#un-revs'); if (revs) revs.innerHTML = '';
    resetProps();
    resetEnds();
    resElev = []; resCoords = []; resCum = []; resBreak = null; hoverD = null;
    srcHover = null;
    const endsPanel = q('#un-ends'); if (endsPanel) endsPanel.style.display = 'none';
    opts = null; rep = null; stats = null; fitted = false; refitNext = false;
    sels = []; pickDraft = []; items = []; search = ''; creating = false;
    current = null;
    busy(false);
    hideLoadError();
    /* El popup es `position:fixed`: dejarlo abierto al salir lo pondría encima
       de la sección siguiente. */
    closePick();
    renderPickChip();
    const s = q('#un-search'); if (s) { s.value = ''; s.style.display = ''; }
    const l = q('#un-list'); if (l) l.innerHTML = '';
    const ps = q('#un-pick-sub'); if (ps) ps.textContent = '';
    const pb = q('#un-pick-back'); if (pb) pb.style.display = 'none';
    const leg = q('#un-legend'); if (leg) leg.innerHTML = '';
    const btn = q('#un-create'); if (btn) btn.disabled = false;
    const tune = q('#un-tune');
    if (tune) { tune.style.display = 'none'; tune.open = false; }
    const off = q('#un-offline'); if (off) off.classList.add('hidden');
    showEmpty(null);
  }

  /* Textos del markup que dependen de si se une una RUTA o un PLAN. Los ids son
     los mismos (es la misma sección): solo cambia lo que dicen. */
  function applyKindUI() {
    const set = (id, txt) => { const el = q(id); if (el) el.textContent = txt; };
    set('#un-pick-title', K.unirCon);
    set('#un-create', K.crear);
    set('#un-elev-empty', K.perfilVacio);
    const s = q('#un-search'); if (s) s.placeholder = K.buscarPh;
    const n = q('#un-name'); if (n) n.placeholder = K.nombrePh;
    const b = q('#un-back'); if (b) b.dataset.nav = K.listUrl;
  }

  async function mount(params, _opts) {
    const tok = ++_tok;
    resetState();
    // El router manda 'plan' desde /Plan/<pid>/unir; sin él, una ruta.
    kind = (params && params.kind === 'plan') ? 'plan' : 'route';
    K = KINDS[kind];
    pid = params && params.id;
    _lastParams = params;
    applyKindUI();
    /* El modo es una PREFERENCIA (como los filtros de «Mis Rutas»), así que
       sobrevive a cambiar de sección pero no se guarda con los datos. */
    mode = loadMode();
    applyModeUI();
    // En montaje el panel de resultado pide lo suyo: elegir con qué montar.
    if (mode === 'montaje') showEmpty(K.eligeMontaje);
    const back = q('#un-back');
    if (back && pid) back.dataset.nav = K.detailUrl(pid);
    const title = q('#un-title-name');
    if (title) title.textContent = K.titulo;
    document.title = `${K.titulo} – Sendero`;
    /* Sin conexión la sección se monta igual (el shell y el código están
       precacheados) y lo dice: el servidor es quien calcula la unión, así que
       aquí no hay nada que encolar. La copia local sí puede pintar la traza. */
    const off = q('#un-offline');
    if (!Store.isOnline() && off) { off.textContent = K.offline; off.classList.remove('hidden'); }
    let data = null;
    try {
      data = await K.load(pid);
    } catch (e) {
      if (tok !== _tok) return;
      showLoadError(e);
      showEmpty(K.noCargada);
      return;
    }
    if (tok !== _tok) return;
    if (!data) { showEmpty(K.noEncontrada); if (title) title.textContent = K.noEncontrada; return; }
    current = data;
    if (title) title.textContent = `Unir: ${current.name || ''}`;
    document.title = `Unir ${current.name || ''} – Sendero`;
    initMap();
    // En montaje, el perfil de A ya se puede pintar: B llega al elegir candidato.
    if (mode === 'montaje') { await ensureSources(); if (tok !== _tok) return; }
    await loadItems();
    if (tok !== _tok) return;
    renderPickChip();
    if (!Store.isOnline()) {
      const list = q('#un-list');
      if (list) list.classList.add('is-off');
      return;                    // sin red no se abre: el aviso ya lo explica
    }
    /* Se llega aquí para elegir con qué unir, así que el popup se abre solo —
       una vez la lista está cargada, para que se vea ya con sus «Cercanos» (o
       con el «no hay otras» y su «← Volver»). Si ya hay candidato (se vuelve de
       otra sección, o «↻ Reintentar») no se abre: estorbaría. */
    if (!sels.length) openPick();
  }

  function unmount() {
    _tok++;                        // invalida cualquier carga en vuelo
    resetState();
    pid = null; _lastParams = null;
    const list = q('#un-list');
    if (list) list.classList.remove('is-off');
  }

  /* Listener de `document`: se registra UNA vez al cargar el archivo, nunca en
     mount() (loadOnce() ejecuta el script una sola vez, pero mount() puede
     correr decenas de veces y los listeners se irían acumulando). Por eso
     comprueba él mismo que la sección está a la vista y el popup abierto: este
     archivo sigue cargado aunque se esté en otra sección. */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !pickOpen) return;
    const sec = document.getElementById('sec-unir');
    if (!sec || sec.classList.contains('hidden')) return;
    closePick();
  });

  window.SEC.unir = {
    mount, unmount, retry,
    searchChanged, backToProposals, toggleRev, optsChanged, setGap,
    endsChanged, doMerge,
    // el popup «con qué unir» (`changePick` es el nombre viejo de openPick)
    openPick, closePick, changePick, veilClick, backFromPick, applyPick,
    // modo «Montaje»
    setMode, srcAll, srcAdd, clearPieces, fitSeam,
  };
})();
