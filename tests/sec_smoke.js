/* Prueba de humo del módulo de sección.  Ejecutar:  node tests/sec_smoke.js

   DOM mínimo: solo lo que necesita el bloque de nivel superior de sec/detalle.js.
   Objetivo: que cargar el módulo contra los ids REALES del markup no explote. */
const fs=require('fs');
const html=fs.readFileSync('templates/sec/detalle.html','utf8');
const ids=new Set([...html.matchAll(/id="([^"{}]+)"/g)].map(m=>m[1]));
const classes=new Set([...html.matchAll(/class="([^"{}]+)"/g)].flatMap(m=>m[1].split(/\s+/)));
const seen=[];
function node(sel){
  return {sel, id:(sel.match(/#([\w-]+)/)||[])[1]||'',
    classList:{add(){},remove(){},toggle(){},contains(){return true;}},
    style:{}, dataset:{}, files:[], value:'', textContent:'', innerHTML:'',
    addEventListener(t){seen.push(sel+':'+t);}, appendChild(){}, remove(){},
    closest(){return node('.panel');}, querySelector(){return node('x');},
    querySelectorAll(){return [];},
    getContext(){return {};}, click(){}, };
}
global.window={SEC:{}, addEventListener(){}, scrollTo(){}};
global.document={
  querySelector(sel){
    const idm=sel.match(/#([\w-]+)\s*$/);
    if(idm && !ids.has(idm[1])) { throw new Error('id inexistente en el markup: '+sel); }
    const clm=sel.match(/\.([\w-]+)\s*$/);
    if(clm && !classes.has(clm[1])) { throw new Error('clase inexistente en el markup: '+sel); }
    return node(sel);
  },
  getElementById(id){ if(!ids.has(id)) throw new Error('getElementById inexistente: '+id); return node('#'+id); },
  createElement(){return node('nuevo');},
  addEventListener(t){seen.push('document:'+t);},
  head:{appendChild(){}}, title:'',
};
global.Store={isOnline:()=>true, patch:async()=>({ok:true}), route:async()=>null,
              putDetail:async()=>{}, syncNow(){}};
global.$=s=>document.querySelector(s);
global.toast=()=>{}; global.esc=s=>s; global.fmtKm=()=>'0'; global.fmtDur=()=>'0';
global.fmtDate=()=>'';
/* Formatos del rediseño (viven en static/js/core/chrome.js, que aquí no se carga). */
global.fmtNum=()=>'0'; global.fmtHM=()=>'0:00'; global.fmtHMS=()=>'0:00:00';
global.fmtPace=()=>'0:00 /km'; global.fmtDateLong=()=>''; global.fmtDateTime=()=>''; global.ACTIVITIES=[]; global.activityOf=()=>null;
global.iconSvg=()=>''; global.buildStyle=()=>({}); global.basemapNames=()=>[];
global.defaultBasemap=()=>'Topográfico'; global.applyBasemap=()=>{};
global.OFFLINE_LAYER='Offline (local)'; global.Chart=function(){}; global.maplibregl={};
global.go=()=>{};

eval(fs.readFileSync('static/js/sec/detalle.js','utf8'));
const api=Object.keys(window.SEC.detalle||{}).sort();
console.log('módulo cargado sin errores');
console.log('SEC.detalle:', api.join(', '));
console.log('listeners registrados al cargar:', seen.join(' | '));
if(typeof window.SEC.detalle.mount!=='function') throw new Error('mount no es función');
if(typeof window.SEC.detalle.unmount!=='function') throw new Error('unmount no es función');
// unmount debe poder llamarse sin haber montado nada (el router lo hace al salir)
window.SEC.detalle.unmount();
console.log('unmount() en frío: OK');
