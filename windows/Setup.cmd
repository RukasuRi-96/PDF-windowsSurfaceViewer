@echo off
rem Shipped in EaglesPDF-Setup.zip as "Install Eagles PDF viewer.cmd" (see tools/build-win.js).
title Eagles PDF viewer setup
if not exist "%~dp0files\app.asar" goto notextracted
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0files\setup.ps1" -FromLauncher
echo.
pause
exit /b

:notextracted
echo.
echo  Please extract the zip first:
echo    1. Close this window.
echo    2. Right-click EaglesPDF-Setup.zip and choose "Extract All...".
echo    3. In the extracted folder, double-click "Install Eagles PDF viewer".
echo.
pause
