/* plane-3d.js — Menú de capas, vista 2D / 3D (inclinación del mapa), geometría de pistas y
   colores por altitud.

   El nombre viene del avión 3D de Three.js (y su estela con altitud real) que vivía acá,
   para el modo "Terreno 3D". Ese modo (que después pasó a Cesium) nunca se usaba y su capa
   custom de WebGL chocaba con el globo de Mapbox: se sacó el 2026-11-22.

   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// Si el heading/altitud llega corrupto (NaN, Infinity, un objeto raro) alguna vez desde el
// sim, esto lo cambia por un valor por defecto sano en vez de dejarlo pasar.
function finiteNum(v,fallback){ return (typeof v==='number' && isFinite(v)) ? v : fallback; }

document.getElementById('btn-layers').addEventListener('click',()=>{ document.getElementById('layers').classList.toggle('hidden'); document.getElementById('btn-layers').classList.toggle('active'); });
// (Acá estaban los botones de zoom, que hacían zoom sin soltar el seguimiento, y la
// brújula que volvía al norte. Se sacaron el 2026-11-21: en el iPad se hace con los dedos.)

// Vista 2D / 3D (inclinación del mapa). Animamos el pitch nosotros mismos, cuadro a
// cuadro con setPitch instantáneo, para que el recentrado del seguimiento no la cancele.
function tiltTo(target){
  const start=map.getPitch(), t0=performance.now(), dur=450;
  (function step(now){
    let k=Math.min(1,(now-t0)/dur);
    const e=1-Math.pow(1-k,3);            // easeOutCubic
    map.setPitch(start+(target-start)*e);
    if(k<1) requestAnimationFrame(step);
  })(performance.now());
}
document.getElementById('btn-3d').onclick=()=>{
  const to3d = map.getPitch() < 20;
  tiltTo(to3d?60:0);
  const b=document.getElementById('btn-3d');
  b.textContent = to3d?'3D':'2D';   // muestra el modo en el que quedás
  b.classList.toggle('active', to3d);
  try{ localStorage.setItem('vista3d', to3d?'1':'0'); }catch(e){}
};
// La vista 2D/3D se recuerda entre sesiones (el mapa nace inclinado a 60°, ver map-setup.js)
try{
  if(localStorage.getItem('vista3d')==='0'){
    map.setPitch(0);
    const b=document.getElementById('btn-3d');
    b.textContent='2D'; b.classList.remove('active');
  }
}catch(e){}


function dest(lat,lon,brg,d){const R=6378137,b=brg*Math.PI/180,dd=d/R,la1=lat*Math.PI/180,lo1=lon*Math.PI/180;
  const la2=Math.asin(Math.sin(la1)*Math.cos(dd)+Math.cos(la1)*Math.sin(dd)*Math.cos(b));
  const lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(dd)*Math.cos(la1),Math.cos(dd)-Math.sin(la1)*Math.sin(la2));
  return [lo2*180/Math.PI,la2*180/Math.PI];}
function runwayShape(clat,clon,hdg,len,wid){const f=dest(clat,clon,hdg,len/2),b=dest(clat,clon,hdg+180,len/2);
  return {poly:[dest(f[1],f[0],hdg+90,wid/2),dest(f[1],f[0],hdg-90,wid/2),dest(b[1],b[0],hdg-90,wid/2),dest(b[1],b[0],hdg+90,wid/2)],center:[f,b]};}

// Color continuo por altitud: interpola entre los tramos, así el trazo cambia de color
// suavemente (azul -> azul claro -> verde...) en vez de saltar de golpe.
// Escala de Flightradar24: blanco casi en tierra, después amarillo, verde, celeste,
// azul, violeta, y rojo en lo más alto. Los cortes vienen de sus umbrales en metros
// (100 m para el amarillo, 2500 m para el celeste) pasados a pies.
const ALT_STOPS=[
  [0,     [255,255,255]],   // blanco     · menos de 100 m
  [330,   [250,204,21]],    // amarillo
  [3300,  [74,222,128]],    // verde
  [8200,  [56,189,248]],    // celeste    · desde 2500 m
  [16000, [37,99,235]],     // azul
  [28000, [30,58,138]],     // azul oscuro · acá cae el crucero típico
  [40000, [124,58,237]],    // violeta
  [48000, [239,68,68]],     // rojo        · muy alto, casi nunca
];
function altColorRGB(ft){ ft=ft||0;
  if(ft<=ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for(let i=0;i<ALT_STOPS.length-1;i++){ const a=ALT_STOPS[i], b=ALT_STOPS[i+1];
    if(ft<=b[0]){ const k=(ft-a[0])/(b[0]-a[0]);
      return [Math.round(a[1][0]+(b[1][0]-a[1][0])*k),Math.round(a[1][1]+(b[1][1]-a[1][1])*k),Math.round(a[1][2]+(b[1][2]-a[1][2])*k)]; } }
  return ALT_STOPS[ALT_STOPS.length-1][1]; }
function altColor(ft){ return 'rgb('+altColorRGB(ft).join(',')+')'; }
function fmtDur(min){ if(min==null)return '00:00:00'; const s=Math.max(0,Math.round(min*60)); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0'); }
function fmtEnd(min){ if(min==null)return ''; const h=Math.floor(min/60),m=Math.round(min%60); return '~'+(h>0?h+'h ':'')+m+'m'; }
const nf=n=>n.toLocaleString('en-US');
