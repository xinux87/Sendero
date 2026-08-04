/* Código compartido entre plantillas (sin build step: se carga con <script src>
   desde base.html, ANTES del script inline de cada página).
   Aquí solo vive JS puro sin Jinja. Si tocas ACTIVITIES o BASEMAP_TILES, recuerda
   que lo usan app.html y editor.html (que siguen con su JS inline) y las secciones
   de la SPA static/js/sec/*.js (detalle, plan). */

/* ── actividades ── */
const ACTIVITIES=[
  {id:'senderismo',label:'Senderismo',color:'#e8863c',symbol:`
    <circle cx="13" cy="8.5" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="15.5" y2="11"  stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="10.5" y2="13.5" stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="10.5" y1="13.5" x2="9.5" y2="18"  stroke="#0b120e" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15.5" y2="19"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="10.5" y2="18"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  `},
  {id:'bicicleta',label:'Bicicleta',color:'#3d9be9',symbol:`
    <circle cx="9.5"  cy="17.5" r="2.3" fill="none" stroke="#0b120e" stroke-width="1.6"/>
    <circle cx="16.5" cy="17.5" r="2.3" fill="none" stroke="#0b120e" stroke-width="1.6"/>
    <path d="M9.5,17.5 L13,14 L16.5,17.5 M13,14 L11.5,17.5"
      stroke="#0b120e" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="15.5" cy="10" r="1.5" fill="#0b120e"/>
    <line x1="15.5" y1="11.5" x2="13" y2="14"   stroke="#0b120e" stroke-width="1.7" stroke-linecap="round"/>
    <line x1="14.5" y1="12.5" x2="12" y2="13.5" stroke="#0b120e" stroke-width="1.4" stroke-linecap="round"/>
  `},
  {id:'caminata',label:'Caminata',color:'#43b97f',symbol:`
    <circle cx="13" cy="8.5" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="15.5" y2="13.5" stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="10.5" y2="13"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15"   y2="19"   stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="11"   y2="18.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  `},
  {id:'correr',label:'Correr',color:'#e34b4b',symbol:`
    <circle cx="14" cy="8" r="1.6" fill="#0b120e"/>
    <line x1="14" y1="9.6"  x2="12" y2="15"   stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="16" y2="10"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="10" y2="13"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="12" y1="15"   x2="15.5" y2="19" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="12" y1="15"   x2="9.5"  y2="18" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  `},
  {id:'esqui',label:'Esquí',color:'#a86ee0',symbol:`
    <circle cx="13" cy="8" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="9.6"  x2="11" y2="14.5"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="12" y1="11.5" x2="8.5" y2="13"   stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="12" y1="11.5" x2="16.5" y2="13"  stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="8.5"  y1="13" x2="8"   y2="17.5" stroke="#0b120e" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="16.5" y1="13" x2="17"  y2="17.5" stroke="#0b120e" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="11"   y1="14.5" x2="9.5" y2="18" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="11"   y1="14.5" x2="13" y2="18"  stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="7.5"  y1="19"   x2="12" y2="19"  stroke="#0b120e" stroke-width="2"   stroke-linecap="round"/>
    <line x1="12"   y1="19"   x2="16" y2="19"  stroke="#0b120e" stroke-width="2"   stroke-linecap="round"/>
  `},
  {id:'otros',label:'Otros',color:'#e055c0',symbol:`
    <circle cx="13" cy="8.5" r="1.6" fill="#0b120e"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="8.5" y2="11"  stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="17.5" y2="11" stroke="#0b120e" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="11"   y2="19" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15"   y2="19" stroke="#0b120e" stroke-width="1.8" stroke-linecap="round"/>
  `},
];
function activityOf(id){return ACTIVITIES.find(a=>a.id===id);}
function iconSvg(a,size=26){
  return `<svg width="${size}" height="${size}" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
    <circle cx="13" cy="13" r="11" fill="${a.color}" stroke="#0b120e" stroke-width="2.5"/>
    ${a.symbol}
  </svg>`;}
function genericIconSvg(size=26){
  return `<svg width="${size}" height="${size}" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
    <circle cx="13" cy="13" r="11" fill="#1c2c22" stroke="#0b120e" stroke-width="2.5"/>
    <circle cx="13" cy="10" r="2" fill="#8b9a8f"/>
    <line x1="13" y1="12.5" x2="13" y2="17"   stroke="#8b9a8f" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="14"   x2="11" y2="15.5" stroke="#8b9a8f" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="13" y1="14"   x2="15" y2="15.5" stroke="#8b9a8f" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="13" y1="17"   x2="11.5" y2="19" stroke="#8b9a8f" stroke-width="1.6" stroke-linecap="round"/>
    <line x1="13" y1="17"   x2="14.5" y2="19" stroke="#8b9a8f" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;}
/* Registra los iconos de actividad como imágenes MapLibre ('act-<id>'). */
function _loadActImages(map){
  return Promise.all(ACTIVITIES.map(a=>new Promise(resolve=>{
    const img=new Image(26,26);
    img.onload=()=>{try{map.addImage('act-'+a.id,img);}catch(e){}resolve();};
    img.onerror=()=>resolve();
    img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(iconSvg(a,26));
  })));
}

/* ── capas base de mapa (MapLibre) ──
   Las 4 capas raster son de terceros y SOLO funcionan con internet. La 5ª capa,
   OFFLINE_LAYER, la sirve Sendero desde un archivo PMTiles propio en /data
   (Ajustes → Mapas) y es la única que funciona sin conexión: cachear en masa
   teselas de OSM/OpenTopoMap/Esri va contra sus políticas de uso. */
const BASEMAP_TILES={
  'Topográfico':['https://a.tile.opentopomap.org/{z}/{x}/{y}.png','https://b.tile.opentopomap.org/{z}/{x}/{y}.png','https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
  'Callejero':  ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png','https://b.tile.openstreetmap.org/{z}/{x}/{y}.png','https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'],
  'Satélite':   ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  'Oscuro':     ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png']
};
const OFFLINE_LAYER='Offline (local)';
/* Atribución por capa. Va en la fuente para que el AttributionControl de cada
   mapa la muestre: son teselas de terceros y su licencia obliga a citarlas
   (antes solo la ponían los mapas de app.html, a mano). */
const BASEMAP_ATTRIB={
  'Topográfico':'© <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> · OSM',
  'Callejero':  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  'Satélite':   '© Esri · OSM',
  'Oscuro':     '© CartoDB · OSM'
};

/* Config de mapas inyectada por el servidor en <body data-map-cfg> (la genera
   map_cfg() en api/maps.py: offline_url, offline_maxzoom, offline_attribution,
   default_layer). Va en el HTML y no por fetch para que el primer mapa se pinte
   sin esperar una petición, y para que funcione sin conexión. Sin ella, la capa
   offline simplemente no aparece en el selector. */
const MAP_CFG=(()=>{
  try{ return JSON.parse(document.body.dataset.mapCfg||'{}'); }catch(e){ return {}; }
})();
function offlineMapUrl(){ return MAP_CFG.offline_url||''; }
function hasOfflineMap(){ return !!offlineMapUrl(); }

/* Planificador externo (Ajustes → Editor), inyectado igual que MAP_CFG. Lo usa
   "Dibujar ruta nueva" en Mis Planes. */
const PLANNER_URL=(document.body.dataset.plannerUrl||'').trim()||'https://brouter.de/brouter-web';

/* Expresión de color de línea por actividad para MapLibre. La comparten los dos
   mapas que dibujan tracks de varias rutas a la vez (dashboard y Mis Rutas): si
   cada uno la construyera por su cuenta, una actividad nueva en ACTIVITIES se
   pintaría de gris en uno de ellos. */
function activityLineColor(){
  const expr=['match',['get','activity']];
  ACTIVITIES.forEach(a=>{expr.push(a.id,a.color);});
  expr.push('#888888');
  return expr;
}

/* Registra el protocolo pmtiles:// en MapLibre una sola vez (idempotente: lo
   llaman todas las vistas). Si pmtiles.js no cargó, no rompe nada. */
let _pmtilesReady=false;
function ensurePmtiles(){
  if(_pmtilesReady) return true;
  if(typeof pmtiles==='undefined'||typeof maplibregl==='undefined') return false;
  try{
    maplibregl.addProtocol('pmtiles',new pmtiles.Protocol().tile);
    _pmtilesReady=true;
  }catch(e){ /* ya registrado */ _pmtilesReady=true; }
  return _pmtilesReady;
}

/* Nombres de capa disponibles, en el orden del selector. */
function basemapNames(){
  const names=Object.keys(BASEMAP_TILES);
  if(hasOfflineMap()) names.push(OFFLINE_LAYER);
  return names;
}

/* Capa por defecto: la de Ajustes → Mapas si es válida; si no, `fallback` (cada
   vista tiene el suyo: el dashboard siempre ha sido oscuro y el mapa de Mis
   Rutas satélite, así que no comparten default). */
function defaultBasemap(fallback){
  const d=MAP_CFG.default_layer;
  if(d&&basemapNames().includes(d))return d;
  return (fallback&&basemapNames().includes(fallback))?fallback:'Topográfico';
}

/* ¿Esta capa necesita internet? (para avisar en la UI cuando no hay conexión) */
function basemapNeedsNet(capa){ return capa!==OFFLINE_LAYER; }

function buildStyle(capa){
  if(capa===OFFLINE_LAYER&&hasOfflineMap()&&ensurePmtiles()){
    // Teselas raster propias en PMTiles. Un basemap vectorial necesitaría además
    // glyphs y sprite locales; con raster no hace falta ninguno de los dos, así
    // que funciona sin conexión sin más piezas.
    return {version:8,
      sources:{basemap:{type:'raster',tiles:['pmtiles://'+offlineMapUrl()+'/{z}/{x}/{y}'],
                        tileSize:256,maxzoom:MAP_CFG.offline_maxzoom||14,
                        attribution:MAP_CFG.offline_attribution||'Mapa local'}},
      layers:[{id:'basemap',type:'raster',source:'basemap'}]};
  }
  return {version:8,sources:{basemap:{type:'raster',tiles:BASEMAP_TILES[capa]||BASEMAP_TILES['Callejero'],
                                     tileSize:256,maxzoom:19,
                                     attribution:BASEMAP_ATTRIB[capa]||BASEMAP_ATTRIB['Callejero']}},
          layers:[{id:'basemap',type:'raster',source:'basemap'}]};
}

/* ── ubicación del usuario ────────────────────────────────────────────────────
   Botón "Mi ubicación" de TODOS los mapas: centra el mapa donde esté el usuario
   y lo sigue mientras no arrastre. Es el GeolocateControl de MapLibre, no un
   control propio, y eso importa por una razón concreta: el punto y el círculo de
   precisión los pinta con marcadores DOM, no con capas de estilo, así que
   sobreviven al setStyle() de applyBasemap (regla 15) sin que cada vista tenga
   que repintar nada al cambiar de capa base.
   Dos cosas hay que poner a mano:
   - los textos: MapLibre solo los traduce por la opción `locale` del mapa, y son
     seis mapas — mejor una vez aquí (ver _geoLabels);
   - el aviso de error, porque la geolocalización solo existe en contexto seguro
     (https o localhost): en LAN por http el navegador la deniega, y el motivo no
     se ve en ningún sitio de la página. */
const GEO_TXT={
  ok:'Mi ubicación',
  nosop:'Este navegador no puede dar la ubicación',
  http:'La ubicación necesita HTTPS (o localhost): por http el navegador la bloquea',
  denied:'Ubicación denegada: dale permiso al sitio en el navegador',
  unavail:'No se ha podido determinar la ubicación (sin señal GPS)',
  timeout:'La ubicación ha tardado demasiado; inténtalo otra vez',
};
/* ¿este mapa está siguiendo ahora mismo la ubicación del usuario?
   Lo preguntan los re-encuadres AUTOMÁTICOS de las secciones (un filtro, una
   sincronización que repinta la lista, el 'load' del mapa): mientras se sigue la
   ubicación la cámara es del usuario, y un fitBounds() no solo se la robaba —
   además tumbaba el seguimiento a "segundo plano", porque MapLibre entiende
   cualquier movimiento ajeno como que el usuario se ha ido a mirar otra cosa.
   Los encuadres que el usuario PIDE (botón "centrar en la ruta") no miran esto. */
const _geoTracking=new WeakSet();
function geoTracking(map){ return !!map&&_geoTracking.has(map); }

function addGeolocate(map,position='top-right'){
  if(typeof maplibregl==='undefined'||!maplibregl.GeolocateControl) return null;
  const ctrl=new maplibregl.GeolocateControl({
    positionOptions:{enableHighAccuracy:true,timeout:10000,maximumAge:10000},
    trackUserLocation:true,showUserLocation:true,showAccuracyCircle:true,
    // maxZoom para que en un GPS impreciso no se cuele hasta z20 sobre nada
    fitBoundsOptions:{maxZoom:15,duration:700},
  });
  ctrl.on('trackuserlocationstart',()=>_geoTracking.add(map));
  ctrl.on('trackuserlocationend',()=>_geoTracking.delete(map));
  ctrl.on('error',e=>{
    if(typeof toast!=='function') return;
    // En contexto no seguro el navegador responde PERMISSION_DENIED igual que si
    // el usuario hubiera dicho no: hay que distinguirlo antes de por el código.
    if(!window.isSecureContext){ toast(GEO_TXT.http); return; }
    toast(e&&e.code===1?GEO_TXT.denied:e&&e.code===3?GEO_TXT.timeout:GEO_TXT.unavail);
  });
  map.addControl(ctrl,position);
  _geoLabels(map);
  return ctrl;
}
/* Pasa a español el título del botón. MapLibre lo escribe cuando termina de
   comprobar si el navegador soporta geolocalización, y eso es ASÍNCRONO (el
   botón todavía no existe al volver de addControl), así que se reescribe cuando
   pase, no una sola vez. Se deja de escuchar a los 5 s: después ya no cambia. */
function _geoLabels(map){
  const apply=()=>{
    const btn=map.getContainer().querySelector('.maplibregl-ctrl-geolocate');
    if(!btn) return;
    const t=btn.disabled?GEO_TXT.nosop:GEO_TXT.ok;
    if(btn.title!==t){ btn.title=t; btn.setAttribute('aria-label',t); }
  };
  apply();
  if(typeof MutationObserver==='undefined') return;
  const obs=new MutationObserver(apply);
  obs.observe(map.getContainer(),{subtree:true,childList:true,
                                 attributes:true,attributeFilter:['title','disabled']});
  setTimeout(()=>obs.disconnect(),5000);
}

/* Cambia la capa base de un mapa ya creado.
   OJO: setTiles() solo vale entre capas del mismo tipo de fuente. Al entrar o
   salir de la capa offline (pmtiles:// con otro maxzoom) hay que reconstruir el
   estilo, y eso borra las capas/fuentes de datos del mapa — por eso se avisa por
   el evento 'sendero:basemap' para que cada vista vuelva a pintar lo suyo. */
function applyBasemap(map,capa){
  const st=buildStyle(capa);
  const src=map.getSource('basemap');
  const wasOffline=!!(src&&(src.tiles||[]).some(t=>String(t).startsWith('pmtiles://')));
  const willOffline=capa===OFFLINE_LAYER;
  if(src&&wasOffline===willOffline){
    src.setTiles(st.sources.basemap.tiles);
    return false;               // no hubo recarga de estilo
  }
  map.setStyle(st);
  map.once('styledata',()=>map.fire('sendero:basemap',{capa}));
  return true;                  // el llamador debe repintar sus capas
}

/* ── Escala de pendiente (verde → rojo) ─────────────────────────────────────
   Colorea la traza del mapa y el perfil de elevación del detalle de una RUTA y
   del de un PLAN por lo empinado del terreno: verde llano, rojo pared. La usan
   sec/detalle.js y sec/plan.js, y por eso vive aquí y no en una de las dos.

   Cuatro decisiones, para no rediscutirlas:
   - **Pendiente ABSOLUTA**: bajar al 25 % pinta igual que subirlo. Es lo duro del
     terreno, no el esfuerzo de ascenso; y así "verde = llano, rojo = empinado" se
     lee sin pensar.
   - **Ventana de SLOPE_WINDOW_M metros**, centrada: entre dos puntos seguidos de
     un GPS la pendiente es ruido puro (±40 % en llano). Es el mismo motivo por el
     que _elevSub() mide la pendiente máxima sobre tramos de ≥30 m.
   - Los colores son de la paleta del proyecto (verde de `caminata`, ámbar
     `--pr-yellow`, naranja de `senderismo`, rojo `--gr-red`) más una lima para el
     escalón que faltaba. Van aquí, en el JS que pinta, como el resto de colores
     de serie: en el CSS de las secciones no debe haber hex sueltos (regla 9).
   - Los cortes (0·5·10·15·25) son los de las escalas de cicloturismo y montaña,
     y son los que enseña la leyenda: si los cambias, la leyenda sigue sola. */
const SLOPE_SCALE = [
  [0,  [ 67, 185, 127]],   // #43b97f  llano
  [5,  [163, 201,  78]],   // #a3c94e  suave
  [10, [227, 178,  60]],   // #e3b23c  exigente (--pr-yellow)
  [15, [232, 134,  60]],   // #e8863c  duro
  [25, [226,  73,  44]],   // #e2492c  muy duro (--gr-red)
];
const SLOPE_WINDOW_M = 50;

/* |pendiente %| → color, interpolando entre las paradas de la escala. Con `a`
   devuelve rgba() (lo usa el relleno del perfil, que va translúcido). */
function slopeColor(pct, a){
  const p=Math.abs(Number(pct)||0), S=SLOPE_SCALE;
  const salida=c => a==null ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${a})`;
  if(p<=S[0][0]) return salida(S[0][1]);
  for(let i=1;i<S.length;i++){
    if(p<=S[i][0]){
      const [x,cx]=S[i-1], [y,cy]=S[i], t=(p-x)/(y-x);
      return salida(cx.map((v,k)=>Math.round(v+(cy[k]-v)*t)));
    }
  }
  return salida(S[S.length-1][1]);
}

/* Perfil de pendientes alineado 1:1 con la serie de elevación [{d,e}] (d en km,
   e en m): devuelve un array de porcentajes, uno por punto. Cada uno se mide
   sobre una ventana centrada de al menos `win` metros, no contra el punto de al
   lado: sin eso el color parpadearía con el ruido del GPS en vez de describir el
   terreno. */
function slopeProfile(elev, win){
  const n=(elev||[]).length, out=new Array(n).fill(0);
  if(n<2) return out;
  const half=(win||SLOPE_WINDOW_M)/2/1000;      // en km, a cada lado
  let a=0, b=0;
  for(let i=0;i<n;i++){
    while(a<i   && elev[i].d-elev[a].d>half)   a++;
    while(a>0   && elev[i].d-elev[a].d<half)   a--;
    while(b<n-1 && elev[b].d-elev[i].d<half)   b++;
    while(b>i   && elev[b].d-elev[i].d>half)   b--;
    /* En los extremos la ventana centrada se queda a medias (en el punto 0 solo
       hay lado derecho), y media ventana da el doble de ruido justo donde
       empieza el track. Se estira por el lado que quede. */
    let a2=a, b2=b;
    while(elev[b2].d-elev[a2].d < half*2 && (a2>0 || b2<n-1)){
      if(a2>0) a2--; else b2++;
    }
    if(b2<=a2){ out[i]=i>0?out[i-1]:0; continue; }
    const dx=(elev[b2].d-elev[a2].d)*1000;
    out[i]=dx>0 ? (elev[b2].e-elev[a2].e)/dx*100 : 0;
  }
  return out;
}

/* Media de |pendiente| en `B` cubos de igual LONGITUD del track.

   Por DISTANCIA y no por índice, y esto es el meollo: la serie de elevación NO
   es uniforme en distancia. El GPX muestrea por tiempo, así que una subida lenta
   acumula puntos y una bajada rápida casi ninguno, y `resample()` del modo ligero
   toma un paso constante en índice, que conserva ese sesgo. Medido en rutas
   reales, el punto nº 50 % de la serie puede estar en el km 37 % del track: quien
   pinte "el color del punto k/n en la fracción k/n del eje" acaba con la subida
   pintada encima de un llano. Lo usan la traza del mapa y el perfil, para que los
   dos digan lo mismo en el mismo sitio. */
function slopeBuckets(elev, B){
  const n=(elev||[]).length;
  if(n<2 || B<1) return null;
  const d0=elev[0].d, total=elev[n-1].d-d0;
  if(!(total>0)) return null;
  const prof=slopeProfile(elev);
  const suma=new Array(B).fill(0), cuenta=new Array(B).fill(0);
  for(let i=0;i<n;i++){
    const k=Math.min(B-1, Math.floor((elev[i].d-d0)/total*B));
    suma[k]+=Math.abs(prof[i]); cuenta[k]++;
  }
  const out=new Array(B); let prev=0;
  for(let k=0;k<B;k++){ out[k]=cuenta[k] ? suma[k]/cuenta[k] : prev; prev=out[k]; }
  return out;
}

/* Expresión `line-gradient` para la traza del mapa, a partir de la serie de
   elevación. Devuelve null si no hay datos suficientes (entonces la traza se
   queda del color de la actividad, como antes).

   La fracción de cada parada es d/dTotal, o sea la MISMA magnitud que
   ['line-progress'] salvo por la deformación de Mercator, que en un track de
   unos kilómetros es de milésimas. La fuente necesita `lineMetrics:true` o
   MapLibre ignora el degradado.

   La pendiente se promedia en SLOPE_BUCKETS cubos de igual longitud antes de
   emitir paradas, y las de igual color se funden: sin eso saldría una parada por
   punto de la serie (cientos o miles) y la expresión sería impagable. */
const SLOPE_Q = 1.5;          // cuantización del color, en puntos de %
const SLOPE_BUCKETS = 200;    // tope de paradas de la expresión
function slopeGradientExpr(elev){
  const n=(elev||[]).length;
  if(n<2) return null;
  const d0=elev[0].d, total=elev[n-1].d-d0;
  if(!(total>0)) return null;
  const B=Math.max(2, Math.min(SLOPE_BUCKETS, n));
  const cubos=slopeBuckets(elev, B);
  if(!cubos) return null;
  const expr=['interpolate',['linear'],['line-progress']];
  let ult=null;
  for(let k=0;k<B;k++){
    const q=Math.round(Math.min(cubos[k],40)/SLOPE_Q)*SLOPE_Q;
    if(q===ult) continue;                               // mismo color: no hace parada
    const f=k===0 ? 0 : (k+0.5)/B;
    if(expr.length>3 && f<=expr[expr.length-2]) continue;
    expr.push(f, slopeColor(q));
    ult=q;
  }
  /* Una sola parada = toda la ruta con la misma pendiente (una rampa constante,
     o un llano). MapLibre necesita dos, así que se repite el color: la traza sale
     entera de ese color, que es justo lo que toca. */
  if(expr.length===5) expr.push(1, expr[4]);
  return expr.length>=7 ? expr : null;
}

/* Degradado de canvas HORIZONTAL para el perfil de elevación, con la misma
   escala que la traza del mapa: opaco para la línea (`a` sin valor) y
   translúcido para el relleno. Lo usan sec/detalle.js y sec/plan.js.

   Dos cosas que costaron un fallo cada una:
   - El color de cada parada sale de `slopeBuckets` (por DISTANCIA); tomarlo del
     punto nº k/n de la serie desplazaba el color casi un kilómetro en una ruta de
     siete, y salía la subida pintada sobre el llano.
   - Es un degradado de canvas y NO `segment.borderColor`: con estilos por tramo
     Chart.js parte también el RELLENO y deja una costura vertical en cada punto
     (~80 rayas en un perfil normal).
   Se sitúa con la escala X del gráfico, no con el chartArea, para que cada color
   caiga justo encima de su kilómetro. */
const SLOPE_CHART_BUCKETS = 64;   // en 700 px el ojo no distingue más
function slopeChartGradient(chart, elev, a, cubosYa){
  const {ctx, chartArea, scales} = chart;
  if(!chartArea || !(elev||[]).length) return 'transparent';
  const x0=scales.x.getPixelForValue(elev[0].d);
  const x1=scales.x.getPixelForValue(elev[elev.length-1].d);
  if(!(x1>x0)) return 'transparent';
  const B=Math.max(2, Math.min(SLOPE_CHART_BUCKETS, elev.length));
  const cubos=cubosYa || slopeBuckets(elev, B);
  if(!cubos) return slopeColor(0, a);
  const g=ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, slopeColor(cubos[0], a));
  for(let k=0;k<B;k++) g.addColorStop((k+0.5)/B, slopeColor(cubos[k], a));
  g.addColorStop(1, slopeColor(cubos[B-1], a));
  return g;
}

/* Pone el degradado de pendiente en el dataset del perfil como un VALOR concreto,
   y lo rehace solo cuando cambia el ancho del gráfico.

   NO es un refinamiento, es la diferencia entre que el hover vaya fluido o no:
   Chart.js resuelve las opciones **scriptables una vez POR PUNTO**, así que con
   `borderColor: c => slopeChartGradient(...)` y un perfil de 510 puntos salían
   **1020 recálculos del perfil de pendientes por repintado**… y el hover repinta en
   cada mousemove. Medido con una ruta de 3000 puntos: 114 ms por movimiento del
   ratón (~9 fps). Como valor concreto se calcula una vez y se reutiliza.

   Va en `afterLayout` porque ahí ya están las escalas y el chartArea, y todavía no
   se han resuelto las opciones de los elementos: el valor nuevo entra en el mismo
   ciclo de update. */
function slopeGradientPlugin(elev){
  const n=(elev||[]).length;
  const cubos=n>1 ? slopeBuckets(elev, Math.max(2, Math.min(SLOPE_CHART_BUCKETS, n))) : null;
  let x0=null, x1=null;
  return {id:'slopeGradient',
    afterLayout(chart){
      if(!cubos) return;
      const nx0=chart.scales.x.getPixelForValue(elev[0].d);
      const nx1=chart.scales.x.getPixelForValue(elev[n-1].d);
      if(nx0===x0 && nx1===x1) return;          // mismo ancho: el degradado vale
      x0=nx0; x1=nx1;
      const ds=chart.data.datasets[0];
      ds.borderColor    = slopeChartGradient(chart, elev, undefined, cubos);
      ds.backgroundColor= slopeChartGradient(chart, elev, .34, cubos);
    }};
}

/* Leyenda de la escala: la tira de color con sus cortes. La pintan los dos
   detalles, y sale de SLOPE_SCALE para que no se pueda quedar desfasada. */
function slopeLegendHtml(){
  const S=SLOPE_SCALE, max=S[S.length-1][0];
  const paradas=S.map(([p,c])=>`rgb(${c.join(',')}) ${p/max*100}%`).join(',');
  const marcas=S.map(([p],i)=>{
    const x=p/max*100;
    // la primera marca se alinea a la izquierda y la última a la derecha, o se
    // saldrían media etiqueta por cada punta de la tira
    const tr=i===0?'0':(i===S.length-1?'-100%':'-50%');
    return `<i style="left:${x}%;transform:translateX(${tr})">${p}${i===S.length-1?'&nbsp;%+':''}</i>`;
  }).join('');
  return `<span class="sl-lbl">Pendiente</span><span class="sl-scale">`
       + `<span class="sl-bar" style="background:linear-gradient(90deg,${paradas})"></span>`
       + `<span class="sl-ticks">${marcas}</span></span>`;
}
