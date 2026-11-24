@echo off
rem Starts Grape's server for development: pages rebuild as they are edited, /view-process shows the traffic.
cd /d "%~dp0"
if not exist node_modules\next call npm install
node server.js
pause
