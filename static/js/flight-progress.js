/* flight-progress.js — Progreso del vuelo: ETA, barra estilo FR24, guia y tabla de descenso, proximo punto.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Tiempo estimado, incluso con el avión parado ----
// Si todavía no despegaste no hay velocidad real, así que suponemos la de crucero
// típica según el tipo de motor que reporta el simulador.
const CRUISE_KT={1:450, 5:280, 3:110};      // 1=jet, 5=turbohélice, 3=helicóptero
const CRUISE_KT_DEFAULT=130;                 // pistón o desconocido
const CLIMB_DESC_MIN=15;                     // despegue y aterrizaje son mucho más lentos
function assumedKt(){ const t=(lastState||{}).eng_type; return CRUISE_KT[t]||CRUISE_KT_DEFAULT; }
function isRealSpeed(){ return !!(lastGs && lastGs>=40); }
function etaMinutes(nm){
  return isRealSpeed() ? (nm/lastGs*60) : (nm/assumedKt()*60 + CLIMB_DESC_MIN);
}
function fmtHm(min){ const h=Math.floor(min/60), m=Math.round(min%60);
  return (h>0? h+'h '+m+'m' : m+'m'); }
function routeEta(nm){ const min=etaMinutes(nm), hh=Math.floor(min/60), mm=Math.round(min%60);
  return (isRealSpeed()?'':'~')+String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0'); }
// Rumbo inicial (great circle) de un punto a otro, en grados verdaderos 0-359
function bearingTo(la1,lo1,la2,lo2){
  const p1=la1*Math.PI/180, p2=la2*Math.PI/180, dl=(lo2-lo1)*Math.PI/180;
  const y=Math.sin(dl)*Math.cos(p2);
  const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
const CARDINALS=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'];
function cardinal(deg){ return CARDINALS[Math.round(((deg%360)+360)%360/22.5)%16]; }
// Los rumbos calculados con coordenadas son VERDADEROS, pero la brújula del avión es
// MAGNÉTICA. En Colombia hay unos 7 grados de diferencia: por eso seguías el rumbo que
// decía la app y terminabas al costado del punto. Acá lo convertimos.
function toMag(deg){
  const mv=(lastState||{}).magvar;
  return ((deg - (mv||0)) % 360 + 360) % 360;
}
function fmtBrg(deg){ const m=toMag(deg);
  return String(Math.round(m)%360).padStart(3,'0')+'° '+cardinal(m); }
// Parte un tramo largo en pedacitos. Un segmento de cientos de millas se dibuja mal al
// alejar el zoom (la línea punteada llega a desaparecer), y además en un mapa plano una
// recta no es el camino real: densificando sigue el arco correcto y se ve siempre.
function densify(a, b, maxNm){
  const nm=haversineNM(a[1],a[0],b[1],b[0]);
  if(nm<=maxNm) return [b];
  const n=Math.min(64, Math.ceil(nm/maxNm)), out=[];
  for(let i=1;i<=n;i++){ const t=i/n;
    out.push([a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]); }
  return out;
}
function drawRoute(){ if(!routeTarget) return;
  limpiarPuntosPasados();       // los puntos ya sobrevolados se sacan antes de dibujar
  // Si todavía no hay avión (por ejemplo al pegar una ruta con el sim cerrado), la ruta
  // igual se dibuja: arranca en su primer punto en vez de en el avión.
  const inicio = cur ? [cur.lng,cur.lat]
                     : (routeWaypoints.length ? [routeWaypoints[0].lon, routeWaypoints[0].lat]
                                              : [routeTarget.lon, routeTarget.lat]);
  const nodos=[inicio];
  routeWaypoints.forEach(w=>nodos.push([w.lon,w.lat]));   // puntos intermedios en orden
  nodos.push([routeTarget.lon,routeTarget.lat]);

  let nm=0; for(let i=0;i<nodos.length-1;i++){ nm+=haversineNM(nodos[i][1],nodos[i][0],nodos[i+1][1],nodos[i+1][0]); }
  // Rumbo al PRÓXIMO punto (no al destino final): es el que hay que volar ahora a mano
  const nx=nodos[1] || nodos[0];
  const brg=bearingTo(inicio[1],inicio[0],nx[1],nx[0]);

  const coords=[nodos[0]];
  for(let i=0;i<nodos.length-1;i++) densify(nodos[i],nodos[i+1],40).forEach(p=>coords.push(p));

  const feats=[
    {type:'Feature',properties:{label:fmtDist(nm)+' | '+routeEta(nm)+' | '+fmtBrg(brg)},geometry:{type:'LineString',coordinates:coords}},
    {type:'Feature',geometry:{type:'Point',coordinates:[routeTarget.lon,routeTarget.lat]}}];
  routeWaypoints.forEach(w=>{ if(w.name) feats.push(
    {type:'Feature',properties:{ident:w.name},geometry:{type:'Point',coordinates:[w.lon,w.lat]}}); });
  map.getSource('planroute').setData({type:'FeatureCollection',features:feats});
  // El chip ya no repite destino/NM/rumbo: eso lo cuenta mejor el panel de progreso.
  // Acá quedan solo las dos acciones.
  document.getElementById('route-chip').style.display='flex';
  updateProgress(nm, brg);
}
// ---- Barra de progreso del vuelo (estilo Flightradar24) ----
// El origen se deduce del aeropuerto más cercano al primer punto de la ruta volada.
let originApt=null, originRefKey=null;
function findOriginAirport(){
  const r=(lastState&&lastState.route)||[];
  if(!r.length || !navAirports.length) return null;
  const key=r[0][0].toFixed(3)+','+r[0][1].toFixed(3);
  if(originRefKey===key && originApt) return originApt;   // cacheado: no recalcular cada tick
  let best=null,bestD=Infinity;
  navAirports.forEach(a=>{ const d=haversineNM(r[0][0],r[0][1],a.lat,a.lon);
    if(d<bestD){ bestD=d; best=a; } });
  if(best && bestD<25){ originRefKey=key; originApt=best; return best; }
  return null;
}
// Coordenadas legibles para los puntos sueltos (los que no son aeropuertos)
function fmtCoord(lat,lon){
  return Math.abs(lat).toFixed(2)+'° '+(lat>=0?'N':'S')+'  '+Math.abs(lon).toFixed(2)+'° '+(lon>=0?'E':'O');
}
// Arranca cerrado a propósito: se abre solo si lo pedís desde la barra de herramientas
let progressUserOn=false;
// Nombre del aeropuerto de destino, pedido por ICAO a la base completa (una sola vez)
let destInfo=null, destInfoPending=null;
function ensureDestInfo(icao){
  if(!icao || icao==='PUNTO') return;
  if(destInfo && destInfo.icao===icao) return;
  if(destInfoPending===icao) return;
  destInfoPending=icao;
  fetch('/api/airport?icao='+encodeURIComponent(icao)).then(r=>r.json())
    .then(a=>{ if(a && a.icao) destInfo=a; destInfoPending=null; })
    .catch(()=>{ destInfoPending=null; });
}
function syncProgressButton(){
  const b=document.getElementById('btn-progress'), el=document.getElementById('progress-panel');
  if(!b||!el) return;
  const avail=!!routeTarget;
  b.classList.toggle('disabled',!avail);
  b.classList.toggle('active', avail && progressUserOn);
  b.title = avail ? 'Progreso del vuelo' : 'Progreso del vuelo (necesita una ruta)';
  const abierto = avail && progressUserOn;
  const cambio = el.classList.contains('hidden') === abierto;   // ¿cambió la visibilidad?
  el.classList.toggle('hidden', !abierto);
  // Con el panel abierto los dos costados quedan ocupados, así que el avión vuelve al
  // centro; al cerrarlo se corre otra vez a la derecha. Solo si no lo fijaste a mano.
  if(cambio) revisarCentrado();
}
function updateProgress(nmLeft, brg){
  const el=document.getElementById('progress-panel'); if(!el) return;
  syncProgressButton();
  if(!routeTarget || !progressUserOn) return;

  const org=findOriginAirport();
  const r=(lastState&&lastState.route)||[];
  if(org){
    document.getElementById('pg-from').textContent=org.icao;
    document.getElementById('pg-from-name').textContent=org.name||'';
  }else{
    // Despegaste lejos de cualquier aeropuerto: lo tratamos como punto suelto
    document.getElementById('pg-from').textContent='PUNTO';
    document.getElementById('pg-from-name').textContent = r.length?fmtCoord(r[0][0],r[0][1]):'Origen desconocido';
  }

  const isPoint = routeTarget.icao==='PUNTO';
  document.getElementById('pg-to').textContent = routeTarget.icao;
  let toName='';
  if(isPoint){ toName=fmtCoord(routeTarget.lat, routeTarget.lon); }
  else{
    toName=(searchAirport&&searchAirport.icao===routeTarget.icao?searchAirport.name:(findApt(routeTarget.icao)||{}).name)||'';
    // Un destino lejano (ej. KBOS desde Cartagena) no está en los datos cargados alrededor
    // del avión, así que lo pedimos por ICAO a la base completa del backend.
    if(!toName){ ensureDestInfo(routeTarget.icao); toName=(destInfo&&destInfo.icao===routeTarget.icao?destInfo.name:'')||''; }
    // Si elegiste pista, se avisa acá: el destino no es el centro del aeropuerto sino su umbral
    if(routeTarget.pista) toName = (toName?toName+' · ':'')+'pista '+routeTarget.pista;
  }
  document.getElementById('pg-to-name').textContent = toName;

  const done=(lastState&&lastState.distance_nm)||0;      // recorrido real, no en línea recta
  const total=done+nmLeft;
  const pct=total>0?Math.max(0,Math.min(100,done/total*100)):0;
  document.getElementById('pg-fill').style.width=pct+'%';
  document.getElementById('pg-done').innerHTML=fmtDistB(done);
  document.getElementById('pg-left').innerHTML=fmtDistB(nmLeft)+' · '+routeEta(nmLeft);
  document.getElementById('pg-brg').textContent=fmtBrg(brg);

  // Llegada estimada: con el avión quieto usa la velocidad típica del tipo de avión;
  // apenas superás los 40 nudos pasa sola al cálculo con tu velocidad real.
  const etaEl=document.getElementById('pg-eta'), min=etaMinutes(nmLeft);
  const est=!isRealSpeed();
  const h=horaLlegada(min);
  etaEl.textContent=(est?'~':'')+h.txt+'  ·  '+fmtHm(min);
  etaEl.style.color = est ? 'var(--text-dim)' : 'var(--text)';
  etaEl.title = (est ? ('Estimado suponiendo '+assumedKt()+' kt de crucero') : 'Calculado con tu velocidad real')
    + (h.sim ? ' · hora local del simulador' : ' · hora de tu computadora (el sim no la está dando)');
  updateNextLeg();
  updateVnav(nmLeft);
  updateVs(nmLeft);
  updateSpd(nmLeft);
  lastNmLeft=nmLeft;
  updateTablaDescenso(nmLeft);
  updateFaseIcono();
}
// Última distancia al destino conocida: la tabla de descenso se puede repintar sola
// (al cambiar de perfil) sin esperar a la próxima vuelta del panel.
let lastNmLeft=0;

// El avioncito del panel se inclina según lo que estés haciendo: subiendo, nivelado o
// bajando. El ícono apunta al norte, así que girándolo se lee como una trayectoria.
function updateFaseIcono(){
  const ic=document.getElementById('pg-badge-icon'), b=document.getElementById('pg-badge');
  if(!ic) return;
  const vs=(lastState||{}).vs;
  let ang=90, fase='Nivelado', col='rgba(251,191,36,0.9)', sombra='rgba(251,191,36,0.35)';  // 90° = mirando a la derecha
  if(vs!=null && vs>300){ ang=45;  fase='En ascenso';  col='rgba(74,222,128,0.9)';  sombra='rgba(74,222,128,0.35)'; }
  else if(vs!=null && vs<-300){ ang=135; fase='En descenso'; col='rgba(56,189,248,0.9)'; sombra='rgba(56,189,248,0.35)'; }
  ic.style.transform='rotate('+ang+'deg)';
  // El avioncito va oscuro sobre el círculo de color, así que lo que cambia es el fondo
  if(b){ b.style.background=col; b.style.boxShadow='0 6px 18px '+sombra;
    b.title=fase+(vs!=null?(' · '+(vs>=0?'+':'')+Math.round(vs)+' ft/min'):''); }
}

// ---- Guía de descenso (regla 3:1 de los pilotos) ----
// Por cada 1000 pies a perder hacen falta 3 millas náuticas. No hace falta planificar
// ninguna altitud de crucero: se usa la que tenés en este momento.
function destElevFt(){
  const a=(destInfo&&destInfo.icao===routeTarget.icao)?destInfo:(findApt(routeTarget.icao)||{});
  const e=parseFloat(a.elev_ft);
  return isNaN(e)?0:e;
}
// Antes estas tres filas se escondían cuando no aplicaban y el panel parecía romperse:
// abrías el progreso en tierra y no había ni descenso ni velocidad. Ahora la fila siempre
// está, y cuando no hay nada que decir muestra el motivo en gris.
function pgFila(rowId, elId, clave, valor, color){
  const row=document.getElementById(rowId), el=document.getElementById(elId);
  if(!row||!el) return;
  row.style.display='';
  const k=row.querySelector('.pg-k'); if(k) k.textContent=clave;
  el.textContent=valor;
  el.style.color=color||'var(--text)';
}
const PG_GRIS='var(--text-dim)';

// Hora de llegada. Va en la HORA DEL SIMULADOR, que es la que importa: si volás de noche
// en el sim a las 3 de la tarde de tu día real, saber que llegás "a las 15:40 tuyas" no
// sirve para nada. `local_time` viene del sim en segundos desde medianoche. Si el sim no
// la está dando, se cae a la hora de la PC y se avisa en el tooltip.
// El sim rate NO se toma en cuenta a propósito: las horas del simulador ya corren
// aceleradas junto con el vuelo, así que la cuenta cierra sola.
function horaLlegada(min){
  const s=lastState||{};
  if(s.local_time!=null){
    const seg=(s.local_time + min*60) % 86400;
    const hh=Math.floor(seg/3600), mm=Math.floor((seg%3600)/60);
    return { txt:String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0'), sim:true };
  }
  const d=new Date(Date.now()+min*60000);
  return { txt:d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), sim:false };
}

// ¿Toca ya el perfil de descenso? Se calcula con la regla 3:1 desde la altura actual, así
// que sirve igual para un crucero a 38.000 que para un salto corto a 9.000: en el vuelo
// corto la senda arranca mucho más cerca del destino, no a las 100 millas fijas.
// Los 10 NM de margen son para que los números aparezcan un poco antes de tener que bajar.
function enDescenso(nmLeft){
  const s=lastState||{};
  if(!routeTarget || routeTarget.icao==='PUNTO') return false;
  if(!nmLeft || nmLeft<=0 || s.alt==null || s.on_ground) return false;
  const perder=s.alt-(destElevFt()+1500);
  if(perder<300) return nmLeft<=25;            // ya venís bajo: igual sirve en la llegada
  return nmLeft <= (perder/1000*3)+10;
}

// Antes esta fila decía "Inicio del descenso: en X NM" mientras todavía estabas lejos,
// y recién mostraba una altura concreta cuando ya estabas cerca. En la práctica eso no
// se entendía y encima la altura saltaba de a 100 ft, cambiando todo el tiempo. Ahora
// siempre muestra la altura a la que "deberías" estar YA, a la distancia que sea —
// bien lejos te va a pedir una altura alta (normal, todavía no hay que bajar) y a
// medida que te acercás la cifra baja sola, sin cambiar de mensaje.
function updateVnav(nmLeft){
  const row=document.getElementById('pg-vnav-row'), el=document.getElementById('pg-vnav');
  const s=lastState||{};
  if(!routeTarget || routeTarget.icao==='PUNTO'){
    pgFila('pg-vnav-row','pg-vnav','Altura recomendada','poné un aeropuerto de destino',PG_GRIS); return; }
  if(s.alt==null){
    pgFila('pg-vnav-row','pg-vnav','Altura recomendada','—',PG_GRIS); return; }
  if(s.on_ground){
    pgFila('pg-vnav-row','pg-vnav','Altura recomendada','se calcula al despegar',PG_GRIS); return; }
  if(!nmLeft){
    pgFila('pg-vnav-row','pg-vnav','Altura recomendada','—',PG_GRIS); return; }
  row.style.display='';
  row.querySelector('.pg-k').textContent='Altura recomendada';

  const elev=destElevFt();
  const floor=elev+1500;                       // apuntamos a 1500 ft sobre el aeropuerto
  if(s.alt-floor<300){
    pgFila('pg-vnav-row','pg-vnav','Altura recomendada','ya venís a la altura de llegada',PG_GRIS); return; }

  // Misma cuenta que la tabla de descenso (300 ft por milla + elevación del aeropuerto),
  // así que la fila y la tabla nunca se contradicen. Redondeada de a 500 ft (no de a 100)
  // para que no esté bailando todo el tiempo con cada actualización de posición.
  const t=Math.round(altEnNm(nmLeft)/500)*500;
  const diff=s.alt-t;
  // Ir por encima del perfil sí importa (no llegás a bajar a tiempo). Ir por debajo no
  // es un problema, así que solo lo informamos cuando la diferencia es grande.
  if(diff>300){
    // Cuánto tenés que bajar para emparejarte con el perfil, repartido en lo que queda
    // de vuelo — la misma cuenta que la fila "Bajar a", puesta acá al lado para no
    // tener que mirar dos filas separadas y sacar la cuenta mental vos mismo.
    let extra='';
    if(lastGs && lastGs>=40){
      const min=nmLeft/lastGs*60;
      const fpm=Math.round((s.alt-floor)/Math.max(1,min)/50)*50;
      if(fpm>0) extra=' (−'+nf(fpm)+')';
    }
    el.textContent=nf(t)+' ft'+extra; el.style.color='#fb923c';
  }
  else if(diff<-1500){ el.textContent=nf(t)+' ft · vas '+nf(Math.round(-diff/100)*100)+' bajo'; el.style.color='var(--text-dim)'; }
  else { el.textContent=nf(t)+' ft · en la senda'; el.style.color='#4ade80'; }
}

// Régimen de descenso necesario: cuántos pies por minuto hacen falta para llegar a la
// altura de aterrizaje justo a tiempo, con la velocidad que llevás ahora.
function updateVs(nmLeft){
  const s=lastState||{};
  if(!routeTarget || routeTarget.icao==='PUNTO' || s.alt==null || !nmLeft){
    pgFila('pg-vs-row','pg-vs','Bajar a','—',PG_GRIS); return; }
  if(s.on_ground){ pgFila('pg-vs-row','pg-vs','Bajar a','se calcula al despegar',PG_GRIS); return; }
  if(!lastGs || lastGs<40){ pgFila('pg-vs-row','pg-vs','Bajar a','necesito velocidad real',PG_GRIS); return; }
  const perder=s.alt-(destElevFt()+1500);
  if(perder<300){ pgFila('pg-vs-row','pg-vs','Bajar a','no hace falta bajar',PG_GRIS); return; }
  const min=nmLeft/lastGs*60;                    // minutos que faltan al destino
  const fpm=Math.round(perder/Math.max(1,min)/50)*50;
  // Más de 2000 ft/min de bajada es incómodo: significa que vas tarde
  pgFila('pg-vs-row','pg-vs', fpm>2000?'Bajar a (vas tarde)':'Bajar a',
         '−'+nf(fpm)+' ft/min', fpm>2000?'#fb923c':(fpm>0?'#4ade80':PG_GRIS));
}

// Velocidad recomendada. En descenso manda el perfil del avión (la misma tabla que se
// abre manteniendo pulsada la fila); lejos del destino, la regla general de 250 kt bajo
// 10.000 pies, que es la que aplica siempre.
function updateSpd(nmLeft){
  const s=lastState||{};
  if(s.alt==null || s.ias==null){ pgFila('pg-spd-row','pg-spd','Velocidad','—',PG_GRIS); return; }
  if(s.on_ground){ pgFila('pg-spd-row','pg-spd','Velocidad','en tierra',PG_GRIS); return; }

  const nm=Math.round(nmLeft||0);
  if(enDescenso(nm)){
    const p=perfilActivo();
    if(nm<4){ pgFila('pg-spd-row','pg-spd','Velocidad en final','VAPP '+p.vapp+' kt','#7dd3fc'); return; }
    const flap=flapsEnNm(nm,p);
    if(flap){ pgFila('pg-spd-row','pg-spd','Configuración', flap+' · a '+nm+' NM','#fbbf24'); return; }
    // La velocidad es la de ESTA milla, la misma que muestra la fila de la tabla donde
    // estás parado ahora. Y como el próximo cambio importa tanto como el actual, se avisa
    // cuántas millas faltan para tener que frenar otra vez.
    const objetivo=velEnNm(p,nm);                     // ej. "280 kt"
    const kt=parseInt(objetivo,10);
    let color=PG_GRIS, extra='';
    if(!isNaN(kt)){
      const dif=s.ias-kt;
      if(dif>25){ color='#fb923c'; extra=' · '+Math.round(dif)+' de más'; }
      else if(Math.abs(dif)<=25){ color='#4ade80'; }
    }
    const sig=proximoCambio(p,nm);
    if(sig && !extra) extra=' · '+sig.texto+' en '+sig.nm+' NM';
    pgFila('pg-spd-row','pg-spd','Velocidad objetivo', objetivo+extra, color);
    return;
  }

  if(s.alt<10000){
    const exceso=s.ias-250;
    if(exceso>10) pgFila('pg-spd-row','pg-spd','Velocidad','máx 250 kt · '+Math.round(exceso)+' de más','#fb923c');
    else          pgFila('pg-spd-row','pg-spd','Velocidad','máx 250 kt bajo 10.000','#4ade80');
  } else {
    pgFila('pg-spd-row','pg-spd','Velocidad','libre sobre 10.000 ft',PG_GRIS);
  }
}

// ---- Tabla de descenso ----
// La regla es siempre la misma (3:1: 300 pies de altura por cada milla que falta), así
// que las altitudes se calculan, no se copian. Lo que sí cambia según el avión es la
// VELOCIDAD, y eso es lo que guardan estos perfiles: pares [desde cuántas NM, qué IAS].
// Se lee de arriba hacia abajo y vale el primero cuyo tramo ya empezaste.
const PERFILES={
  narrow:{ nombre:'A320 / narrowbody', vapp:'135-145',
    vel:[[100,'280 kt'],[40,'250 kt'],[20,'210 kt'],[15,'180-190 kt'],[10,'170 kt']] },
  wide:{ nombre:'A330 / widebody', vapp:'140-155',
    vel:[[100,'280 kt'],[35,'250 kt'],[25,'220 kt'],[20,'210 kt'],[15,'190-200 kt'],[10,'180 kt']] },
  heavy:{ nombre:'747 / heavy', vapp:'145-150',
    vel:[[90,'300 kt'],[80,'290 kt'],[60,'280 kt'],[40,'250 kt'],[30,'240 kt'],
         [25,'220 kt'],[20,'210 kt'],[15,'190 kt'],[12,'180 kt'],[10,'170 kt']],
    flaps:[[8,'Flaps iniciales'],[6,'Config. intermedia'],[4,'Config. final']] },
};
// La tabla se genera milla por milla, de 120 NM hasta 1: así, sea cual sea la distancia
// que falta, hay una fila exacta para leer en vez de tener que interpolar entre dos.
const TABLA_DESDE=120;
// Millas donde se saca cada escalón de flaps, de más lejos a más cerca. Es el valor por
// defecto; algunos perfiles (747) traen su propio texto en PERFILES[x].flaps.
const TABLA_FLAPS=[[8,'Flaps 1'],[6,'Flaps 2'],[4,'Flaps 3']];
// En qué configuración deberías estar a esa distancia: el último escalón que ya sacaste.
// A 7 NM seguís con Flaps 1 (los sacaste a 8), a 5 NM con Flaps 2, etc. Devuelve null
// mientras todavía estés limpio.
function flapsEnNm(nm,p){
  const tabla=(p&&p.flaps)||TABLA_FLAPS;
  let f=null;
  for(const [desde,txt] of tabla){ if(nm<=desde) f=txt; }
  return f;
}

let perfilElegido=null;      // null = lo deduce del avión cargado en el sim

// Adivina el perfil por el nombre del avión que reporta el simulador: primero busca el
// 747 específicamente (tiene su propia tabla), después si es ancho o angosto en general.
function perfilAuto(){
  const t=((lastState&&lastState.aircraft)||'').toLowerCase();
  if(!t) return 'narrow';
  if(/747|748/.test(t)) return 'heavy';
  const ancho=/a3[35]0|a340|a380|b?7[456]7|777|787|767|md-?11|dc-?10|widebody/.test(t);
  return ancho?'wide':'narrow';
}
function perfilActivo(){ return PERFILES[perfilElegido||perfilAuto()]||PERFILES.narrow; }

// Velocidad que toca a esa distancia, según el perfil. Más lejos que el primer tramo
// (100 NM) vale ese mismo: la tabla no cambia de velocidad por estar más lejos.
function velEnNm(p,nm){
  let v=p.vel[0][1];
  for(const [desde,kt] of p.vel){ if(nm<=desde) v=kt; }
  return v;
}
// Altura a la que deberías estar a esa distancia. Suma la elevación del aeropuerto: la
// tabla de manual asume nivel del mar y en un destino alto quedaría corta.
function altEnNm(nm){ return Math.round((nm*300+destElevFt())/100)*100; }

// La tabla de manual arranca en 100 NM / 30.000 ft porque asume un vuelo largo. En un
// salto corto que nunca pasó de 12.000 pies, esas primeras filas son ruido: piden bajar
// desde una altura a la que nunca estuviste. Así que se recortan las que quedan por
// encima del techo del vuelo, y siempre se deja al menos una fila arriba tuyo como
// referencia. Si todavía no hay dato de altitud, se muestra la tabla entera.
function techoVuelo(){
  const s=lastState||{};
  const a=Math.max(s.alt||0, s.max_alt||0);
  return a>0 ? a : null;
}
// Lista de millas a mostrar, de la más lejana a la más cercana. Se recorta por arriba
// según lo alto que hayas volado: en un salto que nunca pasó de 12.000 pies no tiene
// sentido empezar en 120 NM / 36.000 ft. Se deja 10 NM de margen por si venís alto.
function filasUtiles(){
  const techo=techoVuelo();
  let desde=TABLA_DESDE;
  if(techo){
    const porAltura=Math.ceil((techo-destElevFt())/300)+10;
    desde=Math.max(15, Math.min(TABLA_DESDE, porAltura));
  }
  const out=[];
  for(let d=desde; d>=1; d--) out.push(d);
  return out;
}
// Lo que toca hacer a esa distancia: mientras estés limpio manda la velocidad; una vez
// que empezás a sacar flaps, manda la configuración.
function accionEnNm(p,nm){ return flapsEnNm(nm,p) || velEnNm(p,nm); }

// En qué milla cambia esa acción y cuál es la siguiente. Sirve para avisar en el panel
// "280 kt · 250 kt en 2 NM" sin tener que abrir la tabla.
function proximoCambio(p,nm){
  const ahora=accionEnNm(p,nm);
  for(let d=Math.round(nm)-1; d>=1; d--){
    const a=accionEnNm(p,d);
    if(a!==ahora) return {nm:Math.round(nm)-d, texto:a};
  }
  return null;
}

function pintarPerfiles(){
  const cont=document.getElementById('pg-perfiles'); if(!cont) return;
  if(cont.dataset.listo) return;                 // los botones se arman una sola vez
  cont.dataset.listo='1';
  const opciones=[['','Auto'],['narrow','Narrow'],['wide','Wide'],['heavy','747']];
  cont.innerHTML=opciones.map(function(o){
    return '<button class="pg-perfil" data-p="'+o[0]+'">'+o[1]+'</button>';
  }).join('');
  cont.querySelectorAll('.pg-perfil').forEach(function(b){
    b.onclick=function(e){
      e.stopPropagation();
      perfilElegido=b.dataset.p||null;
      try{ localStorage.setItem('perfilDescenso', perfilElegido||''); }catch(err){}
      updateTablaDescenso(lastNmLeft);
    };
  });
}

function updateTablaDescenso(nmLeft){
  const caja=document.getElementById('tabla-modal'); if(!caja) return;
  if(caja.classList.contains('hidden')) return;   // cerrada: no gastamos en redibujar
  const s=lastState||{};
  pintarPerfiles();

  const p=perfilActivo();
  const auto=!perfilElegido;
  document.getElementById('pg-perfil-nom').textContent=p.nombre+(auto?' · auto':'');
  document.getElementById('pg-perfiles').querySelectorAll('.pg-perfil').forEach(function(b){
    b.classList.toggle('on',(b.dataset.p||null)===perfilElegido);
  });

  // Hay una fila por milla, así que la activa es exactamente la milla que falta.
  const nm=Math.round(nmLeft||0);
  const filas=filasUtiles();
  const activa=filas.indexOf(nm);

  // Redibujar 120 filas en cada vuelta rompería el scroll mientras la mirás, así que el
  // HTML solo se rehace cuando cambia algo estructural (perfil, cantidad de filas o
  // elevación del destino). El resto del tiempo solo se mueve el resaltado.
  const body=document.getElementById('pg-tabla-body');
  const firma=p.nombre+'|'+filas.length+'|'+filas[0]+'|'+destElevFt();
  if(body.dataset.firma!==firma){
    body.dataset.firma=firma;
    body.innerHTML=filas.map(function(d){
      const flap=flapsEnNm(d,p);
      const vel=flap?('<span class="fflap">'+flap+'</span>'):velEnNm(p,d);
      // Marcamos las millas donde cambia lo que hay que hacer: son las de decisión
      const cambia = accionEnNm(p,d)!==accionEnNm(p,d+1);
      return '<div class="pg-fila'+(cambia?' hito':'')+'" data-nm="'+d+'">'
        +'<span class="fnm">'+d+'</span>'
        +'<span>'+nf(altEnNm(d))+' ft</span><span>'+vel+'</span></div>';
    }).join('')
    +'<div class="pg-fila" data-nm="0"><span class="fnm">Final</span>'
    +'<span>Senda ILS</span><span>VAPP '+p.vapp+'</span></div>';
    body.dataset.centrada='';        // tabla nueva: hay que volver a centrar
  }

  // Resaltado y atenuado de lo que ya quedó atrás
  body.querySelectorAll('.pg-fila').forEach(function(el){
    const d=parseInt(el.dataset.nm,10);
    el.classList.toggle('activa', nm>0 && (d===nm || (d===0 && nm<1)));
    el.classList.toggle('pasada', nm>0 && d>nm);
  });

  // Se centra solo cuando cambia la milla actual: si se hiciera en cada vuelta, no te
  // dejaría desplazarte a mano para mirar más adelante.
  if(body.dataset.centrada!==String(nm)){
    body.dataset.centrada=String(nm);
    const el=body.querySelector('.pg-fila.activa');
    if(el){
      // scrollTop en vez de scrollIntoView: este último también mueve la página entera
      const alto=body.clientHeight||1;
      body.scrollTop = Math.max(0, el.offsetTop - alto/2 + el.offsetHeight/2);
    }
  }

  // Pie: la comparación concreta entre dónde estás y dónde deberías estar
  const pie=document.getElementById('pg-tabla-pie');
  if(s.alt==null || !nm){ pie.innerHTML='Esperando datos del vuelo.'; return; }
  if(s.on_ground){ pie.innerHTML='En tierra.'; return; }
  if(nm>filas[0]){ pie.innerHTML='A <b>'+Math.round(nm)+' NM</b> · todavía en crucero.'; return; }
  const ideal=altEnNm(nm);
  const dif=s.alt-ideal;
  if(dif>600) pie.innerHTML='A <b>'+Math.round(nm)+' NM</b> deberías ir por <b>'+nf(ideal)
    +' ft</b> · <span class="alto">vas '+nf(Math.round(dif/100)*100)+' ft alto</span>';
  else if(dif<-1500) pie.innerHTML='A <b>'+Math.round(nm)+' NM</b> deberías ir por <b>'+nf(ideal)
    +' ft</b> · vas '+nf(Math.round(-dif/100)*100)+' ft bajo';
  else pie.innerHTML='A <b>'+Math.round(nm)+' NM</b> · <span class="senda">en la senda</span> ('
    +nf(ideal)+' ft)';
}

// Abrir la tabla completa manteniendo pulsada la fila de altura o la de velocidad, que
// son justamente las que muestran un dato sacado de esa tabla.
function abrirTablaDescenso(){
  const m=document.getElementById('tabla-modal'); if(!m) return;
  m.classList.remove('hidden');
  updateTablaDescenso(lastNmLeft);
}
function cerrarTablaDescenso(){
  const m=document.getElementById('tabla-modal'); if(m) m.classList.add('hidden');
}
(function(){
  try{
    const g=localStorage.getItem('perfilDescenso');
    if(g==='narrow'||g==='wide'||g==='heavy') perfilElegido=g;
  }catch(e){}

  // Botón explícito: la pulsación larga costaba encontrarla (nadie la descubría sola).
  const btnTabla=document.getElementById('pg-tabla-btn');
  if(btnTabla) btnTabla.onclick=function(e){ e.stopPropagation(); abrirTablaDescenso(); };

  // Pulsación larga: 450 ms sin moverse. Si arrastrás (scroll del panel) se cancela.
  // Se deja como atajo extra en ambas filas, ya no es la única forma de abrir la tabla.
  const LARGO_MS=450;
  ['pg-vnav-row','pg-spd-row'].forEach(function(id){
    const el=document.getElementById(id); if(!el) return;
    el.classList.add('pg-pulsable');
    el.title='Mantené pulsado para ver la tabla completa';
    let t=null, x0=0, y0=0;
    const arrancar=function(x,y){
      x0=x; y0=y;
      clearTimeout(t);
      t=setTimeout(function(){ t=null; abrirTablaDescenso(); }, LARGO_MS);
    };
    const cancelar=function(){ clearTimeout(t); t=null; };
    const moverse=function(x,y){
      if(t && (Math.abs(x-x0)>10 || Math.abs(y-y0)>10)) cancelar();
    };
    el.addEventListener('mousedown',e=>arrancar(e.clientX,e.clientY));
    el.addEventListener('mousemove',e=>moverse(e.clientX,e.clientY));
    el.addEventListener('mouseup',cancelar);
    el.addEventListener('mouseleave',cancelar);
    el.addEventListener('touchstart',e=>{ if(e.touches[0]) arrancar(e.touches[0].clientX,e.touches[0].clientY); },{passive:true});
    el.addEventListener('touchmove',e=>{ if(e.touches[0]) moverse(e.touches[0].clientX,e.touches[0].clientY); },{passive:true});
    el.addEventListener('touchend',cancelar);
    el.addEventListener('touchcancel',cancelar);
    // En el celular, dejar pulsado abre el menú del navegador: eso lo tapa
    el.addEventListener('contextmenu',e=>e.preventDefault());
  });

  const cerrar=document.getElementById('tabla-close');
  if(cerrar) cerrar.onclick=cerrarTablaDescenso;
  const modal=document.getElementById('tabla-modal');
  if(modal) modal.addEventListener('click',function(e){ if(e.target.id==='tabla-modal') cerrarTablaDescenso(); });
})();

// ---- Cuánto falta para el próximo punto de la ruta ----
let legRefId=null, legRefNm=0;
// Al pasar por un punto de la ruta lo damos por cumplido y lo sacamos solo. El radio es
// chico (2,5 NM ≈ 4,6 km) para que solo cuente si realmente lo sobrevolaste.
const PASO_NM=2.5;
function limpiarPuntosPasados(){
  if(!cur || !routeWaypoints.length) return false;
  let saco=false;
  for(let i=routeWaypoints.length-1;i>=0;i--){
    const w=routeWaypoints[i];
    if(haversineNM(cur.lat,cur.lng,w.lat,w.lon)<=PASO_NM){
      w.marker.remove(); routeWaypoints.splice(i,1); saco=true;
      showToast('Pasaste '+(w.name||'el punto')+' · lo saqué de la ruta');
    }
  }
  return saco;
}
function nextLegTarget(){
  if(!cur||!routeTarget||!routeWaypoints.length) return null;   // ruta directa, sin puntos
  const ref=w=>({key:'w'+w.id, lat:w.lat, lon:w.lon, name:w.name||'Punto de ruta'});
  const toDest=haversineNM(cur.lat,cur.lng,routeTarget.lat,routeTarget.lon);
  // El primer punto que siga estando "adelante": si ya lo dejaste atrás, ir hasta él y
  // después al destino sería un rodeo. El margen es amplio (60%) porque un punto puesto
  // a mano casi nunca cae sobre la línea recta al destino: con el 15% de antes, cualquier
  // punto un poco al costado se descartaba y el panel decía "sin puntos intermedios".
  for(const w of routeWaypoints){
    const via=haversineNM(cur.lat,cur.lng,w.lat,w.lon)+haversineNM(w.lat,w.lon,routeTarget.lat,routeTarget.lon);
    if(via<=toDest*1.6) return ref(w);
  }
  // Ninguno pasó el filtro (te desviaste mucho, o la ruta da una vuelta grande a
  // propósito): igual mostramos uno, porque una guía imperfecta sirve más que un panel
  // diciendo que no hay puntos cuando sí los pusiste. Elegimos el que menos rodeo pide,
  // así si uno quedó atrás y otro adelante, gana el de adelante.
  let mejor=routeWaypoints[0], mejorVia=Infinity;
  for(const w of routeWaypoints){
    const via=haversineNM(cur.lat,cur.lng,w.lat,w.lon)+haversineNM(w.lat,w.lon,routeTarget.lat,routeTarget.lon);
    if(via<mejorVia){ mejorVia=via; mejor=w; }
  }
  return ref(mejor);
}
function updateNextLeg(){
  const row=document.getElementById('pg-next-row'); if(!row) return;
  row.style.display='';
  const to=nextLegTarget();
  // Antes esto se escondía y parecía que la función se había perdido. Ahora la ficha
  // sigue ahí y te dice qué hacer para tener un próximo punto.
  if(!to){
    row.classList.add('vacio');
    txt('pg-next','sin puntos intermedios');
    document.getElementById('pg-next-fill').style.width='0%';
    txt('pg-next-nm','--'); txt('pg-next-km','＋ punto');
    txt('pg-next-min','--'); txt('pg-next-brg','---°'); txt('pg-next-card','rumbo');
    return;
  }
  row.classList.remove('vacio');
  const nm=haversineNM(cur.lat,cur.lng,to.lat,to.lon);
  if(legRefId!==to.key){ legRefId=to.key; legRefNm=nm; }   // tramo nuevo: guardamos su largo
  if(nm>legRefNm) legRefNm=nm;                              // te alejaste: reajustamos
  const pct=legRefNm>0 ? Math.max(0,Math.min(100,(1-nm/legRefNm)*100)) : 0;
  document.getElementById('pg-next-fill').style.width=pct+'%';
  txt('pg-next', to.name);
  // Las dos unidades van juntas en la misma ficha: NM grande y los km debajo
  txt('pg-next-nm',  Math.round(nm));
  txt('pg-next-km',  nf(km(nm))+' km');
  txt('pg-next-min', Math.round(etaMinutes(nm)));
  // Rumbo al próximo punto, ya en magnético (el que marca la brújula de la cabina)
  const b=toMag(bearingTo(cur.lat,cur.lng,to.lat,to.lon));
  txt('pg-next-brg', String(Math.round(b)%360).padStart(3,'0')+'°');
  txt('pg-next-card', cardinal(b));
}
