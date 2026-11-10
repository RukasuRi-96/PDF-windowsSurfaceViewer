# Inkleaf PDF setup (per-user, no admin rights needed).
# Downloads the official Electron runtime from GitHub, verifies its SHA-256,
# adds the Inkleaf app (app.asar) and creates shortcuts.
# Compatible with Windows PowerShell 5.1. Keep this file ASCII-only.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppVersion = '__APP_VERSION__'
$ElectronVersion = '__ELECTRON_VERSION__'
$ElectronSha256 = '__ELECTRON_SHA256__'

$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Inkleaf PDF'
$exe = Join-Path $dest 'InkleafPDF.exe'
$icon = Join-Path $dest 'icon.ico'
$zip = Join-Path ([IO.Path]::GetTempPath()) "inkleaf-electron-v$ElectronVersion-win32-x64.zip"
$url = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"

function Step([string]$n, [string]$text) {
  Write-Host ''
  Write-Host "[$n/3] $text" -ForegroundColor Cyan
}

# Run a native program without PowerShell 5.1 turning its stderr into errors.
function Invoke-Native([scriptblock]$block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $block | Out-Host } finally { $ErrorActionPreference = $old }
  return $LASTEXITCODE
}

function Test-Sha([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  return ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $ElectronSha256.ToUpper())
}

function Set-RegValue([string]$key, [string]$name, $value, [string]$type) {
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -LiteralPath $key -Name $name -Value $value -PropertyType $type -Force | Out-Null
}

try {
  Write-Host ''
  Write-Host "Inkleaf PDF $AppVersion setup" -ForegroundColor White
  Write-Host "Installing to: $dest"

  $asar = Join-Path $here 'app.asar'
  if (-not (Test-Path -LiteralPath $asar)) {
    throw 'app.asar was not found next to Setup. Please extract the whole zip first (right-click the zip > Extract All), then run Setup.cmd from the extracted folder.'
  }

  Get-Process -Name 'InkleafPDF' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000

  # ---- 1. runtime -------------------------------------------------------
  Step '1' 'Downloading the app runtime (about 160 MB) from GitHub...'
  if (Test-Sha $zip) {
    Write-Host 'Already downloaded earlier - reusing it.'
  } else {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $code = Invoke-Native { curl.exe -L --fail --retry 3 --retry-delay 2 --progress-bar -o $zip $url }
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $zip)) {
      Write-Host 'curl could not download it, trying another way (this can take a few minutes)...' -ForegroundColor Yellow
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
    if (-not (Test-Sha $zip)) {
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      throw 'The downloaded file did not pass its safety check (SHA-256 mismatch). Please run Setup again.'
    }
    Write-Host 'Download verified.'
  }

  # ---- 2. install -------------------------------------------------------
  Step '2' 'Installing...'
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $code = 1
  try { $code = Invoke-Native { tar.exe -xf $zip -C $dest } } catch { $code = 1 }
  if ($code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $dest 'electron.exe'))) {
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
  }
  Rename-Item -LiteralPath (Join-Path $dest 'electron.exe') -NewName 'InkleafPDF.exe'
  Remove-Item -LiteralPath (Join-Path $dest 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $asar -Destination (Join-Path $dest 'resources\app.asar') -Force
  foreach ($f in @('icon.ico', 'Uninstall.cmd', 'README.txt')) {
    $src = Join-Path $here $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $dest $f) -Force }
  }
  $licSrc = Join-Path $here 'licenses'
  if (Test-Path -LiteralPath $licSrc) { Copy-Item -LiteralPath $licSrc -Destination $dest -Recurse -Force }
  # Keep only English UI strings for Chromium (saves ~40 MB).
  Get-ChildItem -LiteralPath (Join-Path $dest 'locales') -Filter '*.pak' |
    Where-Object { $_.Name -ne 'en-US.pak' -and $_.Name -ne 'en-GB.pak' } |
    Remove-Item -Force
  if (-not (Test-Path -LiteralPath (Join-Path $dest 'resources\app.asar'))) { throw 'Install incomplete: app.asar missing.' }
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Install incomplete: InkleafPDF.exe missing.' }

  # ---- 3. shortcuts + Open with ----------------------------------------
  Step '3' 'Creating Start menu and Desktop shortcuts...'
  if ($onWindows) {
    Get-ChildItem -LiteralPath $dest -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    $shell = New-Object -ComObject WScript.Shell
    foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
      $lnk = $shell.CreateShortcut((Join-Path $dir 'Inkleaf PDF.lnk'))
      $lnk.TargetPath = $exe
      $lnk.WorkingDirectory = $dest
      $lnk.IconLocation = "$icon,0"
      $lnk.Description = 'Fast touch and pen PDF reader'
      $lnk.Save()
    }

    $classes = 'HKCU:\Software\Classes'
    $openCmd = '"' + $exe + '" "%1"'
    Set-RegValue "$classes\InkleafPDF.Document" '(Default)' 'PDF Document' 'String'
    Set-RegValue "$classes\InkleafPDF.Document\DefaultIcon" '(Default)' ('"' + $icon + '",0') 'String'
    Set-RegValue "$classes\InkleafPDF.Document\shell\open\command" '(Default)' $openCmd 'String'
    Set-RegValue "$classes\.pdf\OpenWithProgids" 'InkleafPDF.Document' '' 'String'
    Set-RegValue "$classes\Applications\InkleafPDF.exe\SupportedTypes" '.pdf' '' 'String'
    Set-RegValue "$classes\Applications\InkleafPDF.exe\DefaultIcon" '(Default)' ('"' + $icon + '",0') 'String'
    Set-RegValue "$classes\Applications\InkleafPDF.exe\shell\open\command" '(Default)' $openCmd 'String'

    $uk = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\InkleafPDF'
    Set-RegValue $uk 'DisplayName' 'Inkleaf PDF' 'String'
    Set-RegValue $uk 'DisplayIcon' ('"' + $icon + '",0') 'String'
    Set-RegValue $uk 'Publisher' 'Inkleaf' 'String'
    Set-RegValue $uk 'DisplayVersion' $AppVersion 'String'
    Set-RegValue $uk 'InstallLocation' $dest 'String'
    Set-RegValue $uk 'UninstallString' ('"' + (Join-Path $dest 'Uninstall.cmd') + '"') 'String'
    Set-RegValue $uk 'NoModify' 1 'DWord'
    Set-RegValue $uk 'NoRepair' 1 'DWord'
  } else {
    Write-Host '(not Windows: skipping shortcuts and registry)'
  }

  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

  Write-Host ''
  Write-Host 'Done! Inkleaf PDF is on your Start menu and Desktop.' -ForegroundColor Green
  Write-Host 'Tip: to open PDFs with it by default, right-click any PDF > Open with >'
  Write-Host '     Choose another app > Inkleaf PDF > Always.'
  if ($onWindows) { Start-Process -FilePath $exe }
  exit 0
} catch {
  Write-Host ''
  Write-Host ('Setup failed: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
