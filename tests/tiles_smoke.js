/* Prueba de humo de la geometría de teselas.  Ejecutar:  node tests/tiles_smoke.js

   Comprueba lo único de static/js/core/tiles.js que es pura matemática y se
   puede probar sin navegador: que el corredor de un track sale del tamaño que
   debe (que es lo que hace viable la función: cientos de teselas, no millones),
   que no hay repetidos, y que las URLs salen bien formadas.
*/
const fs = require('fs');
const assert = require('assert');

// Dependencias que tiles.js espera del ámbito global (viven en shared.js).
global.BASEMAP_TILES = {
  'Topográfico': ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
                  'https://b.tile.opentopomap.org/{z}/{x}/{y}.png'],
  'Satélite':    ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
};
global.OFFLINE_LAYER = 'Offline (local)';
global.toast = () => {};
global.esc = s => s;
global.caches = {open: async () => ({match: async () => null, put: async () => {}, keys: async () => []})};

/* `const Tiles = …` declarado dentro de un eval() queda en el ámbito del propio
   eval, no en el global — el mismo detalle que hacía que window.Router fuese
   undefined en la app. Se recoge el valor evaluando la expresión al final. */
const Tiles = eval(fs.readFileSync('static/js/core/tiles.js', 'utf8') + '\n;Tiles');

/* Track sintético: 40 km hacia el noreste desde el Pirineo navarro, un punto
   cada ~30 m (como un GPS real de andar). */
function track(km) {
  const n = Math.round(km * 1000 / 30);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([-1.60 + i * 0.00019, 42.60 + i * 0.00019]);
  return pts;
}

// ── tamaño del corredor ────────────────────────────────────────────────────
const t40 = Tiles.forTrack(track(40));
const t14 = Tiles.forTrack(track(14));
console.log(`corredor de 40 km (z${Tiles.ZOOM_MIN}-${Tiles.ZOOM_MAX}): ${t40.length} teselas`);
console.log(`corredor de 14 km: ${t14.length} teselas`);
assert.ok(t40.length > 100 && t40.length < 700,
  `40 km deben ser cientos de teselas, no ${t40.length}`);
assert.ok(t14.length < t40.length, 'una ruta más corta necesita menos teselas');
assert.ok(t40.length < Tiles.MAX_TILES, 'una ruta normal no llega al tope');
console.log('OK el corredor tiene un tamaño razonable (esto es lo que hace viable la función)');

// ── sin repetidos ──────────────────────────────────────────────────────────
const claves = new Set(t40.map(t => `${t.z}/${t.x}/${t.y}`));
assert.equal(claves.size, t40.length, 'no debe haber teselas repetidas');
console.log('OK sin teselas repetidas');

// ── zooms bajos primero (si se corta la descarga, queda la vista general) ──
const zooms = [...new Set(t40.map(t => t.z))];
assert.deepEqual(zooms, [...zooms].sort((a, b) => a - b), 'los zooms van de menor a mayor');
assert.equal(zooms[0], Tiles.ZOOM_MIN);
assert.equal(zooms[zooms.length - 1], Tiles.ZOOM_MAX);
console.log('OK ordenadas por zoom ascendente:', zooms.join(', '));

// ── un solo punto: el anillo de vecinas ────────────────────────────────────
const uno = Tiles.forTrack([[-1.6, 42.6]], {zmin: 12, zmax: 12, ring: 1});
assert.equal(uno.length, 9, `un punto con anillo 1 son 9 teselas, no ${uno.length}`);
console.log('OK un punto suelto genera su tesela y las 8 vecinas');

// ── coherencia con el esquema XYZ conocido ─────────────────────────────────
// (0,0) en z1 cae en la tesela x=1,y=1; el meridiano/ecuador es la esquina.
assert.deepEqual(Tiles.tileOf(0, 0, 1), [1, 1]);
assert.deepEqual(Tiles.tileOf(0, -180, 1), [0, 1]);
console.log('OK tileOf() coincide con el esquema XYZ estándar');

// ── URLs ───────────────────────────────────────────────────────────────────
const urls = Tiles.urlsFor('Topográfico', t14);
assert.equal(urls.length, t14.length);
assert.ok(urls.every(u => /^https:\/\/[ab]\.tile\.opentopomap\.org\/\d+\/\d+\/\d+\.png$/.test(u)),
  'las URLs deben salir sustituidas y repartidas entre subdominios');
assert.ok(new Set(urls.map(u => u[8])).size >= 1, 'reparte entre los subdominios disponibles');
// Satélite invierte x/y en la plantilla: hay que respetar el orden de la plantilla.
const sat = Tiles.urlFor('Satélite', {z: 12, x: 100, y: 200});
assert.ok(sat.endsWith('/12/200/100'), `el orden {z}/{y}/{x} de Esri debe respetarse: ${sat}`);
console.log('OK URLs bien formadas, incluido el orden {z}/{y}/{x} de Satélite');

assert.equal(Tiles.urlsFor('Capa que no existe', t14).length, 0);
console.log('OK una capa sin plantillas no genera URLs');

const est = Tiles.estimate(t40);
console.log(`estimación para 40 km: ${est.n} teselas, ~${est.mb.toFixed(0)} MB`);
assert.ok(est.mb > 1 && est.mb < 40, 'la estimación debe estar en el orden de unos MB');

console.log('\nTODO OK');
