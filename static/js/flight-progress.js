/* flight-progress.js — Progreso del vuelo: ETA, barra estilo FR24, guia y tabla de descenso, proximo punto.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Tiempo estimado, incluso con el avión parado ----
// Si todavía no despegaste no hay velocidad real, así que suponemos la de crucero
// típica según el tipo de motor que reporta el simulador.
// La sale del perfil del avión (PERFILES, más abajo): antes era solo por tipo de motor y un
// jet ejecutivo, un CRJ y un 747 suponían lo mismo.
const CLIMB_DESC_MIN=15;                     // despegue y aterrizaje son mucho más lentos
function assumedKt(){ return perfilActivo().kt||130; }
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
  featuresVnav(nodos, nm).forEach(f=>feats.push(f));    // T/C y T/D
  map.getSource('planroute').setData({type:'FeatureCollection',features:feats});
  // El chip de la ruta (＋ punto, ✕ cancelar) se sacó: las dos cosas están en el ícono de
  // punto del estante del dock (1 toque / 2 toques, ver graph-panel.js).
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
// Con el dock (2026-11-21) el progreso ya no es un panel aparte que tapa medio mapa: es la
// barra del perfil y unas columnas del mismo dock. Por eso arranca VISIBLE apenas hay una
// ruta; el botón de la barra de herramientas lo sigue escondiendo si no lo querés.
let progressUserOn=true;
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
// La clase con-ruta en la pila del dock muestra todo lo .solo-ruta (perfil, llegada, guía,
// marca del rumbo a seguir y próximo punto). El dock cambia de alto, y el avión se vuelve
// a centrar solo en lo que queda de mapa (lo dispara el ResizeObserver de tools-ui.js).
function syncProgressButton(){
  const b=document.getElementById('btn-progress'), pila=document.getElementById('dock-pila');
  if(!b||!pila) return;
  const avail=!!routeTarget;
  b.classList.toggle('disabled',!avail);
  b.classList.toggle('active', avail && progressUserOn);
  b.title = avail ? 'Progreso del vuelo' : 'Progreso del vuelo (necesita una ruta)';
  pila.classList.toggle('con-ruta', avail && progressUserOn);
}
function updateProgress(nmLeft, brg){
  syncProgressButton();
  if(!routeTarget || !progressUserOn) return;

  const org=findOriginAirport();
  const r=(lastState&&lastState.route)||[];
  // La barrita muestra la CIUDAD (OurAirports la trae como "municipality"); si no hay,
  // el nombre del aeropuerto
  if(org){
    document.getElementById('pg-from').textContent=org.icao;
    document.getElementById('pg-from-name').textContent=org.city||org.name||org.icao;
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
    const a=(searchAirport&&searchAirport.icao===routeTarget.icao)?searchAirport:findApt(routeTarget.icao);
    toName=(a&&(a.city||a.name))||'';
    // Un destino lejano (ej. KBOS desde Cartagena) no está en los datos cargados alrededor
    // del avión, así que lo pedimos por ICAO a la base completa del backend.
    if(!toName){ ensureDestInfo(routeTarget.icao); toName=(destInfo&&destInfo.icao===routeTarget.icao?(destInfo.city||destInfo.name):'')||''; }
  }
  document.getElementById('pg-to-name').textContent = toName||routeTarget.icao;

  const done=(lastState&&lastState.distance_nm)||0;      // recorrido real, no en línea recta
  const total=done+nmLeft;
  document.getElementById('pg-done').innerHTML=fmtDistB(done);
  // Sin el tiempo restante (lo dice "Llegada · en Xh") : con él no entraba en la columna
  document.getElementById('pg-left').innerHTML=fmtDistB(nmLeft);
  document.getElementById('pg-brg').textContent=fmtBrg(brg);
  rosaBrg=brg; pintarRosa();

  // Llegada estimada: con el avión quieto usa la velocidad típica del tipo de avión;
  // apenas superás los 40 nudos pasa sola al cálculo con tu velocidad real.
  const etaEl=document.getElementById('pg-eta'), min=etaMinutes(nmLeft);
  const est=!isRealSpeed();
  // Dos lecturas, se cambia tocando la fila: la hora local del SIMULADOR a la que llegás
  // (la que importa para saber si aterrizás de día o de noche), o la hora REAL en el iPad,
  // que con sim rate x4 es mucho antes. Antes no decía cuál era y no se sabía.
  const rate=Math.max(1,(lastState&&lastState.sim_rate)||1);
  const fila=document.getElementById('pg-eta-row');
  let h;
  if(llegadaReal){
    const minReal=min/rate, d=new Date(Date.now()+minReal*60000);
    h={txt:String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'), sim:false};
    txt('pg-eta-k','Llegada (hora real'+(rate>1?' · x'+rate:'')+')');
    etaEl.textContent=(est?'~':'')+h.txt;
    txt('pg-eta-en','en '+fmtHm(minReal));
  } else {
    h=horaLlegada(min);
    txt('pg-eta-k', h.sim ? 'Llegada (hora sim)' : 'Llegada (hora de la PC)');
    etaEl.textContent=(est?'~':'')+h.txt;
    txt('pg-eta-en','en '+fmtHm(min));
  }
  if(fila) fila.classList.toggle('real', llegadaReal);
  // Centro de la barrita: en cuánto aterrizás (tiempo del simulador)
  txt('pf-aterriza', (isPoint?'Llegás en ':'Aterrizás en ')+(est?'~':'')+fmtHm(min));
  etaEl.style.color = est ? 'var(--text-dim)' : 'var(--text)';
  etaEl.title = est ? ('Estimado suponiendo '+assumedKt()+' kt de crucero') : 'Calculado con tu velocidad real';
  updateNextLeg();
  updateVnav(nmLeft);
  updateVs(nmLeft);
  updateSpd(nmLeft);
  lastNmLeft=nmLeft;
  updateTablaDescenso(nmLeft);
  pintarPerfil(done, nmLeft);
}
// Última distancia al destino conocida: la tabla de descenso se puede repintar sola
// (al cambiar de perfil) sin esperar a la próxima vuelta del panel.
let lastNmLeft=0;

// ---- Barrita del vuelo (arriba del dock) ----
// Una línea del origen al destino: lo volado en celeste hasta el avión, lo que falta en
// gris. Antes fue un perfil de altura y después una línea con T/C, T/D, puntos de ruta y la
// fase; el 2026-11-21 se simplificó a esto (diseño "barrita"). El T/C y el T/D siguen en el
// mapa y en la guía de abajo.
try{ localStorage.removeItem('perfil.tc'); }catch(e){}     // lo usaba el perfil de altura
function pintarPerfil(done, nmLeft){
  if(!document.getElementById('pf') || !routeTarget) return;
  const total=Math.max(1, done+nmLeft);
  const xp=Math.max(0, Math.min(100, done/total*100));
  document.getElementById('pf-hecho').style.width=xp+'%';
  const avion=document.getElementById('pf-avion');
  avion.style.left=xp+'%';
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
let llegadaReal=false;
try{ llegadaReal=localStorage.getItem('llegada.real')==='1'; }catch(e){}
(function(){
  const fila=document.getElementById('pg-eta-row'); if(!fila) return;
  fila.addEventListener('click',()=>{
    llegadaReal=!llegadaReal;
    try{ localStorage.setItem('llegada.real',llegadaReal?'1':'0'); }catch(e){}
    if(routeTarget) drawRoute();
  });
})();
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
    pgFila('pg-vnav-row','pg-vnav','Altura','poné un aeropuerto de destino',PG_GRIS); return; }
  if(s.alt==null){
    pgFila('pg-vnav-row','pg-vnav','Altura','—',PG_GRIS); return; }
  if(s.on_ground){
    pgFila('pg-vnav-row','pg-vnav','Altura','se calcula al despegar',PG_GRIS); return; }
  if(!nmLeft){
    pgFila('pg-vnav-row','pg-vnav','Altura','—',PG_GRIS); return; }
  row.style.display='';
  row.querySelector('.pg-k').textContent='Altura';

  // Va antes del chequeo de "ya venís a la altura de llegada": en un destino alto (Bogotá,
  // 8.360 ft) ese chequeo saltaba en pleno ascenso.
  // Antes del T/D la fila es la del CRUCERO: a qué altura vas y en cuánto llegás. La
  // etiqueta dice de dónde sale esa altura (tu AP, el plan, o una estimación). Sin este
  // tope, lejos del destino la regla 3:1 pedía cosas como "77,000 ft · vas 64,900 bajo"
  // (257 NM × 300 ft).
  const vn=calcVnav(nmLeft);
  if(vn && vn.tod!=null){
    const de={ap:'Crucero (tu AP)', plan:'Crucero (plan)', nivelado:'Crucero', estimado:'Crucero estimado'}[vn.fuente]||'Crucero';
    if(vn.toc!=null){
      pgFila('pg-vnav-row','pg-vnav', de+(vn.recortado?' · ruta corta':''),
        // Sin el "a 2.100 ft/min": ya está en el panel de datos y en el iPad partía la fila en dos
        fmtFL(vn.techo)+' en '+fmtMin(vn.tocMin));
    } else {
      pgFila('pg-vnav-row','pg-vnav', de, fmtFL(vn.techo)+' · nivelado', '#4ade80');
    }
    return; }

  const elev=destElevFt();
  const floor=elev+1500;                       // apuntamos a 1500 ft sobre el aeropuerto
  if(s.alt-floor<300){
    pgFila('pg-vnav-row','pg-vnav','Altura','ya venís a la altura de llegada',PG_GRIS); return; }

  // Misma cuenta que la tabla de descenso (300 ft por milla + elevación del aeropuerto),
  // así que la fila y la tabla nunca se contradicen. Redondeada de a 500 ft (no de a 100)
  // para que no esté bailando todo el tiempo con cada actualización de posición.
  // CON TOPE en la altura más alta del vuelo: la 3:1 no sabe a qué altura volaste, y en un
  // salto a 9.000 ft pedía "14.000 ft · vas 5.000 bajo" — subir para después bajar, nada
  // que ver. Nunca pide más de lo que volaste.
  const techo=Math.max(s.alt, s.max_alt||0);
  const t=Math.min(Math.round(altEnNm(nmLeft)/500)*500, Math.round(techo/500)*500);
  const diff=s.alt-t;
  // Solo importa ir ALTO (no llegás a bajar a tiempo): ahí sí se dice cuánto y a qué
  // régimen bajar. Ir un poco bajo no es problema (se nivela y listo), así que no se le
  // ponen números: "bien" o "algo bajo".
  // El régimen para corregir ya lo da la fila de abajo ("Bajar a"): acá solo cuánto.
  if(diff>1000){
    pgFila('pg-vnav-row','pg-vnav','Vas alto', nf(Math.round(diff/500)*500)+' ft de más · senda '+nf(t)+' ft','#fb923c');
  }
  else if(diff<-3000){ pgFila('pg-vnav-row','pg-vnav','Altura', 'algo bajo · mantené '+nf(Math.round(s.alt/500)*500)+' ft',PG_GRIS); }
  else { pgFila('pg-vnav-row','pg-vnav','Altura', 'bien · senda '+nf(t)+' ft','#4ade80'); }
}

// Régimen de descenso necesario: cuántos pies por minuto hacen falta para llegar a la
// altura de aterrizaje justo a tiempo, con la velocidad que llevás ahora.
function updateVs(nmLeft){
  const s=lastState||{};
  if(!routeTarget || routeTarget.icao==='PUNTO' || s.alt==null || !nmLeft){
    pgFila('pg-vs-row','pg-vs','Bajar a','—',PG_GRIS); return; }
  if(s.on_ground){ pgFila('pg-vs-row','pg-vs','Bajar a','se calcula al despegar',PG_GRIS); return; }
  if(!lastGs || lastGs<40){ pgFila('pg-vs-row','pg-vs','Bajar a','necesito velocidad real',PG_GRIS); return; }
  // Antes del T/D no hay que bajar todavía: repartir la bajada en todo lo que falta daba
  // un "−100 ft/min" en verde en pleno ascenso. Va antes del "no hace falta bajar" por lo
  // mismo que en updateVnav (destinos altos).
  const vn=calcVnav(nmLeft);
  if(vn && vn.tod!=null){
    pgFila('pg-vs-row','pg-vs','Bajar en', vn.todMin<1?'ahora':'en '+fmtMin(vn.todMin)+' · '+nf(km(vn.tod))+' km',
      vn.todMin<=3?'#fbbf24':PG_GRIS); return; }
  const perder=s.alt-(destElevFt()+1500);
  if(perder<300){ pgFila('pg-vs-row','pg-vs','Bajar a','no hace falta bajar',PG_GRIS); return; }
  const min=nmLeft/lastGs*60;                    // minutos que faltan al destino
  const fpm=Math.round(perder/Math.max(1,min)/50)*50;
  // Más de 2000 ft/min de bajada es incómodo: significa que vas tarde
  pgFila('pg-vs-row','pg-vs', fpm>2000?'Bajar a (vas tarde)':'Bajar a',
         '−'+nf(fpm)+' ft/min', fpm>2000?'#fb923c':(fpm>0?'#4ade80':PG_GRIS));
}

// Velocidad recomendada, según la fase del vuelo:
//  - debajo de 10.000 ft: la regla de 250 kt (solo jets: un ATR o una avioneta ni llegan);
//  - subiendo: la velocidad de ascenso del avión (IAS, y arriba del cruce el Mach);
//  - en crucero: el Mach de crucero del avión, comparado con el que llevás;
//  - bajando: el perfil del avión (la misma tabla que se abre manteniendo la fila), con
//    flaps y VAPP al final.
// Antes, fuera del descenso solo decía "libre sobre 10.000 ft", que no ayudaba en nada.
function fmtMach(m){ return 'M'+m.toFixed(2).replace(/^0/,''); }
function updateSpd(nmLeft){
  const s=lastState||{};
  if(s.alt==null || s.ias==null){ pgFila('pg-spd-row','pg-spd','Velocidad','—',PG_GRIS); return; }
  if(s.on_ground){ pgFila('pg-spd-row','pg-spd','Velocidad','en tierra',PG_GRIS); return; }

  const nm=Math.round(nmLeft||0), p=perfilActivo();
  if(enDescenso(nm)){
    if(nm<4){ pgFila('pg-spd-row','pg-spd','Vel. final','VAPP '+p.vapp+' kt','#7dd3fc'); return; }
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
    pgFila('pg-spd-row','pg-spd','Vel. bajando', objetivo+extra, color);
    return;
  }

  const vn=(routeTarget && routeTarget.icao!=='PUNTO') ? calcVnav(nmLeft) : null;
  const subiendo = vn ? vn.toc!=null : (s.vs!=null && s.vs>300);
  const [ktSube, machSube]=p.velSube||[250,null];
  const jet=ktSube>=250;
  const verde='#4ade80', naranja='#fb923c';

  // Regla de 250 kt debajo de 10.000 ft (para cualquiera que vaya más rápido)
  if(s.alt<10000 && s.ias>260){
    pgFila('pg-spd-row','pg-spd','Velocidad','máx 250 kt bajo 10.000 · '+Math.round(s.ias-250)+' de más',naranja); return; }
  if(s.alt<10000 && jet){
    pgFila('pg-spd-row','pg-spd', subiendo?'Vel. subiendo':'Velocidad','250 kt hasta 10.000 ft',verde); return; }

  if(subiendo){
    // Arriba de ~FL280 el avión pasa a mantener Mach (la IAS va bajando sola)
    if(machSube && s.alt>=28000){
      const ok=s.mach==null || Math.abs(s.mach-machSube)<=0.02;
      pgFila('pg-spd-row','pg-spd','Vel. subiendo', fmtMach(machSube)+(s.mach!=null&&!ok?' · vas '+fmtMach(s.mach):''), ok?verde:'#fbbf24');
    } else {
      const ok=Math.abs(s.ias-ktSube)<=15;
      pgFila('pg-spd-row','pg-spd','Vel. subiendo', ktSube+' kt'+(machSube?' → '+fmtMach(machSube):'')+(ok?'':' · vas '+Math.round(s.ias)),
        ok?verde:'#fbbf24');
    }
    return;
  }

  // Crucero
  if(p.mach && s.alt>=25000){
    const ok=s.mach==null || Math.abs(s.mach-p.mach)<=0.02;
    pgFila('pg-spd-row','pg-spd','Velocidad', fmtMach(p.mach)+(s.mach!=null?(ok?' · bien':' · vas '+fmtMach(s.mach)):''), ok?verde:'#fbbf24');
  } else {
    const ias=p.iasCrucero||ktSube;
    const ok=Math.abs(s.ias-ias)<=20;
    pgFila('pg-spd-row','pg-spd','Velocidad', '~'+ias+' kt'+(ok?' · bien':' · vas '+Math.round(s.ias)), ok?verde:PG_GRIS);
  }
}

// ---- Tabla de descenso ----
// La regla es siempre la misma (3:1: 300 pies de altura por cada milla que falta), así
// que las altitudes se calculan, no se copian. Lo que sí cambia según el avión es la
// VELOCIDAD, y eso es lo que guardan estos perfiles: pares [desde cuántas NM, qué IAS].
// Se lee de arriba hacia abajo y vale el primero cuyo tramo ya empezaste.
// Además de la velocidad, cada perfil trae cómo sube y a qué altura suele ir, para ubicar
// en la ruta el tope de ascenso (T/C) y el de descenso (T/D):
//   sube      = [régimen medio de ascenso en ft/min, velocidad sobre el suelo media en kt].
//               Es el PROMEDIO hasta crucero: un A320 sale a 2500 ft/min pero arriba de
//               FL300 sube a 1000, y en total tarda ~20-22 min hasta FL350.
//   crucero   = altitud típica (ft) si no hay plan de MSFS que la diga.
//   kt        = velocidad de crucero típica, para la ETA con el avión parado.
//   margenTod = millas extra antes del 3:1 para frenar: cuanto más pesado, más le cuesta
//               bajar y frenar a la vez, así que empieza antes.
//   velSube   = [IAS de ascenso sobre 10.000 ft, Mach al que pasa arriba] (fila Velocidad).
//   mach      = Mach de crucero; iasCrucero = IAS de crucero para los que no van por Mach.
const PERFILES={
  narrow:{ nombre:'A320 / narrowbody', vapp:'135-145',
    sube:[1700,330], crucero:35000, kt:450, margenTod:5, velSube:[290,0.78], mach:0.78,
    vel:[[100,'280 kt'],[40,'250 kt'],[20,'210 kt'],[15,'180-190 kt'],[10,'170 kt']] },
  wide:{ nombre:'A330 / widebody', vapp:'140-155',
    sube:[1400,340], crucero:37000, kt:470, margenTod:8, velSube:[300,0.82], mach:0.82,
    vel:[[100,'280 kt'],[35,'250 kt'],[25,'220 kt'],[20,'210 kt'],[15,'190-200 kt'],[10,'180 kt']] },
  heavy:{ nombre:'747 / heavy', vapp:'145-150',
    sube:[1200,340], crucero:36000, kt:480, margenTod:12, velSube:[320,0.85], mach:0.85,
    vel:[[90,'300 kt'],[80,'290 kt'],[60,'280 kt'],[40,'250 kt'],[30,'240 kt'],
         [25,'220 kt'],[20,'210 kt'],[15,'190 kt'],[12,'180 kt'],[10,'170 kt']],
    flaps:[[8,'Flaps iniciales'],[6,'Config. intermedia'],[4,'Config. final']] },
  regional:{ nombre:'E-Jet / CRJ / regional', vapp:'130-140',
    sube:[1800,310], crucero:33000, kt:430, margenTod:4, velSube:[290,0.76], mach:0.77,
    vel:[[100,'280 kt'],[40,'250 kt'],[20,'210 kt'],[12,'180 kt'],[9,'160 kt']] },
  turboprop:{ nombre:'ATR / Dash 8 / turbohélice', vapp:'110-120',
    sube:[1300,200], crucero:22000, kt:270, margenTod:0, velSube:[180,null], iasCrucero:200,
    vel:[[100,'240 kt'],[30,'210 kt'],[15,'180 kt'],[10,'160 kt']],
    flaps:[[8,'Flaps 15'],[4,'Flaps 30 / final']] },
  bizjet:{ nombre:'Jet ejecutivo', vapp:'115-130',
    sube:[2500,300], crucero:41000, kt:440, margenTod:3, velSube:[270,0.75], mach:0.80,
    vel:[[100,'280 kt'],[40,'250 kt'],[15,'200 kt'],[10,'170 kt']] },
  ga:{ nombre:'Avioneta / pistón', vapp:'65-75',
    sube:[600,90], crucero:7500, kt:120, margenTod:0, velSube:[75,null], iasCrucero:110,
    vel:[[100,'crucero'],[10,'100 kt']],
    flaps:[[4,'Flaps 10°'],[2,'Flaps full']] },
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

// Adivina el perfil del avión cargado en el sim, de lo más confiable a lo menos:
//  1. el código ICAO de ATC MODEL (A20N, B738, E175...), que no depende de la librea;
//  2. el nombre (TITLE), que a veces es solo el de la librea ("Avianca HK-5555");
//  3. tipo de motor + peso máximo de despegue, que siempre está y da el tamaño.
// Antes solo existía el paso 2, y todo lo que no decía 747/A330/777... caía en "narrow":
// un ATR o una avioneta se trataban como un A320.
const ICAO_PERFIL=[
  [/^(B74|B748|A38|A124|AN22|AN25)/,'heavy'],
  [/^(A30|A310|A33|A34|A35|B76|B77|B78|MD11|DC10|IL96|L101)/,'wide'],
  [/^(CRJ|E1[0-9]{2}|E29|E75|E2[0-9]{2}|E35L|RJ[0-9]|B46|F70|F100|SU95|AJ27)/,'regional'],
  [/^(AT4|AT7|ATP|DH8|DHC[6-8]|SF34|JS[0-9]|B190|D328|SW4|C208|PC12|TBM|BE20|B350|BE9L|KODI|L410|Y12|C27J|C130|C30J|AN2[46])/,'turboprop'],
  [/^(C25|C5[0-9]{2}|C55|C56|C68|C700|C750|CL30|CL35|CL60|GL[0-9A-Z]|GLF|GLEX|FA[0-9]|F2TH|F900|LJ|E50P|E55P|E545|E550|HDJT|SF50|EA50|PRM1|H25)/,'bizjet'],
  [/^(A3[12][0-9]|A19N|A20N|A21N|BCS|A22|B73|B3[789]M|B3XM|B75|MD8|MD9|B712|C919|DC9)/,'narrow'],
  [/^(C1[0-9]{2}|C2[0-9]{2}|PA|P28|DA[0-9]|SR2|BE3[3-6]|BE5|BE76|M20|CUB|J3|DR40|TB[0-9]|AA5|C42|DV20|VL3|SAVG)/,'ga'],
];
function perfilPorIcao(icao){
  if(!icao) return null;
  for(const [re,p] of ICAO_PERFIL){ if(re.test(icao)) return p; }
  return null;
}
function perfilPorTitulo(t){
  if(!t) return null;
  if(/747|748|a380|an-?124/.test(t)) return 'heavy';
  if(/a3[035]0|a340|a350|b?7[678]7|777|787|767|md-?11|dc-?10|widebody/.test(t)) return 'wide';
  if(/crj|e-?jet|e1[79]\d|erj|e175|e190|e195|embraer 1[79]|bae ?146|avro ?rj|fokker/.test(t)) return 'regional';
  if(/atr|dash ?8|q400|dhc-?[678]|king ?air|caravan|kodiak|pc-?12|tbm|saab ?340|twin otter|beech(craft)? ?1900/.test(t)) return 'turboprop';
  if(/citation|cj[1-4]|longitude|latitude|learjet|lear |gulfstream|challenger|global|falcon|phenom|praetor|hondajet|vision jet|sf50|eclipse/.test(t)) return 'bizjet';
  if(/a3[12]\d|a2[0-1]n|a220|737|757|md-?8\d|a32nx|fenix|neo\b/.test(t)) return 'narrow';
  if(/cessna 1[5-8]\d|c1[5-8]\d|skyhawk|skylane|piper|cub|cherokee|archer|warrior|seminole|diamond|da ?40|da ?42|da ?62|cirrus|sr2\d|bonanza|baron|mooney|robin|extra 3\d0|icon a5|savage|zlin|aviat|pitts|carbon ?cub|glider|planeador/.test(t)) return 'ga';
  return null;
}
// Sin código ni nombre conocido: el motor y el peso (lb) dicen el tamaño.
// 0=pistón 1=jet 3=helicóptero 5=turbohélice (ENGINE TYPE de SimConnect).
function perfilPorPeso(engType, mtow){
  if(engType===0 || engType===3) return 'ga';
  if(engType===5) return (mtow && mtow<20000) ? 'ga' : 'turboprop';
  if(engType===1 && mtow){
    if(mtow>700000) return 'heavy';
    if(mtow>300000) return 'wide';
    if(mtow>130000) return 'narrow';
    if(mtow>45000)  return 'regional';
    return 'bizjet';
  }
  return null;
}
// Devuelve también DE DÓNDE salió, para mostrarlo en la tabla ("por código", "por peso")
// y que se note si la app adivinó o lo sabía.
function deteccionAvion(){
  const s=lastState||{};
  const icao=(s.ac_icao||'').toUpperCase();
  let p=perfilPorIcao(icao);
  if(p) return {perfil:p, fuente:icao};
  p=perfilPorTitulo((s.aircraft||'').toLowerCase());
  if(p) return {perfil:p, fuente:'por nombre'};
  p=perfilPorPeso(s.eng_type, s.ac_mtow_lb);
  if(p) return {perfil:p, fuente:'por motor y peso'};
  return {perfil:'narrow', fuente:'sin datos'};
}
function perfilAuto(){ return deteccionAvion().perfil; }
function perfilActivo(){ return PERFILES[perfilElegido||perfilAuto()]||PERFILES.narrow; }

// ---- Tope de ascenso (T/C) y de descenso (T/D) sobre la ruta ----
// MSFS mete sus propios TIMECRUIS/TIMEDSCNT en el plan, en lugares que no servían (se
// filtran en server/msfs_plan.py). Estos se calculan con el perfil del avión:
//  - Crucero: el del plan de MSFS si la ruta vino de ahí; si no, el típico del perfil,
//    recortado en vuelos cortos (nadie sube un A320 a FL350 para 80 NM). Si ya volaste
//    más alto, manda la altura real; y si vas nivelado cerca del crucero, esa es la tuya.
//  - T/C: lo que falta subir ÷ régimen medio × velocidad media de ascenso. Se mide desde
//    donde estás, así que se va acercando solo y desaparece al llegar arriba.
//  - T/D: la regla 3:1 de la tabla de descenso (así nunca se contradicen) + el margen del
//    perfil para frenar. Un jet a FL350 da ~115-125 NM antes del destino.
// Si la ruta es tan corta que no alcanza para subir al crucero y bajar, el techo se baja
// hasta donde se crucen la subida y la bajada.
let cruceroPlan=null;   // ft: CruisingAlt del plan de MSFS (lo pone checkMsfsPlan en flightplan.js)
const NM_POR_FT_BAJANDO=1/300;   // 3:1, igual que altEnNm()

// Duración legible: "12 min", "1h 05m"
function fmtMin(m){ return m>=60 ? fmtHm(m) : Math.max(1,Math.round(m))+' min'; }

// Régimen vertical suavizado (~6 s): el VS del sim salta de una lectura a otra y el "llegás
// en X min" bailaba. Se actualiza por tiempo, no por llamada (calcVnav se llama varias
// veces por segundo desde lugares distintos).
let vsSuave=null, vsSuaveT=0;
function vsSuavizado(){
  const s=lastState||{}, ahora=Date.now();
  if(s.vs==null){ vsSuave=null; return null; }
  const dt=Math.min(10,(ahora-vsSuaveT)/1000); vsSuaveT=ahora;
  vsSuave = vsSuave==null ? s.vs : vsSuave+(s.vs-vsSuave)*Math.min(1,dt/6);
  return vsSuave;
}
// Altura del piloto automático como objetivo: tiene que estar a tu altura o arriba (si
// está abajo es que ya estás bajando) y ser una altura de verdad (≥ 5.000 ft).
// OJO: algunos aviones de terceros (Fenix, por ejemplo) no la publican en la SimVar
// estándar; entonces no aparece y se usa el plan o la estimación.
function altAP(){
  const s=lastState||{}, ap=s.ap;
  if(!ap || ap.alt==null || s.alt==null) return null;
  if(ap.alt<5000 || ap.alt<s.alt-300) return null;
  return Math.round(ap.alt/100)*100;
}
// Cuánto llevás nivelado a la misma altura (para tomarla como tu crucero)
let nivelDesde=null, nivelAlt=null;
function segundosNivelado(){
  const s=lastState||{};
  if(s.on_ground!==false || s.alt==null || s.vs==null || Math.abs(s.vs)>=300){ nivelDesde=null; return 0; }
  if(nivelDesde==null || Math.abs(s.alt-nivelAlt)>200){ nivelDesde=Date.now(); nivelAlt=s.alt; }
  return (Date.now()-nivelDesde)/1000;
}

// La altura de crucero es la que VOS vas a volar, no un número fijo. En orden:
//   1. la del piloto automático (lo que pusiste en el FCU/MCP);
//   2. la del plan de MSFS, si el AP está más abajo mientras subís (una restricción
//      intermedia, tipo FL100) — una vez que llegaste al plan, vuelve a mandar el AP;
//   3. si no hay ninguna, una estimación por el largo del vuelo y el tipo de avión
//      (un jet en un vuelo largo: FL330-FL410; en un salto corto, menos), y si ya llevás
//      un minuto nivelado arriba, tu altura.
// El T/C usa tu régimen real de subida (si estás subiendo) y tu velocidad: "si seguís así,
// llegás a FL350 en 12 min".
function calcVnav(nmLeft){
  const s=lastState||{}, p=perfilActivo();
  if(!routeTarget || routeTarget.icao==='PUNTO' || !(nmLeft>0)) return null;
  const elevDest=destElevFt();
  const alt=(s.alt!=null)?s.alt:0;
  const enAire=s.on_ground===false;
  const [fpm,ktSube]=p.sube;
  const nmPorFtSubiendo=ktSube/60/fpm;
  const margen=p.margenTod||0;
  const vs=vsSuavizado();

  const apAlt=altAP();
  let crucero=null, fuente='';
  if(cruceroPlan){ crucero=cruceroPlan; fuente='plan'; }
  if(apAlt && (!crucero || apAlt>=crucero || (s.max_alt||0)>=crucero-500)){ crucero=apAlt; fuente='ap'; }
  if(!crucero){
    const viaje=(s.distance_nm||0)+nmLeft;          // largo total del vuelo, no lo que falta
    crucero=Math.min(p.crucero, Math.max(elevDest+3000, 10000+viaje*100));
    crucero=Math.round(crucero/1000)*1000;           // niveles redondos: FL230, no FL234
    fuente='estimado';
    if(s.max_alt && s.max_alt>crucero) crucero=s.max_alt;
    if(segundosNivelado()>=60 && alt>=Math.min(15000, crucero*0.75)){ crucero=Math.round(alt/100)*100; fuente='nivelado'; }
  }

  // ¿Alcanza la ruta para subir hasta ahí y bajar? Si no, techo donde se cruzan.
  let techo=crucero;
  const subir=Math.max(0,techo-alt);
  if(subir*nmPorFtSubiendo + (techo-elevDest)*NM_POR_FT_BAJANDO + margen > nmLeft){
    techo=(nmLeft-margen + alt*nmPorFtSubiendo + elevDest*NM_POR_FT_BAJANDO)
          /(nmPorFtSubiendo+NM_POR_FT_BAJANDO);
    techo=Math.floor(techo/1000)*1000;
  }
  const bajando = enAire && s.vs!=null && s.vs<-500;
  const out={techo:Math.max(techo,alt), recortado:techo<crucero-400, fuente:fuente};

  // T/C: solo mientras falte subir (y no estés ya bajando). Subiendo de verdad, con tu
  // régimen y tu velocidad; si no, con los del perfil del avión.
  const falta=techo-alt;
  if(falta>500 && !bajando){
    if(enAire && vs!=null && vs>300 && lastGs>=40){
      out.tocMin=falta/vs;
      out.toc=out.tocMin*lastGs/60;
      out.vsReal=vs;
    } else {
      out.toc=falta*nmPorFtSubiendo;                 // NM desde donde estás
      out.tocMin=falta/fpm;
    }
  }
  // T/D: desde la altura más alta entre el techo y la que llevás
  const desdeDestino=(Math.max(techo,alt)-elevDest)*NM_POR_FT_BAJANDO + margen;
  const adelante=nmLeft-desdeDestino;
  // Si ya venís bajando, el T/D quedó atrás (empezaste antes, o ATC te bajó): manda la
  // senda de descenso. Antes seguía diciendo "Crucero · nivelado / bajar en 1 min".
  // Pero solo cerca del T/D: bajando a 1000 NM del destino (un escalón de ATC, o la demo
  // que sube y baja en círculos) marcaba el T/D justo donde estabas (2026-11-21).
  const yaEnDescenso = bajando && adelante < Math.max(40, desdeDestino*0.5);
  if(adelante>1 && !yaEnDescenso){
    out.tod=adelante;                                // NM desde donde estás
    out.todDest=desdeDestino;                        // NM antes del destino
    const kt=(enAire && lastGs>=40)?lastGs:p.kt;
    out.todMin=adelante/kt*60 + (out.tocMin? out.tocMin*0.3 : 0);  // el ascenso es más lento
  }
  return out;
}
function fmtFL(ft){
  ft=Math.round(ft/100)*100;
  return ft>=18000 ? 'FL'+String(Math.round(ft/100)).padStart(3,'0') : nf(ft)+' ft';
}
// Punto a `dist` NM desde el inicio de la ruta, siguiendo sus tramos ([lng,lat]).
function puntoEnRuta(nodos, dist){
  for(let i=0;i<nodos.length-1;i++){
    const a=nodos[i], b=nodos[i+1];
    const tramo=haversineNM(a[1],a[0],b[1],b[0]);
    if(dist<=tramo){ const t=tramo>0?dist/tramo:0;
      return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]; }
    dist-=tramo;
  }
  return nodos[nodos.length-1];
}
// Features para la fuente 'planroute' (capas planroute-vnav-* en geo-utils.js)
// Aviso unos minutos antes del T/D y otro al llegar, una sola vez por ruta. No avisa si
// ya venís bajando (empezaste antes) ni en tierra.
let todAviso={clave:null, previo:false, ahora:false};
function avisoTod(v){
  const s=lastState||{};
  const clave=routeTarget ? routeTarget.icao+'@'+routeTarget.lat.toFixed(3)+','+routeTarget.lon.toFixed(3) : null;
  if(todAviso.clave!==clave) todAviso={clave:clave, previo:false, ahora:false};
  if(!v || v.tod==null || s.on_ground!==false) return;
  if(s.vs!=null && s.vs<-500) return;
  if(!todAviso.ahora && v.tod<=3){
    todAviso.ahora=todAviso.previo=true;
    showToast('Empezá a bajar ahora · desde '+fmtFL(Math.max(v.techo, s.alt||0)));
  } else if(!todAviso.previo && v.todMin<=3){
    todAviso.previo=true;
    showToast('En ~'+Math.max(1,Math.round(v.todMin))+' min empezás a bajar · preparate');
  }
}
function featuresVnav(nodos, nmLeft){
  const v=calcVnav(nmLeft);
  avisoTod(v);
  if(!v) return [];
  // Antes decían "T/C · FL130 (ruta corta) / en 2 min · 17 km" y "T/D · 46 NM antes / en
  // 2 min · 22 km": mezclaban distancias desde vos y desde el destino y no se entendían.
  // Ahora dicen qué pasa ahí y en cuánto tiempo; el lugar ya lo marca el punto en la línea.
  const f=[];
  if(v.toc!=null && v.toc<nmLeft){
    const s=lastState||{};
    const cuando = s.on_ground===false ? 'en '+fmtMin(v.tocMin) : fmtMin(v.tocMin)+' tras despegar';
    f.push({type:'Feature',properties:{vnav:'toc',
      label:'Llegás a '+fmtFL(v.techo)+'\n'+cuando+(v.recortado?' · máx. por ruta corta':'')},
      geometry:{type:'Point',coordinates:puntoEnRuta(nodos,v.toc)}});
  }
  if(v.tod!=null){
    f.push({type:'Feature',properties:{vnav:'tod',
      label:'Empezá a bajar\n'+(v.todMin<1?'ahora':'en '+fmtMin(v.todMin))},
      geometry:{type:'Point',coordinates:puntoEnRuta(nodos,v.tod)}});
  }
  return f;
}

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
  const opciones=[['','Auto'],['ga','Avioneta'],['turboprop','Turbohélice'],['bizjet','Ejecutivo'],
    ['regional','Regional'],['narrow','Narrow'],['wide','Wide'],['heavy','747']];
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
  document.getElementById('pg-perfil-nom').textContent=p.nombre+(auto?' · auto ('+deteccionAvion().fuente+')':'');
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
    if(g && Object.prototype.hasOwnProperty.call(PERFILES,g)) perfilElegido=g;
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
    txt('pg-next','Puntos');
    document.getElementById('pg-next-fill').style.width='0%';
    txt('pg-next-nm','--'); txt('pg-next-km','＋ punto');
    txt('pg-next-min','--'); txt('pg-next-brg','---°'); txt('pg-next-card','rumbo'); girarFlecha('fr-next', null);
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
  girarFlecha('fr-next', b);
}
