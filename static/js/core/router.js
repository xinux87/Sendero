/* Router de la SPA.

   Generaliza el router que ya existía en app.html (_showSec/_spaNavTo/popstate)
   de 3 a 6 vistas, añadiendo las tres que antes eran documentos aparte: detalle
   de ruta, detalle de plan y editor.

   Contrato de cada sección (static/js/sec/<sec>.js, dentro de su IIFE):
     window.SEC.<sec> = { mount(params), unmount() }
   `mount` puede ser async; `unmount` DEBE destruir mapas y Charts de la sección.
   Sin eso, navegar entre secciones acumula instancias de MapLibre y listeners
   para siempre — es la fuga más probable de toda la conversión, porque no falla
   de golpe, se degrada.
*/
const Router = (() => {
  'use strict';

  // Orden importante: la primera que encaje gana. El editor va antes que el
  // detalle porque /Sendero/<id>/editor también encajaría en el patrón del detalle.
  const ROUTES = [
    {sec: 'editor',    re: /^\/Sendero\/([^/]+)\/editor\/?$/, params: m => ({id: dec(m[1])})},
    {sec: 'detalle',   re: /^\/Sendero\/([^/]+)\/?$/,         params: m => ({id: dec(m[1])})},
    {sec: 'plan',      re: /^\/Plan\/([^/]+)\/?$/,            params: m => ({id: dec(m[1])})},
    {sec: 'dashboard', re: /^\/dashboard\/?$/,                params: () => ({})},
    {sec: 'rutas',     re: /^\/rutas\/?$/,                    params: () => ({})},
    {sec: 'planes',    re: /^\/planificacion\/?$/,            params: () => ({})},
  ];

  const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };

  // Secciones que muestran el nav del header como activo.
  const NAV_URL = {dashboard: '/dashboard', rutas: '/rutas', planes: '/planificacion'};

  let _cur = null;          // {sec, params}
  let _mounting = null;     // promesa del montaje en curso

  function parse(path) {
    for (const r of ROUTES) {
      const m = path.match(r.re);
      if (m) return {sec: r.sec, params: r.params(m)};
    }
    return null;
  }

  function el(sec) { return document.getElementById('sec-' + sec); }

  /* ¿Está esta sección en el documento actual?

     Durante la migración (§3) el shell solo aloja algunas de las 6 vistas; el
     resto sigue sirviéndose como documento propio. Navegar hacia una sección que
     no está aquí NO es un error: es una recarga de página normal, como hoy. Sin
     esta comprobación el router intentaría cargar /static/js/sec/<sec>.js, se
     comería el 404 y dejaría la vista vacía. Cuando estén las 6, siempre true. */
  function hosted(sec) { return !!el(sec); }

  function assets(sec) {
    return Promise.all([
      loadCssOnce(`/static/css/${sec}.css`),
      loadOnce(`/static/js/sec/${sec}.js`),
    ]);
  }

  /* Navega a una URL de la app. Devuelve una promesa que resuelve cuando la
     sección está montada (útil en tests y para encadenar). */
  function go(url, {push = true, bootstrap = null} = {}) {
    const path = url.split('?')[0].split('#')[0];
    const target = parse(path);
    if (!target || !hosted(target.sec)) { location.href = url; return Promise.resolve(); }
    if (push) history.pushState({sec: target.sec, params: target.params}, '', url);
    return show(target, bootstrap);
  }

  function show(target, bootstrap) {
    // Serializa los montajes: dos clics rápidos no deben montar dos secciones a
    // la vez sobre el mismo DOM.
    _mounting = Promise.resolve(_mounting).then(() => _show(target, bootstrap));
    return _mounting;
  }

  // ms del fundido de salida (debe cuadrar con la transición de .sec en base.html)
  const ANIM_OUT = 150;
  let _primero = true;      // la carga inicial no se anima

  async function _show(target, bootstrap) {
    const {sec, params} = target;
    if (_cur && _cur.sec !== sec) {
      const prev = window.SEC[_cur.sec];
      if (prev && prev.unmount) { try { prev.unmount(); } catch (e) { console.warn('[router] unmount', e); } }
      const pe = el(_cur.sec);
      if (pe) {
        // Fundido de salida antes de ocultar (lo que hacía _showSec en app.html).
        if (!_primero) {
          pe.classList.add('_sec-leaving');
          await new Promise(r => setTimeout(r, ANIM_OUT));
          pe.classList.remove('_sec-leaving');
        }
        pe.classList.add('hidden');
      }
    }
    document.documentElement.dataset.sec = sec;
    const node = el(sec);
    if (node) {
      node.classList.remove('hidden');
      if (!_primero) {
        node.classList.add('_sec-entering');
        setTimeout(() => node.classList.remove('_sec-entering'), 240);
      }
    }
    _primero = false;
    markNav(sec);
    showSectionActions(sec);
    try {
      await assets(sec);
    } catch (e) {
      // Sin conexión y sin el módulo en caché: no se puede montar la sección.
      console.warn('[router]', e);
      if (node) node.innerHTML =
        '<p class="empty">No se pudo cargar esta sección sin conexión.</p>';
      _cur = {sec, params};
      return;
    }
    const mod = window.SEC[sec];
    const same = _cur && _cur.sec === sec;
    _cur = {sec, params};
    if (!mod || !mod.mount) return;
    try {
      await mod.mount(params, {bootstrap, remount: same});
    } catch (e) {
      console.error('[router] mount ' + sec, e);
    }
  }

  function markNav(sec) {
    document.querySelectorAll('.header-nav .nav-link, .tabbar .nav-link')
      .forEach(a => {
        const href = a.getAttribute('data-nav') || a.getAttribute('href');
        a.classList.toggle('on', !!NAV_URL[sec] && href === NAV_URL[sec]);
      });
  }

  /* Acciones de cabecera por sección: los botones que en app.html vivían en
     #act-dashboard/#act-rutas/#act-planes. Van fuera de la sección (están en la
     cabecera), así que no los puede mostrar el propio módulo sin saber cuándo
     está activo: los marca `data-sec-actions="<sec>"` y los conmuta el router. */
  function showSectionActions(sec) {
    document.querySelectorAll('[data-sec-actions]').forEach(el2 => {
      el2.classList.toggle('hidden', el2.dataset.secActions !== sec);
    });
  }

  function current() { return _cur; }

  /* Cambia la URL sin navegar (renombrar una ruta no debe recargar nada). */
  function replace(url) { history.replaceState(history.state, '', url); }

  function start(initial) {
    window.addEventListener('popstate', e => {
      const t = (e.state && e.state.sec)
        ? {sec: e.state.sec, params: e.state.params || {}}
        : parse(location.pathname);
      if (!t) return;
      // Atrás/adelante hacia una vista que este documento no aloja (todavía):
      // recargar es lo correcto, el servidor sirve su propia plantilla.
      if (!hosted(t.sec)) { location.reload(); return; }
      show(t, null);
    });
    // Delegación: <a data-spa>, [data-nav] y los enlaces del nav/tab bar
    // (a.nav-link) navegan por el router. Sin `a.nav-link` aquí, el header haría
    // una recarga completa: chrome.js se aparta cuando el router sabe montar el
    // destino, y entonces nadie llamaría a go().
    document.addEventListener('click', e => {
      const a = e.target.closest('a[data-spa], [data-nav], a.nav-link');
      if (!a) return;
      const href = a.getAttribute('data-nav') || a.getAttribute('href');
      if (!href || !parse(href.split('?')[0])) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;   // abrir en pestaña
      e.preventDefault();
      go(href);
    });
    const t = parse(location.pathname);
    // El servidor solo sirve el shell para vistas que este documento aloja; si no
    // encaja, no se monta nada (mejor una página vacía que una sección errónea).
    if (!t || !hosted(t.sec)) return Promise.resolve();
    history.replaceState({sec: t.sec, params: t.params}, '', location.pathname + location.search);
    return show(t, initial && initial.bootstrap);
  }

  return {start, go, parse, current, replace, markNav};
})();

/* Atajo global: lo usan los onclick= de las plantillas (antes location.href=…). */
window.go = (url, opts) => Router.go(url, opts);
