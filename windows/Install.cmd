@echo off
setlocal
rem Installs Inkleaf PDF for the current user (no admin rights needed).
set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\Programs\Inkleaf PDF"
set "EXE=%DEST%\InkleafPDF.exe"

echo.
echo  Installing Inkleaf PDF to:
echo    %DEST%
echo.

taskkill /im InkleafPDF.exe /f >nul 2>&1
robocopy "%SRC%." "%DEST%" /E /NFL /NDL /NJH /NJS /NP /XF Install.cmd >nul
if %ERRORLEVEL% GEQ 8 (
  echo  Copy failed. Make sure Inkleaf PDF is closed and try again.
  pause
  exit /b 1
)

rem Unblock downloaded files and create Start menu + Desktop shortcuts.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath $env:DEST -Recurse | Unblock-File -ErrorAction SilentlyContinue;" ^
  "$s = New-Object -ComObject WScript.Shell;" ^
  "$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'));" ^
  "foreach ($d in $dirs) { $l = $s.CreateShortcut((Join-Path $d 'Inkleaf PDF.lnk')); $l.TargetPath = $env:EXE; $l.WorkingDirectory = $env:DEST; $l.IconLocation = $env:EXE + ',0'; $l.Description = 'Fast touch and pen PDF reader'; $l.Save() }"

rem Offer Inkleaf PDF in "Open with" for .pdf files.
reg add "HKCU\Software\Classes\InkleafPDF.Document" /ve /d "PDF Document" /f >nul
reg add "HKCU\Software\Classes\InkleafPDF.Document\DefaultIcon" /ve /d "\"%EXE%\",0" /f >nul
reg add "HKCU\Software\Classes\InkleafPDF.Document\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
reg add "HKCU\Software\Classes\.pdf\OpenWithProgids" /v "InkleafPDF.Document" /t REG_NONE /f >nul
reg add "HKCU\Software\Classes\Applications\InkleafPDF.exe\SupportedTypes" /v ".pdf" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\Applications\InkleafPDF.exe\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul

rem Show in Settings > Apps so it can be uninstalled normally.
set "UK=HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InkleafPDF"
reg add "%UK%" /v DisplayName /d "Inkleaf PDF" /f >nul
reg add "%UK%" /v DisplayIcon /d "\"%EXE%\",0" /f >nul
reg add "%UK%" /v Publisher /d "Inkleaf" /f >nul
reg add "%UK%" /v DisplayVersion /d "1.0.0" /f >nul
reg add "%UK%" /v InstallLocation /d "%DEST%" /f >nul
reg add "%UK%" /v UninstallString /d "\"%DEST%\Uninstall.cmd\"" /f >nul
reg add "%UK%" /v NoModify /t REG_DWORD /d 1 /f >nul
reg add "%UK%" /v NoRepair /t REG_DWORD /d 1 /f >nul

echo  Done! Inkleaf PDF is on your Start menu and Desktop.
echo.
echo  Tip: to open PDFs with it by default, right-click any PDF,
echo  choose "Open with" ^> "Choose another app" ^> Inkleaf PDF ^> "Always".
echo.
start "" "%EXE%"
pause
