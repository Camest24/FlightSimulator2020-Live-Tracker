/* geo-utils.js — Helpers geograficos: distancias, rumbos, proyeccion de puntos.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Distancias ----
// Regla de la casa: donde se vea una distancia se ven LAS DOS unidades, siempre en el
// mismo orden (km primero, NM después). Todo pasa por acá para que no se escape ninguna.
const KM_POR_NM=1.852;
function km(nm){ return Math.round((nm||0)*KM_POR_NM); }
function fmtDist(nm){ return nf(km(nm))+' km · '+Math.round(nm||0)+' NM'; }
// Igual pero con los km resaltados, para las líneas donde el km es el dato principal
function fmtDistB(nm){ return '<b>'+nf(km(nm))+' km</b> · '+Math.round(nm||0)+' NM'; }

function planeSVG(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.6"`:''}><path d="M12 2c-.5 0-1 .5-1 1.5V9L3 14v2l8-2.5V19l-2 1.5V22l3-1 3 1v-1.5L13 19v-5.5L21 16v-2l-8-5V3.5C13 2.5 12.5 2 12 2z"/></svg>`; }
// Silueta de A320 vista desde arriba (fuselaje + alas en flecha + 2 motores), apunta al norte
function planeSilhouette(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"`:''}><path d="M24 4C22.6 4 21.6 5.4 21.6 7.5L21.6 20 5 30 5 33 21.6 27.5 21.6 37 16.5 41 16.5 44 24 42 31.5 44 31.5 41 26.4 37 26.4 27.5 43 33 43 30 26.4 20 26.4 7.5C26.4 5.4 25.4 4 24 4Z"/><ellipse cx="13.6" cy="25.4" rx="1.7" ry="3"/><ellipse cx="34.4" cy="25.4" rx="1.7" ry="3"/></svg>`; }
// Jet pesado (4 motores)
function planeQuadJet(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"`:''}><path d="M24 4C22.6 4 21.6 5.4 21.6 7.5L21.6 20 5 30 5 33 21.6 27.5 21.6 37 16.5 41 16.5 44 24 42 31.5 44 31.5 41 26.4 37 26.4 27.5 43 33 43 30 26.4 20 26.4 7.5C26.4 5.4 25.4 4 24 4Z"/><ellipse cx="12.5" cy="27" rx="1.5" ry="2.6"/><ellipse cx="17" cy="24.6" rx="1.5" ry="2.6"/><ellipse cx="31" cy="24.6" rx="1.5" ry="2.6"/><ellipse cx="35.5" cy="27" rx="1.5" ry="2.6"/></svg>`; }
// Turbohélice (alas rectas + discos de hélice)
function planeTurboprop(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"`:''}><path d="M24 4c-1.3 0-2.3 1.3-2.3 3.2V20L6 23.5v3l15.7-2.6V37l-4.6 3.6V44L24 42l6.9 2v-3.4L26.3 37V23.9L42 26.5v-3L26.3 20V7.2C26.3 5.3 25.3 4 24 4z"/><ellipse cx="14" cy="22" rx="1.6" ry="2.4"/><ellipse cx="34" cy="22" rx="1.6" ry="2.4"/><path d="M14 17.6v8.8M34 17.6v8.8" stroke="${fill}" stroke-width="1.3" opacity="0.75"/></svg>`; }
// Helicóptero
function planeHeli(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8"`:''}><ellipse cx="24" cy="22" rx="5" ry="9"/><rect x="22.8" y="29" width="2.4" height="13" rx="1"/><rect x="18" y="40" width="12" height="2.4" rx="1"/><path d="M8 10L40 34M40 10L8 34" stroke="${fill}" stroke-width="2" opacity="0.8"/></svg>`; }
// Widebody bimotor (A330/777/787): misma silueta que el A320 pero con motores más gordos;
// además se dibuja más grande (ver mePlaneSVG).
function planeWide(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"`:''}><path d="M24 3C22.5 3 21.4 4.5 21.4 6.8L21.4 19.5 4 30 4 33.2 21.4 27.6 21.4 37.5 16 41.4 16 44.5 24 42.6 32 44.5 32 41.4 26.6 37.5 26.6 27.6 44 33.2 44 30 26.6 19.5 26.6 6.8C26.6 4.5 25.5 3 24 3Z"/><ellipse cx="13.2" cy="25.6" rx="2.3" ry="3.7"/><ellipse cx="34.8" cy="25.6" rx="2.3" ry="3.7"/></svg>`; }
// Jet ejecutivo / regional con motores atrás (Citation, Learjet, CRJ): alas limpias,
// los dos motores pegados a la cola y cola en T.
function planeRearJet(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"`:''}><path d="M24 4C25.2 4 26 5.4 26 7.5L26 19 41 27 41 29.5 26 25.5 26 37 32 39.5 32 42 24 41 16 42 16 39.5 22 37 22 25.5 7 29.5 7 27 22 19 22 7.5C22 5.4 22.8 4 24 4Z"/><ellipse cx="20" cy="32.5" rx="1.8" ry="3.3"/><ellipse cx="28" cy="32.5" rx="1.8" ry="3.3"/></svg>`; }
// Avioneta monomotor (C172, Piper): ala recta larga, hélice adelante.
function planeGA(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"`:''}><path d="M24 6C25.4 6 26.2 7.2 26.2 8.8L26.2 15 44 15 44 19.5 26.2 19.5 26 36 32.2 37.2 32.2 40.8 24 40.8 15.8 40.8 15.8 37.2 22 36 21.8 19.5 4 19.5 4 15 21.8 15 21.8 8.8C21.8 7.2 22.6 6 24 6Z"/><path d="M17.5 4.6H30.5" stroke="${fill}" stroke-width="1.8" stroke-linecap="round" opacity="0.8"/></svg>`; }
// Bimotor de pistón (Baron, Seneca, DA62): ala recta con dos góndolas y dos hélices.
function planeTwinProp(fill,size,stroke){ return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"`:''}><path d="M24 6C25.4 6 26.2 7.2 26.2 8.8L26.2 16 44 16.5 44 20.5 26.2 20.5 26 36 32.2 37.2 32.2 40.8 24 40.8 15.8 40.8 15.8 37.2 22 36 21.8 20.5 4 20.5 4 16.5 21.8 16 21.8 8.8C21.8 7.2 22.6 6 24 6Z"/><ellipse cx="14.5" cy="17" rx="2" ry="4.4"/><ellipse cx="33.5" cy="17" rx="2" ry="4.4"/><path d="M10 12.2H19M29 12.2H38" stroke="${fill}" stroke-width="1.6" stroke-linecap="round" opacity="0.8"/></svg>`; }

// Elige el ícono del avión propio. Antes solo miraba tipo y cantidad de motores, así que
// cualquier jet bimotor era un A320. Ahora usa el mismo perfil que la tabla de descenso
// (código ICAO del sim, nombre, o motor + peso; o el que elijas a mano en la tabla), y el
// tamaño también cambia: un 777 se ve más grande que un CRJ.
function tipoIcono(){
  const s=lastState||{}, et=s.eng_type, n=s.eng_count||0;
  if(et===3) return 'heli';
  let perfil=null;
  try{ perfil=perfilElegido||perfilAuto(); }catch(e){}       // vive en flight-progress.js
  if(perfil==='ga') return (et===0 && n>=2) ? 'twinprop' : 'ga';
  if(perfil==='heavy') return (n && n<4) ? 'wide' : 'quad';
  // Regionales con motores en la cola (CRJ, Fokker 70/100); los E-Jet los llevan bajo el ala
  if(perfil==='regional' && /^(CRJ|F70|F100)/.test((s.ac_icao||'').toUpperCase())) return 'regionalcola';
  if(perfil) return perfil;
  if(et===1) return n>=4 ? 'quad' : 'narrow';
  if(et===5) return 'turboprop';
  return et===0 && n>=2 ? 'twinprop' : 'ga';
}
function mePlaneSVG(){
  const C='#fbbf24', B='#1e293b';          // amarillo, como en Flightradar
  switch(tipoIcono()){
    case 'quad':      return planeQuadJet(C,50,B);
    case 'wide':      return planeWide(C,50,B);
    case 'narrow':    return planeSilhouette(C,42,B);
    case 'regional':  return planeSilhouette(C,37,B);
    case 'regionalcola': return planeRearJet(C,39,B);
    case 'bizjet':    return planeRearJet(C,34,B);
    case 'turboprop': return planeTurboprop(C,40,B);
    case 'twinprop':  return planeTwinProp(C,34,B);
    case 'heli':      return planeHeli(C,36,B);
    default:          return planeGA(C,32,B);
  }
}
let acIconKey=null;
function updatePlaneIcon(s){
  const key=tipoIcono();
  if(key===acIconKey) return;
  acIconKey=key;
  if(meMarker) meMarker.getElement().innerHTML=mePlaneSVG();
}
function popup(html){ return new mapboxgl.Popup({offset:16,closeButton:false}).setHTML(html); }
function acftEl(cls,svg,hdg){ const el=document.createElement('div'); el.innerHTML=`<div class="acft-inner ${cls}" style="transform:rotate(${hdg}deg)">${svg}</div>`; return el; }

let followMode=true, meMarker=null, meInner=null;
// Cámara de torre en el mapa 2D (ver flightplan.js/placeTower2D y telemetry.js/planeFrame):
// centro FIJO en towerPoint2D, con el mapa rotando solo para seguir mirando al avión —
// nada de esto toca Terreno 3D/Cesium, es la versión 2D de la misma idea.
let towerMode2D=false, towerPoint2D=null;
let aptMarkers=[], vorMarkers=[];
const flags={apt:true,vor:true,grids:false};
let navRef=null, navAirports=[], navVors=[];
let aptRadius=60, lastAptCenter=null;   // radio de aeropuertos (NM)
// Celular (vertical u horizontal): mismo corte que las @media del final de main.css.
// Ahí los paneles se acomodan distinto (arriba/abajo o fijos a los costados).
const MQ_CHICA=window.matchMedia('(max-width:700px), (max-height:500px)');
function pantallaChica(){ return MQ_CHICA.matches; }
let routeTarget=null;                    // {lat,lon,icao} destino de la ruta
let routeWaypoints=[], wpId=0;           // puntos de ruta intermedios {id,lat,lon,marker}
let lastGs=0;                            // última ground speed (kt), para el ETA de la ruta
let lastState=null;                      // último estado recibido, para prellenar el editor
let searchMarker=null, searchAirport=null;   // buscador de aeropuertos
let addWpMode=false;                     // modo "agregar punto de ruta" (evita puntos accidentales)

map.on('load',()=>{
  map.addSource('rw-fill',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('rw-center',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  // Las pistas también se funden con el zoom: de lejos son manchas ilegibles
  map.addLayer({id:'rw-fill',type:'fill',source:'rw-fill',paint:{'fill-color':'#0f172a','fill-outline-color':'#fff',
    'fill-opacity':['interpolate',['linear'],['zoom'],7,0,9.5,0.85]}});
  map.addLayer({id:'rw-center',type:'line',source:'rw-center',paint:{'line-color':'#fff','line-width':1.4,'line-dasharray':[3,3.5],
    'line-opacity':['interpolate',['linear'],['zoom'],7,0,9.5,0.85]}});
  map.addSource('flown',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'flown',type:'line',source:'flown',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-width':5}});
  // Ruta directa a un aeropuerto (plan de vuelo simple)
  map.addSource('planroute',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'planroute-line',type:'line',source:'planroute',filter:['==',['geometry-type'],'LineString'],layout:{'line-cap':'round'},paint:{'line-color':'#a855f7','line-width':3,'line-dasharray':[2,2]}});
  map.addLayer({id:'planroute-pt',type:'circle',source:'planroute',filter:['all',['==',['geometry-type'],'Point'],['!',['has','ident']],['!',['has','vnav']]],paint:{'circle-radius':6,'circle-color':'#a855f7','circle-stroke-color':'#fff','circle-stroke-width':2}});
  // Tope de ascenso (verde, como el ícono "en ascenso") y de descenso (celeste), calculados
  // en flight-progress.js (featuresVnav). El texto va arriba a la derecha del punto: abajo
  // ya están los nombres de los waypoints, y centrado encima se pisaba con la etiqueta de
  // la propia ruta en las rutas norte-sur.
  map.addLayer({id:'planroute-vnav-pt',type:'circle',source:'planroute',filter:['has','vnav'],paint:{'circle-radius':7,
    'circle-color':['match',['get','vnav'],'toc','#4ade80','#38bdf8'],'circle-stroke-color':'#0f172a','circle-stroke-width':2.5}});
  map.addLayer({id:'planroute-vnav-lbl',type:'symbol',source:'planroute',filter:['has','vnav'],layout:{'text-field':['get','label'],
    'text-font':FUENTE_NEGRITA,'text-size':12.5,'text-line-height':1.25,'text-anchor':'bottom-left','text-justify':'left','text-offset':[0.9,-0.6],
    'text-allow-overlap':true,'text-ignore-placement':true},
    paint:{'text-color':['match',['get','vnav'],'toc','#86efac','#7dd3fc'],'text-halo-color':'rgba(10,10,20,0.92)','text-halo-width':2.4}});
  // Nombres de los VOR de la ruta generada. Al dibujarlos como capa del mapa (y no como
  // HTML encima) se comportan bien al inclinar la vista en 3D.
  map.addLayer({id:'planroute-wp',type:'symbol',source:'planroute',filter:['all',['==',['geometry-type'],'Point'],['has','ident']],layout:{'text-field':['get','ident'],'text-font':FUENTE_NEGRITA,'text-size':12.5,'text-offset':[0,1.3],'text-anchor':'top','text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#7dd3fc','text-halo-color':'rgba(10,10,20,0.92)','text-halo-width':2.4}});
  // 'line' + symbol-spacing repite la etiqueta a lo largo del trazo cada ~350 px de pantalla.
  // Con 'line-center' el texto vivía en el punto medio de la ruta: en un Cartagena-Boston
  // ese punto queda fuera de la vista y la etiqueta desaparecía.
  map.addLayer({id:'planroute-label',type:'symbol',source:'planroute',filter:['==',['geometry-type'],'LineString'],layout:{'symbol-placement':'line','symbol-spacing':350,'text-field':['get','label'],'text-font':FUENTE_NEGRITA,'text-size':17,'text-allow-overlap':true,'text-ignore-placement':true,'text-keep-upright':true},paint:{'text-color':'#ffffff','text-halo-color':'rgba(10,10,20,0.9)','text-halo-width':2.8,'text-halo-blur':0.3}});
  // Plan de vuelo del propio MSFS (solo lectura) — línea magenta como la del GPS
  map.addSource('fplan',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'fplan-line',type:'line',source:'fplan',filter:['==',['geometry-type'],'LineString'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#ff3df5','line-width':3.5,'line-opacity':0.9}});
  map.addLayer({id:'fplan-pt',type:'circle',source:'fplan',filter:['==',['geometry-type'],'Point'],paint:{'circle-radius':5,'circle-color':'#ff3df5','circle-stroke-color':'#fff','circle-stroke-width':2}});
  // Círculo del radio de aeropuertos
  map.addSource('aptcircle',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'aptcircle',type:'line',source:'aptcircle',paint:{'line-color':'#2f6df6','line-width':1.6,'line-dasharray':[3,3],'line-opacity':0.85}});
  // Toggle "Grids": retícula de lat/lon (siempre que está prendido) + eje de pista
  // extendido para el destino elegido (solo si hay una pista concreta, con rumbo).
  map.addSource('coordgrid',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'coordgrid-line',type:'line',source:'coordgrid',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':'#94a3b8','line-width':1,'line-opacity':0.5}});
  map.addLayer({id:'coordgrid-label',type:'symbol',source:'coordgrid',filter:['==',['geometry-type'],'Point'],layout:{'text-field':['get','label'],'text-font':FUENTE_NEGRITA,'text-size':10.5,'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#cbd5e1','text-halo-color':'rgba(10,10,20,0.85)','text-halo-width':1.4}});
  map.addSource('rwyaxis',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'rwyaxis-line',type:'line',source:'rwyaxis',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':'#facc15','line-width':2,'line-dasharray':[1,2]}});
  map.addLayer({id:'rwyaxis-tick',type:'circle',source:'rwyaxis',filter:['==',['geometry-type'],'Point'],paint:{'circle-radius':3,'circle-color':'#facc15','circle-stroke-color':'#1e293b','circle-stroke-width':1}});
  map.addLayer({id:'rwyaxis-label',type:'symbol',source:'rwyaxis',filter:['==',['geometry-type'],'Point'],layout:{'text-field':['get','label'],'text-font':FUENTE_NEGRITA,'text-size':11,'text-offset':[0,-1.1],'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#facc15','text-halo-color':'rgba(10,10,20,0.85)','text-halo-width':1.6}});
  map.on('moveend',updateGrids);
  map.on('zoomend',updateGrids);
  // La etiqueta de la ruta va al tope de la pila: si no, la línea magenta del plan de
  // MSFS se dibuja encima y el texto queda tapado.
  map.moveLayer('planroute-label');
  map.moveLayer('planroute-wp');
  map.moveLayer('planroute-vnav-pt');
  map.moveLayer('planroute-vnav-lbl');
  // El plan de vuelo del propio MSFS se sigue calculando y guardando (lo usa el chip de
  // abajo), pero no lo dibujamos: poné FPLAN_LINE_VISIBLE=true para volver a verlo.
  const v = FPLAN_LINE_VISIBLE ? 'visible' : 'none';
  map.setLayoutProperty('fplan-line','visibility',v);
  map.setLayoutProperty('fplan-pt','visibility',v);
  // Polling HTTP a 10 lecturas por segundo (ver startTelemetry() en tools-ui.js). Se probó
  // reemplazar esto por WebSocket y salió peor en la práctica — ver comentario ahí mismo.
  startTelemetry();
});

// El estado del seguimiento se ve en el botón de la barra (encendido/apagado),
// así que ya no hace falta el cartel de abajo.
function unfollow(){ if(!followMode) return;
  followMode=false;
  document.getElementById('btn-center').classList.remove('active'); }
map.on('dragstart',unfollow);
map.on('click',(e)=>{
  if(addWpMode && routeTarget){
    // Si el toque cae cerca de una marca del eje de pista (5/10/15/20 NM, toggle "Grids"),
    // el punto se agrega EXACTO ahí en vez de en el pixel bajo el dedo: a mano es casi
    // imposible acertarle a un círculo de 3px, sobre todo en el celular. El radio de
    // tolerancia es en pantalla (px), no en distancia real, así que no depende del zoom.
    const tol=10;
    const hits=map.queryRenderedFeatures(
      [[e.point.x-tol,e.point.y-tol],[e.point.x+tol,e.point.y+tol]], {layers:['rwyaxis-tick']});
    if(hits.length){
      const c=hits[0].geometry.coordinates;
      addWaypoint(c[0], c[1], hits[0].properties.label);
    } else {
      addWaypoint(e.lngLat.lng, e.lngLat.lat);
    }
    return;   // modo agregar punto
  }
  if(lpMarker){ closePointMenu(); return; }
  // ↑ Antes esto era "return" a secas: el primer clic (el que ABRE el menú de pulsación
  // larga) queda absorbido acá para no encadenar un unfollow() de más. El problema era
  // que TODO clic siguiente, mientras el menú seguía abierto (si tocabas otro punto del
  // mapa sin elegir ninguna opción), también quedaba absorbido sin hacer nada — el mapa
  // "no respondía" al dedo en esa zona hasta cerrar el menú a mano con la ✕. Ahora un
  // clic mientras está abierto simplemente lo cierra, como tocar afuera de un popup.
  unfollow();                       // un toque en el mapa suelta el seguimiento automático
});
function follow(){ followMode=true; document.getElementById('btn-center').classList.add('active'); }
document.getElementById('btn-center').onclick=()=>{
  // Salir de la cámara de torre 2D: mismo botón de siempre, vuelve derecho a seguir al
  // avión en vez de quedar plantado en el punto que tocaste.
  if(towerMode2D){
    towerMode2D=false; towerPoint2D=null;
    map.setBearing(0);
    follow();
    if(meMarker){ const g=meMarker.getLngLat(); map.easeTo({center:centroSeguir(g.lng,g.lat)}); }
    return;
  }
  // Apagarlo con el botón es una decisión: ahí no se recentra solo (ver más abajo).
  if(followMode){ unfollow(); autoRecentrar=false; }
  else { autoRecentrar=true; follow(); if(meMarker){ const g=meMarker.getLngLat(); map.easeTo({center:centroSeguir(g.lng,g.lat)}); } }
};

// ---- Volver solo al avión a los 5 s ----
// Mover el mapa con el dedo suelta el seguimiento, y después había que acordarse de
// tocar el botón para volver. Ahora, si soltaste el seguimiento tocando o arrastrando el
// mapa, a los 5 s sin tocar nada vuelve solo. Si lo apagaste con el BOTÓN, se respeta.
// No vuelve mientras estés haciendo algo en el mapa: agregando puntos, con un menú,
// popup, buscador o ventana abierta, o mirando la ficha de un avión del tráfico.
const RECENTRAR_MS=5000;
let autoRecentrar=true, ultimoToque=Date.now();
// Toques y rueda siempre son tuyos. Zoom/giro/inclinación cuentan solo si traen el evento
// original: los que dispara la propia app al seguir al avión no lo traen.
['touchstart','touchmove','mousedown','wheel'].forEach(ev=>map.on(ev,()=>{ ultimoToque=Date.now(); }));
['dragstart','zoomstart','rotatestart','pitchstart'].forEach(ev=>
  map.on(ev, e=>{ if(e && e.originalEvent) ultimoToque=Date.now(); }));
function haciendoAlgoEnElMapa(){
  const visible=id=>{ const el=document.getElementById(id); return !!el && !el.classList.contains('hidden'); };
  return addWpMode || (typeof lpMarker!=='undefined' && lpMarker)
    || !!document.querySelector('.mapboxgl-popup')
    || ['search-panel','ac-card','resumen-modal','hist-modal','opts-modal','status-modal','tabla-modal','time-modal'].some(visible);
}
setInterval(()=>{
  if(followMode || !autoRecentrar || towerMode2D || !meMarker) return;
  if(Date.now()-ultimoToque<RECENTRAR_MS || haciendoAlgoEnElMapa()) return;
  // Se marca ANTES de guardar `toque` (que no se vuelva a disparar mientras dura la
  // animación). Al revés, la comprobación de abajo nunca coincidía y no volvía a seguir.
  ultimoToque=Date.now();
  const g=meMarker.getLngLat(), toque=ultimoToque;
  map.easeTo({center:centroSeguir(g.lng,g.lat), duration:900});
  // El seguimiento se prende al terminar el viaje (si se prendiera antes, planeFrame
  // pisaría la animación con saltos). Si en el medio tocaste el mapa, se cancela.
  setTimeout(()=>{ if(ultimoToque===toque && !followMode) follow(); }, 950);
}, 500);

// ---- Plan de vuelo (ruta directa + teletransporte beta) ----
function haversineNM(la1,lo1,la2,lo2){ const R=3440.065,p1=la1*Math.PI/180,p2=la2*Math.PI/180,dp=(la2-la1)*Math.PI/180,dl=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2; return 2*R*Math.asin(Math.sqrt(a)); }

// ---- Grids: retícula de coordenadas + eje de pista extendido (ver toggle "Grids") ----
// El paso de la retícula se achica con el zoom, para que nunca queden ni 2 líneas
// perdidas (muy alejado) ni un enrejado ilegible (muy cerca).
function gridStepDeg(){
  const z=map.getZoom();
  if(z>=11) return 0.05;
  if(z>=9) return 0.1;
  if(z>=7) return 0.5;
  if(z>=5) return 1;
  return 2;
}
function drawCoordGrid(){
  const src=map.getSource('coordgrid'); if(!src) return;
  if(!flags.grids){ src.setData({type:'FeatureCollection',features:[]}); return; }
  const b=map.getBounds(), step=gridStepDeg();
  const lonMin=Math.floor(b.getWest()/step)*step, lonMax=Math.ceil(b.getEast()/step)*step;
  const latMin=Math.floor(b.getSouth()/step)*step, latMax=Math.ceil(b.getNorth()/step)*step;
  const dec=step<0.1?3:(step<1?2:0), feats=[];
  for(let la=latMin; la<=latMax+1e-9; la+=step){
    feats.push({type:'Feature',geometry:{type:'LineString',coordinates:[[lonMin,la],[lonMax,la]]},properties:{}});
    feats.push({type:'Feature',geometry:{type:'Point',coordinates:[lonMin,la]},properties:{label:la.toFixed(dec)+'°'}});
  }
  for(let lo=lonMin; lo<=lonMax+1e-9; lo+=step){
    feats.push({type:'Feature',geometry:{type:'LineString',coordinates:[[lo,latMin],[lo,latMax]]},properties:{}});
    feats.push({type:'Feature',geometry:{type:'Point',coordinates:[lo,latMax]},properties:{label:lo.toFixed(dec)+'°'}});
  }
  src.setData({type:'FeatureCollection',features:feats});
}
// Curso de aproximación extendido de la pista elegida como destino (routeTarget.hdg):
// una línea saliendo del umbral hacia atrás, con marcas cada 5 NM, para alinear los
// puntos de la ruta con el eje real de la pista en vez de a ojo.
function drawRwyAxis(){
  const src=map.getSource('rwyaxis'); if(!src) return;
  if(!flags.grids || !routeTarget || !routeTarget.pista || routeTarget.hdg==null){
    src.setData({type:'FeatureCollection',features:[]}); return;
  }
  const {lat,lon,hdg}=routeTarget, back=(hdg+180)%360, maxNm=20, stepNm=5;
  const coords=[[lon,lat]], feats=[];
  for(let d=stepNm; d<=maxNm; d+=stepNm){
    const p=dest(lat,lon,back,d*1852);
    coords.push(p);
    feats.push({type:'Feature',geometry:{type:'Point',coordinates:p},properties:{label:d+' NM'}});
  }
  feats.unshift({type:'Feature',geometry:{type:'LineString',coordinates:coords},properties:{}});
  src.setData({type:'FeatureCollection',features:feats});
}
function updateGrids(){ drawCoordGrid(); drawRwyAxis(); }

// ---- Mantener pulsado (genérico) ----
// `ms` sin moverse más de 10 px. Si arrastrás (scroll del panel, mover el mapa) se cancela.
// Mientras se aprieta, el elemento lleva la clase "apretando" (para dar respuesta visual).
function alMantenerPulsado(el, fn, ms){
  if(!el) return;
  ms=ms||450;
  let t=null, x0=0, y0=0;
  const arrancar=(x,y)=>{ x0=x; y0=y; clearTimeout(t); el.classList.add('apretando');
    t=setTimeout(()=>{ t=null; el.classList.remove('apretando'); fn(); }, ms); };
  const cancelar=()=>{ clearTimeout(t); t=null; el.classList.remove('apretando'); };
  const moverse=(x,y)=>{ if(t && (Math.abs(x-x0)>10 || Math.abs(y-y0)>10)) cancelar(); };
  el.addEventListener('mousedown',e=>arrancar(e.clientX,e.clientY));
  el.addEventListener('mousemove',e=>moverse(e.clientX,e.clientY));
  el.addEventListener('mouseup',cancelar);
  el.addEventListener('mouseleave',cancelar);
  el.addEventListener('touchstart',e=>{ if(e.touches[0]) arrancar(e.touches[0].clientX,e.touches[0].clientY); },{passive:true});
  el.addEventListener('touchmove',e=>{ if(e.touches[0]) moverse(e.touches[0].clientX,e.touches[0].clientY); },{passive:true});
  el.addEventListener('touchend',cancelar);
  el.addEventListener('touchcancel',cancelar);
  el.addEventListener('contextmenu',e=>e.preventDefault());   // iOS/Android: sin menú del sistema
}

// ---- Flechita de rumbo ----
// `gradosVerdaderos`: el rumbo respecto al norte geográfico (el del mapa). Se le resta la
// rotación del mapa para que apunte igual que la línea que ves en pantalla, aunque lo
// hayas girado (3D en persecución). Se acumula el ángulo para que al pasar de 359° a 1° no
// dé la vuelta entera con la animación.
// ---- Rosa del dock: hacia dónde queda el destino ----
// El avión va FIJO apuntando arriba (como el ND de la cabina) y la flecha ámbar marca el
// destino respecto de la nariz: arriba = vas derecho, a la derecha = girá a la derecha.
// Antes las dos giraban según el norte del mapa y la marca era un triángulo apuntando
// hacia adentro: parecía una flecha al revés y no decía para dónde girar (2026-11-21).
let rosaBrg=null;                  // rumbo verdadero al destino (lo pone updateProgress)
function pintarRosa(){
  const el=document.getElementById('fr-brg'); if(!el) return;
  const h=lastState ? lastState.heading : null;
  if(rosaBrg==null || h==null || isNaN(rosaBrg)){ el.style.visibility='hidden'; return; }
  el.style.visibility='';
  const giro=((rosaBrg-h)%360+540)%360-180;          // -180..180, + = a la derecha
  let ang=giro;
  const prev=parseFloat(el.dataset.ang);
  if(!isNaN(prev)){ ang=prev+((((ang-prev)%360)+540)%360-180); }   // sin vueltas largas
  el.dataset.ang=ang;
  el.style.transform='rotate('+ang+'deg)';
  el.classList.toggle('derecho', Math.abs(giro)<=5);
}

function girarFlecha(id, gradosVerdaderos){
  const el=document.getElementById(id); if(!el) return;
  if(gradosVerdaderos==null || isNaN(gradosVerdaderos)){ el.style.visibility='hidden'; return; }
  el.style.visibility='';
  let ang=gradosVerdaderos-(map && map.getBearing ? map.getBearing() : 0);
  const prev=parseFloat(el.dataset.ang);
  if(!isNaN(prev)){ ang=prev+((((ang-prev)%360)+540)%360-180); }
  el.dataset.ang=ang;
  el.style.transform='rotate('+ang+'deg)';
}
