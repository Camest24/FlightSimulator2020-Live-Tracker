/* tools-ui.js — Paneles y utilidades sueltas: company route, buscador, estado del avion, averias,
   historial, wake lock y tamano de los paneles.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Exportar la ruta como company route (para cargarla desde el MCDU) ----
document.getElementById('rc-mcdu').onclick=function(){
  if(!routeTarget){ return; }
  if(routeTarget.icao==='PUNTO'){ showToast('El destino tiene que ser un aeropuerto'); return; }
  const org=findOriginAirport();
  if(!org){ showToast('No pude identificar el aeropuerto de salida'); return; }
  // Solo viajan los puntos CON nombre. Un punto suelto del mapa no tiene identificador,
  // y el MCDU no puede cargar algo que no existe en su base de navegación.
  const conNombre=routeWaypoints.filter(w=>w.name);
  const sinNombre=routeWaypoints.length-conNombre.length;
  const btn=this; btn.disabled=true; btn.textContent='Guardando…';
  fetch('/api/coroute',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({origin:org.icao, destination:routeTarget.icao,
      origin_lat:org.lat, origin_lon:org.lon,
      dest_lat:routeTarget.lat, dest_lon:routeTarget.lon,
      waypoints:conNombre.map(w=>({id:w.name, name:w.name, lat:w.lat, lon:w.lon}))})})
    .then(r=>r.json()).then(d=>{
      if(!d.ok){
        const msg={no_simbridge:'No encontré la carpeta de SimBridge',
                   ruta_muy_corta:'La ruta necesita al menos un punto: usá "Generar ruta"',
                   faltan_aeropuertos:'Origen y destino tienen que ser aeropuertos'}[d.reason];
        showToast(msg || 'No pude guardar la ruta');
        return;
      }
      const fuera=[].concat(d.skipped||[]);
      const sb=d.simbridge||{};
      // El archivo puede quedar perfecto y el MCDU dar error igual, simplemente porque
      // SimBridge está cerrado: el avión no lee el archivo, se lo pide al servidor de
      // SimBridge. Antes esto no se veía por ningún lado y parecía que fallaba la app.
      if(!sb.vivo){
        // Sin SimBridge abierto el MCDU no puede leer la ruta. En vez de mandarte a
        // buscarlo al menú de inicio, lo intentamos abrir nosotros.
        showToast('Ruta guardada como "'+d.name+'" · abriendo SimBridge…');
        fetch('/api/simbridge_start',{method:'POST'}).then(r=>r.json()).then(function(a){
          if(a.ok) showToast('SimBridge abierto · ya podés escribir "'+d.name+'" en CO RTE');
          else if(a.reason==='no_encontrado')
            showToast('No encontré SimBridge instalado · abrilo a mano (FlyByWire SimBridge) '
              +'y volvé a tocar MCDU');
          else
            showToast('No pude abrir SimBridge · abrilo a mano y volvé a tocar MCDU');
        }).catch(function(){ showToast('No pude abrir SimBridge · abrilo a mano'); });
      } else if(sb.ruta_visible===false){
        showToast('Guardada como "'+d.name+'" pero SimBridge no la pudo leer · '
          +'probá con menos puntos intermedios');
      } else {
        showToast('Guardada como "'+d.name+'" · '+d.fixes+' puntos · escribila en CO RTE'
          +(sinNombre?(' · '+sinNombre+' sin nombre quedaron fuera'):'')
          +(fuera.length?(' · el FMS no reconoce: '+fuera.join(', ')):''));
      }
    })
    .catch(()=>showToast('Error al guardar la ruta'))
    .finally(()=>{ btn.disabled=false; btn.textContent='→ MCDU'; });
};

// ---- Buscador de aeropuertos del mundo ----
let searchTimer=null;
function openSearch(){ const p=document.getElementById('search-panel'); p.classList.remove('hidden'); const i=document.getElementById('sp-input'); i.value=''; document.getElementById('sp-results').innerHTML=''; setTimeout(()=>i.focus(),50); }
function closeSearch(){ document.getElementById('search-panel').classList.add('hidden'); }
document.getElementById('btn-search').onclick=()=>{ document.getElementById('search-panel').classList.contains('hidden')?openSearch():closeSearch(); };
document.getElementById('sp-close').onclick=closeSearch;
document.getElementById('sp-input').addEventListener('input',function(){
  const q=this.value.trim(); clearTimeout(searchTimer);
  const box=document.getElementById('sp-results');
  if(q.length<2){ box.innerHTML=''; return; }
  searchTimer=setTimeout(()=>{
    fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json()).then(list=>{
      if(!list.length){ box.innerHTML='<div class="sp-item" style="cursor:default;color:var(--text-dim)">Sin resultados</div>'; return; }
      box.innerHTML='';
      list.forEach(a=>{ const el=document.createElement('div'); el.className='sp-item';
        el.innerHTML='<span class="sp-icao">'+a.icao+'</span><span class="sp-name">'+(a.name||'')+'</span>';
        el.onclick=()=>selectSearchResult(a); box.appendChild(el); });
    }).catch(()=>{});
  }, 250);
});
function selectSearchResult(a){
  searchAirport=a;                          // queda "encontrado" para que ruta/teleporte lo ubiquen
  if(searchMarker) searchMarker.remove();
  searchMarker=aptMarker(a);                // mismo pin y acciones que un aeropuerto normal
  map.flyTo({center:[a.lon,a.lat], zoom:12, essential:true});
  setTimeout(()=>{ try{ searchMarker.togglePopup(); }catch(e){} }, 400);
  closeSearch();
}

// ---- Panel de estado del avión ----
function stOnOff(v,onTxt,offTxt){ return '<span class="st-val '+(v?'on':'off')+'">'+(v?onTxt:offTxt)+'</span>'; }
// Devuelve la promesa para que quien llama pueda saber si el sim aceptó el evento.
// El backend ahora responde {ok, error} de verdad, no un "ok" de mentira.
window.cmd=function(ev){
  return fetch('/api/cmd?ev='+encodeURIComponent(ev),{method:'POST'})
    .then(r=>r.json())
    .catch(()=>({ok:false, error:'no pude hablar con el servidor'}));
};
// De todo el "estado del avión" lo único que se usa en vuelo son las luces, así que el
// panel quedó reducido a eso. El resto (tren, flaps, spoilers, freno) se maneja mejor
// desde la cabina.
function renderStatus(s){
  s=s||{};
  const L=s.lights||{};
  const lchip=(on,txt,ev)=>'<span class="st-chip'+(on?' on':'')+'" onclick="cmd(\''+ev+'\')">'+txt+'</span>';
  const h='<div class="st-row" style="border-bottom:none"><span class="st-chips">'
    +lchip(L.landing,'Aterrizaje','LANDING_LIGHTS_TOGGLE')
    +lchip(L.taxi,'Taxi','TOGGLE_TAXI_LIGHTS')
    +lchip(L.beacon,'Beacon','TOGGLE_BEACON_LIGHTS')
    +lchip(L.strobe,'Strobe','STROBES_TOGGLE')
    +lchip(L.nav,'Navegación','TOGGLE_NAV_LIGHTS')+'</span></div>';
  document.getElementById('st-body').innerHTML=h;
  // El botón del panel se prende cuando hay alguna luz encendida
  const on=!!(L.landing||L.taxi||L.beacon||L.strobe||L.nav);
  const b=document.getElementById('btn-status'); if(b) b.classList.toggle('on',on);
}
document.getElementById('off-x').oninput=(e)=>setOffsetX(parseInt(e.target.value,10));
document.getElementById('off-reset').onclick=()=>offsetAuto();
document.getElementById('btn-status').onclick=(e)=>{ e.stopPropagation(); renderStatus(lastState);
  pintarOffset();
  document.getElementById('status-modal').classList.remove('hidden'); };
document.getElementById('st-close').onclick=()=>document.getElementById('status-modal').classList.add('hidden');
document.getElementById('status-modal').addEventListener('click',(e)=>{ if(e.target.id==='status-modal') e.currentTarget.classList.add('hidden'); });

// ---- Averías ----
// Cada una es un evento estándar de SimConnect. Se disparan por el mismo canal que ya
// usan el tren, los flaps y las luces.
const AVERIAS=[
  ['TOGGLE_ENGINE1_FAILURE','Motor 1'],
  ['TOGGLE_ENGINE2_FAILURE','Motor 2'],
  ['TOGGLE_ENGINE3_FAILURE','Motor 3'],
  ['TOGGLE_ENGINE4_FAILURE','Motor 4'],
  ['TOGGLE_ELECTRICAL_FAILURE','Sistema eléctrico'],
  ['TOGGLE_HYDRAULIC_FAILURE','Hidráulico'],
  ['TOGGLE_VACUUM_FAILURE','Vacío'],
  ['TOGGLE_PITOT_BLOCKAGE','Tubo pitot bloqueado'],
  ['TOGGLE_STATIC_PORT_BLOCKAGE','Toma estática bloqueada'],
  ['TOGGLE_TOTAL_BRAKE_FAILURE','Frenos (ambos)'],
  ['TOGGLE_LEFT_BRAKE_FAILURE','Freno izquierdo'],
  ['TOGGLE_RIGHT_BRAKE_FAILURE','Freno derecho'],
];
// Todos son eventos TOGGLE: el mismo evento rompe y repara. Por eso llevamos la cuenta
// de cuáles están rotas ahora mismo (failActivas) y así podemos ofrecer "reparar".
let failMin=0, failCola=[], failSeq=0;
const failActivas=new Set();
const failNombre=Object.fromEntries(AVERIAS);

function failMinutos(){
  const libre=parseFloat(document.getElementById('fail-min').value);
  return (!isNaN(libre) && libre>=0) ? libre : failMin;
}

// Dispara el evento y avisa de verdad si el simulador no lo aceptó, en vez de fallar
// en silencio como hacía antes.
function mandarAveria(ev, nombre, romper){
  return cmd(ev).then(d=>{
    if(!d.ok){
      showToast('No se pudo: '+nombre+(d.error?(' ('+d.error+')'):''));
      return false;
    }
    if(romper) failActivas.add(ev); else failActivas.delete(ev);
    pintarAverias();
    showToast(romper ? ('¡Avería! '+nombre) : ('Reparado: '+nombre));
    return true;
  });
}

function pintarCola(){
  const box=document.getElementById('fail-queue');
  if(!failCola.length){ box.innerHTML=''; return; }
  box.innerHTML=failCola.map(f=>{
    const s=Math.max(0,Math.round((f.cuando-Date.now())/1000));
    const mm=String(Math.floor(s/60)).padStart(2,'0'), ss=String(s%60).padStart(2,'0');
    return '<div class="fq-item"><span class="fq-name">'+f.nombre+'</span>'
      +'<span class="fq-time">'+mm+':'+ss+'</span>'
      +'<button class="fq-cancel" onclick="cancelarAveria('+f.id+')">Cancelar</button></div>';
  }).join('');
}
window.cancelarAveria=function(id){
  const i=failCola.findIndex(f=>f.id===id);
  if(i<0) return;
  clearTimeout(failCola[i].t); const n=failCola[i].nombre;
  failCola.splice(i,1); pintarCola(); showToast('Cancelada: '+n);
};

function programarAveria(ev,nombre){
  // Si ya está rota, un clic la repara: el botón hace de interruptor
  if(failActivas.has(ev)){ mandarAveria(ev,nombre,false); return; }
  const min=failMinutos();
  if(min<=0){ mandarAveria(ev,nombre,true); return; }
  const id=++failSeq, cuando=Date.now()+min*60000;
  const t=setTimeout(()=>{
    mandarAveria(ev,nombre,true);
    failCola=failCola.filter(f=>f.id!==id); pintarCola();
  }, min*60000);
  failCola.push({id:id, nombre:nombre, cuando:cuando, t:t});
  pintarCola();
  showToast(nombre+' programada en '+min+' min');
}

// Repara todo lo roto de una. Van espaciadas ~120 ms porque mandar doce eventos de
// golpe hace que el sim se coma algunos.
function repararTodo(){
  const pendientes=[...failActivas];
  if(!pendientes.length && !failCola.length){ showToast('No hay averías activas'); return; }
  failCola.forEach(f=>clearTimeout(f.t)); failCola=[]; pintarCola();
  if(!pendientes.length){ showToast('Programadas canceladas'); return; }
  pendientes.forEach((ev,i)=>setTimeout(()=>mandarAveria(ev, failNombre[ev]||ev, false), i*120));
}
window.repararTodo=repararTodo;

function pintarAverias(){
  document.getElementById('fail-body').innerHTML=AVERIAS.map(([ev,nom])=>{
    const roto=failActivas.has(ev);
    return '<span class="fail-item'+(roto?' roto':'')+'" data-ev="'+ev+'" data-nom="'+nom+'"'
      +' title="'+(roto?'Tocá para reparar':'Tocá para averiar')+'">'
      +'<svg class="fi-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>'
      +nom+'</span>';
  }).join('');
  document.querySelectorAll('#fail-body .fail-item').forEach(el=>{
    el.onclick=()=>programarAveria(el.dataset.ev, el.dataset.nom);
  });
  const b=document.getElementById('fail-repair');
  if(b){ const n=failActivas.size; b.textContent = n?('Reparar todo ('+n+')'):'Reparar todo'; b.disabled=!n && !failCola.length; }
}
document.querySelectorAll('.fail-mode').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.fail-mode').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); failMin=parseFloat(b.dataset.min)||0;
  document.getElementById('fail-min').value='';
});
document.getElementById('fail-repair').onclick=repararTodo;
document.getElementById('btn-fail').onclick=()=>{
  pintarAverias(); pintarCola();
  document.getElementById('fail-modal').classList.remove('hidden');
};
document.getElementById('fail-close').onclick=()=>document.getElementById('fail-modal').classList.add('hidden');
document.getElementById('fail-modal').addEventListener('click',e=>{ if(e.target.id==='fail-modal') e.currentTarget.classList.add('hidden'); });
setInterval(()=>{ if(failCola.length) pintarCola(); },1000);   // cuenta regresiva en vivo
document.addEventListener('keydown',e=>{ if(e.key==='Escape') document.getElementById('fail-modal').classList.add('hidden'); });

// ---- Historial de vuelos ----
function fmtFecha(ts){
  if(!ts) return '';
  const d=new Date(ts*1000);
  return d.toLocaleDateString([], {day:'2-digit', month:'short'})+' · '+
         d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function renderHist(list){
  const box=document.getElementById('hist-body');
  if(!list.length){ box.innerHTML='<div class="hist-empty">Todavía no hay vuelos guardados.<br>Se guardan solos al aterrizar, o al tocar "Reiniciar ruta".</div>'; return; }
  box.innerHTML=list.map(f=>{
    const de=f.from_icao||'----', a=f.to_icao||'----';
    const kms=km(f.distance_nm);
    const min=(f.start_time&&f.end_time)?Math.round((f.end_time-f.start_time)/60):0;
    const alt=f.max_alt_ft?Math.round(f.max_alt_ft).toLocaleString('en-US')+' ft':'';
    return '<div class="hist-item">'
      +'<span class="hist-main"><span class="hist-route">'+de+' → '+a+'</span>'
      +'<span class="hist-sub">'+fmtFecha(f.start_time)+(alt?(' · máx '+alt):'')+'</span></span>'
      +'<span class="hist-nums">'+nf(kms)+' km<span>'+Math.round(f.distance_nm||0)+' NM · '+fmtHm(min)+'</span></span>'
      +'<button class="hist-del" title="Borrar" onclick="delHist('+f.id+')">✕</button></div>';
  }).join('');
}
function loadHist(){
  fetch('/api/history').then(r=>r.json()).then(renderHist)
    .catch(()=>{ document.getElementById('hist-body').innerHTML='<div class="hist-empty">No pude leer el historial.</div>'; });
}
window.delHist=function(id){
  fetch('/api/history/delete?id='+id,{method:'POST'}).then(r=>r.json()).then(()=>loadHist()).catch(()=>{});
};
document.getElementById('btn-hist').onclick=()=>{
  document.getElementById('hist-modal').classList.remove('hidden'); loadHist();
};
document.getElementById('hist-close').onclick=()=>document.getElementById('hist-modal').classList.add('hidden');
document.getElementById('hist-modal').addEventListener('click',e=>{ if(e.target.id==='hist-modal') e.currentTarget.classList.add('hidden'); });

// ---- Wake Lock: mantener la pantalla encendida durante el vuelo ----
let wakeLock=null;
async function reqWakeLock(){ try{ if('wakeLock' in navigator){ wakeLock=await navigator.wakeLock.request('screen'); } }catch(e){} }
reqWakeLock();
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') reqWakeLock(); });

function showWaiting(show, connected){
  const w=document.getElementById('waiting'); if(!w) return;
  w.classList.toggle('hidden', !show);
  // Sin textos: lo único que cambia es la ruedita, que se cierra en verde cuando el
  // simulador ya respondió y solo falta que entres a un vuelo.
  if(show) w.classList.toggle('listo', !!connected);
}
// La ruta volada (hasta 6000 puntos) viaja aparte del estado liviano — de a ~1 vez por
// segundo, sea por WS (mensaje {type:'route'}) o por HTTP (/api/route) — es la única parte
// que de verdad la necesita. `lastRoute` guarda la última copia conocida para que el resto
// del código (findOriginAirport/updateProgress en flight-progress.js, que leen
// lastState.route) siga funcionando igual, con un desfasaje de a lo sumo ~1s, imperceptible.
let lastRoute=[];

// Procesa un estado nuevo, venga de donde venga (WS push o fetch de respaldo). Separado de
// poll() para que ambos caminos compartan exactamente la misma lógica de dibujado.
function handleState(s){
  lastState=s;
  lastState.route=lastRoute;
  const dbg=document.getElementById('debug-badge'); if(dbg) dbg.classList.toggle('hidden', !s.debug);
  // "null island" (lat 0, lon 0) = estás en el menú del sim, no en un vuelo real
  const nullIsland = (s.lat!=null && Math.abs(s.lat)<0.5 && Math.abs(s.lon)<0.5);
  const ready = s.connected && s.lat!=null && s.lon!=null && !nullIsland;
  showWaiting(!ready, s.connected);
  if(!ready) return;        // no dibujamos el avión hasta tener una posición real
  try{
    updatePlane(s);         // RÁPIDO (~10 Hz): solo alimenta el buffer de interpolación (barato)
    // PESADO (~1 Hz): panel, ruta, aeropuertos, gráfico. Así 10 lecturas/s NO ahogan el hilo principal.
    if(performance.now()-lastUi>900){
      lastUi=performance.now();
      updatePanel(s);
      updatePlaneIcon(s);   // cambia el ícono si el tipo de avión cambió
      updateFPlan(s);       // plan de vuelo del sim (línea magenta)
      if(!document.getElementById('status-modal').classList.contains('hidden')) renderStatus(s);
      sampleGraph(s);
      fetch('/api/route').then(r=>r.json()).then(d=>handleRoute(d.route||[])).catch(()=>{});
      maybeFetchNav(s.lat,s.lon);
      maybeFetchDestNav();          // aeropuertos y VOR alrededor del destino
      if(routeTarget) drawRoute();
      if(cur && (flags.apt||flags.vor)){ updateCircle(cur);
        if(!lastAptCenter || haversineNM(cur.lat,cur.lng,lastAptCenter.lat,lastAptCenter.lng)>5) renderNav(cur); }
      avisarGuardado(s);
    }
  }catch(e){ console.error('render:', e); }   // un hipo de dibujado no debe marcar "desconectado"
}
function handleRoute(r){
  lastRoute=r||[];
  if(lastState) lastState.route=lastRoute;
  updateRoute(lastRoute);
}

// ---- Transporte: polling HTTP ----
// Se probó reemplazar esto por WebSocket (push desde el server) y en la práctica salió
// PEOR: el servidor de desarrollo de Flask manda-y-duerme de forma secuencial, así que
// cualquier bache de la red atrasaba directamente el siguiente envío — algo que el
// polling no sufre, porque cada fetch sale independiente de los demás. Confirmado en
// el iPad real: se sintió más brusco y más espaciado. Se revirtió a propósito.
function poll(){
  fetch('/api/state').then(r=>r.json()).then(handleState)
    .catch(()=>{ showWaiting(true,false); });   // solo si falla la consulta al backend
}
function startTelemetry(){
  poll();
  setInterval(poll,100);   // 10 lecturas por segundo
}

// El backend cierra el vuelo solo al aterrizar y quedar quieto. Cuando eso pasa manda
// un timestamp nuevo en `guardado_en`: lo avisamos una sola vez.
let ultimoGuardado=null;
function avisarGuardado(s){
  const t=s && s.guardado_en;
  if(!t){ ultimoGuardado=null; return; }
  if(t===ultimoGuardado) return;
  ultimoGuardado=t;
  showToast('Vuelo guardado en el historial ✓');
}

// ---- Tamaño de los paneles ----
// Va al FINAL del script y dentro de su propia función a propósito. La vez pasada esto
// mismo se ejecutaba en medio del archivo y consultaba `chart`, que está declarado más
// abajo con `let`: leer una variable `let` antes de su línea lanza un error (y `typeof`
// NO protege de eso), así que el script se cortaba ahí y se caía media app. Acá abajo ya
// existe todo, y aun así el acceso al gráfico va diferido y envuelto en try.
(function(){
  const MIN=0.6, MAX=1.3;
  // Cada panel tiene su propia escala y su propio valor por defecto: el de datos se lee
  // todo el tiempo y conviene grande; el de progreso es de consulta y estorba menos chico.
  const PANELES=[
    { css:'--ui-izq', clave:'uiScaleIzq', def:1,   sl:'ui-izq', val:'ui-izq-val' },
    { css:'--ui-der', clave:'uiScaleDer', def:0.9, sl:'ui-der', val:'ui-der-val' },
  ];
  function aplicar(p, k, guardar){
    k=Math.round(Math.max(MIN,Math.min(MAX, parseFloat(k)||p.def))*10)/10;
    document.documentElement.style.setProperty(p.css, String(k));
    const sl=document.getElementById(p.sl); if(sl) sl.value=k;
    const val=document.getElementById(p.val); if(val) val.textContent=Math.round(k*100)+'%';
    if(guardar) localStorage.setItem(p.clave, String(k));
    // El canvas del gráfico hay que redimensionarlo a mano, con la medida SIN escalar
    if(p.css==='--ui-izq') setTimeout(function(){ try{ ajustarGrafico(); }catch(e){} }, 60);
  }
  PANELES.forEach(function(p){
    const g=parseFloat(localStorage.getItem(p.clave));
    aplicar(p, (g>=MIN&&g<=MAX)?g:p.def, false);
    const sl=document.getElementById(p.sl);
    if(sl) sl.oninput=function(){ aplicar(p, sl.value, true); };
  });
  const rst=document.getElementById('ui-reset');
  if(rst) rst.onclick=function(){ PANELES.forEach(function(p){ aplicar(p, p.def, true); }); };
})();
