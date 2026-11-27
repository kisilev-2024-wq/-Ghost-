'use strict';
/*
 * anthropic-guard.js — сторож доступа к Anthropic (Windows, Node 16+, от администратора)
 *
 *   node anthropic-guard.js                     запуск
 *   node anthropic-guard.js --status            состояние
 *   node anthropic-guard.js --unlock            снять блокировки
 *   node anthropic-guard.js --install-watchdog  задача планировщика
 *   node anthropic-guard.js --remove-watchdog   удалить задачу
 *   node anthropic-guard.js --file "C:\путь\ips.txt"
 *
 * Правило брандмауэра НЕ ВЫКЛЮЧАЕТСЯ НИКОГДА, меняется только охват:
 *   закрыто -> localip=any (режется всё)
 *   открыто -> localip=все адреса КРОМЕ подтверждённого адаптера VPN
 * Уход трафика мимо VPN режется ядром мгновенно, без ожидания проверок.
 */

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http = require('http');
var dgram = require('dgram');
var dns = require('dns').promises;
var perf = require('perf_hooks').performance;
var cp = require('child_process');
var promisify = require('util').promisify;

// ───────────────────────── Настройки ─────────────────────────
var CONFIG = {
  CHECK_INTERVAL_MS: 1000,       // проверка публичного IP
  FAST_INTERVAL_MS: 100,         // локальная проверка маршрута (без трафика)
  FILE_REFRESH_MS: 2000,
  DNS_REFRESH_MS: 30000,
  MAINTAIN_MS: 5000,
  MAX_AGE_MS: 2200,              // нет свежего подтверждения -> закрыто
  MAX_INFLIGHT: 3,
  REQUEST_TIMEOUT_MS: 2500,
  PROVIDER_BACKOFF_MS: 8000,
  OPEN_AFTER_OK: 2,              // подряд подтверждений для открытия
  EXIT_QUARANTINE_MS: 15000,     // после чужого IP закрыто минимум столько
  LOCALIP_RETRY_MS: 60000,       // повтор пробы поддержки localip
  LOCALIP_FAIL_LIMIT: 3,         // сколько подряд отказов до verdict
  CANARY_INTERVAL_MS: 3000,
  CANARY_TIMEOUT_MS: 1500,
  RESOLVED_TTL_MS: 6 * 3600 * 1000,
  RESOLVED_MAX: 200,
  MIN_PREFIX: 24,                // короче — отвергается
  STRICT_SINGLE_IP: true,        // ровно один адрес /32
  REQUIRE_TUNNEL_ADAPTER: true,  // адрес обязан быть на туннельном адаптере
  BLOCK_SHARED_CDN_IPS: true,    // блокировать IP всех доменов Anthropic
  KILL_FLOWS_ON_CLOSE: true,     // рвать установленные соединения
  DISABLE_IPV6_TRANSITION: true, // отключить Teredo/6to4/ISATAP
  HEARTBEAT_MS: 1000,
  HEARTBEAT_STALE_MS: 10000
};

var FILE_NAME = 'allowed_ip.txt';
var LOG_FILE_NAME = 'anthropic-guard.log';
var HEARTBEAT_NAME = 'anthropic-guard.heartbeat';
var RULE_PREFIX = 'ANTHROPIC_GUARD';
var RULE_V4 = RULE_PREFIX + '_BLOCK_V4';
var RULE_V6 = RULE_PREFIX + '_BLOCK_V6';
var LEGACY_RULES = [
  RULE_PREFIX + '_ANTHROPIC_V4', RULE_PREFIX + '_ANTHROPIC_V6',
  RULE_PREFIX + '_LOCK_V4', RULE_PREFIX + '_LOCK_V6',
  RULE_PREFIX + '_FULL_V4', RULE_PREFIX + '_NARROW_V4', RULE_PREFIX + '_FULL_V6'
];
var TASK_NAME = 'AnthropicGuardWatchdog';
var HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
var MARK_BEGIN = '# >>> ANTHROPIC_GUARD BEGIN';
var MARK_END = '# <<< ANTHROPIC_GUARD END';

// Все диапазоны Anthropic (AS399358): inbound и outbound. Чужих сайтов там нет.
var ANTHROPIC_RANGES_V4 = ['160.79.104.0/21', '153.61.224.0/22', '153.61.208.0/20'];
var ANTHROPIC_RANGES_V6 = ['2607:6bc0::/48'];

var IP_PROVIDERS = [
  { host: 'api.ipify.org', path: '/' },
  { host: 'icanhazip.com', path: '/' },
  { host: 'checkip.amazonaws.com', path: '/' },
  { host: 'ifconfig.me', path: '/ip' }
];

var ANTHROPIC_DOMAINS = [
  'anthropic.com', 'www.anthropic.com', 'api.anthropic.com', 'a-api.anthropic.com',
  'console.anthropic.com', 'docs.anthropic.com', 'statsig.anthropic.com',
  'mcp-proxy.anthropic.com', 'assets-proxy.anthropic.com',
  'claude.ai', 'www.claude.ai', 'api.claude.ai',
  'claude.com', 'www.claude.com', 'platform.claude.com', 'docs.claude.com',
  'code.claude.com', 'support.claude.com',
  'claudeusercontent.com', 'bridge.claudeusercontent.com'
];
var ANTHROPIC_RESOLVE_DOMAINS = [
  'api.anthropic.com', 'console.anthropic.com', 'mcp-proxy.anthropic.com', 'platform.claude.com'
];
var TUNNEL_HINTS = ['wireguard', 'wintun', 'tun', 'tap', 'ppp', 'vpn', 'nordlynx',
  'proton', 'mullvad', 'amnezia', 'outline', 'openvpn', 'wg', 'zerotier', 'tailscale'];

function now() { return perf.now(); }

// ───────────────────────── IPv4 без регулярок ─────────────────────────
function ipv4ToInt(s) {
  if (typeof s !== 'string') return null;
  var t = s.trim();
  if (t.indexOf('/') >= 0) return null;
  var parts = t.split('.');
  if (parts.length !== 4) return null;
  var n = 0;
  for (var i = 0; i < 4; i += 1) {
    var p = parts[i];
    if (p.length < 1 || p.length > 3) return null;
    if (p.length > 1 && p.charAt(0) === '0') return null;
    var v = 0;
    for (var j = 0; j < p.length; j += 1) {
      var c = p.charCodeAt(j);
      if (c < 48 || c > 57) return null;
      v = v * 10 + (c - 48);
    }
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}
function intToIpv4(n) {
  return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256,
    Math.floor(n / 256) % 256, n % 256].join('.');
}
function cidrToRange(s) {
  if (typeof s !== 'string') return null;
  var t = s.trim();
  var slash = t.indexOf('/');
  var bits = 32;
  if (slash >= 0) {
    var bs = t.slice(slash + 1);
    if (bs.length < 1 || bs.length > 2) return null;
    for (var k = 0; k < bs.length; k += 1) {
      var cc = bs.charCodeAt(k);
      if (cc < 48 || cc > 57) return null;
    }
    bits = Number(bs);
    if (bits > 32) return null;
  }
  var n = ipv4ToInt(slash >= 0 ? t.slice(0, slash) : t);
  if (n === null) return null;
  var size = Math.pow(2, 32 - bits);
  var start = Math.floor(n / size) * size;
  return [start, start + size - 1];
}
function prefixOf(s) {
  var i = String(s).indexOf('/');
  return i >= 0 ? Number(String(s).slice(i + 1)) : 32;
}
function rangeToStr(r) {
  return r[0] === r[1] ? intToIpv4(r[0]) : intToIpv4(r[0]) + '-' + intToIpv4(r[1]);
}
function inRanges(ip, ranges) {
  var n = typeof ip === 'number' ? ip : ipv4ToInt(ip);
  if (n === null || !ranges || !ranges.length) return false;
  for (var i = 0; i < ranges.length; i += 1) {
    if (n >= ranges[i][0] && n <= ranges[i][1]) return true;
  }
  return false;
}
function complementRanges(ranges) {
  var sorted = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
  var out = [], cursor = 0;
  for (var i = 0; i < sorted.length; i += 1) {
    var s = sorted[i][0], e = sorted[i][1];
    if (s > cursor) out.push([cursor, s - 1]);
    if (e + 1 > cursor) cursor = e + 1;
  }
  if (cursor <= 4294967295) out.push([cursor, 4294967295]);
  return out;
}

// ───────────────────────── Брандмауэр ─────────────────────────
function makeWindowsFw(run) {
  var exec = run || promisify(cp.execFile);
  function nf(args) { return exec('netsh', ['advfirewall', 'firewall'].concat(args), { windowsHide: true }); }
  function localArg(local) { return 'localip=' + (local && local.length ? local.join(',') : 'any'); }
  function enableArg(en) { return 'enable=' + (en ? 'yes' : 'no'); }
  return {
    deleteRule: function (name) {
      return nf(['delete', 'rule', 'name=' + name]).catch(function () { });
    },
    createRule: function (name, ips, enabled, local) {
      return nf(['add', 'rule', 'name=' + name, 'dir=out', 'action=block', 'protocol=any',
        'remoteip=' + ips.join(','), localArg(local), enableArg(enabled), 'profile=any']);
    },
    updateRule: function (name, ips, enabled, local) {
      return nf(['set', 'rule', 'name=' + name, 'new',
        'remoteip=' + ips.join(','), localArg(local), enableArg(enabled)]);
    },
    ensureOn: function () {
      return exec('netsh', ['advfirewall', 'set', 'allprofiles', 'state', 'on'], { windowsHide: true });
    }
  };
}

function disableIpv6Transition(say) {
  [['interface', 'teredo', 'set', 'state', 'disabled'],
  ['interface', '6to4', 'set', 'state', 'disabled'],
  ['interface', 'isatap', 'set', 'state', 'disabled']].forEach(function (a) {
    try { cp.execFileSync('netsh', a, { stdio: 'ignore', windowsHide: true }); }
    catch (e) { say('Не удалось отключить ' + a[1] + ': ' + e.message); }
  });
}

// Синхронное аварийное закрытие: правило есть -> обновить, нет -> создать. Оба стека.
function failClosedSync(hosts, run) {
  var exec = run || cp.execFileSync;
  [[RULE_V4, ANTHROPIC_RANGES_V4], [RULE_V6, ANTHROPIC_RANGES_V6]].forEach(function (pair) {
    var name = pair[0], ips = pair[1];
    try {
      exec('netsh', ['advfirewall', 'firewall', 'set', 'rule', 'name=' + name, 'new',
        'localip=any', 'enable=yes'], { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      try {
        exec('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=' + name, 'dir=out',
          'action=block', 'protocol=any', 'remoteip=' + ips.join(','), 'localip=any',
          'enable=yes', 'profile=any'], { stdio: 'ignore', windowsHide: true });
      } catch (e2) { /* больше нечего сделать */ }
    }
  });
  try { hosts.write(ANTHROPIC_DOMAINS); } catch (e3) { /* hosts недоступен */ }
}

// ───────────────────────── hosts (атомарно) ─────────────────────────
function makeHosts(hostsPath, flush) {
  var doFlush = flush || function () { };
  return {
    write: function (domains) {
      var lines = fs.readFileSync(hostsPath, 'utf8').split('\n');
      var clean = [], skip = false;
      for (var i = 0; i < lines.length; i += 1) {
        var l = lines[i].replace('\r', '');
        if (l.indexOf(MARK_BEGIN) >= 0) { skip = true; continue; }
        if (l.indexOf(MARK_END) >= 0) { skip = false; continue; }
        if (!skip) clean.push(l);
      }
      while (clean.length && clean[clean.length - 1] === '') clean.pop();
      if (domains.length) {
        clean.push('', MARK_BEGIN);
        for (var j = 0; j < domains.length; j += 1) {
          clean.push('0.0.0.0 ' + domains[j]);
          clean.push(':: ' + domains[j]);
        }
        clean.push(MARK_END);
      }
      var tmp = hostsPath + '.agtmp';
      fs.writeFileSync(tmp, clean.join('\r\n') + '\r\n');
      fs.renameSync(tmp, hostsPath);
      doFlush();
    },
    isBlocked: function () { return fs.readFileSync(hostsPath, 'utf8').indexOf(MARK_BEGIN) >= 0; }
  };
}

// ───────────────────────── Сеть ─────────────────────────
// http вместо https: IP-эхо не содержит секретов, а TLS-перехват не ломает проверку.
function httpFetchIp(provider, timeoutMs, httpImpl) {
  var mod = httpImpl || http;
  return new Promise(function (resolve) {
    var settled = false;
    function done(v) { if (!settled) { settled = true; resolve(v); } }
    var req;
    try {
      req = mod.get({
        host: provider.host, path: provider.path, agent: false,
        timeout: timeoutMs, family: 4, headers: { 'User-Agent': 'curl/8.0' }
      }, function (res) {
        var raw = String((res.socket && res.socket.localAddress) || '');
        if (raw.indexOf('::ffff:') === 0) raw = raw.slice(7);
        var local = ipv4ToInt(raw) !== null ? raw : null;
        if (res.statusCode !== 200) { res.resume(); done(null); return; }
        var data = '';
        res.setEncoding('utf8');
        res.on('data', function (c) {
          data += c;
          if (data.length > 100) { try { req.destroy(); } catch (e) { } done(null); }
        });
        res.on('end', function () {
          var t = data.trim().split('\n')[0].trim();
          done(ipv4ToInt(t) !== null ? { ip: t, local: local } : null);
        });
        res.on('error', function () { done(null); });
      });
    } catch (e) { done(null); return; }
    req.on('timeout', function () { try { req.destroy(); } catch (e) { } done(null); });
    req.on('error', function () { done(null); });
    req.on('close', function () { done(null); });
  });
}

// Локальный адрес, с которого ОС отправила бы пакет. Пакеты НЕ отправляются.
function srcIpTo(target, timeoutMs) {
  return new Promise(function (resolve) {
    var s;
    try { s = dgram.createSocket('udp4'); } catch (e) { resolve(null); return; }
    var settled = false;
    function done(v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { s.close(); } catch (e) { }
      resolve(v);
    }
    var timer = setTimeout(function () { done(null); }, timeoutMs || 300);
    s.on('error', function () { done(null); });
    try {
      s.connect(443, target, function () {
        var a = null;
        try { a = s.address().address; } catch (e) { }
        done(ipv4ToInt(a) !== null ? a : null);
      });
    } catch (e) { done(null); }
  });
}

function netProbe(ip, port, timeoutMs) {
  return new Promise(function (resolve) {
    var s = net.connect({ host: ip, port: port, family: 4 });
    function done(v) { try { s.destroy(); } catch (e) { } resolve(v); }
    s.setTimeout(timeoutMs, function () { done(false); });
    s.once('connect', function () { done(true); });
    s.once('error', function () { done(false); });
  });
}

function adapterMap() {
  var m = {}, ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) { if (a.family === 'IPv4') m[a.address] = name; });
  });
  return m;
}
function netSignature() {
  var ifs = os.networkInterfaces(), rows = [];
  Object.keys(ifs).sort().forEach(function (n) {
    (ifs[n] || []).forEach(function (a) { rows.push(n + '|' + a.family + '|' + a.address); });
  });
  return rows.sort().join(';');
}
function isTunnelName(name) {
  var l = String(name || '').toLowerCase();
  for (var i = 0; i < TUNNEL_HINTS.length; i += 1) if (l.indexOf(TUNNEL_HINTS[i]) >= 0) return true;
  return false;
}

function killFlows(ipList, say) {
  var ranges = [];
  ipList.forEach(function (s) { var r = cidrToRange(s); if (r) ranges.push(r); });
  var out;
  try {
    out = cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      'Get-NetTCPConnection -State Established | ForEach-Object { $_.RemoteAddress + "," + $_.OwningProcess }'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  } catch (e) { say('Не удалось получить список соединений: ' + e.message); return 0; }
  var pids = {};
  out.split('\n').forEach(function (line) {
    var t = line.trim(), comma = t.indexOf(',');
    if (comma < 0) return;
    var pid = Number(t.slice(comma + 1).trim());
    if (!pid || pid === process.pid || pid <= 4) return;
    if (inRanges(t.slice(0, comma).trim(), ranges)) pids[pid] = true;
  });
  var killed = 0;
  Object.keys(pids).forEach(function (pid) {
    try {
      cp.execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      killed += 1;
      say('Разорвано соединение к Anthropic: процесс ' + pid + ' завершён.');
    } catch (e) { /* уже ушёл */ }
  });
  return killed;
}

// ───────────────────────── Ядро ─────────────────────────
function createGuard(deps) {
  var cfg = Object.assign({}, CONFIG, deps.config || {});
  var fw = deps.fw, hosts = deps.hosts, fetchIp = deps.fetchIp, readAllowed = deps.readAllowed;
  var netSig = deps.netSignature || function () { return ''; };
  var say = deps.log || function () { };
  var providers = deps.providers || IP_PROVIDERS;
  var resolve4 = deps.resolve4 || function (d) { return dns.resolve4(d); };
  var resolve6 = deps.resolve6 || function (d) { return dns.resolve6(d); };
  var probeConnect = deps.probeConnect || null;
  var routeSrc = deps.srcIpTo || null;
  var adapters = deps.adapterMap || adapterMap;
  var kill = deps.killFlows || null;

  var lastSaid = {};
  function sayOnce(key, msg, every) {
    var t = now(), gap = every || 5000;
    if (lastSaid[key] !== undefined && t - lastSaid[key] < gap) return;
    lastSaid[key] = t;
    say(msg);
  }

  var allowedRanges = [], allowedText = '', fileError = null;
  var lastIp = null, lastIpAt = -Infinity, lastLocal = null;
  var okStreak = 0, quarantineUntil = -Infinity;
  var seqCounter = 0, lastAcceptedSeq = 0, minValidSeq = 0, inflight = 0, rr = 0;
  var backoff = {};
  var lastNetSig = netSig();
  var routeOk = !routeSrc, routeSrcNow = null, routeCheckedAt = routeSrc ? -Infinity : Infinity;
  var desiredOpen = false, closeReason = 'запуск';
  var applied = { open: false, v4: '', v6: '', spec: '' };
  var syncing = false, syncing6 = false, fastBusy = false, dnsBusy = false;
  var ensureBusy = false, canaryBusy = false, stopped = false;
  var leaks = 0, localipBroken = false, localipFails = 0, closedSince = -Infinity, loggedIp = null;
  var resolved4 = {}, resolved6 = {}, protect4 = {};
  var timers = [];
  var resolveDomains = cfg.BLOCK_SHARED_CDN_IPS ? ANTHROPIC_DOMAINS : ANTHROPIC_RESOLVE_DOMAINS;

  function v4List() {
    var out = ANTHROPIC_RANGES_V4.slice();
    Object.keys(resolved4).forEach(function (ip) { if (!protect4[ip]) out.push(ip); });
    return out;
  }
  function v6List() { return ANTHROPIC_RANGES_V6.concat(Object.keys(resolved6)); }
  function remember(map, ip) { delete map[ip]; map[ip] = now(); }
  function pruneResolved() {
    var t = now();
    [resolved4, resolved6].forEach(function (m) {
      Object.keys(m).forEach(function (ip) { if (t - m[ip] > cfg.RESOLVED_TTL_MS) delete m[ip]; });
      var keys = Object.keys(m);
      while (keys.length > cfg.RESOLVED_MAX) delete m[keys.shift()];
    });
  }
  function routeTargets() {
    var t = [];
    Object.keys(resolved4).forEach(function (ip) { if (!protect4[ip] && t.length < 3) t.push(ip); });
    if (!t.length) t.push(intToIpv4(cidrToRange(ANTHROPIC_RANGES_V4[0])[0]));
    return t;
  }

  // Правило ВСЕГДА включено. Нет подтверждённого адреса -> полный блок.
  function ruleSpec(open) {
    if (!open || localipBroken || !lastLocal) return { enabled: true, local: null };
    var r = cidrToRange(lastLocal);
    if (!r) return { enabled: true, local: null };
    return { enabled: true, local: complementRanges([r]).map(rangeToStr) };
  }

  // Возвращает фактически применённый spec — чтобы applied не расходился с реальностью.
  function applyRule(name, ips, enabled, local) {
    return fw.updateRule(name, ips, enabled, local).then(function () {
      return { enabled: enabled, local: local && local.length ? local : null };
    }).catch(function (e) {
      if (local && local.length) {
        // проверяем, дело ли в localip: то же правило без условия
        return fw.updateRule(name, ips, true, null).then(function () {
          return { enabled: true, local: null, localRejected: true };
        }).catch(function () {
          return fw.createRule(name, ips, enabled, local).then(function () {
            return { enabled: enabled, local: local };
          });
        });
      }
      return fw.createRule(name, ips, enabled, local).then(function () {
        return { enabled: enabled, local: null };
      });
    });
  }

  function setRule(name, ips, enabled, local) {
    return applyRule(name, ips, enabled, local).then(function (spec) {
      if (spec.localRejected) {
        localipFails += 1;
        if (localipFails >= cfg.LOCALIP_FAIL_LIMIT && !localipBroken) {
          localipBroken = true;
          say('КРИТИЧНО: Windows не принимает привязку localip. Доступ остаётся ЗАКРЫТЫМ. ' +
            'Повторная проба через ' + Math.round(cfg.LOCALIP_RETRY_MS / 1000) + ' с.');
        }
      } else if (local && local.length) {
        localipFails = 0;
      }
      return spec;
    });
  }

  function sync() {
    if (syncing) return Promise.resolve();
    syncing = true;
    function loop() {
      var open = desiredOpen && !localipBroken;
      var v4 = v4List();
      var spec = ruleSpec(open);
      var v4s = JSON.stringify(v4), ss = JSON.stringify(spec);
      if (open === applied.open && v4s === applied.v4 && ss === applied.spec) return Promise.resolve();
      return setRule(RULE_V4, v4, spec.enabled, spec.local).then(function (actual) {
        var realOpen = !!(actual.enabled && actual.local && actual.local.length);
        if (realOpen !== applied.open) {
          try { hosts.write(realOpen ? [] : ANTHROPIC_DOMAINS); }
          catch (e) { sayOnce('hosts', 'Не удалось изменить hosts: ' + e.message); }
          say('Доступ к Anthropic: ' + (realOpen ? 'ОТКРЫТ (адаптер ' + lastLocal + ')' : 'ЗАБЛОКИРОВАН — ' + closeReason));
          if (!realOpen && cfg.KILL_FLOWS_ON_CLOSE && kill) {
            try { kill(v4, say); } catch (e) { sayOnce('kill', 'Разрыв соединений: ' + e.message); }
          }
        }
        applied.open = realOpen;
        applied.v4 = v4s;
        applied.spec = JSON.stringify({ enabled: actual.enabled, local: actual.local });
        closedSince = realOpen ? Infinity : now();
        return loop();
      });
    }
    return loop().catch(function (e) {
      sayOnce('sync', 'Ошибка применения правил: ' + e.message);
    }).then(function () { syncing = false; });
  }

  function sync6() {
    if (syncing6) return Promise.resolve();
    syncing6 = true;
    function loop() {
      var v6 = v6List(), v6s = JSON.stringify(v6);
      if (v6s === applied.v6) return Promise.resolve();
      return setRule(RULE_V6, v6, true, null).then(function () {
        applied.v6 = v6s;
        return loop();
      });
    }
    return loop().catch(function (e) {
      sayOnce('sync6', 'Ошибка применения IPv6-правила: ' + e.message);
    }).then(function () { syncing6 = false; });
  }

  function evaluate() {
    var t = now();
    var reason = null;
    if (fileError) reason = fileError;
    else if (!allowedRanges.length) reason = 'в файле нет разрешённого IP';
    else if (localipBroken) reason = 'Windows не поддерживает привязку к адаптеру';
    else if (!lastIp || t - lastIpAt > cfg.MAX_AGE_MS) reason = 'нет свежего подтверждения публичного IP';
    else if (!inRanges(lastIp, allowedRanges)) reason = 'публичный IP ' + lastIp + ' не из файла';
    else if (t < quarantineUntil) reason = 'карантин после чужого IP';
    else if (!lastLocal) reason = 'не определён локальный адрес адаптера';
    else if (!routeOk || t - routeCheckedAt > cfg.FAST_INTERVAL_MS * 4) reason = 'маршрут до Anthropic не через подтверждённый адаптер';
    else if (okStreak < cfg.OPEN_AFTER_OK) reason = 'ожидание повторного подтверждения';
    if (reason) closeReason = reason;
    desiredOpen = reason === null;
    sync();
    sync6();
  }

  function onIp(seq, r) {
    if (seq < minValidSeq || seq < lastAcceptedSeq) return;
    var ip = typeof r === 'string' ? r : r.ip;
    var local = (r && typeof r === 'object' && r.local) || null;
    if (ipv4ToInt(ip) === null) return;
    lastAcceptedSeq = seq;
    lastIp = ip;
    lastIpAt = now();
    if (inRanges(ip, allowedRanges) && local) {
      lastLocal = local;
      okStreak += 1;
    } else {
      okStreak = 0;
      lastLocal = null;
      quarantineUntil = now() + cfg.EXIT_QUARANTINE_MS;
      if (inRanges(ip, allowedRanges) && !local) {
        sayOnce('nolocal', 'Не удалось определить локальный адрес проверки — доступ закрыт.');
      } else {
        sayOnce('rotation', 'ВНИМАНИЕ: выходной IP ' + ip + ' не совпадает с файлом. ' +
          'Если VPN меняет адрес на том же адаптере, гарантировать отсутствие утечки невозможно — ' +
          'нужен выделенный статический IP.', 30000);
      }
    }
    if (ip !== loggedIp) {
      loggedIp = ip;
      say('Публичный IP: ' + ip + (inRanges(ip, allowedRanges) ? ' (есть в файле)' : ' (НЕТ в файле)'));
    }
    evaluate();
  }

  function pickProvider() {
    var t = now();
    for (var i = 0; i < providers.length; i += 1) {
      var p = providers[(rr + i) % providers.length];
      if ((backoff[p.host] || 0) <= t) { rr = (rr + i + 1) % providers.length; return p; }
    }
    var q = providers[rr % providers.length];
    rr += 1;
    return q;
  }
  function startCheck() {
    var p = pickProvider();
    seqCounter += 1;
    var seq = seqCounter;
    inflight += 1;
    Promise.resolve().then(function () { return fetchIp(p, cfg.REQUEST_TIMEOUT_MS); })
      .then(function (r) {
        if (r) onIp(seq, r); else backoff[p.host] = now() + cfg.PROVIDER_BACKOFF_MS;
      })
      .catch(function () { backoff[p.host] = now() + cfg.PROVIDER_BACKOFF_MS; })
      .then(function () { inflight -= 1; });
  }

  function tick() {
    if (stopped) return;
    try {
      var sig = netSig();
      if (sig !== lastNetSig) {
        lastNetSig = sig;
        lastIp = null; lastLocal = null; okStreak = 0; routeOk = !routeSrc;
        minValidSeq = seqCounter + 1;
        say('Сетевые настройки изменились: доступ закрыт до новой проверки.');
      }
      if (inflight < cfg.MAX_INFLIGHT) startCheck();
    } catch (e) {
      lastIp = null; lastLocal = null; okStreak = 0; routeOk = false;
      sayOnce('tick', 'Внутренняя ошибка проверки: ' + e.message + '. Доступ закрыт.');
    }
    evaluate();
  }

  function fastTick() {
    if (stopped || fastBusy || !routeSrc) return Promise.resolve();
    fastBusy = true;
    return Promise.all(routeTargets().map(function (t) { return routeSrc(t, 300); }))
      .then(function (srcs) {
        var map = adapters(), ok = true, first = null;
        for (var i = 0; i < srcs.length; i += 1) {
          var s = srcs[i];
          if (!s || ipv4ToInt(s) === null) { ok = false; break; }
          if (first === null) first = s;
          if (s !== first) { ok = false; break; }
          if (lastLocal && s !== lastLocal) { ok = false; break; }
          if (cfg.REQUIRE_TUNNEL_ADAPTER && !isTunnelName(map[s])) { ok = false; break; }
        }
        if (!ok && routeOk && desiredOpen) {
          sayOnce('route', 'Маршрут до Anthropic ушёл мимо VPN — мгновенное закрытие.', 2000);
          okStreak = 0;
        }
        routeOk = ok; routeSrcNow = first; routeCheckedAt = now();
        evaluate();
      })
      .catch(function () { routeOk = false; routeCheckedAt = now(); evaluate(); })
      .then(function () { fastBusy = false; });
  }

  function maintain() {
    if (typeof fw.ensureOn === 'function' && !ensureBusy) {
      ensureBusy = true;
      Promise.resolve().then(function () { return fw.ensureOn(); })
        .catch(function (e) { sayOnce('ensureOn', 'Не удалось включить брандмауэр: ' + e.message); })
        .then(function () { ensureBusy = false; });
    }
    if (typeof hosts.isBlocked === 'function') {
      try {
        var should = !applied.open;
        if (hosts.isBlocked() !== should) hosts.write(should ? ANTHROPIC_DOMAINS : []);
      } catch (e) { sayOnce('hosts', 'Не удалось проверить hosts: ' + e.message); }
    }
  }

  function refreshFile() {
    try {
      var list = readAllowed();
      fileError = null;
      if (cfg.STRICT_SINGLE_IP) {
        if (list.length !== 1) fileError = 'в файле должен быть РОВНО ОДИН IP (сейчас ' + list.length + ')';
        else if (prefixOf(list[0]) !== 32) fileError = 'разрешён только одиночный адрес /32';
      }
      allowedText = list.join(',');
      allowedRanges = fileError ? [] : list.map(cidrToRange).filter(Boolean);
    } catch (e) {
      allowedRanges = [];
      fileError = 'не удалось прочитать файл: ' + e.message;
      sayOnce('file', fileError);
    }
    applied.v4 = ''; applied.v6 = '';
    maintain();
    evaluate();
  }

  function refreshDns() {
    if (dnsBusy) return Promise.resolve();
    dnsBusy = true;
    var jobs = [];
    providers.forEach(function (p) {
      jobs.push(resolve4(p.host).then(function (r) { r.forEach(function (ip) { protect4[ip] = true; }); }));
    });
    resolveDomains.forEach(function (d) {
      jobs.push(resolve4(d).then(function (r) { r.forEach(function (ip) { remember(resolved4, ip); }); }));
    });
    ANTHROPIC_RESOLVE_DOMAINS.forEach(function (d) {
      jobs.push(resolve6(d).then(function (r) { r.forEach(function (ip) { remember(resolved6, ip); }); }));
    });
    return Promise.allSettled(jobs).then(function () {
      pruneResolved();
      dnsBusy = false;
      evaluate();
    });
  }

  function canary() {
    if (stopped || canaryBusy || !probeConnect) return Promise.resolve();
    if (applied.open || desiredOpen || now() - closedSince < 1500) return Promise.resolve();
    var target = Object.keys(resolved4).filter(function (ip) { return !protect4[ip]; })[0];
    if (!target) return Promise.resolve();
    canaryBusy = true;
    return probeConnect(target, 443, cfg.CANARY_TIMEOUT_MS).then(function (reachable) {
      if (reachable && !applied.open && !desiredOpen) {
        leaks += 1;
        say('ВНИМАНИЕ: подключение к Anthropic (' + target + ') прошло при закрытом доступе. Переустанавливаю правила.');
        applied.v4 = ''; applied.v6 = ''; applied.spec = '';
        maintain();
        evaluate();
      }
    }).catch(function () { }).then(function () { canaryBusy = false; });
  }

  function retryLocalip() {
    if (!localipBroken) return;
    localipBroken = false;
    localipFails = 0;
    say('Повторная проба поддержки localip.');
    evaluate();
  }

  function start() {
    // Сначала закрытое правило (update-or-create, без удаления), потом чистка legacy.
    return setRule(RULE_V4, v4List(), true, null)
      .then(function () { return setRule(RULE_V6, v6List(), true, null); })
      .then(function () {
        return Promise.all(LEGACY_RULES.map(function (n) { return fw.deleteRule(n); }));
      })
      .then(function () {
        applied = {
          open: false, v4: JSON.stringify(v4List()), v6: JSON.stringify(v6List()),
          spec: JSON.stringify({ enabled: true, local: null })
        };
        closedSince = now();
        try { hosts.write(ANTHROPIC_DOMAINS); } catch (e) { say('Не удалось изменить hosts: ' + e.message); }
        refreshFile();
        timers.push(setInterval(tick, cfg.CHECK_INTERVAL_MS));
        timers.push(setInterval(function () { fastTick(); }, cfg.FAST_INTERVAL_MS));
        timers.push(setInterval(refreshFile, cfg.FILE_REFRESH_MS));
        timers.push(setInterval(function () { refreshDns(); }, cfg.DNS_REFRESH_MS));
        timers.push(setInterval(maintain, cfg.MAINTAIN_MS));
        timers.push(setInterval(retryLocalip, cfg.LOCALIP_RETRY_MS));
        if (probeConnect && cfg.CANARY_INTERVAL_MS > 0) {
          timers.push(setInterval(function () { canary(); }, cfg.CANARY_INTERVAL_MS));
        }
        return refreshDns();
      });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    timers.forEach(clearInterval);
    desiredOpen = false;
    closeReason = 'остановка сторожа';
    try {
      cp.execFileSync('netsh', ['advfirewall', 'firewall', 'set', 'rule', 'name=' + RULE_V4,
        'new', 'localip=any', 'enable=yes'], { stdio: 'ignore', windowsHide: true });
    } catch (e) { /* правила нет */ }
    try { hosts.write(ANTHROPIC_DOMAINS); } catch (e) { /* hosts недоступен */ }
  }

  return {
    start: start, stop: stop, tick: tick, fastTick: fastTick, refreshFile: refreshFile,
    refreshDns: refreshDns, canary: canary, evaluate: evaluate,
    state: function () {
      return {
        open: applied.open, desired: desiredOpen, reason: closeReason, ip: lastIp,
        local: lastLocal, locals: lastLocal ? [lastLocal] : [], route: routeSrcNow,
        routeOk: routeOk, leaks: leaks, localipBroken: localipBroken, allowed: allowedText,
        okStreak: okStreak, quarantineMs: Math.max(0, Math.round(quarantineUntil - now()))
      };
    }
  };
}

// ───────────────────────── Файл, журнал, CLI ─────────────────────────
function getDesktop() {
  try {
    var p = cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath("Desktop")'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* запасной вариант ниже */ }
  var home = os.homedir();
  var cands = [path.join(home, 'Desktop'), path.join(home, 'Рабочий стол')];
  for (var i = 0; i < cands.length; i += 1) if (fs.existsSync(cands[i])) return cands[i];
  return home;
}
function ensureFile(file, say) {
  if (fs.existsSync(file)) return;
  var tell = say || function () { };
  try {
    fs.writeFileSync(file, [
      '# РОВНО ОДИН публичный IPv4-адрес, при котором разрешён доступ к Anthropic.',
      '# Это должен быть ваш ВЫДЕЛЕННЫЙ (статический) выходной IP VPN.',
      '# Диапазоны и несколько адресов запрещены: файл будет считаться некорректным.',
      '# Пока файл пуст или некорректен — доступ к Anthropic заблокирован.',
      '# Скрипт сам сюда ничего не пишет.',
      ''
    ].join('\r\n'));
    tell('Создан файл ' + file + ' (пустой). Впишите в него один разрешённый IP.');
  } catch (e) { tell('Не удалось создать файл ' + file + ': ' + e.message); }
}
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    var body = buf.slice(2);
    return Buffer.from(body.slice(0, body.length - (body.length % 2))).swap16().toString('utf16le');
  }
  var t = buf.toString('utf8');
  return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t;
}
function splitTokens(line) {
  var out = [], cur = '';
  for (var i = 0; i < line.length; i += 1) {
    var c = line.charAt(i);
    if (c === ' ' || c === '\t' || c === ',' || c === ';' || c === '\r') {
      if (cur) { out.push(cur); cur = ''; }
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function parseAllowed(text, warn) {
  var tell = warn || function () { };
  var valid = [];
  text.split('\n').forEach(function (rawLine) {
    var line = rawLine.split('#')[0].trim();
    if (!line) return;
    splitTokens(line).forEach(function (tok) {
      var r = cidrToRange(tok);
      if (!r) { tell('Пропущено (нужен корректный IPv4 или CIDR): ' + tok); return; }
      if (prefixOf(tok) < CONFIG.MIN_PREFIX) {
        tell('Отвергнуто: слишком широкий диапазон ' + tok + ' (короче /' + CONFIG.MIN_PREFIX + ').');
        return;
      }
      valid.push(tok);
    });
  });
  return valid;
}
var warned = {};
function readAllowedFile(file, say) {
  var tell = say || function () { };
  ensureFile(file, tell);
  return parseAllowed(decodeText(fs.readFileSync(file)), function (m) {
    if (!warned[m]) { warned[m] = true; tell(m); }
  });
}
function makeLogger(file) {
  return function (msg) {
    console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
    try {
      try { if (fs.statSync(file).size > 1048576) fs.renameSync(file, file + '.old'); } catch (e) { }
      fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + msg + '\r\n');
    } catch (e) { /* журнал необязателен */ }
  };
}
function parseArgs(argv) {
  var out = { unlock: false, status: false, watchdog: false, install: false, remove: false, file: null };
  for (var i = 0; i < argv.length; i += 1) {
    var a = argv[i];
    if (a === '--unlock') out.unlock = true;
    else if (a === '--status') out.status = true;
    else if (a === '--watchdog') out.watchdog = true;
    else if (a === '--install-watchdog') out.install = true;
    else if (a === '--remove-watchdog') out.remove = true;
    else if (a === '--file' && argv[i + 1]) { out.file = argv[i + 1]; i += 1; }
    else if (a.indexOf('--file=') === 0) out.file = a.slice(7);
  }
  return out;
}
function isAdmin() {
  var tries = [['fltmc', []], ['net', ['session']]];
  for (var i = 0; i < tries.length; i += 1) {
    try { cp.execFileSync(tries[i][0], tries[i][1], { stdio: 'ignore', windowsHide: true }); return true; }
    catch (e) { /* дальше */ }
  }
  return false;
}
function heartbeatPath(file) { return path.join(path.dirname(file), HEARTBEAT_NAME); }
function writeHeartbeat(file) {
  try { fs.writeFileSync(heartbeatPath(file), JSON.stringify({ pid: process.pid, ts: Date.now() })); }
  catch (e) { /* не критично */ }
}
function watchdogCheck(file, hosts, say) {
  var stale = true;
  try {
    var hb = JSON.parse(fs.readFileSync(heartbeatPath(file), 'utf8'));
    var alive = false;
    try { process.kill(hb.pid, 0); alive = true; } catch (e) { alive = false; }
    stale = !alive || (Date.now() - hb.ts) > CONFIG.HEARTBEAT_STALE_MS;
  } catch (e) { stale = true; }
  if (stale) {
    say('Watchdog: сторож не работает — принудительно закрываю доступ к Anthropic.');
    failClosedSync(hosts);
  }
  return stale;
}
function installWatchdog(file, say) {
  var tr = '"' + process.execPath + '" "' + path.resolve(__filename) + '" --watchdog --file "' + file + '"';
  [['MINUTE', ''], ['ONSTART', 'Boot']].forEach(function (s) {
    var args = ['/Create', '/TN', TASK_NAME + s[1], '/TR', tr, '/SC', s[0],
      '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'];
    if (s[0] === 'MINUTE') args.push('/MO', '1');
    try { cp.execFileSync('schtasks', args, { stdio: 'ignore', windowsHide: true }); }
    catch (e) { say('Не удалось создать задачу ' + s[0] + ': ' + e.message); }
  });
  say('Watchdog установлен: раз в минуту и при старте системы.');
}
function removeWatchdog(say) {
  [TASK_NAME, TASK_NAME + 'Boot'].forEach(function (n) {
    try { cp.execFileSync('schtasks', ['/Delete', '/TN', n, '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch (e) { /* задачи нет */ }
  });
  say('Watchdog удалён.');
}
function warnProxy(say) {
  var found = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .filter(function (k) { return process.env[k]; });
  if (found.length) {
    say('ВНИМАНИЕ: задан прокси (' + found.join(', ') + '). Трафик через прокси идёт на адрес прокси, ' +
      'и правила по IP Anthropic его не увидят.');
  }
}
function showStatus(file, hosts) {
  console.log('Файл разрешённых IP: ' + file);
  var entries = [];
  try { entries = readAllowedFile(file, function (m) { console.log('! ' + m); }); }
  catch (e) { console.log('не удалось прочитать: ' + e.message); }
  console.log('записей: ' + entries.length + (entries.length ? ' (' + entries.join(', ') + ')' : ''));
  return Promise.all(IP_PROVIDERS.map(function (p) { return httpFetchIp(p, 3000); }))
    .then(function (rs) {
      var r = rs.filter(Boolean)[0] || null;
      console.log('Текущий публичный IP: ' + (r ? r.ip : 'не удалось определить'));
      console.log('Локальный адрес проверки: ' + (r && r.local ? r.local : 'не определён'));
      if (r && r.local) {
        var name = adapterMap()[r.local];
        console.log('Адаптер: ' + (name || '?') + (isTunnelName(name) ? ' (туннельный)' : ' (НЕ туннельный)'));
      }
      [RULE_V4, RULE_V6].forEach(function (n) {
        var ok = true;
        try {
          cp.execFileSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + n],
            { stdio: 'ignore', windowsHide: true });
        } catch (e) { ok = false; }
        console.log('Правило ' + n + ': ' + (ok ? 'есть' : 'НЕТ'));
      });
      var blocked = false;
      try { blocked = hosts.isBlocked(); } catch (e) { }
      console.log('Блок в hosts: ' + (blocked ? 'есть' : 'нет'));
      try {
        var hb = JSON.parse(fs.readFileSync(heartbeatPath(file), 'utf8'));
        console.log('Сторож: pid ' + hb.pid + ', heartbeat ' + Math.round((Date.now() - hb.ts) / 1000) + ' с назад');
      } catch (e) { console.log('Сторож: heartbeat не найден (не запущен?)'); }
    });
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') { console.error('Скрипт рассчитан на Windows.'); process.exit(1); }
  if (!isAdmin()) { console.error('Запустите терминал от имени администратора.'); process.exit(1); }
  try { cp.execFileSync('cmd', ['/c', 'chcp 65001>nul'], { stdio: 'inherit' }); } catch (e) { }

  var flush = function () { cp.execFile('ipconfig', ['/flushdns'], { windowsHide: true }, function () { }); };
  var fw = makeWindowsFw();
  var hosts = makeHosts(HOSTS_PATH, flush);
  var file = args.file ? path.resolve(args.file) : path.join(getDesktop(), FILE_NAME);
  var logger = makeLogger(path.join(path.dirname(file), LOG_FILE_NAME));

  if (args.remove) { removeWatchdog(logger); return Promise.resolve(); }
  if (args.install) { ensureFile(file, logger); installWatchdog(file, logger); return Promise.resolve(); }
  if (args.watchdog) { watchdogCheck(file, hosts, logger); return Promise.resolve(); }
  if (args.unlock) {
    return Promise.all([RULE_V4, RULE_V6].concat(LEGACY_RULES).map(function (n) { return fw.deleteRule(n); }))
      .then(function () {
        try { hosts.write([]); } catch (e) { logger('Не удалось изменить hosts: ' + e.message); }
        try { fs.unlinkSync(heartbeatPath(file)); } catch (e) { }
        logger('Все блокировки сняты.');
      });
  }
  if (args.status) return showStatus(file, hosts);

  ensureFile(file, logger);
  if (CONFIG.DISABLE_IPV6_TRANSITION) disableIpv6Transition(logger);
  warnProxy(logger);

  var guard = createGuard({
    fw: fw, hosts: hosts, fetchIp: httpFetchIp, netSignature: netSignature,
    log: logger, probeConnect: netProbe, killFlows: killFlows, srcIpTo: srcIpTo,
    readAllowed: function () { return readAllowedFile(file, logger); }
  });

  var closing = false;
  function closeAndExit(code, reason) {
    if (closing) return;
    closing = true;
    logger(reason);
    try { guard.stop(); } catch (e) { }
    failClosedSync(hosts);
    try { fs.unlinkSync(heartbeatPath(file)); } catch (e) { }
    process.exit(code);
  }
  ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].forEach(function (sig) {
    process.on(sig, function () { closeAndExit(0, 'Остановлено: доступ к Anthropic закрыт (снять: --unlock).'); });
  });
  process.on('uncaughtException', function (e) {
    console.error(e);
    closeAndExit(1, 'Аварийная остановка (' + e.message + '): доступ закрыт.');
  });
  process.on('unhandledRejection', function (e) {
    closeAndExit(1, 'Необработанная ошибка (' + (e && e.message ? e.message : e) + '): доступ закрыт.');
  });

  return guard.start().then(function () {
    writeHeartbeat(file);
    setInterval(function () { writeHeartbeat(file); }, CONFIG.HEARTBEAT_MS);
    logger('Сторож запущен. Файл: ' + file);
    logger('Правило брандмауэра никогда не выключается; при открытии разрешён только подтверждённый адаптер.');
    logger('Остановка: Ctrl+C (доступ закроется). Рекомендую: --install-watchdog.');
  }).catch(function (e) {
    closeAndExit(1, 'Не удалось запустить сторож: ' + e.message);
  });
}

module.exports = {
  main: main, createGuard: createGuard, makeWindowsFw: makeWindowsFw, makeHosts: makeHosts,
  failClosedSync: failClosedSync, httpFetchIp: httpFetchIp, parseAllowed: parseAllowed,
  decodeText: decodeText, parseArgs: parseArgs, cidrToRange: cidrToRange, inRanges: inRanges,
  ipv4ToInt: ipv4ToInt, ipToInt: ipv4ToInt, intToIp: intToIpv4, intToIpv4: intToIpv4,
  complementRanges: complementRanges, rangeToStr: rangeToStr, isTunnelName: isTunnelName,
  prefixOf: prefixOf, watchdogCheck: watchdogCheck, heartbeatPath: heartbeatPath,
  CONFIG: CONFIG, RULE_V4: RULE_V4, RULE_V6: RULE_V6, ANTHROPIC_DOMAINS: ANTHROPIC_DOMAINS,
  ANTHROPIC_RANGES_V4: ANTHROPIC_RANGES_V4, MARK_BEGIN: MARK_BEGIN, MARK_END: MARK_END
};

if (require.main === module) {
  main().catch(function (e) { console.error(e); process.exit(1); });
}
