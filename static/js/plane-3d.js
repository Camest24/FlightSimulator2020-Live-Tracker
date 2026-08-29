/* plane-3d.js — Capa custom 3D: modelo del avion, estela con altitud real y anclaje al terreno.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Modelo 3D del avión (modo Terreno 3D) -----------------------------------------
// En vez de la cinta extruida (se veía como un muro y era difícil de leer), en 3D
// mostramos directamente el avión como modelo GLTF, ubicado a su altitud real (MSL) con
// un custom layer de MapLibre + three.js. En 2D seguimos usando el ícono de siempre.
// Si el heading/altitud llega corrupto (NaN, Infinity, un objeto raro) alguna vez desde el
// sim, esto evita que se cuele en las matrices de three.js: un solo NaN ahí arruina toda
// la matriz de transformación y el modelo se ve roto/"invertido". Mejor caer siempre a un
// valor por defecto sano.
function finiteNum(v,fallback){ return (typeof v==='number' && isFinite(v)) ? v : fallback; }
let curAltFt=0;              // última altitud conocida (pies), la alimenta updatePlane()
let curOnGround=false;       // ¿el sim reporta el avión en tierra ahora mismo? (cesium-3d.js
                              // lo usa para anclar la altura renderizada al terreno real)
let planeModelOn=false;      // ¿modo Terreno 3D activo? controla si este layer dibuja algo
const TRAIL_WIDTH_M=24;      // ancho total de la cinta de la estela 3D, en metros reales
// El modelo del avión se arma a mano con primitivas (ver buildPlaneModel), con el morro
// apuntando a +X en su propio espacio local — mismo eje que usaba el .glb que reemplaza,
// así que el offset de 90° para alinearlo con el rumbo sigue siendo el mismo.
const PLANE_YAW_OFFSET=Math.PI/2;
// Jet genérico simple (no un modelo real de ningún fabricante) armado con geometría de
// three.js: fuselaje (cilindro) + morro (cono) + alas en flecha + deriva vertical, todo en
// el mismo amarillo del ícono 2D. Se eligió esto en vez de cargar otro .glb externo porque
// (a) no depende de conseguir/licenciar un modelo real de avión comercial, (b) no pesa nada
// y no hay archivo que bajar, y (c) al no haber carga asíncrona no hay ventana en la que
// this.model pueda quedar null mientras el layer ya está renderizando (la condición de
// carrera que sí existía con GLTFLoader).
function buildPlaneModel(){
  // roughness/metalness bajos le dan un brillo direccional que rompe el look "plano" de un
  // color sólido sin textura — sin esto, con luz difusa nomás, se ve como un cartón amarillo.
  const mat=new THREE.MeshStandardMaterial({color:0xfbbf24,roughness:0.45,metalness:0.35});
  const darkMat=new THREE.MeshStandardMaterial({color:0x1a1204,roughness:0.3,metalness:0.4});
  const group=new THREE.Group();
  const FUS_LEN=3.6, FUS_R=0.42;   // fuselaje más ancho: antes se veía como un palito

  // Fuselaje: cilindro acostado (su eje largo por defecto es Y, lo giramos a X).
  const fuselage=new THREE.Mesh(new THREE.CylinderGeometry(FUS_R,FUS_R,FUS_LEN,18),mat);
  fuselage.rotation.z=-Math.PI/2;
  group.add(fuselage);

  // Morro: cono en la punta delantera (+X), mismo giro que el fuselaje para que la punta
  // (por defecto hacia +Y) quede apuntando hacia adelante.
  const nose=new THREE.Mesh(new THREE.ConeGeometry(FUS_R,1.0,18),mat);
  nose.rotation.z=-Math.PI/2;
  nose.position.x=FUS_LEN/2+0.5;
  group.add(nose);

  // Cabina: una cúpula oscura sobre el morro, de contraste — rompe el amarillo sólido y da
  // una referencia de "frente" reconocible incluso de lejos/de noche.
  const canopy=new THREE.Mesh(new THREE.SphereGeometry(FUS_R*0.62,12,10,0,Math.PI*2,0,Math.PI/2),darkMat);
  canopy.rotation.x=Math.PI/2;
  canopy.position.set(FUS_LEN/2-0.35,FUS_R*0.55,0);
  group.add(canopy);

  // Alas: dos cajas finas en flecha hacia atrás (~28°), a mitad de fuselaje.
  function wing(side){
    const span=2.6, chord=1.0, thick=0.08;
    const w=new THREE.Mesh(new THREE.BoxGeometry(chord,thick,span),mat);
    w.position.set(-0.15,0,side*(FUS_R+span/2-0.2));
    w.rotation.y=side*(28*Math.PI/180);
    return w;
  }
  group.add(wing(1));
  group.add(wing(-1));

  // Deriva: aleta vertical atrás (-X), parada sobre el fuselaje.
  const tailFin=new THREE.Mesh(new THREE.BoxGeometry(0.9,1.05,0.09),mat);
  tailFin.position.set(-FUS_LEN/2+0.35,FUS_R+0.4,0);
  tailFin.rotation.z=-12*Math.PI/180;   // un poco barrida hacia atrás, más "jet"
  group.add(tailFin);

  return group;
}
// Una sola capa custom con UN solo renderer/cámara compartidos entre el modelo del avión
// y la estela 3D (dos THREE.WebGLRenderer separados sobre el MISMO contexto GL del canvas
// del mapa competían por el estado interno de WebGL y colgaban la pestaña).
// Última matriz de proyección que MapLibre le pasó a la capa 3D en su render() (ver más
// abajo). La reusamos en planeFrame() para saber EXACTAMENTE dónde cae en pantalla el
// punto elevado del avión (a su altitud real), y así centrar la cámara en ESE punto en
// vez del punto del suelo. Puede ser de un frame atrás (un ~1/60s de atraso) — no importa,
// la posición/altitud cambian lento comparado con eso.
let lastRenderMatrix=null;
const planeModelLayer={
  id:'plane-3d-model', type:'custom', renderingMode:'3d',
  onAdd(mapRef,gl){
    this.map=mapRef;   // guardado para usarlo en render(gl,matrix), que NO recibe el mapa como parámetro
    this.camera=new THREE.Camera();
    this.modelScene=new THREE.Scene();
    const l1=new THREE.DirectionalLight(0xffffff,1.0); l1.position.set(0,-70,100).normalize(); this.modelScene.add(l1);
    const l2=new THREE.DirectionalLight(0xffffff,0.6); l2.position.set(0,70,-100).normalize(); this.modelScene.add(l2);
    this.modelScene.add(new THREE.AmbientLight(0xffffff,0.5));
    // Geometría armada al toque, sin carga asíncrona (ver buildPlaneModel): existe apenas
    // corre onAdd, no hace falta esperar ningún archivo ni cuidar una carrera con render().
    this.model=buildPlaneModel();
    this.modelScene.add(this.model);
    // Estela 3D: mismo trazo que 'flown' pero con cada punto a SU altitud real (MSL) en vez
    // de drapeada en el piso. Es una CINTA (malla triangulada), no una THREE.Line: el ancho
    // de línea de WebGL (gl.LINE_WIDTH) está limitado a ~1px en casi todos los drivers, así
    // que una Line se ve casi invisible. La cinta tiene ancho real en metros y se ve gruesa
    // a cualquier zoom. Va en una escena aparte porque usa la matriz de proyección BASE del
    // mapa (sin la traslación/escala/rotación propias del modelo del avión): sus vértices ya
    // están en coordenadas Mercator absolutas.
    this.trailScene=new THREE.Scene();
    this.trailGeometry=new THREE.BufferGeometry();
    this.trailMesh=new THREE.Mesh(this.trailGeometry,
      new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity:0.85,side:THREE.DoubleSide}));
    this.trailMesh.frustumCulled=false;
    this.trailScene.add(this.trailMesh);
    this.trailCount=0;
    this.renderer=new THREE.WebGLRenderer({canvas:mapRef.getCanvas(),context:gl,antialias:true});
    this.renderer.autoClear=false;
    this.renderer.setPixelRatio(1);   // trabajamos directo en píxeles físicos del canvas (ver render())
  },
  render(gl,matrix){
    if(!planeModelOn) return;
    lastRenderMatrix=matrix;
    // three.js nunca se entera solo de que el canvas de MapLibre cambió de tamaño (retina,
    // resize de ventana, o simplemente que al montar la capa el canvas todavía no tenía su
    // tamaño final). Si el viewport interno de three.js queda desincronizado del canvas real,
    // gl.viewport() termina apuntando a un rectángulo chico/viejo y TODO lo que MapLibre
    // dibuja después en el mismo frame (satélite, terreno) se recorta a ese rectángulo — se
    // ve como que el mapa entero se puso negro. Resincronizamos en cada frame; es barato si
    // no cambió nada (three.js hace el chequeo interno y no llama a gl.viewport de más).
    const canvas=this.map.getCanvas();
    this.renderer.setSize(canvas.width,canvas.height,false);
    const baseMatrix=new THREE.Matrix4().fromArray(matrix);
    this.renderer.resetState();
    if(this.trailCount>1){
      this.camera.projectionMatrix=baseMatrix;
      this.renderer.render(this.trailScene,this.camera);
    }
    if(this.model && cur){
      const altFt=finiteNum(curAltFt,0);
      const altM=Math.max(0,altFt*0.3048);
      // Anclado contra el DEM del mapa (ver terrainElevM): nunca por debajo del terreno que
      // se está pintando, así que en tierra queda pegado al piso en vez de flotando.
      const renderAltM=Math.max(terrainElevM(cur.lng,cur.lat),altM);
      const merc=maplibregl.MercatorCoordinate.fromLngLat([cur.lng,cur.lat],renderAltM);
      const scale=merc.meterInMercatorCoordinateUnits()*16;   // el modelo real es muy chico a esta escala; se agranda para que se vea (subido de 6 a 16: con la cámara de persecución tan cerca, 6 se veía diminuto)
      // Si el heading llega corrupto (NaN/Infinity) caemos a 0 en vez de dejar que arruine
      // toda la matriz de rotación (eso es lo que hacía ver el modelo roto/"invertido").
      const hdgRad=finiteNum(cur.hdg,0)*Math.PI/180;
      // El modelo viene con Y como "arriba" propio; Rx lo pone de pie en el espacio del mapa
      // (donde Z es arriba). El rumbo se aplica en Y ANTES de ese ajuste: ese es el eje que
      // realmente gira el morro del avión (yaw), ya que rota en el espacio original del modelo.
      const rx=new THREE.Matrix4().makeRotationX(Math.PI/2);
      const ry=new THREE.Matrix4().makeRotationY(hdgRad+PLANE_YAW_OFFSET);
      const l=new THREE.Matrix4()
        .makeTranslation(merc.x,merc.y,merc.z)
        .scale(new THREE.Vector3(scale,-scale,scale))
        .multiply(rx).multiply(ry);
      this.camera.projectionMatrix=new THREE.Matrix4().copy(baseMatrix).multiply(l);
      this.renderer.render(this.modelScene,this.camera);
    }
    // three.js deja el estado de WebGL como haya quedado tras SU último draw call (con
    // materiales transparentes eso suele ser depthMask(false) y blending prendido). MapLibre
    // asume, para sus propios draws de después en el MISMO frame (satélite, terreno), que el
    // estado está en su configuración normal — si no la restauramos acá, esos draws
    // posteriores dejan de escribir/leer profundidad como corresponde y el resto del mapa
    // deja de pintarse (pantalla negra) hasta el próximo repintado completo.
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // OJO: blending va ENCENDIDO, no apagado — el propio pintor de MapLibre dibuja relleno,
    // etiquetas y calles con blending alfa activo; deshabilitarlo acá (en vez de restaurar el
    // blend func normal) hacía que esos draws posteriores no compusieran nada = pantalla negra.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.colorMask(true,true,true,true);
    this.map.triggerRepaint();
  }
};
// Altura del terreno (metros) en un punto, según el mismo DEM que MapLibre usa para pintar
// la superficie. La usamos para anclar el modelo/estela a ESE terreno en vez de a la
// altitud MSL "pura": el dato de elevación real de MSFS y el DEM de terceros que usa el
// mapa casi nunca coinciden exacto (puede haber ~100m de diferencia en zonas montañosas
// como Medellín), así que ubicar el avión en su altitud MSL "de verdad" lo dejaba flotando
// sobre el piso aunque estuviera aterrizado. Anclando contra el MISMO DEM que dibuja el
// terreno, el avión queda pegado al piso al aterrizar sin importar el desfasaje absoluto.
function terrainElevM(lng,lat){
  try{ const e=map.queryTerrainElevation([lng,lat]); return (e==null||!isFinite(e))?0:e; }
  catch(err){ return 0; }
}
function setPlaneModelVisible(on){
  planeModelOn=on;
  if(meMarker) meMarker.getElement().style.display=on?'none':'';
  map.triggerRepaint();
}

// Recalcula la estela 3D a partir de los mismos puntos que ya arma updateRoute() para la
// línea plana (route[0..drawTo) + el punto interpolado 'cur'), cada uno con su propia
// altitud real en vez de la altitud actual constante.
function update3DTrail(route,drawTo){
  // Guarda por si el primer dato del sim llega antes de que la capa 3D termine de montarse
  // (onAdd, asíncrono): sin esto, esa carrera tira "Cannot read properties of undefined
  // (reading 'setAttribute')" en cada actualización de ruta hasta que la capa termina de armarse.
  if(!planeModelLayer.trailGeometry) return;
  const n=drawTo+(cur?1:0);
  if(n<2){ planeModelLayer.trailCount=0; return; }

  // Punto Mercator + altitud de cada vértice. IMPORTANTE: cada punto histórico usa SU
  // PROPIA altitud guardada en route[i][2] (la que tenía el avión en ese momento), NUNCA
  // la altitud actual — si no, al subir/bajar el avión el tramo viejo de la estela
  // "saltaría" con él, como si nunca hubiera estado a otra altura. Solo el último punto
  // (la posición interpolada 'cur') usa curAltFt, porque ES la posición actual.
  // Igual que en el modelo del avión (ver terrainElevM): anclado contra el DEM del mapa,
  // nunca por debajo del terreno, para que el tramo en tierra quede pegado al piso en vez
  // de flotar por el desfasaje entre la altitud MSL real y la del DEM de terceros.
  const pts=new Array(n);
  for(let i=0;i<drawTo;i++){
    const p=route[i], altFt=finiteNum(p[2],0), altM=Math.max(0,altFt*0.3048);
    const renderAltM=Math.max(terrainElevM(p[1],p[0]),altM);
    const merc=maplibregl.MercatorCoordinate.fromLngLat([p[1],p[0]],renderAltM);
    pts[i]={x:merc.x,y:merc.y,z:merc.z,altFt};
  }
  if(cur){
    const altFt=finiteNum(curAltFt,0), altM=Math.max(0,altFt*0.3048);
    const renderAltM=Math.max(terrainElevM(cur.lng,cur.lat),altM);
    const merc=maplibregl.MercatorCoordinate.fromLngLat([cur.lng,cur.lat],renderAltM);
    pts[drawTo]={x:merc.x,y:merc.y,z:merc.z,altFt};
  }

  // Cinta triangulada en vez de una THREE.Line: el ancho de línea de WebGL no se respeta en
  // casi ningún driver (queda en ~1px), así que en vez de una línea dibujamos un rectángulo
  // delgado (TRAIL_WIDTH_M de ancho real) que se extiende a los lados de la trayectoria,
  // perpendicular a la dirección de vuelo en cada punto — se ve como una cinta gruesa desde
  // cualquier zoom, sin depender de gl.LINE_WIDTH.
  const refLL=drawTo>0 ? [route[0][1],route[0][0]] : [cur.lng,cur.lat];
  const halfW=maplibregl.MercatorCoordinate.fromLngLat(refLL,0).meterInMercatorCoordinateUnits()*(TRAIL_WIDTH_M/2);

  const positions=new Float32Array(n*2*3), colors=new Float32Array(n*2*3);
  for(let i=0;i<n;i++){
    let dx,dy;
    if(n<2){ dx=1; dy=0; }
    else if(i===0){ dx=pts[1].x-pts[0].x; dy=pts[1].y-pts[0].y; }
    else if(i===n-1){ dx=pts[i].x-pts[i-1].x; dy=pts[i].y-pts[i-1].y; }
    else { dx=pts[i+1].x-pts[i-1].x; dy=pts[i+1].y-pts[i-1].y; }
    const len=Math.hypot(dx,dy)||1;
    const px=-dy/len*halfW, py=dx/len*halfW;   // perpendicular a la dirección de vuelo
    const c=altColorRGB(pts[i].altFt);
    const b=i*6;
    positions[b]=pts[i].x-px; positions[b+1]=pts[i].y-py; positions[b+2]=pts[i].z;
    positions[b+3]=pts[i].x+px; positions[b+4]=pts[i].y+py; positions[b+5]=pts[i].z;
    colors[b]=colors[b+3]=c[0]/255; colors[b+1]=colors[b+4]=c[1]/255; colors[b+2]=colors[b+5]=c[2]/255;
  }
  const indices=new Uint32Array((n-1)*6);
  for(let i=0;i<n-1;i++){
    const a=i*2,bI=i*2+1,c2=i*2+2,d=i*2+3,o=i*6;
    indices[o]=a; indices[o+1]=bI; indices[o+2]=c2;
    indices[o+3]=bI; indices[o+4]=d; indices[o+5]=c2;
  }
  planeModelLayer.trailGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  planeModelLayer.trailGeometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  planeModelLayer.trailGeometry.setIndex(new THREE.BufferAttribute(indices,1));
  planeModelLayer.trailGeometry.attributes.position.needsUpdate=true;
  planeModelLayer.trailGeometry.attributes.color.needsUpdate=true;
  planeModelLayer.trailGeometry.index.needsUpdate=true;
  planeModelLayer.trailGeometry.computeBoundingSphere();
  planeModelLayer.trailCount=n;
  map.triggerRepaint();
}

const labelIds=labelLayers.map(l=>l.id);
function setBase(name){ const v=(id,on)=>map.setLayoutProperty(id,'visibility',on?'visible':'none');
  v('sat',name==='satlabels'||name==='satellite'); v('street',name==='street'); v('dark',name==='dark');
  labelIds.forEach(id=>v(id,name==='satlabels')); }
document.querySelectorAll('.layer-opt').forEach(o=>o.addEventListener('click',()=>{
  document.querySelectorAll('.layer-opt').forEach(x=>x.classList.remove('sel')); o.classList.add('sel'); setBase(o.dataset.layer); }));
document.getElementById('btn-layers').addEventListener('click',()=>{ document.getElementById('layers').classList.toggle('hidden'); document.getElementById('btn-layers').classList.toggle('active'); });
// Los botones de zoom no deben soltar el seguimiento: si estás siguiendo al avión,
// hacemos el zoom centrado en él en vez de dejar que se corra de la pantalla.
//
// En modo Terreno 3D el mapa de MapLibre está oculto (display:none) — zoomear ahí no
// tiene ningún efecto visible, incómodo justo con el único botón de zoom que hay a mano.
// planeModelOn es la misma bandera que ya usa el resto del código para saber si el modo
// 3D está activo (se prende/apaga junto con window.cesium3D.setActive, ver
// flightplan.js) — si está prendida, redirigimos el click a la cámara de Cesium en vez
// del mapa 2D.
function zoomBoton(delta){
  if(planeModelOn && window.cesium3D){ window.cesium3D.adjustZoom(delta); return; }
  if(followMode && meMarker){ const g=meMarker.getLngLat(); map.easeTo({zoom:map.getZoom()+delta, center:centroSeguir(g.lng,g.lat), duration:280}); }
  else if(delta>0) map.zoomIn(); else map.zoomOut();
}
document.getElementById('zin').onclick=()=>zoomBoton(1);
document.getElementById('zout').onclick=()=>zoomBoton(-1);

// Brújula (abajo a la derecha): gira con el mapa y al tocarla vuelve al norte
document.getElementById('compass').onclick=()=>map.easeTo({bearing:0,duration:400});
function syncCompass(){
  const c=document.getElementById('compass-rose');
  if(c) c.style.transform='rotate('+(-map.getBearing())+'deg)';
}
map.on('rotate',syncCompass);
syncCompass();

// Vista 2D / 3D (inclinación del mapa). Animamos el pitch nosotros mismos, cuadro a
// cuadro con setPitch instantáneo, para que el recentrado del seguimiento no la cancele.
function tiltTo(target){
  const start=map.getPitch(), t0=performance.now(), dur=450;
  (function step(now){
    let k=Math.min(1,(now-t0)/dur);
    const e=1-Math.pow(1-k,3);            // easeOutCubic
    map.setPitch(start+(target-start)*e);
    if(k<1) requestAnimationFrame(step);
  })(performance.now());
}
document.getElementById('btn-3d').onclick=()=>{
  const to3d = map.getPitch() < 20;
  tiltTo(to3d?60:0);
  const b=document.getElementById('btn-3d');
  b.textContent = to3d?'3D':'2D';   // muestra el modo en el que quedás
  b.classList.toggle('active', to3d);
};


function dest(lat,lon,brg,d){const R=6378137,b=brg*Math.PI/180,dd=d/R,la1=lat*Math.PI/180,lo1=lon*Math.PI/180;
  const la2=Math.asin(Math.sin(la1)*Math.cos(dd)+Math.cos(la1)*Math.sin(dd)*Math.cos(b));
  const lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(dd)*Math.cos(la1),Math.cos(dd)-Math.sin(la1)*Math.sin(la2));
  return [lo2*180/Math.PI,la2*180/Math.PI];}
function runwayShape(clat,clon,hdg,len,wid){const f=dest(clat,clon,hdg,len/2),b=dest(clat,clon,hdg+180,len/2);
  return {poly:[dest(f[1],f[0],hdg+90,wid/2),dest(f[1],f[0],hdg-90,wid/2),dest(b[1],b[0],hdg-90,wid/2),dest(b[1],b[0],hdg+90,wid/2)],center:[f,b]};}

// Color continuo por altitud: interpola entre los tramos, así el trazo cambia de color
// suavemente (azul -> azul claro -> verde...) en vez de saltar de golpe.
// Escala de Flightradar24: blanco casi en tierra, después amarillo, verde, celeste,
// azul, violeta, y rojo en lo más alto. Los cortes vienen de sus umbrales en metros
// (100 m para el amarillo, 2500 m para el celeste) pasados a pies.
const ALT_STOPS=[
  [0,     [255,255,255]],   // blanco     · menos de 100 m
  [330,   [250,204,21]],    // amarillo
  [3300,  [74,222,128]],    // verde
  [8200,  [56,189,248]],    // celeste    · desde 2500 m
  [16000, [37,99,235]],     // azul
  [28000, [30,58,138]],     // azul oscuro · acá cae el crucero típico
  [40000, [124,58,237]],    // violeta
  [48000, [239,68,68]],     // rojo        · muy alto, casi nunca
];
function altColorRGB(ft){ ft=ft||0;
  if(ft<=ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for(let i=0;i<ALT_STOPS.length-1;i++){ const a=ALT_STOPS[i], b=ALT_STOPS[i+1];
    if(ft<=b[0]){ const k=(ft-a[0])/(b[0]-a[0]);
      return [Math.round(a[1][0]+(b[1][0]-a[1][0])*k),Math.round(a[1][1]+(b[1][1]-a[1][1])*k),Math.round(a[1][2]+(b[1][2]-a[1][2])*k)]; } }
  return ALT_STOPS[ALT_STOPS.length-1][1]; }
function altColor(ft){ return 'rgb('+altColorRGB(ft).join(',')+')'; }
function fmtDur(min){ if(min==null)return '00:00:00'; const s=Math.max(0,Math.round(min*60)); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0'); }
function fmtEnd(min){ if(min==null)return ''; const h=Math.floor(min/60),m=Math.round(min%60); return '~'+(h>0?h+'h ':'')+m+'m'; }
const nf=n=>n.toLocaleString('en-US');
