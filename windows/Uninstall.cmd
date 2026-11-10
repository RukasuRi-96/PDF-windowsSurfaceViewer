@echo off
setlocal
set "DEST=%LOCALAPPDATA%\Programs\Inkleaf PDF"
echo Removing Inkleaf PDF...
taskkill /im InkleafPDF.exe /f >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { Remove-Item -LiteralPath (Join-Path $d 'Inkleaf PDF.lnk') -ErrorAction SilentlyContinue }"
reg delete "HKCU\Software\Classes\InkleafPDF.Document" /f >nul 2>&1
reg delete "HKCU\Software\Classes\.pdf\OpenWithProgids" /v "InkleafPDF.Document" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Applications\InkleafPDF.exe" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InkleafPDF" /f >nul 2>&1
echo Inkleaf PDF has been removed. (Your PDFs are untouched.)
rem Delete the program folder after this script exits.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & rmdir /s /q "%DEST%""
