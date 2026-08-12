/* graph-panel.js — Grafico de velocidad y altitud, su ventana visible y los controles para recorrerlo.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// ---- Gráfico de velocidad y altitud (estilo FR24) ----
// El gráfico arranca abierto: es de lo que más se mira durante el vuelo y ya no tapa
// el mapa (cuelga del panel de datos). Se cierra con su botón o con la ✕.
let chart=null, graphOpen=true, history=[], lastGraphSample=0, lastElapsed=0;
function fmtClock(ms){ const d=new Date(ms); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function ensureChart(){
  if(chart || typeof Chart==='undefined') return;
  const ctx=document.getElementById('graph-canvas').getContext('2d');
  chart=new Chart(ctx,{ type:'line',
    data:{ labels:[], datasets:[
      { label:'kt', data:[], borderColor:'rgba(251,191,36,0.55)', backgroundColor:'transparent',
        yAxisID:'y1', pointRadius:0, borderWidth:1.6, tension:0.25 },
      // La curva de altitud toma el mismo color que el rastro del mapa: cada tramo se
      // pinta según a qué altura estabas, así el gráfico y el mapa cuentan lo mismo.
      { label:'ft', data:[], backgroundColor:'transparent', yAxisID:'y', pointRadius:0, borderWidth:2.6, tension:0.25,
        segment:{ borderColor:c=>altColor((history[c.p1DataIndex+(chart&&chart.__off||0)]||{}).alt) } },
      // Marcas de los puntos de ruta que fuiste pasando, sobre la curva de altitud
      { label:'wp', data:[], yAxisID:'y', showLine:false, pointStyle:'triangle',
        pointRadius:6, pointBackgroundColor:'#7dd3fc', pointBorderColor:'#0f172a', pointBorderWidth:1.5 } ]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false, interaction:{intersect:false,mode:'index'},
      layout:{padding:{top:2}},
      scales:{
        x:{ ticks:{color:'rgba(246,248,251,0.45)',maxTicksLimit:6,font:{size:10}}, grid:{color:'rgba(255,255,255,0.05)'} },
        y:{ position:'left', min:0, ticks:{color:'rgba(246,248,251,0.45)',maxTicksLimit:5,font:{size:10},
              callback:v=>v>=1000?(v/1000)+'k':v}, grid:{color:'rgba(255,255,255,0.05)'} },
        y1:{ position:'right', min:0, ticks:{color:'rgba(251,191,36,0.5)',maxTicksLimit:5,font:{size:10}}, grid:{drawOnChartArea:false} } },
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{ label:(c)=>{
          if(c.datasetIndex===2){ const h=history[c.dataIndex+(chart&&chart.__off||0)];
            return h&&h.wp ? ('Punto '+h.wp) : null; }
          return c.formattedValue+' '+c.dataset.label;
        } } } } } });
}
// Chart.js mide su contenedor con getBoundingClientRect, que YA viene achicado por el
// scale de los paneles. Si lo dejamos solo, dibuja a ese tamaño y encima el navegador
// vuelve a escalarlo: el gráfico salía dos veces más chico que el resto del panel.
// offsetWidth/offsetHeight sí dan la medida sin escalar, así que se la pasamos a mano.
function ajustarGrafico(){
  if(!chart) return;
  const caja=document.querySelector('#graph-panel .gp-body');
  if(caja && caja.offsetWidth>0) chart.resize(caja.offsetWidth, caja.offsetHeight);
}
window.addEventListener('resize', ()=>{ try{ ajustarGrafico(); }catch(e){} });

// ---- Ventana visible del gráfico ----
// El historial completo puede ser de muchas horas, pero en un panel angosto todo junto
// no se lee. Por eso se muestra una VENTANA: se elige cuánto tiempo abarca (15m/30m/1h/
// todo) y se recorre el vuelo con la barra de abajo o arrastrando el gráfico.
// `graphVista` es el índice de la muestra donde arranca la ventana; null = pegado al
// final (sigue al avión en vivo). El resto del código sigue usando `history` entero:
// el recorte se hace solo acá, al dibujar.
let graphSpanMin=0;        // 0 = todo el vuelo
let graphVista=null;       // null = pegado al presente
const GRAPH_SEG=4;         // segundos entre muestras (coincide con sampleGraph)

function graphVentana(){ return graphSpanMin>0 ? Math.max(10, Math.round(graphSpanMin*60/GRAPH_SEG)) : history.length; }
function graphMaxIni(){ return Math.max(0, history.length - graphVentana()); }
function graphIni(){
  const max=graphMaxIni();
  if(graphVista===null) return max;              // pegado al presente
  return Math.max(0, Math.min(graphVista, max));
}
// El rango visible se muestra como reloj (ej. "14:05 → 14:35") para ubicarse en el vuelo
function pintarNavGrafico(){
  const sl=document.getElementById('gp-scroll'), et=document.getElementById('gp-rango');
  if(!sl||!et) return;
  const max=graphMaxIni(), ini=graphIni();
  const hayQueRecorrer = max>0;
  sl.disabled=!hayQueRecorrer;
  sl.value = hayQueRecorrer ? (ini/max*100) : 100;
  const trozo=history.slice(ini, ini+graphVentana());
  et.textContent = trozo.length ? (trozo[0].label+' → '+trozo[trozo.length-1].label) : '—';
}

function refreshChart(){ if(!chart) return;
  ajustarGrafico();
  const ini=graphIni(), vis=history.slice(ini, ini+graphVentana());
  // El color por altitud de cada tramo se lee de `history` por índice: como ahora
  // dibujamos un recorte, hay que correr ese índice o los colores quedan desfasados.
  chart.__off=ini;
  chart.data.labels=vis.map(h=>h.label);
  chart.data.datasets[0].data=vis.map(h=>h.gs);
  chart.data.datasets[1].data=vis.map(h=>h.alt);
  // Solo hay valor en las muestras donde se pasó un punto; el resto queda vacío
  chart.data.datasets[2].data=vis.map(h=>h.wp?h.alt:null);
  chart.update('none');
  pintarNavGrafico(); }
let lastWpSeen=null, pendingWp=null;
function sampleGraph(s){
  if((s.elapsed_min||0)+0.05 < lastElapsed){ history=[]; lastWpSeen=null; graphVista=null; }   // vuelo reiniciado
  lastElapsed=s.elapsed_min||0;
  // Detectamos el cambio de punto de ruta para marcarlo en la próxima muestra
  const nx=(typeof nextLegTarget==='function')?nextLegTarget():null;
  const key=nx?nx.key:null;
  if(key!==lastWpSeen){ if(lastWpSeen!==null && lastWpName) pendingWp=lastWpName; lastWpSeen=key; }
  if(nx) lastWpName=nx.name;
  const t=Date.now();
  if(t-lastGraphSample>4000 && s.alt!=null && s.gs!=null){
    history.push({label:fmtClock(t), alt:Math.round(s.alt), gs:Math.round(s.gs), wp:pendingWp});
    pendingWp=null;
    // A una muestra cada 4 s, 1500 muestras eran solo 100 minutos: en un vuelo de 2:40
    // se perdía la primera hora. 9000 cubren 10 horas, que alcanza para cualquier vuelo.
    if(history.length>9000){ history.shift(); if(graphVista!==null) graphVista=Math.max(0,graphVista-1); }
    lastGraphSample=t; if(graphOpen) refreshChart();
  }
}
let lastWpName=null;
document.getElementById('btn-progress').onclick=()=>{
  if(!routeTarget) return;              // sin ruta el botón está bloqueado
  progressUserOn=!progressUserOn;
  syncProgressButton();
};
document.getElementById('btn-graph').onclick=()=>{
  graphOpen=!graphOpen;
  document.getElementById('graph-panel').classList.toggle('hidden',!graphOpen);
  document.getElementById('btn-graph').classList.toggle('active',graphOpen);
  if(graphOpen){ ensureChart(); refreshChart(); }
};
document.getElementById('gp-close').onclick=()=>{ graphOpen=false; document.getElementById('graph-panel').classList.add('hidden'); document.getElementById('btn-graph').classList.remove('active'); };

// ---- Controles para recorrer el gráfico ----
(function(){
  const sl=document.getElementById('gp-scroll');
  const cuerpo=document.querySelector('#graph-panel .gp-body');

  document.querySelectorAll('.gp-span').forEach(function(b){
    b.onclick=function(){
      document.querySelectorAll('.gp-span').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      graphSpanMin=parseInt(b.dataset.min,10)||0;
      graphVista=null;                 // al cambiar el zoom volvemos al presente
      try{ refreshChart(); }catch(e){}
    };
  });

  if(sl) sl.oninput=function(){
    const max=graphMaxIni();
    // Soltar la barra del todo a la derecha vuelve a "seguir en vivo"
    graphVista = (max<=0 || parseFloat(sl.value)>=99.5) ? null : Math.round(max*parseFloat(sl.value)/100);
    try{ refreshChart(); }catch(e){}
  };

  // Arrastrar el gráfico con el dedo/mouse, que es lo natural para moverse en el tiempo
  if(cuerpo){
    let arrastrando=false, x0=0, ini0=0;
    const empezar=function(x){
      if(graphMaxIni()<=0) return;     // todo el vuelo ya entra en pantalla
      arrastrando=true; x0=x; ini0=graphIni(); cuerpo.classList.add('arrastrando');
    };
    const mover=function(x){
      if(!arrastrando) return;
      const ancho=cuerpo.offsetWidth||1;
      // Cuántas muestras corresponden a los píxeles arrastrados
      const dm=Math.round((x0-x)/ancho*graphVentana());
      const max=graphMaxIni(), nuevo=Math.max(0,Math.min(ini0+dm,max));
      graphVista = (nuevo>=max) ? null : nuevo;
      try{ refreshChart(); }catch(e){}
    };
    const soltar=function(){ arrastrando=false; cuerpo.classList.remove('arrastrando'); };

    cuerpo.addEventListener('mousedown',e=>{ empezar(e.clientX); });
    window.addEventListener('mousemove',e=>{ if(arrastrando){ e.preventDefault(); mover(e.clientX); } });
    window.addEventListener('mouseup',soltar);
    cuerpo.addEventListener('touchstart',e=>{ if(e.touches[0]) empezar(e.touches[0].clientX); },{passive:true});
    cuerpo.addEventListener('touchmove',e=>{ if(arrastrando&&e.touches[0]){ e.preventDefault(); mover(e.touches[0].clientX); } },{passive:false});
    cuerpo.addEventListener('touchend',soltar);
  }
})();

// Como arranca abierto, hay que crear el lienzo ya (si no, queda vacío hasta tocar el botón)
ensureChart(); refreshChart();

// ---- Modo "agregar punto de ruta" ----
document.getElementById('rc-addwp').onclick=()=>setAddWp(!addWpMode);
