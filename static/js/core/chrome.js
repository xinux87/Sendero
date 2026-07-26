/* Chrome de la aplicación: helpers globales ($, fmtKm, fmtDur, fmtDate, esc,
   toast), navegación del header y modal de Ajustes. Extraído del <script> inline
   de templates/base.html para que el Service Worker pueda cachearlo por URL,
   separado del HTML (roadmap/spa-offline-sync.md §2).

   OJO: este archivo NO va envuelto en un IIFE a propósito. Sus funciones se
   llaman desde atributos onclick= del propio base.html (openSettings, cfgNav,
   saveSettings…), que solo ven el ámbito global. Los módulos de sección
   (static/js/sec/*.js) sí van en IIFE, porque conviven todos en el mismo
   documento y sus nombres chocarían.

   Se carga DESPUÉS de shared.js y ANTES de los módulos de sección. */
const $=s=>document.querySelector(s);
/* Transición suave entre páginas del nav, SOLO para los documentos que no son la
   SPA (hoy el editor). Si el router está cargado y sabe montar ese destino, es él
   quien navega: este listener corre antes (chrome.js se carga antes que
   router.js) y sin esta comprobación haría un location.href 100 ms después de
   que la SPA ya hubiera cambiado de sección — o sea, una recarga completa. */
document.addEventListener('click', e => {
  const link = e.target.closest('a.nav-link');
  if (!link || link.classList.contains('on')) return;
  const href = link.getAttribute('href');
  // OJO: `typeof Router`, no `window.Router`. Router y Store se declaran con
  // `const` en el ámbito superior de un script clásico, y eso crea un binding
  // léxico global que NO aparece como propiedad de window. Con `window.Router`
  // esta comprobación siempre era falsa y el nav hacía una recarga completa
  // encima de la navegación de la SPA.
  if (typeof Router !== 'undefined' && href && Router.parse(href.split('?')[0])) return;
  e.preventDefault();
  document.body.style.transition = 'opacity .1s ease';
  document.body.style.opacity = '0';
  setTimeout(() => location.href = link.href, 100);
});
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"),2200);}
function fmtKm(m){return m?(m/1000).toFixed(2):"–";}
function fmtDur(s){if(!s)return"–";s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
  return h?`${h}h ${m}m`:`${m}m`;}
function fmtDate(iso){if(!iso)return"Sin fecha";const d=new Date(iso);
  return d.toLocaleDateString("es-ES",{day:"2-digit",month:"long",year:"numeric"});}
function esc(s){return(s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}

/* ── PWA: Service Worker e indicador de estado (roadmap §5) ───────────────── */

/* El SW se registra desde AQUÍ, no desde el shell, aunque el plan lo pusiera en
   el shell: mientras la migración no termine, /dashboard, /rutas y
   /planificacion los sirve templates/app.html, y registrándolo solo en el shell
   esas tres vistas —las más usadas— se quedarían sin caché de código. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', {scope: '/'})
      .catch(e => console.warn('[sw] registro', e));
  });
}

/* Badge de estado: solo se muestra cuando hay algo que decir (sin conexión,
   sincronizando o con escrituras en cola). Vive en chrome.js porque el header es
   de base.html y lo comparten la SPA nueva y la vieja; el Store puede no estar
   cargado (app.html no lo usa todavía), así que todo lo suyo es opcional. */
function _netBadge(text, cls) {
  const b = $('#net-badge');
  if (!b) return;
  b.className = 'net-badge' + (cls ? ' ' + cls : '') + (text ? '' : ' hidden');
  b.textContent = text || '';
}

/* `typeof Store`, no `window.Store`: ver el comentario del listener del nav. */
const _tieneStore = () => typeof Store !== 'undefined';

function _netRefresh(ev) {
  if (navigator.onLine === false) { _netBadge('sin conexión', 'off'); return; }
  if (ev && ev.type === 'syncing') { _netBadge('sincronizando'); return; }
  const pend = _tieneStore() ? Store.pendingCount() : Promise.resolve(0);
  pend.then(n => {
    if (navigator.onLine === false) return;               // cambió mientras tanto
    if (n > 0) _netBadge(`${n} sin enviar`, 'pend');
    else _netBadge('');
  }).catch(() => _netBadge(''));
}

window.addEventListener('online',  () => _netRefresh());
window.addEventListener('offline', () => _netRefresh());
window.addEventListener('load', () => {
  _netRefresh();
  if (_tieneStore()) {
    Store.onChange(_netRefresh);
    Store.flushOutbox();          // por si quedó algo de una sesión sin conexión
  }
});

/* ── Ajustes → Sin conexión (roadmap §6.3 y §7) ────────────────────────────
   Todo esto es UI sobre lo que ya hace static/js/core/store.js: prefetchAll(),
   usage(), verify(), flushOutbox() y clearLocal(). En el editor (que no carga el
   Store) la sección avisa en vez de romperse. */

function _fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function loadOffline() {
  const est = $('#off-estado');
  if (!est) return;
  if (!_tieneStore()) {
    est.textContent = 'Esta pantalla no usa el almacén local.';
    return;
  }
  try {
    const [rutas, planes, uso, cursor, syncedAt] = await Promise.all([
      Store._getAll('routes'), Store._getAll('planned'), Store.usage(),
      Store.meta('cursor'), Store.meta('synced_at'),
    ]);
    const cuando = syncedAt
      ? new Date(syncedAt).toLocaleString('es-ES', {day: '2-digit', month: 'short',
                                                    hour: '2-digit', minute: '2-digit'})
      : 'nunca';
    const partes = [
      `${rutas.length} ruta(s) y ${planes.length} plan(es) guardados`,
      uso ? `${uso.cachedDetails} detalle(s) descargado(s)` : null,
      uso && uso.usage ? `${_fmtBytes(uso.usage)} ocupados` : null,
      `última sincronización: ${cuando}`,
      // El cursor es opaco: no se muestra como número "de versión", solo como
      // señal de que hay una copia establecida.
      cursor ? null : 'sin sincronizar todavía',
    ].filter(Boolean);
    est.innerHTML = partes.join(' · ');
    $('#off-prefetch-info').textContent = uso
      ? `${uso.cachedDetails} / ${rutas.length}` : '';
  } catch (e) {
    est.textContent = 'No se pudo leer el almacén local.';
  }
  renderOutbox();
}

async function renderOutbox() {
  const box = $('#off-cola');
  if (!box || !_tieneStore()) return;
  let items = [];
  try { items = await Store._getAll('outbox'); } catch (e) {}
  const flush = $('#off-flush-btn');
  if (!items.length) {
    box.innerHTML = '<div class="cfg-hint" style="margin:0">Nada pendiente: todo enviado.</div>';
    if (flush) flush.disabled = true;
    return;
  }
  if (flush) flush.disabled = false;
  box.innerHTML = items.map(it => {
    const cuando = new Date(it.ts).toLocaleString('es-ES',
      {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
    const campos = Object.keys(it.body || {}).join(', ');
    return `<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;
      border:1px solid var(--line);border-radius:7px;padding:7px 10px;margin-bottom:6px">
      <span style="font-size:13px">${esc(it.label || campos || 'cambio')}
        <span class="mono" style="color:var(--muted);font-size:11px"> · ${esc(campos)}</span></span>
      <span class="mono" style="font-size:11px;color:var(--muted);white-space:nowrap">${cuando}</span>
    </div>`;
  }).join('');
}

async function offRefresh() {
  if (!_tieneStore()) return;
  const r = await Store.syncNow({force: true});
  toast(r && r.error ? 'No se pudo sincronizar (¿sin conexión?)' : 'Datos actualizados');
  loadOffline();
}

async function offVerify() {
  if (!_tieneStore()) return;
  const btn = $('#off-verify-btn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Comprobando…';
  try {
    const rep = await Store.verify();
    const n = ['routes', 'planned'].reduce((acc, k) =>
      acc + (rep[k] ? rep[k].missing.length + rep[k].stale.length + rep[k].extra.length : 0), 0);
    toast(n ? `Reparadas ${n} diferencia(s)` : 'La copia local coincide con el servidor');
    loadOffline();
  } catch (e) {
    toast('La comprobación necesita conexión');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function offPrefetch() {
  if (!_tieneStore()) return;
  if (!Store.isOnline()) { toast('Descargar necesita conexión'); return; }
  const btn = $('#off-prefetch-btn'), bg = $('#off-prefetch-bar-bg'), bar = $('#off-prefetch-bar');
  btn.disabled = true;
  bg.style.display = '';
  const res = await Store.prefetchAll((hechas, total, fallidas) => {
    bar.style.width = Math.round((hechas / total) * 100) + '%';
    $('#off-prefetch-info').textContent = `${hechas} / ${total}`
      + (fallidas ? ` · ${fallidas} fallo(s)` : '');
  });
  btn.disabled = false;
  setTimeout(() => { bg.style.display = 'none'; bar.style.width = '0'; }, 800);
  toast(res.failed ? `${res.done - res.failed} descargada(s), ${res.failed} fallo(s)`
                   : `${res.done} ruta(s) disponibles sin conexión`);
  loadOffline();
}

async function offFlush() {
  if (!_tieneStore()) return;
  const r = await Store.flushOutbox();
  toast(r.sent || r.dropped
    ? `${r.sent} enviado(s)${r.dropped ? `, ${r.dropped} descartado(s)` : ''}`
    : 'No se pudo enviar (¿sin conexión?)');
  loadOffline();
}

async function offDiscard() {
  if (!_tieneStore()) return;
  const items = await Store._getAll('outbox');
  if (!items.length) { toast('No hay nada pendiente'); return; }
  if (!confirm(`¿Descartar ${items.length} cambio(s) sin enviar? Se perderán.`)) return;
  for (const it of items) await Store._del('outbox', it.id);
  toast('Cambios pendientes descartados');
  loadOffline();
}

async function offClear() {
  if (!_tieneStore()) return;
  const pend = await Store.pendingCount();
  const extra = pend ? `\n\nOJO: hay ${pend} cambio(s) sin enviar que se perderán.` : '';
  if (!confirm('¿Vaciar la copia local de este dispositivo?' + extra
    + '\n\nNo se borra nada del servidor: los datos se vuelven a descargar.')) return;
  await Store.clearLocal();
  toast('Copia local vaciada');
  loadOffline();
}

/* ── ajustes ─────────────────────────────────────────────────────────────── */
const _CFG_ACTIVITIES=['senderismo','bicicleta','caminata','correr','esqui','otros'];
let _gpxTypesCustom={};
let _gpsThresholds={};

function renderGpsThrTable(){
  const tbody=$('#gps-thr-tbody');
  if(!tbody)return;
  tbody.innerHTML='';
  _CFG_ACTIVITIES.forEach(act=>{
    const th=_gpsThresholds[act]||{};
    const tr=document.createElement('tr');
    const inp=(k,step)=>`<input type="number" min="0" step="${step}" class="cfg-input"
      style="width:100%" id="gps-thr-${act}-${k}" value="${th[k]??''}">`;
    tr.innerHTML=`<td style="text-transform:capitalize">${act}</td>
      <td>${inp('max_speed_kmh','1')}</td>
      <td>${inp('max_vert_rate_ms','0.5')}</td>
      <td>${inp('max_ele_m','50')}</td>`;
    tbody.appendChild(tr);
  });
}

async function saveGpsThresholds(){
  const payload={};
  for(const act of _CFG_ACTIVITIES){
    const v=k=>parseFloat($(`#gps-thr-${act}-${k}`).value);
    const th={max_speed_kmh:v('max_speed_kmh'),max_vert_rate_ms:v('max_vert_rate_ms'),max_ele_m:v('max_ele_m')};
    if(Object.values(th).some(x=>isNaN(x)||x<=0)){toast(`Umbrales inválidos en «${act}»`);return;}
    payload[act]=th;
  }
  const res=await fetch('/api/settings/gps-thresholds',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(res.ok){toast('Umbrales guardados. Se aplican al reescanear o guardar cada ruta.');}
  else{const j=await res.json().catch(()=>({}));toast(j.error||'Error al guardar los umbrales');}
}

async function openSettings(){
  try{
    const r=await fetch('/api/settings');
    const c=await r.json();
    $('#cfg-immich-url').value    = c.IMMICH_URL        || '';
    $('#cfg-immich-key').value    = c.IMMICH_API_KEY    || '';
    $('#cfg-immich-margin').value = c.IMMICH_MARGIN_MIN || '180';
    $('#cfg-immich-dist').value   = c.IMMICH_DIST_M     || '100';
    $('#cfg-dem-url').value       = c.DEM_URL           || '';
    $('#cfg-planner-url').value   = c.PLANNER_URL       || '';
    $('#cfg-geocode-url').value   = c.GEOCODE_URL       || '';
  }catch(e){}
  try{
    const r=await fetch('/api/settings/gpx-types');
    _gpxTypesCustom=await r.json();
  }catch(e){_gpxTypesCustom={};}
  renderGpxTypesTable();
  try{
    const r=await fetch('/api/settings/gps-thresholds');
    _gpsThresholds=await r.json();
  }catch(e){_gpsThresholds={};}
  renderGpsThrTable();
  loadMaps();
  loadMifit();
  loadOffline();
  cfgSection('immich',$('#cfg-nav-immich'));
  $('#cfg-overlay').classList.remove('hidden');
}

function closeSettings(){ clearInterval(_mifitPoll); $('#cfg-overlay').classList.add('hidden'); }

function cfgSection(name,btn){
  document.querySelectorAll('.cfg-nav-item').forEach(b=>b.classList.remove('on'));
  document.querySelectorAll('.cfg-sec-content').forEach(s=>s.classList.add('hidden'));
  btn.classList.add('on');
  $(`#cfg-sec-${name}`).classList.remove('hidden');
  $('#cfg-topbar-title').textContent=btn.textContent.trim();
}

async function saveSettings(){
  const res=await fetch('/api/settings',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      IMMICH_URL:        $('#cfg-immich-url').value.trim(),
      IMMICH_API_KEY:    $('#cfg-immich-key').value.trim(),
      IMMICH_MARGIN_MIN: $('#cfg-immich-margin').value.trim(),
      IMMICH_DIST_M:     $('#cfg-immich-dist').value.trim(),
      DEM_URL:           $('#cfg-dem-url').value.trim(),
      PLANNER_URL:       $('#cfg-planner-url').value.trim(),
      GEOCODE_URL:       $('#cfg-geocode-url').value.trim(),
    }),
  });
  if(res.ok){ closeSettings(); toast('Ajustes guardados'); }
  else toast('Error al guardar los ajustes');
}

/* ── Mapas (capa por defecto + mapa offline PMTiles) ─────────────────────── */
/* Los .pmtiles disponibles los descubre el servidor mirando data/tiles/
   (/api/maps), no se escriben a mano: así no se puede configurar un archivo que
   no existe, que daría 404 en cada tesela. El cambio de capa por defecto solo
   afecta a los mapas que se creen a partir de la siguiente carga de página. */
async function loadMaps(){
  let m={};
  try{ m=await (await fetch('/api/maps')).json(); }catch(e){ return; }
  const dir=$('#cfg-map-dir'); if(dir) dir.textContent=m.tiles_dir||'data/tiles/';
  const file=$('#cfg-map-offline');
  if(file){
    file.innerHTML='<option value="">(ninguno)</option>'+
      (m.tilesets||[]).map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
    // Si el archivo configurado ya no está en la carpeta, se añade marcado como
    // ausente en vez de perder el ajuste en silencio al guardar.
    if(m.offline_file&&!(m.tilesets||[]).includes(m.offline_file)){
      file.innerHTML+=`<option value="${esc(m.offline_file)}">${esc(m.offline_file)} (no encontrado)</option>`;
    }
    file.value=m.offline_file||'';
  }
  const def=$('#cfg-map-default');
  if(def){
    // Las capas que ofrece el selector son las de static/shared.js; "Offline
    // (local)" solo aparece si hay un PMTiles configurado y presente.
    def.innerHTML=basemapNames().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    def.value=(m.default_layer&&basemapNames().includes(m.default_layer))?m.default_layer:defaultBasemap();
  }
  if($('#cfg-map-maxzoom')) $('#cfg-map-maxzoom').value=m.maxzoom||14;
  if($('#cfg-map-attr'))    $('#cfg-map-attr').value=m.attribution||'';
}

async function saveMapSettings(){
  const res=await fetch('/api/settings',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      MAP_DEFAULT_LAYER:       $('#cfg-map-default').value,
      MAP_OFFLINE_FILE:        $('#cfg-map-offline').value,
      MAP_OFFLINE_MAXZOOM:     $('#cfg-map-maxzoom').value.trim()||'14',
      MAP_OFFLINE_ATTRIBUTION: $('#cfg-map-attr').value.trim(),
    })});
  if(!res.ok){ toast('Error al guardar los ajustes de mapas'); return; }
  closeSettings();
  toast('Ajustes de mapas guardados. Recarga la página para aplicarlos.');
}

/* ── Mi Fit / Zepp ───────────────────────────────────────────────────────── */
let _mifitPoll=null;

function _mifitDateTime(iso){
  try{ return new Date(iso).toLocaleString('es-ES',{day:'2-digit',month:'short',
    year:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){ return iso; }
}

function _mifitApplyStatus(st){
  const badge=$('#mifit-status-badge'), detail=$('#mifit-status-detail');
  const dtEl=$('#mifit-last-sync-dt'), resEl=$('#mifit-last-sync-result');
  if(!badge) return;
  // Bloque 1 (badge): SOLO salud de conexión, no estado de sincronización.
  let cls='ok', label='Conectado ✓', hint='';
  if(!st.has_token){ cls='warn'; label='Sin token'; hint='Añade tu apptoken para empezar.'; }
  else if(st.status==='token_expired' || st.status==='needs_login'){
    cls='err'; label='Token caducado — reconecta';
  }
  badge.className='mifit-badge '+cls;
  badge.textContent=label;
  detail.textContent=hint;
  // Bloque 2 (registro): última sincronización + resultado (o "Sincronizando…").
  dtEl.textContent = st.last_sync ? _mifitDateTime(st.last_sync) : 'Nunca';
  if(st.status==='running' || st.requested) resEl.textContent='Sincronizando…';
  else resEl.textContent = (st.last_result && st.last_result.mensaje) ? st.last_result.mensaje : '';
}

async function refreshMifitStatus(){
  try{ const st=await (await fetch('/api/mifit/status')).json(); _mifitApplyStatus(st); return st; }
  catch(e){ return null; }
}

function _mifitToggleFreq(){
  // La frecuencia solo aplica con la sincronización automática activada: se
  // atenúa/deshabilita cuando el toggle está off, para que se entienda.
  const on=$('#cfg-mifit-enabled').checked, f=$('#cfg-mifit-freq-field');
  $('#cfg-mifit-interval').disabled=!on;
  if(f) f.style.opacity=on?'1':'.5';
}

async function loadMifit(){
  try{
    const s=await (await fetch('/api/mifit/settings')).json();
    $('#cfg-mifit-endpoint').value = s.endpoint || 'https://api-mifit.huami.com';
    // El desplegable ya no tiene "0" (el toggle gobierna on/off); si venía 0, muestra 6 h.
    $('#cfg-mifit-interval').value = String(s.interval_min || 360);
    $('#cfg-mifit-since').value = s.since_date || '';
    $('#cfg-mifit-enabled').checked = !!s.enabled;
    $('#cfg-mifit-token').value='';
    $('#cfg-mifit-token').placeholder = s.has_token
      ? ('token guardado ••••'+(s.token_last4||''))
      : 'pega aquí el apptoken';
  }catch(e){}
  _mifitToggleFreq();
  refreshMifitStatus();
}

async function _mifitPost(body, okMsg){
  const res=await fetch('/api/mifit/settings',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(res.ok){ if(okMsg){ toast(okMsg); loadMifit(); } }
  else{ const j=await res.json().catch(()=>({})); toast(j.error||'Error al guardar los ajustes'); }
  return res.ok;
}

// Bloque 1: token (solo si se ha escrito uno nuevo) + región.
async function saveMifitConexion(){
  const body={endpoint:$('#cfg-mifit-endpoint').value};
  const tok=$('#cfg-mifit-token').value.trim();
  if(tok) body.token=tok;
  await _mifitPost(body, 'Conexión guardada');
}

// Bloque 2: auto on/off + frecuencia + fecha "Importar desde".
async function saveMifitOpciones(){
  await _mifitPost({
    enabled:      $('#cfg-mifit-enabled').checked,
    interval_min: parseInt($('#cfg-mifit-interval').value,10)||360,
    since_date:   $('#cfg-mifit-since').value || '',
  }, 'Opciones guardadas');
}

// Guardado silencioso de TODO el formulario, usado por los botones de sync para
// persistir lo que hay en pantalla antes de disparar (aunque no hayas pulsado Guardar).
async function saveMifitSettings(silent){
  const body={
    enabled:      $('#cfg-mifit-enabled').checked,
    endpoint:     $('#cfg-mifit-endpoint').value,
    interval_min: parseInt($('#cfg-mifit-interval').value,10)||360,
    since_date:   $('#cfg-mifit-since').value || '',
  };
  const tok=$('#cfg-mifit-token').value.trim();
  if(tok) body.token=tok;
  const ok=await _mifitPost(body, silent?null:'Ajustes de Mi Fit guardados');
  return ok;
}

async function mifitReimport(){
  const since=$('#cfg-mifit-since').value;
  const msg = since
    ? `Se reiniciará la marca y se reimportará desde ${since}. El historial ya existente se omite por duplicado. ¿Continuar?`
    : 'No has puesto fecha en "Importar desde": se reimportará TODO tu historial. ¿Continuar?';
  if(!confirm(msg)) return;
  await mifitSyncNow(true);
}

async function mifitSyncNow(reset){
  const btns=[$('#mifit-sync-btn'), $('#mifit-reimport-btn')];
  // Siempre persistimos el formulario (fecha/región/intervalo/token) antes de
  // disparar: así el botón respeta lo que hay en pantalla aunque no hayas
  // pulsado "Guardar ajustes".
  if(!await saveMifitSettings(true)) return;
  const res=await fetch('/api/mifit/sync',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({reset:!!reset})});
  if(!res.ok){ const j=await res.json().catch(()=>({})); toast(j.error||'No se pudo encolar la sincronización'); return; }
  toast(reset ? 'Reimportación encolada…' : 'Sincronización encolada…');
  btns.forEach(b=>b&&(b.disabled=true));
  clearInterval(_mifitPoll);
  let ticks=0;
  _mifitPoll=setInterval(async()=>{
    ticks++;
    const st=await refreshMifitStatus();
    const busy = st && (st.status==='running' || st.requested);
    if(!busy || ticks>200){                      // ~10 min de sondeo como tope (un backfill puede tardar)
      clearInterval(_mifitPoll); btns.forEach(b=>b&&(b.disabled=false));
      if(st && st.last_result && st.last_result.mensaje) toast(st.last_result.mensaje);
    }
  },3000);
}

/* ── ingesta ─────────────────────────────────────────────────────────────── */
function _actOpts(sel){
  return _CFG_ACTIVITIES.map(a=>`<option value="${a}"${a===sel?' selected':''}>${a}</option>`).join('');
}

function renderGpxTypesTable(){
  const tbody=$('#gpx-types-tbody');
  tbody.innerHTML='';
  for(const[k,v] of Object.entries(_gpxTypesCustom)){
    tbody.appendChild(_gpxTypeRow(k,v));
  }
}

function _gpxTypeRow(key,val){
  key=key||''; val=val||'senderismo';
  const tr=document.createElement('tr');
  tr.innerHTML=
    `<td><input class="cfg-input gpx-type-key" value="${esc(key)}" placeholder="ej: trail biking" style="min-width:180px"></td>`+
    `<td><select class="cfg-input gpx-type-val" style="width:150px">${_actOpts(val)}</select></td>`+
    `<td><button class="btn ghost sm" style="padding:4px 9px;color:var(--gr-red);border-color:var(--gr-red)" `+
    `onclick="this.closest('tr').remove()">✕</button></td>`;
  return tr;
}

function addGpxTypeRow(){
  $('#gpx-types-tbody').appendChild(_gpxTypeRow('','senderismo'));
}

async function saveGpxTypes(){
  const map={};
  for(const tr of document.querySelectorAll('#gpx-types-tbody tr')){
    const k=tr.querySelector('.gpx-type-key').value.trim().toLowerCase();
    const v=tr.querySelector('.gpx-type-val').value;
    if(k) map[k]=v;
  }
  const res=await fetch('/api/settings/gpx-types',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(map),
  });
  if(res.ok){_gpxTypesCustom=map;toast('Mapeos guardados');}
  else toast('Error al guardar los mapeos');
}

document.addEventListener('keydown', e=>{
  if(e.key==='Escape' && !$('#cfg-overlay').classList.contains('hidden')) closeSettings();
});
$('#cfg-overlay').addEventListener('click', e=>{
  if(e.target===$('#cfg-overlay')) closeSettings();
});

