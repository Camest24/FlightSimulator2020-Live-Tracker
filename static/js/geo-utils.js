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
// Elige el ícono según el tipo de avión que reporta el simulador
function mePlaneSVG(){
  const s=lastState||{}, et=s.eng_type, n=s.eng_count||2;
  const C='#fbbf24';                       // amarillo, como en Flightradar
  if(et===1) return (n>=4) ? planeQuadJet(C,44,'#1e293b') : planeSilhouette(C,42,'#1e293b');
  if(et===5) return planeTurboprop(C,40,'#1e293b');
  if(et===3) return planeHeli(C,36,'#1e293b');
  return planeSVG(C,30,'#1e293b');        // pistón / desconocido
}
let acIconKey=null;
function updatePlaneIcon(s){
  const key=(s.eng_type==null?'x':s.eng_type)+'-'+(s.eng_count||0);
  if(key===acIconKey) return;
  acIconKey=key;
  if(meMarker) meMarker.getElement().innerHTML=mePlaneSVG();
}
function popup(html){ return new maplibregl.Popup({offset:16,closeButton:false}).setHTML(html); }
function acftEl(cls,svg,hdg){ const el=document.createElement('div'); el.innerHTML=`<div class="acft-inner ${cls}" style="transform:rotate(${hdg}deg)">${svg}</div>`; return el; }

let followMode=true, meMarker=null, meInner=null;
// Cámara de torre en el mapa 2D (ver flightplan.js/placeTower2D y telemetry.js/planeFrame):
// centro FIJO en towerPoint2D, con el mapa rotando solo para seguir mirando al avión —
// nada de esto toca Terreno 3D/Cesium, es la versión 2D de la misma idea.
let towerMode2D=false, towerPoint2D=null;
let aptMarkers=[], vorMarkers=[];
const flags={apt:true,vor:true,terrain3d:false,grids:false};
let navRef=null, navAirports=[], navVors=[];
let aptRadius=60, lastAptCenter=null;   // radio de aeropuertos (NM)
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
  map.addLayer(planeModelLayer);
  // Ruta directa a un aeropuerto (plan de vuelo simple)
  map.addSource('planroute',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'planroute-line',type:'line',source:'planroute',filter:['==',['geometry-type'],'LineString'],layout:{'line-cap':'round'},paint:{'line-color':'#a855f7','line-width':3,'line-dasharray':[2,2]}});
  map.addLayer({id:'planroute-pt',type:'circle',source:'planroute',filter:['all',['==',['geometry-type'],'Point'],['!',['has','ident']]],paint:{'circle-radius':6,'circle-color':'#a855f7','circle-stroke-color':'#fff','circle-stroke-width':2}});
  // Nombres de los VOR de la ruta generada. Al dibujarlos como capa del mapa (y no como
  // HTML encima) se comportan bien al inclinar la vista en 3D.
  map.addLayer({id:'planroute-wp',type:'symbol',source:'planroute',filter:['all',['==',['geometry-type'],'Point'],['has','ident']],layout:{'text-field':['get','ident'],'text-font':['Noto Sans Bold'],'text-size':12.5,'text-offset':[0,1.3],'text-anchor':'top','text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#7dd3fc','text-halo-color':'rgba(10,10,20,0.92)','text-halo-width':2.4}});
  // 'line' + symbol-spacing repite la etiqueta a lo largo del trazo cada ~350 px de pantalla.
  // Con 'line-center' el texto vivía en el punto medio de la ruta: en un Cartagena-Boston
  // ese punto queda fuera de la vista y la etiqueta desaparecía.
  map.addLayer({id:'planroute-label',type:'symbol',source:'planroute',filter:['==',['geometry-type'],'LineString'],layout:{'symbol-placement':'line','symbol-spacing':350,'text-field':['get','label'],'text-font':['Noto Sans Bold'],'text-size':17,'text-allow-overlap':true,'text-ignore-placement':true,'text-keep-upright':true},paint:{'text-color':'#ffffff','text-halo-color':'rgba(10,10,20,0.9)','text-halo-width':2.8,'text-halo-blur':0.3}});
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
  map.addLayer({id:'coordgrid-label',type:'symbol',source:'coordgrid',filter:['==',['geometry-type'],'Point'],layout:{'text-field':['get','label'],'text-font':['Noto Sans Bold'],'text-size':10.5,'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#cbd5e1','text-halo-color':'rgba(10,10,20,0.85)','text-halo-width':1.4}});
  map.addSource('rwyaxis',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'rwyaxis-line',type:'line',source:'rwyaxis',filter:['==',['geometry-type'],'LineString'],paint:{'line-color':'#facc15','line-width':2,'line-dasharray':[1,2]}});
  map.addLayer({id:'rwyaxis-tick',type:'circle',source:'rwyaxis',filter:['==',['geometry-type'],'Point'],paint:{'circle-radius':3,'circle-color':'#facc15','circle-stroke-color':'#1e293b','circle-stroke-width':1}});
  map.addLayer({id:'rwyaxis-label',type:'symbol',source:'rwyaxis',filter:['==',['geometry-type'],'Point'],layout:{'text-field':['get','label'],'text-font':['Noto Sans Bold'],'text-size':11,'text-offset':[0,-1.1],'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#facc15','text-halo-color':'rgba(10,10,20,0.85)','text-halo-width':1.6}});
  map.on('moveend',updateGrids);
  map.on('zoomend',updateGrids);
  // La etiqueta de la ruta va al tope de la pila: si no, la línea magenta del plan de
  // MSFS se dibuja encima y el texto queda tapado.
  map.moveLayer('planroute-label');
  map.moveLayer('planroute-wp');
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
  // En modo Terreno 3D la cámara YA está siempre centrada en el avión (no hay "soltar
  // seguimiento" ahí, a diferencia del mapa 2D) — acá el botón cambia de sentido: resetea
  // la órbita a la vista default, derecho detrás del avión, por si quedó mirando desde
  // cualquier otro ángulo por un drag anterior.
  if(planeModelOn && window.cesium3D){ window.cesium3D.recenter(); return; }
  // Salir de la cámara de torre 2D: mismo botón de siempre, vuelve derecho a seguir al
  // avión en vez de quedar plantado en el punto que tocaste.
  if(towerMode2D){
    towerMode2D=false; towerPoint2D=null;
    map.setBearing(0);
    follow();
    if(meMarker){ const g=meMarker.getLngLat(); map.easeTo({center:centroSeguir(g.lng,g.lat)}); }
    return;
  }
  if(followMode){ unfollow(); }
  else { follow(); if(meMarker){ const g=meMarker.getLngLat(); map.easeTo({center:centroSeguir(g.lng,g.lat)}); } }
};

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
