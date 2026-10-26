/**
 * dsh-nx, the Windows side.
 *
 * NX is a Windows desktop application and three of its failure modes live outside
 * the process: a missing window (screenshots render nothing), a minimized window
 * (NX exports an empty image and calls it success), and a stale syslog (the only
 * record of whether the plugin was loaded or refused). Each of those is inspected
 * here rather than inferred from "the port is open".
 *
 * @module @dsh-external/dsh-nx/win
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const POWERSHELL = 'powershell.exe'

/**
 * Run a PowerShell script with no profile, inheriting the current environment.
 * The script is passed as one argument, so it never goes through cmd.exe quoting.
 * @returns { stdout, stderr, code } — code is the exit status, or -1 on spawn failure.
 */
export function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
        })
      },
    )
  })
}

/** Escape a value for a single-quoted PowerShell string literal. */
export function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** True when a TCP endpoint accepts a connection within `timeoutMs`. */
export function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

/**
 * Look for a running image by name.
 * @returns { running, pids } — pids is what tasklist reported, and is empty when it cannot tell.
 */
export async function findProcess(imageName) {
  const { stdout } = await new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
      { timeout: 15000, windowsHide: true },
      (error, out) => resolve({ stdout: typeof out === 'string' ? out : '' }),
    )
  })
  const pids = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('"')) continue
    const cells = trimmed.split('","').map((cell) => cell.replace(/^"|"$/g, ''))
    if (cells[0].toLowerCase() !== imageName.toLowerCase()) continue
    const pid = Number(cells[1])
    if (Number.isFinite(pid)) pids.push(pid)
  }
  return { running: pids.length > 0, pids }
}

/** The newest NX syslog in %TEMP%, or null. NX writes one per startup. */
export function newestSyslog(tmpDir = os.tmpdir()) {
  let entries
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true })
  } catch {
    return null
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.syslog')) continue
    const full = path.join(tmpDir, entry.name)
    try {
      const stat = fs.statSync(full)
      files.push({ path: full, mtime: stat.mtimeMs, size: stat.size })
    } catch {
      // A syslog can disappear between readdir and stat while NX rotates it.
    }
  }
  if (files.length === 0) return null
  files.sort((a, b) => b.mtime - a.mtime)
  return files[0]
}

/**
 * Pull the load evidence out of a syslog.
 *
 * The distinction that matters, and that the nx-auto-mcp README spells out: a
 * missing `Loaded assembly` line is *not* proof that the DLL was refused. A crash
 * or a batch session truncates the log before the plugin is reached. So this
 * reports what was seen, never a verdict derived from absence alone.
 */
export function scanSyslog(text) {
  const lines = text.split(/\r?\n/)
  const evidence = {
    authenticated: false,
    signatureRejected: false,
    customDirs: '',
    customDirsAll: [],
    loadedFrom: [],
    fatalSignal: false,
  }
  for (const line of lines) {
    if (/Authentication passed/i.test(line)) evidence.authenticated = true
    if (/signature (is )?(not valid|invalid)|author license is not present/i.test(line)) {
      evidence.signatureRejected = true
    }
    if (/Loaded assembly: managed_plugin/i.test(line)) {
      const match = /from (.+)$/.exec(line)
      evidence.loadedFrom.push(match === null ? line.trim() : match[1].trim())
    }
    // NX logs several UGII_*_CUSTOM_DIRECTORY_FILE lines: the effective value, the
    // built-in default (prefixed with a [n] level), and UGII_UG_CUSTOM_DIRECTORY_FILE,
    // which contains the same words and would be matched by a substring test.
    if (!/UGII_UG_CUSTOM_DIRECTORY_FILE/i.test(line)) {
      const match = /^\s*(?:\[(\d+)\]\s*)?UGII_CUSTOM_DIRECTORY_FILE\s+(.+)$/i.exec(line)
      if (match !== null) {
        const value = match[2].trim()
        const level = match[1]
        if (!evidence.customDirsAll.includes(value)) evidence.customDirsAll.push(value)
        // An unprefixed line is the value NX actually used; a [n] line is a default.
        if (evidence.customDirs === '' && level === undefined) evidence.customDirs = value
      }
    }
    if (/O\/S ERROR: signal \d+ caught/i.test(line)) evidence.fatalSignal = true
  }
  if (evidence.customDirs === '' && evidence.customDirsAll.length > 0) evidence.customDirs = evidence.customDirsAll[0]
  return { ...evidence, loaded: evidence.loadedFrom.length > 0 }
}
/** Read at most the last `maxBytes` of a file, as UTF-8 text. */
export function readTail(filePath, maxBytes = 262144) {
  let handle
  try {
    const stat = fs.statSync(filePath)
    const start = Math.max(0, stat.size - maxBytes)
    handle = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(handle, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch {
        // Closing a handle that the OS already dropped is not actionable.
      }
    }
  }
}

const WINDOW_SCRIPT_HEADER = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class DshNxWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public static List<IntPtr> Handles = new List<IntPtr>();
  public static List<string> Titles = new List<string>();
  public static List<int> Pids = new List<int>();
  public static List<bool> Visible = new List<bool>();
  public static bool Collect(IntPtr h, IntPtr l) {
    int n = GetWindowTextLength(h);
    if (n > 0) {
      StringBuilder sb = new StringBuilder(n + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      Titles.Add(sb.ToString());
      Handles.Add(h);
      Pids.Add((int)pid);
      Visible.Add(IsWindowVisible(h));
    }
    return true;
  }
  public static void Run() { EnumWindows(Collect, IntPtr.Zero); }
}
"@
`

/**
 * Locate the NX main window.
 *
 * Matching on the title alone is not reliable: the title is "NX" on a fresh
 * session, "part - NX" once a part is open, and localised on other installs —
 * while a loose match on "NX" also hits unrelated windows (an Explorer folder
 * named "SiemensNX-2412", for instance). The owning process id is the stable
 * identity, so that is the filter; the title fragment only breaks ties.
 *
 * @param titleFragment - preferred fragment, used to rank candidates.
 * @param restore - restore and foreground the window when it is found.
 * @param pids - ugraf.exe process ids; empty falls back to title matching alone.
 * @returns { found, title, pid, wasMinimized, restored, minimized }
 */
export async function windowState(titleFragment, restore, pids = []) {
  const pidList = pids.filter((pid) => Number.isFinite(pid))
  const script =
    WINDOW_SCRIPT_HEADER +
    `
[DshNxWin]::Run()
$wanted = @(${pidList.join(',')})
$needle = ${psQuote(titleFragment)}
$candidates = @()
for ($i = 0; $i -lt [DshNxWin]::Handles.Count; $i++) {
  $title = [DshNxWin]::Titles[$i]
  if ([string]::IsNullOrWhiteSpace($title)) { continue }
  $procId = [DshNxWin]::Pids[$i]
  if ($wanted.Count -gt 0 -and ($wanted -notcontains $procId)) { continue }
  $candidates += [pscustomobject]@{
    Index = $i
    Title = $title
    Pid = $procId
    Visible = [DshNxWin]::Visible[$i]
    Named = ($title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  }
}
if ($candidates.Count -eq 0) { Write-Output '{"found":false}'; exit 0 }
$best = $candidates |
  Sort-Object -Property @{ Expression = 'Named'; Descending = $true },
                        @{ Expression = 'Visible'; Descending = $true },
                        @{ Expression = { $_.Title.Length }; Descending = $true } |
  Select-Object -First 1
$handle = [DshNxWin]::Handles[$best.Index]
$was = [DshNxWin]::IsIconic($handle)
$restored = $false
if (${restore ? '$true' : '$false'} -and $was) {
  [void][DshNxWin]::SendMessage($handle, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  $restored = $true
}
if (${restore ? '$true' : '$false'}) {
  [void][DshNxWin]::SetForegroundWindow($handle)
  [void][DshNxWin]::BringWindowToTop($handle)
}
$now = [DshNxWin]::IsIconic($handle)
@{ found = $true; title = $best.Title; pid = $best.Pid; wasMinimized = $was; restored = $restored; minimized = $now } | ConvertTo-Json -Compress
`
  const { stdout, stderr, code } = await runPowerShell(script, 45000)
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop()
  if (line === undefined) {
    return {
      found: false,
      title: '',
      pid: 0,
      wasMinimized: false,
      restored: false,
      minimized: false,
      error: stderr.trim() === '' ? `window probe exited ${code}` : stderr.trim().split(/\r?\n/)[0],
    }
  }
  try {
    return JSON.parse(line)
  } catch {
    return { found: false, title: '', pid: 0, wasMinimized: false, restored: false, minimized: false, error: 'unparseable window probe output' }
  }
}
/** Close enough to "the user's temp" for the syslog lookup. */
export function tempDirectory() {
  return os.tmpdir()
}
