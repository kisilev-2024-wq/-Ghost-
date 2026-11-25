'use strict';
/* ip_watch.js — мониторинг IP, лог на рабочем столе. Запуск: node ip_watch.js  Стоп: Ctrl+C */

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
  INTERVAL:        0.1,
  MODE:            'public',   // 'public' | 'local' | 'both'
  PUBLIC_INTERVAL: 2.0,
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
  console.log('Options: --mode public|local|both | --interval 0.1 | --public-interval 2 | --file name.txt | --no-rotate');
  process.exit(0);
}
if (ARGS.mode) CFG.MODE = ARGS.mode;
if (ARGS.file) CFG.LOG_NAME = ARGS.file;
if (ARGS.rotate === false) CFG.ROTATE = false;
const ARG_INTERVAL = isFinite(ARGS.interval) ? ARGS.interval : CFG.INTERVAL;
const ARG_PUB      = isFinite(ARGS.publicInterval) ? ARGS.publicInterval : CFG.PUBLIC_INTERVAL;

const pad = (n, w) => String(n).padStart(w || 2, '0');

function ts(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
         pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}

function fmtDur(sec) {
  if (sec < 60) return sec.toFixed(3) + ' с';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const human = h ? (h + ' ч ' + pad(m) + ' мин ' + pad(s) + ' с') : (m + ' мин ' + pad(s) + ' с');
  return sec.toFixed(3) + ' с (' + human + ')';
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

function desktopDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    try {
      const cmd = 'powershell -NoProfile -NonInteractive -Command "' +
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')\"";
      const out = execSync(cmd, { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      if (out && isDir(out)) return out;
    } catch (e) {}
    const cands = [];
    ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'].forEach(function (k) {
      if (process.env[k]) cands.push(path.join(process.env[k], 'Desktop'));
    });
    cands.push(path.join(home, 'Desktop'), path.join(home, 'Рабочий стол'));
    for (const c of cands) if (isDir(c)) return c;
    return home;
  }
  try {
    const cfg = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const m = cfg.match(/^\s*XDG_DESKTOP_DIR\s*=\s*"?([^"\n]+)"?/m);
    if (m) { const p = m[1].replace('$HOME', home); if (isDir(p)) return p; }
  } catch (e) {}
  const list = [path.join(home, 'Desktop'), path.join(home, 'Рабочий стол')];
  for (const c of list) if (isDir(c)) return c;
  return home;
}

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: CFG.MAX_WORKERS });

function lookup4(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { family: 4, all: !!(options && options.all) }, cb);
}

function httpIp(host, urlPath) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const fail = function (e) { if (!settled) { settled = true; reject(e); } };
    const req = https.request({
      host: host, path: urlPath, method: 'GET', agent: agent, lookup: lookup4,
      headers: { 'User-Agent': CFG.UA, 'Accept': 'text/plain' },
      timeout: CFG.TIMEOUT * 1000
    }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; if (body.length > 4096) req.destroy(new Error('response too big')); });
      res.on('error', fail);
      res.on('end', function () {
        if (settled) return;
        settled = true;
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        const ip = (body.trim().split(/\r?\n/)[0] || '').trim();
        if (!net.isIP(ip)) return reject(new Error('not an IP: ' + JSON.stringify(ip.slice(0, 60))));
        resolve(ip);
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', fail);
    req.end();
  });
}

async function getPublicIP(pidx) {
  let err = 'unknown';
  const first = CFG.PROVIDERS[pidx];
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return { ip: await httpIp(first[0], first[1]), err: null }; }
    catch (e) { err = first[0] + ': ' + e.message; }
  }
  const back = CFG.PROVIDERS[(pidx + 1) % CFG.PROVIDERS.length];
  try { return { ip: await httpIp(back[0], back[1]), err: null }; }
  catch (e) { err = back[0] + ': ' + e.message; }
  return { ip: null, err: err };
}

function getLocalIP() {
  return new Promise(function (resolve, reject) {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = function (e, ip) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { s.close(); } catch (err) {}
      if (e) reject(e); else resolve(ip);
    };
    const timer = setTimeout(function () { finish(new Error('local ip timeout')); }, 1000);
    s.on('error', function (e) { finish(e); });
    try {
      s.connect(53, '8.8.8.8', function () {
        try { finish(null, s.address().address); } catch (e) { finish(e); }
      });
    } catch (e) { finish(e); }
  });
}

class Log {
  constructor(file) { this.path = file; this.fd = fs.openSync(file, 'w'); }
  line(s) { try { fs.writeSync(this.fd, s + os.EOL); } catch (e) {} }
  close() { try { fs.fsyncSync(this.fd); fs.closeSync(this.fd); } catch (e) {} }
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
        this.log.line('[' + ts(t) + '] [' + this.kind + '] !! нет ответа ' + this.errStreak + ' проверок подряд (' + err + ')');
      return;
    }
    if (this.errStreak >= CFG.ERROR_STREAK)
      this.log.line('[' + ts(t) + '] [' + this.kind + '] связь восстановлена, простой ~' + fmtDur((t - this.downSince) / 1000));
    this.errStreak = 0;

    if (this.ip === null) {
      this._activate(ip, t);
      this._emit('[' + ts(t) + '] [' + this.kind + '] Изначальный IP: ' + ip);
      return;
    }
    if (ip !== this.ip) {
      const dur = (t - this.since) / 1000;
      const old = this.ip;
      this.changes++;
      this.stats.get(old).total += dur;
      this._activate(ip, t);
      this._emit('[' + ts(t) + '] [' + this.kind + '] ИЗМЕНЕНИЕ #' + this.changes +
                 ' | новый IP: ' + ip + ' | предыдущий: ' + old +
                 ' | длительность предыдущего: ' + fmtDur(dur));
    }
  }
  finish(t) {
    this.log.line('');
    this.log.line('[' + ts(t) + '] [' + this.kind + '] ОСТАНОВКА');
    if (this.ip !== null) {
      const dur = (t - this.since) / 1000;
      this.stats.get(this.ip).total += dur;
      this.log.line('[' + this.kind + '] текущий IP: ' + this.ip + ' | держался: ' + fmtDur(dur));
    }
    this.log.line('[' + this.kind + '] проверок: ' + this.checks + ' | ошибок: ' + this.errors + ' | изменений IP: ' + this.changes);
    if (this.stats.size) {
      this.log.line('[' + this.kind + '] суммарно по адресам:');
      const arr = Array.from(this.stats.entries()).sort(function (a, b) { return b[1].total - a[1].total; });
      for (const item of arr) {
        this.log.line('    ' + item[0].padEnd(40) + ' ' + fmtDur(item[1].total) + ' | сессий: ' + item[1].sessions);
      }
    }
  }
}

const periods = {};
if (CFG.MODE === 'local' || CFG.MODE === 'both') periods.local = Math.max(0.01, ARG_INTERVAL);
if (CFG.MODE === 'public') periods.public = Math.max(0.05, ARG_INTERVAL);
else if (CFG.MODE === 'both') periods.public = Math.max(0.2, ARG_PUB);
if (!Object.keys(periods).length) { console.error('Bad --mode. Use: public | local | both'); process.exit(1); }

let logPath = path.join(desktopDir(), CFG.LOG_NAME);
const existed = fs.existsSync(logPath);
let log;
try { log = new Log(logPath); }
catch (e) { logPath = path.join(desktopDir(), 'ip_watch_' + Date.now() + '.txt'); log = new Log(logPath); }

const line70 = '='.repeat(70);
log.line(line70);
log.line('ЗАПУСК: ' + ts(Date.now()));
log.line('Файл: ' + logPath + ' (' + (existed ? 'найден -> содержимое очищено' : 'создан заново') + ')');
log.line('Режим: ' + CFG.MODE + ' | ' + Object.keys(periods).map(function (k) { return k + ': ' + periods[k] + ' с'; }).join(' | '));
log.line('Формат: [время изменения] ИЗМЕНЕНИЕ #n | новый IP | предыдущий IP | сколько держался предыдущий');
log.line(line70);
console.log('Лог: ' + logPath);
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
  const task = (kind === 'local')
    ? getLocalIP().then(function (ip) { return { ip: ip, err: null }; }).catch(function (e) { return { ip: null, err: e.message }; })
    : getPublicIP(pidx);
  task.then(function (r) { if (!stopped) trackers[kind].handle(seq, r.ip, Date.now(), r.err); })
      .catch(function () {})
      .then(function () { inflight[kind]--; });
}

for (const k of Object.keys(periods)) {
  tick(k);
  timers.push(setInterval((function (kind) { return function () { tick(kind); }; })(k), periods[k] * 1000));
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  timers.forEach(clearInterval);
  const now = Date.now();
  for (const k of Object.keys(trackers)) trackers[k].finish(now);
  log.line(line70);
  log.close();
  console.log('');
  console.log('Готово. Лог: ' + log.path);
  try { agent.destroy(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('unhandledRejection', function (e) { console.error('Предупреждение:', e && e.message); });
process.on('uncaughtException', function (e) { console.error('Ошибка:', e); shutdown(); });
