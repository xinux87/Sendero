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
