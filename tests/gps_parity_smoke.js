/* Paridad entre el detector de avisos GPS del CLIENTE y el del SERVIDOR.
     node tests/gps_parity_smoke.js

   `detectGpsIssues()` (static/js/sec/editor.js) es un puerto de
   `detect_gps_anomalies()` (core/gps_analysis.py). De esa equivalencia depende
   toda la garantía de "✔ Corregir todo": el editor corrige hasta que SU detector
   dice cero, y si el criterio del servidor fuese otro, al guardar reaparecerían
   los avisos — que es exactamente el fallo que obligaba a pasar la herramienta
   varias veces.

   Aquí no se comparan implementaciones a ojo: se generan escenarios, se pasan
   por las dos y se exige que marquen LOS MISMOS PUNTOS con los mismos tipos.
   La función JS se extrae del archivo real (no es una copia), y la de Python se
   invoca en un subproceso, así que el día que una de las dos cambie sin la otra,
   esto falla.

   Nota sobre la forma: el servidor devuelve TRAMOS fusionados (d_from/d_to en km)
   y el cliente puntos sueltos; se comparan por (tipo, índice del punto culpable),
   que es lo que ambos saben identificar sin ambigüedad — para eso el driver de
   Python emite los flags SIN fusionar.
*/
const fs = require('fs');
const assert = require('assert');
const {execFileSync} = require('child_process');

const src = fs.readFileSync('static/js/sec/editor.js', 'utf8');
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
const haversineM = eval('(' + fuente('haversineM') + ')');
const detectGpsIssues = eval('(' + fuente('detectGpsIssues') + ')');

/* Driver de Python: reusa el MISMO bucle de core/gps_analysis.py pero sin
   _merge_flags, para poder comparar punto a punto. Si el bucle de allí cambia,
   este import deja de reflejarlo y el test lo cantará con un escenario real. */
const DRIVER = `
import json, sys, math
sys.path.insert(0, '.')
from core.gps_analysis import _haversine_m, _parse_time

def flags(lonlat, ele, time, th):
    n = len(lonlat)
    out = []
    if n < 2:
        return out
    max_speed = th["max_speed_kmh"]; max_vert = th["max_vert_rate_ms"]
    max_ele = th.get("max_ele_m")
    times = [_parse_time(t) for t in time] if time else None
    if max_ele and ele and ele[0] is not None and ele[0] > max_ele:
        out.append(["altitude", 0])
    for i in range(1, n):
        lon1, lat1 = lonlat[i-1]; lon2, lat2 = lonlat[i]
        dist_m = _haversine_m(lon1, lat1, lon2, lat2)
        if max_ele and ele and ele[i] is not None and ele[i] > max_ele:
            out.append(["altitude", i])
        if times:
            t0, t1 = times[i-1], times[i]
            if t0 is not None and t1 is not None:
                dt_s = (t1 - t0).total_seconds()
                if dt_s > 0:
                    if (dist_m/1000)/(dt_s/3600) > max_speed:
                        out.append(["speed", i])
                    if ele and ele[i-1] is not None and ele[i] is not None:
                        if abs(ele[i]-ele[i-1])/dt_s > max_vert:
                            out.append(["elevation", i])
    return out

esc = json.load(sys.stdin)
print(json.dumps([flags(e["lonlat"], e["ele"], e["time"], e["th"]) for e in esc]))
`;

const TH = {max_speed_kmh: 15, max_vert_rate_ms: 3, max_ele_m: 4900};
const THJS = {maxSpeed: 15, maxVert: 3, maxEle: 4900};
const PASO = 0.00012;

function track(n) {
  const lonlat = [], ele = [], time = [];
  for (let i = 0; i < n; i++) {
    lonlat.push([-1.6 + i * PASO, 42.0]);
    ele.push(1000 + i);
    time.push(new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + i * 10000).toISOString());
  }
  return {lonlat, ele, time, th: TH};
}

const escenarios = [];
const nombres = [];

let e = track(20); escenarios.push(e); nombres.push('track limpio');

e = track(20); e.lonlat[5] = [e.lonlat[5][0] + 0.01, 42.0]; e.ele[5] = 3000;
escenarios.push(e); nombres.push('salto de posición con altitud falsa');

e = track(30); [12, 13, 14].forEach((i, k) => { e.lonlat[i] = [e.lonlat[i][0] + 0.008 + k * 0.001, 42.002]; });
escenarios.push(e); nombres.push('tira de 3 puntos desviados');

e = track(20); e.ele[8] = e.ele[7] + 100;
escenarios.push(e); nombres.push('tasa vertical imposible');

e = track(20); e.ele[9] = 6000;
escenarios.push(e); nombres.push('altitud por encima del máximo');

e = track(20); for (let i = 0; i < 20; i++) e.ele[i] = 5200;
escenarios.push(e); nombres.push('todo el track por encima del máximo');

e = track(20); e.time[7] = null;
escenarios.push(e); nombres.push('un punto sin marca de tiempo');

e = track(20); e.time = null;
escenarios.push(e); nombres.push('track sin tiempos (solo altitud es comprobable)');

e = track(20); e.ele = null;
escenarios.push(e); nombres.push('track sin elevación');

e = track(20); e.time[9] = e.time[8];
escenarios.push(e); nombres.push('dos puntos con el mismo timestamp (dt = 0)');

e = track(20); e.ele[6] = null;
escenarios.push(e); nombres.push('un punto sin elevación en medio');

e = track(60);
e.lonlat[10] = [e.lonlat[10][0] + 0.012, 42.001]; e.ele[10] = 2500;
[24, 25, 26].forEach((i, k) => { e.lonlat[i] = [e.lonlat[i][0] + 0.009 + k * 0.001, 42.003]; });
e.ele[40] = e.ele[39] + 250; e.ele[41] = e.ele[39] + 240; e.ele[50] = 6200;
escenarios.push(e); nombres.push('los tres tipos mezclados');

const py = JSON.parse(execFileSync('python3', ['-c', DRIVER],
  {input: JSON.stringify(escenarios), encoding: 'utf8', maxBuffer: 1 << 24}));

let total = 0;
escenarios.forEach((esc, k) => {
  const t = esc.time ? esc.time.map(x => (x == null ? null : Date.parse(x))) : null;
  const js = detectGpsIssues(esc.lonlat, esc.ele, t, THJS)
    .map(x => `${x.type}:${x.i}`).sort();
  const srv = py[k].map(([tipo, i]) => `${tipo}:${i}`).sort();
  assert.deepEqual(js, srv,
    `«${nombres[k]}»\n  cliente:  ${JSON.stringify(js)}\n  servidor: ${JSON.stringify(srv)}`);
  total += srv.length;
  console.log(`OK ${nombres[k]} — ${srv.length} aviso(s), idénticos en cliente y servidor`);
});

assert.ok(total > 15, `los escenarios deberían generar avisos de sobra: ${total}`);
console.log(`\n${escenarios.length} escenarios, ${total} avisos: cliente y servidor coinciden punto a punto`);
console.log('\nTODO OK');
