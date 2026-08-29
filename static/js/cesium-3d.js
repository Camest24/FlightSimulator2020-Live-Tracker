// ---- Modo "Terreno 3D" real: CesiumJS con terreno/imágenes reales de Cesium ion + un
// modelo GLB real del avión, en reemplazo del terreno nativo de MapLibre + avión de
// Three.js de antes (ver plane-3d.js — ese código queda sin usarse para este modo, no
// borrado, por si hay que revertir rápido: ver flightplan.js, tg-terrain3d).
//
// Portado del prototipo aislado design/cesium-preview.html, con dos diferencias de fondo:
//  1. Posición/orientación leen datos REALES en vivo (cur/curAltFt, las mismas variables
//     globales que ya alimenta telemetry.js) en vez de un vuelo simulado. El patrón es
//     el de un CallbackProperty típico para datos en vivo: ignora el argumento "time" que
//     le pasa Cesium y devuelve el último valor conocido — sin muestreo, sin ventana de
//     tiempo, sin la carrera de relojes que causó los crashes 'reading longitude' en el
//     prototipo (ver ese archivo para la explicación completa).
//  2. Carga perezosa: Cesium.js (~2-3MB) y el modelo (14MB) NO se cargan en cada apertura
//     de la app. La LIBRERÍA se precarga sola, de fondo, unos segundos después de abrir
//     (normalmente hay tiempo muerto antes de despegar) — así, para cuando el usuario
//     toca "Terreno 3D", lo más pesado ya está listo. El VISOR (Viewer, más pesado
//     todavía: arranca su propio loop de render) recién se crea la PRIMERA vez que se
//     activa el toggle, con una pantalla de carga. Activaciones siguientes son instantáneas
//     (solo mostrar/ocultar + pausar/reanudar el render con useDefaultRenderLoop).
//
// Todo va en un IIFE: este archivo comparte scope global con los otros 9 (scripts
// clásicos, sin módulos — así está armado todo el proyecto), así que solo expone
// `window.cesium3D.setActive(bool)`. Nada más se filtra al scope compartido, para no
// arriesgar colisiones de nombres con el resto (varios, como "viewer" o "tick", son
// bastante genéricos).
(function(){
  'use strict';

  const CESIUM_VERSION = '1.133.1';
  const CESIUM_JS = 'https://cdnjs.cloudflare.com/ajax/libs/cesium/'+CESIUM_VERSION+'/Cesium.js';
  const CESIUM_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/cesium/'+CESIUM_VERSION+'/Widgets/widgets.min.css';
  // Modelo: Airbus A320-200 V2 de Dlourine (Sketchfab, CC-BY 4.0) — corregido (origen
  // recentrado, escala real ~37,5m, morro alineado). Ver design/cesium-preview.html para
  // el detalle completo de esa corrección. Licencia exige crédito: puesto en el HUD del
  // panel de capas (ver templates/index.html, junto al toggle "Terreno 3D").
  const GLB_URL = '/static/assets/a320_fixed.glb';
  const ION_TOKEN = (window.CESIUM_ION_TOKEN || '').trim();
  const HAS_TOKEN = ION_TOKEN.length > 0;

  let libraryPromise = null;
  let viewerPromise = null;
  let viewer = null;
  let viewerReady = false;
  let active = false;
  let frameLoopRunning = false;

  function loadScript(src){
    return new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = src;
      s.onload = ()=>resolve();
      s.onerror = ()=>reject(new Error('No se pudo cargar '+src));
      document.head.appendChild(s);
    });
  }
  function loadCss(href){
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }

  function ensureLibrary(){
    if(libraryPromise) return libraryPromise;
    libraryPromise = (async ()=>{
      loadCss(CESIUM_CSS);
      await loadScript(CESIUM_JS);
    })();
    return libraryPromise;
  }
  // Precarga temprana: no bloquea nada, solo empieza a bajar la librería de fondo. Si el
  // usuario nunca activa Terreno 3D, son ~2-3MB descargados de más en una sesión — el
  // trade-off que vale la pena para que la pantalla de carga casi nunca se vea.
  setTimeout(ensureLibrary, 4000);

  // ensureViewer() memoiza la promesa igual que ensureLibrary(): si el usuario destilda y
  // vuelve a tildar el toggle varias veces mientras carga la primera vez, TODAS las
  // llamadas comparten la misma promesa en vez de disparar initViewer() más de una vez
  // (dos Viewer sobre el mismo <div> tira error).
  function ensureViewer(){
    if(viewerReady) return Promise.resolve();
    if(viewerPromise) return viewerPromise;
    viewerPromise = ensureLibrary().then(()=>{
      initViewer();
      viewerReady = true;
    });
    return viewerPromise;
  }

  // ---- Cámara: orbit manual, centrada en el avión SIEMPRE (mismo enfoque del prototipo:
  // lookAtTransform con offset EXPLÍCITO cada frame — nunca omitido, para no activar el
  // modo "look" nativo de Cesium, que descentra la cámara al arrastrar) ----
  let targetHeading = 0, orbitHeading = 0;
  let targetPitch = Math.atan2(42, 110), orbitPitch = targetPitch;
  let targetRange = Math.hypot(110, 42), orbitRange = targetRange;
  let maxPitchRad = 0; // se fija en initViewer() (necesita Cesium.Math, no cargado todavía acá)
  // posProp/orientProp se asignan en initViewer() (recién ahí existe Cesium.CallbackProperty)
  // pero se declaran acá afuera para que frameTick() pueda usar el MISMO cálculo que ya usa
  // el modelo — nada de duplicar la cuenta del banqueo en dos lugares distintos.
  let posProp = null, orientProp = null;

  // ---- Altitud renderizada: anclada al terreno REAL de Cesium, no a un cálculo ciego de
  // "altitud MSL = altura sobre el elipsoide". INDICATED_ALTITUDE (lo que manda el sim en
  // s.alt) es una altitud barométrica/MSL; Cartesian3.fromDegrees espera altura sobre el
  // ELIPSOIDE WGS84 — son dos referencias distintas, y la diferencia entre ellas (ondulación
  // del geoide) varía según el punto del planeta y puede ser de varios metros a varias
  // decenas de metros. Pasar curAltFt directo ahí es lo que causaba que el avión apareciera
  // "flotando" a varios metros del suelo en la vista 3D aunque en MSFS estuviera exactamente
  // sobre la pista (on_ground=true, altitud de campo correcta).
  //
  // Fix: cuando el avión está en tierra, lo anclamos DIRECTO a la altura de terreno que
  // Cesium ya tiene cargada en ese punto (ground truth real — no importa qué diga el
  // altímetro) y de paso calibramos groundRefFt = "qué altitud MSL reporta el sim cuando
  // estamos apoyados en el suelo, acá mismo". En vuelo usamos esa referencia para estimar
  // AGL (altitud actual menos esa referencia) y lo sumamos al terreno del punto actual bajo
  // el avión. No es el AGL real del sim (todavía no lo expone /api/state), pero es exacto
  // cerca de despegue/aterrizaje — justo donde el error se notaba — y se recalibra solo cada
  // vez que el avión vuelve a tocar tierra.
  let groundRefFt = null;
  let lastTerrainM = 0;
  let smoothTerrainM = null;
  function terrainHeightAt(lng, lat){
    try{
      const h = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lng, lat));
      if(h!=null && isFinite(h)) lastTerrainM = h;
    }catch(e){ /* tile de terreno todavía no cargado en este punto: seguimos con el último valor conocido */ }
    // Suavizado leve: el terreno cargado cambia de nivel de detalle según se mueve la
    // cámara (maximumScreenSpaceError), y cada cambio de LOD puede devolver una altura
    // ligeramente distinta en el mismo punto de un frame a otro — eso es lo que se veía
    // como "z-fighting con el aire" (el avión vibrando contra el suelo). Un lerp rápido
    // (0.3, sigue el valor real en pocos frames, nada de retraso perceptible) absorbe ese
    // ruido sin esconder cambios reales de altura.
    smoothTerrainM = (smoothTerrainM==null) ? lastTerrainM : smoothTerrainM + (lastTerrainM - smoothTerrainM) * 0.3;
    return smoothTerrainM;
  }
  // Cache de un solo frame: posProp Y orientProp llamaban esto cada uno por su cuenta —
  // el doble de globe.getHeight() por frame de lo necesario, y encima con la posibilidad
  // de que la cámara se moviera entre medio y las dos lecturas no coincidieran (otra
  // fuente de jitter). Ahora se calcula una sola vez por frame y el segundo llamado
  // reusa el resultado.
  let cachedAltM = 0, cachedAltAtMs = -1;
  // curOnGround puede llegar con una lectura suelta rara (rebote del tren, ruido del propio
  // SimConnect) — si eso pasa mientras el avión ya está volando, recalibrar groundRefFt con
  // ESA lectura corrompe la referencia de AGL para el resto del vuelo (posible causa de
  // "el avión sube sin sentido"). Por eso no se confía en on_ground=true hasta que lleve
  // sostenido más de un ciclo de polling (250ms, ver geo-utils.js) — un blip de una sola
  // muestra ya no alcanza para recalibrar.
  let groundSinceMs = null;
  function isGroundTrusted(){
    if(!curOnGround){ groundSinceMs = null; return false; }
    if(groundSinceMs==null) groundSinceMs = performance.now();
    return (performance.now() - groundSinceMs) > 300;
  }
  // Diagnóstico: si esto sigue raro después de todos los ajustes anteriores, es mejor medir
  // que seguir adivinando. Un log throttleado a 1/seg con los valores crudos que alimentan
  // la altura renderizada — con esto en la consola (F12 en PC, Web Inspector en iPad) se ve
  // exactamente cuál de los tres (terreno crudo, on_ground, o curAltFt) es el que salta.
  let lastDiagAt = 0;
  function diagLog(terrainRaw, terrainSmooth, aglM){
    const nowMs = performance.now();
    if(nowMs - lastDiagAt < 1000) return;
    lastDiagAt = nowMs;
    console.log('[cesium3d]', {
      curOnGround, groundTrusted: isGroundTrusted(), groundRefFt,
      curAltFt: Math.round(curAltFt), terrainRawM: Math.round(terrainRaw), terrainSmoothM: Math.round(terrainSmooth),
      aglM: Math.round(aglM), altM: Math.round(cachedAltM), hdg: Math.round(cur.hdg),
    });
  }
  function renderAltitudeM(){
    const nowMs = performance.now();
    if(nowMs - cachedAltAtMs < 8) return cachedAltM;
    cachedAltAtMs = nowMs;
    const terrainM = terrainHeightAt(cur.lng, cur.lat);
    if(isGroundTrusted()){
      groundRefFt = curAltFt;
      cachedAltM = terrainM;
      diagLog(lastTerrainM, terrainM, 0);
      return cachedAltM;
    }
    if(groundRefFt!=null){
      const aglM = Math.max(0, (curAltFt - groundRefFt) * 0.3048);
      cachedAltM = terrainM + aglM;
      diagLog(lastTerrainM, terrainM, aglM);
      return cachedAltM;
    }
    // Todavía no tocamos tierra esta sesión (ej: la app se abrió con el avión ya en vuelo):
    // sin referencia de calibración, volvemos al cálculo viejo (altitud MSL cruda como
    // altura sobre el elipsoide) — impreciso en tierra, inofensivo en crucero, y se
    // autocorrige en cuanto el avión toque tierra una vez.
    cachedAltM = Math.max(0, finiteNum(curAltFt, 0)) * 0.3048;
    diagLog(lastTerrainM, terrainM, 0);
    return cachedAltM;
  }

  // ---- Cámara de torre: tocar un punto del terreno y plantar ahí una cámara FIJA (como
  // un mástil de torre de control) que mira siempre al avión, panéandolo automáticamente
  // mientras vuela — no orbita, no sigue al avión en posición, solo lo mira. A lo sumo a
  // 5 km del avión (si tocás más lejos, se acerca al punto tocado pero sin pasar de esa
  // distancia): más lejos que eso ya no se vería nada útil.
  const TOWER_MAX_M = 5000;
  const TOWER_HEIGHT_M = 30;   // altura del "mástil" sobre el terreno, como una torre real
  let towerMode = false;
  let towerCenter = null;      // Cartesian3 de la posición FIJA de la cámara
  let pickMenuEl = null;
  function closePickMenu(){ if(pickMenuEl){ pickMenuEl.remove(); pickMenuEl = null; } }
  function showPickMenu(screenX, screenY, lat, lng){
    closePickMenu();
    const rect = viewer.scene.canvas.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'lp-menu glass';
    el.style.cssText = 'position:fixed;left:'+(rect.left+screenX)+'px;top:'+(rect.top+screenY)+'px;'
      +'transform:translate(-50%,-110%);z-index:20;';
    el.innerHTML = '<button class="lp-btn lp-cam">🗼 Cámara de torre aquí</button>'
      + '<button class="lp-btn lp-x">✕</button>';
    el.querySelector('.lp-cam').onclick = ()=>{ placeTower(lat, lng); closePickMenu(); };
    el.querySelector('.lp-x').onclick = closePickMenu;
    document.body.appendChild(el);
    pickMenuEl = el;
  }
  function placeTower(lat, lng){
    if(!cur) return;
    // Si tocaste más lejos de 5 km del avión, la torre se pone en esa MISMA dirección
    // pero a 5 km justos — nunca más lejos. haversineNM/bearingTo/dest ya existen en
    // geo-utils.js/flight-progress.js/plane-3d.js (mismo scope global, ver cabecera del
    // archivo): se reusan tal cual en vez de reescribir la misma trigonometría acá.
    const distM = haversineNM(cur.lat, cur.lng, lat, lng) * 1852;
    let tLat = lat, tLng = lng;
    if(distM > TOWER_MAX_M){
      const brg = bearingTo(cur.lat, cur.lng, lat, lng);
      const p = dest(cur.lat, cur.lng, brg, TOWER_MAX_M);   // [lng,lat]
      tLng = p[0]; tLat = p[1];
    }
    const groundM = terrainHeightAt(tLng, tLat);
    towerCenter = Cesium.Cartesian3.fromDegrees(tLng, tLat, groundM + TOWER_HEIGHT_M);
    towerMode = true;
  }

  function orbitOffset(){
    const ch = Math.cos(orbitPitch);
    return new Cesium.Cartesian3(
      -orbitRange * ch * Math.cos(orbitHeading),
       orbitRange * ch * Math.sin(orbitHeading),
       orbitRange * Math.sin(orbitPitch)
    );
  }

  function initViewer(){
    Cesium.Ion.defaultAccessToken = HAS_TOKEN ? ION_TOKEN : undefined;
    maxPitchRad = Cesium.Math.toRadians(85);

    viewer = new Cesium.Viewer('cesium-container', {
      imageryProvider: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
    });

    if(HAS_TOKEN){
      const terrain = Cesium.Terrain.fromWorldTerrain({ requestWaterMask: true, requestVertexNormals: true });
      terrain.errorEvent.addEventListener((e)=>console.error('Error cargando terreno de Cesium ion:', e));
      viewer.scene.setTerrain(terrain);
      Cesium.createWorldImageryAsync().then((provider)=>{
        viewer.imageryLayers.addImageryProvider(provider);
      }).catch((e)=>console.error('Error cargando imágenes de Cesium ion:', e));
      viewer.scene.globe.show = true;
      viewer.scene.globe.depthTestAgainstTerrain = true;
      // FALSO en vez de true: sin la cúpula de SkyAtmosphere (ver más abajo, apagada por el
      // crash de Safari) no hay nada que oculte las estrellas del skybox por defecto de
      // Cesium — el resultado era un cielo de noche fijo, sin importar la hora real del
      // vuelo, en CUALQUIER plataforma (no solo iPad, ahí simplemente se notó primero).
      // Con esto apagado y un backgroundColor celeste plano (ver abajo) el cielo lee como
      // de día siempre — no es la hora real del sim, pero es consistente y va bien con el
      // look low-poly (cielo de color sólido, sin degradado foto-realista).
      viewer.scene.skyBox.show = false;
      // FALSO en vez de true. Segunda vuelta de este mismo bug de Safari/iPadOS (MSL
      // compilation error, "thread float3 could not bind to lvalue"): la primera vez
      // (fog.enabled, ver abajo) arregló el shader del AVIÓN; el que quedaba era el shader
      // de esta CÚPULA del cielo — SkyAtmosphere tiene su PROPIA función
      // computeAtmosphereScattering (con un out param extra, "translucent", ver
      // SkyAtmosphereCommon.glsl en la fuente de Cesium) que pisa el mismo bug del
      // compilador Metal. Por eso tardaba "un segundo" en crashear: esa cúpula recién se
      // compila cuando entra en el frustum de cámara, no al arrancar. Todo lo que sea
      // "atmosphere scattering" real-time parece romper este Safari en particular — así
      // que se apaga acá también en vez de ir shader por shader.
      viewer.scene.skyAtmosphere.show = false;
      // Ver comentario de arriba: mismo bug, shader del AVIÓN (AtmospherePipelineStage se
      // inyecta en CUALQUIER modelo cuando "frameState.fog.enabled && fog.renderable" es
      // true — confirmado leyendo la fuente de Cesium). No es el globo, es el fog de la
      // escena colándose en el shader del GLB.
      viewer.scene.fog.enabled = false;
      // Subido de 3 a 16 (antes había quedado en 8, todavía no alcanzaba según lo
      // reportado): terreno e IMÁGENES bastante menos subdivididos — ambos comparten la
      // misma jerarquía de tiles por screen-space-error, así que este único número reduce
      // tanto los triángulos de terreno como cuántas imágenes satelitales hay que pedir y
      // decodificar en tiempo real. Es la palanca más grande de rendimiento de este
      // archivo: si el hilo principal se ahoga dibujando terreno, hasta el polling de
      // telemetría (setInterval de 250ms en geo-utils.js) y el loop de interpolación de
      // cur (planeFrame en telemetry.js, que alimenta ESTA MISMA posición) se atrasan —
      // eso es lo que se ve como "el avión se mueve a saltos".
      viewer.scene.globe.maximumScreenSpaceError = 16;
      viewer.scene.globe.tileCacheSize = 200;
      // Esto (ver más arriba) fue el intento anterior — no era la causa real del crash de
      // Safari, pero de todas formas es una mejora de estilo/rendimiento legítima (menos
      // efecto foto-realista en el horizonte), así que se queda.
      viewer.scene.globe.showGroundAtmosphere = false;
      // Celeste plano en vez del navy oscuro que usa el modo sin token: acá SÍ hay terreno
      // real de fondo, así que el "cielo" (lo que se ve por encima del horizonte, sin
      // skybox ni atmósfera) tiene que leer como de día, no como espacio/noche.
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#6ec3f4');
      // Con datos reales de Cesium ion hay que dejar visible su atribución (términos de
      // uso del plan gratuito) — a diferencia del modo sin token, acá NO se oculta.
    } else {
      // Sin token en data/cesium_ion_token.txt: mismo modo "globo invisible" verificado en
      // el prototipo (globe.show=true + translucency en 0, nunca globe.show=false — ver
      // design/cesium-preview.html para el porqué). Sin terreno/imágenes reales, así que
      // acá SÍ ocultamos la atribución (no hay datos reales de Cesium que atribuir).
      viewer.scene.globe.show = true;
      viewer.scene.globe.translucency.enabled = true;
      viewer.scene.globe.translucency.frontFaceAlpha = 0.0;
      viewer.scene.globe.translucency.backFaceAlpha = 0.0;
      viewer.scene.globe.depthTestAgainstTerrain = false;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b0e14');
      viewer.scene.skyBox.show = false;
      viewer.scene.skyAtmosphere.show = false;
      viewer.scene.fog.enabled = false;
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0b0e14');
      const creditEl = viewer.container.querySelector('.cesium-viewer-bottom');
      if(creditEl) creditEl.style.display = 'none';
    }
    // ---- Ajustes de rendimiento + look low-poly (pedido explícito: menos parecido a un
    // simulador foto-realista, más liviano) ----
    // MSAA y FXAA suavizan bordes — justo lo contrario de lo que queremos: un look low-poly
    // se ve MEJOR con bordes duros/con dientes de sierra (como un juego PS1/N64), y ambos
    // cuestan GPU por nada si los apagamos.
    viewer.scene.msaaSamples = 1;
    if(viewer.scene.postProcessStages && viewer.scene.postProcessStages.fxaa){
      viewer.scene.postProcessStages.fxaa.enabled = false;
    }
    // Renderizar a menos resolución real y escalar hacia arriba: ahorro de GPU notorio
    // (menos píxeles que sombrear) y refuerza el aspecto "chunky" que se busca. Bajado de
    // 0.82 a 0.6 — ver el diagnóstico real (fps~3-4 sostenido mientras se juega MSFS a la
    // vez): dos escenas 3D completas peleando por la misma GPU, así que hay que apretar
    // fuerte acá, no solo un ajuste cosmético.
    viewer.resolutionScale = 0.6;
    // Techo explícito de fps en vez de dejar que el widget intente clavar 60 y pierda esa
    // pelea contra MSFS la mayoría del tiempo (de ahí el fps~3-4 medido en el PC): a un
    // objetivo bajo y ESTABLE, Cesium deja de pedir tantos frames por segundo. Subido de
    // 20 a 30 — se prueba siempre desde un dispositivo aparte (iPad), donde este número
    // no compite con la GPU de MSFS para nada (vive enteramente en el navegador que
    // renderiza), así que no hay motivo para quedarse corto acá — 30 se ve bastante más
    // fluido que 20 y sigue siendo mucho más liviano que dejarlo sin techo.
    viewer.targetFrameRate = 30;

    // ---- Posición/orientación: datos reales en vivo (cur/curAltFt de telemetry.js) ----
    // (asignan a las variables declaradas afuera, no "const" locales — frameTick() más
    // abajo reusa este MISMO orientProp para la cámara, en vez de recalcular el banqueo
    // dos veces con el riesgo de que las dos cuentas se desincronicen.)
    posProp = new Cesium.CallbackProperty(()=>{
      if(!cur) return undefined;
      const altM = renderAltitudeM();
      return Cesium.Cartesian3.fromDegrees(cur.lng, cur.lat, altM);
    }, false);
    // Banqueo: ANTES esto se estimaba derivando la velocidad de giro del rumbo entre
    // muestras (primero por frame de render — bug, colapsaba a 0 seguido — después por
    // muestras reales de buf[] — mejoró pero seguía "destellando" en las curvas, según lo
    // reportado). Cambio de raíz: SimConnect expone el ángulo de banco REAL del avión
    // (PLANE_BANK_DEGREES, ver app.py) — el mismo tipo de dato que VERTICAL_SPEED, que ya
    // funcionó perfecto para el cabeceo de acá abajo. Nada de estimar ni derivar: se lee
    // directo de lastState.bank, mismo patrón que realVsFtMin().
    function realBankDeg(){
      return (lastState && typeof lastState.bank==='number') ? lastState.bank : 0;
    }
    // Cabeceo por subida/bajada: la velocidad vertical SÍ viene real en /api/state — es
    // "lastState.vs" (ft/min), la misma que ya usa flight-progress.js para la flechita de
    // ascenso/descenso. Nada de estimar acá tampoco, dato real del sim.
    function realVsFtMin(){
      return (lastState && typeof lastState.vs==='number') ? lastState.vs : 0;
    }
    let smoothBankDeg = 0, smoothClimbDeg = 0;
    orientProp = new Cesium.CallbackProperty(()=>{
      if(!cur) return undefined;
      const altM = renderAltitudeM();
      const position = Cesium.Cartesian3.fromDegrees(cur.lng, cur.lat, altM);
      // Suavizado leve nada más (no hay que "esperar" a que la tasa se calcule, ya viene
      // el ángulo real): solo para que no se vea con escalones si el dato llega con algo
      // de ruido muestra a muestra.
      //
      // SIGNO: la apuesta original (negar, igual que el cálculo viejo derivado del rumbo)
      // salió al revés — confirmado en vivo, banqueaba para el lado contrario. Con el dato
      // REAL de SimConnect el signo va derecho, sin negar.
      const targetBankDeg = Cesium.Math.clamp(realBankDeg(), -35, 35);
      smoothBankDeg += (targetBankDeg - smoothBankDeg) * 0.35;
      // 1000 ft/min ≈ 10° de cabeceo visual — no es la actitud real del avión (eso depende
      // de velocidad/configuración), es una aproximación visual (VERTICAL_SPEED no trae un
      // ángulo, solo la tasa, a diferencia del banqueo que ahora sí es el dato real).
      const targetClimbDeg = Cesium.Math.clamp((realVsFtMin()/1000) * 10, -20, 20);
      smoothClimbDeg += (targetClimbDeg - smoothClimbDeg) * 0.1;
      // OJO EJE: en este modelo (GLB corregido, ver design/cesium-preview.html y el
      // historial de "no vertical, horizontal xd") el banqueo tuvo que ir en el slot de
      // PITCH de HeadingPitchRoll para verse bien — no en el de roll, donde iría en un
      // modelo sin corregir. Seguiendo esa misma lógica, el cabeceo real (subir/bajar la
      // nariz) es la ÚNICA rotación que le queda libre: el slot de ROLL. Es la mejor
      // apuesta con la info que hay, pero no está probado en vivo — si sale girando al
      // costado en vez de con la nariz arriba/abajo, es el mismo tipo de eje cruzado que
      // pasó con el banqueo, avisen y se cambia de slot.
      const hpr = new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(cur.hdg),
        Cesium.Math.toRadians(smoothBankDeg),
        Cesium.Math.toRadians(smoothClimbDeg)
      );
      return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
    }, false);

    // ---- Shader "low poly": el modelo de Sketchfab es foto-realista (PBR, texturas de
    // detalle) — para que se vea más low-poly/estilizado (y más barato de renderizar) le
    // metemos un CustomShader que hace dos cosas:
    //  1. Normal "de cara" en vez de la normal suavizada del glTF: se recalcula por
    //     derivadas de pantalla (dFdx/dFdy) de la posición, así que cada triángulo queda
    //     con UN tono plano en vez de un degradado continuo entre vértices — es justo lo
    //     que hace ver "facetado"/low-poly a un modelo, sin tocar la geometría real.
    //  2. Sombreado tipo toon (3 bandas fijas) en vez de iluminación PBR completa —
    //     además de verse más estilizado, es MUCHO más barato: lightingModel UNLIT se
    //     salta todo el cálculo de metalness/roughness/IBL del pipeline PBR normal.
    const lowPolyShader = new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,
      fragmentShaderText:
        'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {\n' +
        '  vec3 posEC = fsInput.attributes.positionEC;\n' +
        '  vec3 flatNormal = normalize(cross(dFdx(posEC), dFdy(posEC)));\n' +
        '  vec3 lightDirEC = normalize(vec3(0.35, 0.55, 0.75));\n' +
        '  float ndl = clamp(dot(flatNormal, lightDirEC), 0.0, 1.0);\n' +
        '  float band = floor(ndl * 3.0 + 0.5) / 3.0;\n' +
        '  float shade = 0.5 + band * 0.5;\n' +
        '  material.diffuse *= shade;\n' +
        '}',
    });

    viewer.entities.add({
      name: 'avion',
      position: posProp,
      orientation: orientProp,
      model: { uri: GLB_URL, minimumPixelSize: 48, customShader: lowPolyShader },
    });

    // ---- Mouse: orbit + zoom manual (controlador nativo de Cesium apagado, ver
    // comentario en el prototipo sobre por qué mezclar los dos rompe el centrado) ----
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    let dragging = false;
    let downAt = 0, downMoved = false;
    handler.setInputAction((e)=>{
      dragging = true;
      downAt = performance.now();
      downMoved = false;
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction((e)=>{
      dragging = false;
      // Soltó rápido y sin arrastrar => fue un TAP, no un drag de cámara: probamos levantar
      // el punto del terreno tocado para ofrecer plantar ahí la cámara de torre.
      if(!downMoved && (performance.now() - downAt) < 450){
        const ray = viewer.camera.getPickRay(e.position);
        const picked = ray ? viewer.scene.globe.pick(ray, viewer.scene) : null;
        if(picked){
          const carto = Cesium.Cartographic.fromCartesian(picked);
          showPickMenu(e.position.x, e.position.y,
            Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude));
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
    handler.setInputAction((movement)=>{
      if(!dragging) return;
      const dx = movement.endPosition.x - movement.startPosition.x;
      const dy = movement.endPosition.y - movement.startPosition.y;
      if(Math.abs(dx)>4 || Math.abs(dy)>4) downMoved = true;
      targetHeading -= dx * 0.006;
      targetPitch = Cesium.Math.clamp(targetPitch + dy * 0.006, -maxPitchRad, maxPitchRad);
      closePickMenu();   // arrastrar la cámara descarta cualquier menú de un toque anterior
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((wheelDelta)=>{
      targetRange = Cesium.Math.clamp(targetRange * (1 - wheelDelta * 0.0005), 15, 3000);
    }, Cesium.ScreenSpaceEventType.WHEEL);
    // WHEEL nunca dispara en touch (iPad) — por eso no había forma de hacer zoom ahí, ni
    // para acercar ni para alejar. El equivalente táctil es PINCH_MOVE: movement.distance
    // trae la distancia entre los dos dedos, antes (startPosition.y) y ahora
    // (endPosition.y) — separarlos (distancia crece) tiene que achicar targetRange (zoom
    // in), juntarlos lo agranda (zoom out). Mismo clamp(15,3000) que el wheel — "pon
    // limitador" — así el pinch tampoco puede pedir un acercamiento/alejamiento extremo
    // que dispare de más el detalle de terreno a renderizar.
    handler.setInputAction((movement)=>{
      const pinchDelta = movement.distance.endPosition.y - movement.distance.startPosition.y;
      targetRange = Cesium.Math.clamp(targetRange * (1 - pinchDelta * 0.01), 15, 3000);
    }, Cesium.ScreenSpaceEventType.PINCH_MOVE);

    frameTick(); // arranca el loop propio de cámara
  }

  // Diagnóstico #2: si después de todos los ajustes sigue moviéndose "a saltos", lo que
  // hace falta es medir, no adivinar de nuevo. Esto mide dos cosas por separado cada
  // segundo, en la consola:
  //  - fps: cuántas veces por segundo REALMENTE corre este loop (si Cesium está ahogando
  //    el hilo principal, esto va a estar bien por debajo de 60 — confirma o descarta esa
  //    hipótesis con un número, no una sensación).
  //  - gaps: el tiempo entre cada cambio REAL de cur.lng (no cuadros de render, cambios de
  //    valor) — si vienen parejos (~ms similares entre sí) la interpolación está sana; si
  //    vienen en ráfagas (varios gaps chiquitos seguidos de uno grande) confirma que el
  //    polling/buffer se están vaciando y "poniéndose al día" de golpe.
  let fpsFrames = 0, fpsAt = performance.now();
  let curTickGaps = [], lastCurLng = null, lastCurChangeAt = 0;
  function frameTick(){
    if(!frameLoopRunning) return;
    const diagNowMs = performance.now();
    fpsFrames++;
    if(diagNowMs - fpsAt > 1000){
      console.log('[cesium3d] fps~'+fpsFrames, 'gaps(ms) entre cambios de posición:', curTickGaps.join(','));
      fpsFrames = 0; fpsAt = diagNowMs; curTickGaps = [];
    }
    if(cur){
      if(lastCurLng!==cur.lng){
        if(lastCurChangeAt) curTickGaps.push(Math.round(diagNowMs-lastCurChangeAt));
        lastCurChangeAt = diagNowMs;
        lastCurLng = cur.lng;
      }
    }
    if(towerMode && towerCenter && viewer && cur){
      // Cámara de torre: posición SIEMPRE fija en towerCenter, mirando al avión cada
      // frame. endTransform:IDENTITY es necesario — la cámara puede venir de la rama de
      // abajo (chase, que usa lookAtTransform con un marco custom) y sin resetear eso acá
      // setView interpretaría destination/direction/up mal, relativo a ese marco viejo.
      const now = Cesium.JulianDate.now();
      const planeCart = posProp.getValue(now);
      if(planeCart){
        const dir = Cesium.Cartesian3.subtract(planeCart, towerCenter, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(dir, dir);
        const up = Cesium.Cartesian3.normalize(towerCenter, new Cesium.Cartesian3());
        viewer.camera.setView({
          destination: towerCenter,
          orientation: { direction: dir, up: up },
          endTransform: Cesium.Matrix4.IDENTITY,
        });
      }
    } else if(cur && viewer){
      let dh = targetHeading - orbitHeading;
      dh = ((dh + Math.PI) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI) - Math.PI;
      orbitHeading += dh * 0.12;
      orbitPitch += (targetPitch - orbitPitch) * 0.12;
      orbitRange += (targetRange - orbitRange) * 0.12;

      // IMPORTANTE: la cámara usa su PROPIO quaternion, no el de orientProp (el del
      // modelo). orientProp mete el banqueo estimado en el slot de PITCH de
      // HeadingPitchRoll — es un hack de hace rato para que el modelo del avión se vea
      // bien (ver historial), pero eso significa que ese quaternion tiene el marco de
      // referencia INCLINADO según el banqueo del momento. Reusarlo acá para la cámara
      // hacía que orbitOffset() (que asume un eje "arriba" limpio para su matemática
      // esférica) orbitara sobre un marco que se bamboleaba cada vez que el banqueo
      // cambiaba — eso es lo que se sentía "absurdamente incómodo" y probablemente la
      // causa de los giros de 180°, sobre todo en curvas cerradas. La cámara ahora arma su
      // propio quaternion con SOLO el heading real (pitch=0, roll=0): un marco de
      // referencia estable, sin importar cuánto banquee el modelo.
      const now = Cesium.JulianDate.now();
      const cart = posProp.getValue(now);
      if(cart){
        const camHpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(cur.hdg), 0, 0);
        const camQuat = Cesium.Transforms.headingPitchRollQuaternion(cart, camHpr);
        const rot = Cesium.Matrix3.fromQuaternion(camQuat, new Cesium.Matrix3());
        const m4 = Cesium.Matrix4.fromRotationTranslation(rot, cart, new Cesium.Matrix4());
        viewer.camera.lookAtTransform(m4, orbitOffset());
      }
    }
    requestAnimationFrame(frameTick);
  }

  function setActive(on){
    active = on;
    // Filtro retro sobre TODA la interfaz (ver main.css, .retro3d-on) — no solo la escena
    // 3D, también los paneles/menús encima, tal cual se pidió. Se prende/apaga junto con
    // el resto del modo, no depende de si el Viewer ya terminó de cargar.
    document.body.classList.toggle('retro3d-on', on);
    const mapEl = document.getElementById('map');
    const containerEl = document.getElementById('cesium-container');
    const loadingEl = document.getElementById('cesium-loading');

    if(!on){
      if(containerEl) containerEl.style.display = 'none';
      if(loadingEl) loadingEl.style.display = 'none';
      if(mapEl) mapEl.style.display = '';
      frameLoopRunning = false;
      if(viewer) viewer.useDefaultRenderLoop = false;
      // Si quedó en cámara de torre, la próxima vez que se active Terreno 3D arranca de
      // nuevo siguiendo al avión, no plantada en un punto de la sesión anterior.
      towerMode = false;
      towerCenter = null;
      closePickMenu();
      return;
    }

    if(mapEl) mapEl.style.display = 'none';

    if(viewerReady){
      if(containerEl) containerEl.style.display = '';
      viewer.useDefaultRenderLoop = true;
      frameLoopRunning = true;
      requestAnimationFrame(frameTick);
      return;
    }

    if(loadingEl) loadingEl.style.display = 'flex';
    ensureViewer().then(()=>{
      if(!active) return; // el usuario desactivó el toggle mientras cargaba
      frameLoopRunning = true;
      if(loadingEl) loadingEl.style.display = 'none';
      if(containerEl) containerEl.style.display = '';
      requestAnimationFrame(frameTick);
    }).catch((e)=>{
      console.error('No se pudo inicializar el modo Terreno 3D:', e);
      if(loadingEl) loadingEl.style.display = 'none';
      if(mapEl) mapEl.style.display = '';
      active = false;
      // Destildamos el toggle visualmente: si quedó "on" pero no hay Cesium, confundiría.
      const tg = document.getElementById('tg-terrain3d');
      if(tg) tg.classList.remove('on');
    });
  }

  // adjustZoom/recenter: para que los botones +/- y "centrar" del panel (que por defecto
  // operan sobre el mapa 2D de MapLibre — ver plane-3d.js/geo-utils.js) tengan sentido
  // también en modo Terreno 3D en vez de mover un mapa invisible sin ningún efecto. Los
  // botones ya chequean si el modo 3D está activo (planeModelOn) y llaman a esto en vez
  // de la lógica del mapa 2D.
  function adjustZoom(delta){
    // Mismo paso/clamp que la rueda del mouse (ver Cesium.ScreenSpaceEventType.WHEEL más
    // arriba) — un delta de +1/-1 por click, no una rueda completa.
    targetRange = Cesium.Math.clamp(targetRange * (delta>0 ? 0.8 : 1.25), 15, 3000);
  }
  function recenter(){
    // Reset a la vista default: derecho detrás del avión, sin importar cuánto se haya
    // orbitado con el drag. orbitHeading/Pitch/Range lerpean solos hacia estos targets
    // (ver frameTick) así que el reset se anima suave, no salta de golpe.
    // También es la salida de la cámara de torre (ver placeTower): mismo botón "centrar"
    // de siempre, ahora vuelve a trabar la cámara al avión en vez de quedarse plantada.
    towerMode = false;
    towerCenter = null;
    closePickMenu();
    targetHeading = 0;
    targetPitch = Math.atan2(42, 110);
    targetRange = Math.hypot(110, 42);
  }

  window.cesium3D = { setActive, adjustZoom, recenter };
})();
