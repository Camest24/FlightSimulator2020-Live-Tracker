# MSFS Live Tracker

App web local que muestra tu vuelo de Microsoft Flight Simulator 2020 en vivo sobre un
mapa satelital real, al estilo Flightradar24. Pensada para un segundo monitor, una tablet
o para pasarle el link a alguien en tu misma red.

## Qué hace

**El mapa**

- Mapa vectorial (MapLibre) con satélite real y nombres de lugares en blanco con halo.
- 4 capas: satélite con nombres (por defecto), satélite, mapa de calles, mapa oscuro.
- Aeropuertos y pistas reales (datos de OurAirports): cada pista se dibuja con su largo
  y orientación reales. Clic para ver ICAO, nombre, elevación y pista.
- VOR reales con su frecuencia.
- Radio configurable (20 a 200 NM) alrededor del avión y del aeropuerto de destino.
  Fuera de ese radio, si hacés zoom sobre una zona, lo que hay ahí aparece igual, con un
  fundido suave al alejarte.
- El mapa sigue al avión. Un toque en el mapa suelta el seguimiento; el botón de la barra
  lo vuelve a enganchar.
- Brújula abajo a la derecha: gira con el mapa y al tocarla vuelve al norte.

**Panel de datos**

- Altitud, velocidad (con mach), velocidad vertical, rumbo, distancia, tiempo de vuelo,
  combustible con autonomía estimada y clima real (METAR).
- Sim Rate: muestra la velocidad de simulación y la sube o baja desde la app.
- Estado del avión: tren, flaps, spoilers, freno de mano y luces, todo accionable.
- Gráfico de velocidad y altitud, con marcas de los puntos de ruta que fuiste pasando.

**Rutas**

- Ruta directa a cualquier aeropuerto desde su popup.
- Generador de rutas: encadena VOR reales entre tu posición y el destino, buscando el
  camino más corto que además no se desvíe del rumbo directo.
- Mantené pulsado en cualquier punto del mapa para trazar ruta hasta ahí.
- Puntos intermedios: se insertan donde menos desvían la ruta.
- La etiqueta de la ruta muestra distancia, tiempo y rumbo a seguir.
- Si armaste un plan en el mapa del mundo de MSFS, la app lo detecta y adopta el destino
  sola (solo si el archivo es reciente y estás en su aeropuerto de salida).

**Progreso del vuelo**

Panel opcional (botón en la barra de arriba a la derecha) con origen y destino, barra de
avance, kilómetros recorridos y restantes, rumbo a seguir, llegada estimada, guía de
descenso y distancia al próximo punto.

La llegada estimada funciona incluso con el avión parado: supone una velocidad de crucero
típica según el tipo de motor y cambia al cálculo real apenas superás los 40 nudos.

La guía de descenso usa la regla 3:1 (3 millas por cada 1000 pies a perder) y tiene en
cuenta la elevación del aeropuerto de destino.

**Historial**

El vuelo se guarda solo al terminar: cuando despegaste, aterrizaste y quedaste detenido
unos 45 segundos, pasa al historial con su trayecto, kilómetros, duración y altitud
máxima. El rastro sigue en pantalla para que puedas mirarlo; se limpia recién cuando
despegás de nuevo. También se guarda al tocar "Reiniciar ruta" (sin duplicarlo si ya se
había guardado solo).

Se consulta desde el botón de historial y se puede borrar vuelo por vuelo.

**Beta**

- Teletransporte a cualquier aeropuerto, eligiendo pista y si querés salir o llegar.
- Ajuste manual de altitud, rumbo, ángulo y velocidad.

## Requisitos

1. Python 3.9+
2. MSFS 2020 corriendo (SimConnect viene activado por defecto).
3. Conexión a internet para el satélite, el clima y la descarga inicial de los datos de
   aeropuertos y VOR.

## Instalación y uso

Doble clic en `iniciar.bat` (instala dependencias y arranca). O a mano:

```
pip install -r requirements.txt
python app.py
```

Se abre en http://localhost:5001

La primera vez descarga los datos de aeropuertos, pistas y VOR (OurAirports) y los guarda
en `data/` para no volver a bajarlos.

## Para verlo en otra pantalla o dispositivo

Desde otra compu o el celular: `http://TU-IP-LOCAL:5001`. Tu IP la ves con `ipconfig`,
buscando "Dirección IPv4".

## Aerovías en vivo (opcional)

El generador de rutas usa por defecto un archivo de aerovías fijo (ciclo 2012). Existe
la posibilidad de que la app las pida en vivo a MSFS mientras volás, para que reflejen
lo que el simulador tiene cargado en ese momento (por ejemplo, si tenés un ciclo de
Navigraph instalado, esas aerovías actualizadas).

Esto necesita un `SimConnect.dll` más moderno que el que trae la app por defecto, porque
el que viene no tiene las funciones necesarias. Para activarlo:

1. Instalá el **MSFS SDK** (gratis, desde el menú "Ayuda" del propio simulador o desde
   su sitio). Por defecto queda en `C:\MSFS SDK\SimConnect SDK\lib\SimConnect.dll` — la
   app ya busca ahí solo.
2. Si tu SDK quedó en otra carpeta, creá el archivo `data/simconnect_dll_path.txt` con
   una sola línea: la ruta completa a ese `SimConnect.dll`.
3. Reiniciá la app con MSFS corriendo. Podés ver si prendió en
   `http://localhost:5001/api/live_airways_status`.

Si no hacés nada de esto, la app sigue funcionando exactamente igual que siempre (con el
archivo fijo) — esto es un agregado opcional, no un requisito.

## Notas

- Los aeropuertos y VOR se prenden y apagan desde el botón de capas, arriba a la derecha.
- El vuelo en curso se autoguarda en `data/current_flight.json`; el historial queda en
  `data/flights_history.json`.
- El rastro se limita a 6000 puntos: al pasarse, adelgaza la mitad más vieja. En un vuelo
  de 8 horas serían más de 100.000 puntos y el navegador se arrastraría.
- Los vuelos con menos de 5 puntos o sin distancia real (teletransportes) no se guardan
  en el historial.
