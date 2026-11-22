/* map-setup.js — Estilo del mapa, capas de etiquetas y creacion de la instancia MapLibre.

   Extraido tal cual del unico bloque <script> que vivia dentro de templates/index.html.
   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar. */

// Línea magenta del plan de vuelo del propio MSFS. La dejamos oculta porque se superpone
// con la ruta de la app; el código queda intacto por si algún día la querés de vuelta.
const FPLAN_LINE_VISIBLE=false;

const labelPaint={ 'text-color':'#fff','text-halo-color':'rgba(0,0,0,0.6)','text-halo-width':1.4,'text-halo-blur':0.4 };
const nameField=['coalesce',['get','name:latin'],['get','name']];
const labelLayers=[
  {id:'lbl-country','source-layer':'place',filter:['==',['get','class'],'country'],maxzoom:8,layout:{'text-field':nameField,'text-font':['Noto Sans Bold'],'text-transform':'uppercase','text-letter-spacing':0.1,'text-size':['interpolate',['linear'],['zoom'],2,10,6,15]}},
  {id:'lbl-state','source-layer':'place',filter:['==',['get','class'],'state'],maxzoom:9,layout:{'text-field':nameField,'text-font':['Noto Sans Regular'],'text-transform':'uppercase','text-letter-spacing':0.2,'text-size':['interpolate',['linear'],['zoom'],5,10,9,14]}},
  {id:'lbl-city','source-layer':'place',filter:['==',['get','class'],'city'],layout:{'text-field':nameField,'text-font':['Noto Sans Bold'],'text-size':['interpolate',['exponential',1.2],['zoom'],5,13,10,19],'text-max-width':8}},
  {id:'lbl-town','source-layer':'place',filter:['==',['get','class'],'town'],minzoom:7,layout:{'text-field':nameField,'text-font':['Noto Sans Regular'],'text-size':['interpolate',['exponential',1.2],['zoom'],8,12,13,16],'text-max-width':8}},
  {id:'lbl-village','source-layer':'place',filter:['==',['get','class'],'village'],minzoom:10,layout:{'text-field':nameField,'text-font':['Noto Sans Regular'],'text-size':['interpolate',['exponential',1.2],['zoom'],11,11,15,14],'text-max-width':8}},
].map(l=>({id:l.id,type:'symbol',source:'omt','source-layer':l['source-layer'],filter:l.filter,minzoom:l.minzoom||0,maxzoom:l.maxzoom||24,layout:Object.assign({'text-optional':true,visibility:'visible'},l.layout),paint:labelPaint}));

const rlayer=(id,vis)=>({id,type:'raster',source:id,layout:{visibility:vis?'visible':'none'}});
// Terreno 3D: relieve real (Mapterhorn, Copernicus GLO-30, gratis y sin API key) más
// una capa de sombreado para que el relieve se note también con el mapa plano.
const hillshadeLayer={id:'hillshade-3d',type:'hillshade',source:'hillshadeSource',
  layout:{visibility:'none'},paint:{'hillshade-shadow-color':'#473b24'}};
// Solo queda "Satélite con nombres": los mapas de calles y oscuro (Carto) empezaron a pedir
// API key ("API key required") y el satélite pelado nadie lo usaba, así que se sacaron con
// su selector (2026-11-21).
const style={version:8,glyphs:'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources:{
    sat:{type:'raster',tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],tileSize:256,maxzoom:19},
    omt:{type:'vector',url:'https://tiles.openfreemap.org/planet'},
    terrainSource:{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'},
    hillshadeSource:{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json'},
  },
  layers:[rlayer('sat',true),hillshadeLayer,...labelLayers],
  sky:{},
};

// maxPitch: 60 es el default de MapLibre — no alcanza para la cámara de persecución
// (CHASE_PITCH más abajo, ~67°), que quedaba recortada en 60 en silencio (setPitch no
// avisa si clampea). 80 deja margen de sobra.
const map=new maplibregl.Map({container:'map',style,center:[-75.45,6.28],zoom:12,pitch:60,maxPitch:80,attributionControl:false});
// Rotación habilitada: el ícono del avión usa rotationAlignment 'map', así que se corrige solo
