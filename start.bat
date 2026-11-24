@echo off
rem Starts Grape's server on this computer: the app's login, the website and the admin page (http://127.0.0.1:8787).
rem Leave this window open while Grape is used. The first start builds the website (a minute).
cd /d "%~dp0"
if not exist node_modules\next call npm install
if not exist .next\BUILD_ID call npm run build
node server.js --prod
pause
