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
let aptMarkers=[], vorMarkers=[];
const flags={apt:true,vor:true,terrain3d:false};
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
  // La etiqueta de la ruta va al tope de la pila: si no, la línea magenta del plan de
  // MSFS se dibuja encima y el texto queda tapado.
  map.moveLayer('planroute-label');
  map.moveLayer('planroute-wp');
  // El plan de vuelo del propio MSFS se sigue calculando y guardando (lo usa el chip de
  // abajo), pero no lo dibujamos: poné FPLAN_LINE_VISIBLE=true para volver a verlo.
  const v = FPLAN_LINE_VISIBLE ? 'visible' : 'none';
  map.setLayoutProperty('fplan-line','visibility',v);
  map.setLayoutProperty('fplan-pt','visibility',v);
  poll(); setInterval(poll,250);   // 4 lecturas por segundo
});

// El estado del seguimiento se ve en el botón de la barra (encendido/apagado),
// así que ya no hace falta el cartel de abajo.
function unfollow(){ if(!followMode) return;
  followMode=false;
  document.getElementById('btn-center').classList.remove('active'); }
map.on('dragstart',unfollow);
map.on('click',(e)=>{
  if(addWpMode && routeTarget){ addWaypoint(e.lngLat.lng, e.lngLat.lat); return; }   // modo agregar punto
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
  if(followMode){ unfollow(); }
  else { follow(); if(meMarker){ const g=meMarker.getLngLat(); map.easeTo({center:centroSeguir(g.lng,g.lat)}); } }
};

// ---- Plan de vuelo (ruta directa + teletransporte beta) ----
function haversineNM(la1,lo1,la2,lo2){ const R=3440.065,p1=la1*Math.PI/180,p2=la2*Math.PI/180,dp=(la2-la1)*Math.PI/180,dl=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2; return 2*R*Math.asin(Math.sqrt(a)); }
