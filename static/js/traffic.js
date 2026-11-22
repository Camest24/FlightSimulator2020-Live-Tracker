// ---- Tráfico IA (AIG / FSLTL / MSFS) — backend: server/traffic.py ----
// Usa el mismo radio que los aeropuertos (aptRadius): el botón de radio decide también
// cuánto tráfico se ve. El backend lee el sim cada 2 s; entre lectura y lectura cada avión
// se extrapola con su rumbo y velocidad (4 Hz) para que no avance a saltos de ~250 m.
flags.traffic=true;
let trafficData=[], trafficT=0, trafficSel=null, trafficMaxNM=108;
// Estacionados y apagados (a.activo===false, ver _publicar en server/traffic.py): ocultos por
// defecto, como en un radar real. El botón "P" los muestra; la elección se recuerda.
flags.parked=(()=>{ try{ return localStorage.getItem('traffic.parked')==='1'; }catch(e){ return false; } })();
const trafficVisible=a=>flags.parked || a.activo!==false;

// ---- Íconos: la MISMA silueta y el mismo amarillo que el avión propio (geo-utils.js) ----
// Se arman desde esos SVG para que un cambio de dibujo allá se vea igual acá. Dos colores
// por forma: amarillo normal y rojo para el seleccionado. El propio se distingue por el pin azul.
const TRAFFIC_FORMAS={
  jet:   c=>planeSilhouette(c,88,'#0f172a'),
  quad:  c=>planeQuadJet(c,88,'#0f172a'),
  prop:  c=>planeTurboprop(c,88,'#0f172a'),
  heli:  c=>planeHeli(c,88,'#0f172a'),
  piston:c=>planeSVG(c,88,'#0f172a'),
};
const TRAFFIC_COLORES={w:'#fbbf24', sel:'#ef4444'};
function loadTrafficImages(){
  Object.entries(TRAFFIC_FORMAS).forEach(([forma,svg])=>{
    Object.entries(TRAFFIC_COLORES).forEach(([suf,color])=>{
      const id='ai-'+forma+'-'+suf, img=new Image(88,88);
      img.onload=()=>{ if(!map.hasImage(id)) map.addImage(id,img,{pixelRatio:2}); };
      // los SVG de geo-utils.js se usan inline en el DOM y no traen xmlns; como imagen sí hace falta
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg(color).replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" '));
    });
  });
}

function trafficIconExpr(){
  return ['concat','ai-',['get','forma'],['case',['==',['get','id'],trafficSel==null?-1:trafficSel],'-sel','-w']];
}

function initTraffic(){
  loadTrafficImages();
  map.addSource('traffic',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('traffic-route',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  const antes=map.getLayer('planroute-label') ? 'planroute-label' : undefined;
  // Ruta del seleccionado: lo volado sólido y tenue, lo que falta punteado (como en Flightradar)
  // (dos capas: line-dasharray no acepta expresiones por dato en MapLibre)
  map.addLayer({id:'traffic-route-hecho',type:'line',source:'traffic-route',filter:['get','hecho'],layout:{'line-cap':'round'},
    paint:{'line-color':'#ffffff','line-width':2,'line-opacity':0.45}},antes);
  map.addLayer({id:'traffic-route-falta',type:'line',source:'traffic-route',filter:['!',['get','hecho']],
    paint:{'line-color':'#ffffff','line-width':2,'line-opacity':0.85,'line-dasharray':[2,2]}},antes);
  map.addLayer({id:'traffic-icon',type:'symbol',source:'traffic',
    layout:{'icon-image':trafficIconExpr(),'icon-size':['interpolate',['linear'],['zoom'],5,0.62,9,0.75,13,0.9],
      'icon-rotate':['get','hdg'],'icon-rotation-alignment':'map','icon-allow-overlap':true,'icon-ignore-placement':true},
    paint:{
      // (MapLibre exige 'zoom' en el interpolate de afuera: el case va adentro, no al revés)
      'icon-opacity':['interpolate',['linear'],['zoom'],8,['case',['get','ground'],0,1],10,1]}},
    antes);
  // Las etiquetas (logo + callsign) NO son texto de la capa: son marcadores HTML, ver
  // updateTrafficLabels() — una capa symbol no puede mostrar el logo de cada aerolínea.
  map.on('click','traffic-icon',(e)=>{ selectTraffic(e.features[0].properties.id); });
  // Tocar el mapa fuera de un avión cierra la tarjeta (además de lo que ya hace ese toque)
  map.on('click',(e)=>{
    if(trafficSel==null) return;
    if(!map.queryRenderedFeatures(e.point,{layers:['traffic-icon']}).length) closeTrafficCard();
  });
  map.on('mouseenter','traffic-icon',()=>{ map.getCanvas().style.cursor='pointer'; });
  map.on('mouseleave','traffic-icon',()=>{ map.getCanvas().style.cursor=''; });
  fetchTraffic();
  setInterval(fetchTraffic,2000);
  setInterval(renderTraffic,250);
}
if(map.loaded()) initTraffic(); else map.on('load',initTraffic);

function fetchTraffic(){
  if(!flags.traffic || document.hidden) return;
  fetch('/api/traffic?radius='+aptRadius).then(r=>r.json()).then(d=>{
    trafficData=d.aircraft||[]; trafficT=performance.now(); trafficMaxNM=d.radio_max_nm||108;
    const vis=trafficData.filter(trafficVisible).length, ocultos=trafficData.length-vis;
    const n=document.getElementById('traffic-count');
    if(n) n.textContent=!d.conectado ? '· sin conexión'
      : '· '+vis+(ocultos?' (+'+ocultos+' apagados)':'')+(aptRadius>trafficMaxNM?' · máx '+trafficMaxNM+' NM':'');
    const b=document.getElementById('btn-parked');
    if(b) b.title=(flags.parked?'Ocultar':'Mostrar')+' aviones estacionados y apagados'+(ocultos?' ('+ocultos+')':'');
    renderTraffic();
  }).catch(()=>{});
}

function trafficPos(a){
  const dt=Math.min(6,(performance.now()-trafficT)/1000);   // si el backend se cuelga, no seguir de largo
  if(a.on_ground || !(a.gs>30)) return [a.lon,a.lat];
  return dest(a.lat,a.lon,a.hdg,a.gs*0.514444*dt);           // kt -> m/s
}

function renderTraffic(){
  const src=map.getSource('traffic'); if(!src) return;
  if(document.hidden) return;   // pestaña en segundo plano: nadie lo ve, no gastar CPU 4 veces por segundo
  if(!flags.traffic){ src.setData({type:'FeatureCollection',features:[]}); updateTrafficLabels({}); return; }
  const pos={};
  const vis=trafficData.filter(trafficVisible);
  // El seleccionado se apagó (o se ocultaron los estacionados): la tarjeta se cierra con él
  if(trafficSel!=null && !vis.some(a=>a.id===trafficSel)){ closeTrafficCard(); return; }
  const feats=vis.map(a=>{ pos[a.id]=trafficPos(a);
    return {type:'Feature',geometry:{type:'Point',coordinates:pos[a.id]},
      properties:{id:a.id,hdg:a.hdg,forma:a.forma||'jet',ground:!!a.on_ground}}; });
  src.setData({type:'FeatureCollection',features:feats});
  updateTrafficLabels(pos);
  if(trafficSel!=null) updateTrafficCard();
}

// ---- Etiquetas estilo Flightradar: cajita blanca con el logo de la aerolínea y el callsign ----
// Logos del CDN público pics.avs.io por código IATA. Si no hay logo (o la aerolínea no está
// en la tabla del backend) queda el nombre en su color, o solo el callsign.
const trafficLabels=new Map();   // id -> {m: Marker, el, key}

function fillTrafficLabel(el,a){
  el.innerHTML='';
  const nombre=()=>{ const i=document.createElement('i'); i.textContent=a.aerolinea; i.style.setProperty('--h',airlineHue(a.aerolinea_icao||a.aerolinea)); return i; };
  if(a.aerolinea_iata && !(a.on_ground && a.gs<2)){
    const img=document.createElement('img'); img.alt='';
    img.src='https://pics.avs.io/120/36/'+encodeURIComponent(a.aerolinea_iata)+'.png';
    img.onerror=()=>{ img.replaceWith(nombre()); };
    el.appendChild(img);
  } else if(a.aerolinea && !(a.on_ground && a.gs<2)){
    el.appendChild(nombre());
  }
  const b=document.createElement('b'); b.textContent=a.etiqueta||''; el.appendChild(b);
}

function updateTrafficLabels(pos){
  const z=map.getZoom(), vivos=new Set();
  // Solo las cajitas que caen en pantalla (con un margen): cada una es un elemento HTML que se
  // mueve 4 veces por segundo, y con AIG en un hub la mayoría queda fuera de la vista.
  const b=map.getBounds(), dLat=(b.getNorth()-b.getSouth())*0.15, dLng=(b.getEast()-b.getWest())*0.15;
  const s=b.getSouth()-dLat, n=b.getNorth()+dLat, w=b.getWest()-dLng, e=b.getEast()+dLng;
  for(const a of trafficData){
    // En vuelo desde zoom 6; los estacionados recién a zoom de plataforma (13): un hub
    // de AIG con cientos de cajitas taparía el aeropuerto entero.
    if(!pos[a.id] || !(a.on_ground ? z>=13 : z>=6)) continue;
    const [lng,lat]=pos[a.id];
    if(lat<s || lat>n || lng<w || lng>e) continue;
    vivos.add(a.id);
    let L=trafficLabels.get(a.id);
    if(!L){
      const el=document.createElement('div'); el.className='ac-label';
      // stopPropagation: sin esto el mismo toque llega al mapa, que suelta el seguimiento y cierra la tarjeta
      el.addEventListener('click',e=>{ e.stopPropagation(); selectTraffic(a.id); });
      L={el,key:null,m:new maplibregl.Marker({element:el,anchor:'top-left',offset:[14,6]}).setLngLat(pos[a.id]).addTo(map)};
      trafficLabels.set(a.id,L);
    }
    const key=(a.aerolinea_iata||'')+'|'+(a.aerolinea||'')+'|'+(a.etiqueta||'')+'|'+(a.on_ground?1:0);
    if(L.key!==key){ fillTrafficLabel(L.el,a); L.key=key; }   // reconstruir solo si cambió (el logo no recarga)
    L.m.setLngLat(pos[a.id]);
    L.el.classList.toggle('sel',a.id===trafficSel);
  }
  for(const [id,L] of trafficLabels) if(!vivos.has(id)){ L.m.remove(); trafficLabels.delete(id); }
}

// ---- Tarjeta del avión seleccionado ----
function trafficAlt(ft){ return ft>=18000 ? 'FL'+String(Math.round(ft/100)).padStart(3,'0') : nf(Math.round(ft))+' ft'; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// Color estable por aerolínea (mismo ICAO, mismo color), para el distintivo de la tarjeta
function airlineHue(code){ let h=0; for(const ch of (code||'?')) h=(h*31+ch.charCodeAt(0))%360; return h; }

function selectTraffic(id){
  trafficSel=id;
  map.setLayoutProperty('traffic-icon','icon-image',trafficIconExpr());
  const a=trafficData.find(x=>x.id===id); if(!a) return;
  buildTrafficCard(a);
  renderTraffic();
}

function closeTrafficCard(){
  trafficSel=null;
  document.getElementById('ac-card').classList.add('hidden');
  if(map.getLayer('traffic-icon')) map.setLayoutProperty('traffic-icon','icon-image',trafficIconExpr());
  const r=map.getSource('traffic-route'); if(r) r.setData({type:'FeatureCollection',features:[]});
  renderTraffic();
}

// ---- Foto del avión: JetPhotos primero, Wikimedia Commons de respaldo ----
// JetPhotos (con permiso para este proyecto académico, sin uso comercial) entra por el
// backend: /api/jetphoto -> server/jetphotos.py -> API no oficial de roowus en local. Solo
// se pide por matrícula exacta: una foto de otro avión de JetPhotos no se muestra como
// "referencia". Si el servicio no está o no hay foto, sigue Commons, que tiene licencia libre
// (CC) y su API está hecha para llamarse desde el navegador (origin=*). Planespotters prohíbe
// pasar por un servidor propio y no acepta pedidos desde otra página (CORS).
// Ambos piden crédito: autor + enlace a la página de la foto (+ licencia en Commons).
const trafficFotos=new Map();   // matrícula (o aerolínea|tipo) -> Promise<foto|null>
const normReg=s=>(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');

function commonsBuscar(q,filtro){
  const url='https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*'
    +'&generator=search&gsrnamespace=6&gsrlimit=6&gsrsearch='+encodeURIComponent(q+' filetype:bitmap')
    +'&prop=imageinfo&iiprop=url|extmetadata&iiextmetadatafilter=Artist|LicenseShortName&iiurlwidth=640';
  return fetch(url,{headers:{'Api-User-Agent':'MSFS-Live-Tracker/2.0'}}).then(r=>r.json()).then(d=>{
    const pages=Object.values((d.query&&d.query.pages)||{}).sort((x,y)=>x.index-y.index);
    // La búsqueda de Commons es por texto libre: se exige que el NOMBRE del archivo tenga lo buscado
    const p=pages.find(p=>p.imageinfo && p.imageinfo[0].thumburl && filtro(p.title));
    if(!p) return null;
    const ii=p.imageinfo[0], md=ii.extmetadata||{};
    const tmp=document.createElement('div'); tmp.innerHTML=md.Artist?md.Artist.value:'';   // viene como HTML
    return {src:ii.thumburl, link:ii.descriptionurl, autor:tmp.textContent.trim(),
            licencia:md.LicenseShortName?md.LicenseShortName.value:'', titulo:p.title};
  }).catch(()=>null);
}

// Familia del avión ("A320", "737", "ATR72", "E19"...) para comparar el tipo del sim con el
// de la foto. Gruesa a propósito: una A320 y una A320neo, o un 737-800 y un 737 MAX, son la
// misma familia y la foto sirve igual. null = no se reconoce (otro tipo, helicóptero...).
function familiaAvion(s){
  const t=(s||'').toUpperCase(); let m;
  if(/A ?220|BCS[13]|CS[13]00/.test(t)) return 'A220';
  if((m=t.match(/A ?(3\d\d)/))) return 'A'+m[1];
  if((m=t.match(/(?:^|[^0-9])7([0-8])7(?![0-9])/))) return '7'+m[1]+'7';
  if((m=t.match(/ATR ?-?(42|72)/))) return 'ATR'+m[1];
  if((m=t.match(/(?:ERJ|EMB|\bE)[ -]?(1[79]|2[09])\d/))) return 'E'+m[1];
  if(/CRJ|CANADAIR REGIONAL/.test(t)) return 'CRJ';
  if(/DASH ?8|DHC-8|Q400|DH8/.test(t)) return 'DH8';
  if(/CARAVAN|C208|CESSNA 208/.test(t)) return 'C208';
  if(/BEECH.*1900|B190/.test(t)) return 'B190';
  if(/MD-?11/.test(t)) return 'MD11';
  return null;
}

// Que la matrícula coincida no alcanza: en la flota falsa de --debug las matrículas son
// inventadas (HK-4842 salía un helicóptero en un ATR 42), y en la vida real una matrícula se
// puede reasignar. Si el tipo de la foto es de OTRA familia que el del sim, la foto pasa a
// "Referencia". `estricto`: el tipo viene de un campo propio (JetPhotos), así que un tipo que
// no se reconoce también cuenta como distinto; en Commons solo hay el nombre del archivo,
// que muchas veces no dice el tipo, y ahí solo se marca si nombra otra familia.
function chequearTipo(f,a,tipoFoto,estricto){
  const fs=familiaAvion(a.tipo)||familiaAvion(a.tipo_codigo);
  const fp=familiaAvion(tipoFoto);
  const distinto=!!fs && (fp ? fp!==fs : (estricto && !!tipoFoto));
  return Object.assign(f,{exacta:!distinto,
    motivo: distinto ? 'La matrícula coincide pero la foto es de otro tipo ('+(tipoFoto||'?')+'); en el simulador es '+(a.tipo||a.tipo_codigo) : ''});
}

// Caché que sobrevive a recargar la página y a cerrar la app: AIG repite los mismos aviones
// de una sesión a otra, y así la foto de una matrícula ya vista sale al instante sin consultar
// a nadie (la imagen en sí la guarda el caché HTTP del navegador). Solo se guardan las fotos
// EXACTAS: una "Referencia" o un "sin foto" pueden deberse a que JetPhotos estaba caído, y no
// deben quedar pegados 30 días; esos se resuelven de nuevo (el backend también los cachea).
const FOTO_LS='acfoto:v1:', FOTO_TTL=30*86400e3;
function fotoGuardada(key){
  try{
    const v=JSON.parse(localStorage.getItem(FOTO_LS+key)||'null');
    if(v && v.t+FOTO_TTL>Date.now()) return v.f;
  }catch(e){}
  return null;
}
function guardarFoto(key,f){
  try{ localStorage.setItem(FOTO_LS+key, JSON.stringify({t:Date.now(),f})); }catch(e){ /* lleno o bloqueado: no pasa nada */ }
}

function fotoDe(a){
  const key=a.matricula||((a.aerolinea||'')+'|'+(a.tipo||''));
  if(trafficFotos.has(key)) return trafficFotos.get(key);
  const guardada=a.matricula && fotoGuardada(key);
  if(guardada){ const p=Promise.resolve(guardada); trafficFotos.set(key,p); return p; }
  const p=(async()=>{
    let reserva=null;   // foto de la matrícula exacta pero de otro tipo: solo si no aparece nada mejor
    if(a.matricula){
      try{
        const j=await fetch('/api/jetphoto?reg='+encodeURIComponent(a.matricula)).then(r=>r.json());
        if(j.foto){ const f=chequearTipo(j.foto,a,j.foto.tipo,true); if(f.exacta) return f; reserva=f; }
      }catch(e){ /* servicio caído: se sigue con Commons */ }
      const r=normReg(a.matricula);
      const f=await commonsBuscar('"'+a.matricula+'"', t=>normReg(t).includes(r));
      if(f){ const g=chequearTipo(f,a,f.titulo,false); if(g.exacta) return g; reserva=reserva||g; }
    }
    // Sin foto de esa matrícula: una de la MISMA aerolínea y familia de avión, marcada como referencia
    const fam=((a.tipo||'').match(/A\d{3}|7[0-8]7|ATR ?\d{2}|E1\d{2}|CRJ\d+|Dash 8/i)||[''])[0];
    const air=(a.aerolinea||'').split(' ')[0];
    if(air && fam){
      const f=await commonsBuscar('"'+a.aerolinea+'" '+fam, t=>normReg(t).includes(normReg(air)) && normReg(t).includes(normReg(fam)));
      if(f) return Object.assign(f,{exacta:false});
    }
    // Una foto del tipo correcto (aunque sea otro avión) explica mejor que la de la matrícula
    // con otro tipo: por eso la reserva va al final.
    return reserva;
  })().then(f=>{
    if(f && f.exacta && a.matricula) guardarFoto(key,f);
    // "Sin foto" no se recuerda toda la sesión: la primera consulta levanta el servicio de
    // JetPhotos (~25 s en frío) y puede volver vacía aunque la foto exista. Al minuto se reintenta.
    if(!f) setTimeout(()=>trafficFotos.delete(key),60e3);
    return f;
  });
  trafficFotos.set(key,p);
  return p;
}

function aptBlock(ap,lado){
  if(!ap) return '<div class="acc-apt '+lado+'"><b>—</b><span>?</span></div>';
  const lugar=ap.city||ap.name||'';
  return '<div class="acc-apt '+lado+'" title="'+esc(ap.name||'')+'"><b>'+esc(ap.icao)+'</b><span>'+esc(lugar)+'</span></div>';
}

// Se arma UNA vez por selección; después updateTrafficCard() solo toca los textos que
// cambian (4 veces por segundo), así la foto no parpadea ni se pierde el scroll.
function buildTrafficCard(a){
  const card=document.getElementById('ac-card');
  const code=a.aerolinea_icao||(a.callsign||'').slice(0,3)||'IA';
  const titulo=a.vuelo||a.callsign||a.matricula||'Tráfico';
  // Línea de abajo del título: aerolínea + callsign (si el título es el vuelo comercial)
  const sub=[a.aerolinea, a.callsign && a.callsign!==titulo ? a.callsign : ''].filter(Boolean).join(' · ');
  const ruta=(a.origen||a.destino)
    ? '<div class="acc-route">'+aptBlock(a.origen,'l')
      +'<div class="acc-mid"><div class="acc-bar"><div class="acc-fill" data-k="fill"></div>'
      +'<div class="acc-plane" data-k="plane">'+planeSilhouette('#fbbf24',18,'#0f172a')+'</div></div>'
      +'<div class="acc-phase" data-k="phase"></div></div>'+aptBlock(a.destino,'r')+'</div>'
    : '<div class="acc-noplan" data-k="phase"></div>';
  // Pie: tipo de avión, matrícula y, si la hay, el enlace a todas sus fotos en JetPhotos
  // (la foto de la tarjeta es solo una; las demás son de los fotógrafos, en su página).
  const ficha=[a.tipo||a.tipo_codigo, a.matricula].filter(Boolean).map(esc).join(' · ');
  const fotos=a.matricula ? '<a class="acc-jp" href="https://www.jetphotos.com/registration/'+encodeURIComponent(a.matricula)
    +'" target="_blank" rel="noopener" title="Fotos de '+esc(a.matricula)+' en JetPhotos">Fotos ↗</a>' : '';
  card.innerHTML=
    '<div class="acc-head"><div class="acc-badge" style="--h:'+airlineHue(code)+'">'+esc(code)+'</div>'
    +'<div class="acc-titles"><div class="acc-call">'+esc(titulo)+'</div><div class="acc-sub">'+esc(sub||'Tráfico IA')+'</div></div>'
    +'<button class="acc-x" aria-label="Cerrar">✕</button></div>'
    +'<div class="acc-photo hidden" data-k="photo"></div>'
    +ruta
    +'<div class="acc-grid">'
    +'<div><span>Altitud</span><b data-k="alt"></b></div>'
    +'<div><span>Velocidad</span><b data-k="gs"></b></div>'
    +'<div><span>V/S · fpm</span><b data-k="vs"></b></div>'
    +'<div><span>Rumbo</span><b data-k="hdg"></b></div>'
    +'<div class="wide"><span>Distancia a ti</span><b data-k="dist"></b></div></div>'
    +'<div class="acc-foot"><div class="acc-fase" data-k="fase"></div><span>'+(ficha||'—')+'</span>'+fotos+'</div>';
  card.querySelector('.acc-x').onclick=closeTrafficCard;
  card.classList.remove('hidden');
  updateTrafficCard();
  const pedida=a.id;
  fotoDe(a).then(f=>{
    const box=card.querySelector('[data-k="photo"]');
    if(!f || !box || trafficSel!==pedida) return;     // sin foto (o ya se eligió otro avión): no ocupa lugar
    const fuente=f.fuente||'Wikimedia Commons';
    // no-referrer: el CDN de JetPhotos rechaza (hotlink) los pedidos con Referer de otra página
    box.innerHTML='<a href="'+esc(f.link)+'" target="_blank" rel="noopener" title="Ver en '+esc(fuente)+'">'
      +'<img src="'+esc(f.src)+'" alt="'+esc(a.tipo||'')+'" referrerpolicy="no-referrer"></a>'
      +(f.exacta?'':'<span class="acc-ref" title="'+esc(f.motivo||'No hay foto de esta matrícula: es otro avión de la misma aerolínea y tipo')+'">Referencia</span>')
      +'<span class="acc-credit">© '+esc(f.autor||'Desconocido')+(f.licencia?' · '+esc(f.licencia):'')+' · '+esc(fuente)+'</span>';
    const img=box.querySelector('img');
    img.onload=()=>box.classList.remove('hidden');   // se muestra recién cuando cargó: nada de cuadro vacío
    img.onerror=()=>box.classList.add('hidden');
  });
}

function updateTrafficCard(){
  const card=document.getElementById('ac-card');
  const a=trafficData.find(x=>x.id===trafficSel);
  if(!a){ closeTrafficCard(); return; }        // salió del radio o el sim lo borró
  const set=(k,v)=>{ const e=card.querySelector('[data-k="'+k+'"]'); if(e && e.innerHTML!==v) e.innerHTML=v; };
  const vs=Math.round(a.vs/50)*50;
  set('alt', a.on_ground ? 'En tierra' : trafficAlt(a.alt));
  set('gs', Math.round(a.gs)+' <small>kt</small>');
  set('vs', Math.abs(vs)<100 ? '—' : (vs>0?'↑':'↓')+nf(Math.abs(vs)));   // la unidad va en la etiqueta: no entra en la celda
  set('hdg', String(Math.round(a.hdg)%360).padStart(3,'0')+'°');
  set('dist', fmtDist(a.dist_nm));
  set('fase', esc(a.fase||''));
  const fe=card.querySelector('[data-k="fase"]'); if(fe) fe.dataset.f=a.fase||'';
  set('phase', a.falta_nm!=null ? 'faltan '+fmtDist(a.falta_nm) : (a.origen||a.destino ? '' : 'Sin plan de vuelo'));
  if(a.progreso!=null){
    const p=Math.max(0,Math.min(100,a.progreso*100)).toFixed(1)+'%';
    const fill=card.querySelector('[data-k="fill"]'), pl=card.querySelector('[data-k="plane"]');
    if(fill) fill.style.width=p;
    if(pl) pl.style.left=p;
  }
  // Ruta en el mapa: origen → avión (volado) y avión → destino (lo que falta)
  const r=map.getSource('traffic-route'); if(!r) return;
  const pos=trafficPos(a), feats=[];
  if(a.origen && a.origen.lat!=null) feats.push({type:'Feature',properties:{hecho:true},geometry:{type:'LineString',coordinates:[[a.origen.lon,a.origen.lat],pos]}});
  if(a.destino && a.destino.lat!=null) feats.push({type:'Feature',properties:{hecho:false},geometry:{type:'LineString',coordinates:[pos,[a.destino.lon,a.destino.lat]]}});
  r.setData({type:'FeatureCollection',features:feats});
}

bindToggle(document.getElementById('tg-traffic'),'traffic',(on)=>{
  if(!on){ closeTrafficCard(); trafficData=[]; document.getElementById('traffic-count').textContent=''; }
  else fetchTraffic();
  renderTraffic();
});

// Botón "P" (junto a la brújula): mostrar u ocultar los estacionados apagados
(()=>{
  const b=document.getElementById('btn-parked'); if(!b) return;
  b.classList.toggle('on',flags.parked);
  b.addEventListener('click',()=>{
    flags.parked=!flags.parked;
    b.classList.toggle('on',flags.parked);
    try{ localStorage.setItem('traffic.parked',flags.parked?'1':'0'); }catch(e){}
    fetchTraffic();       // actualiza también el contador del panel de capas
  });
})();
