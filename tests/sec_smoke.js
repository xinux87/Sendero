/* Prueba de humo de los módulos de sección.  Ejecutar:  node tests/sec_smoke.js

   DOM mínimo: solo lo que necesita el bloque de nivel superior de sec/<sec>.js.
   Objetivo: que cargar el módulo contra los ids y clases REALES de su markup no
   explote — pilla un selector que ya no existe, que es el fallo que no se nota
   hasta que alguien abre esa vista.

   Cubre `detalle` y `plan`. Para añadir otra sección, mete su nombre en SECCIONES:
   basta que su markup esté en templates/sec/<sec>.html, su JS en
   static/js/sec/<sec>.js, y que publique window.SEC.<sec>.{mount,unmount}. */
const fs=require('fs');
const SECCIONES=['detalle','plan'];

function probar(sec){
  /* El documento real es shell.html CON la sección incluida dentro, y parte de lo
     que toca un módulo vive en el shell (las acciones de cabecera por sección,
     `data-sec-actions`: #immich-btn y compañía). Buscar solo en sec/<sec>.html
     daría por inexistentes ids que sí están en pantalla. */
  const html=fs.readFileSync(`templates/sec/${sec}.html`,'utf8')
            +fs.readFileSync('templates/shell.html','utf8');
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
                plan:async()=>null, putDetail:async()=>{}, patchPlanRow:async()=>{},
                syncNow(){}};
  global.$=s=>document.querySelector(s);
  global.toast=()=>{}; global.esc=s=>s; global.fmtKm=()=>'0'; global.fmtDur=()=>'0';
  global.fmtDate=()=>'';
  /* Formatos del rediseño (viven en static/js/core/chrome.js, que aquí no se carga). */
  global.fmtNum=()=>'0'; global.fmtHM=()=>'0:00'; global.fmtHMS=()=>'0:00:00';
  global.fmtPace=()=>'0:00 /km'; global.fmtDateLong=()=>''; global.fmtDateTime=()=>''; global.ACTIVITIES=[]; global.activityOf=()=>null;
  global.iconSvg=()=>''; global.buildStyle=()=>({}); global.basemapNames=()=>[];
  global.defaultBasemap=()=>'Topográfico'; global.applyBasemap=()=>{};
  global.OFFLINE_LAYER='Offline (local)'; global.Chart=function(){}; global.maplibregl={};
  /* viven en static/shared.js y static/js/core/tiles.js, que aquí no se cargan */
  global.addGeolocate=()=>null; global.geoTracking=()=>false;
  global.Tiles={downloadForTrack(){}, statusForTrack(){}};
  global.go=()=>{};
  /* Sin red: las secciones piden /api/config y similares al montar. Devolver una
     respuesta "no ok" en vez de dejar `fetch` sin definir es lo que hace que ese
     camino se recorra entero (y con los globales de ESTA sección puestos, ver el
     drenaje de abajo). */
  global.fetch=async()=>({ok:false, status:503, json:async()=>({})});

  eval(fs.readFileSync(`static/js/sec/${sec}.js`,'utf8'));
  const mod=window.SEC[sec]||{};
  console.log(`\n[${sec}] módulo cargado sin errores`);
  console.log(`SEC.${sec}:`, Object.keys(mod).sort().join(', '));
  console.log('listeners registrados al cargar:', seen.join(' | '));
  if(typeof mod.mount!=='function') throw new Error(`${sec}: mount no es función`);
  if(typeof mod.unmount!=='function') throw new Error(`${sec}: unmount no es función`);
  // unmount debe poder llamarse sin haber montado nada (el router lo hace al salir)
  mod.unmount();
  console.log('unmount() en frío: OK');
  /* Y un mount() con el Store devolviendo null: recorre el camino de "no se pudo
     cargar", que toca los ids de todos los paneles de la vista. Es lo que hace que
     este test pille un panel nuevo cuyo id no está en el markup. */
  return Promise.resolve(mod.mount({id: 'inexistente'}, {}))
    /* Los módulos disparan trabajo sin esperarlo (cargar /api/config y repintar
       después). Se le da un turno para que termine ANTES de instalar los globales
       de la sección siguiente: si no, ese repintado buscaría los ids de esta
       sección en el markup de la otra y el fallo sería del test, no del código. */
    .then(() => new Promise(r => setTimeout(r, 10)))
    .then(() => {
      console.log('mount() sin datos: OK');
      mod.unmount();
    });
}

SECCIONES.reduce((p, sec) => p.then(() => probar(sec)), Promise.resolve())
  .catch(e => { console.error('FALLO:', e.message); process.exit(1); });
