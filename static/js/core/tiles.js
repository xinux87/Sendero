/* Mapa sin conexión de UNA ruta.

   El planteamiento original era descargar zonas enteras. Se cambió por algo
   mucho más pequeño y que además resuelve mejor el caso de verdad:

     descargar solo el CORREDOR de teselas que cubre el track de una ruta.

   Los números lo justifican: una ruta de 39 km necesita ~250 teselas entre el
   zoom 10 y el 15 (unos 6 MB); una caminata de 14 km, ~120. Una región serían
   cientos de miles. Y a diferencia de la capa PMTiles —que la sirve Sendero y
   por tanto necesita el servidor encendido— esto vive en el navegador, así que
   funciona con el móvil en el monte y el servidor apagado en casa.

   Las teselas van a su propia caché (`sendero-tiles-v1`), que NO se borra al
   publicar una versión: son datos que el usuario ha pedido explícitamente, no
   código. Las sirve el Service Worker (ver static/sw.js): al no haber red, la
   petición de MapLibre se resuelve desde ahí.

   Sobre los términos de uso: las 4 capas base son de terceros y sus políticas
   piden no descargar en masa. Por eso esto (a) es siempre una acción explícita
   del usuario sobre una ruta concreta, (b) tiene un tope duro de teselas, y
   (c) descarga despacio y de pocas en pocas. La UI lo dice antes de empezar.
*/
const Tiles = (() => {
  'use strict';

  const CACHE = 'sendero-tiles-v1';
  // z10 da contexto al alejarse; z15 es suficiente para caminar (~5 m/píxel).
  const ZOOM_MIN = 10, ZOOM_MAX = 15;
  // Tope duro: por encima de esto no se descarga y se dice por qué. Con el
  // corredor de una ruta normal no se llega ni de lejos (250-500).
  const MAX_TILES = 3000;
  const CONCURRENCY = 3;          // amable con el servidor de teselas
  const PAUSE_MS = 60;            // ídem: ~50 teselas/s como máximo

  /* ── geometría ─────────────────────────────────────────────────────────── */

  /* lat/lon → índices de tesela en el zoom z (esquema XYZ de siempre). */
  function tileOf(lat, lon, z) {
    const n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n);
    const la = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(la)) / Math.PI) / 2 * n);
    return [x, y];
  }

  /* Corredor de teselas de un track: las que pisa, más un anillo de `ring`
     alrededor para que la línea no quede pegada al borde de la pantalla.
     Devuelve una lista sin repetidos y ordenada por zoom (primero los zooms
     bajos: si la descarga se corta a medias, al menos queda la vista general). */
  function forTrack(coords, {zmin = ZOOM_MIN, zmax = ZOOM_MAX, ring = 1} = {}) {
    const out = [];
    const vistos = new Set();
    for (let z = zmin; z <= zmax; z++) {
      const n = 2 ** z;
      for (const [lon, lat] of coords) {
        const [tx, ty] = tileOf(lat, lon, z);
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            const x = tx + dx, y = ty + dy;
            if (x < 0 || y < 0 || x >= n || y >= n) continue;
            const k = `${z}/${x}/${y}`;
            if (vistos.has(k)) continue;
            vistos.add(k);
            out.push({z, x, y});
          }
        }
      }
    }
    return out;
  }

  /* URL de una tesela en la capa `capa`. Reparte entre los subdominios igual
     que hace MapLibre (a/b/c...), para no cargar siempre el mismo. */
  function urlFor(capa, t) {
    const plantillas = BASEMAP_TILES[capa];
    if (!plantillas || !plantillas.length) return null;
    const p = plantillas[(t.x + t.y) % plantillas.length];
    return p.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  }

  const urlsFor = (capa, tiles) =>
    tiles.map(t => urlFor(capa, t)).filter(Boolean);

  /* ── caché ─────────────────────────────────────────────────────────────── */

  async function cache() { return caches.open(CACHE); }

  /* Cuántas de estas URLs están ya guardadas. Sirve para el "ya la tienes" de
     la UI y para no volver a pedir lo que ya hay. */
  async function have(urls) {
    const c = await cache();
    let n = 0;
    for (const u of urls) if (await c.match(u)) n++;
    return n;
  }

  /* Descarga las que falten. `onProgress(hechas, total, fallidas)` se llama a
     cada tesela. Devuelve {total, descargadas, yaEstaban, fallidas, bytes}. */
  async function download(urls, onProgress) {
    const c = await cache();
    if (urls.length > MAX_TILES) {
      throw Object.assign(new Error('demasiadas teselas'), {tooMany: true, n: urls.length});
    }
    const pendientes = [];
    let yaEstaban = 0;
    for (const u of urls) {
      if (await c.match(u)) yaEstaban++; else pendientes.push(u);
    }
    let hechas = yaEstaban, fallidas = 0, bytes = 0;
    const total = urls.length;
    if (onProgress) onProgress(hechas, total, fallidas);

    let i = 0;
    const worker = async () => {
      while (i < pendientes.length) {
        const u = pendientes[i++];
        try {
          // `cors` a propósito, no `no-cors`: una respuesta opaca no la puede
          // decodificar MapLibre después. Las 4 capas ya envían CORS (si no, no
          // se verían hoy), así que aquí no se pierde ninguna.
          const res = await fetch(u, {mode: 'cors', cache: 'default'});
          if (res.ok) {
            const buf = await res.clone().arrayBuffer();
            bytes += buf.byteLength;
            await c.put(u, res);
          } else {
            fallidas++;
          }
        } catch (e) {
          fallidas++;
        }
        hechas++;
        if (onProgress) onProgress(hechas, total, fallidas);
        if (PAUSE_MS) await new Promise(r => setTimeout(r, PAUSE_MS));
      }
    };
    await Promise.all(Array.from({length: Math.min(CONCURRENCY, pendientes.length)}, worker));
    return {total, descargadas: hechas - yaEstaban - fallidas, yaEstaban, fallidas, bytes};
  }

  /* Cuánto ocupa todo lo descargado, contando las entradas de la caché. El
     tamaño exacto lo estima el navegador (navigator.storage), que mezcla todo;
     aquí interesa el número de teselas, que sí es exacto. */
  async function usage() {
    const c = await cache();
    const keys = await c.keys();
    return {tiles: keys.length};
  }

  async function clear() { await caches.delete(CACHE); }

  /* Estimación para la UI antes de descargar: cuántas teselas y cuántos MB
     aproximados. 25 KB/tesela es la media medida en las 4 capas raster. */
  function estimate(tiles) {
    return {n: tiles.length, mb: (tiles.length * 25) / 1024};
  }

  /* ── el flujo completo, con su UI ──────────────────────────────────────────
     Vive aquí y no en cada sección porque `detalle` y `plan` lo necesitan
     idéntico: preguntar con la estimación delante, descargar con progreso y
     decir en qué quedó. `infoEl` es el <div> donde se escribe el estado. */
  async function downloadForTrack({coords, capa, infoEl, nombre}) {
    if (!coords || coords.length < 2) { toast('Esta ruta no tiene track'); return; }
    if (capa === OFFLINE_LAYER) {
      pinta(infoEl, 'La capa «Offline (local)» la sirve Sendero desde su archivo PMTiles: '
        + 'para verla sin conexión hace falta el servidor encendido. Cambia a una capa '
        + 'normal en el mapa y vuelve a intentarlo si quieres llevártela en el móvil.');
      return;
    }
    const tiles = forTrack(coords);
    const est = estimate(tiles);
    if (est.n > MAX_TILES) {
      pinta(infoEl, `Esta ruta necesitaría ${est.n} teselas, por encima del tope de `
        + `${MAX_TILES}. Es una ruta enorme: descarga el mapa por tramos.`);
      return;
    }
    const urls = urlsFor(capa, tiles);
    if (!urls.length) { pinta(infoEl, `La capa «${capa}» no tiene teselas descargables.`); return; }
    const ya = await have(urls);
    if (ya === urls.length) {
      pinta(infoEl, `El mapa de esta ruta ya está en este dispositivo `
        + `(${urls.length} teselas, «${capa}»).`, 'ok');
      return;
    }
    if (!confirm(`Descargar el mapa de «${nombre || 'esta ruta'}» para usarlo sin conexión:\n\n`
      + `· ${est.n - ya} teselas nuevas (${est.n} en total), unos ${est.mb.toFixed(0)} MB\n`
      + `· capa «${capa}», zoom ${ZOOM_MIN} a ${ZOOM_MAX}\n`
      + `· solo la franja por la que pasa el track\n\n`
      + `Las teselas son de un servicio de terceros: se descargan despacio y solo `
      + `las de esta ruta. ¿Continuar?`)) return;

    pinta(infoEl, 'Descargando el mapa…', '', true);
    const barra = infoEl && infoEl.querySelector('.bar i');
    let res;
    try {
      res = await download(urls, (hechas, total) => {
        if (barra) barra.style.width = Math.round((hechas / total) * 100) + '%';
        const txt = infoEl && infoEl.querySelector('span');
        if (txt) txt.textContent = `Descargando el mapa… ${hechas} / ${total} teselas`;
      });
    } catch (e) {
      pinta(infoEl, 'No se pudo descargar el mapa.');
      return;
    }
    const mb = (res.bytes / 1024 / 1024).toFixed(1);
    if (res.fallidas && !res.descargadas) {
      pinta(infoEl, `No se descargó ninguna tesela (${res.fallidas} fallos). ¿Hay conexión?`);
      return;
    }
    pinta(infoEl, `Mapa disponible sin conexión: ${res.total - res.fallidas} teselas`
      + (res.descargadas ? `, ${mb} MB descargados` : '')
      + (res.fallidas ? ` · ${res.fallidas} fallaron` : '') + '.', 'ok');
    toast('Mapa guardado para usar sin conexión');
  }

  /* Estado para la UI al abrir una ruta: si ya está descargada, decirlo. */
  async function statusForTrack({coords, capa, infoEl}) {
    if (!infoEl) return;
    if (!coords || coords.length < 2 || capa === OFFLINE_LAYER) { oculta(infoEl); return; }
    const urls = urlsFor(capa, forTrack(coords));
    if (!urls.length) { oculta(infoEl); return; }
    const ya = await have(urls);
    if (!ya) { oculta(infoEl); return; }
    if (ya === urls.length) {
      pinta(infoEl, `Mapa disponible sin conexión (${urls.length} teselas, «${capa}»).`, 'ok');
    } else {
      pinta(infoEl, `Mapa a medias en este dispositivo: ${ya} de ${urls.length} teselas.`);
    }
  }

  function pinta(el, texto, clase, conBarra) {
    if (!el) return;
    el.className = 'offline-map-info' + (clase ? ' ' + clase : '');
    el.innerHTML = `<span>${esc(texto)}</span>`
      + (conBarra ? '<div class="bar"><i></i></div>' : '');
  }
  const oculta = el => { if (el) el.className = 'offline-map-info hidden'; };

  return {CACHE, ZOOM_MIN, ZOOM_MAX, MAX_TILES,
          tileOf, forTrack, urlFor, urlsFor,
          have, download, usage, clear, estimate,
          downloadForTrack, statusForTrack};
})();
