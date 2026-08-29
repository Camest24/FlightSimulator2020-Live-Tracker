@echo off
title MSFS Live Tracker - DEBUG
cd /d "%~dp0"

echo Cerrando cualquier proceso viejo que siga escuchando en el puerto 5001...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :5001 ^| findstr LISTENING') do (
    taskkill /PID %%p /F >nul 2>&1
)

echo Verificando dependencias...
pip install -r requirements.txt >nul 2>&1

echo Arrancando en modo DEBUG (avion estatico en SKRG, sin MSFS) en http://localhost:5001 ...
python app.py --debug

pause
