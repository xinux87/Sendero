/* Código compartido entre plantillas (sin build step: se carga con <script src>
   desde base.html, ANTES del script inline de cada página).
   Aquí solo vive JS puro sin Jinja: los datos por página (current, R, …) se
   siguen inyectando en cada plantilla. Si tocas ACTIVITIES o BASEMAP_TILES,
   recuerda que lo usan app.html, sendero.html, editor.html y plan_detalle.html. */

/* ── actividades ── */
const ACTIVITIES=[
  {id:'senderismo',label:'Senderismo',color:'#c97a3a',symbol:`
    <circle cx="13" cy="8.5" r="1.6" fill="white"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="15.5" y2="11"  stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="10.5" y2="13.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="10.5" y1="13.5" x2="9.5" y2="18"  stroke="white" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15.5" y2="19"  stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="10.5" y2="18"  stroke="white" stroke-width="1.8" stroke-linecap="round"/>
  `},
  {id:'bicicleta',label:'Bicicleta',color:'#3a9ed8',symbol:`
    <circle cx="9.5"  cy="17.5" r="2.3" fill="none" stroke="white" stroke-width="1.6"/>
    <circle cx="16.5" cy="17.5" r="2.3" fill="none" stroke="white" stroke-width="1.6"/>
    <path d="M9.5,17.5 L13,14 L16.5,17.5 M13,14 L11.5,17.5"
      stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="15.5" cy="10" r="1.5" fill="white"/>
    <line x1="15.5" y1="11.5" x2="13" y2="14"   stroke="white" stroke-width="1.7" stroke-linecap="round"/>
    <line x1="14.5" y1="12.5" x2="12" y2="13.5" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
  `},
  {id:'caminata',label:'Caminata',color:'#5ab87a',symbol:`
    <circle cx="13" cy="8.5" r="1.6" fill="white"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="15.5" y2="13.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="12"   x2="10.5" y2="13"   stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15"   y2="19"   stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="11"   y2="18.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
  `},
  {id:'correr',label:'Correr',color:'#e05252',symbol:`
    <circle cx="14" cy="8" r="1.6" fill="white"/>
    <line x1="14" y1="9.6"  x2="12" y2="15"   stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="16" y2="10"   stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="10" y2="13"   stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="12" y1="15"   x2="15.5" y2="19" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="12" y1="15"   x2="9.5"  y2="18" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
  `},
  {id:'esqui',label:'Esquí',color:'#9b6fd4',symbol:`
    <circle cx="13" cy="8" r="1.6" fill="white"/>
    <line x1="13" y1="9.6"  x2="11" y2="14.5"  stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="12" y1="11.5" x2="8.5" y2="13"   stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="12" y1="11.5" x2="16.5" y2="13"  stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="8.5"  y1="13" x2="8"   y2="17.5" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="16.5" y1="13" x2="17"  y2="17.5" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="11"   y1="14.5" x2="9.5" y2="18" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="11"   y1="14.5" x2="13" y2="18"  stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="7.5"  y1="19"   x2="12" y2="19"  stroke="white" stroke-width="2"   stroke-linecap="round"/>
    <line x1="12"   y1="19"   x2="16" y2="19"  stroke="white" stroke-width="2"   stroke-linecap="round"/>
  `},
  {id:'otros',label:'Otros',color:'#e0559e',symbol:`
    <circle cx="13" cy="8.5" r="1.6" fill="white"/>
    <line x1="13" y1="10.1" x2="13" y2="15.5" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="8.5" y2="11"  stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="11.5" x2="17.5" y2="11" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="11"   y2="19" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="15.5" x2="15"   y2="19" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
  `},
];
function activityOf(id){return ACTIVITIES.find(a=>a.id===id);}
function iconSvg(a,size=26){
  return `<svg width="${size}" height="${size}" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
    <circle cx="13" cy="13" r="11" fill="${a.color}" stroke="#101a14" stroke-width="2.5"/>
    ${a.symbol}
  </svg>`;}
function genericIconSvg(size=26){
  return `<svg width="${size}" height="${size}" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
    <circle cx="13" cy="13" r="11" fill="#2c4435" stroke="#101a14" stroke-width="2.5"/>
    <circle cx="13" cy="10" r="2" fill="#8aa394"/>
    <line x1="13" y1="12.5" x2="13" y2="17"   stroke="#8aa394" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="13" y1="14"   x2="11" y2="15.5" stroke="#8aa394" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="13" y1="14"   x2="15" y2="15.5" stroke="#8aa394" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="13" y1="17"   x2="11.5" y2="19" stroke="#8aa394" stroke-width="1.6" stroke-linecap="round"/>
    <line x1="13" y1="17"   x2="14.5" y2="19" stroke="#8aa394" stroke-width="1.6" stroke-linecap="round"/>
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

/* ── capas base de mapa (MapLibre) ── */
const BASEMAP_TILES={
  'Topográfico':['https://a.tile.opentopomap.org/{z}/{x}/{y}.png','https://b.tile.opentopomap.org/{z}/{x}/{y}.png','https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
  'Callejero':  ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png','https://b.tile.openstreetmap.org/{z}/{x}/{y}.png','https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'],
  'Satélite':   ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  'Oscuro':     ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png']
};
function buildStyle(capa){
  return {version:8,sources:{basemap:{type:'raster',tiles:BASEMAP_TILES[capa]||BASEMAP_TILES['Callejero'],tileSize:256,maxzoom:19}},
          layers:[{id:'basemap',type:'raster',source:'basemap'}]};
}
