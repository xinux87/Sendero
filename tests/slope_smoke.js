/* Prueba de humo de la escala de pendiente.  Ejecutar:  node tests/slope_smoke.js

   Es la lógica que colorea la traza del mapa y el perfil de elevación del detalle
   de una RUTA y del de un PLAN: verde llano → rojo pared. Vive en static/shared.js
   (slopeColor / slopeProfile / slopeGradientExpr / slopeLegendHtml) y es pura, así
   que se prueba con Node a pelo, sin npm ni navegador (regla 1).

   Lo que vigila, que es justo lo que se rompe sin que se note:
   - que TODO se mida por distancia y no por índice de la serie (la de elevación no
     es uniforme en distancia: ver el bloque del final, que es el fallo real que
     apareció al probar con rutas de verdad);
   - que la pendiente sea ABSOLUTA (bajar al 20 % pinta como subirlo);
   - que la ventana móvil aplane el ruido del GPS — sin ella el color parpadea
     tramo a tramo en vez de describir el terreno;
   - que la expresión de MapLibre tenga paradas ESTRICTAMENTE crecientes (si no,
     MapLibre descarta el degradado entero y la traza sale sin color) y que no
     crezca sin tope con la longitud del track;
   - que un track de pendiente constante siga saliendo pintado (dos paradas del
     mismo color, no null: null deja la traza del color de la actividad). */
const fs = require('fs');

/* shared.js lee document.body al cargarse (MAP_CFG y PLANNER_URL).
   Las `const` de un eval NO salen de su ámbito (a diferencia de las funciones),
   así que el propio eval devuelve lo que hace falta. */
global.document = {body: {dataset: {}}, querySelector: () => null};
const {SLOPE_SCALE, SLOPE_BUCKETS, slopeColor, slopeProfile, slopeGradientExpr,
       slopeBuckets, slopeLegendHtml} = eval('(function(){'
  + fs.readFileSync('static/shared.js', 'utf8')
  + ';return {SLOPE_SCALE, SLOPE_BUCKETS, slopeColor, slopeProfile,'
  + '         slopeGradientExpr, slopeBuckets, slopeLegendHtml};})()');

let oks = 0;
const fallos = [];
function check(cond, msg) {
  if (cond) { oks++; console.log('  OK   ' + msg); }
  else { fallos.push(msg); console.log('  FALLA ' + msg); }
}
/* serie de elevación sintética: n puntos cada `paso` metros */
function serie(n, paso, fe) {
  const e = [];
  for (let i = 0; i <= n; i++) e.push({d: i * paso / 1000, e: fe(i)});
  return e;
}
const creciente = g => {
  for (let i = 5; i < g.length; i += 2) if (!(g[i] > g[i - 2])) return false;
  return true;
};

console.log('\n── colores de la escala ' + ''.padEnd(50, '─'));
check(slopeColor(0) === `rgb(${SLOPE_SCALE[0][1].join(',')})`, 'el llano es el primer color de la escala');
check(slopeColor(99) === `rgb(${SLOPE_SCALE[SLOPE_SCALE.length - 1][1].join(',')})`,
      'por encima del último corte se satura en el último color');
check(slopeColor(-20) === slopeColor(20), 'la pendiente es ABSOLUTA: −20 % pinta como +20 %');
check(slopeColor(7).startsWith('rgb(') && slopeColor(7) !== slopeColor(8),
      'entre cortes interpola (7 % y 8 % no son el mismo color)');
check(slopeColor(10, .34) === slopeColor(10).replace('rgb(', 'rgba(').replace(')', ',0.34)')
      || slopeColor(10, .34).startsWith('rgba('), 'con alfa devuelve rgba() (lo usa el relleno)');

console.log('\n── perfil de pendientes ' + ''.padEnd(50, '─'));
const rampa = serie(100, 10, i => i * 1);            // +1 m cada 10 m = 10 %
const p1 = slopeProfile(rampa);
check(p1.every(v => Math.abs(v - 10) < 0.01), 'una rampa del 10 % da 10 % en TODOS los puntos, extremos incluidos');
const bajada = serie(100, 10, i => 500 - i * 1);
check(slopeProfile(bajada).every(v => Math.abs(v + 10) < 0.01), 'la bajada del 10 % da −10 % (el signo se pierde al colorear)');
/* GPS sucio en terreno llano: ±3 m de un punto al siguiente cada 10 m. Punto a
   punto serían ±60 %; la ventana tiene que dejarlo en algo que siga leyéndose
   verde/lima, no en rojo. */
const ruido = serie(100, 10, i => 1000 + ((i % 2) ? 3 : -3));
const pr = slopeProfile(ruido).map(Math.abs);
check(Math.max(...pr) < 15, `el ruido del GPS en llano no dispara la pendiente (máx ${Math.max(...pr).toFixed(1)} %, punto a punto serían 60)`);
check(slopeProfile([]).length === 0 && slopeProfile([{d: 0, e: 5}]).length === 1,
      'con 0 o 1 punto no revienta');

console.log('\n── expresión line-gradient de MapLibre ' + ''.padEnd(35, '─'));
const g1 = slopeGradientExpr(rampa);
check(g1 && g1[0] === 'interpolate' && g1[2][0] === 'line-progress',
      'es una interpolación sobre line-progress (necesita lineMetrics en la fuente)');
check(g1 && (g1.length - 3) / 2 >= 2, 'una pendiente constante SIGUE pintándose (2 paradas del mismo color, no null)');
check(g1 && g1[3] === 0, 'la primera parada está en 0');
check(creciente(g1), 'las paradas de la rampa van estrictamente crecientes');
const ondulado = serie(2000, 10, i => 1000 + 300 * Math.sin(i / 40) + (i % 3) * 2);
const g2 = slopeGradientExpr(ondulado);
check(creciente(g2), 'las paradas de un track ondulado y ruidoso también');
check((g2.length - 3) / 2 <= SLOPE_BUCKETS + 1,
      `el nº de paradas está acotado (${(g2.length - 3) / 2} ≤ ${SLOPE_BUCKETS}) por muy largo que sea el track`);
const llano = serie(50, 20, () => 700);
const g3 = slopeGradientExpr(llano);
check(g3 && g3[4] === slopeColor(0), 'un track llano sale entero del color de llano');
check(slopeGradientExpr([]) === null && slopeGradientExpr(null) === null
      && slopeGradientExpr([{d: 0, e: 1}]) === null,
      'sin elevación devuelve null (la traza se queda del color de la actividad)');
check(slopeGradientExpr([{d: 2, e: 1}, {d: 2, e: 9}]) === null,
      'con distancia cero devuelve null en vez de dividir por cero');

/* ── El fallo de la v0.9.13 antes de publicarse, y el motivo de que slopeBuckets
   exista: la serie de elevación NO es uniforme en distancia. Un GPX muestrea por
   tiempo, así que la subida lenta acumula puntos y la bajada rápida casi ninguno
   (y `resample()` del modo ligero va por índice, conservando el sesgo). Medido en
   una ruta real de 7,6 km: en la mitad del eje X se pintaba un 28,6 % (rojo) donde
   el terreno iba al 2,3 % (llano), con un desfase de casi 800 m.

   La serie de abajo lo reproduce: primera MITAD de la distancia = subida al 20 %
   con un punto cada 5 m (lenta), segunda mitad = llano con un punto cada 100 m.
   Así el punto nº mitad de la serie está mucho antes de la mitad del track. */
console.log('\n── serie NO uniforme en distancia (el fallo de la 0.9.13) ' + ''.padEnd(16, '─'));
const desigual = [];
for (let d = 0; d < 1; d += 0.005) desigual.push({d, e: 500 + d * 1000 * 0.20});   // 20 %
for (let d = 1; d <= 2; d += 0.100) desigual.push({d, e: 700});                    // llano
const nD = desigual.length;
const idxMitad = Math.round((nD - 1) / 2);
check(desigual[idxMitad].d < 0.75,
      `el punto nº mitad de la serie está en el km ${desigual[idxMitad].d.toFixed(2)}, no en el 1,0 (por eso el índice no vale)`);
const cubos = slopeBuckets(desigual, 20);
check(cubos.slice(0, 9).every(v => v > 15),
      'la primera mitad del TRACK sale empinada (>15 %) en los cubos por distancia');
check(cubos.slice(11).every(v => v < 5),
      'y la segunda mitad sale llana (<5 %), que es donde antes se pintaba la subida');
/* Y la comprobación que falla con el código viejo: el color en la fracción 0.75
   del track tiene que ser el del llano, no el de la subida. */
const cLlano = slopeColor(0), cCuesta = slopeColor(20);
check(slopeColor(cubos[15]) === cLlano && slopeColor(cubos[3]) === cCuesta,
      'x=0,75 pinta llano y x=0,15 pinta cuesta (con la versión por índice era al revés)');
const gD = slopeGradientExpr(desigual);
check(creciente(gD) && gD[gD.length - 1] === cLlano,
      'la expresión del mapa acaba en el color del llano, que es como acaba el track');

console.log('\n── leyenda ' + ''.padEnd(62, '─'));
const leg = slopeLegendHtml();
check((leg.match(/<i /g) || []).length === SLOPE_SCALE.length,
      'la leyenda tiene una marca por corte de la escala');
check(SLOPE_SCALE.every(([, c]) => leg.includes(`rgb(${c.join(',')})`)),
      'y su degradado usa exactamente los colores de SLOPE_SCALE (no puede desfasarse)');

console.log('\n' + ''.padEnd(74, '═'));
console.log(`  ${oks} comprobaciones OK, ${fallos.length} fallos`);
fallos.forEach(f => console.log('   ✗ ' + f));
process.exit(fallos.length ? 1 : 0);
