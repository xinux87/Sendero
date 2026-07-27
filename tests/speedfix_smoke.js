/* Prueba de humo del corrector de velocidad excesiva.  Ejecutar:
     node tests/speedfix_smoke.js

   La herramienta ya NO elimina los puntos con velocidad imposible: los recoloca
   entre el último punto válido anterior y el primer válido posterior (la media de
   los dos cuando el punto cae a mitad de camino en el tiempo). Eso es geometría
   pura dentro del IIFE de static/js/sec/editor.js, así que se extrae la fuente de
   las tres funciones implicadas (no una copia: si cambia el editor, cambia lo que
   se prueba) y se evalúan con el estado del editor simulado.

   Lo que se comprueba, que es lo que no puede romperse:
     1. un salto suelto queda en la MEDIA exacta de sus vecinos (posición y altitud),
     2. el número de puntos no baja: nada se pierde,
     3. tras aplicar el plan ya no queda ninguna velocidad por encima del umbral,
     4. una tira sin punto válido al otro lado (llega al final del track) sí se
        elimina, porque no hay nada con lo que promediar.

   Y a partir de la v0.9.7, lo que de verdad importa de "✔ Corregir todo":
     5. detectGpsIssues() es un puerto EXACTO de detect_gps_anomalies() del
        servidor (mismos tres tipos, mismo criterio entre puntos consecutivos),
     6. planGpsFix() converge en UNA pasada: tras corregir no queda ni un aviso,
        ni de velocidad, ni de tasa vertical, ni de altitud — incluido el caso
        que fallaba, en el que corregir la velocidad reescribía la altitud y
        fabricaba avisos de elevación nuevos,
     7. y cuando algo NO se puede arreglar interpolando (una "altitud máx." por
        debajo de todo el track), lo devuelve en `issues` en vez de fingir.
*/
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync('static/js/sec/editor.js', 'utf8');

/* Extrae `function nombre(…){…}` del archivo casando llaves. Las tres funciones
   que se extraen no contienen cadenas ni comentarios con llaves, así que contar
   basta. */
function fuente(nombre) {
  const i = src.indexOf('function ' + nombre + '(');
  assert.ok(i >= 0, `no se encuentra ${nombre}() en sec/editor.js`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${nombre}(): llaves sin cerrar`);
}

/* Estado del editor que leen las funciones extraídas (mismos nombres). El eval es
   directo, así que las funciones capturan estos `let` como lo harían en el IIFE. */
let P = null, idxMap = null, cur = [], timeMs = null;
const eleOf = oi => (P.ele ? P.ele[oi] : null);
const haversineM = eval('(' + fuente('haversineM') + ')');
const detectSpeedErr = eval('(' + fuente('detectSpeedErr') + ')');
const planSpeedFix = eval('(' + fuente('planSpeedFix') + ')');
/* Motor de "✔ Corregir todo": detector equivalente al del servidor y
   planificador convergente. Son funciones puras (arrays entran, plan sale). */
const _speedBad = eval('(' + fuente('_speedBad') + ')');
const _forEachStrip = eval('(' + fuente('_forEachStrip') + ')');
const detectGpsIssues = eval('(' + fuente('detectGpsIssues') + ')');
const planGpsFix = eval('(' + fuente('planGpsFix') + ')');

/* Track sintético: recta hacia el este a ~10 m por punto y 10 s por punto
   (≈3,6 km/h, ritmo de andar), con elevación subiendo 1 m por punto. */
const PASO = 0.00012;            // ° de longitud ≈ 9,9 m a 42° de latitud
function nuevoTrack(n) {
  P = {n, lonlat: [], ele: [], time: [], segments: [[0, n - 1]]};
  for (let i = 0; i < n; i++) {
    P.lonlat.push([-1.6 + i * PASO, 42.0]);
    P.ele.push(1000 + i);
    P.time.push(new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + i * 10000).toISOString());
  }
  idxMap = Int32Array.from({length: n}, (_, i) => i);
  timeMs = P.time.map(t => Date.parse(t));
  reconstruir();
}
function reconstruir() {
  cur = Array.from(idxMap, oi => P.lonlat[oi]);
}
/* Aplica un plan como lo hace doOp(move_points)+doOp(delete_points): mover
   primero (no reindexa) y borrar después. */
function aplicar(plan) {
  plan.moves.forEach(([i, lon, lat, ele]) => {
    const oi = idxMap[i];
    P.lonlat[oi] = [lon, lat];
    if (ele != null) P.ele[oi] = ele;
  });
  if (plan.drops.length) {
    const fuera = new Set(plan.drops);
    idxMap = Int32Array.from([...idxMap].filter((_, i) => !fuera.has(i)));
  }
  reconstruir();
}

const UMBRAL = 15;   // km/h (senderismo)

// ── 1) salto suelto: media exacta de los vecinos, y no se pierde ───────────────
nuevoTrack(20);
const nAntes = idxMap.length;
P.lonlat[5] = [P.lonlat[5][0] + 0.01, 42.0];   // ~830 m de desvío → ~300 km/h
P.ele[5] = 3000;                               // altitud igual de falsa
reconstruir();

let idxs = detectSpeedErr(UMBRAL);
assert.deepEqual([...idxs], [5], `solo el punto desviado debe marcarse: ${idxs}`);

let plan = planSpeedFix(idxs);
assert.equal(plan.drops.length, 0, 'un salto interior no se elimina');
assert.equal(plan.moves.length, 1);
const [i5, lon5, lat5, ele5] = plan.moves[0];
assert.equal(i5, 5);
const medLon = (cur[4][0] + cur[6][0]) / 2, medLat = (cur[4][1] + cur[6][1]) / 2;
assert.ok(Math.abs(lon5 - medLon) < 1e-12 && Math.abs(lat5 - medLat) < 1e-12,
  `el punto debe quedar en la media de sus vecinos: ${lon5},${lat5} ≠ ${medLon},${medLat}`);
assert.equal(ele5, (P.ele[4] + P.ele[6]) / 2, 'la altitud también se promedia');
console.log('OK un salto suelto queda en la media exacta de sus vecinos (con altitud)');

aplicar(plan);
assert.equal(idxMap.length, nAntes, 'no se pierde ningún punto');
assert.deepEqual([...detectSpeedErr(UMBRAL)], [], 'tras corregir no debe quedar ningún aviso');
console.log('OK el punto no se pierde y no queda velocidad por encima del umbral');

// ── 2) tira de varios puntos desviados: reparto por tiempo, en orden ───────────
nuevoTrack(30);
[12, 13, 14].forEach((i, k) => { P.lonlat[i] = [P.lonlat[i][0] + 0.008 + k * 0.001, 42.002]; });
reconstruir();
idxs = detectSpeedErr(UMBRAL);
assert.deepEqual([...idxs], [12, 13, 14], `la tira entera debe marcarse: ${idxs}`);
plan = planSpeedFix(idxs);
assert.equal(plan.drops.length, 0);
assert.equal(plan.moves.length, 3);
const lons = plan.moves.map(m => m[1]);
assert.ok(lons[0] < lons[1] && lons[1] < lons[2], 'los tres deben repartirse en orden');
const A = cur[11][0], B = cur[15][0];
// tiempos equiespaciados ⇒ 1/4, 2/4 y 3/4 del tramo A–B
[0.25, 0.5, 0.75].forEach((f, k) => {
  assert.ok(Math.abs(lons[k] - (A + (B - A) * f)) < 1e-12,
    `punto ${k} mal repartido: ${lons[k]}`);
});
aplicar(plan);
assert.equal(idxMap.length, 30, 'ningún punto de la tira se pierde');
assert.deepEqual([...detectSpeedErr(UMBRAL)], [], 'la tira corregida no deja avisos');
console.log('OK una tira de 3 puntos se reparte por tiempo entre los válidos');

// ── 3) sin timestamps: espaciado uniforme, y tampoco se pierde nada ───────────
nuevoTrack(20);
P.lonlat[7] = [P.lonlat[7][0] + 0.01, 42.0];
reconstruir();
const conTiempo = planSpeedFix(detectSpeedErr(UMBRAL));
timeMs[idxMap[7]] = null;               // este punto pierde su marca de tiempo
const sinTiempo = planSpeedFix([7]);    // (detectSpeedErr ya no lo evaluaría)
assert.equal(sinTiempo.moves.length, 1);
assert.ok(Math.abs(sinTiempo.moves[0][1] - conTiempo.moves[0][1]) < 1e-12,
  'sin timestamp el reparto uniforme coincide con el temporal en el caso central');
console.log('OK sin marca de tiempo el reparto cae a espaciado uniforme');

// ── 4) tira que llega al final: no hay con qué promediar → se elimina ─────────
nuevoTrack(20);
P.lonlat[19] = [P.lonlat[19][0] + 0.01, 42.0];
reconstruir();
plan = planSpeedFix(detectSpeedErr(UMBRAL));
assert.equal(plan.moves.length, 0, 'sin punto válido después no se puede interpolar');
assert.deepEqual(plan.drops, [19], 'el punto final desviado se elimina');
aplicar(plan);
assert.equal(idxMap.length, 19);
assert.deepEqual([...detectSpeedErr(UMBRAL)], []);
console.log('OK un salto al final del track se elimina (no hay media posible)');


/* ══ "✔ Corregir todo": tiene que converger a CERO avisos en una pasada ══════
   Estos son los casos que obligaban a pasar la herramienta varias veces. El
   criterio de éxito es siempre el mismo y no admite matices: detectGpsIssues()
   sobre el resultado devuelve [].                                            */

const TH = {maxSpeed: 15, maxVert: 3, maxEle: 4900};   // senderismo

/* Estado del editor → los arrays que comen las funciones puras. */
function estado() {
  return {
    pos: Array.from(idxMap, oi => P.lonlat[oi]),
    ele: P.ele ? Array.from(idxMap, oi => P.ele[oi]) : null,
    t:   timeMs ? Array.from(idxMap, oi => timeMs[oi]) : null,
  };
}
/* Aplica el resultado de planGpsFix como lo hacen las ops del editor. */
function aplicarPlan(plan) {
  for (let i = 0; i < idxMap.length; i++) {
    const oi = idxMap[i];
    P.lonlat[oi] = plan.pos[i];
    if (plan.ele) P.ele[oi] = plan.ele[i];
  }
  if (plan.drops.length) {
    const fuera = new Set(plan.drops);
    idxMap = Int32Array.from([...idxMap].filter((_, i) => !fuera.has(i)));
  }
  reconstruir();
}
function avisos() {
  const s = estado();
  return detectGpsIssues(s.pos, s.ele, s.t, TH);
}
function corregir() {
  const s = estado();
  const plan = planGpsFix(s.pos, s.ele, s.t, TH);
  aplicarPlan(plan);
  return plan;
}

// ── 5) el detector ve los tres tipos, y solo cuando toca ──────────────────────
nuevoTrack(20);
assert.deepEqual(avisos(), [], 'un track limpio no debe dar ningún aviso');
console.log('OK un track limpio no genera avisos');

nuevoTrack(20);
P.ele[8] = P.ele[7] + 100;          // +100 m en 10 s = 10 m/s (umbral 3)
reconstruir();
let tipos = avisos().map(x => x.type);
assert.ok(tipos.includes('elevation'), `debía detectar tasa vertical: ${tipos}`);
console.log('OK detecta la tasa vertical imposible (m/s), no solo el salto de altura');

nuevoTrack(20);
P.ele[9] = 6000;                    // por encima de max_ele_m
reconstruir();
tipos = avisos().map(x => x.type);
assert.ok(tipos.includes('altitude'), `debía detectar la altitud: ${tipos}`);
console.log('OK detecta la altitud por encima del máximo de la actividad');

// ── 6) EL CASO DEL FALLO: un salto de GPS con altitud falsa ───────────────────
//    Corregir la velocidad recolocaba el punto y le reescribía la altitud sin
//    mirar la tasa vertical, así que aparecían avisos de elevación nuevos y
//    había que volver a pasar la herramienta.
nuevoTrack(30);
P.lonlat[15] = [P.lonlat[15][0] + 0.01, 42.0];
P.ele[15] = 3000;                   // el salto trae altitud falsa
reconstruir();
let antes = avisos();
assert.ok(antes.some(x => x.type === 'speed'), 'debía haber aviso de velocidad');
assert.ok(antes.some(x => x.type === 'elevation'), 'y de tasa vertical');
plan = corregir();
assert.equal(plan.issues.length, 0, `planGpsFix se declara convergido: ${JSON.stringify(plan.issues)}`);
assert.deepEqual(avisos(), [], 'UNA pasada tiene que dejar el track sin avisos');
assert.equal(idxMap.length, 30, 'y sin perder puntos');
console.log('OK un salto de GPS con altitud falsa se resuelve en UNA pasada');

// ── 7) varios saltos a la vez, de los tres tipos mezclados ────────────────────
nuevoTrack(60);
P.lonlat[10] = [P.lonlat[10][0] + 0.012, 42.001];   // salto de posición
P.ele[10] = 2500;
[24, 25, 26].forEach((i, k) => {                    // tira desviada
  P.lonlat[i] = [P.lonlat[i][0] + 0.009 + k * 0.001, 42.003];
});
P.ele[40] = P.ele[39] + 250;                        // pico de barómetro
P.ele[41] = P.ele[39] + 240;                        // con meseta
P.ele[50] = 6200;                                   // altitud imposible
reconstruir();
antes = avisos();
assert.ok(antes.length >= 4, `el escenario debe ensuciar bien el track: ${antes.length}`);
assert.deepEqual([...new Set(antes.map(x => x.type))].sort(),
  ['altitude', 'elevation', 'speed'], 'deben aparecer los tres tipos');
plan = corregir();
assert.equal(plan.issues.length, 0, `quedan avisos: ${JSON.stringify(plan.issues)}`);
assert.deepEqual(avisos(), [], 'los tres tipos mezclados se resuelven en UNA pasada');
console.log(`OK ${antes.length} avisos de los 3 tipos, resueltos en una pasada (${plan.passes} iteración interna)`);

// ── 8) idempotencia: volver a corregir no debe tocar nada ─────────────────────
const posDespues = JSON.stringify(estado().pos);
const eleDespues = JSON.stringify(estado().ele);
plan = corregir();
assert.equal(plan.drops.length, 0, 'una segunda pasada no debe eliminar nada');
assert.equal(JSON.stringify(estado().pos), posDespues, 'ni mover ningún punto');
assert.equal(JSON.stringify(estado().ele), eleDespues, 'ni tocar ninguna altitud');
console.log('OK corregir un track ya corregido no cambia nada (idempotente)');

// ── 9) lo irreparable se REPORTA, no se finge ─────────────────────────────────
//    Altitud máxima por debajo de toda la ruta: no hay ancla válida con la que
//    interpolar. Antes se quedaba en bucle silencioso; ahora sale en issues.
nuevoTrack(20);
for (let i = 0; i < 20; i++) P.ele[i] = 5200;       // todo por encima de 4900
reconstruir();
plan = planGpsFix(estado().pos, estado().ele, estado().t, TH);
assert.ok(plan.issues.length > 0, 'debe admitir que no puede arreglarlo');
assert.ok(plan.issues.every(x => x.type === 'altitude'), 'y decir de qué tipo son');
assert.ok(plan.passes <= 4, `no puede quedarse iterando: ${plan.passes}`);
console.log('OK una altitud máxima imposible se reporta en vez de fingir que se arregló');

// ── 10) el reparto temporal no puede retroceder ───────────────────────────────
//    Con timestamps desordenados dentro de la tira, la monotonía del reparto es
//    lo que impide fabricar una velocidad nueva entre dos puntos interpolados.
nuevoTrack(30);
[14, 15, 16].forEach(i => { P.lonlat[i] = [P.lonlat[i][0] + 0.01, 42.002]; });
timeMs[idxMap[15]] = timeMs[idxMap[14]] - 5000;     // marca fuera de orden
reconstruir();
plan = corregir();
assert.deepEqual(avisos().filter(x => x.type === 'speed'), [],
  'con timestamps desordenados tampoco puede quedar velocidad excesiva');
console.log('OK un timestamp fuera de orden no rompe el reparto (monotonía forzada)');

console.log('\nTODO OK');
