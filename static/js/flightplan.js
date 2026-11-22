/* flightplan.js — Plan de vuelo: menu al mantener pulsado, plan de MSFS, generador por VOR, sim rate.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Mantener pulsado en el mapa => menú para trazar ruta a ese punto ----
const LONG_PRESS_MS=800;
let lpTimer=null, lpMarker=null;
function cancelLongPress(){ if(lpTimer){ clearTimeout(lpTimer); lpTimer=null; } }
function closePointMenu(){ if(lpMarker){ lpMarker.remove(); lpMarker=null; } }
function showPointMenu(lngLat){
  closePointMenu();
  const el=document.createElement('div'); el.className='lp-menu glass';
  // Si ya hay una ruta activa, ofrecemos además meterlo como punto intermedio
  el.innerHTML='<button class="lp-btn lp-go">Ir hacia aquí</button>'
    +(routeTarget?'<button class="lp-btn lp-wp">＋ Punto</button>':'')
    +'<button class="lp-btn lp-cam">🗼 Torre aquí</button>'
    +'<button class="lp-btn lp-tp">✈ Teletransportarme</button>'
    +'<button class="lp-btn lp-x">✕</button>';
  el.querySelector('.lp-go').onclick=()=>{
    routeWaypoints.forEach(w=>w.marker.remove()); routeWaypoints=[];   // destino nuevo => waypoints viejos ya no aplican
    routeTarget={lat:lngLat.lat, lon:lngLat.lng, icao:'PUNTO'};
    msfsPlanAuto=false;                      // ruta puesta a mano: manda sobre la de MSFS
    drawRoute(); closePointMenu();
  };
  const wp=el.querySelector('.lp-wp');
  if(wp) wp.onclick=()=>{ addWaypoint(lngLat.lng, lngLat.lat); closePointMenu(); };
  el.querySelector('.lp-cam').onclick=()=>{ placeTower2D(lngLat.lat, lngLat.lng); closePointMenu(); };
  el.querySelector('.lp-tp').onclick=()=>showTeleportForm(el, lngLat);
  el.querySelector('.lp-x').onclick=closePointMenu;
  lpMarker=new mapboxgl.Marker({element:el, anchor:'bottom', offset:[0,-12]}).setLngLat(lngLat).addTo(map);
}
// Cámara de torre en el mapa: centro FIJO en el punto tocado (a lo sumo 5 km del avión) y
// el mapa rota solo para seguir mirando hacia el avión (ver planeFrame en telemetry.js).
const TOWER2D_MAX_M=5000;
function placeTower2D(lat,lng){
  if(!cur) return;
  let tLat=lat, tLng=lng;
  const distM=haversineNM(cur.lat,cur.lng,lat,lng)*1852;
  if(distM>TOWER2D_MAX_M){
    const brg=bearingTo(cur.lat,cur.lng,lat,lng);
    const p=dest(cur.lat,cur.lng,brg,TOWER2D_MAX_M);   // [lng,lat]
    tLng=p[0]; tLat=p[1];
  }
  unfollow();
  towerMode2D=true;
  towerPoint2D=[tLng,tLat];
  map.easeTo({center:towerPoint2D, zoom:14, duration:400});
}
// Pide altitud y rumbo antes de teletransportar a un punto cualquiera del mapa (no solo
// pistas de aeropuerto). Precarga los valores actuales del avión como punto de partida.
function showTeleportForm(el, lngLat){
  const curAlt = (lastState && lastState.alt!=null) ? Math.round(lastState.alt) : 5000;
  const curHdg = (lastState && lastState.heading!=null) ? Math.round(lastState.heading) : 0;
  el.innerHTML =
    '<div class="lp-form">'
    +'<label class="lp-lbl">Alt (ft)<input type="number" class="lp-input" id="lp-tp-alt" value="'+curAlt+'" step="100"></label>'
    +'<label class="lp-lbl">Rumbo (°)<input type="number" class="lp-input" id="lp-tp-hdg" value="'+curHdg+'" min="0" max="359" step="1"></label>'
    +'<button class="lp-btn lp-tp-go">Ir</button>'
    +'<button class="lp-btn lp-x">✕</button>'
    +'</div>';
  el.querySelector('.lp-tp-go').onclick=()=>{
    const alt=parseFloat(document.getElementById('lp-tp-alt').value);
    const hdg=parseFloat(document.getElementById('lp-tp-hdg').value);
    doTeleport(lngLat.lat, lngLat.lng, isNaN(alt)?null:alt, isNaN(hdg)?null:hdg, null, null, false, false);
    closePointMenu();
  };
  el.querySelector('.lp-x').onclick=closePointMenu;
}
function armLongPress(e){
  cancelLongPress();
  const at=e.lngLat;
  lpTimer=setTimeout(()=>{ lpTimer=null; showPointMenu(at); }, LONG_PRESS_MS);
}
map.on('mousedown', armLongPress);
map.on('touchstart', armLongPress);
// Solo cancelamos con acciones del usuario: el mapa se mueve solo al seguir al avión,
// así que NO podemos cancelar con 'move' o el menú nunca aparecería en vuelo.
map.on('mouseup', cancelLongPress);
map.on('touchend', cancelLongPress);
map.on('touchmove', cancelLongPress);
map.on('dragstart', cancelLongPress);
map.on('zoomstart', cancelLongPress);

// ---- Plan de vuelo armado en el mapa del mundo de MSFS (pre-partida) ----
// El backend lee CustomFlight.PLN. Si el juego trae un destino y vos todavía no
// pusiste una ruta propia, la app la adopta sola.
let msfsPlanKey=null, msfsPlanAuto=false;

// `manual` = lo pediste vos con el botón: entonces no se aplican los filtros de seguridad
// (querés ESE plan, aunque sea viejo) y se avisa si no hay nada que traer.
function checkMsfsPlan(manual){
  return fetch('/api/msfs_plan').then(r=>r.json()).then(p=>{
    if(!p.ok || p.dest_lat==null){
      if(manual) showToast('No encontré ningún plan de vuelo en MSFS');
      return false;
    }
    const key=p.departure+'>'+p.destination+'@'+p.mtime;
    if(!manual){
      if(key===msfsPlanKey) return false;             // este plan ya lo procesamos
      if(routeTarget && !msfsPlanAuto) return false;  // pusiste la tuya a mano: no la pisamos

      // MSFS deja este archivo intacto si arrancás un vuelo sin ruta, así que puede ser
      // de una partida vieja. Automáticamente solo lo tomamos si es reciente Y estás
      // parado en su aeropuerto de salida. Si no, es un fantasma y lo ignoramos.
      //
      // Ojo con esta condición: antes decía `if(p.dep_lat!=null && cur)`, así que cuando
      // todavía no había posición del avión (`cur` null, que es justo lo que pasa al
      // abrir la app) la comprobación se salteaba entera y adoptaba planes viejos. Por
      // eso se había terminado desactivando toda esta función. Ahora, sin posición,
      // esperamos: ya volverá a intentar en el próximo ciclo.
      if(!cur) return false;
      if(p.age_h!=null && p.age_h>6) return false;
      if(p.dep_lat!=null && haversineNM(cur.lat, cur.lng, p.dep_lat, p.dep_lon) > 30) return false;
    }
    msfsPlanKey=key;
    routeWaypoints.forEach(w=>w.marker.remove()); routeWaypoints=[];
    routeTarget={lat:p.dest_lat, lon:p.dest_lon, icao:p.destination, pista:null};
    msfsPlanAuto=!manual;
    cruceroPlan=p.cruise_alt||null;     // altura de crucero del plan: base del T/C y T/D

    // El plan trae los puntos intermedios: los metemos como puntos de ruta propios.
    // El backend los devuelve en `waypoints`, con el nombre en `id`.
    let metidos=0;
    (p.waypoints||[]).forEach(function(f){
      if(f.lat==null || f.lon==null) return;
      if(f.id===p.departure || f.id===p.destination) return;   // los extremos ya están
      if(addNamedWp(f.lat, f.lon, f.id||'PUNTO', true)) metidos++;
    });

    drawRoute();
    syncProgressButton();
    showToast('Plan de MSFS: '+p.departure+' → '+p.destination
      +(metidos?(' · '+metidos+' puntos'):' · sin puntos intermedios'));
    return true;
  }).catch(function(){
    if(manual) showToast('No pude leer el plan de MSFS');
    return false;
  });
}
// Se reintenta cada 20 s. Solo adopta el plan si estás parado en su aeropuerto de salida
// y el archivo es reciente (ver los filtros de arriba); si no, no toca nada.
setTimeout(()=>checkMsfsPlan(false),1500);
setInterval(()=>checkMsfsPlan(false),20000);

// Botón para traerlo a mano, sin esperar ni depender de los filtros de arriba
(function(){
  const b=document.getElementById('btn-msfsplan');
  if(!b) return;
  b.onclick=function(){
    b.classList.add('active');
    checkMsfsPlan(true).then(function(){ setTimeout(()=>b.classList.remove('active'),400); });
  };
})();

// Aviso de hora de llegada: aparece 10s al crear o modificar la ruta
let etaTimer=null;
function showToast(msg){
  const el=document.getElementById('eta-toast');
  document.getElementById('eta-text').textContent=msg;
  el.classList.remove('hidden');
  clearTimeout(etaTimer); etaTimer=setTimeout(()=>el.classList.add('hidden'),10000);
}

// Plan de vuelo del sim: dibuja el tramo activo y se va completando al secuenciar waypoints
let fplanPts=[];
function updateFPlan(s){
  const src=map.getSource('fplan'); if(!src) return;
  const fp=s.fplan;
  if(!fp || !fp.next){ src.setData({type:'FeatureCollection',features:[]}); fplanPts=[]; return; }
  const key=fp.next[0].toFixed(4)+','+fp.next[1].toFixed(4);
  if(!fplanPts.length || fplanPts[fplanPts.length-1].k!==key) fplanPts.push({k:key,lat:fp.next[0],lon:fp.next[1]});
  if(fplanPts.length>60) fplanPts.shift();
  const coords=[];
  if(fp.prev) coords.push([fp.prev[1],fp.prev[0]]);
  fplanPts.forEach(p=>coords.push([p.lon,p.lat]));
  const feats=[];
  if(coords.length>1) feats.push({type:'Feature',geometry:{type:'LineString',coordinates:coords}});
  feats.push({type:'Feature',geometry:{type:'Point',coordinates:[fp.next[1],fp.next[0]]}});
  src.setData({type:'FeatureCollection',features:feats});
}

// Agregar un punto intermedio tocando el mapa (con una ruta activa).
// name  = etiqueta del VOR cuando el punto viene del generador de rutas
// append= respetar el orden dado en vez de reordenar por menor desvío
function addWaypoint(lng,lat,name,append){
  if(!cur||!routeTarget) return;
  const id=++wpId; const el=document.createElement('div'); el.className='wp-mk';
  // Sin etiqueta en el DOM: el nombre lo dibuja el motor del mapa (capa planroute-wp),
  // que sí respeta la inclinación en vista 3D.
  el.innerHTML='<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="'
    +(name?'#0ea5e9':'#a855f7')+'" stroke="#fff" stroke-width="2.5"/></svg>';
  // Cuando el punto viene del generador de rutas (name truthy) cae EXACTO sobre el VOR:
  // los dos marcadores quedan pixel a pixel encima uno del otro y es una lotería cuál
  // recibe el click. Lo corremos unos px para que ambos queden clickeables por separado.
  const m=new mapboxgl.Marker({element:el,anchor:'center',offset:name?[9,-9]:[0,0]}).setLngLat([lng,lat])
    .setPopup(popup('<b>'+(name||'Punto de ruta')+'</b>'+(name?'<br><span class="pp-sub">VOR de la ruta generada</span>':'')
      +'<div class="pp-actions"><button class="pp-btn-remove" onclick="removeWaypoint('+id+')">Quitar punto</button></div>')).addTo(map);
  const wp={id:id,lat:lat,lon:lng,marker:m,name:name||null};
  if(append){ routeWaypoints.push(wp); return wp; }   // orden ya calculado por el backend
  // Insertar donde MENOS desvía la ruta, para que quede ordenada (sin zigzag), sin importar
  // el orden en que se toquen los puntos. Recorro cada tramo y elijo el de menor detour.
  const path=[{lat:cur.lat,lon:cur.lng}].concat(routeWaypoints, [{lat:routeTarget.lat,lon:routeTarget.lon}]);
  let best=0, bestCost=Infinity;
  for(let i=0;i<path.length-1;i++){ const a=path[i], b=path[i+1];
    const cost=haversineNM(a.lat,a.lon,lat,lng)+haversineNM(lat,lng,b.lat,b.lon)-haversineNM(a.lat,a.lon,b.lat,b.lon);
    if(cost<bestCost){ bestCost=cost; best=i; } }
  routeWaypoints.splice(best,0,wp);
  drawRoute();
}
// ---- Generador de rutas por VOR (backend: A* sobre las radioayudas reales) ----
// Aplica una ruta ya calculada (lista de puntos con nombre) hacia un destino
function aplicarRuta(icao, lat, lon, pts){
  clearRoute();
  routeTarget={lat:lat, lon:lon, icao:icao};
  msfsPlanAuto=false; cruceroPlan=null;
  (pts||[]).forEach(w=>addWaypoint(w.lon, w.lat, w.id, true));
  drawRoute();
}
function cerrarOpciones(){ document.getElementById('opts-modal').classList.add('hidden'); }
document.getElementById('opts-close').onclick=cerrarOpciones;
document.getElementById('opts-modal').addEventListener('click',e=>{ if(e.target.id==='opts-modal') cerrarOpciones(); });

// Muestra el menú de rutas alternativas y deja elegir
function mostrarOpciones(icao, lat, lon, opciones){
  const body=document.getElementById('opts-body');
  document.getElementById('opts-title').textContent='Rutas a '+icao;
  body.innerHTML='';
  opciones.forEach((o,i)=>{
    const el=document.createElement('div'); el.className='opt-item';
    const vias=(o.airways&&o.airways.length)?o.airways.join(' · '):'Directo';
    const pts=(o.waypoints||[]).map(w=>w.id).join(' → ')||'sin puntos intermedios';
    el.innerHTML='<span class="opt-main"><span class="opt-awy">'+vias+'</span>'
      +'<span class="opt-pts">'+pts+'</span></span>'
      +'<span class="opt-nums">'+nf(km(o.distance_nm))+' km<span>'+Math.round(o.distance_nm)+' NM</span>'
      +'<span>'+(o.detour_pct>0?('+'+Math.round(o.detour_pct)+'%'):'directo')+'</span></span>';
    el.onclick=()=>{ aplicarRuta(icao, lat, lon, o.waypoints); cerrarOpciones();
      showToast('Ruta por '+vias+' · '+fmtDist(o.distance_nm)); };
    body.appendChild(el);
  });
  document.getElementById('opts-modal').classList.remove('hidden');
}

window.genRoute=function(btn,lat,lon,icao){
  if(!cur){ showToast('Esperando posición del avión'); return; }
  if(btn){ btn.textContent='Buscando…'; btn.disabled=true; }
  const restaurar=()=>{ if(btn){ btn.textContent='Generar ruta'; btn.disabled=false; } };
  const q='lat='+cur.lat+'&lon='+cur.lng+'&dlat='+lat+'&dlon='+lon;
  // Primero probamos por aerovías reales; si no hay red o no encuentra, caemos al
  // encadenado de VOR, que siempre funciona.
  fetch('/api/genroute_awy?'+q).then(r=>r.json()).then(d=>{
    if(d.ok && d.options && d.options.length){
      restaurar();
      if(d.options.length===1){
        const o=d.options[0];
        aplicarRuta(icao, lat, lon, o.waypoints);
        showToast('Ruta por '+(o.airways.join(' · ')||'directo')+' · '+fmtDist(o.distance_nm));
      } else {
        mostrarOpciones(icao, lat, lon, d.options);
      }
      return;
    }
    return fetch('/api/genroute?'+q).then(r=>r.json()).then(v=>{
      restaurar();
      if(!v.ok){ showToast('No encontré ruta hasta '+icao); return; }
      aplicarRuta(icao, lat, lon, v.waypoints);
      const via=(v.waypoints||[]).map(w=>w.id).join(' → ')||'directo';
      showToast('Ruta por radioayudas · '+Math.round(v.distance_nm)+' NM · '+via);
    });
  }).catch(()=>{ restaurar(); showToast('Error al generar la ruta'); });
};
// Agregar un VOR o un aeropuerto a la ruta CON SU NOMBRE. Es la diferencia entre un punto
// suelto (que el MCDU no reconoce) y una referencia real que sí entra al plan de vuelo.
// `callado` evita el aviso: se usa al importar un plan entero, donde un toast por punto
// sería insoportable (se avisa una sola vez, al final, con el total).
window.addNamedWp=function(lat,lon,ident,callado){
  if(!routeTarget){ if(!callado) showToast('Primero elegí un destino con "Ruta directa"'); return false; }
  if(routeWaypoints.some(w=>w.name===ident)){ if(!callado) showToast(ident+' ya está en la ruta'); return false; }
  addWaypoint(lon, lat, ident);
  if(!callado) showToast(ident+' agregado a la ruta');
  return true;
};
window.removeWaypoint=function(id){ const i=routeWaypoints.findIndex(w=>w.id===id); if(i>=0){ routeWaypoints[i].marker.remove(); routeWaypoints.splice(i,1); drawRoute(); } };
// Tocar "Ruta directa" fija la ruta; tocar de nuevo la quita. Actualiza el botón del popup.
// Si el aeropuerto tiene pistas conocidas, primero pregunta a cuál querés ir: apuntar al
// centro del aeropuerto (que suele caer sobre la torre) dejaba la ruta corta y descentrada
// respecto de donde en realidad se toca tierra.
window.planRoute=function(btn,lat,lon,icao){
  // Igual que en rebuildAptActions: si el destino ya está puesto pero SIN pista (por
  // ejemplo, un plan de MSFS que la app adoptó sola), tocar "Ruta directa" tiene que
  // abrir el menú de pistas para poder elegirla — no borrar la ruta que recién llegó.
  const active = routeTarget && routeTarget.icao===icao && routeTarget.pista;
  if(active){
    clearRoute();
    if(btn){ btn.textContent='Ruta directa'; btn.classList.remove('pp-btn-remove'); }
    return;
  }
  // Siempre se abre el menú: si las pistas no están cargadas, pistaMenu() las pide al
  // backend. Antes esto dependía de tener el aeropuerto ya en memoria y por eso muchas
  // veces se saltaba el menú y la ruta iba directo al centro del aeropuerto.
  if(btn){ pistaMenu(btn,icao,lat,lon); return; }
  fijarDestino(lat,lon,icao,null);
};

// Deja el destino puesto. `pista` es opcional y solo sirve para mostrarlo en pantalla.
// `hdg` es el rumbo de esa pista (solo cuando `pista` viene de irAPista): lo guardamos
// para poder trazar el eje extendido del toggle "Grids".
function fijarDestino(lat,lon,icao,pista,hdg){
  routeTarget={lat:lat, lon:lon, icao:icao, pista:pista||null, hdg:(hdg==null?null:hdg)};
  msfsPlanAuto=false; cruceroPlan=null;
  drawRoute();
  updateGrids();
}

// Aeropuertos cuyas pistas tuvimos que pedirle al backend, para no repetir el pedido
let pistasCache={};

// Menú de pistas: cada pista da dos opciones (una por cabecera), porque no es lo mismo
// aterrizar por 09 que por 27 — son extremos opuestos del asfalto.
window.pistaMenu=function(btn,icao,lat,lon){
  const caja=btn.parentNode;
  const pintar=function(pistas){
    let html='';
    (pistas||[]).forEach(function(r,ri){
      const nm=(r.name||'/').split('/');
      html+="<button class=\"pp-btn-route\" onclick=\"irAPista('"+icao+"',"+ri+",0)\">Pista "+(nm[0]||'?')+"</button>";
      html+="<button class=\"pp-btn-route\" onclick=\"irAPista('"+icao+"',"+ri+",1)\">Pista "+(nm[1]||'?')+"</button>";
    });
    html+="<button class=\"pp-btn-wp\" onclick=\"irAlCentro('"+icao+"',"+lat+","+lon+")\">Centro del aeropuerto</button>";
    caja.innerHTML=html;
  };
  const local=pistasDe(icao);
  if(local.length){ pintar(local); return; }
  // Sin datos cargados: se los pedimos al backend, que tiene la base completa
  caja.innerHTML='<span class="pp-sub">Buscando pistas…</span>';
  fetch('/api/airport?icao='+encodeURIComponent(icao)).then(r=>r.json())
    .then(function(a){
      if(a && a.runways && a.runways.length){ pistasCache[icao]=a.runways; pintar(a.runways); }
      else pintar([]);            // sin datos de pista: queda solo "centro del aeropuerto"
    })
    .catch(function(){ pintar([]); });
};

// Las pistas de un aeropuerto, vengan de donde vengan
function pistasDe(icao){
  if(pistasCache[icao]) return pistasCache[icao];
  const a=findApt(icao);
  return (a && a.runways) ? a.runways : [];
}

window.irAlCentro=function(icao,lat,lon){
  fijarDestino(lat,lon,icao,null);
  showToast('Ruta a '+icao+' · centro del aeropuerto');
};

// El destino queda en la CABECERA por la que vas a entrar (el umbral), que es donde se
// toca tierra, y centrado a lo ancho de la pista.
window.irAPista=function(icao,ri,end){
  const pistas=pistasDe(icao);
  if(!pistas[ri]){ showToast('No tengo los datos de esa pista'); return; }
  const r=pistas[ri];
  const nm=(r.name||'/').split('/');
  const etiqueta=(end===0?nm[0]:nm[1])||'?';
  const hdg = end===0 ? r.hdg : (r.hdg+180)%360;
  // dest() devuelve [lng,lat]; retrocediendo media pista desde el centro se llega al umbral
  const thr = dest(r.center[0], r.center[1], (hdg+180)%360, r.len_m/2);
  fijarDestino(thr[1], thr[0], icao, etiqueta, hdg);
  showToast('Ruta a '+icao+' · pista '+etiqueta+' · rumbo '+Math.round(hdg)+'°');
};
window.clearRoute=function(){ routeTarget=null; routeWaypoints.forEach(w=>w.marker.remove()); routeWaypoints=[];
  if(map.getSource('planroute')) map.getSource('planroute').setData({type:'FeatureCollection',features:[]});
  originApt=null; originRefKey=null; msfsPlanAuto=false; cruceroPlan=null;
  // Bloquea el botón y esconde lo del progreso; la próxima ruta se vuelve a ver sola
  progressUserOn=true; syncProgressButton();
  if(typeof closePointMenu==='function') closePointMenu();
  setAddWp(false); updateGrids(); };
// Modo "agregar punto de ruta": se prende desde el engranaje. Mientras dura, el engranaje
// y su botón quedan morados, y el botón dice "Terminar puntos".
function setAddWp(on){ addWpMode=on;
  const b=document.getElementById('btn-agregar-puntos'), g=document.getElementById('btn-ajustes');
  if(b){ b.classList.toggle('morado',on); b.querySelector('span').textContent=on?'Terminar puntos':'Añadir puntos'; }
  if(g) g.classList.toggle('agregando',on); }
function doTeleport(lat,lon,alt,hdg,spd,gear,waitGear,eng0){
  let q='/api/teleport?lat='+lat+'&lon='+lon;
  if(alt!=null && !isNaN(alt)) q+='&alt='+alt;
  const h=parseFloat(hdg); if(!isNaN(h)) q+='&hdg='+h;
  if(spd!=null && !isNaN(spd)) q+='&spd='+spd;
  if(gear!=null) q+='&gear='+(gear?1:0);
  if(waitGear) q+='&wg=1';
  if(eng0) q+='&eng0=1';
  fetch(q,{method:'POST'}).then(r=>r.json()).then(d=>{ if(!d.ok) alert('No se pudo teletransportar (beta). ¿MSFS está conectado?'); }).catch(()=>alert('Error al teletransportar.'));
}
// Espera visual a que baje el tren (contador %), luego dispara el teleporte
function startGearWait(go){
  const ov=document.getElementById('gear-wait'), pctEl=document.getElementById('gw-pct');
  ov.classList.remove('hidden'); pctEl.textContent='0%'; const t0=Date.now();
  const iv=setInterval(()=>{
    const p=(lastState&&lastState.gear_pct!=null)?lastState.gear_pct:0;
    pctEl.textContent=Math.round(p*100)+'%';
    if(p>=0.99 || Date.now()-t0>18000){    // tren abajo (o tope de 18s)
      clearInterval(iv);
      setTimeout(()=>{ ov.classList.add('hidden'); go(); }, 1000);   // 1s extra de margen
    }
  }, 300);
}
// Control de hora del sim (beta) — el clima real por ahora se sigue ajustando desde MSFS.
// Se trabaja en la HORA LOCAL de donde está el avión (en Colombia, UTC−5), que es la que
// importa para saber si es de día o de noche. El sim solo deja cambiar la hora Zulu, así
// que se convierte. Antes el cuadro mostraba la hora local pero la mandaba como Zulu: en
// Colombia quedaba corrida 5 horas.
// El huso sale del propio sim (hora local − hora Zulu), así que respeta los husos reales
// (España va en UTC+1 aunque esté al oeste de Greenwich) sin que la app tenga que saberlos.
function husoSimSeg(){
  const s=lastState||{};
  if(s.local_time==null || s.zulu_time==null) return null;
  let d=Math.round((s.local_time-s.zulu_time)/900)*900;      // los husos van de a 15 min
  if(d>14*3600) d-=86400;
  if(d<-12*3600) d+=86400;
  return d;
}
function fmtHuso(seg){
  if(!seg) return 'UTC';
  const h=Math.floor(Math.abs(seg)/3600), m=Math.round(Math.abs(seg)%3600/60);
  return 'UTC'+(seg<0?'−':'+')+h+(m?':'+String(m).padStart(2,'0'):'');
}
(function(){
  const modal=document.getElementById('time-modal');
  const btn=document.getElementById('btn-time');
  if(!modal||!btn) return;
  btn.onclick=()=>{
    const huso=husoSimSeg();
    const s=lastState||{};
    const base = huso!=null ? s.local_time : s.zulu_time;     // sin huso conocido, en Zulu
    if(base!=null){
      const secs=Math.round(base);
      document.getElementById('tm-h').value=Math.floor(secs/3600)%24;
      document.getElementById('tm-m').value=Math.floor((secs%3600)/60);
    }
    txt('tm-title', huso!=null ? 'Hora local del avión ('+fmtHuso(huso)+')' : 'Hora del simulador (Zulu/UTC)');
    modal.classList.remove('hidden');
  };
  document.getElementById('tm-cancel').onclick=()=>modal.classList.add('hidden');
  document.getElementById('tm-apply').onclick=()=>{
    let h=parseInt(document.getElementById('tm-h').value,10);
    let m=parseInt(document.getElementById('tm-m').value,10);
    if(isNaN(h)||isNaN(m)) return;
    const huso=husoSimSeg();
    if(huso!=null){                                   // local → Zulu
      const z=(((h*3600+m*60-huso)%86400)+86400)%86400;
      h=Math.floor(z/3600); m=Math.floor((z%3600)/60);
    }
    fetch('/api/set_time?h='+h+'&m='+m,{method:'POST'}).then(r=>r.json()).then(d=>{
      if(!d.ok) alert('No se pudo cambiar la hora (beta). ¿MSFS está conectado?');
      modal.classList.add('hidden');
    }).catch(()=>alert('Error al cambiar la hora.'));
  };
})();
// Busca un aeropuerto por ICAO en TODAS las listas cargadas, no solo en las de alrededor
// del avión: el destino de una ruta casi siempre viene de `destAirports` o `viewAirports`,
// y al mirar solo `navAirports` esta función devolvía null justo cuando más se la necesita
// (por eso el menú de pistas no aparecía al poner ruta directa a un aeropuerto lejano).
// El try es por precaución: allAirports() se define más abajo en el archivo.
function findApt(icao){
  try{ const a=allAirports().find(x=>x.icao===icao); if(a) return a; }catch(e){}
  try{ const a=navAirports.find(x=>x.icao===icao); if(a) return a; }catch(e){}
  return (searchAirport&&searchAirport.icao===icao)?searchAirport:null;
}
// Teletransportarme => elegir Aproximación / Despegue
window.tpMenu=function(btn,icao){
  btn.parentNode.innerHTML="<button class=\"pp-btn-tp\" onclick=\"tpRunwayMenu(this,'"+icao+"','approach')\">Aproximación</button>"
    +"<button class=\"pp-btn-tp\" onclick=\"tpRunwayMenu(this,'"+icao+"','takeoff')\">Despegue</button>";
};
// Elegir la dirección/pista (las 2 cabeceras de cada pista)
window.tpRunwayMenu=function(btn,icao,mode){
  const a=findApt(icao); let html='';
  if(a&&a.runways&&a.runways.length){
    a.runways.forEach((r,ri)=>{ const nm=(r.name||'/').split('/');
      html+="<button class=\"pp-btn-tp\" onclick=\"tpGo('"+icao+"','"+mode+"',"+ri+",0)\">Pista "+(nm[0]||'?')+"</button>";
      html+="<button class=\"pp-btn-tp\" onclick=\"tpGo('"+icao+"','"+mode+"',"+ri+",1)\">Pista "+(nm[1]||'?')+"</button>"; });
  } else { html='<span class="pp-sub">Sin datos de pista</span>'; }
  btn.parentNode.innerHTML=html;
};
window.tpGo=function(icao,mode,ri,end){
  const a=findApt(icao); if(!a||!a.runways||!a.runways[ri]) return;
  const r=a.runways[ri], elev=parseFloat(a.elev_ft);
  const hdg = end===0 ? r.hdg : (r.hdg+180)%360;
  const thr = dest(r.center[0], r.center[1], (hdg+180)%360, r.len_m/2);   // cabecera de salida [lng,lat]
  if(mode==='takeoff'){
    const alt=isNaN(elev)?null:elev+20;
    const go=()=>doTeleport(thr[1],thr[0],alt,hdg,0,true,false,true);   // vel 0, tren abajo, motores a 0
    const gearDown = lastState && lastState.gear_pct!=null && lastState.gear_pct>=0.99;
    if(gearDown){ go(); }                                 // tren ya abajo => instantáneo
    else { fetch('/api/gear',{method:'POST'}); startGearWait(go); }   // bajar tren, contador, luego tp
  } else {
    const alt=isNaN(elev)?null:elev+1800;
    const p=dest(thr[1],thr[0],(hdg+180)%360,5*1852);    // 5 NM en final (aterrizaje instantáneo)
    doTeleport(p[1],p[0],alt,hdg,140,true);
  }
};

// ---- Sim Rate (velocidad de simulación) ----
document.getElementById('sr-minus').onclick=(e)=>{ e.stopPropagation(); cmd('SIM_RATE_DECR'); };
document.getElementById('sr-plus').onclick=(e)=>{ e.stopPropagation(); cmd('SIM_RATE_INCR'); };

function bindToggle(el,key,onchange){ el.addEventListener('click',()=>{ const on=!el.classList.contains('on'); el.classList.toggle('on',on); flags[key]=on; onchange(on); }); }
function aptCenter(){ return cur || (navRef?{lng:navRef[1],lat:navRef[0]}:null); }
// Aeropuertos y VOR quedaron fijos en "siempre visibles" (flags.apt/vor ya nacen en true
// y nada los apaga); este toggle era el que los prendía/apagaba, ahora lo ocupa Grids.
bindToggle(document.getElementById('tg-grids'),'grids',()=>updateGrids());
// (Acá estaba el interruptor "Terreno 3D" (Cesium): se sacó con la migración a Mapbox,
// 2026-11-22. Nunca se usaba.)
function changeRadius(d){ aptRadius=Math.max(20,Math.min(200,aptRadius+d)); document.getElementById('rad-val').textContent=aptRadius+' NM · '+km(aptRadius)+' km'; renderNav(aptCenter()); }
document.getElementById('rad-minus').onclick=()=>changeRadius(-20);
document.getElementById('rad-plus').onclick=()=>changeRadius(20);

function txt(id,v){ const e=document.getElementById(id); if(e) e.textContent=v; }

// ---- La ruta sobrevive a una recarga de la página ----
// Safari del iPad descarta las pestañas que quedan en segundo plano y al volver recarga
// la página: la ruta que habías armado (destino, pista, puntos) se perdía, aunque el rastro
// volado sí volvía (ese lo guarda el backend). Ahora se guarda en el navegador cada vez que
// cambia y se recupera al volver a tener posición del avión. Vence a las 14 h para no
// resucitar la ruta de ayer.
const RUTA_KEY='rutaActiva', RUTA_VIGENCIA_MS=14*3600e3;
let rutaFirma=null;
function guardarRuta(){
  try{
    if(!routeTarget){
      if(rutaFirma!==''){ localStorage.removeItem(RUTA_KEY); rutaFirma=''; }
      return;
    }
    const wps=routeWaypoints.map(w=>({lat:w.lat, lon:w.lon, name:w.name||null}));
    const firma=JSON.stringify([routeTarget, wps, cruceroPlan, msfsPlanAuto, progressUserOn]);
    if(firma===rutaFirma) return;
    rutaFirma=firma;
    localStorage.setItem(RUTA_KEY, JSON.stringify({t:Date.now(), target:routeTarget, wps:wps,
      crucero:cruceroPlan, auto:msfsPlanAuto, planKey:msfsPlanKey, progreso2:progressUserOn}));
  }catch(e){}
}
function restaurarRuta(){
  let d=null;
  try{ d=JSON.parse(localStorage.getItem(RUTA_KEY)||'null'); }catch(e){}
  if(!d || !d.target) return;
  if(routeTarget) return;                    // ya hay otra (por ejemplo, el plan de MSFS)
  if(!(Date.now()-d.t < RUTA_VIGENCIA_MS)){ try{ localStorage.removeItem(RUTA_KEY); }catch(e){} return; }
  routeTarget=d.target;
  cruceroPlan=d.crucero||null; msfsPlanAuto=!!d.auto; msfsPlanKey=d.planKey||null;
  (d.wps||[]).forEach(w=>addWaypoint(w.lon, w.lat, w.name||null, true));
  // "progreso2": con el dock el progreso arranca visible. Lo guardado antes con la clave
  // vieja ("progreso") casi siempre era false porque el panel arrancaba cerrado: se ignora.
  progressUserOn = d.progreso2!==undefined ? !!d.progreso2 : true;
  drawRoute(); updateGrids();
  const n=(d.wps||[]).length;
  showToast('Ruta recuperada: '+routeTarget.icao+(n?(' · '+n+' puntos'):''));
}
// addWaypoint necesita la posición del avión, así que se espera a tenerla.
const esperaRutaGuardada=setInterval(()=>{
  if(!cur) return;
  clearInterval(esperaRutaGuardada);
  restaurarRuta();
  setInterval(guardarRuta, 2000);            // recién ahora: antes borraría la guardada
}, 500);
