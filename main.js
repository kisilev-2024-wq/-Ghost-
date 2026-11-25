@echo off
setlocal EnableExtensions
chcp 65001 >nul
title IP Watch
cd /d "%~dp0"
set "SELF=%~f0"
set "IPW_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText($env:SELF); $m='#PS'+'-BEGIN'; $n='#JS'+'-BEGIN'; iex $c.Substring($c.IndexOf($m), $c.IndexOf($n)-$c.IndexOf($m))"
echo.
echo Press any key to close...
pause >nul
exit /b
#PS-BEGIN
# ================= УСТАНОВЩИК / ЛАУНЧЕР (PowerShell) =================
$ErrorActionPreference = 'Stop'
try {
    $root = Split-Path -Parent $env:SELF
    Set-Location $root
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    function Step($t) { Write-Host "[setup] $t" -ForegroundColor Cyan }

    # --- 1. Выкладываем рабочий скрипт ip_watch.js из этого же файла ---
    $mJs  = '#JS' + '-BEGIN'
    $js   = $c.Substring($c.IndexOf($mJs) + $mJs.Length)
    $js   = $js.Substring($js.IndexOf("`n") + 1)
    $jsPath = Join-Path $root 'ip_watch.js'
    if (-not (Test-Path $jsPath) -or [IO.File]::ReadAllText($jsPath) -ne $js) {
        [IO.File]::WriteAllText($jsPath, $js, (New-Object System.Text.UTF8Encoding($false)))
        Step 'ip_watch.js создан/обновлён'
    }

    # --- 2. Ищем Node.js: сначала системный, потом портативный ---
    $node = $null
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        try {
            $v = (& $cmd.Source -v).Trim().TrimStart('v').Split('.')[0]
            if ([int]$v -ge 16) { $node = $cmd.Source }
        } catch {}
    }
    $dest = Join-Path $root 'node_portable'
    if (-not $node -and (Test-Path $dest)) {
        $exe = Get-ChildItem $dest -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($exe) { $node = $exe.FullName }
    }

    # --- 3. Нет Node? Качаем официальный портативный ZIP (админ не нужен) ---
    if (-not $node) {
        Step 'Node.js не найден. Скачиваю портативную версию (~30 МБ, один раз)...'
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $ver  = $null
        try {
            $list = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 30
            $rel  = $list | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
            if ($rel) { $ver = $rel.version }
        } catch { Step 'Не удалось получить список версий, беру запасную' }
        if (-not $ver) { $ver = 'v22.14.0' }

        $zipName = "node-$ver-win-$arch.zip"
        $base    = "https://nodejs.org/dist/$ver"
        $tmp     = Join-Path $env:TEMP $zipName
        Step "Загрузка: $base/$zipName"
        Invoke-WebRequest "$base/$zipName" -OutFile $tmp -UseBasicParsing -TimeoutSec 900

        # сверка SHA256 с официальным файлом подписей
        $expected = $null
        try {
            $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 30).Content
            $line = ($sums -split "`n" | Where-Object { $_.Trim().EndsWith($zipName) }) | Select-Object -First 1
            if ($line) { $expected = ($line.Trim() -split '\s+')[0].ToLower() }
        } catch { Step 'SHASUMS256 недоступен - проверка пропущена' }
        if ($expected) {
            $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
            if ($actual -ne $expected) { Remove-Item $tmp -Force; throw 'SHA256 не совпала - загрузка повреждена, установка прервана' }
            Step 'SHA256 совпала'
        }

        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        New-Item -ItemType Directory -Path $dest | Out-Null
        Step 'Распаковка...'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($tmp, $dest)
        Remove-Item $tmp -Force
        $node = (Get-ChildItem $dest -Recurse -Filter node.exe | Select-Object -First 1).FullName
    }
    if (-not $node) { throw 'Node.js не найден и не удалось установить' }
    Step "Node: $node  ($(& $node -v))"

    # --- 4. npm-зависимости: ставятся сами, если появится package.json ---
    $pkg = Join-Path $root 'package.json'
    if (Test-Path $pkg) {
        $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
        if ((Test-Path $npm) -and -not (Test-Path (Join-Path $root 'node_modules'))) {
            Step 'Устанавливаю npm-зависимости из package.json...'
            & $npm install --omit=dev --no-audit --no-fund
        }
    }

    # --- 5. Запуск ---
    $argv = @()
    if ($env:IPW_ARGS) { $argv = $env:IPW_ARGS.Trim() -split '\s+' }
    Write-Host ''
    & $node $jsPath @argv
    exit $LASTEXITCODE
}
catch {
    Write-Host "[setup] ОШИБКА: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Проверь интернет/антивирус или поставь Node вручную: winget install OpenJS.NodeJS.LTS' -ForegroundColor Yellow
    exit 1
}
#JS-BEGIN
'use strict';
/* ip_watch.js — мониторинг IP, лог на рабочем столе. Стоп: Ctrl+C */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const dns = require('dns');
const net = require('net');
const dgram = require('dgram');
const { execSync } = require('child_process');

/* ==================== НАСТРОЙКИ ==================== */
const CFG = {
  INTERVAL:        0.1,        // период проверки, сек
  MODE:            'public',   // 'public' | 'local' | 'both'
  PUBLIC_INTERVAL: 2.0,        // период для public в режиме 'both'
  TIMEOUT:         2.0,
  MAX_WORKERS:     8,
  ROTATE:          true,
  LOG_NAME:        'ip_watch.txt',
  LOG_ERRORS:      true,
  ERROR_STREAK:    20,
  UA:              'curl/8.4.0',
  PROVIDERS: [
    ['api.ipify.org',         '/'],
    ['icanhazip.com',         '/'],
    ['ifconfig.me',           '/ip'],
    ['checkip.amazonaws.com', '/'],
    ['ident.me',              '/'],
    ['ipinfo.io',             '/ip'],
  ],
};
/* =================================================== */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], val = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => (val !== null ? val : argv[++i]);
    switch (a) {
      case '--mode':            out.mode = next(); break;
      case '--interval':        out.interval = parseFloat(next()); break;
      case '--public-interval': out.publicInterval = parseFloat(next()); break;
      case '--file':            out.file = next(); break;
      case '--no-rotate':       out.rotate = false; break;
      case '-h': case '--help': out.help = true; break;
    }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log('Опции: --mode public|local|both | --interval 0.1 | --public-interval 2 | --file имя.txt | --no-rotate');
  process.exit(0);
}
if (ARGS.mode) CFG.MODE = ARGS.mode;
if (ARGS.file) CFG.LOG_NAME = ARGS.file;
if (ARGS.rotate === false) CFG.ROTATE = false;
const ARG_INTERVAL = isFinite(ARGS.interval) ? ARGS.interval : CFG.INTERVAL;
const ARG_PUB      = isFinite(ARGS.publicInterval) ? ARGS.publicInterval : CFG.PUBLIC_INTERVAL;

const pad = (n, w = 2) => String(n).padStart(w, '0');
function ts(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtDur(sec) {
  if (sec < 60) return `${sec.toFixed(3)} с`;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const human = h ? `${h} ч ${pad(m)} мин ${pad(s)} с` : `${m} мин ${pad(s)} с`;
  return `${sec.toFixed(3)} с (${human})`;
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function desktopDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    try {
      const cmd = 'powershell -NoProfile -NonInteractive -Command "' +
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')\"";
      const out = execSync(cmd, { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      if (out && isDir(out)) return out;
    } catch {}
    const cands = [];
    for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'])
      if (process.env[k]) cands.push(path.join(process.env[k], 'Desktop'));
    cands.push(path.join(home, 'Desktop'), path.join(home, 'Рабочий стол'));
    for (const c of cands) if (isDir(c)) return c;
    return home;
  }
  try {
    const cfg = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const m = cfg.match(/^\s*XDG_DESKTOP_DIR\s*=\s*"?([^"\n]+)"?/m);
    if (m) { const p = m[1].replace('$HOME', home); if (isDir(p)) return p; }
  } catch {}
  for (const c of [path.join(home, 'Desktop'), path.join(home, 'Рабочий стол')]) if (isDir(c)) return c;
  return home;
}

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: CFG.MAX_WORKERS });
function lookup4(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { family: 4, all: !!(options && options.all) }, cb);
}
function httpIp(host, urlPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = e => { if (!settled) { settled = true; reject(e); } };
    const req = https.request({
      host, path: urlPath, method: 'GET', agent, lookup: lookup4,
      headers: { 'User-Agent': CFG.UA, 'Accept': 'text/plain' },
      timeout: CFG.TIMEOUT * 1000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 4096) req.destroy(new Error('ответ слишком большой')); });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        const ip = (body.trim().split(/\r?\n/)[0] || '').trim();
        if (!net.isIP(ip)) return reject(new Error('не IP: ' + JSON.stringify(ip.slice(0, 60))));
        resolve(ip);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    req.end();
  });
}
async function getPublicIP(pidx) {
  let err = 'unknown';
  const first = CFG.PROVIDERS[pidx];
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return { ip: await httpIp(first[0], first[1]), err: null }; }
    catch (e) { err = `${first[0]}: ${e.message}`; }
  }
  const back = CFG.PROVIDERS[(pidx + 1) % CFG.PROVIDERS.length];
  try { return { ip: await httpIp(back[0], back[1]), err: null }; }
  catch (e) { err = `${back[0]}: ${e.message}`; }
  return { ip: null, err };
}
function getLocalIP() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (e, ip) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { s.close(); } catch {}
      e ? reject(e) : resolve(ip);
    };
    const timer = setTimeout(() => finish(new Error('local ip timeout')), 1000);
    s.on('error', e => finish(e));
    try { s.connect(53, '8.8.8.8', () => { try { finish(null, s.address().address); } catch (e) { finish(e); } }); }
    catch (e) { finish(e); }
  });
}

class Log {
  constructor(file) { this.path = file; this.fd = fs.openSync(file, 'w'); }
  line(s) { try { fs.writeSync(this.fd, s + os.EOL); } catch {} }
  close() { try { fs.fsyncSync(this.fd); fs.closeSync(this.fd); } catch {} }
}
class Tracker {
  constructor(kind, log) {
    this.kind = kind; this.log = log;
    this.ip = null; this.since = null; this.lastSeq = -1;
    this.changes = 0; this.checks = 0; this.errors = 0;
    this.errStreak = 0; this.downSince = null;
    this.stats = new Map();
  }
  _activate(ip, t) {
    this.ip = ip; this.since = t;
    if (!this.stats.has(ip)) this.stats.set(ip, { total: 0, sessions: 0 });
    this.stats.get(ip).sessions++;
  }
  _emit(line) { this.log.line(line); console.log(line); }
  handle(seq, ip, t, err) {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq; this.checks++;
    if (!ip) {
      this.errors++;
      if (this.errStreak === 0) this.downSince = t;
      this.errStreak++;
      if (CFG.LOG_ERRORS && this.errStreak === CFG.ERROR_STREAK)
        this.log.line(`[${ts(t)}] [${this.kind}] !! нет ответа ${this.errStreak} проверок подряд (${err})`);
      return;
    }
    if (this.errStreak >= CFG.ERROR_STREAK)
      this.log.line(`[${ts(t)}] [${this.kind}] связь восстановлена, простой ~${fmtDur((t - this.downSince) / 1000)}`);
    this.errStreak = 0;
    if (this.ip === null) {
      this._activate(ip, t);
      this._emit(`[${ts(t)}] [${this.kind}] Изначальный IP: ${ip}`);
      return;
    }
    if (ip !== this.ip) {
      const dur = (t - this.since) / 1000;
      const old = this.ip;
      this.changes++;
      this.stats.get(old).total += dur;
      this._activate(ip, t);
      this._emit(`[${ts(t)}] [${this.kind}] ИЗМЕНЕНИЕ #${this.changes} | новый IP: ${ip} | ` +
                 `предыдущий: ${old} | длительность предыдущего: ${fmtDur(dur)}`);
    }
  }
  finish(t) {
    this.log.line('');
    this.log.line(`[${ts(t)}] [${this.kind}] ОСТАНОВКА`);
    if (this.ip !== null) {
      const dur = (t - this.since) / 1000;
      this.stats.get(this.ip).total += dur;
      this.log.line(`[${this.kind}] текущий IP: ${this.ip} | держался: ${fmtDur(dur)}`);
    }
    this.log.line(`[${this.kind}] проверок: ${this.checks} | ошибок: ${this.errors} | изменений IP: ${this.changes}`);
    if (this.stats.size) {
      this.log.line(`[${this.kind}] суммарно по адресам:`);
      [...this.stats.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([ip, s]) => {
        this.log.line(`    ${ip.padEnd(40)} ${fmtDur(s.total)} | сессий: ${s.sessions}`);
      });
    }
  }
}

const periods = {};
if (CFG.MODE === 'local' || CFG.MODE === 'both') periods.local = Math.max(0.01, ARG_INTERVAL);
if (CFG.MODE === 'public') periods.public = Math.max(0.05, ARG_INTERVAL);
else if (CFG.MODE === 'both') periods.public = Math.max(0.2, ARG_PUB);
if (!Object.keys(periods).length) { console.error('Неверный --mode. Допустимо: public | local | both'); process.exit(1); }

let logPath = path.join(desktopDir(), CFG.LOG_NAME);
const existed = fs.existsSync(logPath);
let log;
try { log = new Log(logPath); }
catch { logPath = path.join(desktopDir(), `ip_watch_${Date.now()}.txt`); log = new Log(logPath); }

log.line('='.repeat(70));
log.line(`ЗАПУСК: ${ts(Date.now())}`);
log.line(`Файл: ${logPath} (${existed ? 'найден -> содержимое очищено' : 'создан заново'})`);
log.line(`Режим: ${CFG.MODE} | ` + Object.entries(periods).map(([k, v]) => `${k}: ${v} с`).join(' | '));
log.line('Формат: [время изменения] ИЗМЕНЕНИЕ #n | новый IP | предыдущий IP | сколько держался предыдущий');
log.line('='.repeat(70));
console.log(`Лог: ${logPath}`);
console.log('Мониторинг запущен. Ctrl+C — остановка.');

const trackers = {};
for (const k of Object.keys(periods)) trackers[k] = new Tracker(k, log);
const inflight = {}, timers = [];
let seqCounter = 0, provCursor = 0, stopped = false;

function tick(kind) {
  if (stopped) return;
  if ((inflight[kind] || 0) >= CFG.MAX_WORKERS) return;
  inflight[kind] = (inflight[kind] || 0) + 1;
  const seq = ++seqCounter;
  const pidx = CFG.ROTATE ? (provCursor++ % CFG.PROVIDERS.length) : 0;
  const task = kind === 'local'
    ? getLocalIP().then(ip => ({ ip, err: null })).catch(e => ({ ip: null, err: e.message }))
    : getPublicIP(pidx);
  task.then(({ ip, err }) => { if (!stopped) trackers[kind].handle(seq, ip, Date.now(), err); })
      .catch(() => {})
      .finally(() => { inflight[kind]--; });
}
for (const [kind, period] of Object.entries(periods)) {
  tick(kind);
  timers.push(setInterval(() => tick(kind), period * 1000));
}
function shutdown() {
  if (stopped) return;
  stopped = true;
  timers.forEach(clearInterval);
  const now = Date.now();
  for (const tr of Object.values(trackers)) tr.finish(now);
  log.line('='.repeat(70));
  log.close();
  console.log(`\nГотово. Лог: ${log.path}`);
  try { agent.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('unhandledRejection', e => console.error('Предупреждение:', e && e.message));
process.on('uncaughtException', e => { console.error('Ошибка:', e); shutdown(); });
