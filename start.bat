@echo off
echo Starting server...
start /B cmd /c "node server.js"
timeout /t 5
start http://localhost:3000
echo Done! Check your browser.
timeout /t 3
