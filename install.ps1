$ErrorActionPreference = 'Stop'

$Repo = 'funny-dog/agent-cleaner'
$InstallDir = if ($env:AGENT_CLEANER_INSTALL_DIR) {
  $env:AGENT_CLEANER_INSTALL_DIR
} else {
  Join-Path $HOME '.agent-cleaner\bin'
}

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($Arch -notin @('X64', 'Arm64')) {
  $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'X64' } else { $env:PROCESSOR_ARCHITECTURE }
}
if ($Arch -ne 'X64' -and $Arch -ne 'Arm64') {
  throw "Unsupported Windows architecture: $Arch"
}

$Asset = 'agent-cleaner-win32-x64.zip'
$Version = $env:AGENT_CLEANER_VERSION
if ($Version) {
  $Tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  $DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$Asset"
} else {
  $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$Asset"
}

$Proxy = if ($env:GITHUB_PROXY) { $env:GITHUB_PROXY } else { $env:DSHM_GITHUB_PROXY }
if ($Proxy) {
  $Proxy = $Proxy.TrimEnd('/')
  $DownloadUrl = "$Proxy/$DownloadUrl"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-cleaner-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
  $ZipPath = Join-Path $TmpDir $Asset
  $ExtractDir = Join-Path $TmpDir 'extract'
  Write-Host "Downloading $Asset from $DownloadUrl..."
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath -UseBasicParsing
  Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

  $SourceExe = Join-Path $ExtractDir 'agent-cleaner.exe'
  if (-not (Test-Path $SourceExe)) {
    throw 'Archive did not contain agent-cleaner.exe'
  }

  $DestExe = Join-Path $InstallDir 'agent-cleaner.exe'
  $DestAc = Join-Path $InstallDir 'ac.exe'
  Copy-Item -Path $SourceExe -Destination $DestExe -Force
  Copy-Item -Path $SourceExe -Destination $DestAc -Force

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $PathEntries = if ($UserPath) { $UserPath -split ';' | Where-Object { $_ } } else { @() }
  $AlreadyInPath = $PathEntries | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') }
  if (-not $AlreadyInPath) {
    $NewUserPath = (@($PathEntries) + @($InstallDir)) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
    $env:Path = "$InstallDir;$env:Path"
    Write-Host "Added $InstallDir to user PATH."
  }

  Write-Host "Installed: $DestExe"
  Write-Host "Alias:     $DestAc"
  Write-Host ''
  Write-Host "Run 'ac' to launch the interactive wizard, or 'ac --help' for all commands."
} finally {
  Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
