# Cubo CLI installer — https://cubo.spheceo.com
#
# Usage (PowerShell):
#   irm https://cubo.spheceo.com/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo = "spheceo/cubo"
$Target = "x86_64-pc-windows-msvc"
$Archive = "cubo-cli-$Target.tar.gz"
$BaseUrl = "https://github.com/$Repo/releases/latest/download"

# %LOCALAPPDATA%\Programs\cubo, added to the user PATH.
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\cubo"

Write-Host "Installing Cubo CLI..."

$Tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("cubo-install-" + [guid]::NewGuid()))
try {
  Write-Host "Downloading $Archive..."
  Invoke-WebRequest -Uri "$BaseUrl/$Archive" -OutFile (Join-Path $Tmp $Archive) -UseBasicParsing
  Invoke-WebRequest -Uri "$BaseUrl/$Archive.sha256" -OutFile (Join-Path $Tmp "$Archive.sha256") -UseBasicParsing

  Write-Host "Verifying checksum..."
  $Expected = (Get-Content (Join-Path $Tmp "$Archive.sha256")).Trim().Split(' ')[0].ToLower()
  $Actual = (Get-FileHash (Join-Path $Tmp $Archive) -Algorithm SHA256).Hash.ToLower()
  if ($Expected -ne $Actual) {
    throw "Checksum mismatch: expected $Expected, got $Actual."
  }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  tar xzf (Join-Path $Tmp $Archive) -C $Tmp
  foreach ($name in @("cubo.exe", "ffmpeg.exe", "ffprobe.exe")) {
    Move-Item -Force (Join-Path $Tmp $name) (Join-Path $InstallDir $name)
  }

  # Add to the user PATH if it is not there already.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable(
      'Path', "$userPath;$InstallDir", 'User')
    $env:Path += ";$InstallDir"
    Write-Host ""
    Write-Host "Added $InstallDir to your user PATH."
    Write-Host "Open a NEW terminal window for it to take effect, or run:"
    Write-Host "  `$env:Path += `";$InstallDir`""
  }
} finally {
  Remove-Item -Recurse -Force $Tmp
}

Write-Host ""
Write-Host "Windows may ask for permission the first time cubo serve starts —"
Write-Host "that is the standard firewall prompt; allow access on private networks."
Write-Host ""
Write-Host "Cubo installed. To start streaming:"
Write-Host "  1. Run:            cubo serve"
Write-Host "  2. A browser tab opens app.cubo.spheceo.com automatically."
Write-Host "     (Or open it yourself any time.)"
Write-Host "  3. Search titles:  cubo search `"avengers`""
Write-Host "  4. Update later:   cubo update"
Write-Host ""
Write-Host "Logs are saved to %LOCALAPPDATA%\cubo\logs\cubo.log"
