/* telemetry.js — Telemetria en vivo: odometro, poll(), buffer de interpolacion, y la camara que sigue
   al avion cada frame (planeFrame vive aca porque corren en el mismo bucle).

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Odómetro ----
// Cada cifra es una tira 0-9 que se desliza, como el altímetro de la cabina. Solo
// reconstruimos el HTML si cambia la FORMA del número (999 -> 1,000); si no, movemos
// las tiras y el navegador anima la transición solo.
const ODO_DIGITOS='<span class="od"><span class="od-r">'
  +[0,1,2,3,4,5,6,7,8,9].map(d=>'<span>'+d+'</span>').join('')+'</span></span>';
function odoForma(s){ return [...s].map(c=>/[0-9]/.test(c)?'#':c).join(''); }
function setOdo(id,valor){
  const el=document.getElementById(id); if(!el) return;
  const s=String(valor);
  if(!el.classList.contains('odo')) el.classList.add('odo');
  const forma=odoForma(s);
  if(el.dataset.forma!==forma){
    el.innerHTML=[...s].map(c=>/[0-9]/.test(c)?ODO_DIGITOS:'<span class="od-f">'+c+'</span>').join('');
    el.dataset.forma=forma;
    // Sin este reflow el navegador junta el "nacer" con el "moverse" y no se ve rodar
    void el.offsetHeight;
  }
  const tiras=el.querySelectorAll('.od-r'); let k=0;
  for(const c of s){
    if(!/[0-9]/.test(c)) continue;
    const t=tiras[k++]; if(t) t.style.transform='translateY(-'+c+'em)';
  }
}
// Escribe una de las dos líneas chicas bajo el dato grande (altitud / velocidad)
function setSub(id,v,cls){ const e=document.getElementById(id); if(!e) return; e.textContent=v; e.className='hero-sub'+(cls?' '+cls:''); }

function updatePanel(s){
  // Altitud: el número grande en pies; abajo la vertical (color según suba o baje) y los metros
  if(s.alt!=null) setOdo('v-alt',nf(Math.round(s.alt)));
  if(s.vs!=null){
    const up=s.vs>=0, flecha=Math.abs(s.vs)<50?'→':(up?'↑':'↓');
    const m=(s.alt!=null)?('  ·  '+nf(Math.round(s.alt*0.3048))+' m'):'';
    setSub('v-vs',flecha+' '+nf(Math.abs(Math.round(s.vs)))+' ft/min'+m, Math.abs(s.vs)<50?'':(up?'green':'orange'));
  }
  // Velocidad: nudos grande; abajo mach (si tiene sentido) y km/h
  if(s.gs!=null){ lastGs=s.gs;
    setOdo('v-gs',Math.round(s.gs));
    // El mach va siempre, aunque el número sea chico: si no, en tierra desaparecía la línea
    const m=(s.mach!=null) ? ('M '+s.mach.toFixed(2)+'  ·  ') : '';
    setSub('s-gs',m+Math.round(s.gs*1.852)+' km/h'); }
  // El rumbo también en magnético, para que coincida con la brújula de la cabina
  if(s.heading!=null) setOdo('v-hdg',String(Math.round(toMag(s.heading))).padStart(3,'0')+'°');
  pintarRosa();                  // el avión de la rosa queda fijo; gira la flecha al destino
  if(s.sim_rate!=null){ const r=s.sim_rate, e=document.getElementById('v-simrate');
    if(e){ setOdo('v-simrate',(r%1===0?r:r.toFixed(2))+'×'); e.classList.toggle('orange',r>1); } }
  { const d=s.distance_nm||0;
    setOdo('v-dist',d.toFixed(1));
    txt('s-dist',nf(km(d))+' km'); }
  setOdo('v-time',fmtDur(s.elapsed_min||0));
  pintarDespegue(s);
  if(s.fuel_gal!=null){
    setOdo('v-fuel',nf(Math.round(s.fuel_gal))+' gal');
    txt('s-fuel',nf(Math.round(s.fuel_gal*3.78541))+' L');
    txt('s-endur',s.endurance_min!=null?fmtEnd(s.endurance_min)+' restantes':'');
    const bar=document.getElementById('fuel-bar'), fill=document.getElementById('fuel-fill');
    if(s.fuel_capacity){ const pct=Math.max(0,Math.min(100,s.fuel_gal/s.fuel_capacity*100)); bar.style.display='block'; fill.style.width=pct+'%'; fill.style.background=pct<15?'#ef4444':pct<30?'#fb923c':'#4ade80'; }
    else bar.style.display='none'; }
  // El botón de luces se prende solo si hay alguna encendida
  if(s.lights){ const L=s.lights, b=document.getElementById('btn-status');
    if(b) b.classList.toggle('on',!!(L.landing||L.taxi||L.beacon||L.strobe||L.nav)); }
}

// Banda de altitud: agrupamos en escalones para poder unir puntos consecutivos del mismo
// color en UNA sola línea.
function altBanda(ft){ return Math.round(Math.max(0,ft||0)/1500); }

function updateRoute(route){
  const fc={type:'FeatureCollection',features:[]};
  const n=route.length;
  // El avión va ~1.2s atrás del último dato real (buffer): no dibujamos los 2 puntos más
  // nuevos (van "adelante" del avión) y cerramos el trazo en 'cur', así van pegados.
  const drawTo=(n>2 && cur)?n-2:n;

  // Antes se creaba UNA línea por cada par de puntos: en un vuelo largo eran miles de
  // trocitos sueltos, y al alejar el zoom el mapa los recortaba y el rastro aparecía
  // partido. Ahora unimos los puntos seguidos que comparten banda de altitud en una sola
  // línea continua, así pasamos de miles de piezas a unas pocas decenas.
  let ini=0;
  for(let i=1;i<drawTo;i++){
    const fin = (i===drawTo-1) || (altBanda(route[i][2])!==altBanda(route[i+1] ? route[i+1][2] : route[i][2]));
    if(!fin) continue;
    const coords=[];
    for(let j=ini;j<=i;j++) coords.push([route[j][1],route[j][0]]);
    if(coords.length>1)
      fc.features.push({type:'Feature',properties:{color:altColor(route[i][2]||0)},
                        geometry:{type:'LineString',coordinates:coords}});
    ini=i;                     // el tramo siguiente arranca donde terminó este: sin huecos
  }
  if(drawTo>=1 && cur){ const last=route[drawTo-1];
    fc.features.push({type:'Feature',properties:{color:altColor(last[2]||0)},
                      geometry:{type:'LineString',coordinates:[[last[1],last[0]],[cur.lng,cur.lat]]}}); }
  const src=map.getSource('flown'); if(src) src.setData(fc);
}

// Interpolación con buffer de retardo (~1.2s): reproducimos el avión caminando sobre la
// ruta REAL entre los últimos puntos conocidos. Movimiento SIEMPRE hacia adelante, fluido
// y sin retrocesos (rubber-banding). Único costo: ~1.2s de atraso, imperceptible.
const buf=[];            // {lng,lat,hdg,t}
const DELAY=700;         // colchón: ~7 muestras a 10 Hz. Absorbe el jitter del wifi sin colgarse
// Cuánto puede pasar entre dos muestras del buffer antes de asumir que no es jitter de red
// sino que el tab estuvo oculto/tapado (Chrome PAUSA por completo requestAnimationFrame en
// tabs no visibles u ocluidos — algo normal acá: esta app suele vivir en una pestaña/monitor
// aparte mientras MSFS tiene el foco). planeFrame() vive de rAF, así que mientras el tab está
// oculto 'cur' (el rumbo que pintan TANTO el ícono 2D como el modelo 3D) queda congelado, pero
// poll() sigue via setInterval y el buffer sigue creciendo con rumbos reales y frescos. Al
// volver a primer plano, si no cortamos acá, planeFrame podría interpolar entre esa muestra
// vieja (de antes de ocultarse) y la nueva (de recién) como si el vuelo hubiera girado
// derechito de una al otro — un barrido por un rumbo intermedio que el avión nunca tuvo. Eso
// es justo el bug: errático, sin offset fijo, y tanto peor cuanto más cambió el rumbo real
// mientras el tab estuvo oculto.
const GAP_MS=2000;
let cur=null;            // posición renderizada (para seguir la cámara y para el trazo)
let lastUi=0;            // separa el dibujado pesado (~1 Hz) de la lectura de posición (~10 Hz)
function lerpAngle(a,b,t){ const d=((b-a+540)%360)-180; return a+d*t; }

function updatePlane(s){
  if(s.lat==null||s.lon==null) return;
  // finiteNum en vez de "||0": un heading que llegue NaN o Infinity (dato corrupto del
  // sim) no debe colarse en la rotación del ícono.
  const hdg=finiteNum(s.heading,0);
  const now=performance.now();
  // Ver comentario de GAP_MS: si pasó demasiado desde la última muestra, el tab estuvo
  // oculto y 'cur' quedó congelado. Vaciamos el buffer viejo así el próximo planeFrame()
  // arranca directo en la muestra fresca (buf con un solo punto = sin interpolación posible),
  // en vez de barrer desde la posición congelada hasta acá.
  if(buf.length && now-buf[buf.length-1].t>GAP_MS) buf.length=0;
  buf.push({lng:s.lon,lat:s.lat,hdg,t:now});
  if(buf.length>14) buf.shift();
  if(!meMarker){ const el=document.createElement('div'); el.className='plane-me'; el.innerHTML=mePlaneSVG();
    // rotationAlignment/pitchAlignment 'map' => el ícono se apoya en el plano del mapa y
    // apunta al rumbo real tanto en 2D como en 3D (arregla el desvío visual al inclinar).
    meMarker=new mapboxgl.Marker({element:el,anchor:'center',rotationAlignment:'map',pitchAlignment:'map'})
      .setLngLat([s.lon,s.lat]).setRotation(hdg).addTo(map);
    cur={lng:s.lon,lat:s.lat,hdg};
    map.jumpTo({center:[s.lon,s.lat],zoom:14}); }  // primer contacto: encuadra la pista
}

let lastCenterAt=0;
// Cada cuánto llamamos a map.setCenter()/setBearing() como máximo, en ms. El ícono se
// sigue actualizando cada frame (barato: mover un marcador), pero mover la CÁMARA del
// mapa 60 veces por segundo — sobre todo con el viejo Terreno 3D, que además recalculaba
// relieve y una capa custom de three.js en cada repintado — resultó ser demasiado
// trabajo seguido: en una prueba real esto llegó a colgar la pestaña entera. La posición
// real tampoco cambia más rápido que el propio telemetry_loop (10 lecturas/seg), así que no
// hace falta re-centrar más seguido que eso para que se vea igual de fluido.
const CENTER_MIN_MS=120;
function planeFrame(now){
  if(meMarker && buf.length){
    const rt=now-DELAY;                       // tiempo de reproducción (atrasado)
    let p;
    if(rt<=buf[0].t){ p=buf[0]; }
    else if(rt>=buf[buf.length-1].t){ p=buf[buf.length-1]; }   // buffer seco: mantener, no retroceder
    else {
      let i=0; while(i<buf.length-1 && buf[i+1].t<rt) i++;
      const a=buf[i], b=buf[i+1], k=(rt-a.t)/Math.max(1,(b.t-a.t));
      p={lng:a.lng+(b.lng-a.lng)*k, lat:a.lat+(b.lat-a.lat)*k, hdg:lerpAngle(a.hdg,b.hdg,k)};
    }
    cur={lng:p.lng,lat:p.lat,hdg:p.hdg};
    meMarker.setLngLat([cur.lng,cur.lat]);
    meMarker.setRotation(cur.hdg);
    if(towerMode2D && towerPoint2D && now-lastCenterAt>=CENTER_MIN_MS && !map.isZooming() && !map.isRotating()){
      // Cámara de torre 2D: el CENTRO nunca se mueve de towerPoint2D (es fijo, como el
      // mástil de una torre real) — lo único que cambia frame a frame es el BEARING, para
      // que la torre siga "mirando" hacia donde está el avión ahora mismo. bearingTo ya
      // existe en flight-progress.js (mismo scope global de siempre).
      lastCenterAt=now;
      map.setCenter(towerPoint2D);
      map.setBearing(bearingTo(towerPoint2D[1], towerPoint2D[0], cur.lat, cur.lng));
    } else if(followMode && now-lastCenterAt>=CENTER_MIN_MS && !map.isZooming() && !map.isRotating()){
      lastCenterAt=now;
      map.setCenter(centroSeguir(cur.lng,cur.lat));
    }
  }
  requestAnimationFrame(planeFrame);
}
requestAnimationFrame(planeFrame);

// ---- Corrimiento del avión al seguirlo ----
// El dock de abajo tapa una franja (más alta con ruta, y más todavía con el estante o el
// gráfico abiertos). Para que el avión quede en el medio de lo que SÍ se ve del mapa, entre
// la barra de arriba y el dock, el centro del mapa se corre hacia abajo:
// centro = proyectar(avión) − corrimiento. Antes el corrimiento era horizontal (120 px a la
// derecha) porque el panel de datos tapaba la franja izquierda.
function offsetActual(){
  const pila=document.getElementById('dock-pila');
  const alto=map.getContainer().clientHeight;
  if(!pila || !alto) return 0;
  const abajo=pila.getBoundingClientRect().top;
  // La barra solo cuenta si está arriba en su lugar (vertical o movida no tapa el centro)
  const barra=document.getElementById('toolbar');
  const arriba=(barra && barra.dataset.orient!=='v' && !barra.classList.contains('movido'))
    ? barra.getBoundingClientRect().bottom : 0;
  if(!(abajo>arriba+80)) return 0;
  return Math.round((arriba+abajo)/2 - alto/2);      // negativo: el avión sube
}
// Centro de cámara para el seguimiento: el punto en el suelo, corrido `dy` píxeles para
// no quedar tapado por el dock.
function centroSeguir(lng,lat){
  const dy=offsetActual();
  if(Math.abs(dy)<2) return [lng,lat];
  const base=map.project([lng,lat]);
  const c=map.unproject([base.x, base.y-dy]);
  return [c.lng,c.lat];
}
function recentrar(){
  if(followMode && cur) map.easeTo({center:centroSeguir(cur.lng,cur.lat),duration:250});
}
// La llama el dock cuando cambia de alto (tools-ui.js). Es una función
// declarada (se puede llamar desde arriba del archivo) y va con try por si alguna vez
// se invoca antes de que este bloque termine de ejecutarse.
function revisarCentrado(){
  try{ recentrar(); }catch(e){}
}


function circlePoly(lng,lat,radiusNM){ const rad=radiusNM*1852, pts=[]; for(let i=0;i<=64;i++){ pts.push(dest(lat,lng,i/64*360,rad)); } return {type:'Feature',geometry:{type:'Polygon',coordinates:[pts]}}; }
// Centros donde mostramos aeropuertos/VOR: el avión y, si hay ruta, el aeropuerto de llegada
function navCenters(center){
  const out=[];
  if(center) out.push(center);
  if(routeTarget && routeTarget.icao!=='PUNTO') out.push({lng:routeTarget.lon, lat:routeTarget.lat});
  return out;
}
// Fuera del radio, lo que hay en pantalla aparece por zoom: se empieza a insinuar en
// ZOOM_FADE_LO y termina de aparecer en ZOOM_FADE_HI. Al alejarte hace el camino inverso,
// así que se desvanece en vez de desaparecer de golpe.
const ZOOM_FADE_LO=8.6, ZOOM_FADE_HI=10.2;
function zoomedIn(){ return map.getZoom()>=ZOOM_FADE_LO; }
function viewFadeAlpha(){
  return Math.max(0, Math.min(1, (map.getZoom()-ZOOM_FADE_LO)/(ZOOM_FADE_HI-ZOOM_FADE_LO)));
}
// Solo se atenúa lo que aparece por zoom. Lo que está dentro de un radio se ve siempre.
function applyViewFade(){
  const a=viewFadeAlpha();
  document.querySelectorAll('.apt-pin[data-view="1"], .vor-mk[data-view="1"]').forEach(el=>{
    el.style.opacity=a;
    el.style.pointerEvents = a<0.2 ? 'none' : '';
  });
}
map.on('zoom',applyViewFade);
function inView(lat,lon){
  if(!zoomedIn()) return false;
  const b=map.getBounds();
  return lat>=b.getSouth() && lat<=b.getNorth() && lon>=b.getWest() && lon<=b.getEast();
}
function visibleHere(centers,lat,lon){ return nearAnyCenter(centers,lat,lon) || inView(lat,lon); }
function nearAnyCenter(centers,lat,lon){
  return centers.some(c=>haversineNM(c.lat,c.lng,lat,lon)<=aptRadius);
}
// Cuando el destino queda cerca, los dos radios se pisan y se veían los arcos cruzándose
// por dentro, como un diagrama de Venn. Dibujamos solo el CONTORNO de la unión: de cada
// círculo nos quedamos con los tramos que no caen dentro de ningún otro.
function circleUnionLines(centers, radiusNM){
  const N=128, feats=[];
  centers.forEach((c,ci)=>{
    const pts=[], fuera=[];
    for(let i=0;i<N;i++){
      const p=dest(c.lat,c.lng,i/N*360,radiusNM*1852);   // [lng,lat]
      pts.push(p);
      // margen de 0.05 NM para que los dos círculos no dejen un huequito en el cruce
      fuera.push(!centers.some((o,oi)=>oi!==ci && haversineNM(o.lat,o.lng,p[1],p[0])<radiusNM-0.05));
    }
    if(fuera.every(v=>!v)) return;                       // tapado del todo por otro
    if(fuera.every(v=>v)){                               // suelto: anillo completo
      feats.push({type:'Feature',geometry:{type:'LineString',coordinates:pts.concat([pts[0]])}});
      return;
    }
    // Arrancamos justo después de un corte, así el recorrido no parte un tramo al medio
    let ini=0; while(fuera[ini] || !fuera[(ini+1)%N]) ini=(ini+1)%N;
    let tramo=[];
    for(let k=1;k<=N;k++){
      const i=(ini+k)%N;
      if(fuera[i]) tramo.push(pts[i]);
      else if(tramo.length){
        if(tramo.length>1) feats.push({type:'Feature',geometry:{type:'LineString',coordinates:tramo}});
        tramo=[];
      }
    }
    if(tramo.length>1) feats.push({type:'Feature',geometry:{type:'LineString',coordinates:tramo}});
  });
  return feats;
}
function updateCircle(center){ const src=map.getSource('aptcircle'); if(!src) return;
  const cs=(flags.apt||flags.vor)?navCenters(center):[];
  src.setData({type:'FeatureCollection',features:circleUnionLines(cs,aptRadius)}); }

function renderVors(center){
  vorMarkers.forEach(m=>m.remove()); vorMarkers=[];
  if(!flags.vor) return;
  const centers=navCenters(center);
  if(!centers.length && !zoomedIn()) return;
  allVors().forEach(v=>{ if(!visibleHere(centers,v.lat,v.lon)) return;
    const el=document.createElement('div'); el.className='vor-mk';
    if(!nearAnyCenter(centers,v.lat,v.lon)){ el.dataset.view='1'; el.style.opacity=viewFadeAlpha(); }
    el.innerHTML='<svg width="26" height="26" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10.5" fill="rgba(34,211,238,0.12)" stroke="#22d3ee" stroke-width="1.6"/><g stroke="#22d3ee" stroke-width="1.6" stroke-linecap="round"><path d="M16 3v3.5M16 25.5v3.5M3 16h3.5M25.5 16h3.5"/></g><circle cx="16" cy="16" r="2.3" fill="#22d3ee"/></svg>';
    vorMarkers.push(new mapboxgl.Marker({element:el,anchor:'center'}).setLngLat([v.lon,v.lat])
      .setPopup(popup('<b>'+v.id+'</b> · '+v.name+'<br><span class="pp-sub">VOR · '+v.freq+' MHz</span>'
        +'<div class="pp-actions"><button class="pp-btn-wp" onclick="addNamedWp('+v.lat+','+v.lon+",'"+v.id+"')\">＋ A la ruta</button></div>")).addTo(map)); });
}
function renderNav(center){ renderAirports(center); renderVors(center); updateCircle(center);
  applyViewFade();                       // los recién creados ya nacen con su opacidad
  if(center) lastAptCenter=center; }

function aptPinHTML(){ return '<svg width="20" height="25" viewBox="0 0 24 30"><path d="M12 0C6.5 0 2 4.4 2 9.9 2 17 12 30 12 30S22 17 22 9.9C22 4.4 17.5 0 12 0z" fill="#2f6df6" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="10" r="4" fill="#fff"/></svg>'; }
function aptPopupHTML(a){
  const rwtxt=(a.runways&&a.runways[0])?(' · Pista '+a.runways[0].name+' · '+a.runways[0].len_m+' m'):'';
  let dist='';
  if(cur){ const nm=haversineNM(cur.lat,cur.lng,a.lat,a.lon); dist=' · '+fmtDist(nm); }
  const d=0.02;   // foto aérea del aeropuerto (satélite Esri, sin API key)
  const img='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox='+(a.lon-d)+','+(a.lat-d*0.62)+','+(a.lon+d)+','+(a.lat+d*0.62)+'&bboxSR=4326&size=300,186&format=jpg&f=image';
  return '<img class="apt-photo" src="'+img+'" onerror="this.style.display=\'none\'" alt="">'
    +'<b>'+a.icao+'</b> · '+a.name+'<br><span class="pp-sub">Elev '+(a.elev_ft||'?')+' ft'+rwtxt+dist+'</span><div class="pp-actions"></div>';
}
function rebuildAptActions(a){   // rellena los botones al abrir el popup (evita estados pegados)
  const box=document.querySelector('.mapboxgl-popup-content .pp-actions'); if(!box) return;
  // Solo cuenta como "ruta activa" si ya tiene pista elegida. Un destino que llegó solo
  // (plan de MSFS detectado automáticamente) queda con pista:null, centrado en la torre;
  // si contara como activo acá, el botón pasaría a "Quitar ruta" y ya no se podría abrir
  // el menú de pistas para corregirlo — quedaría pegado en el centro del aeropuerto.
  const act=routeTarget&&routeTarget.icao===a.icao&&routeTarget.pista;
  box.innerHTML='<button class="pp-btn-route'+(act?' pp-btn-remove':'')+'" onclick="planRoute(this,'+a.lat+','+a.lon+",'"+a.icao+"')\">"+(act?'Quitar ruta':'Ruta directa')+"</button>"
    +"<button class=\"pp-btn-gen\" onclick=\"genRoute(this,"+a.lat+","+a.lon+",'"+a.icao+"')\">Generar ruta</button>"
    +"<button class=\"pp-btn-wp\" onclick=\"addNamedWp("+a.lat+","+a.lon+",'"+a.icao+"')\">＋ A la ruta</button>"
    +"<button class=\"pp-btn-tp\" onclick=\"tpMenu(this,'"+a.icao+"')\">Teletransportarme</button>";
}
function aptMarker(a,byView){
  const el=document.createElement('div'); el.className='apt-pin'; el.innerHTML=aptPinHTML();
  // La opacidad se fija AL CREARLO. Si se dejaba para después, el marcador nacía opaco
  // y recién en el siguiente cuadro se atenuaba: eso era el parpadeo.
  if(byView){ el.dataset.view='1'; el.style.opacity=viewFadeAlpha(); }
  const m=new mapboxgl.Marker({element:el,anchor:'bottom'}).setLngLat([a.lon,a.lat]).setPopup(popup(aptPopupHTML(a))).addTo(map);
  m.getPopup().on('open',()=>rebuildAptActions(a));
  return m;
}
function renderAirports(center){
  aptMarkers.forEach(m=>m.remove()); aptMarkers=[];
  const rwFill={type:'FeatureCollection',features:[]}, rwCenter={type:'FeatureCollection',features:[]};
  const centers=navCenters(center);
  if(flags.apt && (centers.length || zoomedIn())){
    allAirports().forEach(a=>{
      if(!visibleHere(centers,a.lat,a.lon)) return;
      if(aptMarkers.length>=120) return;              // tope para no ahogar el navegador
      (a.runways||[]).forEach(r=>{ if(!r.len_m) return; const rw=runwayShape(r.center[0],r.center[1],r.hdg,r.len_m,r.wid_m||45);
        rwFill.features.push({type:'Feature',geometry:{type:'Polygon',coordinates:[[...rw.poly,rw.poly[0]]]}});
        rwCenter.features.push({type:'Feature',geometry:{type:'LineString',coordinates:rw.center}}); });
      aptMarkers.push(aptMarker(a, !nearAnyCenter(centers,a.lat,a.lon)));
    });
  }
  if(map.getSource('rw-fill')) map.getSource('rw-fill').setData(rwFill);
  if(map.getSource('rw-center')) map.getSource('rw-center').setData(rwCenter);
  const vis=flags.apt?'visible':'none';
  if(map.getLayer('rw-fill')){ map.setLayoutProperty('rw-fill','visibility',vis); map.setLayoutProperty('rw-center','visibility',vis); }
}

function rebuildNav(data){ navAirports=data.airports||[]; navVors=data.vors||[]; renderNav(cur||(navRef?{lng:navRef[1],lat:navRef[0]}:null)); }
function maybeFetchNav(lat,lon){
  if(navRef){ const d=Math.hypot(lat-navRef[0],lon-navRef[1]); if(d<0.3) return; }
  navRef=[lat,lon];
  fetch('/api/navdata?lat='+lat+'&lon='+lon+'&radius=250').then(r=>r.json()).then(d=>{ if(d.ready) rebuildNav(d); }).catch(()=>{});
}

// Datos de navegación alrededor del aeropuerto de llegada (se piden una sola vez por destino)
let destAirports=[], destVors=[], destNavKey=null;
// Datos de la zona que estás mirando, para cuando te vas lejos del avión y hacés zoom
let viewAirports=[], viewVors=[], viewNavKey=null;
function allAirports(){ const m=new Map();
  navAirports.forEach(a=>m.set(a.icao,a)); destAirports.forEach(a=>m.set(a.icao,a));
  viewAirports.forEach(a=>m.set(a.icao,a)); return [...m.values()]; }
function allVors(){ const m=new Map();
  navVors.forEach(v=>m.set(v.id+v.lat,v)); destVors.forEach(v=>m.set(v.id+v.lat,v));
  viewVors.forEach(v=>m.set(v.id+v.lat,v)); return [...m.values()]; }

// Al alejarse del avión y hacer zoom, pedimos los datos de esa zona. Solo cuando NO
// estás siguiendo al avión: si lo seguís, los 250 NM que ya se descargan alcanzan.
function maybeFetchViewNav(){
  if(!zoomedIn() || followMode){
    if(viewNavKey){ viewNavKey=null; viewAirports=[]; viewVors=[]; renderNav(aptCenter()); }
    return;
  }
  const c=map.getCenter(), key=c.lat.toFixed(1)+','+c.lng.toFixed(1);
  if(viewNavKey===key) return;
  viewNavKey=key;
  const b=map.getBounds();
  const r=Math.min(250, Math.max(60, haversineNM(c.lat,c.lng,b.getNorth(),b.getEast())+20));
  fetch('/api/navdata?lat='+c.lat+'&lon='+c.lng+'&radius='+Math.round(r))
    .then(x=>x.json()).then(d=>{ if(!d.ready) return;
      viewAirports=d.airports||[]; viewVors=d.vors||[]; renderNav(aptCenter()); })
    .catch(()=>{});
}
// Redibujar al terminar de mover o hacer zoom: lo visible depende de dónde estás mirando
let viewRenderTimer=null, lastViewKey=null;
function onViewChanged(){
  maybeFetchViewNav();
  // Redibujar destruye y recrea todos los marcadores. Al hacer zoom eso pasaba en cada
  // gesto y producía el parpadeo, aunque los aeropuertos visibles fueran los mismos.
  // Ahora solo redibujamos si de verdad cambió lo que hay que mostrar.
  const c=map.getCenter();
  const key=c.lat.toFixed(2)+','+c.lng.toFixed(2)+','+(zoomedIn()?1:0);
  if(key===lastViewKey) return;
  lastViewKey=key;
  clearTimeout(viewRenderTimer);
  viewRenderTimer=setTimeout(()=>{ if(!followMode || zoomedIn()) renderNav(aptCenter()); },250);
}
map.on('moveend',onViewChanged);
map.on('zoomend',onViewChanged);
function maybeFetchDestNav(){
  if(!routeTarget || routeTarget.icao==='PUNTO'){
    if(destNavKey){ destNavKey=null; destAirports=[]; destVors=[]; renderNav(aptCenter()); }
    return;
  }
  const key=routeTarget.lat.toFixed(2)+','+routeTarget.lon.toFixed(2);
  if(destNavKey===key) return;
  destNavKey=key;
  fetch('/api/navdata?lat='+routeTarget.lat+'&lon='+routeTarget.lon+'&radius=250')
    .then(r=>r.json()).then(d=>{ if(!d.ready) return;
      destAirports=d.airports||[]; destVors=d.vors||[]; renderNav(aptCenter()); })
    .catch(()=>{});
}

// ---- Hora de despegue (debajo del tiempo de vuelo) ----
// Por defecto la hora local del SIMULADOR a la que despegaste ("despegaste 8:24 pm"): con
// el tiempo de vuelo al lado se ve a qué hora llegás en el sim. Un toque cambia a la hora
// REAL (la del iPad) y cuánto va durando en la vida real: con sim rate x4 son muy distintas.
let tiempoReal=false;
try{ tiempoReal=localStorage.getItem('tiempo.real')==='1'; }catch(e){}
function fmtHora12(h,m){
  return ((h%12)||12)+':'+String(m).padStart(2,'0')+(h<12?' am':' pm');
}
function pintarDespegue(s){
  const row=document.getElementById('time-row'), sub=document.getElementById('time-sub');
  const d=s && s.despegue;
  row.classList.toggle('con-despegue',!!d);
  row.classList.toggle('real',!!d && tiempoReal);
  if(!d){ sub.style.display='none'; return; }
  sub.style.display='';
  if(tiempoReal){
    const t=new Date(d.real*1000);
    // Mientras volás cuenta hasta ahora; ya en tierra, hasta el toque de pista
    const a=s.aterrizaje, fin=(a && a.t>d.real) ? a.t : Date.now()/1000;
    txt('s-despegue','despegue real '+fmtHora12(t.getHours(),t.getMinutes()));
    txt('s-real',fmtHm(Math.max(0,(fin-d.real)/60))+' reales');
  } else {
    if(d.sim_local==null){ txt('s-despegue','despegue: hora del sim desconocida'); }
    else { const x=Math.round(d.sim_local);
      txt('s-despegue','despegaste '+fmtHora12(Math.floor(x/3600)%24, Math.floor(x%3600/60))+' (sim)'); }
    txt('s-real','tocá: hora real');
  }
}
document.getElementById('time-row').addEventListener('click',()=>{
  if(!(lastState && lastState.despegue)) return;
  tiempoReal=!tiempoReal;
  try{ localStorage.setItem('tiempo.real',tiempoReal?'1':'0'); }catch(e){}
  pintarDespegue(lastState);
});
