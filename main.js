'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var G = require('./anthropic-guard.js');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(cond, timeout, step) {
  var t0 = Date.now(), lim = timeout || 3000, gap = step || 5;
  while (Date.now() - t0 < lim) { if (cond()) return Date.now() - t0; await sleep(gap); }
  throw new Error('until(): timeout');
}

function makeFakeFw(latency, rejectLocal) {
  var rules = new Map();
  var fw = {
    rules: rules, rejectLocal: !!rejectLocal, ensureOnCalls: 0, failNext: 0,
    ensureOn: async function () { fw.ensureOnCalls += 1; },
    deleteRule: async function (n) { rules.delete(n); },
    createRule: async function (n, ips, en, local) {
      await sleep(latency);
      if (fw.rejectLocal && local && local.length) throw new Error('localip not supported');
      if (fw.failNext > 0) { fw.failNext -= 1; throw new Error('netsh failed'); }
      rules.set(n, { ips: ips, enabled: en, local: local && local.length ? local : null });
    },
    updateRule: async function (n, ips, en, local) {
      if (!rules.has(n)) throw new Error('no rule');
      await sleep(latency);
      if (fw.rejectLocal && local && local.length) throw new Error('localip not supported');
      if (fw.failNext > 0) { fw.failNext -= 1; throw new Error('netsh failed'); }
      rules.set(n, { ips: ips, enabled: en, local: local && local.length ? local : null });
    },
    blocked: function () { var r = rules.get(G.RULE_V4); return !!(r && r.enabled && !r.local); },
    wouldBlock: function (src) {
      var r = rules.get(G.RULE_V4);
      if (!r || !r.enabled) return false;
      if (!r.local) return true;
      var ranges = r.local.map(function (x) {
        var p = x.split('-');
        return [G.ipToInt(p[0]), G.ipToInt(p[1] || p[0])];
      });
      return G.inRanges(src, ranges);
    },
    v6blocked: function () { var r = rules.get(G.RULE_V6); return !!(r && r.enabled); }
  };
  return fw;
}
function makeFakeHosts() {
  var h = {
    last: null, writes: 0,
    write: function (d) { h.last = d.slice(); h.writes += 1; },
    isBlocked: function () { return !!(h.last && h.last.length); }
  };
  return h;
}

async function boot(opts) {
  var o = opts || {};
  var world = {
    ip: o.ip || '203.0.113.5', allowed: o.allowed === undefined ? ['203.0.113.5'] : o.allowed,
    net: 'a', local: '10.8.0.2', adapter: 'WireGuard Tunnel', failHosts: new Set(),
    failAll: false, fetchLatency: o.fetchLatency === undefined ? 20 : o.fetchLatency,
    netThrow: false, probe: async function () { return false; }, stringOnly: false,
    routeLocal: null
  };
  var fw = makeFakeFw(o.netsh === undefined ? 30 : o.netsh, o.rejectLocal);
  var logs = [];
  var hosts = makeFakeHosts();
  var guard = G.createGuard({
    fw: fw, hosts: hosts,
    fetchIp: o.fetchImpl ? function (p, t) { return o.fetchImpl(world, p, t); } : async function (p) {
      var started = world.ip, startedLocal = world.local;
      await sleep(world.fetchLatency);
      if (world.failAll || world.failHosts.has(p.host)) throw new Error('fail');
      return world.stringOnly ? started : { ip: started, local: startedLocal };
    },
    netSignature: function () { if (world.netThrow) throw new Error('boom'); return world.net; },
    srcIpTo: o.noRoute ? null : async function () { return world.routeLocal || world.local; },
    adapterMap: function () {
      var m = {};
      m[world.local] = world.adapter;
      m['192.168.1.5'] = 'Ethernet';
      return m;
    },
    probeConnect: o.canary ? function () { return world.probe.apply(null, arguments); } : undefined,
    killFlows: o.killFlows ? function () { world.killed = (world.killed || 0) + 1; return 1; } : null,
    readAllowed: function () { return world.allowed.slice(); },
    resolve4: o.resolve4 || (async function () { return []; }),
    resolve6: async function () { return []; },
    log: function (m) { logs.push(m); },
    config: Object.assign({
      CHECK_INTERVAL_MS: 20, FILE_REFRESH_MS: 100, MAX_AGE_MS: 250,
      EXIT_QUARANTINE_MS: 0, LOCALIP_RETRY_MS: 100000, FAST_INTERVAL_MS: 20
    }, o.config || {})
  });
  await guard.start();
  return { world: world, fw: fw, hosts: hosts, guard: guard, logs: logs };
}

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('cidrToRange / inRanges / ведущие нули', function () {
  var r = G.cidrToRange('160.79.104.0/21');
  assert.strictEqual(G.ipToInt('160.79.104.0'), r[0]);
  assert.strictEqual(G.ipToInt('160.79.111.255'), r[1]);
  assert.ok(G.inRanges('160.79.111.255', [r]));
  assert.ok(!G.inRanges('160.79.112.0', [r]));
  assert.ok(!G.inRanges('1.2.3.4', []));
  assert.strictEqual(G.cidrToRange('01.2.3.4'), null, 'ведущие нули запрещены');
  assert.strictEqual(G.cidrToRange('999.1.1.1'), null);
  assert.strictEqual(G.cidrToRange(''), null);
});

test('диапазоны Anthropic включают 153.61.224.0/22', function () {
  assert.ok(G.ANTHROPIC_RANGES_V4.indexOf('153.61.224.0/22') >= 0);
  assert.ok(G.inRanges('153.61.225.1', G.ANTHROPIC_RANGES_V4.map(G.cidrToRange)));
});

test('старт закрыт, открывается при IP из файла', async function () {
  var b = await boot();
  assert.ok(b.fw.blocked());
  assert.ok(b.hosts.last.length > 0);
  await until(function () { return !b.fw.blocked(); });
  assert.deepStrictEqual(b.hosts.last, []);
  assert.ok(b.fw.v6blocked());
  b.guard.stop();
});

test('смена IP x -> z -> x -> y блокирует и открывает', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.ip = '198.51.100.9';
  var t1 = await until(function () { return b.fw.blocked(); });
  b.world.ip = '203.0.113.5';
  await until(function () { return !b.fw.blocked(); });
  b.world.ip = '192.0.2.77';
  var t2 = await until(function () { return b.fw.blocked(); });
  console.log('    задержка блокировки: ' + t1 + ' и ' + t2 + ' мс');
  b.guard.stop();
});

test('все сервисы недоступны -> блокировка по таймауту, потом восстановление', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.failAll = true;
  await until(function () { return b.fw.blocked(); }, 1500);
  b.world.failAll = false;
  await until(function () { return !b.fw.blocked(); });
  b.guard.stop();
});

test('сбой одного сервиса не вызывает мигания', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.failHosts.add('icanhazip.com');
  var flaps = 0, t0 = Date.now();
  while (Date.now() - t0 < 800) { if (b.fw.blocked()) flaps += 1; await sleep(5); }
  assert.strictEqual(flaps, 0);
  b.guard.stop();
});

test('смена адаптеров закрывает мгновенно, устаревшие ответы игнорируются', async function () {
  var b = await boot({ fetchLatency: 150, config: { MAX_AGE_MS: 600 } });
  await until(function () { return !b.fw.blocked(); });
  b.world.net = 'b';
  var t = await until(function () { return b.fw.blocked(); }, 500);
  await sleep(60);
  assert.ok(b.fw.blocked(), 'устаревший ответ не должен открывать доступ');
  console.log('    блокировка после смены сети за ' + t + ' мс');
  await until(function () { return !b.fw.blocked(); }, 1500);
  b.guard.stop();
});

test('строгий режим: пусто -> закрыто, /24 -> закрыто, один IP -> открыто', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.allowed = [];
  await until(function () { return b.fw.blocked(); }, 1000);
  b.world.allowed = ['203.0.113.0/24'];
  await sleep(300);
  assert.ok(b.fw.blocked(), 'диапазон в строгом режиме запрещён');
  b.world.allowed = ['203.0.113.5', '203.0.113.6'];
  await sleep(300);
  assert.ok(b.fw.blocked(), 'два адреса запрещены');
  b.world.allowed = ['203.0.113.5'];
  await until(function () { return !b.fw.blocked(); }, 1000);
  b.guard.stop();
});

test('пустой файл никогда не открывает доступ', async function () {
  var b = await boot({ allowed: [] });
  var t0 = Date.now();
  while (Date.now() - t0 < 500) { assert.ok(b.fw.blocked()); await sleep(10); }
  b.guard.stop();
});

test('ошибка чтения файла -> закрыто', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.allowed = null;
  await until(function () { return b.fw.blocked(); }, 1000);
  b.guard.stop();
});

test('реалистичные задержки: сеть 150 мс, netsh 150 мс', async function () {
  var b = await boot({
    fetchLatency: 150, netsh: 150,
    config: { CHECK_INTERVAL_MS: 100, FILE_REFRESH_MS: 5000, MAX_AGE_MS: 1000 }
  });
  await until(function () { return !b.fw.blocked(); }, 4000);
  var lat = [];
  for (var i = 0; i < 5; i += 1) {
    b.world.ip = '198.51.100.' + (10 + i);
    lat.push(await until(function () { return b.fw.blocked(); }, 3000));
    b.world.ip = '203.0.113.5';
    await until(function () { return !b.fw.blocked(); }, 3000);
  }
  console.log('    задержки блокировки, мс: ' + lat.join(', '));
  b.guard.stop();
});

test('makeWindowsFw: корректные команды netsh, без delete перед add', async function () {
  var calls = [];
  var fw = G.makeWindowsFw(async function (cmd, args) { calls.push([cmd, args]); return {}; });
  await fw.createRule('R', ['1.2.3.0/24', '5.6.7.8'], true);
  await fw.updateRule('R', ['1.2.3.0/24'], true, ['0.0.0.0-10.8.0.1', '10.8.0.3-255.255.255.255']);
  assert.strictEqual(calls[0][0], 'netsh');
  assert.deepStrictEqual(calls[0][1], ['advfirewall', 'firewall', 'add', 'rule', 'name=R', 'dir=out',
    'action=block', 'protocol=any', 'remoteip=1.2.3.0/24,5.6.7.8', 'localip=any', 'enable=yes', 'profile=any']);
  assert.deepStrictEqual(calls[1][1], ['advfirewall', 'firewall', 'set', 'rule', 'name=R', 'new',
    'remoteip=1.2.3.0/24', 'localip=0.0.0.0-10.8.0.1,10.8.0.3-255.255.255.255', 'enable=yes']);
});

test('hosts: добавление, идемпотентность, удаление без следов', function () {
  var f = path.join(os.tmpdir(), 'hosts-test-' + process.pid);
  var original = '127.0.0.1 localhost\r\n::1 localhost\r\n';
  fs.writeFileSync(f, original);
  var h = G.makeHosts(f);
  h.write(['claude.ai', 'api.anthropic.com']);
  var once = fs.readFileSync(f, 'utf8');
  assert.ok(once.indexOf('0.0.0.0 claude.ai') >= 0 && once.indexOf(':: api.anthropic.com') >= 0);
  h.write(['claude.ai', 'api.anthropic.com']);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), once);
  h.write([]);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), original);
  fs.unlinkSync(f);
});

test('IP y не пропускается ни в какой момент', async function () {
  var b = await boot({ ip: '192.0.2.77' });
  var t0 = Date.now();
  while (Date.now() - t0 < 700) { assert.ok(b.fw.blocked(), 'y пропущен!'); assert.ok(b.fw.v6blocked()); await sleep(5); }
  b.guard.stop();
});

test('самовосстановление: правило удалили или отключили снаружи', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.ip = '192.0.2.77';
  await until(function () { return b.fw.blocked(); });
  b.fw.rules.delete(G.RULE_V4);
  await until(function () { return b.fw.blocked(); }, 1500);
  b.fw.rules.get(G.RULE_V4).enabled = false;
  await until(function () { return b.fw.blocked(); }, 1500);
  b.fw.rules.get(G.RULE_V6).enabled = false;
  await until(function () { return b.fw.v6blocked(); }, 1500);
  b.guard.stop();
});

test('самовосстановление hosts и повторное включение брандмауэра', async function () {
  var b = await boot({ ip: '192.0.2.77' });
  await sleep(150);
  b.hosts.last = [];
  await until(function () { return b.hosts.last.length > 0; }, 1500);
  assert.ok(b.fw.ensureOnCalls >= 2);
  b.guard.stop();
});

test('временные ошибки netsh: попытки повторяются', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.fw.failNext = 3;
  b.world.ip = '192.0.2.77';
  var t = await until(function () { return b.fw.blocked(); }, 3000);
  console.log('    блокировка встала через ' + t + ' мс при 3 сбоях netsh');
  b.guard.stop();
});

test('IP сервисов проверки защищены, домены Anthropic блокируются', async function () {
  var map = {
    'console.anthropic.com': ['160.79.104.10'],
    'www.claude.ai': ['172.64.1.1'],
    'ifconfig.me': ['104.18.1.1'],
    'claude.ai': ['104.18.1.1'],
    'api.ipify.org': ['9.9.9.9']
  };
  var r4 = async function (d) { return map[d] || []; };
  var b = await boot({ resolve4: r4, config: { BLOCK_SHARED_CDN_IPS: true } });
  await until(function () { return b.fw.rules.get(G.RULE_V4).ips.indexOf('172.64.1.1') >= 0; }, 1500);
  var ips = b.fw.rules.get(G.RULE_V4).ips;
  assert.ok(ips.indexOf('160.79.104.10') >= 0);
  assert.ok(ips.indexOf('104.18.1.1') < 0, 'IP сервиса проверки нельзя блокировать');
  b.guard.stop();
});

test('complementRanges', function () {
  var c = G.complementRanges([G.cidrToRange('10.8.0.2')]).map(G.rangeToStr);
  assert.deepStrictEqual(c, ['0.0.0.0-10.8.0.1', '10.8.0.3-255.255.255.255']);
  assert.deepStrictEqual(G.complementRanges([[0, 0xFFFFFFFF]]), []);
});

test('открыто: VPN проходит, остальные адаптеры режет ядро', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  assert.ok(!b.fw.wouldBlock('10.8.0.2'));
  assert.ok(b.fw.wouldBlock('192.168.1.5'));
  assert.ok(b.fw.v6blocked());
  b.guard.stop();
});

test('VPN упал: НОЛЬ утечек, ядро блокирует без ожидания проверок', async function () {
  var b = await boot({
    fetchLatency: 150, netsh: 150,
    config: { CHECK_INTERVAL_MS: 100, MAX_AGE_MS: 1000, FILE_REFRESH_MS: 5000 }
  });
  await until(function () { return !b.fw.blocked(); }, 4000);
  var leaked = 0;
  b.world.ip = '192.0.2.77'; b.world.local = '192.168.1.5'; b.world.net = 'b';
  var t0 = Date.now();
  while (Date.now() - t0 < 1200) { if (!b.fw.wouldBlock('192.168.1.5')) leaked += 1; await sleep(2); }
  assert.strictEqual(leaked, 0, 'трафик с обычного адаптера пропущен');
  b.guard.stop();
});

test('VPN переподключился: старый адрес закрыт, новый открыт после проверки', async function () {
  var b = await boot({ fetchLatency: 100 });
  await until(function () { return !b.fw.blocked(); });
  b.world.local = '10.8.0.9'; b.world.net = 'b';
  await until(function () { return b.fw.blocked(); }, 500);
  await until(function () { return !b.fw.blocked(); }, 1500);
  assert.ok(b.fw.wouldBlock('10.8.0.2'));
  assert.ok(!b.fw.wouldBlock('10.8.0.9'));
  b.guard.stop();
});

test('ИЗМЕРЕНИЕ окна: выход сменился на том же адаптере (принципиальный предел)', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  var leaked = 0, t0 = Date.now();
  b.world.ip = '198.51.100.9';
  while (!b.fw.blocked() && Date.now() - t0 < 2000) {
    if (!b.fw.wouldBlock('10.8.0.2')) leaked += 1;
    await sleep(2);
  }
  console.log('    окно ' + (Date.now() - t0) + ' мс, пропущенных проб: ' + leaked +
    ' — лечится только выделенным статическим IP');
  assert.ok(b.fw.blocked(), 'после обнаружения должно быть закрыто');
  b.guard.stop();
});

test('локальный адрес неизвестен: закрыто, правило НЕ выключается', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.stringOnly = true;
  b.world.net = 'b';
  await until(function () { return b.fw.blocked(); }, 1500);
  var r = b.fw.rules.get(G.RULE_V4);
  assert.ok(r.enabled, 'правило не должно выключаться');
  assert.ok(b.fw.wouldBlock('192.168.1.5'));
  assert.ok(b.fw.wouldBlock('10.8.0.2'));
  b.guard.stop();
});

test('Windows не принимает localip: остаёмся ЗАКРЫТЫМИ, без fail-open', async function () {
  var b = await boot({ rejectLocal: true, config: { LOCALIP_FAIL_LIMIT: 2 } });
  await sleep(400);
  assert.ok(b.guard.state().localipBroken, 'должен быть выставлен флаг');
  assert.ok(b.fw.blocked(), 'доступ обязан остаться закрытым');
  var r = b.fw.rules.get(G.RULE_V4);
  assert.ok(r.enabled, 'правило никогда не выключается');
  assert.ok(b.logs.some(function (m) { return m.indexOf('localip') >= 0; }));
  b.guard.stop();
});

test('карантин после чужого IP держит ворота закрытыми', async function () {
  var b = await boot({ config: { EXIT_QUARANTINE_MS: 600 } });
  await until(function () { return !b.fw.blocked(); });
  b.world.ip = '192.0.2.77';
  await until(function () { return b.fw.blocked(); }, 1000);
  b.world.ip = '203.0.113.5';
  await sleep(300);
  assert.ok(b.fw.blocked(), 'карантин ещё идёт');
  await until(function () { return !b.fw.blocked(); }, 2000);
  b.guard.stop();
});

test('маршрут ушёл мимо VPN при том же наборе адаптеров -> закрыто', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.routeLocal = '192.168.1.5';
  await until(function () { return b.fw.blocked(); }, 1000);
  assert.ok(b.guard.state().reason.indexOf('маршрут') >= 0);
  b.guard.stop();
});

test('не-туннельный адаптер не открывает доступ', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.adapter = 'Ethernet';
  b.world.net = 'b';
  await sleep(400);
  assert.ok(b.fw.blocked(), 'доступ через обычный адаптер открываться не должен');
  b.guard.stop();
});

test('разрыв установленных соединений при закрытии', async function () {
  var b = await boot({ killFlows: true });
  await until(function () { return !b.fw.blocked(); });
  b.world.ip = '192.0.2.77';
  await until(function () { return b.fw.blocked(); }, 1000);
  assert.ok(b.world.killed >= 1, 'соединения должны быть разорваны');
  b.guard.stop();
});

test('parseAllowed: комментарии, разделители, мусор, широкие диапазоны', function () {
  var warns = [];
  var r = G.parseAllowed([
    '# заголовок',
    '203.0.113.5   # мой VPN',
    '198.51.100.7, 198.51.100.8;198.51.100.0/24',
    'мусор 999.1.1.1',
    '0.0.0.0/0',
    '01.2.3.4',
    ''
  ].join('\r\n'), function (m) { warns.push(m); });
  assert.deepStrictEqual(r, ['203.0.113.5', '198.51.100.7', '198.51.100.8', '198.51.100.0/24']);
  assert.ok(warns.some(function (m) { return m.indexOf('999.1.1.1') >= 0; }));
  assert.ok(warns.some(function (m) { return m.indexOf('широкий') >= 0; }));
  assert.ok(warns.some(function (m) { return m.indexOf('01.2.3.4') >= 0; }));
});

test('decodeText: UTF-8 BOM, UTF-16 LE и BE', function () {
  var t = '203.0.113.5\r\n';
  assert.strictEqual(G.decodeText(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(t)])), t);
  assert.strictEqual(G.decodeText(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(t, 'utf16le')])), t);
  assert.strictEqual(G.decodeText(Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(t, 'utf16le').swap16()])), t);
});

test('parseArgs', function () {
  var a = G.parseArgs(['--unlock']);
  assert.strictEqual(a.unlock, true);
  assert.strictEqual(a.status, false);
  var b = G.parseArgs(['--status', '--file', 'C:\\a b\\ips.txt']);
  assert.strictEqual(b.status, true);
  assert.strictEqual(b.file, 'C:\\a b\\ips.txt');
  assert.strictEqual(G.parseArgs(['--file=x.txt']).file, 'x.txt');
  assert.strictEqual(G.parseArgs(['--install-watchdog']).install, true);
  assert.strictEqual(G.parseArgs(['--watchdog']).watchdog, true);
});

test('httpFetchIp: только IPv4, локальный адрес, мусор и ошибки', async function () {
  var EventEmitter = require('events').EventEmitter;
  function fake(body, status, local) {
    var seen = {};
    return {
      seen: seen,
      get: function (opts, cb) {
        seen.opts = opts;
        var req = new EventEmitter();
        req.destroy = function () { req.emit('close'); };
        setImmediate(function () {
          var res = new EventEmitter();
          res.statusCode = status === undefined ? 200 : status;
          res.socket = { localAddress: local === undefined ? '::ffff:10.8.0.2' : local };
          res.setEncoding = function () { };
          res.resume = function () { };
          cb(res);
          res.emit('data', body);
          res.emit('end');
        });
        return req;
      }
    };
  }
  var ok = fake('203.0.113.5\n');
  assert.deepStrictEqual(await G.httpFetchIp({ host: 'h', path: '/' }, 1000, ok), { ip: '203.0.113.5', local: '10.8.0.2' });
  assert.strictEqual(ok.seen.opts.family, 4);
  assert.strictEqual(await G.httpFetchIp({ host: 'h', path: '/' }, 1000, fake('203.0.113.5', 500)), null);
  assert.strictEqual(await G.httpFetchIp({ host: 'h', path: '/' }, 1000, fake('2001:db8::1')), null);
  assert.strictEqual(await G.httpFetchIp({ host: 'h', path: '/' }, 1000, fake('x'.repeat(500))), null);
});

test('failClosedSync: закрывает оба правила, создаёт отсутствующие, не бросает', function () {
  var calls = [];
  var hosts = { wrote: null, write: function (d) { this.wrote = d; } };
  G.failClosedSync(hosts, function (cmd, args) { calls.push([cmd, args]); });
  assert.strictEqual(calls[0][0], 'netsh');
  assert.ok(calls[0][1].indexOf('localip=any') >= 0);
  assert.ok(calls[0][1].indexOf('enable=yes') >= 0);
  assert.ok(calls[0][1].indexOf('name=' + G.RULE_V4) >= 0);
  assert.ok(calls.some(function (c) { return c[1].indexOf('name=' + G.RULE_V6) >= 0; }), 'IPv6 тоже');
  assert.deepStrictEqual(hosts.wrote, G.ANTHROPIC_DOMAINS);

  var calls2 = [];
  G.failClosedSync({ write: function () { } }, function (cmd, args) {
    calls2.push(args);
    if (args.indexOf('set') >= 0) throw new Error('no rule');
  });
  assert.ok(calls2.some(function (a) { return a.indexOf('add') >= 0; }), 'должен быть fallback на add');

  G.failClosedSync({ write: function () { throw new Error('x'); } }, function () { throw new Error('y'); });
});

test('монотонные часы: перевод времени назад не держит доступ открытым', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  var real = Date.now;
  Date.now = function () { return real() - 3600000; };
  try {
    b.world.failAll = true;
    await until(function () { return b.fw.blocked(); }, 1500);
  } finally { Date.now = real; }
  b.guard.stop();
});

test('внутренняя ошибка проверки сети -> закрыто, потом восстановление', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.world.netThrow = true;
  await until(function () { return b.fw.blocked(); }, 1000);
  assert.ok(b.logs.some(function (m) { return m.indexOf('Внутренняя ошибка') >= 0; }));
  b.world.netThrow = false;
  await until(function () { return !b.fw.blocked(); }, 1500);
  b.guard.stop();
});

test('повторяющиеся ошибки netsh не засоряют журнал', async function () {
  var b = await boot();
  await until(function () { return !b.fw.blocked(); });
  b.fw.failNext = 1e9;
  b.world.ip = '198.51.100.9';
  await sleep(1500);
  var errs = b.logs.filter(function (m) { return m.indexOf('Ошибка применения правил') >= 0; }).length;
  assert.ok(errs >= 1 && errs <= 2, 'сообщений: ' + errs);
  b.fw.failNext = 0;
  await until(function () { return b.fw.blocked(); }, 2000);
  b.guard.stop();
});

test('канарейка: утечка при закрытом доступе обнаруживается', async function () {
  var b = await boot({
    ip: '192.0.2.77', canary: true,
    resolve4: async function (d) { return d === 'api.anthropic.com' ? ['160.79.104.10'] : []; },
    config: { CANARY_INTERVAL_MS: 50, FILE_REFRESH_MS: 100000 }
  });
  await sleep(1800);
  assert.ok(b.fw.blocked());
  b.fw.rules.delete(G.RULE_V4);
  b.world.probe = async function () { return !b.fw.blocked(); };
  await until(function () { return b.fw.blocked(); }, 2000);
  assert.ok(b.guard.state().leaks >= 1);
  b.guard.stop();
});

test('канарейка молчит, пока доступ открыт', async function () {
  var b = await boot({ canary: true, config: { CANARY_INTERVAL_MS: 50 } });
  await until(function () { return !b.fw.blocked(); });
  await sleep(300);
  assert.strictEqual(b.guard.state().leaks, 0);
  b.guard.stop();
});

test('список найденных IP ограничен', async function () {
  var many = Array.from({ length: 500 }, function (_, i) {
    return '198.18.' + Math.floor(i / 250) + '.' + ((i % 250) + 1);
  });
  var b = await boot({
    ip: '192.0.2.77',
    resolve4: async function (d) { return d === 'api.anthropic.com' ? many : []; },
    config: { RESOLVED_MAX: 50 }
  });
  await until(function () { return (b.fw.rules.get(G.RULE_V4) || { ips: [] }).ips.length > 10; }, 2000);
  await sleep(200);
  var n = b.fw.rules.get(G.RULE_V4).ips.length;
  assert.ok(n <= G.ANTHROPIC_RANGES_V4.length + 50, 'в правиле ' + n + ' адресов');
  b.guard.stop();
});

test('watchdog: нет heartbeat -> принудительное закрытие', function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
  var file = path.join(dir, 'allowed_ip.txt');
  var calls = [];
  var hosts = { write: function () { } };
  var real = require('child_process').execFileSync;
  require('child_process').execFileSync = function (cmd, args) { calls.push(args); };
  try {
    var stale = G.watchdogCheck(file, hosts, function () { });
    assert.strictEqual(stale, true);
    assert.ok(calls.length > 0, 'должны быть вызовы netsh');
  } finally {
    require('child_process').execFileSync = real;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
});

(async function () {
  var failed = 0;
  for (var i = 0; i < tests.length; i += 1) {
    try { await tests[i][1](); console.log('OK  ' + tests[i][0]); }
    catch (e) { failed += 1; console.log('FAIL ' + tests[i][0] + '\n  ' + e.stack); }
  }
  console.log(failed ? '\nПровалено: ' + failed : '\nВсе тесты пройдены');
  process.exit(failed ? 1 : 0);
})();
