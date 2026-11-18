@echo off
setlocal
set "DEST=%LOCALAPPDATA%\Programs\Eagles PDF viewer"
echo Removing Eagles PDF viewer...
taskkill /im EaglesPDF.exe /f >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { Remove-Item -LiteralPath (Join-Path $d 'Eagles PDF viewer.lnk') -ErrorAction SilentlyContinue }"
reg delete "HKCU\Software\Classes\EaglesPDF.Document" /f >nul 2>&1
reg delete "HKCU\Software\Classes\.pdf\OpenWithProgids" /v "EaglesPDF.Document" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Applications\EaglesPDF.exe" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\EaglesPDF" /f >nul 2>&1
echo Eagles PDF viewer has been removed. (Your PDFs are untouched.)
rem Delete the program folder after this script exits.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & rmdir /s /q "%DEST%""
