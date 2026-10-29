@echo off
rem Starts Lekhira Writes on this computer and opens it in your browser.
title Lekhira Writes
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)
set OPEN_BROWSER=1
node --disable-warning=ExperimentalWarning server/index.js
pause
