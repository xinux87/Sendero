/* Sección `editor`: editor de rutas. Portado de la app multipágina
   (`git show v0.7.1:templates/editor.html`).
   Markup en templates/sec/editor.html, CSS en static/css/editor.css.

   Es la última de las 6 vistas que entra en el shell, y la más delicada: de este
   archivo depende la PARIDAD CLIENTE/SERVIDOR de las operaciones (doOp() aquí,
   apply_ops() en core/editing.py). Por eso el cuerpo se movió literal desde la
   plantilla: si añades una op, impleméntala en los dos sitios y comprueba que la
   misma secuencia da las mismas coordenadas.

   Lo que sí cambia respecto a la plantilla:

   - `R` (nombre, versión, umbral GPS, avisos, dem_enabled) ya no lo inyecta
     Jinja: lo pide mount() a GET /api/routes/<public_id>/editor.
   - El editor NO funciona sin conexión, y es a propósito: opera con el estado
     GUARDADO en el servidor y cada guardado lleva `base_version` para detectar
     conflictos. Encolar eso sería inventarse decisiones del servidor (regla del
     outbox en store.js). Sin red, mount() lo dice y no monta.
   - unmount() destruye el mapa, las 2 gráficas y todos los marcadores; y si hay
     cambios sin guardar, un listener en fase de captura pide confirmación antes
     de dejar que el router cambie de sección (antes bastaba `beforeunload`,
     porque salir del editor era siempre una recarga de documento).

   Contrato: mount(params, opts) / unmount(). params.id = public_id. */
(() => {
  'use strict';

  let _tok = 0, _detailsBound = false;
  const visible = () => {
    const el = document.getElementById('sec-editor');
    return !!el && !el.classList.contains('hidden');
  };
    let R = null;   // metadatos de la ruta (GET /api/routes/<id>/editor)

  // Colores derivados de ACTIVITIES (static/shared.js): una sola fuente de verdad.
  const ACT_COLORS = Object.fromEntries(ACTIVITIES.map(a=>[a.id,a.color]));
    // Antes era una const calculada al cargar la página; ahora R llega por
    // fetch en mount(), así que el color se resuelve en cada uso.
    const lineColor = () => (R && ACT_COLORS[R.activity_type]) || '#e2492c';

  /* ── estado ─────────────────────────────────────────────────────────────── */
  let P = null;            // respuesta de /points {lonlat, ele, time, hr, segments, version, n}
  let idxMap = null;       // Int32Array: índices ORIGINALES vivos, en orden actual
  let cur = [];            // coords [lon,lat] del estado actual (derivado de idxMap)
  let cumM = null;         // Float64Array distancia acumulada (m) del estado actual
  let undoStack = [], redoStack = [];   // {idxMap, op}
  let opsList = [];        // ops pendientes desde el último guardado (con .desc)
  let selA = null, selB = null;         // índices del estado actual
  let handleA = null, handleB = null;   // markers draggables
  let map = null, chart = null;
  let speedChart = null;
  let mode = 'select';                  // 'select' (tramos A–B) | 'verts' (editar puntos)
  // Valores editados sin guardar, por índice ORIGINAL (move_point / set_ele);
  // los puntos insertados se añaden al final de los arrays de P.
  let posOverride = new Map(), eleOverride = new Map();
  let dragVert = null, suppressLineClick = false;
  let spikePreviewData = null, spikeItems = null, simpKeep = null, speedErrIdxs = null;
  let speedFixPlan = null; // {moves:[[i,lon,lat[,ele]],…], drops:[i,…]} de planSpeedFix()
  let wpts = [], wptMarkers = [];      // waypoints del estado actual + sus markers
  const EMPTY_FC = {type:'FeatureCollection',features:[]};
  let timeMs = null;       // Date.parse de P.time por índice ORIGINAL (null si no hay)
  let mkStart = null, mkEnd = null;
  let baseStats = null;    // stats del estado cargado, para los deltas

  function haversineM(la1,lo1,la2,lo2){
    const R2=6371000,r=Math.PI/180,dLa=(la2-la1)*r,dLo=(lo2-lo1)*r;
    const a=Math.sin(dLa/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLo/2)**2;
    return 2*R2*Math.asin(Math.sqrt(a));
  }

  /* ── detalles (nombre + dispositivo) ──────────────────────────────────────
     Era una IIFE que corría al cargar la página; ahora la llama mount() la
     primera vez (los listeners se enganchan una sola vez, ver _detailsBound). */
  function initDetails(){
    const nIn=document.getElementById('det-name');
    const dIn=document.getElementById('det-device');
    const btn=document.getElementById('det-save');
    nIn.value = R.name || '';
    dIn.value = R.device || '';
    const dirty=()=>{
      const changed = nIn.value.trim()!==(R.name||'') || dIn.value.trim()!==(R.device||'');
      btn.disabled = !changed;
    };
    nIn.addEventListener('input',dirty);
    dIn.addEventListener('input',dirty);
    dirty();
  }

  async function saveDetails(){
    const nIn=document.getElementById('det-name');
    const dIn=document.getElementById('det-device');
    const btn=document.getElementById('det-save');
    const name=nIn.value.trim(), device=dIn.value.trim();
    if(!name){toast('El nombre no puede estar vacío');nIn.focus();return;}
    const payload={};
    if(name!==(R.name||''))   payload.name=name;
    if(device!==(R.device||''))payload.device=device;
    if(!Object.keys(payload).length)return;
    btn.disabled=true;
    let res;
    try{
      res=await fetch(`/api/routes/${R.public_id}`,{method:'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    }catch(e){toast('Error de red al guardar');btn.disabled=false;return;}
    if(!res.ok){const j=await res.json().catch(()=>({}));toast(j.error||'No se pudo guardar');btn.disabled=false;return;}
    R.name=name; R.device=device;
    Store.syncNow({force:true});   // el listado se pone al día por el delta
    document.getElementById('ed-name').textContent=name;
    /* La URL es /Sendero/<public_id>/editor: renombrar ya no la cambia (antes iba
       por nombre y había que reescribirla con history.replaceState). */
    toast('Detalles guardados');
  }

  async function loadPoints(){
    let res;
    try{ res = await fetch(`/api/routes/${R.public_id}/points`); }
    catch(e){ document.getElementById('ed-loading').textContent = 'Error de red al cargar los puntos.'; return; }
    if(!res.ok){
      const j = await res.json().catch(()=>({}));
      document.getElementById('ed-loading').textContent = j.error || 'No se pudieron cargar los puntos.';
      return;
    }
    P = await res.json();
    R.version = P.version;
    document.getElementById('ed-version').textContent = 'v' + P.version;
    timeMs = P.time ? P.time.map(t => t ? Date.parse(t) : null) : null;
    idxMap = Int32Array.from({length: P.n}, (_, i) => i);
    undoStack = []; redoStack = []; opsList = [];
    posOverride = new Map(); eleOverride = new Map();
    wpts = P.waypoints || [];
    document.getElementById('ed-loading').classList.add('hidden');
    document.getElementById('ed-body').classList.remove('hidden');
    if(!map) initMap();
    applyState(true);
    baseStats = currentStats();
    renderStats();
    loadVersions();
    renderIssues();
  }

  /* ── estado derivado ────────────────────────────────────────────────────── */
  function eleOf(oi){
    if(eleOverride.has(oi)) return eleOverride.get(oi);
    return P.ele ? P.ele[oi] : null;
  }

  function rebuild(){
    const n = idxMap.length;
    cur = new Array(n);
    cumM = new Float64Array(n);
    for(let i=0;i<n;i++){
      const oi = idxMap[i];
      cur[i] = posOverride.get(oi) || P.lonlat[oi];
      if(i>0){
        const a=cur[i-1], b=cur[i];
        cumM[i] = cumM[i-1] + haversineM(a[1],a[0],b[1],b[0]);
      }
    }
  }

  function currentStats(){
    const n = idxMap.length;
    let asc=0, desc=0, lastE=null;
    if(P.ele){
      for(let i=0;i<n;i++){
        const e = eleOf(idxMap[i]);
        if(e==null) continue;
        if(lastE!=null){
          const d = e - lastE;
          if(d > 2) asc += d; else if(d < -2) desc += -d;
        }
        lastE = e;
      }
    }
    return {dist: cumM.length?cumM[cumM.length-1]:0, asc, desc, n};
  }

  function fmt(n,dec=0){return n.toLocaleString('es-ES',{maximumFractionDigits:dec});}

  function renderStats(){
    const s = currentStats();
    const dl = baseStats ? s.dist - baseStats.dist : 0;
    const delta = Math.abs(dl) > 1
      ? `<div class="delta">${dl>0?'+':'−'}${fmt(Math.abs(dl)/1000,2)} km</div>` : '';
    const dn = baseStats ? s.n - baseStats.n : 0;
    const deltaN = dn !== 0 ? `<div class="delta">${dn>0?'+':'−'}${fmt(Math.abs(dn))} pts</div>` : '';
    document.getElementById('ed-stats').innerHTML = `
      <div class="ed-stat"><div class="v">${fmt(s.dist/1000,2)} <small>km</small></div><div class="l">Distancia</div>${delta}</div>
      <div class="ed-stat"><div class="v">${fmt(s.n)} <small>pts</small></div><div class="l">Puntos</div>${deltaN}</div>
      <div class="ed-stat"><div class="v">+${fmt(s.asc)} <small>m</small></div><div class="l">Desnivel +</div></div>
      <div class="ed-stat"><div class="v">−${fmt(s.desc)} <small>m</small></div><div class="l">Desnivel −</div></div>`;
  }

  function applyState(fit=false){
    rebuild();
    clearSel(false);
    if(map && map.getSource('ruta')){
      map.getSource('ruta').setData({type:'Feature',geometry:{type:'LineString',coordinates:cur}});
      if(mkStart) mkStart.setLngLat(cur[0]);
      if(mkEnd) mkEnd.setLngLat(cur[cur.length-1]);
    }
    // Repintar la selección (ya vacía): sin esto la banda amarilla y la opacidad
    // atenuada se quedan con la geometría ANTERIOR y parece que el mapa no refresca.
    paintSel();
    // El rango total puede haber cambiado: recortar la ventana de zoom si sobresale
    if(viewMin!=null){
      const t=totalKm();
      if(viewMin>=t){viewMin=null;viewMax=null;}
      else if(viewMax>t){viewMax=t;}
    }
    closeSimplify();closeSpikes();closeSpeedFix();   // previews de herramientas: obsoletos tras cambiar el estado
    closeShift();closeMerge();
    updateVerts();
    renderWpts();
    updateIssueOverlays();
    renderIssues();
    renderChart();
    renderSpeedChart();
    renderStats();
    updateButtons();
    if(fit && map) fitRoute();
  }

  function updateButtons(){
    const n = idxMap.length;
    const iA = effA(), iB = effB();
    document.getElementById('op-trim-start').disabled = !(iA != null && iA > 0);
    document.getElementById('op-trim-end').disabled   = !(iB != null && iB < n-1);
    document.getElementById('op-del-range').disabled  = !(selA != null && selB != null);
    // dividir: requiere solo A (sin B, para que el corte sea inequívoco),
    // interior, y sin cambios pendientes (opera sobre el estado guardado)
    document.getElementById('op-split').disabled =
      !(selA != null && selB == null && selA >= 1 && selA <= n-2 && !opsList.length);
    document.getElementById('op-clear-sel').disabled  = selA == null && selB == null;
    document.getElementById('undo-btn').disabled = !undoStack.length;
    document.getElementById('redo-btn').disabled = !redoStack.length;
    document.getElementById('save-btn').disabled = !opsList.length;
  }

  /* A efectivo = el manejador de menor índice; B el de mayor (da igual cuál arrastres). */
  function effA(){ if(selA==null && selB==null) return null;
    if(selA!=null && selB!=null) return Math.min(selA,selB); return selA ?? selB; }
  function effB(){ if(selA==null && selB==null) return null;
    if(selA!=null && selB!=null) return Math.max(selA,selB); return selA ?? selB; }

  /* ── mapa ───────────────────────────────────────────────────────────────── */
  /* buildStyle y defaultBasemap viven en static/shared.js. El editor no tiene
     selector de capas: usa la de Ajustes → Mapas (offline incluida). */

  function fitRoute(){
    if(!cur.length) return;
    let mnLo=Infinity,mxLo=-Infinity,mnLa=Infinity,mxLa=-Infinity;
    cur.forEach(([lo,la])=>{
      if(lo<mnLo)mnLo=lo;if(lo>mxLo)mxLo=lo;
      if(la<mnLa)mnLa=la;if(la>mxLa)mxLa=la;
    });
    map.fitBounds([[mnLo,mnLa],[mxLo,mxLa]],{padding:50,duration:400});
  }

  function nearestIdx(lon,lat){
    const cos0=Math.cos(lat*Math.PI/180);
    let bi=0,bd=Infinity;
    for(let i=0;i<cur.length;i++){
      const dx=(cur[i][0]-lon)*cos0, dy=cur[i][1]-lat, d=dx*dx+dy*dy;
      if(d<bd){bd=d;bi=i;}
    }
    return bi;
  }

  function initMap(){
    map = new maplibregl.Map({container:'edmap',style:buildStyle(defaultBasemap()),
      center:cur.length?cur[0]:[-3.7,40.4],zoom:12,attributionControl:false});
    map.addControl(new maplibregl.AttributionControl({compact:true}),'bottom-right');
    map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
    map.addControl({onAdd(){
      const c=document.createElement('div');c.className='maplibregl-ctrl maplibregl-ctrl-group';
      const b=document.createElement('button');b.innerHTML='⤢';b.title='Centrar en la ruta';
      b.style.cssText='font-size:16px;cursor:pointer;border:none;background:none';
      b.onclick=()=>fitRoute();c.appendChild(b);return c;
    },onRemove(){}},'top-left');

    map.on('load',()=>{
      map.addSource('ruta',{type:'geojson',
        data:{type:'Feature',geometry:{type:'LineString',coordinates:cur}}});
      map.addLayer({id:'ruta-linea',type:'line',source:'ruta',
        layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':lineColor(),'line-width':4,'line-opacity':0.9}});
      // capa invisible ancha para que el click sea fácil de acertar
      map.addLayer({id:'ruta-hit',type:'line',source:'ruta',
        paint:{'line-color':'#000','line-width':16,'line-opacity':0}});
      map.addSource('sel',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
      map.addLayer({id:'sel-linea',type:'line',source:'sel',
        layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'#e3b23c','line-width':6,'line-opacity':0.95}});
      // ghost de simplificación (línea blanca discontinua con el resultado)
      map.addSource('ghost',{type:'geojson',data:EMPTY_FC});
      map.addLayer({id:'ghost-line',type:'line',source:'ghost',
        paint:{'line-color':'#ffffff','line-width':2,'line-dasharray':[2,2],'line-opacity':0.95}});
      // vértices editables (modo "Editar puntos"; visibles al acercarse)
      map.addSource('verts',{type:'geojson',data:EMPTY_FC});
      map.addLayer({id:'verts-circ',type:'circle',source:'verts',minzoom:13,
        layout:{visibility:'none'},
        paint:{'circle-radius':['interpolate',['linear'],['zoom'],13,3,16,6.5],
          'circle-color':'#ffffff','circle-stroke-color':'#0b120e','circle-stroke-width':1.5,
          'circle-opacity':0.95}});
      // preview del punto arrastrándose (línea a los vecinos)
      map.addSource('drag-preview',{type:'geojson',data:EMPTY_FC});
      map.addLayer({id:'drag-preview-line',type:'line',source:'drag-preview',
        paint:{'line-color':'#e3b23c','line-width':2.5,'line-dasharray':[1.5,1.5]}});
      // preview de "corregir velocidad excesiva" (puntos a eliminar, en rojo)
      map.addSource('speederr',{type:'geojson',data:EMPTY_FC});
      map.addLayer({id:'speederr-circ',type:'circle',source:'speederr',
        paint:{'circle-radius':5,'circle-color':'#e05252',
          'circle-stroke-color':'#0b120e','circle-stroke-width':1.5,'circle-opacity':0.95}});
      // tramos con avisos GPS (rojo translúcido bajo la línea principal)
      map.addSource('issues',{type:'geojson',data:EMPTY_FC});
      map.addLayer({id:'issues-line',type:'line',source:'issues',
        layout:{'line-join':'round','line-cap':'round'},
        paint:{'line-color':'#e05252','line-width':9,'line-opacity':0.45}},'ruta-linea');

      mkStart = new maplibregl.Marker({color:'#e3b23c'}).setLngLat(cur[0]).addTo(map);
      mkEnd = new maplibregl.Marker({color:'#e0e0e0'}).setLngLat(cur[cur.length-1]).addTo(map);
      fitRoute();

      map.on('click','ruta-hit',e=>{
        if(suppressLineClick){suppressLineClick=false;return;}
        if(mode==='verts'){
          if(e.originalEvent.shiftKey)return;  // Shift+click = waypoint (handler general)
          // click sobre un vértice → lo gestiona su propio handler (mover/borrar)
          const vhits=map.queryRenderedFeatures(e.point,{layers:['verts-circ']});
          if(vhits.length)return;
          insertAt(e.lngLat);
          return;
        }
        const idx=nearestIdx(e.lngLat.lng,e.lngLat.lat);
        if(selA==null) setSel(idx,selB);
        else if(selB==null) setSel(selA,idx);
        else {
          // ambos puestos: mueve el manejador más cercano al click
          const dA=Math.abs(idx-selA), dB=Math.abs(idx-selB);
          if(dA<=dB) setSel(idx,selB); else setSel(selA,idx);
        }
      });
      map.on('mouseenter','ruta-hit',()=>{map.getCanvas().style.cursor=mode==='verts'?'copy':'pointer';});
      map.on('mouseleave','ruta-hit',()=>{map.getCanvas().style.cursor='';});
      // Click fuera de la línea → deseleccionar (el click sobre la línea ya lo
      // gestiona el handler de 'ruta-hit'; aquí solo se limpia si no la tocó).
      // En modo "Editar puntos", Shift+click en cualquier sitio añade un waypoint.
      map.on('click',e=>{
        if(mode==='verts' && e.originalEvent.shiftKey){
          addWpt(e.lngLat);
          return;
        }
        if(selA==null && selB==null)return;
        const hits=map.queryRenderedFeatures(e.point,{layers:['ruta-hit']});
        if(!hits.length)clearSel();
      });

      // ── modo "Editar puntos": arrastrar vértice / Alt+click borra / click inserta ──
      map.on('mousedown','verts-circ',e=>{
        if(mode!=='verts'||e.originalEvent.altKey||e.originalEvent.button!==0)return;
        e.preventDefault();
        dragVert={i:e.features[0].properties.i,pos:null};
        map.dragPan.disable();
        map.getCanvas().style.cursor='grabbing';
      });
      map.on('mousemove',e=>{
        if(!dragVert)return;
        const i=dragVert.i;
        dragVert.pos=[e.lngLat.lng,e.lngLat.lat];
        const coords=[];
        if(i>0)coords.push(cur[i-1]);
        coords.push(dragVert.pos);
        if(i<cur.length-1)coords.push(cur[i+1]);
        map.getSource('drag-preview').setData(
          {type:'Feature',geometry:{type:'LineString',coordinates:coords}});
      });
      map.on('mouseup',()=>{
        if(!dragVert)return;
        const {i,pos}=dragVert;
        dragVert=null;
        map.dragPan.enable();
        map.getCanvas().style.cursor='';
        map.getSource('drag-preview').setData(EMPTY_FC);
        if(pos){
          suppressLineClick=true;   // el mouseup dispara un click que insertaría un punto
          doOp({op:'move_point',i,lon:pos[0],lat:pos[1],desc:'Movido 1 punto'});
        }
      });
      map.on('click','verts-circ',e=>{
        if(mode!=='verts'||!e.originalEvent.altKey)return;
        if(idxMap.length<=2){toast('La ruta no puede quedar con menos de 2 puntos');return;}
        doOp({op:'delete_points',indices:[e.features[0].properties.i],desc:'Eliminado 1 punto'});
      });
      map.on('mouseenter','verts-circ',()=>{if(mode==='verts'&&!dragVert)map.getCanvas().style.cursor='grab';});
      map.on('mouseleave','verts-circ',()=>{if(!dragVert)map.getCanvas().style.cursor='';});
    });
  }

  /* punto→segmento más cercano para decidir dónde insertar */
  function _segDist2(p,a,b,cos0){
    const ax=a[0]*cos0,ay=a[1],bx=b[0]*cos0,by=b[1],px=p[0]*cos0,py=p[1];
    const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy;
    const t=len2?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/len2)):0;
    const qx=ax+t*dx-px,qy=ay+t*dy-py;
    return qx*qx+qy*qy;
  }
  function insertAt(ll){
    const lon=ll.lng,lat=ll.lat;
    const i=nearestIdx(lon,lat);
    const cos0=Math.cos(lat*Math.PI/180);
    let after;
    if(i===0)after=0;
    else if(i===cur.length-1)after=cur.length-2;
    else{
      const dPrev=_segDist2([lon,lat],cur[i-1],cur[i],cos0);
      const dNext=_segDist2([lon,lat],cur[i],cur[i+1],cos0);
      after=dPrev<=dNext?i-1:i;
    }
    doOp({op:'insert_point',after,lon,lat,desc:'Añadido 1 punto'});
  }

  function updateVerts(){
    if(!map||!map.getSource('verts'))return;
    if(mode==='verts'){
      map.getSource('verts').setData({type:'FeatureCollection',
        features:cur.map((c,i)=>({type:'Feature',geometry:{type:'Point',coordinates:c},properties:{i}}))});
      map.setLayoutProperty('verts-circ','visibility','visible');
    }else{
      map.setLayoutProperty('verts-circ','visibility','none');
      map.getSource('verts').setData(EMPTY_FC);
    }
  }

  function setMode(m){
    if(mode===m)return;
    mode=m;
    clearSel();
    closeSimplify();closeSpikes();closeSpeedFix();
    document.getElementById('mtab-select').classList.toggle('on',m==='select');
    document.getElementById('mtab-verts').classList.toggle('on',m==='verts');
    document.getElementById('ops-select').style.display=m==='select'?'':'none';
    document.getElementById('mode-hint').innerHTML=m==='select'
      ?'Haz click en la línea del mapa para colocar los manejadores <b style="color:#e3b23c">A</b> y <b style="color:#e2492c">B</b>, o arrastra sobre el perfil de elevación. Los manejadores se pueden arrastrar por el track.'
      :'Acércate al track (los puntos aparecen al hacer zoom). <b>Arrastra</b> un punto para moverlo, <b>Alt+click</b> lo elimina, <b>click en la línea</b> inserta un punto nuevo, <b>Shift+click</b> en el mapa añade un waypoint ⚑.';
    updateVerts();
  }

  function makeHandle(cls){
    const el=document.createElement('div');el.className=cls;
    const mk=new maplibregl.Marker({element:el,draggable:true,anchor:'center'});
    let raf=null;
    mk.on('drag',()=>{
      if(raf)return;
      raf=requestAnimationFrame(()=>{
        raf=null;
        const p=mk.getLngLat();
        const idx=nearestIdx(p.lng,p.lat);
        mk.setLngLat(cur[idx]);
        mk._selIdx=idx;
        if(cls==='handle-a')selA=idx;else selB=idx;
        paintSel();
      });
    });
    mk.on('dragend',()=>{
      const p=mk.getLngLat();
      const idx=nearestIdx(p.lng,p.lat);
      mk.setLngLat(cur[idx]);
      if(cls==='handle-a')selA=idx;else selB=idx;
      paintSel();updateButtons();
    });
    return mk;
  }

  function setSel(a,b){
    selA=a;selB=b;
    if(selA!=null){
      if(!handleA){handleA=makeHandle('handle-a');handleA.addTo(map);}
      handleA.setLngLat(cur[selA]);
    } else if(handleA){handleA.remove();handleA=null;}
    if(selB!=null){
      if(!handleB){handleB=makeHandle('handle-b');handleB.addTo(map);}
      handleB.setLngLat(cur[selB]);
    } else if(handleB){handleB.remove();handleB=null;}
    paintSel();updateButtons();
  }

  function paintSel(){
    const iA=effA(),iB=effB();
    const hasRange = iA!=null && iB!=null && iA!==iB && selA!=null && selB!=null;
    if(map && map.getSource('sel')){
      map.getSource('sel').setData(hasRange
        ? {type:'Feature',geometry:{type:'LineString',coordinates:cur.slice(iA,iB+1)}}
        : {type:'FeatureCollection',features:[]});
      if(map.getLayer('ruta-linea'))
        map.setPaintProperty('ruta-linea','line-opacity',hasRange?0.45:0.9);
    }
    if(chart)chart.draw();
    if(speedChart)speedChart.draw();
  }

  function clearSel(repaint=true){
    selA=null;selB=null;
    if(handleA){handleA.remove();handleA=null;}
    if(handleB){handleB.remove();handleB=null;}
    if(repaint){paintSel();updateButtons();}
  }

  /* ── perfil de elevación ────────────────────────────────────────────────── */
  const bandPlugin={id:'selBand',afterDraw(c){
    const iA=effA(),iB=effB();
    if(iA==null||iB==null||iA===iB)return;
    const x1=c.scales.x.getPixelForValue(cumM[iA]/1000);
    const x2=c.scales.x.getPixelForValue(cumM[iB]/1000);
    const ctx=c.ctx,area=c.chartArea;
    ctx.save();
    ctx.beginPath();ctx.rect(area.left,area.top,area.right-area.left,area.bottom-area.top);ctx.clip();
    ctx.fillStyle='rgba(232,196,74,.18)';
    ctx.fillRect(Math.min(x1,x2),area.top,Math.abs(x2-x1),area.bottom-area.top);
    ctx.strokeStyle='#e3b23c';ctx.lineWidth=1.5;
    [x1,x2].forEach(x=>{ctx.beginPath();ctx.moveTo(x,area.top);ctx.lineTo(x,area.bottom);ctx.stroke();});
    ctx.restore();
  }};

  /* ── zoom de las gráficas (rueda; doble click restablece; Shift+arrastre panea) ── */
  let viewMin=null, viewMax=null;   // ventana visible en km (null = todo el track)
  function totalKm(){ return cumM && cumM.length ? cumM[cumM.length-1]/1000 : 1; }
  function xRange(){ return [viewMin ?? 0, viewMax ?? totalKm()]; }
  function applyZoom(){
    const [mn,mx]=xRange();
    // Se re-deciman los datos al rango visible: al acercarse se ve el detalle
    // completo de la zona (clave para poder seleccionar secciones pequeñas).
    if(chart){
      chart.options.scales.x.min=mn;chart.options.scales.x.max=mx;
      chart.data.datasets[0].data=elevData();
      chart.update('none');
    }
    if(speedChart){
      speedChart.options.scales.x.min=mn;speedChart.options.scales.x.max=mx;
      speedChart.data.datasets[0].data=computeSpeedData();
      speedChart.update('none');
    }
  }
  function bindChartZoom(canvas,getChart){
    if(canvas._edZoom)return;canvas._edZoom=true;
    canvas.addEventListener('wheel',ev=>{
      const c=getChart();if(!c)return;
      ev.preventDefault();
      const rect=canvas.getBoundingClientRect();
      const cx=(ev.clientX-rect.left)*(canvas.width/(window.devicePixelRatio||1))/rect.width;
      const [mn,mx]=xRange(), total=totalKm();
      let center=c.scales.x.getValueForPixel(cx);
      if(center==null||isNaN(center))center=(mn+mx)/2;
      center=Math.max(mn,Math.min(center,mx));
      const f=ev.deltaY<0?0.75:1.33;
      const minW=Math.max(total*0.002,0.02);   // hasta ~0.2% del track (mín. 20 m)
      let w=Math.max(minW,Math.min((mx-mn)*f,total));
      const r=(center-mn)/((mx-mn)||1);
      let nmn=center-r*w, nmx=nmn+w;
      if(nmn<0){nmx-=nmn;nmn=0;}
      if(nmx>total){nmn-=(nmx-total);nmx=total;nmn=Math.max(0,nmn);}
      if(w>=total-1e-9){viewMin=null;viewMax=null;}
      else{viewMin=nmn;viewMax=nmx;}
      applyZoom();
    },{passive:false});
    canvas.addEventListener('dblclick',()=>{viewMin=null;viewMax=null;applyZoom();});
  }

  // Zoom por pasos alrededor del centro de la ventana visible: sustituto táctil
  // de la rueda (botones .chart-zoom, visibles solo en @media(hover:none)).
  function edZoomStep(f){
    const [mn,mx]=xRange(), total=totalKm();
    const center=(mn+mx)/2;
    const minW=Math.max(total*0.002,0.02);
    const w=Math.max(minW,Math.min((mx-mn)*f,total));
    let nmn=center-w/2, nmx=nmn+w;
    if(nmn<0){nmx-=nmn;nmn=0;}
    if(nmx>total){nmn-=(nmx-total);nmx=total;nmn=Math.max(0,nmn);}
    if(w>=total-1e-9){viewMin=null;viewMax=null;}
    else{viewMin=nmn;viewMax=nmx;}
    applyZoom();
  }

  function elevData(){
    const [mnV,mxV]=xRange();
    const n=idxMap.length;
    const lo=Math.max(0,kmToIdx(mnV)-1), hi=Math.min(n-1,kmToIdx(mxV)+1);
    const step=Math.max(1,Math.ceil((hi-lo+1)/3000));
    const data=[];
    for(let i=lo;i<=hi;i+=step){
      const e=eleOf(idxMap[i]);
      if(e==null)continue;
      data.push({x:cumM[i]/1000,y:e});
    }
    return data;
  }

  function renderChart(){
    const panel=document.getElementById('profile-panel');
    if(!P.ele){panel.style.display='none';return;}
    panel.style.display='';
    const data=elevData();
    const ctx=document.getElementById('edelev');
    if(chart)chart.destroy();
    chart=new Chart(ctx,{type:'line',plugins:[bandPlugin,issueBandsPlugin],
      data:{datasets:[{data,fill:true,borderColor:'#e2492c',
        backgroundColor:'rgba(210,74,58,.15)',pointRadius:0,borderWidth:2,tension:.3}]},
      options:{animation:false,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{enabled:false}},
        scales:{
          x:{type:'linear',min:xRange()[0],max:xRange()[1],
             title:{display:true,text:'km',color:'#8b9a8f'},ticks:{color:'#8b9a8f',maxTicksLimit:8},grid:{color:'rgba(236,229,216,.07)'}},
          y:{title:{display:true,text:'m',color:'#8b9a8f'},ticks:{color:'#8b9a8f'},grid:{color:'rgba(236,229,216,.07)'}}
        }}});
    bindChartDrag(ctx, () => chart);
    bindChartZoom(ctx, () => chart);
  }

  /* La velocidad se deriva de los tiempos con la misma ventana móvil de 15 s que
     usa analyse_gpx (SPEED_WINDOW_S): se actualiza en vivo al recortar. Con un
     reverse pendiente no hay tiempos válidos (se eliminan al guardar). */
  const SPEED_WINDOW_MS = 15000;
  function timesUsable(){ return timeMs && !opsList.some(o => o.op === 'reverse'); }

  function computeSpeedData(){
    const [mnV, mxV] = xRange();
    const n = idxMap.length;
    const valid = [];               // posiciones i del estado actual con tiempo
    for(let i = 0; i < n; i++) if(timeMs[idxMap[i]] != null) valid.push(i);
    if(valid.length < 2) return [];
    const raw = [];
    let lo = 0;
    for(let k = 0; k < valid.length; k++){
      const i = valid[k], t = timeMs[idxMap[i]];
      while(lo < k && t - timeMs[idxMap[valid[lo]]] > SPEED_WINDOW_MS) lo++;
      if(lo >= k) continue;
      const j = valid[lo], dt = (t - timeMs[idxMap[j]]) / 1000;
      if(dt <= 0) continue;
      const x = cumM[i] / 1000;
      if(x < mnV || x > mxV) continue;   // solo la ventana visible
      raw.push({x, y: (cumM[i] - cumM[j]) / dt * 3.6});
    }
    const step = Math.max(1, Math.ceil(raw.length / 3000));  // decimación solo para pintar
    return step === 1 ? raw : raw.filter((_, k) => k % step === 0);
  }

  function renderSpeedChart(){
    const panel = document.getElementById('speed-panel');
    if(!timesUsable()){
      panel.style.display = 'none';
      if(speedChart){speedChart.destroy();speedChart = null;}
      return;
    }
    const data = computeSpeedData();
    if(!data.length && viewMin == null){   // sin velocidad en TODO el track → sin panel
      panel.style.display = 'none';
      if(speedChart){speedChart.destroy();speedChart = null;}
      return;
    }
    panel.style.display = '';
    const ctx = document.getElementById('edspeed');
    if(speedChart) speedChart.destroy();
    speedChart = new Chart(ctx,{type:'line',plugins:[bandPlugin,issueBandsPlugin],
      data:{datasets:[{data,fill:true,borderColor:'#3a9ed8',
        backgroundColor:'rgba(58,158,216,.12)',pointRadius:0,borderWidth:1.5,tension:.3}]},
      options:{animation:false,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{enabled:false}},
        scales:{
          x:{type:'linear',min:xRange()[0],max:xRange()[1],
             title:{display:true,text:'km',color:'#8b9a8f'},ticks:{color:'#8b9a8f',maxTicksLimit:8},grid:{color:'rgba(236,229,216,.07)'}},
          y:{title:{display:true,text:'km/h',color:'#8b9a8f'},ticks:{color:'#8b9a8f'},grid:{color:'rgba(236,229,216,.07)'}}
        }}});
    bindChartDrag(ctx, () => speedChart);
    bindChartZoom(ctx, () => speedChart);
  }

  function kmToIdx(km){
    // búsqueda binaria en cumM (metros)
    const m=km*1000;
    let lo=0,hi=cumM.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(cumM[mid]<m)lo=mid+1;else hi=mid;}
    if(lo>0 && Math.abs(cumM[lo-1]-m)<Math.abs(cumM[lo]-m))lo--;
    return lo;
  }

  let chartDragging=false,chartPanning=null;
  function bindChartDrag(canvas,getChart){
    if(canvas._edBound)return;canvas._edBound=true;
    const evX=ev=>(ev.touches?ev.touches[0].clientX:ev.clientX);
    const idxFromEvent=ev=>{
      const c=getChart();if(!c)return null;
      const rect=canvas.getBoundingClientRect();
      const cx=evX(ev)-rect.left;
      const km=c.scales.x.getValueForPixel(cx*(canvas.width/(window.devicePixelRatio||1))/rect.width);
      if(km==null||isNaN(km))return null;
      return kmToIdx(Math.max(0,Math.min(km,cumM[cumM.length-1]/1000)));
    };
    const down=ev=>{
      if(ev.shiftKey&&viewMin!=null){   // Shift+arrastre: panear la ventana de zoom
        const c=getChart();if(!c)return;
        chartPanning={x0:evX(ev),mn:viewMin,mx:viewMax,
          kmPerPx:(viewMax-viewMin)/(c.chartArea.right-c.chartArea.left)};
        ev.preventDefault();return;
      }
      if(mode!=='select')return;   // la selección A–B es del modo Seleccionar
      const i=idxFromEvent(ev);if(i==null)return;chartDragging=true;setSel(i,i);ev.preventDefault();
    };
    const move=ev=>{
      if(chartPanning){
        const dkm=(chartPanning.x0-evX(ev))*chartPanning.kmPerPx;
        const w=chartPanning.mx-chartPanning.mn,total=totalKm();
        let nmn=Math.max(0,Math.min(chartPanning.mn+dkm,total-w));
        viewMin=nmn;viewMax=nmn+w;applyZoom();ev.preventDefault();return;
      }
      if(!chartDragging)return;const i=idxFromEvent(ev);if(i==null)return;setSel(selA,i);ev.preventDefault();
    };
    const up=()=>{
      if(chartPanning){chartPanning=null;return;}
      if(!chartDragging)return;chartDragging=false;
      if(selA===selB)clearSel();else updateButtons();};
    canvas.addEventListener('mousedown',down);
    window.addEventListener('mousemove',move);
    window.addEventListener('mouseup',up);
    canvas.addEventListener('touchstart',down,{passive:false});
    canvas.addEventListener('touchmove',move,{passive:false});
    canvas.addEventListener('touchend',up);
  }

  /* ── operaciones ────────────────────────────────────────────────────────── */
  function snapshot(){
    // wpts se muta de forma inmutable en doOp (slice/map/filter), así que guardar
    // la referencia es seguro.
    return {idxMap:idxMap.slice(), pos:new Map(posOverride), ele:new Map(eleOverride), wpts};
  }
  function restoreSnap(s){
    idxMap=s.idxMap; posOverride=s.pos; eleOverride=s.ele; wpts=s.wpts;
  }

  function doOp(op){
    undoStack.push({...snapshot(),op});
    redoStack=[];
    opsList.push(op);
    if(op.op==='delete_range'){
      const keep=new Int32Array(idxMap.length-(op.end-op.start+1));
      keep.set(idxMap.subarray(0,op.start),0);
      keep.set(idxMap.subarray(op.end+1),op.start);
      idxMap=keep;
    } else if(op.op==='reverse'){
      idxMap=idxMap.slice().reverse();
    } else if(op.op==='move_point'){
      const oi=idxMap[op.i];
      posOverride=new Map(posOverride); posOverride.set(oi,[op.lon,op.lat]);
    } else if(op.op==='move_points'){
      // lote de move_point (corrección de velocidad excesiva): items [i,lon,lat[,ele]]
      posOverride=new Map(posOverride);
      let el=null;
      op.items.forEach(it=>{
        const oi=idxMap[it[0]];
        posOverride.set(oi,[it[1],it[2]]);
        if(it.length>3&&it[3]!=null){
          if(!el)el=new Map(eleOverride);
          el.set(oi,it[3]);
        }
      });
      if(el)eleOverride=el;
    } else if(op.op==='insert_point'){
      // El punto nuevo se añade al final de los arrays de P con un índice
      // original nuevo; si luego se deshace, la entrada queda huérfana (inofensiva).
      const e1=eleOf(idxMap[op.after]), e2=eleOf(idxMap[op.after+1]);
      const oi=P.lonlat.length;
      P.lonlat.push([op.lon,op.lat]);
      if(P.ele)P.ele.push(e1!=null&&e2!=null?Math.round((e1+e2)*5)/10:null);
      if(P.time)P.time.push(null);
      if(P.hr)P.hr.push(null);
      if(timeMs)timeMs.push(null);
      const nm=new Int32Array(idxMap.length+1);
      nm.set(idxMap.subarray(0,op.after+1),0);
      nm[op.after+1]=oi;
      nm.set(idxMap.subarray(op.after+1),op.after+2);
      idxMap=nm;
    } else if(op.op==='delete_points'){
      const del=new Set(op.indices);
      const nm=new Int32Array(idxMap.length-del.size);
      let k=0;
      for(let i=0;i<idxMap.length;i++) if(!del.has(i)) nm[k++]=idxMap[i];
      idxMap=nm;
    } else if(op.op==='set_ele'){
      eleOverride=new Map(eleOverride);
      op.items.forEach(([i,e])=>eleOverride.set(idxMap[i],e));
    } else if(op.op==='shift_time'){
      // Un desplazamiento global no cambia geometría ni velocidades (las
      // diferencias de tiempo se conservan); no hay nada que mutar en cliente.
    } else if(op.op==='wpt_add'){
      wpts=[...wpts,{lon:op.lon,lat:op.lat,name:op.name||'',ele:null}];
    } else if(op.op==='wpt_move'){
      wpts=wpts.map((w,k)=>k===op.i?{...w,lon:op.lon,lat:op.lat}:w);
    } else if(op.op==='wpt_rename'){
      wpts=wpts.map((w,k)=>k===op.i?{...w,name:op.name||''}:w);
    } else if(op.op==='wpt_del'){
      wpts=wpts.filter((_,k)=>k!==op.i);
    }
    applyState();
  }

  function opTrimStart(){
    const iA=effA();if(iA==null||iA<=0)return;
    doOp({op:'delete_range',start:0,end:iA-1,desc:`Recortados ${iA} puntos del inicio`});
  }
  function opTrimEnd(){
    const iB=effB();const n=idxMap.length;if(iB==null||iB>=n-1)return;
    doOp({op:'delete_range',start:iB+1,end:n-1,desc:`Recortados ${n-1-iB} puntos del final`});
  }
  function opDeleteRange(){
    if(selA==null||selB==null)return;
    const iA=effA(),iB=effB();
    const n=iB-iA+1;
    doOp({op:'delete_range',start:iA,end:iB,desc:`Eliminado un tramo de ${n} puntos`});
  }
  function opReverse(){
    if(P.time && !confirm('Invertir la ruta eliminará las marcas de tiempo de los puntos. ¿Continuar?'))return;
    doOp({op:'reverse',desc:'Invertida la ruta'});
  }

  /* ── simplificación Douglas-Peucker ─────────────────────────────────────── */
  function douglasPeucker(tolM){
    const n=cur.length;
    const keep=new Uint8Array(n);keep[0]=1;keep[n-1]=1;
    const kx=Math.cos(cur[0][1]*Math.PI/180)*111320, ky=110540;
    const stack=[[0,n-1]];
    while(stack.length){
      const [a,b]=stack.pop();
      if(b-a<2)continue;
      const ax=cur[a][0]*kx,ay=cur[a][1]*ky,bx=cur[b][0]*kx,by=cur[b][1]*ky;
      const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy;
      let mi=-1,md=-1;
      for(let i=a+1;i<b;i++){
        const px=cur[i][0]*kx,py=cur[i][1]*ky;
        let d;
        if(len2===0){const ex=px-ax,ey=py-ay;d=ex*ex+ey*ey;}
        else{
          const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/len2));
          const qx=ax+t*dx-px,qy=ay+t*dy-py;d=qx*qx+qy*qy;
        }
        if(d>md){md=d;mi=i;}
      }
      if(md>tolM*tolM){keep[mi]=1;stack.push([a,mi],[mi,b]);}
    }
    return keep;
  }

  function _simpTolM(){
    // slider 0..100 → 0,5 m .. 50 m (escala logarítmica)
    const v=+document.getElementById('simp-tol').value;
    return 0.5*Math.pow(10,2*v/100);
  }
  function toggleSimplify(){
    const panel=document.getElementById('simp-panel');
    if(panel.classList.contains('hidden')){
      closeSpikes();closeSpeedFix();
      panel.classList.remove('hidden');
      simpPreview();
    }else closeSimplify();
  }
  function simpPreview(){
    const tol=_simpTolM();
    simpKeep=douglasPeucker(tol);
    let kept=0;for(let i=0;i<simpKeep.length;i++)kept+=simpKeep[i];
    const n=simpKeep.length;
    document.getElementById('simp-info').textContent=
      `Tolerancia ${tol<10?tol.toFixed(1):Math.round(tol)} m — ${fmt(n)} → ${fmt(kept)} pts (−${Math.round((1-kept/n)*100)} %)`;
    document.getElementById('simp-apply').disabled=kept>=n;
    if(map&&map.getSource('ghost'))
      map.getSource('ghost').setData({type:'Feature',geometry:{type:'LineString',
        coordinates:cur.filter((_,i)=>simpKeep[i])}});
  }
  function closeSimplify(){
    const panel=document.getElementById('simp-panel');
    if(panel)panel.classList.add('hidden');
    simpKeep=null;
    if(map&&map.getSource('ghost'))map.getSource('ghost').setData(EMPTY_FC);
  }
  function applySimplify(){
    if(!simpKeep)return;
    const indices=[];
    for(let i=0;i<simpKeep.length;i++)if(!simpKeep[i])indices.push(i);
    if(!indices.length){toast('Nada que simplificar con esta tolerancia');return;}
    doOp({op:'delete_points',indices,desc:`Simplificado el track (−${indices.length} puntos)`});
    toast(`Track simplificado: −${fmt(indices.length)} puntos`);
  }

  /* ── corrección de picos de elevación ───────────────────────────────────── */
  function detectSpikes(thr){
    const n=idxMap.length, items=[], marks=[];
    for(let i=1;i<n-1;i++){
      const e=eleOf(idxMap[i]), p=eleOf(idxMap[i-1]), q=eleOf(idxMap[i+1]);
      if(e==null||p==null||q==null)continue;
      const d1=e-p, d2=e-q;
      // pico/valle: se separa de AMBOS vecinos más del umbral, en el mismo sentido
      if(Math.abs(d1)>thr&&Math.abs(d2)>thr&&d1*d2>0){
        const fixed=Math.round((p+q)*5)/10;   // interpolación (media de vecinos)
        items.push([i,fixed]);
        marks.push({x:cumM[i]/1000,y:e});
      }
    }
    return {items,marks};
  }
  function toggleSpikes(){
    const panel=document.getElementById('spike-panel');
    if(panel.classList.contains('hidden')){
      if(!P.ele){toast('Esta ruta no tiene datos de elevación');return;}
      closeSimplify();closeSpeedFix();
      panel.classList.remove('hidden');
      spikePreview();
    }else closeSpikes();
  }
  function spikePreview(){
    const thr=+document.getElementById('spike-thr').value;
    const {items,marks}=detectSpikes(thr);
    spikeItems=items;spikePreviewData=marks;
    document.getElementById('spike-info').textContent=
      `Umbral ${thr} m — ${items.length} pico${items.length!==1?'s':''} detectado${items.length!==1?'s':''}`;
    document.getElementById('spike-apply').disabled=!items.length;
    _syncSpikeDataset();
  }
  function _syncSpikeDataset(){
    if(!chart)return;
    chart.data.datasets=[chart.data.datasets[0]];
    if(spikePreviewData&&spikePreviewData.length)
      chart.data.datasets.push({type:'scatter',data:spikePreviewData,
        pointRadius:4,pointHoverRadius:4,backgroundColor:'#e05252',borderColor:'#e05252'});
    chart.update('none');
  }
  function closeSpikes(){
    const panel=document.getElementById('spike-panel');
    if(panel)panel.classList.add('hidden');
    spikeItems=null;spikePreviewData=null;
    _syncSpikeDataset();
  }
  function applySpikes(){
    if(!spikeItems||!spikeItems.length)return;
    const nn=spikeItems.length;
    doOp({op:'set_ele',items:spikeItems,desc:`Corregida la elevación de ${nn} punto${nn!==1?'s':''}`});
    toast(`Corregidos ${nn} pico${nn!==1?'s':''} de elevación`);
  }

  /* ── corrección de velocidad excesiva (saltos de GPS) ───────────────────── */
  function detectSpeedErr(maxKmh){
    // Recorre comparando cada punto con el ÚLTIMO CONSERVADO: así un grupo entero
    // de puntos desplazados (el track "se va" y vuelve) cae completo, no solo el
    // primero del salto. Puntos sin tiempo no se pueden evaluar: se conservan.
    const idxs=[];
    let last=null;
    for(let i=0;i<idxMap.length;i++){
      const t=timeMs[idxMap[i]];
      if(t==null)continue;
      if(last==null){last=i;continue;}
      const dt=(t-timeMs[idxMap[last]])/1000;
      if(dt<=0){last=i;continue;}
      const a=cur[last],b=cur[i];
      const v=haversineM(a[1],a[0],b[1],b[0])/dt*3.6;
      if(v>maxKmh)idxs.push(i);
      else last=i;
    }
    return idxs;
  }
  /* Convierte los puntos marcados en un plan de CORRECCIÓN, no de borrado.
     Cada tira contigua de puntos malos se recoloca interpolando entre el último
     punto válido anterior (A) y el primer válido posterior (B): para un punto
     suelto a mitad de camino en el tiempo eso es exactamente la MEDIA de A y B,
     y para una tira el reparto va proporcional a (t−tA)/(tB−tA) (espaciado
     uniforme si falta algún timestamp). Así el punto no se pierde: se le quita la
     desviación. La elevación se interpola igual cuando A y B la tienen, porque un
     salto de GPS suele traer también una altitud falsa y el punto recolocado debe
     ser coherente con su nueva posición.
     Único caso en que sí se elimina: una tira que llega al final del track (o
     empieza en el primer punto), porque sin un punto válido al otro lado no hay
     nada con lo que promediar. */
  function planSpeedFix(idxs){
    const moves=[], drops=[], n=idxMap.length;
    for(let k=0;k<idxs.length;){
      let j=k;
      while(j+1<idxs.length&&idxs[j+1]===idxs[j]+1)j++;
      const i0=idxs[k], i1=idxs[j], a=i0-1, b=i1+1;
      k=j+1;
      if(a<0||b>=n){for(let q=i0;q<=i1;q++)drops.push(q);continue;}
      const A=cur[a], B=cur[b];
      const tA=timeMs?timeMs[idxMap[a]]:null, tB=timeMs?timeMs[idxMap[b]]:null;
      const span=(tA!=null&&tB!=null)?tB-tA:0;
      const eA=P.ele?eleOf(idxMap[a]):null, eB=P.ele?eleOf(idxMap[b]):null;
      const m=i1-i0+1;
      for(let q=0;q<m;q++){
        const i=i0+q;
        let f=(q+1)/(m+1);
        const ti=timeMs?timeMs[idxMap[i]]:null;
        if(span>0&&ti!=null){
          const g=(ti-tA)/span;
          if(g>0&&g<1)f=g;
        }
        const it=[i, A[0]+(B[0]-A[0])*f, A[1]+(B[1]-A[1])*f];
        if(eA!=null&&eB!=null)it.push(Math.round((eA+(eB-eA)*f)*10)/10);
        moves.push(it);
      }
    }
    return {moves,drops};
  }

  function toggleSpeedFix(){
    const panel=document.getElementById('speedfix-panel');
    if(panel.classList.contains('hidden')){
      if(!timeMs){toast('Esta ruta no tiene marcas de tiempo');return;}
      if(opsList.some(o=>o.op==='reverse')){toast('Con un "invertir" pendiente no hay tiempos válidos');return;}
      closeSimplify();closeSpikes();
      // umbral inicial: el de la actividad en Ajustes → "GPS incorrecto"
      const thr=document.getElementById('speedfix-thr');
      if(!thr._initialized){thr.value=Math.min(200,Math.max(5,R.gps_max_speed||40));thr._initialized=true;}
      panel.classList.remove('hidden');
      speedFixPreview();
    }else closeSpeedFix();
  }
  function speedFixPreview(){
    const thr=+document.getElementById('speedfix-thr').value;
    speedErrIdxs=detectSpeedErr(thr);
    speedFixPlan=planSpeedFix(speedErrIdxs);
    const nm=speedFixPlan.moves.length, nd=speedFixPlan.drops.length;
    document.getElementById('speedfix-info').textContent=
      `Umbral ${thr} km/h — ${fmt(nm)} punto${nm!==1?'s':''} a corregir`+
      (nd?` · ${fmt(nd)} sin punto válido al otro lado (se eliminan)`:'');
    document.getElementById('speedfix-apply').disabled=(!nm&&!nd)||idxMap.length-nd<2;
    if(map&&map.getSource('speederr'))
      map.getSource('speederr').setData({type:'FeatureCollection',
        features:speedErrIdxs.map(i=>({type:'Feature',geometry:{type:'Point',coordinates:cur[i]},properties:{}}))});
    // ghost: el track tal como quedaría, con los marcados ya interpolados
    if(map&&map.getSource('ghost')){
      if(!nm&&!nd)map.getSource('ghost').setData(EMPTY_FC);
      else{
        const fixed=cur.slice();
        speedFixPlan.moves.forEach(([i,lon,lat])=>{fixed[i]=[lon,lat];});
        const drop=new Set(speedFixPlan.drops);
        map.getSource('ghost').setData({type:'Feature',geometry:{type:'LineString',
          coordinates:fixed.filter((_,i)=>!drop.has(i))}});
      }
    }
  }
  function closeSpeedFix(){
    const panel=document.getElementById('speedfix-panel');
    if(panel)panel.classList.add('hidden');
    speedErrIdxs=null;speedFixPlan=null;
    if(map&&map.getSource('speederr'))map.getSource('speederr').setData(EMPTY_FC);
    if(map&&map.getSource('ghost'))map.getSource('ghost').setData(EMPTY_FC);
  }
  function applySpeedFix(){
    const plan=speedFixPlan;   // doOp → applyState → closeSpeedFix lo pone a null
    if(!plan||(!plan.moves.length&&!plan.drops.length))return;
    const nm=plan.moves.length, nd=plan.drops.length;
    if(idxMap.length-nd<2)return;
    // Primero mover (no reindexa) y luego borrar: al revés, los índices de los
    // movimientos ya no señalarían los mismos puntos.
    if(nm)doOp({op:'move_points',items:plan.moves,
      desc:`Corregida velocidad excesiva (${nm} punto${nm!==1?'s':''} interpolado${nm!==1?'s':''})`});
    if(nd)doOp({op:'delete_points',indices:plan.drops,
      desc:`Eliminado${nd!==1?'s':''} ${nd} punto${nd!==1?'s':''} de GPS sin referencia`});
    const parts=[];
    if(nm)parts.push(`${fmt(nm)} punto${nm!==1?'s':''} recolocado${nm!==1?'s':''} por interpolación`);
    if(nd)parts.push(`${fmt(nd)} eliminado${nd!==1?'s':''} (sin punto válido al otro lado)`);
    toast('Velocidad corregida: '+parts.join(' · '));
  }

  /* ── waypoints ──────────────────────────────────────────────────────────── */
  function renderWpts(){
    wptMarkers.forEach(m=>m.remove());
    wptMarkers=[];
    if(!map)return;
    wpts.forEach((w,k)=>{
      const el=document.createElement('div');
      el.className='wpt-marker';el.textContent='⚑';el.style.color='#e8a13a';
      el.title=w.name||'Waypoint';
      const mk=new maplibregl.Marker({element:el,anchor:'bottom',draggable:true})
        .setLngLat([w.lon,w.lat])
        .setPopup(new maplibregl.Popup({offset:18}).setHTML(
          `<b>${esc(w.name)||'(sin nombre)'}</b><br>
           <button class="btn ghost sm" style="margin-top:6px" onclick="wptRename(${k})">Renombrar</button>
           <button class="btn ghost sm" style="margin-top:6px;border-color:var(--gr-red);color:var(--gr-red)" onclick="wptDel(${k})">Eliminar</button>`))
        .addTo(map);
      mk.on('dragend',()=>{
        const p=mk.getLngLat();
        doOp({op:'wpt_move',i:k,lon:p.lng,lat:p.lat,desc:'Movido 1 waypoint'});
      });
      wptMarkers.push(mk);
    });
  }
  function addWpt(ll){
    const name=prompt('Nombre del waypoint:','');
    if(name===null)return;
    doOp({op:'wpt_add',lon:ll.lng,lat:ll.lat,name:name.trim(),desc:'Añadido 1 waypoint'});
  }
  function wptRename(k){
    const name=prompt('Nuevo nombre:',wpts[k]?.name||'');
    if(name===null)return;
    doOp({op:'wpt_rename',i:k,name:name.trim(),desc:'Renombrado 1 waypoint'});
  }
  function wptDel(k){
    if(!confirm(`¿Eliminar el waypoint «${wpts[k]?.name||'(sin nombre)'}»?`))return;
    doOp({op:'wpt_del',i:k,desc:'Eliminado 1 waypoint'});
  }

  /* ── desplazar tiempos ──────────────────────────────────────────────────── */
  function _pendingShiftMs(){
    return opsList.filter(o=>o.op==='shift_time').reduce((a,o)=>a+o.seconds*1000,0);
  }
  function _curStartMs(){
    if(!timeMs)return null;
    for(let i=0;i<idxMap.length;i++){
      const t=timeMs[idxMap[i]];
      if(t!=null)return t+_pendingShiftMs();
    }
    return null;
  }
  function _toLocalInput(ms){
    const d=new Date(ms), p=n=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function toggleShift(){
    const panel=document.getElementById('shift-panel');
    if(panel.classList.contains('hidden')){
      if(!timeMs){toast('Esta ruta no tiene marcas de tiempo');return;}
      if(opsList.some(o=>o.op==='reverse')){toast('Con un "invertir" pendiente no hay tiempos válidos');return;}
      closeSimplify();closeSpikes();closeSpeedFix();closeMerge();
      const cur=_curStartMs();
      document.getElementById('shift-cur').textContent=new Date(cur).toLocaleString('es-ES');
      document.getElementById('shift-dt').value=_toLocalInput(cur);
      panel.classList.remove('hidden');
    }else closeShift();
  }
  function closeShift(){
    const panel=document.getElementById('shift-panel');
    if(panel)panel.classList.add('hidden');
  }
  function applyShift(){
    const v=document.getElementById('shift-dt').value;
    if(!v){toast('Indica la nueva hora de inicio');return;}
    const target=new Date(v).getTime();
    if(isNaN(target)){toast('Fecha inválida');return;}
    const seconds=Math.round((target-_curStartMs())/1000);
    if(!seconds){toast('La hora no ha cambiado');return;}
    const sign=seconds>=0?'+':'−', s=Math.abs(seconds), p=n=>String(n).padStart(2,'0');
    doOp({op:'shift_time',seconds,
      desc:`Desplazados los tiempos ${sign}${p(Math.floor(s/3600))}:${p(Math.floor(s%3600/60))}:${p(s%60)}`});
    toast('Tiempos desplazados (se aplican al guardar)');
  }

  /* ── unir con otra ruta ─────────────────────────────────────────────────── */
  async function toggleMerge(){
    const panel=document.getElementById('merge-panel');
    if(!panel.classList.contains('hidden')){closeMerge();return;}
    closeSimplify();closeSpikes();closeSpeedFix();closeShift();
    let items=[];
    try{items=(await(await fetch('/api/routes')).json()).items||[];}catch(e){}
    const sel=document.getElementById('merge-sel');
    sel.innerHTML='';
    items.filter(r=>r.public_id!==R.public_id).forEach(r=>{
      const o=document.createElement('option');
      o.value=r.public_id;
      o.textContent=`${r.name} (${((r.distance_m||0)/1000).toFixed(1)} km)`;
      o.dataset.name=r.name;
      sel.appendChild(o);
    });
    if(!sel.options.length){toast('No hay otras rutas con las que unir');return;}
    _mergeNameSync();
    panel.classList.remove('hidden');
  }
  function _mergeNameSync(){
    const sel=document.getElementById('merge-sel');
    const other=sel.options[sel.selectedIndex]?.dataset.name||'';
    document.getElementById('merge-name').value=`${R.name} + ${other}`;
  }
  function closeMerge(){
    const panel=document.getElementById('merge-panel');
    if(panel)panel.classList.add('hidden');
  }
  async function doMerge(){
    const sel=document.getElementById('merge-sel');
    const other=sel.value;
    if(!other)return;
    if(opsList.length && !confirm('Los cambios sin guardar NO se incluirán en la unión. ¿Continuar?'))return;
    const res=await fetch('/api/routes/merge',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ids:[R.public_id,other],name:document.getElementById('merge-name').value.trim()})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok){toast(d.error||'Error al unir');return;}
    Store.syncNow({force:true});   // el servidor cambió: pon al día la copia local
    closeMerge();
    const extra=d.times_kept?'':' (tiempos descartados: se solapaban)';
    if(confirm(`Creada «${d.name}»${extra}. ¿Abrir la ruta nueva?`))
      location.href='/Sendero/'+encodeURIComponent(d.public_id);
    else toast(`Creada «${d.name}»${extra}`);
  }

  /* ── elevación desde DEM ────────────────────────────────────────────────── */
  async function doDem(){
    if(opsList.length){toast('Guarda o descarta los cambios antes de recalcular la elevación');return;}
    if(!confirm('Se recalculará la elevación de TODOS los puntos con el servicio DEM configurado y se creará una versión nueva. ¿Continuar?'))return;
    const btn=document.getElementById('dem-btn');
    btn.disabled=true;btn.textContent='🏔 Consultando DEM…';
    try{
      const res=await fetch(`/api/routes/${R.public_id}/elevation-dem`,{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({base_version:R.version})});
      const d=await res.json().catch(()=>({}));
      if(!res.ok){toast(d.error||'Error al recalcular la elevación');return;}
      toast('Elevación recalculada como versión v'+d.version);
      if(d.gps_issues)R.gps_issues=d.gps_issues;
      document.getElementById('ed-body').classList.add('hidden');
      Store.syncNow({force:true});   // el servidor cambió: pon al día la copia local
      document.getElementById('ed-loading').classList.remove('hidden');
      document.getElementById('ed-loading').textContent='Recargando puntos…';
      await loadPoints();
    } finally {btn.disabled=false;btn.textContent='🏔 Recalcular elevación (DEM)';}
  }

  /* ── avisos GPS (gps_issues calculados en create/rescan/guardado) ───────── */
  const issueBandsPlugin={id:'issueBands',beforeDatasetsDraw(c){
    if(opsList.length||!R.gps_issues||!R.gps_issues.length)return;
    const ctx=c.ctx,area=c.chartArea;
    ctx.save();
    ctx.beginPath();ctx.rect(area.left,area.top,area.right-area.left,area.bottom-area.top);ctx.clip();
    R.gps_issues.forEach(it=>{
      const x1=c.scales.x.getPixelForValue(it.d_from);
      const x2=c.scales.x.getPixelForValue(it.d_to);
      ctx.fillStyle=it.severity==='high'?'rgba(224,82,82,.22)':'rgba(224,82,82,.13)';
      ctx.fillRect(Math.min(x1,x2),area.top,Math.max(Math.abs(x2-x1),2),area.bottom-area.top);
    });
    ctx.restore();
  }};

  function renderIssues(){
    const panel=document.getElementById('issues-panel');
    const list=document.getElementById('issues-list');
    const issues=R.gps_issues||[];
    if(!issues.length){panel.classList.add('hidden');return;}
    panel.classList.remove('hidden');
    // Con cambios pendientes, los avisos son del estado GUARDADO y ya no cuadran:
    // se marcan como corregidos (tachados) y se recalcularán al guardar.
    const pending=opsList.length>0;
    document.getElementById('fix-all-btn').disabled=pending;
    const status=document.getElementById('issues-status');
    status.classList.toggle('hidden',!pending);
    if(pending)status.textContent='✔ Correcciones aplicadas. Guarda los cambios para recalcular los avisos.';
    list.innerHTML='';
    issues.forEach((it,k)=>{
      const row=document.createElement('div');
      row.className='issue-row'+(it.severity==='high'?' high':'')+(pending?' done':'');
      row.id='issue-row-'+k;
      const ico=it.type==='speed'?'⚡':(it.type==='altitude'?'🏔':'⛰');
      const unit=it.type==='speed'?'km/h':(it.type==='altitude'?'m':'m/s');
      row.innerHTML=`<span class="ico">${ico}</span>
        <div class="meta">
          <div class="rng">${it.d_from.toFixed(2)}–${it.d_to.toFixed(2)} km</div>
          <div class="det">máx ${it.value_max} ${unit} (umbral ${it.threshold})</div>
        </div>
        <span class="fixed-tag">✔ corregido</span>
        <button class="btn ghost sm" onclick="fixIssue(${k})">Corregir</button>`;
      list.appendChild(row);
    });
  }

  function updateIssueOverlays(){
    // Los rangos son distancias del estado GUARDADO: con ops pendientes ya no
    // cuadran, así que los overlays (mapa + bandas de los charts) se ocultan.
    if(!map||!map.getSource('issues'))return;
    const issues=R.gps_issues||[];
    if(opsList.length||!issues.length){
      map.getSource('issues').setData(EMPTY_FC);
      return;
    }
    map.getSource('issues').setData({type:'FeatureCollection',
      features:issues.map(it=>{
        const i0=kmToIdx(it.d_from), i1=Math.max(kmToIdx(it.d_to),i0+1);
        return {type:'Feature',geometry:{type:'LineString',coordinates:cur.slice(i0,i1+1)},properties:{}};
      })});
  }

  function fixAllIssues(){
    const issues=R.gps_issues||[];
    if(!issues.length)return;
    if(opsList.length){toast('Los avisos son del estado guardado: deshaz o guarda los cambios primero');return;}
    let nEle=0,nSpd=0,nDrop=0;

    // 1) Elevación/altitud primero (no cambian geometría → los km de los avisos
    //    siguen siendo válidos). Un fallo de barómetro genera DOS avisos de
    //    elevación (la subida y la bajada imposibles) con la meseta falsa entre
    //    medias, y los de altitud marcan directamente la meseta: se fusionan los
    //    tramos cercanos (<0,5 km) en una región y se interpola de extremo a
    //    extremo, cubriendo también la meseta.
    if(P.ele){
      const ranges=issues.filter(it=>it.type==='elevation'||it.type==='altitude')
        .map(it=>[it.d_from,it.d_to]).sort((a,b)=>a[0]-b[0]);
      const regions=[];
      ranges.forEach(r=>{
        const last=regions[regions.length-1];
        if(last&&r[0]-last[1]<0.5)last[1]=Math.max(last[1],r[1]);
        else regions.push([r[0],r[1]]);
      });
      const items=[];
      regions.forEach(([d0,d1])=>{
        const a=Math.max(0,kmToIdx(d0)-1);
        const b=Math.min(idxMap.length-1,kmToIdx(d1)+1);
        const eA=eleOf(idxMap[a]), eB=eleOf(idxMap[b]);
        if(eA==null||eB==null||b-a<2)return;
        for(let i=a+1;i<b;i++){
          const t=(cumM[i]-cumM[a])/((cumM[b]-cumM[a])||1);
          items.push([i,Math.round((eA+(eB-eA)*t)*10)/10]);
        }
      });
      if(items.length){
        doOp({op:'set_ele',items,desc:`Corregida la elevación de ${items.length} puntos (avisos GPS)`});
        nEle=items.length;
      }
    }

    // 2) Velocidad: los saltos de GPS se RECOLOCAN interpolando entre los puntos
    //    válidos de alrededor (ver planSpeedFix), no se borran. Solo caen los que
    //    no tienen punto válido a un lado (una tira que llega al final del track).
    const spd=issues.filter(it=>it.type==='speed');
    if(spd.length&&timeMs){
      const idxs=detectSpeedErr(Math.min(...spd.map(it=>it.threshold)));
      const plan=planSpeedFix(idxs);
      if(idxMap.length-plan.drops.length>=2){
        if(plan.moves.length){
          doOp({op:'move_points',items:plan.moves,
            desc:`Corregida velocidad excesiva (${plan.moves.length} punto${plan.moves.length!==1?'s':''} interpolado${plan.moves.length!==1?'s':''}, avisos GPS)`});
          nSpd=plan.moves.length;
        }
        if(plan.drops.length){
          doOp({op:'delete_points',indices:plan.drops,
            desc:`Eliminado${plan.drops.length!==1?'s':''} ${plan.drops.length} punto${plan.drops.length!==1?'s':''} de GPS sin referencia`});
          nDrop=plan.drops.length;
        }
      }
    }

    if(!nEle&&!nSpd&&!nDrop){toast('No se encontró nada que corregir con los umbrales actuales');return;}
    const parts=[];
    if(nSpd)parts.push(`${fmt(nSpd)} punto${nSpd!==1?'s':''} de velocidad recolocado${nSpd!==1?'s':''}`);
    if(nDrop)parts.push(`${fmt(nDrop)} eliminado${nDrop!==1?'s':''} sin referencia`);
    if(nEle)parts.push(`elevación corregida en ${fmt(nEle)} punto${nEle!==1?'s':''}`);
    toast('Corregido: '+parts.join(' · ')+'. Revisa el resultado y guarda.');
  }

  function fixIssue(k){
    const it=(R.gps_issues||[])[k];
    if(!it)return;
    // marca visualmente el aviso que se está corrigiendo ahora mismo
    document.querySelectorAll('.issue-row.active').forEach(r=>r.classList.remove('active'));
    const row=document.getElementById('issue-row-'+k);if(row)row.classList.add('active');
    // zoom de las gráficas al tramo del aviso (con un poco de contexto)
    const total=totalKm(), m=Math.max((it.d_to-it.d_from)*0.5,0.15);
    viewMin=Math.max(0,it.d_from-m);
    viewMax=Math.min(total,it.d_to+m);
    applyZoom();
    if(it.type==='speed'){
      closeSimplify();closeSpikes();closeShift();closeMerge();
      const thr=document.getElementById('speedfix-thr');
      thr.value=Math.min(200,Math.max(5,Math.round(it.threshold)));thr._initialized=true;
      document.getElementById('speedfix-panel').classList.remove('hidden');
      speedFixPreview();
    } else {   // elevation y altitude → corrector de picos de elevación
      closeSimplify();closeSpeedFix();closeShift();closeMerge();
      if(!P.ele){toast('Esta ruta no tiene datos de elevación');return;}
      document.getElementById('spike-panel').classList.remove('hidden');
      spikePreview();
    }
  }

  /* ── dividir ruta ───────────────────────────────────────────────────────── */
  async function doSplit(){
    if(selA==null){toast('Coloca el manejador A en el punto de corte');return;}
    if(opsList.length){toast('Guarda o descarta los cambios antes de dividir');return;}
    const i=selA, n=idxMap.length;
    if(i<1||i>n-2){toast('El punto de corte no puede ser el primero ni el último');return;}
    const name=prompt('Nombre de la nueva ruta (segunda mitad):',R.name+' (2)');
    if(name===null)return;
    const res=await fetch(`/api/routes/${R.public_id}/split`,{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({index:i,name_b:name.trim(),base_version:R.version})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok){toast(d.error||'Error al dividir');return;}
    toast(`Ruta dividida — creada «${d.b_name}»`);
    document.getElementById('ed-body').classList.add('hidden');
    Store.syncNow({force:true});   // el servidor cambió: pon al día la copia local
    document.getElementById('ed-loading').classList.remove('hidden');
    document.getElementById('ed-loading').textContent='Recargando puntos…';
    await loadPoints();
  }

  function undo(){
    if(!undoStack.length)return;
    const e=undoStack.pop();
    redoStack.push({...snapshot(),op:e.op});
    restoreSnap(e);opsList.pop();
    applyState();
  }
  function redo(){
    if(!redoStack.length)return;
    const e=redoStack.pop();
    undoStack.push({...snapshot(),op:e.op});
    restoreSnap(e);opsList.push(e.op);
    applyState();
  }

  document.addEventListener('keydown',e=>{
    if(!visible())return;   // la SPA tiene 6 secciones: los atajos son solo de esta
    if(!document.getElementById('save-modal').classList.contains('hidden'))return;
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}
    else if((e.ctrlKey||e.metaKey)&&(e.key.toLowerCase()==='y'||(e.shiftKey&&e.key.toLowerCase()==='z'))){e.preventDefault();redo();}
    else if(e.key==='Escape')clearSel();
  });

  /* ── guardar ────────────────────────────────────────────────────────────── */
  function _aggSummary(){
    // agrega ops repetidas (12 movimientos → "Movidos 12 puntos") en orden de aparición
    const parts=[], counts={move_point:0, insert_point:0, single_del:0};
    opsList.forEach(o=>{
      if(o.op==='move_point')counts.move_point++;
      else if(o.op==='insert_point')counts.insert_point++;
      else if(o.op==='delete_points'&&o.indices.length===1)counts.single_del++;
      else parts.push(o.desc);
    });
    const pl=(n,s,p)=>n===1?s:p.replace('{n}',fmt(n));
    if(counts.move_point)parts.push(pl(counts.move_point,'Movido 1 punto','Movidos {n} puntos'));
    if(counts.insert_point)parts.push(pl(counts.insert_point,'Añadido 1 punto','Añadidos {n} puntos'));
    if(counts.single_del)parts.push(pl(counts.single_del,'Eliminado 1 punto','Eliminados {n} puntos'));
    return parts.join(' · ');
  }

  function openSaveModal(){
    if(!opsList.length)return;
    document.getElementById('save-summary').value=_aggSummary();
    document.getElementById('save-modal').classList.remove('hidden');
    document.getElementById('save-summary').focus();
  }
  function closeSaveModal(){document.getElementById('save-modal').classList.add('hidden');}

  async function doSave(){
    const btn=document.getElementById('save-confirm');
    btn.disabled=true;btn.textContent='Guardando…';
    try{
      const res=await fetch(`/api/routes/${R.public_id}/edit`,{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          base_version:R.version,
          summary:document.getElementById('save-summary').value.trim(),
          ops:opsList.map(({desc,...rest})=>rest),
        })});
      const d=await res.json().catch(()=>({}));
      if(!res.ok){
        closeSaveModal();
        if(res.status===409){
          toast(d.error||'Conflicto de versión');
          if(confirm('La ruta cambió en otra pestaña. ¿Recargar el editor? (se pierden los cambios locales)'))location.reload();
        } else toast(d.error||'Error al guardar');
        return;
      }
      closeSaveModal();
      toast('Guardado como versión v'+d.version);
      if(d.gps_issues)R.gps_issues=d.gps_issues;   // recalculados en el guardado
      document.getElementById('ed-body').classList.add('hidden');
      Store.syncNow({force:true});   // el servidor cambió: pon al día la copia local
      document.getElementById('ed-loading').classList.remove('hidden');
      document.getElementById('ed-loading').textContent='Recargando puntos…';
      await loadPoints();
    } finally {btn.disabled=false;btn.textContent='Guardar';}
  }

  /* ── versiones ──────────────────────────────────────────────────────────── */
  async function loadVersions(){
    let d;
    try{d=await(await fetch(`/api/routes/${R.public_id}/versions`)).json();}catch(e){return;}
    const box=document.getElementById('ver-list');
    if(!d.items.length){
      box.innerHTML='<div style="color:var(--muted);font-size:12px">Sin ediciones todavía. Al guardar se creará el historial.</div>';
      return;
    }
    box.innerHTML='';
    d.items.forEach(v=>{
      const row=document.createElement('div');row.className='ver-row';
      const isCur=v.version_n===d.current;
      const km=v.distance_m!=null?(v.distance_m/1000).toLocaleString('es-ES',{maximumFractionDigits:2}):'–';
      const asc=v.ascent_m!=null?Math.round(v.ascent_m):'–';
      const date=v.created_at?new Date(v.created_at).toLocaleDateString('es-ES',{day:'2-digit',month:'short'}):'';
      row.innerHTML=`<span class="vn">v${v.version_n}${isCur?' ●':''}</span>
        <div class="meta">
          <div class="sum" title="${esc(v.summary||'')}">${esc(v.summary||'—')}</div>
          <div class="st">${km} km · +${asc} m · ${date}</div>
        </div>
        <div class="acts">
          <button class="btn ghost sm" title="Descargar" onclick="location.href='/api/routes/${R.public_id}/versions/${v.version_n}/gpx'">↓</button>
          ${isCur?'':`<button class="btn ghost sm" onclick="restoreVersion(${v.version_n})">Restaurar</button>`}
        </div>`;
      box.appendChild(row);
    });
  }

  async function restoreVersion(vn){
    let msg=`Se restaurará la versión v${vn} como una versión nueva.`;
    if(opsList.length)msg+=' Los cambios sin guardar se descartarán.';
    if(!confirm(msg+' ¿Continuar?'))return;
    const res=await fetch(`/api/routes/${R.public_id}/versions/${vn}/restore`,{method:'POST'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok){toast(d.error||'Error al restaurar');return;}
    toast(`Versión v${vn} restaurada como v${d.version}`);
    if(d.gps_issues)R.gps_issues=d.gps_issues;
    document.getElementById('ed-body').classList.add('hidden');
    Store.syncNow({force:true});   // el servidor cambió: pon al día la copia local
    document.getElementById('ed-loading').classList.remove('hidden');
    document.getElementById('ed-loading').textContent='Recargando puntos…';
    await loadPoints();
  }

  /* ── salir ──────────────────────────────────────────────────────────────── */
  let leaving=false;   // salida ya confirmada por la app: no volver a avisar en beforeunload
  function goBack(){
    if(opsList.length && !confirm('Hay cambios sin guardar. ¿Salir de todas formas?'))return;
    leaving=true;
    go('/Sendero/'+encodeURIComponent(R.public_id));
  }
  window.addEventListener('beforeunload',e=>{
    if(opsList.length && !leaving){e.preventDefault();e.returnValue='';}
  });
  /* ── montaje ───────────────────────────────────────────────────────────── */
  function resetState() {
    // Mapa, gráficas y marcadores: sin esto, cada visita dejaría un contexto
    // WebGL y dos Chart vivos (la fuga nº 1 de esta conversión).
    destroyMarkers();
    if (chart) { try { chart.destroy(); } catch (e) {} chart = null; }
    if (speedChart) { try { speedChart.destroy(); } catch (e) {} speedChart = null; }
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    P = null; idxMap = null; cur = []; cumM = null; timeMs = null;
    undoStack = []; redoStack = []; opsList = [];
    selA = null; selB = null; baseStats = null;
    posOverride = new Map(); eleOverride = new Map();
    spikePreviewData = null; spikeItems = null; simpKeep = null; speedErrIdxs = null;
    speedFixPlan = null;
    wpts = []; viewMin = null; viewMax = null;
    mode = 'select';
    leaving = false;
    // Todos los paneles de herramientas, cerrados
    ['simplify-panel', 'spikes-panel', 'speedfix-panel', 'shift-panel', 'merge-panel']
      .forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    const sm = document.getElementById('save-modal');
    if (sm) sm.classList.add('hidden');
  }

  function destroyMarkers() {
    [handleA, handleB, mkStart, mkEnd].forEach(m => { if (m) { try { m.remove(); } catch (e) {} } });
    handleA = handleB = mkStart = mkEnd = null;
    wptMarkers.forEach(m => { try { m.remove(); } catch (e) {} });
    wptMarkers = [];
  }

  async function mount(params) {
    const tok = ++_tok;
    resetState();
    const loading = document.getElementById('ed-loading');
    loading.classList.remove('hidden');
    loading.textContent = 'Cargando la ruta…';
    document.getElementById('ed-body').classList.add('hidden');
    if (!Store.isOnline()) {
      loading.textContent = 'El editor necesita conexión: trabaja sobre el archivo del servidor.';
      return;
    }
    try {
      const res = await fetch(`/api/routes/${encodeURIComponent(params.id)}/editor`);
      if (!res.ok) {
        loading.textContent = res.status === 404 ? 'Ruta no encontrada.'
                                                : 'No se pudo abrir el editor.';
        return;
      }
      R = await res.json();
    } catch (e) {
      loading.textContent = 'El editor necesita conexión: trabaja sobre el archivo del servidor.';
      return;
    }
    if (tok !== _tok) return;
    document.title = `${R.name} – Editor`;
    document.getElementById('ed-name').textContent = R.name;
    document.getElementById('ed-version').textContent = 'v' + R.version;
    if (!_detailsBound) { initDetails(); _detailsBound = true; }
    else {
      // Solo los valores: los listeners se enganchan una única vez.
      document.getElementById('det-name').value = R.name || '';
      document.getElementById('det-device').value = R.device || '';
      document.getElementById('det-save').disabled = true;
    }
    document.getElementById('dem-btn').style.display = R.dem_enabled ? '' : 'none';
    await loadPoints();
  }

  function unmount() {
    _tok++;
    resetState();
    R = null;
  }

  /* Cambios sin guardar + navegación de la SPA. `beforeunload` solo salta en
     recargas de documento de verdad, y ahora salir del editor puede ser un simple
     cambio de sección: se pregunta en fase de CAPTURA, antes de que el router
     procese el click, para poder cancelarlo. */
  document.addEventListener('click', e => {
    if (!visible() || !opsList.length || leaving) return;
    const a = e.target.closest('a[data-spa], [data-nav], a.nav-link');
    if (!a) return;
    if (a.closest('#sec-editor')) return;   // los botones del propio editor ya preguntan
    if (!confirm('Hay cambios sin guardar en el editor. ¿Salir de todas formas?')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    leaving = true;
  }, true);

  window.SEC.editor = {
    mount, unmount,
    _mergeNameSync,
    applyShift,
    applySimplify,
    applySpeedFix,
    applySpikes,
    clearSel,
    closeMerge,
    closeSaveModal,
    closeShift,
    closeSimplify,
    closeSpeedFix,
    closeSpikes,
    doDem,
    doMerge,
    doSave,
    doSplit,
    edZoomStep,
    fixAllIssues,
    goBack,
    opDeleteRange,
    opReverse,
    opTrimEnd,
    opTrimStart,
    openSaveModal,
    redo,
    saveDetails,
    setMode,
    simpPreview,
    speedFixPreview,
    spikePreview,
    toggleMerge,
    toggleShift,
    toggleSimplify,
    toggleSpeedFix,
    toggleSpikes,
    undo
  };
})();
