@echo off
title Inkleaf PDF setup
if not exist "%~dp0app.asar" goto notextracted
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
exit /b

:notextracted
echo.
echo  Please extract the zip first:
echo  right-click the zip file, choose "Extract All", then run Setup.cmd
echo  from the extracted folder.
echo.
pause
