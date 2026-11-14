# KM AI Speed Test (speedtest-ai) installer for Windows.
# SPDX-License-Identifier: MIT. Copyright (c) 2026 Krutrim Mulyankan.
# https://krutrimmulyankan.in/speedtest/LICENSE.txt
#
#   irm https://krutrimmulyankan.in/speedtest/install.ps1 | iex
#
# Environment:
#   INSTALL_DIR               where to install (default: %LOCALAPPDATA%\Programs\speedtest-ai)
#   SPEEDTEST_AI_BASE_URL     download from another location (a URL, or a local folder)
#   SPEEDTEST_SKIP_CHECKSUM=1 install even when the download cannot be verified
#
# Works in Windows PowerShell 5.1 and PowerShell 7. Nothing is run after installing: a speed test
# spends real model tokens, so it starts only when you ask for it.

$ErrorActionPreference = 'Stop'

function Install-SpeedtestAi {
  $bundleName = 'speedtest-ai.cjs'
  # Filled in by scripts/release.mjs.
  $pinnedSha256 = '__SPEEDTEST_AI_SHA256__'
  $minNodeMajor = 20

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js $minNodeMajor or newer is required. Install it from https://nodejs.org and run this again." }
  $nodeVersion = (& node --version) -replace '^v', ''
  if ([int]($nodeVersion.Split('.')[0]) -lt $minNodeMajor) {
    throw "Node.js $minNodeMajor or newer is required (found $nodeVersion)."
  }

  $baseUrl = if ($env:SPEEDTEST_AI_BASE_URL) { $env:SPEEDTEST_AI_BASE_URL.TrimEnd('/', '\') } else { 'https://krutrimmulyankan.in/speedtest' }
  $installDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\speedtest-ai' }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("speedtest-ai-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $download = Join-Path $tmp $bundleName
    Write-Host "Downloading speedtest-ai from $baseUrl/$bundleName ..."
    if (Test-Path -LiteralPath $baseUrl -PathType Container) {
      Copy-Item -LiteralPath (Join-Path $baseUrl $bundleName) -Destination $download
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri "$baseUrl/$bundleName" -OutFile $download -UseBasicParsing
    }

    $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($pinnedSha256 -match '^[0-9a-f]{64}$') {
      if ($actual -ne $pinnedSha256) { throw "SHA-256 checksum mismatch, nothing was installed. Expected $pinnedSha256, got $actual." }
    } elseif ($env:SPEEDTEST_SKIP_CHECKSUM -ne '1') {
      throw 'This installer has no pinned checksum. Set SPEEDTEST_SKIP_CHECKSUM=1 to install anyway.'
    }

    $version = & node $download --version
    if ($LASTEXITCODE -ne 0) { throw "The downloaded program does not run on this Node.js ($nodeVersion). Nothing was installed." }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $staged = Join-Path $installDir ".$bundleName.new"
    Copy-Item -LiteralPath $download -Destination $staged -Force
    Move-Item -LiteralPath $staged -Destination (Join-Path $installDir $bundleName) -Force

    $shim = "@echo off`r`nnode `"%~dp0$bundleName`" %*`r`n"
    foreach ($name in 'speedtest-ai', 'kmspeed', 'aispeed') {
      [System.IO.File]::WriteAllText((Join-Path $installDir "$name.cmd"), $shim, [System.Text.Encoding]::ASCII)
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host ''
  Write-Host "Installed KM AI Speed Test ($version) to $installDir"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $onPath = ($userPath -split ';') -contains $installDir
  if (-not $onPath) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$($userPath.TrimEnd(';'));$installDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$installDir"
    Write-Host 'Added it to your user PATH. Open a new terminal for other windows to see it.'
  }

  Write-Host ''
  Write-Host 'Commands:'
  Write-Host '  speedtest-ai all          speed test every installed AI agent CLI and compare'
  Write-Host '  speedtest-ai detect       list which CLIs and APIs were found'
  Write-Host '  speedtest-ai run -t ID    test one target (for example: -t claude)'
  Write-Host '  speedtest-ai demo         simulated run, no model is called'
  Write-Host '  speedtest-ai update       install the latest version over this one'
  Write-Host ''
  Write-Host 'A real test sends a short prompt to each agent CLI and uses model tokens from your accounts.'
}

Install-SpeedtestAi
