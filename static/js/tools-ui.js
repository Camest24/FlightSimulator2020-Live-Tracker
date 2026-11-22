/* tools-ui.js — Paneles y utilidades sueltas: luces y hora (engranaje), buscador, estado del avion,
   historial, resumen de fin de vuelo, wake lock, dock de abajo y barra movible.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Engranaje de la barra: luces y hora del simulador ----
// Abre un menú con luces y hora (sus modales de siempre), "Mostrar parqueados" (un
// interruptor del tráfico IA) y, con ruta, añadir puntos y eliminar la ruta. Se cierra al
// abrir luces u hora, al empezar a añadir puntos o al tocar afuera; con parqueados queda
// abierto para que se vea si quedó prendido. No convive con el de capas.
// Eliminar ruta pide dos toques: el primero lo pone rojo ("¿Seguro? Tocá de nuevo") y el
// segundo la borra. Si no confirmás en 4 s vuelve a la normalidad.
(function(){
  const btn=document.getElementById('btn-ajustes'), menu=document.getElementById('ajustes');
  const capas=document.getElementById('layers'), btnCapas=document.getElementById('btn-layers');
  if(!btn||!menu) return;
  const borrar=document.getElementById('btn-borrar-ruta');
  let tBorrar=null;
  function borrarNormal(){ clearTimeout(tBorrar); tBorrar=null; if(!borrar) return;
    borrar.classList.remove('confirmar'); borrar.querySelector('span').textContent='Eliminar ruta'; }
  function abrir(on){
    menu.classList.toggle('hidden',!on); btn.classList.toggle('active',on);
    if(!on){ borrarNormal(); return; }
    menu.querySelectorAll('.aj-ruta').forEach(b=>b.disabled=!routeTarget);
  }
  if(borrar) borrar.addEventListener('click',()=>{
    if(!routeTarget) return;
    if(borrar.classList.contains('confirmar')){ borrarNormal(); clearRoute(); abrir(false); showToast('Ruta eliminada'); return; }
    borrar.classList.add('confirmar'); borrar.querySelector('span').textContent='¿Seguro? Tocá de nuevo';
    tBorrar=setTimeout(borrarNormal, 4000);
  });
  btn.addEventListener('click',()=>{
    const on=menu.classList.contains('hidden');
    if(on && capas && !capas.classList.contains('hidden')){ capas.classList.add('hidden'); btnCapas.classList.remove('active'); }
    abrir(on);
  });
  if(btnCapas) btnCapas.addEventListener('click',()=>abrir(false));
  // En captura: el botón de luces corta la propagación del click
  menu.addEventListener('click',e=>{ const b=e.target.closest('.aj-btn');
    if(b && !b.disabled && b.id!=='btn-parked' && b.id!=='btn-borrar-ruta') abrir(false); }, true);
  document.addEventListener('pointerdown',e=>{
    if(!menu.classList.contains('hidden') && !menu.contains(e.target) && !btn.contains(e.target)) abrir(false);
  }, true);
})();

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
document.getElementById('btn-status').onclick=(e)=>{ e.stopPropagation(); renderStatus(lastState);
  document.getElementById('status-modal').classList.remove('hidden'); };
document.getElementById('st-close').onclick=()=>document.getElementById('status-modal').classList.add('hidden');
document.getElementById('status-modal').addEventListener('click',(e)=>{ if(e.target.id==='status-modal') e.currentTarget.classList.add('hidden'); });

// ---- Historial de vuelos ----
function fmtFecha(ts){
  if(!ts) return '';
  const d=new Date(ts*1000);
  return d.toLocaleDateString([], {day:'2-digit', month:'short'})+' · '+
         d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function renderHist(list){
  const box=document.getElementById('hist-body');
  if(!list.length){ box.innerHTML='<div class="hist-empty">Todavía no hay vuelos guardados.<br>Se guardan solos al aterrizar y quedar quieto en tierra.</div>'; return; }
  box.innerHTML=list.map(f=>{
    const de=f.from_icao||'----', a=f.to_icao||'----';
    const kms=km(f.distance_nm);
    const min=(f.start_time&&f.end_time)?Math.round((f.end_time-f.start_time)/60):0;
    const alt=f.max_alt_ft?Math.round(f.max_alt_ft).toLocaleString('en-US')+' ft':'';
    return '<div class="hist-item">'
      +'<span class="hist-main"><span class="hist-route">'+de+' → '+a+'</span>'
      +'<span class="hist-sub">'+fmtFecha(f.start_time)+(alt?(' · máx '+alt):'')
        +(f.landing_fpm!=null?(' · toque '+nf(f.landing_fpm)+' ft/min'):'')+'</span></span>'
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

// ---- Aterrizaje y fin del vuelo ----
// Qué tal estuvo el toque, en ft/min (negativo = bajando). Los cortes son los habituales
// entre simmers: menos de 60 es "mantequilla", más de 600 ya es para revisar el tren.
function calificarAterrizaje(fpm){
  const v=Math.abs(fpm);
  if(v<60)  return {txt:'muy suave', color:'#4ade80'};
  if(v<240) return {txt:'suave', color:'#4ade80'};
  if(v<400) return {txt:'firme', color:'#fbbf24'};
  if(v<600) return {txt:'duro', color:'#fb923c'};
  return {txt:'muy duro', color:'#ef4444'};
}
// El backend marca cada toque de pista en `aterrizaje` (ver _registrar_aterrizaje): se
// avisa al toque, sin esperar a que el vuelo se cierre.
let ultimoToquePista=null;
function avisarAterrizaje(s){
  const a=s && s.aterrizaje;
  if(!a || a.t===ultimoToquePista) return;
  const primera=ultimoToquePista===null && (Date.now()/1000 - a.t) > 20;   // viejo: al abrir la app
  ultimoToquePista=a.t;
  if(primera) return;
  const c=calificarAterrizaje(a.fpm);
  showToast('Aterrizaje: '+nf(a.fpm)+' ft/min · '+c.txt);
}

// El backend cierra el vuelo solo al aterrizar y quedar quieto. Cuando eso pasa manda
// un timestamp nuevo en `guardado_en`: se muestra el resumen una sola vez.
let ultimoGuardado=null;
function avisarGuardado(s){
  avisarAterrizaje(s);
  const t=s && s.guardado_en;
  if(!t){ ultimoGuardado=null; return; }
  if(t===ultimoGuardado) return;
  const primera=ultimoGuardado===null && (Date.now()/1000 - t) > 120;      // ya estaba guardado al abrir
  ultimoGuardado=t;
  if(primera) return;
  fetch('/api/history').then(r=>r.json()).then(list=>{
    const f=(list||[]).reduce((a,b)=>(!a||b.id>a.id)?b:a, null);
    if(f) mostrarResumen(f); else showToast('Vuelo guardado en el historial ✓');
  }).catch(()=>showToast('Vuelo guardado en el historial ✓'));
}
function mostrarResumen(f){
  const min = f.flight_min || ((f.start_time&&f.end_time)?(f.end_time-f.start_time)/60:0);
  const celdas=[
    ['Distancia', nf(km(f.distance_nm))+' km', Math.round(f.distance_nm||0)+' NM'],
    // Debajo, lo que duró en la vida real (con sim rate x4 es mucho menos)
    ['Tiempo de vuelo', fmtHm(min), (f.takeoff_real&&f.end_time)?('real '+fmtHm((f.end_time-f.takeoff_real)/60)):'reloj del simulador'],
    ['Altura máxima', f.max_alt_ft?fmtFL(f.max_alt_ft):'--', f.max_alt_ft?nf(Math.round(f.max_alt_ft))+' ft':''],
    ['Combustible usado', f.fuel_used_gal!=null?nf(Math.round(f.fuel_used_gal))+' gal':'--',
      f.fuel_used_gal!=null?nf(Math.round(f.fuel_used_gal*3.78541))+' L':'sin dato'],
  ];
  let html='<div class="rs-ruta">'+(f.from_icao||'----')+'<i>→</i>'+(f.to_icao||'----')+'</div>'
    +'<div class="rs-nombres">'+(f.from_name||'')+(f.to_name?' → '+f.to_name:'')+'</div><div class="rs-grid">';
  celdas.forEach(c=>{ html+='<div><span>'+c[0]+'</span><b>'+c[1]+'</b><small>'+c[2]+'</small></div>'; });
  if(f.landing_fpm!=null){
    const c=calificarAterrizaje(f.landing_fpm);
    html+='<div class="rs-aterrizaje"><span>Aterrizaje</span><b style="color:'+c.color+'">'+nf(f.landing_fpm)
      +' ft/min</b><small>'+c.txt+'</small></div>';
  }
  document.getElementById('rs-body').innerHTML=html+'</div>';
  document.getElementById('resumen-modal').classList.remove('hidden');
}
document.getElementById('rs-close').onclick=()=>document.getElementById('resumen-modal').classList.add('hidden');
document.getElementById('resumen-modal').addEventListener('click',e=>{ if(e.target.id==='resumen-modal') e.currentTarget.classList.add('hidden'); });


// ---- Dock de abajo: estante (•••) y su alto ----
(function(){
  const pila=document.getElementById('dock-pila'), dock=document.getElementById('dock');
  const est=document.getElementById('dock-estante'), mas=document.getElementById('dk-mas');
  if(!pila||!dock||!est||!mas) return;
  // Antes los paneles de datos y de progreso se movían y giraban: lo guardado ya no sirve
  try{ ['movible.left-stack','movible.progress-panel','movible.bottom-center'].forEach(k=>localStorage.removeItem(k)); }catch(e){}
  // El estante se recuerda abierto o cerrado. La primera vez arranca abierto (como en el
  // diseño), así se ve que existe.
  let abierto=true;
  try{ abierto=localStorage.getItem('dock.estante')!=='0'; }catch(e){}
  function pintar(){ est.classList.toggle('hidden',!abierto); mas.classList.toggle('on',abierto); }
  mas.addEventListener('click',()=>{
    abierto=!abierto; pintar();
    try{ localStorage.setItem('dock.estante',abierto?'1':'0'); }catch(e){}
  });
  pintar();
  // La brújula, la "P", el zoom y el chip de la ruta se apoyan encima del dock (main.css).
  // Y cada vez que cambia de alto (ruta, estante, gráfico) el avión se recentra en lo que
  // queda de mapa.
  const raiz=document.documentElement;
  let tC=null;
  function medir(){
    raiz.style.setProperty('--dock-alto', dock.offsetHeight+'px');
    raiz.style.setProperty('--pila-alto', pila.offsetHeight+'px');
    clearTimeout(tC); tC=setTimeout(()=>{ try{ revisarCentrado(); }catch(e){} }, 150);
  }
  try{ const ro=new ResizeObserver(medir); ro.observe(pila); ro.observe(dock); }
  catch(e){ window.addEventListener('resize',medir); }
  medir();
})();

// ---- Barra de arriba movible ----
// Se arrastra desde su tirador, tocarlo la gira (horizontal / vertical) y mantenerlo
// pulsado la devuelve arriba al centro. Todo se recuerda entre sesiones. En celular no
// aplica: ahí va fija (main.css).
// Los paneles de datos y de progreso también se movían y giraban; desde el dock
// (2026-11-21) son solo horizontales y fijos abajo, así que quedó solo la barra.
// Se usan pointer events (mouse y dedo con el mismo código; Safari de iPad los tiene).
(function(){
  const PANELES=[
    { id:'toolbar',        asa:'#btn-asa-barra', giro:null,                 def:'h', nombre:'Barra', tocarGira:true },
  ];
  const clave=c=>'movible.'+c.id;
  function leer(c){ try{ return JSON.parse(localStorage.getItem(clave(c)))||{}; }catch(e){ return {}; } }
  function escribir(c,d){ try{ localStorage.setItem(clave(c),JSON.stringify(d)); }catch(e){} }

  // Lo saca de su lugar y lo deja en x,y de pantalla
  function soltar(c, el){ el.classList.add('movido'); }
  function ubicar(c, el, x, y){
    const r=el.getBoundingClientRect();
    if(r.width){                                   // oculto no se puede medir: se deja tal cual
      x=Math.max(4, Math.min(window.innerWidth-r.width-4, x));
      y=Math.max(4, Math.min(window.innerHeight-Math.min(r.height,120)-4, y));
    }
    el.style.left=Math.round(x)+'px'; el.style.top=Math.round(y)+'px';
  }
  // Vuelve a su lugar de siempre
  function limpiar(c, el){
    el.classList.remove('movido');
    el.style.left=''; el.style.top='';
  }
  function orientar(c, el, o){ el.dataset.orient=o; }
  function aplicar(c){
    const el=document.getElementById(c.id); if(!el) return;
    if(pantallaChica()){ limpiar(c,el); el.dataset.orient=c.def; return; }
    const d=leer(c);
    orientar(c, el, d.o||c.def);
    if(d.x!=null && d.y!=null){ soltar(c,el); requestAnimationFrame(()=>ubicar(c,el,d.x,d.y)); }
    else limpiar(c,el);
  }
  function girar(c){
    const el=document.getElementById(c.id), d=leer(c);
    d.o=(el.dataset.orient==='h')?'v':'h';
    orientar(c, el, d.o); escribir(c,d);
    if(el.classList.contains('movido')){ const r=el.getBoundingClientRect(); requestAnimationFrame(()=>ubicar(c,el,r.left,r.top)); }
    showToast(c.nombre+': '+(d.o==='h'?'horizontal':'vertical'));
  }
  function resetear(c){
    const el=document.getElementById(c.id);
    try{ localStorage.removeItem(clave(c)); }catch(e){}
    limpiar(c,el); orientar(c, el, c.def);
    try{ revisarCentrado(); }catch(e){}
    showToast(c.nombre+' en su lugar');
  }

  PANELES.forEach(c=>{
    const el=document.getElementById(c.id), asa=document.querySelector(c.asa);
    if(!el || !asa) return;
    asa.style.touchAction='none';
    let p=null;                                     // arrastre en curso
    asa.addEventListener('pointerdown',e=>{
      if(pantallaChica() || e.button>0) return;
      p={x0:e.clientX, y0:e.clientY, movio:false, id:e.pointerId};
      p.t=setTimeout(()=>{ if(p && !p.movio){ asa.classList.remove('agarrado'); p=null; resetear(c); } }, 700);
      asa.classList.add('agarrado');
      try{ asa.setPointerCapture(e.pointerId); }catch(err){}
      e.preventDefault();
    });
    asa.addEventListener('pointermove',e=>{
      if(!p || e.pointerId!==p.id) return;
      if(!p.movio){
        if(Math.hypot(e.clientX-p.x0, e.clientY-p.y0)<6) return;   // umbral: toque vs arrastre
        p.movio=true; clearTimeout(p.t);
        const r=el.getBoundingClientRect();
        p.dx=p.x0-r.left; p.dy=p.y0-r.top;
        soltar(c,el); ubicar(c,el,r.left,r.top);
      }
      ubicar(c, el, e.clientX-p.dx, e.clientY-p.dy);
    });
    const fin=e=>{
      if(!p || (e && e.pointerId!==p.id)) return;
      clearTimeout(p.t); asa.classList.remove('agarrado');
      const movio=p.movio; p=null;
      if(movio){
        const d=leer(c), r=el.getBoundingClientRect();
        d.x=r.left; d.y=r.top; escribir(c,d);
        try{ revisarCentrado(); }catch(err){}
      } else if(c.tocarGira) girar(c);
    };
    asa.addEventListener('pointerup',fin);
    asa.addEventListener('pointercancel',fin);
    // El tirador de la barra es un botón: que su click no haga nada más
    if(c.tocarGira) asa.addEventListener('click',e=>e.preventDefault());
    const g=c.giro && document.querySelector(c.giro);
    if(g) g.addEventListener('click',e=>{ e.stopPropagation(); if(!pantallaChica()) girar(c); });
    aplicar(c);
  });

  // Al rotar el iPad o cambiar el tamaño: que nada quede fuera de la pantalla, y al pasar a
  // celular (o volver) se aplica o se quita todo.
  let tRes=null;
  window.addEventListener('resize',()=>{ clearTimeout(tRes); tRes=setTimeout(()=>PANELES.forEach(aplicar),200); });
  try{ MQ_CHICA.addEventListener('change',()=>PANELES.forEach(aplicar)); }catch(e){}
})();
