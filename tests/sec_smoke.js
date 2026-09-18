/* Prueba de humo de los módulos de sección.  Ejecutar:  node tests/sec_smoke.js

   DOM mínimo: solo lo que necesita el bloque de nivel superior de sec/<sec>.js.
   Objetivo: que cargar el módulo contra los ids y clases REALES de su markup no
   explote — pilla un selector que ya no existe, que es el fallo que no se nota
   hasta que alguien abre esa vista.

   Cubre `detalle`, `plan`, `editor` y `unir` (los dos últimos se montan DOS
   veces: como ruta y como plan, que es lo que hace el router según la URL). Los
   ids no se escriben aquí: se sacan del markup, así que un panel que se va (el
   «Con qué unir» de `unir`, hoy el popup #un-pick-modal y el chip #un-pick-chip)
   se comprueba solo — lo que sí hay que dar es el DOBLE que necesite el camino
   nuevo (ver `focus`/`select` en el nodo de juguete). Para
   añadir otra sección, mete su nombre en SECCIONES:
   basta que su markup esté en templates/sec/<sec>.html, su JS en
   static/js/sec/<sec>.js, y que publique window.SEC.<sec>.{mount,unmount}. */
const fs=require('fs');
const SECCIONES=['detalle','plan','editor','unir'];

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
      /* `style.setProperty` lo usa la sección `unir` para pasarle a un marcador
         DOM el color leído de los tokens (`--c`): un elemento inline necesita un
         color literal, como MapLibre. */
      style:{setProperty(){}, removeProperty(){}}, dataset:{}, files:[],
      value:'', textContent:'', innerHTML:'',
      /* `checked` lo leen las casillas (el «Recortar solape», #un-trim, de la
         sección `unir`); sin él, leerla daría undefined y no false.
         `disabled`/`title` los ESCRIBE esa misma sección en los toggles
         «Invertir A/B» cuando la propuesta elegida usa esa entrada por trozos
         («parcial»). */
      checked:false, disabled:false, title:'',
      /* La sección `unir` mide el <canvas> de cada perfil fuente para traducir
         un arrastre a kilómetros (modo «Montaje»): sin esto, leerlo daría
         undefined en vez de un rectángulo y el arrastre no se podría enganchar. */
      width:600, height:110,
      getBoundingClientRect(){return {left:0,top:0,width:600,height:110,
        right:600,bottom:110,x:0,y:0};},
      /* Los usa el popup «con qué unir» de la sección `unir` (#un-pick-modal):
         al abrirse, el foco va al buscador. */
      focus(){}, select(){},
      addEventListener(t){seen.push(sel+':'+t);}, appendChild(){}, remove(){},
      closest(){return node('.panel');}, querySelector(){return node('x');},
      querySelectorAll(){return [];},
      /* Contexto 2D de juguete: la sección `unir` dibuja en un <canvas> las
         flechas de sentido de su previsualización (_arrowImage). */
      getContext(){return {beginPath(){},moveTo(){},lineTo(){},closePath(){},
        fill(){},stroke(){},getImageData(){return {width:1,height:1,data:[]};}};},
      click(){}, };
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
  /* `routes`/`planned` los usa sec/unir.js para su lista de candidatos (del
     Store, no de la red). Vacías: recorre el camino de «no hay otras». */
  global.Store={isOnline:()=>true, patch:async()=>({ok:true}), route:async()=>null,
                plan:async()=>null, putDetail:async()=>{}, patchPlanRow:async()=>{},
                routes:async()=>[], planned:async()=>[], syncNow(){}};
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
  /* huecos entre segmentos del track (static/shared.js) */
  global.addGapLayers=()=>0; global.gapFeatures=()=>[];
  /* escala de pendiente (static/shared.js): la usan los dos perfiles */
  global.slopeColor=()=>'rgb(0,0,0)'; global.slopeProfile=()=>[];
  global.slopeGradientExpr=()=>null; global.slopeLegendHtml=()=>'';
  global.slopeBuckets=()=>null; global.slopeChartGradient=()=>'transparent';
  global.slopeGradientPlugin=()=>({id:'slopeGradient'});
  global.Tiles={downloadForTrack(){}, statusForTrack(){}};
  global.go=()=>{};
  /* Los tokens de base.html, leídos del :root: la sección `unir` los necesita
     para los marcadores de inicio y fin (un marcador DOM y MapLibre necesitan un
     color literal, no una variable CSS). */
  global.getComputedStyle=()=>({getPropertyValue:()=>''});
  /* Preferencias de sesión: la sección `unir` recuerda ahí su modo (Automático
     o Montaje). En Node no existe; el código se guarda con `typeof`, pero con el
     doble puesto se recorre el camino de verdad. */
  const _ss=new Map();
  global.sessionStorage={getItem:k=>(_ss.has(k)?_ss.get(k):null),
    setItem:(k,v)=>{_ss.set(k,String(v));}, removeItem:k=>{_ss.delete(k);}};
  /* Lo usa `unir` para pedirle al mapa que se remida cuando aparecen o se van
     los paneles del modo «Montaje». */
  global.requestAnimationFrame=fn=>setTimeout(fn,0);
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
    })
    /* `editor` y `unir` sirven para DOS entidades (una ruta y un plan, ver `K`
       en sec/editor.js y sec/unir.js): montarlas también como plan recorre sus
       textos y sus ids, que es justo lo que este test sabe comprobar. */
    .then(() => (sec !== 'editor' && sec !== 'unir') ? null
      : Promise.resolve(mod.mount({id: 'inexistente', kind: 'plan'}, {}))
          .then(() => new Promise(r => setTimeout(r, 10)))
          .then(() => { console.log('mount() como plan: OK'); mod.unmount(); }));
}

SECCIONES.reduce((p, sec) => p.then(() => probar(sec)), Promise.resolve())
  .catch(e => { console.error('FALLO:', e.message); process.exit(1); });
