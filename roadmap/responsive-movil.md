# Plan: adaptación responsive para móvil (6.5″, ~390–430 px CSS)

Objetivo: que la SPA (`app.html`), el detalle de ruta (`sendero.html`), el detalle de plan
(`plan_detalle.html`) y —de forma limitada— el editor (`editor.html`) funcionen bien en un
móvil de 6.5 pulgadas (viewport típico 390–430 px de ancho, táctil, sin hover ni teclado).

Restricciones que se respetan: sin build step (JS inline en Jinja2), UI en español,
paleta actual (`--panel` #17241c etc.), sin frameworks.

## Diagnóstico resumido (estado actual)

- El meta viewport ya es correcto (`base.html:5`). Solo existen 5 media queries en todo el
  proyecto: 4 a `max-width:560px` (header y tamaño de stats) y 1 a `900px` (grid del editor
  y Vista B de Mis Rutas). Nada específico para 390–430 px.
- **Crítico**: en <560 px la navegación principal se oculta (`base.html:46`,
  `.header-nav{display:none}`) **sin reemplazo** — en móvil no se puede cambiar de sección.
- Dashboard: `.hero-grid` fija a 4 columnas (`app.html:41`); tarjetas de ~85 px en móvil.
- Modal de Ajustes: sidebar fija de 176 px + tablas con columnas fijas (120–160 px ×3-4)
  → overflow horizontal garantizado en 400 px.
- Targets táctiles casi todos entre 22 y 30 px de alto (guía: 44 px): `.btn.sm`, `.pill`,
  `.sort-btn`, `.nav-link`, flechas del datepicker (26 px), celdas de día (~28 px).
- Interacciones hover-only sin equivalente táctil: botón borrar de miniaturas de fotos
  (`sendero.html:34`, `opacity:0` salvo `:hover`), tooltips de mapa por `mouseenter`,
  hover sincronizado mapa↔gráficos, y en el editor Alt+click / Shift+click / rueda.
- Alturas de mapa fijas (320/340/380 px) y uso de `100vh` (salta con la barra del
  navegador móvil; no se usa `dvh` en ningún sitio).
- Lightbox: imagen limitada a `calc(100vw - 140px)` → 250 px de foto en un móvil de 390 px;
  sin swipe, sin cierre por tap en el fondo.
- Tarjeta de ruta: thumbnail lateral al 42 % del ancho — en móvil (1 columna, tarjeta ancha)
  se come casi media tarjeta.

---

## Fase 0 — Fundamentos globales (`base.html`) — prerequisito de todo lo demás

1. **Unificar breakpoints**: dos puntos de corte en todo el proyecto —
   `900px` (tablet/apilado, ya existe) y `600px` (móvil; sustituye a los `560px` actuales).
   Documentarlos en comentario CSS en `base.html`.

2. **Navegación móvil: tab bar inferior**. En <600 px, en vez de ocultar `.header-nav`,
   mostrar una barra fija inferior con 4 pestañas: Dashboard · Rutas · Planes · Ajustes
   (iconos + etiqueta 10-11 px, altura ≥56 px). Detalles:
   - `position:fixed; bottom:0; padding-bottom:env(safe-area-inset-bottom)` (notch/gesto iOS).
   - Reutiliza los mismos `<a class="nav-link">` (mismo router SPA); estado activo con
     `--pr-yellow`.
   - Compensar con `padding-bottom` en `body`/`.wrap` para que el contenido no quede tapado.
   - Subir `.toast` (`base.html:115`) por encima de la barra en móvil.
   - En páginas fuera de la SPA (`sendero.html`, `plan_detalle.html`, `editor.html`) la barra
     puede omitirse (ya tienen "← Volver"); basta con condicionarla al bloque Jinja que ya
     distingue páginas, o con una clase en `<body>`.

3. **Header compacto en móvil**: logo + título en una sola fila (h1 a ~22 px, logo 36 px),
   sin apilar en columna; los `header_actions` de cada sección se recolocan (ver Fase 1).

4. **Targets táctiles**: bloque global
   `@media (hover:none) and (pointer:coarse) { .btn,.btn.sm,.pill,.sort-btn,.view-btn,.nav-link { min-height:44px; } }`
   (con padding proporcional). Ventaja de `hover:none` sobre el ancho: aplica en táctil real
   y no castiga a un desktop con ventana estrecha.

5. **Neutralizar hover-only globalmente**: dentro del mismo bloque `hover:none`, desactivar
   los `transform:translateY(-2px)` de `.card`/`.record-card`/`.plan-card` (en táctil dejan
   la tarjeta "levantada" tras el tap) y forzar visibles los controles que hoy solo aparecen
   con `:hover`.

6. **`100vh` → `100dvh`**: en `.cfg-fullscreen` (`base.html:54`) y `#dash-wrap.view-b`
   (`app.html:207`), con fallback: `height:calc(100vh - X); height:calc(100dvh - X);`.

7. **Modal de Ajustes responsive** (<600 px):
   - `.cfg-fullscreen` a pantalla completa (`inset:0`, `border-radius:0`, `height:100dvh`).
   - `.cfg-sidebar` (176 px vertical) → fila horizontal de pestañas con scroll
     (`overflow-x:auto`, `flex-direction:row`).
   - Tablas de tipos GPX y umbrales GPS: envolver en contenedor `overflow-x:auto`
     (solución mínima) — reformatear a tarjetas apiladas queda como mejora opcional.
   - Inputs con `font-size:16px` en móvil (evita el auto-zoom de iOS Safari al enfocar).
     Aplicar esta regla a **todos** los `input`/`select`/`textarea` del proyecto.

## Fase 1 — SPA `app.html` (Dashboard, Mis Rutas, Mis Planes)

**Dashboard**
1. `.hero-grid`: `repeat(4,1fr)` → `repeat(2,1fr)` en <600 px (2×2, números legibles).
2. `#dash-map`: `height:320px` → `height:40dvh; min-height:260px` en móvil.
3. `.act-row` (`110px 1fr 80px 80px` = 270 px fijos): en <600 px pasar a
   `grid-template-columns:90px 1fr 64px 56px` con fuentes 12 px, o dos líneas
   (nombre+barra / cifras).
4. Tooltips hover del mapa (`mouseenter` sobre `unclustered`): en táctil el tap ya navega a
   la ruta; añadir además apertura del popup en `click` antes de navegar no compensa —
   dejarlo como está y documentarlo.

**Mis Rutas**
5. **Forzar Vista A en móvil**: ocultar los `.view-btn` del header en <600 px y no ofrecer
   la Vista B "Panel" (su media query de 900 px ya la apila, pero duplica esfuerzo de QA
   para cero beneficio en un móvil). Menos superficie que mantener.
6. **Filtros colapsables**: la barra `.filters` (~9 controles) + `.sort-bar` ocupan media
   pantalla en 400 px. En <600 px, colapsarlas tras un botón "☰ Filtros y orden" (badge con
   nº de filtros activos). Implementación sin build: un contenedor con clase `.open` toggle.
7. **"Añadir ruta" como FAB**: en <600 px sacar el label/input file del header a un botón
   flotante circular (＋) abajo a la derecha (por encima de la tab bar,
   `bottom:calc(64px + env(safe-area-inset-bottom))`). El drag&drop global no existe en
   móvil; el FAB es la única vía de subida y debe ser prominente.
8. **Tarjeta de ruta**: `.card-thumb` del 42 % → ~30 % en <600 px con el degradado
   empezando antes, `h3` de 22 → 17-18 px, padding 10px 14px. Alternativa (más cambio,
   mejor resultado): thumbnail como banda superior de 72 px con el texto debajo — decidir
   viendo el resultado del ajuste simple primero.
9. `#overview-map`: `340px` → `38dvh; min-height:240px` en móvil. Mantener `fitMap(true)`
   en el primer encuadre (regla existente).
10. **Modo edición**: `.edit-bar` como barra sticky inferior en móvil (encima de la tab
    bar) — los botones Re-escanear(n)/Eliminar(n) siempre visibles mientras seleccionas.
11. `.dp-pop` (datepicker, `position:fixed; width:230px`): clamp por JS a
    `[8px, innerWidth-238px]` en X; celdas de día a ≥36 px y flechas `.dp-nav` a 36 px
    en móvil.
12. `.upload-loader`: `min-width:300px; right:24px` → `left:12px; right:12px; min-width:0`
    en <600 px.

**Mis Planes**
13. `#plan-map`: mismo tratamiento de altura que los otros mapas. `.plan-grid` ya cae a
    1 columna sola. Modal "Planificar ruta" ya es `width:100%;max-width:520px` — solo
    reducir su `padding:22px` a 16 px en móvil.

## Fase 2 — Detalle de ruta `sendero.html`

1. **Cabecera**: `#d-name` 34 px → 24 px en <600 px. Los 5 botones (Editar, Reescanear,
   GPX, Renombrar, Eliminar) → dejar visibles "✎ Editar" y un botón "⋯" que despliega el
   resto en un menú (mismo patrón CSS `.open` que los filtros). Evita 2-3 filas de botones
   antes del mapa.
2. **Mapa**: `#map` 380 px → `45dvh; min-height:280px` en móvil.
3. **Gráficas (elevación/velocidad/FC)**: envolver cada `<canvas>` en un div con altura
   explícita (p. ej. 160 px en móvil) y pasar los charts a `maintainAspectRatio:false` —
   con el ratio automático actual, en 390 px de ancho quedan enanas (~90 px). Verificar el
   hover sincronizado tras el cambio (checklist del CLAUDE.md).
4. **Hover sincronizado en táctil**: alcance realista —
   - Gráficos→resto: los `onHover` de Chart.js ya reciben el tap; añadir
     `touchmove`/`touchend` sobre cada canvas que traduzca a `setHoverD()` /
     `setHoverD(null)` (respetando la regla de asignación directa `ctx.onmouseleave`,
     misma técnica: `ctx.ontouchmove = ...`, sin `addEventListener`).
   - Mapa→gráficos: omitir en táctil (mousemove continuo no existe; un tap en el track no
     aporta). El cuadro `.hover-infobox` debe clamp-earse al borde derecho del mapa
     (`white-space:nowrap` desborda hoy incluso en desktop estrecho).
5. **Lightbox**:
   - `.lb-img`: `max-width:calc(100vw - 140px)` → `100vw` en <600 px (flechas superpuestas
     semitransparentes sobre la foto, no reservando 70 px por lado).
   - Swipe táctil: `touchstart`/`touchend` con umbral de ~40 px → `lbNav(±1)` (~15 líneas).
   - Cierre por tap en el fondo (target = overlay, no la imagen), además del botón ✕
     (subir su área táctil a 44 px).
6. **Borrar miniatura**: `.thumb .del` visible siempre en `@media (hover:none)` (hoy es
   `opacity:0` salvo hover → inaccesible en táctil).
7. **Modal Immich**: en <600 px pasarlo a pantalla completa (`inset:0`, `max-height:100dvh`,
   sin radios); `.modal-foot` con `flex-wrap:wrap`; añadir cierre por tap en backdrop y
   Escape (hoy solo lo tiene `#cfg-overlay`). **Cuidado**: mantener la regla
   `.overlay.hidden{display:none}` inmediatamente después de `.overlay{display:flex}`
   (bug documentado).
8. **Grid de stats**: ya envuelve bien (2 columnas con `min-width:120px`); solo bajar el
   padding de `.section` de 18 → 14 px y el de `.wrap` de 22 → 14 px en móvil (global,
   Fase 0).

## Fase 3 — Detalle de plan `plan_detalle.html` (barata, casi lista)

1. Mismo patrón que sendero: título 34 → 24 px, mapa 380 px → `45dvh`, padding reducido.
2. La gráfica de elevación: mismo tratamiento de contenedor + `maintainAspectRatio:false`.
3. El resto ya es táctil-compatible (Leaflet con gestos nativos, modal con cierre por
   backdrop y Escape). Sin más trabajo.

## Fase 4 — Editor `editor.html` (alcance limitado y explícito)

El editor es intrínsecamente de escritorio (Alt+click, Shift+click, rueda, drag de vértices
de 3–6.5 px). **Propuesta: no buscar paridad total en móvil**; hacer usable el subconjunto
que tiene sentido en el campo y comunicar el resto.

Usable en móvil (con estos ajustes):
1. Breakpoint 600 px además del 900 existente: toolbar de operaciones como acordeón
   (los 6 `.tool-panel` ya son desplegables; agrupar también las 6 ops de selección),
   `#edmap` a `50dvh`, gráficas con contenedor de altura fija +
   `maintainAspectRatio:false` (hoy `true` → enanas en 390 px).
2. Selección A–B: ya funciona en táctil (los manejadores son markers draggable de MapLibre
   y `bindChartDrag` ya tiene handlers touch). Verificar y subir el radio de los
   manejadores de 20 → 28 px en `hover:none`.
3. Recortar / eliminar tramo / invertir / dividir / deshacer / rehacer / guardar: son
   botones — funcionan con los targets de 44 px de la Fase 0.
4. Zoom de gráficas: añadir botones ＋/− junto a la gráfica en `hover:none` (la rueda no
   existe en táctil; pinch sobre canvas de Chart.js no compensa implementarlo a mano).
5. Modo "Editar puntos" en móvil: **deshabilitarlo** con un aviso ("Edición de vértices
   disponible en pantalla con ratón") en `hover:none`. Alternativa cara (modo v2 si se
   pide): toggles "borrar" / "añadir waypoint" que arman el siguiente tap, sustituyendo
   Alt+click y Shift+click, y radio de hit táctil ampliado para vértices.
6. `touch-action:none` en `#edelev` (línea 39) está bien para el drag de selección, pero
   revisa que la página siga pudiendo hacer scroll tocando fuera de las gráficas.

## Ajustes gráficos transversales (checklist)

| Ajuste | Valor móvil |
|---|---|
| Padding `.wrap` | 22 → 14 px |
| Padding `.section` / `.ed-panel` | 18 → 14 px |
| Títulos de página (`#d-name`, h1) | 34-40 → 22-24 px |
| Fuente mínima de labels | nada por debajo de 11 px (los 9-10 px actuales suben) |
| Inputs/select/textarea | `font-size:16px` (anti-zoom iOS) |
| Botones y pills | `min-height:44px` en `hover:none` |
| Mapas | alturas en `dvh` con `min-height` en px |
| Charts | contenedor con altura fija + `maintainAspectRatio:false` |
| Barra inferior / FAB / toast | `env(safe-area-inset-bottom)` |

## Orden recomendado y esfuerzo

| Fase | Contenido | Esfuerzo | Valor |
|---|---|---|---|
| 0 | base.html: tab bar, breakpoints, targets, Ajustes | M | Bloqueante (sin nav no hay móvil) |
| 1 | app.html: dashboard, rutas, planes | M-L | Alto (uso diario) |
| 2 | sendero.html: detalle, lightbox, Immich | M | Alto (consultar rutas en el monte) |
| 3 | plan_detalle.html | S | Medio |
| 4 | editor.html (subconjunto) | M | Bajo-medio (editar se hace en casa) |

Fases 0–3 dan una app completamente usable en móvil; la 4 puede posponerse o recortarse.

## Verificación

- Chrome DevTools en 390×844 (iPhone 12/13/14) y 412×915 (Pixel/Galaxy 6.5″), modo táctil.
- Por sección: navegar con la tab bar, subir un GPX desde el FAB, filtrar, abrir detalle,
  swipe en lightbox, seleccionar candidatos Immich, guardar notas.
- Regresiones desktop: hover sincronizado 4 direcciones en sendero.html, modal Immich
  oculto al cargar (`.overlay.hidden`), `fitMap(true)` sin animación en el primer encuadre,
  filtros de `ov-lines` (`_ovApplyLineFilter`), listeners de charts sin acumulación.
- Real: probar en el móvil contra la instancia Docker de LAN (puerto 8090).
