@echo off
setlocal
rem Installs Eagles PDF viewer for the current user (no admin rights needed).
set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\Programs\Eagles PDF viewer"
set "EXE=%DEST%\EaglesPDF.exe"

echo.
echo  Installing Eagles PDF viewer to:
echo    %DEST%
echo.

rem Remove the old "Inkleaf PDF" (this app's earlier name). Settings are kept.
taskkill /im InkleafPDF.exe /f >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { Remove-Item -LiteralPath (Join-Path $d 'Inkleaf PDF.lnk') -ErrorAction SilentlyContinue }"
reg delete "HKCU\Software\Classes\InkleafPDF.Document" /f >nul 2>&1
reg delete "HKCU\Software\Classes\.pdf\OpenWithProgids" /v "InkleafPDF.Document" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Applications\InkleafPDF.exe" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InkleafPDF" /f >nul 2>&1
if exist "%LOCALAPPDATA%\Programs\Inkleaf PDF" rmdir /s /q "%LOCALAPPDATA%\Programs\Inkleaf PDF"

taskkill /im EaglesPDF.exe /f >nul 2>&1
robocopy "%SRC%." "%DEST%" /E /NFL /NDL /NJH /NJS /NP /XF Install.cmd >nul
if %ERRORLEVEL% GEQ 8 (
  echo  Copy failed. Make sure Eagles PDF viewer is closed and try again.
  pause
  exit /b 1
)

rem Unblock downloaded files and create Start menu + Desktop shortcuts.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath $env:DEST -Recurse | Unblock-File -ErrorAction SilentlyContinue;" ^
  "$s = New-Object -ComObject WScript.Shell;" ^
  "$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'));" ^
  "foreach ($d in $dirs) { $l = $s.CreateShortcut((Join-Path $d 'Eagles PDF viewer.lnk')); $l.TargetPath = $env:EXE; $l.WorkingDirectory = $env:DEST; $l.IconLocation = $env:EXE + ',0'; $l.Description = 'Fast touch and pen PDF reader'; $l.Save() }"

rem Offer Eagles PDF viewer in "Open with" for .pdf files.
reg add "HKCU\Software\Classes\EaglesPDF.Document" /ve /d "PDF Document" /f >nul
reg add "HKCU\Software\Classes\EaglesPDF.Document\DefaultIcon" /ve /d "\"%EXE%\",0" /f >nul
reg add "HKCU\Software\Classes\EaglesPDF.Document\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
reg add "HKCU\Software\Classes\.pdf\OpenWithProgids" /v "EaglesPDF.Document" /t REG_NONE /f >nul
reg add "HKCU\Software\Classes\Applications\EaglesPDF.exe\SupportedTypes" /v ".pdf" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\Applications\EaglesPDF.exe\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul

rem Show in Settings > Apps so it can be uninstalled normally.
set "UK=HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\EaglesPDF"
reg add "%UK%" /v DisplayName /d "Eagles PDF viewer" /f >nul
reg add "%UK%" /v DisplayIcon /d "\"%EXE%\",0" /f >nul
reg add "%UK%" /v Publisher /d "Eagles" /f >nul
reg add "%UK%" /v DisplayVersion /d "__APP_VERSION__" /f >nul
reg add "%UK%" /v InstallLocation /d "%DEST%" /f >nul
reg add "%UK%" /v UninstallString /d "\"%DEST%\Uninstall.cmd\"" /f >nul
reg add "%UK%" /v NoModify /t REG_DWORD /d 1 /f >nul
reg add "%UK%" /v NoRepair /t REG_DWORD /d 1 /f >nul

echo  Done! Eagles PDF viewer is on your Start menu and Desktop.
echo.
echo  Tip: to open PDFs with it by default, right-click any PDF,
echo  choose "Open with" ^> "Choose another app" ^> Eagles PDF viewer ^> "Always".
echo.
start "" "%EXE%"
pause
