@echo off
title MSFS Live Tracker
cd /d "%~dp0"

echo Verificando dependencias...
pip install -r requirements.txt >nul 2>&1

echo Arrancando MSFS Live Tracker en http://localhost:5001 ...
python app.py

pause
