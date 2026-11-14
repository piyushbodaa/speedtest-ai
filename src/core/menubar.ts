import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Menu-bar and tray front ends. They are thin: each one asks `speedtest-ai menu` what to show and
 * starts a test in a terminal window, where the live speedometer runs.
 *
 *   macOS    a plugin for SwiftBar (https://swiftbar.app), a free menu-bar host
 *   Windows  a PowerShell script that owns a notification-area icon
 *   Linux    Omarchy has its own plugin; other desktops have no front end yet
 */

export const SWIFTBAR_PLUGIN_NAME = 'km-ai-speedtest.30m.sh';
export const TRAY_SCRIPT_NAME = 'speedtest-ai-tray.ps1';
const STARTUP_SHORTCUT = 'KM AI Speed Test.lnk';

/** SwiftBar starts plugins with a bare PATH, so the script looks where node and the CLI usually live. */
export function swiftBarPlugin(command: string): string {
  return `#!/bin/bash
# <xbar.title>KM AI Speed Test</xbar.title>
# <xbar.version>1.0</xbar.version>
# <xbar.author>Krutrim Mulyankan</xbar.author>
# <xbar.desc>Tokens per second and time to first token for your AI agent CLIs.</xbar.desc>
# <xbar.abouturl>https://krutrimmulyankan.in/speedtest</xbar.abouturl>
# SPDX-License-Identifier: MIT. Copyright (c) 2026 Krutrim Mulyankan.
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>false</swiftbar.hideDisablePlugin>

CLI=${shellQuote(command)}
for dir in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/share/mise/shims" "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH

if ! command -v node >/dev/null 2>&1 || [ ! -f "$CLI" ]; then
  echo "⚡ AI"
  echo "---"
  echo "speedtest-ai is not installed | href=https://krutrimmulyankan.in/speedtest"
  exit 0
fi

node "$CLI" menu --swiftbar 2>/dev/null || {
  echo "⚡ AI"
  echo "---"
  echo "Could not read the agent list | color=red"
  echo "Refresh | refresh=true"
}
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The Windows notification-area icon. Windows PowerShell 5.1 compatible, no dependencies. */
export const TRAY_SCRIPT = String.raw`# KM AI Speed Test: notification-area icon. Written by "speedtest-ai menubar install".
# SPDX-License-Identifier: MIT. Copyright (c) 2026 Krutrim Mulyankan.
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$cli = Join-Path $PSScriptRoot 'speedtest-ai.cjs'

function Get-Menu {
  try {
    $json = & node $cli menu 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (($json -join [Environment]::NewLine) | ConvertFrom-Json)
  } catch { return $null }
}

# A test runs in its own console window, where the live speedometer is drawn.
function Start-Test([string[]]$TestArgs) {
  $line = 'node "' + $cli + '" ' + ($TestArgs -join ' ')
  Start-Process -FilePath $env:ComSpec -ArgumentList @('/k', $line)
}

function New-GaugeIcon {
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $track = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 237, 237, 237)), 3.5
  $accent = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 50, 145, 255)), 3.5
  $g.DrawArc($track, 4, 6, 24, 24, 150, 240)
  $g.DrawArc($accent, 4, 6, 24, 24, 150, 150)
  $g.DrawLine($accent, 16, 18, 23, 11)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
}

function Format-Last($agent) {
  if (-not $agent.last) { return 'not tested yet' }
  $tps = [double]$agent.last.tps
  $text = if ($tps -ge 100) { '{0:N0} tok/s' -f $tps } else { '{0:N1} tok/s' -f $tps }
  if ($agent.last.buffered) { $text += ' - no live stream' }
  elseif ($null -ne $agent.last.ttftMs) { $text += ' - {0:N1}s to first token' -f ([double]$agent.last.ttftMs / 1000) }
  if ($agent.last.slowStart) { $text += ' - slow start' }
  return $text
}

function Add-Item($items, [string]$text, [scriptblock]$onClick, [bool]$enabled = $true) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  # A single ampersand would be read as a keyboard mnemonic.
  $item.Text = $text.Replace('&', '&&')
  $item.Enabled = $enabled
  if ($onClick) { $item.add_Click($onClick) }
  [void]$items.Add($item)
  return $item
}

function Update-Menu($strip) {
  $strip.Items.Clear()
  $menu = Get-Menu
  if (-not $menu) {
    [void](Add-Item $strip.Items 'speedtest-ai could not be started' $null $false)
  } else {
    [void](Add-Item $strip.Items ('KM AI Speed Test ' + $menu.version) { Start-Process 'https://krutrimmulyankan.in/speedtest' })
    [void]$strip.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    $agents = @($menu.agents)
    if ($agents.Count -eq 0) {
      [void](Add-Item $strip.Items 'No AI agent CLI found on this PC' $null $false)
    } else {
      [void](Add-Item $strip.Items 'Test every agent' { Start-Test @('all') })
      [void]$strip.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
      foreach ($agent in $agents) {
        $id = [string]$agent.id
        $parent = Add-Item $strip.Items ($agent.name + '   ' + (Format-Last $agent)) $null
        if ($agent.runnable -and $id -match '^[a-z0-9][a-z0-9-]{0,31}$') {
          [void](Add-Item $parent.DropDownItems ('Test ' + $agent.name) { Start-Test @('run', '-t', $id, '--quick') }.GetNewClosure())
        } else {
          [void](Add-Item $parent.DropDownItems ([string]$agent.reason) $null $false)
        }
        if ($agent.last) { [void](Add-Item $parent.DropDownItems ([string]$agent.last.model) $null $false) }
      }
    }
    [void]$strip.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    [void](Add-Item $strip.Items 'A test uses real model tokens from your accounts' $null $false)
  }
  [void](Add-Item $strip.Items 'Exit' { $script:notify.Visible = $false; [System.Windows.Forms.Application]::Exit() })
}

$strip = New-Object System.Windows.Forms.ContextMenuStrip

if ($SelfTest) {
  Update-Menu $strip
  $icon = New-GaugeIcon
  foreach ($item in $strip.Items) { if ($item.Text) { Write-Output $item.Text } }
  Write-Output 'SELFTEST-OK'
  exit 0
}

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = New-GaugeIcon
$script:notify.Text = 'KM AI Speed Test'
$script:notify.ContextMenuStrip = $strip
# Rebuilt each time it opens, so new results and newly installed CLIs show up.
$strip.add_Opening({ Update-Menu $strip })
Update-Menu $strip
$script:notify.Visible = $true
[System.Windows.Forms.Application]::Run()
`;

export interface MenubarOutcome {
  ok: boolean;
  lines: string[];
}

function swiftBarPluginDir(home: string): { dir: string; configured: boolean } {
  const res = spawnSync('defaults', ['read', 'com.ameba.SwiftBar', 'PluginDirectory'], { encoding: 'utf8' });
  const configured = res.status === 0 && res.stdout.trim() !== '';
  return { dir: configured ? res.stdout.trim() : path.join(home, 'Library', 'Application Support', 'SwiftBar', 'Plugins'), configured };
}

function powershell(script: string): { status: number | null; stdout: string } {
  const res = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '' };
}

/** `command` is the absolute path of the installed speedtest-ai program. */
export function installMenubar(command: string, platform = process.platform, home = os.homedir()): MenubarOutcome {
  if (platform === 'darwin') {
    const { dir, configured } = swiftBarPluginDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SWIFTBAR_PLUGIN_NAME);
    fs.writeFileSync(file, swiftBarPlugin(command), { mode: 0o755 });
    const lines = [`Wrote the SwiftBar plugin to ${file}`];
    const hasSwiftBar = ['/Applications/SwiftBar.app', path.join(home, 'Applications', 'SwiftBar.app')].some((p) => fs.existsSync(p));
    if (!hasSwiftBar) {
      lines.push('SwiftBar is not installed. Install it (free): brew install --cask swiftbar');
      lines.push(`When it asks for a plugin folder, choose: ${dir}`);
    } else if (!configured) {
      lines.push(`Open SwiftBar and choose this plugin folder: ${dir}`);
    } else {
      spawnSync('open', ['-g', 'swiftbar://refreshallplugins']);
      lines.push('SwiftBar was asked to reload. Look for the ⚡ item in the menu bar.');
    }
    return { ok: true, lines };
  }
  if (platform === 'win32') {
    const dir = path.dirname(command);
    const script = path.join(dir, TRAY_SCRIPT_NAME);
    fs.writeFileSync(script, TRAY_SCRIPT.replace(/\r?\n/g, '\r\n'));
    const quoted = script.replace(/'/g, "''");
    const create = [
      "$startup = [Environment]::GetFolderPath('Startup')",
      `$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup '${STARTUP_SHORTCUT}'))`,
      "$link.TargetPath = (Get-Command powershell).Source",
      `$link.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${quoted}"'`,
      "$link.WindowStyle = 7",
      "$link.Description = 'KM AI Speed Test tray icon'",
      '$link.Save()',
      `Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','"${quoted}"'`,
    ].join('; ');
    const res = powershell(create);
    const lines = [`Wrote the tray script to ${script}`];
    if (res.status !== 0) {
      lines.push('Could not create the Startup shortcut or start the icon. Start it yourself with:');
      lines.push(`  powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`);
      return { ok: false, lines };
    }
    lines.push('The icon is in the notification area (it may be under the ^ arrow) and starts with Windows.');
    return { ok: true, lines };
  }
  return {
    ok: false,
    lines: [
      'There is no menu-bar front end for this desktop yet.',
      'On Omarchy, use the plugin: omarchy plugin add https://github.com/piyushbodaa/omarchy-km-ai-speedtest.git --enable',
    ],
  };
}

export function uninstallMenubar(command: string, platform = process.platform, home = os.homedir()): MenubarOutcome {
  if (platform === 'darwin') {
    const file = path.join(swiftBarPluginDir(home).dir, SWIFTBAR_PLUGIN_NAME);
    fs.rmSync(file, { force: true });
    spawnSync('open', ['-g', 'swiftbar://refreshallplugins']);
    return { ok: true, lines: [`Removed ${file}`] };
  }
  if (platform === 'win32') {
    const script = path.join(path.dirname(command), TRAY_SCRIPT_NAME);
    powershell(
      `Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) '${STARTUP_SHORTCUT}') -ErrorAction SilentlyContinue; ` +
        `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*${TRAY_SCRIPT_NAME}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    );
    fs.rmSync(script, { force: true });
    return { ok: true, lines: ['Removed the tray icon, its Startup shortcut and its script.'] };
  }
  return { ok: true, lines: ['Nothing to remove on this desktop.'] };
}
