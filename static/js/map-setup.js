/* map-setup.js — Creación del mapa: Mapbox GL JS en modo globo, con un estilo propio liviano.

   Se carga como <script src> clasico (NO type=module): todos estos archivos comparten el
   mismo scope global y DEPENDEN de cargarse en el orden en que aparecen en el HTML, que es
   el mismo orden en que este codigo estaba escrito. No reordenar.

   Hasta el 2026-11-22 el mapa era MapLibre 4.7 con un estilo armado a mano (fotos de Esri,
   nombres de OpenFreeMap, relieve de Mapterhorn). Se pasó a Mapbox por el globo con
   atmósfera y sus nombres de países, océanos y ciudades: el look de las pantallas de los
   aviones. La API es casi igual (MapLibre salió de Mapbox).
   Primero se probó su estilo "Standard Satellite" y en el iPad iba trabado: trae relieve
   3D, luces y edificios 3D, y sus fotos satelitales la cuenta las devuelve con 429 (límite
   -1) y las reintenta. Por eso el estilo es nuestro: solo fotos de Esri + nombres y
   límites de Mapbox + globo con atmósfera. Sin relieve: el suelo es plano a propósito. */

// Línea magenta del plan de vuelo del propio MSFS. La dejamos oculta porque se superpone
// con la ruta de la app; el código queda intacto por si algún día la querés de vuelta.
const FPLAN_LINE_VISIBLE=false;

// Fuentes de las etiquetas. Tienen que existir en el servidor de fuentes de Mapbox: las
// "Noto Sans" de antes eran de OpenFreeMap y acá no cargan.
const FUENTE_NEGRITA=['DIN Pro Bold','Arial Unicode MS Bold'];
const FUENTE_MEDIA=['DIN Pro Medium','Arial Unicode MS Regular'];
const FUENTE_ITALICA=['DIN Pro Italic','Arial Unicode MS Regular'];

// Token público de Mapbox (pk.): lo lee app.py de data/mapbox_token.txt (fuera de git,
// el repo es público) y lo deja en window.MAPBOX_TOKEN. Sin token el mapa no carga.
mapboxgl.accessToken=window.MAPBOX_TOKEN||'';
if(!mapboxgl.accessToken) console.error('[mapa] Falta el token de Mapbox: poné tu token pk. en data/mapbox_token.txt');

// ---- Estilo ----
// Nombres en español si Mapbox lo tiene (name_es), si no el local
const nombreEs=['coalesce',['get','name_es'],['get','name']];
const halo={'text-color':'#fff','text-halo-color':'rgba(0,0,0,0.65)','text-halo-width':1.4,'text-halo-blur':0.4};
const style={version:8,
  glyphs:'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  sources:{
    sat:{type:'raster',tileSize:256,maxzoom:19,
      tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution:'Imágenes © Esri, Maxar, Earthstar Geographics'},
    mb:{type:'vector',url:'mapbox://mapbox.mapbox-streets-v8'},
  },
  layers:[
    {id:'sat',type:'raster',source:'sat'},
    // Límites entre países (no los marítimos): finos y tenues, que no compitan con la ruta
    {id:'limites',type:'line',source:'mb','source-layer':'admin',
      filter:['all',['==',['get','admin_level'],0],['!=',['to-string',['get','maritime']],'true']],
      paint:{'line-color':'rgba(255,255,255,0.45)','line-width':['interpolate',['linear'],['zoom'],2,0.6,8,1.4]}},
    // Océanos y mares, en itálica celeste como en los mapas de cabina
    {id:'lbl-agua',type:'symbol',source:'mb','source-layer':'natural_label',
      filter:['match',['get','class'],['ocean','sea','bay'],true,false],
      layout:{'text-field':nombreEs,'text-font':FUENTE_ITALICA,'text-letter-spacing':0.25,'text-max-width':7,
        'text-size':['interpolate',['linear'],['zoom'],1,11,6,15]},
      paint:{'text-color':'#9fd3ff','text-halo-color':'rgba(0,20,40,0.55)','text-halo-width':1}},
    {id:'lbl-pais',type:'symbol',source:'mb','source-layer':'place_label',maxzoom:7,
      filter:['==',['get','class'],'country'],
      layout:{'text-field':nombreEs,'text-font':FUENTE_NEGRITA,'text-transform':'uppercase','text-letter-spacing':0.12,
        'text-max-width':8,'text-size':['interpolate',['linear'],['zoom'],1,10,6,15],'symbol-sort-key':['get','symbolrank']},
      paint:halo},
    // Departamentos / estados: solo en el rango donde ayudan a ubicarse
    {id:'lbl-estado',type:'symbol',source:'mb','source-layer':'place_label',minzoom:5,maxzoom:8,
      filter:['==',['get','class'],'state'],
      layout:{'text-field':nombreEs,'text-font':FUENTE_MEDIA,'text-transform':'uppercase','text-letter-spacing':0.2,
        'text-size':['interpolate',['linear'],['zoom'],5,9,8,12],'symbol-sort-key':['get','symbolrank'],'text-padding':12},
      paint:Object.assign({},halo,{'text-color':'rgba(255,255,255,0.7)'})},
    // Ciudades: pocas y las importantes. Al principio salían todas (51 a zoom 6) y de cerca
    // casi solo veredas (28 de 33 a zoom 12): mareaba. Ahora nunca veredas (hamlet), pueblos
    // (village) solo muy de cerca, y un tope de importancia que se afloja con el zoom.
    // symbolrank de Mapbox: más bajo = más importante (Medellín 7, Panamá 8, pueblos 12-16).
    {id:'lbl-ciudad',type:'symbol',source:'mb','source-layer':'place_label',minzoom:3,
      filter:['all',['==',['get','class'],'settlement'],
        ['match',['get','type'],['city','town'],true,'village',['>=',['zoom'],12],false],
        ['<=',['get','symbolrank'],['step',['zoom'],7,5,8,7,10,9,12,11,14,13,16]]],
      layout:{'text-field':nombreEs,'text-font':FUENTE_NEGRITA,'text-max-width':8,'symbol-sort-key':['get','symbolrank'],
        'text-padding':10,'text-size':['interpolate',['linear'],['zoom'],3,11,8,14,12,16]},
      paint:halo},
  ],
  // Globo con atmósfera: celeste en el horizonte, espacio oscuro con estrellas
  fog:{'color':'rgb(186,210,235)','high-color':'rgb(36,92,223)','horizon-blend':0.02,
    'space-color':'rgb(11,11,25)','star-intensity':0.6},
};

// projection 'globe': se ve la Tierra al alejarse y se aplana sola al acercarse (a zoom de
// seguimiento es un mapa normal). maxPitch 80: la vista 3D usa 60 y deja margen.
// El logo y el crédito de Mapbox son obligatorios por sus términos: van arriba (abajo
// está el dock), el crédito compacto (una "i" que se despliega).
const map=new mapboxgl.Map({container:'map', style, projection:'globe',
  center:[-75.45,6.28], zoom:12, pitch:60, maxPitch:80, attributionControl:false, logoPosition:'top-left'});
map.addControl(new mapboxgl.AttributionControl({compact:true}),'top-right');
