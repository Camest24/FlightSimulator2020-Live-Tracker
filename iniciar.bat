@echo off
title MSFS Live Tracker
cd /d "%~dp0"

echo Cerrando cualquier proceso viejo que siga escuchando en el puerto 5001...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :5001 ^| findstr LISTENING') do (
    taskkill /PID %%p /F >nul 2>&1
)

echo Verificando dependencias...
pip install -r requirements.txt >nul 2>&1

rem Fotos de JetPhotos (tools\jetphotos-api, necesita Node). La app la levanta sola; aca solo
rem se instalan las dependencias la primera vez y se libera el puerto 8787 de un proceso viejo.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do (
    taskkill /PID %%p /F >nul 2>&1
)
where npm >nul 2>&1
if not errorlevel 1 if not exist "tools\jetphotos-api\node_modules" (
    echo Instalando la API de JetPhotos ^(solo la primera vez^)...
    pushd tools\jetphotos-api
    call npm install >nul 2>&1
    popd
)

echo Arrancando MSFS Live Tracker en http://localhost:5001 ...
python app.py

rem Codigo 0 = se cerro sola porque se cerro MSFS: la ventana se cierra tambien.
rem Cualquier otro = error: pausa para poder leerlo.
if errorlevel 1 pause
