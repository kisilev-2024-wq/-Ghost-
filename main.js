// VERSION: 3.8.0
// main.js — сбор картинки капчи со стены item_frame'ов, 10 раундов
//
// ======================= ЧТО ИСПРАВЛЕНО В v3.8.0 =======================
// 1. [ГЛАВНАЯ ПРИЧИНА «КАШИ» ИЗ ПЛИТОК] Старый assembleWallAuto() ВСЕГДА
//    перебирал все перестановки колонок и брал минимум «цены шва» по
//    ink-маске, а ориентацию брал первую подошедшую (hAsc_yDesc, т.е.
//    «слева меньшие x»). Это верно, только если бот смотрит на стену со
//    стороны +z. С другой стороны картинка зеркальная, и перебор
//    перестановок «чинил» её наугад → плитки перемешивались.
//    Теперь: (а) направление «лево→право» считается по позиции бота
//    относительно плоскости стены; (б) цена швов считается по реальной
//    RGB-палитре карты, а не по бинарной маске; (в) перестановка колонок
//    применяется ТОЛЬКО если она явно лучше (на 25%) порядка по
//    координатам; (г) при почти равных ценах приоритет у варианта,
//    полученного из координат+точки обзора.
// 2. [ЦВЕТА] Множители оттенков палитры карты были [135,255,220,180].
//    Правильно (minecraft.wiki → Map item format): [180,220,255,135]
//    (проверка: GRASS 127,178,56 → id 4..7 = 89,125,39/109,153,48/
//    127,178,56/67,94,29). Старая таблица портила яркость всех картинок.
// 3. [ПОВОРОТ ПЛИТОК] Проверяются 4 правила: rot%4, (4-rot)%4, 0, rot/2 —
//    выбирается по непрерывности швов. Лечит отсутствующие метаданные,
//    перепутанное направление вращения и сервер, пишущий шаги по 45°.
// 4. [МЕТАДАННЫЕ] map_id/Rotation читаются устойчиво ко всем версиям:
//    слушаем entity_metadata / set_entity_metadata / set_entity_data,
//    плюс поллим bot.entities[id].metadata (mineflayer сам их парсит);
//    map_id ищем в data components ('map_id' и 'minecraft:map_id'),
//    в NBT-теге 'map' и в старом itemDamage. Rotation — key 9 (в nmp
//    поле type часто ЧИСЛО, старый фильтр по строке его терял).
//    Сырые метаданные пишутся в metadata_dump.json для диагностики.
// 5. [СЕТКА] Допускаются пропуски и дубли рамок; больше не падаем, если
//    cols*rows != frames.length. Пустые ячейки достраиваются свободными
//    картами по совпадению швов (hole-fill), всё логируется.
// 6. [ОЖИДАНИЕ ДАННЫХ] Ждём ВСЕ плитки стены и «тишину» потока map_data
//    (нет новых байт stableMs). Промпт капчи больше не обязателен —
//    слушаем chat/system/title/actionbar. Таймаут увеличен до 75 с.
// 7. [ROBOFLOW] Опционален (--no-rf / roboflow.enabled=false), с общим
//    бюджетом 25 с; его ошибка НЕ влияет на успех раунда. Добавлена
//    проверка формата modelId/apiKey и режим --rf-test FILE.
// 8. [ВЫВОД] Каталоги раундов не перетираются (в имени номер попытки),
//    готовые картинки дублируются в records/captchas/round_NN.png (+json),
//    пишется records/summary.json и assembly_debug.json по каждой стене.
// 9. [РЕЖИМЫ] --selftest (проверка геометрии без сервера, 5 кейсов),
//    --replay DIR (пересобрать картинку из уже записанных данных),
//    --rounds N, --no-rf, --rf-test FILE, --debug.
// =======================================================================

'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const http = require('http')
const https = require('https')
const tls = require('tls')
const { execSync } = require('child_process')

// mineflayer/socks нужны только для живого забега. Для --selftest/--replay — не нужны.
let mineflayer = null
try { mineflayer = require('mineflayer') } catch (e) { /* опционально */ }
let SocksClient = null
try { SocksClient = require('socks').SocksClient } catch (e) { /* опционально */ }

// ========================= CLI =========================
const ARGV = process.argv.slice(2)
function argVal(name, dflt) {
  const i = ARGV.indexOf('--' + name)
  if (i < 0) return dflt
  const v = ARGV[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}
const CLI = {
  selftest: ARGV.includes('--selftest'),
  rounds: Number(argVal('rounds', 0)) || 0,
  noRf: ARGV.includes('--no-rf'),
  replay: typeof argVal('replay', '') === 'string' ? argVal('replay', '') : '',
  rfTest: typeof argVal('rf-test', '') === 'string' ? argVal('rf-test', '') : '',
  debug: ARGV.includes('--debug')
}

// ========================= КОНСТАНТЫ ЗАБЕГА =========================
const TARGET_ROUNDS = CLI.rounds > 0 ? CLI.rounds : 10
const ATTEMPTS_PER_ROUND = 2
const PAUSE_BETWEEN_MS = 2000
const SETTLE_MS = 800             // добор данных после "готово"
const STABLE_MS = 1500            // поток map_data должен затихнуть на это время
const CAPTCHA_TIMEOUT_MS = 75000  // жёсткий лимит на подключение+сбор
const CONNECT_TIMEOUT_MS = 35000
const LOGIN_TIMEOUT_MS = 30000
const MAX_ROTATIONS_ON_FAIL = 6
const MIN_TILES_DEFAULT = 6       // минимум плиток, чтобы считать раунд успешным
const MIN_TILES_FRACTION = 0.6    // или 60% от размера сетки
const VIEW_SIGN = 1

const CLOUD_RF_TIMEOUT_MS = 20000
const RF_TOTAL_BUDGET_MS = 25000
const CREATE_NO_WINDOW = 0x08000000

// ========================= ГЛОБАЛЬНЫЕ =========================
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []
let REC_ROOT = null
let CAP_ROOT = null

function step(s) {
  const l = new Date().toISOString().slice(11, 19) + ' [step] ' + s
  SLOG.push(l)
  console.log(l)
}
function dbg(s) { if (CLI.debug) step('[dbg] ' + s) }

function flushReport(extra) {
  if (!REC_ROOT) return
  try {
    fs.writeFileSync(path.join(REC_ROOT, 'report_' + STAMP + '.txt'), SLOG.join('\n') + '\n' + (extra || ''))
  } catch (e) { console.error('flushReport err:', e.message) }
}

process.on('uncaughtException', e => {
  console.error('\n!!! UNCAUGHT EXCEPTION !!!\nMessage:', e.message, '\nStack:', e.stack)
  flushReport('UNCAUGHT: ' + (e.stack || e.message))
  setTimeout(() => process.exit(1), 1000)
})
process.on('unhandledRejection', e => {
  console.error('\n!!! UNHANDLED REJECTION !!!\nError:', e)
  flushReport('REJECTION: ' + (e && e.message ? e.message : String(e)))
})

// ========================= КОНФИГ =========================
let CFG_PARENT, CFG_LOCAL, CFG_PATH, CFG = {}, CFG_STRATEGY = 'none'

try {
  CFG_PARENT = path.join(__dirname, '..', 'config.json')
  CFG_LOCAL = path.join(__dirname, 'config.json')
  CFG_PATH = fs.existsSync(CFG_LOCAL) ? CFG_LOCAL : (fs.existsSync(CFG_PARENT) ? CFG_PARENT : null)
} catch (e) { console.error('CFG_PATH error:', e.message) }

function cfgGet(o, kp, d) {
  let c = o
  for (const k of kp.split('.')) { if (!c || c[k] === undefined) return d; c = c[k] }
  return c
}
function isEmptyCfgVal(v) { return v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v)) }
function softCleanJson(t) {
  let s = String(t || '').replace(/^\uFEFF/, '')
  s = s.replace(/:\s*""(?=[^",\s\]}])/g, ': "')
  s = s.replace(/,\s*([}\]])/g, '$1')
  s = s.replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
  return s
}
function extractJsonObject(t) {
  const s = String(t || ''); const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  return (i >= 0 && j > i) ? s.slice(i, j + 1) : ''
}
function parseCfgRaw(raw) {
  const candidates = [String(raw || ''), softCleanJson(raw), extractJsonObject(raw), softCleanJson(extractJsonObject(raw))]
  for (const c of candidates) {
    if (!c) continue
    try { const o = JSON.parse(c); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch (e) {}
  }
  return null
}
function sectionBody(raw, name) {
  const s = String(raw || '')
  const km = s.match(new RegExp('"' + name + '"\\s*:\\s*\\{'))
  if (!km) return ''
  const start = km.index + km[0].length - 1
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1) }
  }
  return ''
}
function grabIn(b, k) { const m = String(b || '').match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1] : undefined }
function grabNumIn(b, k) { const m = String(b || '').match(new RegExp('"' + k + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)')); return m ? Number(m[1]) : undefined }
function regexCfg(raw) {
  const cfg = {}
  const put = (sec, key, val) => { if (isEmptyCfgVal(val)) return; if (!cfg[sec]) cfg[sec] = {}; cfg[sec][key] = val }
  const mc = sectionBody(raw, 'minecraft')
  if (mc) { put('minecraft', 'server', grabIn(mc, 'server')); put('minecraft', 'port', grabNumIn(mc, 'port')); put('minecraft', 'version', grabIn(mc, 'version')) }
  const px = sectionBody(raw, 'proxy')
  if (px) {
    put('proxy', 'host', grabIn(px, 'host')); put('proxy', 'port', grabNumIn(px, 'port'))
    put('proxy', 'username', grabIn(px, 'username')); put('proxy', 'password', grabIn(px, 'password'))
    put('proxy', 'changeIpUrl', grabIn(px, 'changeIpUrl')); put('proxy', 'waitAfterIpChangeSec', grabNumIn(px, 'waitAfterIpChangeSec'))
  }
  const ac = sectionBody(raw, 'accounts')
  if (ac) { put('accounts', 'nickPrefix', grabIn(ac, 'nickPrefix')) }
  const rf = sectionBody(raw, 'roboflow')
  if (rf) { put('roboflow', 'enabled', /"enabled"\s*:\s*true/.test(rf)); put('roboflow', 'apiKey', grabIn(rf, 'apiKey')); put('roboflow', 'modelId', grabIn(rf, 'modelId')) }
  return cfg
}
try {
  if (CFG_PATH) {
    let raw = ''
    try { raw = fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '') } catch (e) { raw = '' }
    const parsed = parseCfgRaw(raw)
    const fb = regexCfg(raw)
    if (parsed) { CFG = parsed; CFG_STRATEGY = 'json' }
    else if (Object.keys(fb).length) { CFG = fb; CFG_STRATEGY = 'regex-fallback' }
  }
} catch (e) { console.error('CFG parse error:', e.message) }

const MC = {
  host: cfgGet(CFG, 'minecraft.server', 'connect.funtime.su'),
  port: cfgGet(CFG, 'minecraft.port', 25565),
  version: cfgGet(CFG, 'minecraft.version', '1.21.1')
}
const PROXY = {
  host: cfgGet(CFG, 'proxy.host', ''),
  port: cfgGet(CFG, 'proxy.port', 1080),
  username: cfgGet(CFG, 'proxy.username', ''),
  password: cfgGet(CFG, 'proxy.password', ''),
  changeIpUrl: cfgGet(CFG, 'proxy.changeIpUrl', ''),
  waitSec: cfgGet(CFG, 'proxy.waitAfterIpChangeSec', 12)
}
const NICK_PREFIX = String(cfgGet(CFG, 'accounts.nickPrefix', 'Player')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'Player'

const CAP = {
  minTiles: Number(cfgGet(CFG, 'capture.minTiles', MIN_TILES_DEFAULT)) || MIN_TILES_DEFAULT,
  stableMs: Number(cfgGet(CFG, 'capture.stableMs', STABLE_MS)) || STABLE_MS,
  timeoutMs: Number(cfgGet(CFG, 'capture.timeoutMs', CAPTCHA_TIMEOUT_MS)) || CAPTCHA_TIMEOUT_MS,
  needPrompt: cfgGet(CFG, 'capture.needPrompt', false) === true
}

try {
  REC_ROOT = path.join(__dirname, 'records')
  CAP_ROOT = path.join(REC_ROOT, 'captchas')
  fs.mkdirSync(CAP_ROOT, { recursive: true })
} catch (e) { console.error('REC_ROOT error:', e.message) }

const sleep = ms => new Promise(r => setTimeout(r, ms))

const NET_FAIL_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|socks|login timeout|spawn timeout/i
const PROXY_DEAD_RE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/i
// ошибки окружения: повторять попытки бессмысленно
const FATAL_RE = /не установлен|нет proxy\.host|модуль socks/i
const badIPs = new Set()
let currentRunIp = null

// ========================= ROBOFLOW (опционально) =========================
const RF_SOCKS_URL = cfgGet(CFG, 'roboflow.socksUrl', 'socks5://5xBLgY:S8hzBU@45.130.129.70:8000')

function parseRfSocksUrl() {
  try {
    const s = String(RF_SOCKS_URL || '')
    if (!s || s.includes('YOUR_')) return null
    const m = s.match(/^socks5[h]?:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/?$/i)
    if (!m) return null
    return { host: m[3], port: Number(m[4]), username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) }
  } catch (e) { return null }
}
const RF_SOCKS = parseRfSocksUrl()

const ROBOFLOW = {
  enabled: CLI.noRf ? false : (cfgGet(CFG, 'roboflow.enabled', true) !== false),
  apiKey: String(cfgGet(CFG, 'roboflow.apiKey', 'kTAPmOyqKcxeBTyi18FD')),
  modelId: String(cfgGet(CFG, 'roboflow.modelId', 's-workspace-juqs3/captcha-funtime-vn60f/2')).replace(/^\/+|\/+$/g, ''),
  confidence: Number(cfgGet(CFG, 'roboflow.confidence', 25)) || 25,
  overlap: Number(cfgGet(CFG, 'roboflow.overlap', 20)) || 20,
  scale: Number(cfgGet(CFG, 'roboflow.scale', 1)) || 1
}

function rfMultipart(buf, filename, boundary) {
  const safe = String(filename || 'captcha.png').replace(/"/g, '')
  const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + safe + '"\r\nContent-Type: image/png\r\n\r\n')
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n')
  return Buffer.concat([head, buf, tail])
}

async function killPort9001() {
  if (process.platform !== 'win32') return
  try {
    const out = execSync('netstat -ano | findstr :9001', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, creationFlags: CREATE_NO_WINDOW })
    const pids = new Set()
    for (const line of String(out || '').split('\n')) {
      if (!line.includes('LISTENING')) continue
      const parts = line.trim().split(/\s+/); const pid = parts[parts.length - 1]
      if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
    }
    for (const pid of pids) {
      step('[RF] убиваю процесс на :9001 PID ' + pid)
      try { execSync('taskkill /F /PID ' + pid, { stdio: 'ignore', windowsHide: true, creationFlags: CREATE_NO_WINDOW }) } catch (e) {}
    }
    if (pids.size) await sleep(800)
  } catch (e) {}
}

// ========================= HTTP / IP =========================
function plainGet(urlStr, timeoutMs) {
  timeoutMs = timeoutMs || 15000
  const buildList = u => { u = String(u || ''); return u.startsWith('https:') ? [u, u.replace('https:', 'http:')] : [u, u.replace('http:', 'https:')] }
  return new Promise((resolve, reject) => {
    let stopped = false, lastErr = 'get failed'
    const attempt = (urls, idx, redirectsLeft, insecure) => {
      if (stopped) return
      if (idx >= urls.length) { stopped = true; reject(new Error(lastErr)); return }
      const u = urls[idx]
      const mod = String(u).startsWith('https') ? https : http
      const opts = { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 MC_Bot/3.8.0', 'Accept': '*/*' } }
      if (insecure) opts.rejectUnauthorized = false
      let req = null
      const timer = setTimeout(() => {
        if (stopped) return
        try { if (req) req.destroy() } catch (e) {}
        lastErr = 'timeout'; attempt(urls, idx + 1, redirectsLeft, insecure)
      }, timeoutMs)
      try {
        req = mod.get(u, opts, res => {
          if (stopped) { try { res.resume() } catch (e) {} return }
          clearTimeout(timer)
          const sc = res.statusCode
          if (sc >= 300 && sc < 400 && res.headers.location && redirectsLeft > 0) {
            let next = String(res.headers.location)
            try { next = new URL(next, u).toString() } catch (e) {}
            try { res.resume() } catch (e) {}
            attempt(buildList(next), 0, redirectsLeft - 1, insecure); return
          }
          let d = ''
          try { res.setEncoding('utf8') } catch (e) {}
          res.on('data', c => { d += c; if (d.length > 200000) d = d.slice(-100000) })
          res.on('end', () => { if (stopped) return; stopped = true; resolve({ status: sc, body: d.trim() }) })
          res.on('error', () => { if (!stopped) attempt(urls, idx + 1, redirectsLeft, insecure) })
        })
      } catch (e) { clearTimeout(timer); attempt(urls, idx + 1, redirectsLeft, insecure); return }
      req.on('error', e => {
        if (stopped) return
        clearTimeout(timer)
        if (!insecure && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|HANDSHAKE|SSL|TLS/i.test((e && e.message) || '')) { attempt(urls, idx, redirectsLeft, true); return }
        attempt(urls, idx + 1, redirectsLeft, insecure)
      })
    }
    attempt(buildList(urlStr), 0, 3, false)
  })
}

function socksHttpGet(host, reqText) {
  if (!SocksClient || !PROXY.host) return Promise.resolve(null)
  return new Promise(resolve => {
    SocksClient.createConnection({
      proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password },
      command: 'connect', destination: { host, port: 80 }
    }).then(conn => {
      let data = ''
      const t = setTimeout(() => { try { conn.socket.destroy() } catch (e) {}; resolve(null) }, 10000)
      conn.socket.on('data', d => {
        data += d.toString()
        const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
        if (m && data.includes('\r\n\r\n')) { clearTimeout(t); try { conn.socket.destroy() } catch (e) {}; resolve(m[1]) }
      })
      conn.socket.on('error', () => { clearTimeout(t); resolve(null) })
      conn.socket.on('end', () => { clearTimeout(t); const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/); resolve(m ? m[1] : null) })
      conn.socket.write(reqText)
    }).catch(() => resolve(null))
  })
}
async function currentIp() { return await socksHttpGet('api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n') }

async function rotateIp() {
  if (!PROXY.changeIpUrl || PROXY.changeIpUrl.includes('YOUR_KEY')) { currentRunIp = await currentIp(); return currentRunIp }
  for (let round = 1; round <= 2; round++) {
    const oldIp = await currentIp()
    step('IP до ротации: ' + (oldIp || '?'))
    let hit = 'fail', ok = false
    for (let t = 1; t <= 2; t++) {
      try {
        const r = await plainGet(PROXY.changeIpUrl, 15000)
        const body = String(r.body || '').replace(/\s+/g, ' ').slice(0, 90)
        hit = 'direct:' + r.status + (body ? ' body=' + body : ''); ok = r.status >= 200 && r.status < 400
      } catch (e) { hit = 'direct:ERR ' + ((e && e.message) || e); ok = false }
      if (ok) break
      if (t < 2) { step('changeIp ' + t + ' не удалась, повтор'); await sleep(3000) }
    }
    step('changeIp: ' + hit)
    const t0 = Date.now(); let newIp = null
    const waitMs = Math.max(8000, (Number(PROXY.waitSec) || 12) * 1000)
    while (Date.now() - t0 < waitMs) { await sleep(2000); newIp = await currentIp(); if (newIp && (!oldIp || newIp !== oldIp)) break }
    if (newIp && (!oldIp || newIp !== oldIp)) {
      if (oldIp && badIPs.has(newIp)) { step('новый IP ' + newIp + ' уже плох — кручу'); continue }
      step('IP СМЕНЁН: ' + (oldIp || '?') + ' -> ' + newIp)
      currentRunIp = newIp; return newIp
    }
    step('IP не сменился')
  }
  currentRunIp = await currentIp(); return currentRunIp
}

// ========================= ROBOFLOW HTTP =========================
function rawRequestOnSocket(useTls, socket, hostname, port, method, reqPath, headers, body, timeoutMs) {
  return new Promise(resolve => {
    const mod = useTls ? https : http
    const defaultPort = useTls ? 443 : 80
    const hostHeader = (port && port !== defaultPort) ? (hostname + ':' + port) : hostname
    const h = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'Connection': 'close',
      'Host': hostHeader, 'Origin': 'https://app.roboflow.com', 'Referer': 'https://app.roboflow.com/'
    }, headers || {})
    if (body != null) h['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))
    const opts = { hostname, port, path: reqPath, method, timeout: timeoutMs, headers: h }
    if (socket) opts.createConnection = () => socket   // надёжнее, чем opts.socket
    let done = false
    const finish = o => { if (done) return; done = true; resolve(o) }
    let req = null
    try {
      req = mod.request(opts, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', e => finish({ status: 0, body: 'RES ERR: ' + ((e && e.message) || e) }))
      })
    } catch (e) { finish({ status: 0, body: 'REQ THROW: ' + ((e && e.message) || e) }); return }
    req.on('error', e => finish({ status: 0, body: 'REQ ERR: ' + ((e && e.message) || e) }))
    req.on('timeout', () => { try { req.destroy() } catch (e) {}; finish({ status: 0, body: 'TIMEOUT' }) })
    if (body != null) req.write(body)
    req.end()
  })
}

function socksConnectSocket(host, port, useTls, pHost, pPort, pUser, pPass) {
  return new Promise((resolve, reject) => {
    if (!SocksClient) { reject(new Error('модуль socks не установлен')); return }
    if (!pHost) { reject(new Error('proxy host пуст')); return }
    let settled = false
    const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('SOCKS timeout 30s')) } }, 30000)
    SocksClient.createConnection({
      proxy: { host: pHost, port: pPort, type: 5, userId: pUser, password: pPass },
      command: 'connect', destination: { host, port }
    }).then(conn => {
      if (settled) { try { conn.socket.destroy() } catch (e) {} return }
      if (!useTls) { settled = true; clearTimeout(to); resolve({ socket: conn.socket, cleanup() { try { conn.socket.destroy() } catch (e) {} } }); return }
      let secure = null
      const fail = e => {
        if (settled) return
        settled = true; clearTimeout(to)
        try { conn.socket.destroy() } catch (x) {}
        if (secure) try { secure.destroy() } catch (x) {}
        reject(e)
      }
      try {
        secure = tls.connect({ socket: conn.socket, servername: host, minVersion: 'TLSv1.2' }, () => {
          if (settled) return
          settled = true; clearTimeout(to)
          resolve({ socket: secure, cleanup() { try { secure.destroy() } catch (e) {}; try { conn.socket.destroy() } catch (e) {} } })
        })
      } catch (e) { fail(e); return }
      secure.on('error', fail); conn.socket.on('error', fail)
    }).catch(e => { if (!settled) { settled = true; clearTimeout(to); reject(e) } })
  })
}

async function rfPostOnce(transport, url, headers, body, timeoutMs) {
  let u = null
  try { u = new URL(url) } catch (e) { return { status: 0, body: 'BAD URL', via: transport } }
  const useTls = u.protocol === 'https:'
  const port = Number(u.port || (useTls ? 443 : 80))
  const reqPath = u.pathname + u.search
  if (transport === 'direct') {
    const r = await rawRequestOnSocket(useTls, null, u.hostname, port, 'POST', reqPath, headers, body, timeoutMs)
    r.via = 'direct'; return r
  }
  if (transport === 'socks') {
    if (!RF_SOCKS) return { status: 0, body: 'RF_SOCKS not configured', via: 'socks' }
    let sk = null
    try {
      sk = await socksConnectSocket(u.hostname, port, useTls, RF_SOCKS.host, RF_SOCKS.port, RF_SOCKS.username, RF_SOCKS.password)
    } catch (e) {
      return { status: 0, body: 'SOCKS ERR: ' + ((e && e.message) || e), via: 'socks' }
    }
    try {
      const r = await rawRequestOnSocket(useTls, sk.socket, u.hostname, port, 'POST', reqPath, headers, body, timeoutMs)
      r.via = 'socks'; return r
    } finally { try { sk.cleanup() } catch (e) {} }
  }
  return { status: 0, body: 'unknown transport', via: transport }
}

async function rfPost(url, headers, body, deadline) {
  const transports = RF_SOCKS ? ['socks', 'direct'] : ['direct']
  const attemptsLog = []
  let last = null
  for (const tr of transports) {
    if (deadline && Date.now() > deadline) break
    const left = deadline ? Math.max(4000, deadline - Date.now()) : CLOUD_RF_TIMEOUT_MS
    const r = await rfPostOnce(tr, url, headers, body, Math.min(CLOUD_RF_TIMEOUT_MS, left))
    attemptsLog.push(tr + ':' + r.status)
    last = r
    const st = Number(r.status || 0)
    if ((st >= 200 && st < 400) || st === 401 || st === 404) { last._attempts = attemptsLog; return last }
    if (st === 403) {
      const b = String(r.body || '')
      if (b.includes('Cloudflare') || b.includes('Attention Required')) { await sleep(1500); continue }
      last._attempts = attemptsLog; return last
    }
    await sleep(700)
  }
  if (last) last._attempts = attemptsLog
  return last || { status: 0, body: 'no transport', via: 'none', _attempts: attemptsLog }
}

function rfGetPredictions(json) {
  if (!json) return []
  if (Array.isArray(json.predictions)) return json.predictions
  if (Array.isArray(json.results)) return json.results
  if (json.prediction && Array.isArray(json.prediction.predictions)) return json.prediction.predictions
  if (json.object && Array.isArray(json.object.predictions)) return json.object.predictions
  return []
}
function rfDigitFromPrediction(p) {
  const s = String(p.class || p.class_name || p.label || p.name || '')
  const m = s.match(/\d/); return m ? m[0] : null
}
function rfNormConf(c) { c = Number(c || 0); if (c > 1) c = c / 100; return c }

function rfMetrics(preds) {
  const digits = []
  for (const p of (preds || [])) {
    const d = rfDigitFromPrediction(p)
    const conf = rfNormConf(p.confidence != null ? p.confidence : p.score)
    if (d !== null && conf >= 0.15) digits.push({ digit: d, conf, x: Number(p.x || 0), y: Number(p.y || 0), w: Number(p.width || p.w || 0), h: Number(p.height || p.h || 0) })
  }
  digits.sort((a, b) => a.x - b.x)
  const n = digits.length
  const avg = n ? digits.reduce((a, d) => a + d.conf, 0) / n : 0
  let row = 0
  if (n > 0) {
    const hs = digits.map(d => d.h).filter(x => x > 0).sort((a, b) => a - b)
    const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 40
    const band = Math.max(25, medH * 0.8)
    const sorted = digits.slice().sort((a, b) => a.y - b.y)
    for (let i = 0; i < sorted.length; i++) {
      const group = [sorted[i]]
      for (let j = i + 1; j < sorted.length; j++) { if (Math.abs(sorted[j].y - sorted[i].y) <= band) group.push(sorted[j]); else break }
      group.sort((a, b) => a.x - b.x)
      let cnt = 0, lastRight = -1e9
      for (const d of group) {
        const left = d.x - d.w / 2, right = d.x + d.w / 2
        if (left >= lastRight - Math.max(3, d.w * 0.15)) { cnt++; lastRight = right }
      }
      if (cnt > row) row = cnt
    }
  }
  const plausible = n >= 3 && n <= 8
  const strong = avg >= 0.35
  const score = (plausible ? 10000 : 0) + (strong ? 3000 : 0) + n * 1000 + row * 700 + Math.round(avg * 1000)
  return { n, avg: Math.round(avg * 1000) / 1000, row, plausible, strong, score, text: digits.map(d => d.digit).join(''), digits }
}

async function sendToRoboflow(pngBuffer, filename, debugDir, label, deadline) {
  const disabled = { ok: false, status: 0, attempt: 'disabled', predictions: [], metrics: rfMetrics([]), error: 'disabled' }
  if (!ROBOFLOW.enabled || !ROBOFLOW.apiKey) return disabled
  if (!/^[A-Za-z0-9_\-\/]+\/[A-Za-z0-9_\-]+\/\d+$/.test(ROBOFLOW.modelId)) {
    step('[RF] ⚠️ modelId подозрительный: "' + ROBOFLOW.modelId + '" (ожидается workspace/project/version)')
  }
  if (!/^[0-9a-fA-F]{24,}$/.test(ROBOFLOW.apiKey)) {
    step('[RF] ⚠️ apiKey непохож на Roboflow private key (обычно 32 hex-символа): ' + ROBOFLOW.apiKey.slice(0, 4) + '...')
  }

  const key = ROBOFLOW.apiKey
  const conf = encodeURIComponent(ROBOFLOW.confidence)
  const ov = encodeURIComponent(ROBOFLOW.overlap)
  const endpoints = ['https://serverless.roboflow.com', 'https://detect.roboflow.com']
  const boundary = '----WebKitFormBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  const mp = rfMultipart(pngBuffer, filename, boundary)
  let last = null

  for (const base of endpoints) {
    if (deadline && Date.now() > deadline) break
    const inferUrl = base + '/' + ROBOFLOW.modelId + '?confidence=' + conf + '&overlap=' + ov
    const attempts = [
      { name: path.basename(base) + '_multipart', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Authorization': 'Bearer ' + key }, body: mp },
      { name: path.basename(base) + '_raw', headers: { 'Content-Type': 'image/png', 'Authorization': 'Bearer ' + key }, body: pngBuffer }
    ]
    for (const at of attempts) {
      if (deadline && Date.now() > deadline) break
      const r = await rfPost(inferUrl, at.headers, at.body, deadline)
      const preview = String(r.body || '').slice(0, 400).replace(/\s+/g, ' ')
      step('[RF] ' + (label || '') + ' ' + at.name + ': status=' + r.status + ' via=' + (r.via || '?'))
      if (r.status === 401) return { ok: false, status: 401, attempt: at.name, predictions: [], metrics: rfMetrics([]), error: 'INVALID API KEY (401)', raw: preview }
      if (r.status === 403 && /Cloudflare|Attention Required/.test(String(r.body || ''))) { await sleep(1500); break }
      if (r.status === 404) { step('[RF] 404 — модель не найдена на ' + base); break }
      let json = null
      try { json = JSON.parse(r.body) } catch (e) {}
      const predictions = rfGetPredictions(json)
      const metrics = rfMetrics(predictions)
      const ok = r.status >= 200 && r.status < 300 && !!json
      const item = { ok, status: r.status, attempt: at.name, url: inferUrl, json, predictions, metrics, raw: String(r.body || '').slice(0, 3000), attempts: r._attempts || [], error: ok ? null : (preview.slice(0, 300) || 'HTTP ' + r.status), modelId: ROBOFLOW.modelId }
      if (debugDir) {
        try {
          fs.mkdirSync(debugDir, { recursive: true })
          fs.writeFileSync(path.join(debugDir, 'roboflow_debug_' + at.name + '.txt'),
            'STATUS: ' + r.status + '\nVIA: ' + (r.via || '?') + '\nURL: ' + inferUrl + '\nBODY:\n' + String(r.body || '').slice(0, 8000) + '\n')
        } catch (e) {}
      }
      if (ok) { step('[RF] ✅ ' + at.name + ' ЦИФР: ' + metrics.n + ' text="' + metrics.text + '"'); return item }
      last = item
    }
  }
  return last || Object.assign(disabled, { error: 'all endpoints failed' })
}

// ========================= ПАЛИТРА КАРТЫ MINECRAFT =========================
const BASE_COLORS = [[0,0,0],[127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],[167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],[112,112,112],[64,128,255],[104,83,50],[255,252,245],[216,127,51],[178,76,216],[102,153,216],[229,229,51],[127,204,25],[242,127,165],[76,76,76],[153,153,153],[76,127,153],[127,63,178],[51,76,178],[102,76,51],[102,127,51],[153,51,51],[25,25,25],[250,238,77],[92,219,213],[74,128,255],[0,217,58],[135,107,58],[112,2,2],[143,119,100],[161,83,37],[149,88,108],[114,119,139],[186,133,35],[103,117,52],[160,77,78],[57,42,35],[135,106,97],[86,91,91],[118,70,86],[74,59,91],[77,51,35],[76,83,42],[143,61,46],[37,22,16],[189,48,49],[148,63,97],[126,32,44],[22,119,121],[58,142,140],[74,117,116],[23,121,121],[90,90,90],[224,169,112],[127,106,82],[221,169,46],[156,104,66]]
// !!! ПРАВИЛЬНЫЙ ПОРЯДОК ОТТЕНКОВ (minecraft.wiki → Map item format):
//   byte & 3 : 0 → ×180/255, 1 → ×220/255, 2 → ×255/255, 3 → ×135/255
// Проверка: GRASS(127,178,56) id 4..7 = 89,125,39 / 109,153,48 / 127,178,56 / 67,94,29 ✓
const SHADE_MULT = [180, 220, 255, 135]
const AIR_RGB = [255, 255, 255]   // color id 0 = «не исследовано» → рисуем белым

const PALETTE = (() => {
  const p = new Uint8Array(256 * 3)
  for (let v = 0; v < 256; v++) {
    let r = AIR_RGB[0], g = AIR_RGB[1], b = AIR_RGB[2]
    if (v !== 0) {
      const base = BASE_COLORS[v >> 2] || [0, 0, 0]
      const m = SHADE_MULT[v & 3] / 255
      r = Math.round(base[0] * m); g = Math.round(base[1] * m); b = Math.round(base[2] * m)
    }
    p[v * 3] = r; p[v * 3 + 1] = g; p[v * 3 + 2] = b
  }
  return p
})()
const LUM = (() => {
  const l = new Uint8Array(256)
  for (let v = 0; v < 256; v++) l[v] = Math.round(0.299 * PALETTE[v * 3] + 0.587 * PALETTE[v * 3 + 1] + 0.114 * PALETTE[v * 3 + 2])
  return l
})()
// таблица «расстояний» между цветами палитры (для оценки швов)
let PAL_DIST = null
function palDist(a, b) {
  if (a === b) return 0
  if (!PAL_DIST) {
    PAL_DIST = new Uint16Array(65536)
    for (let i = 0; i < 256; i++) for (let j = i + 1; j < 256; j++) {
      const d = Math.abs(PALETTE[i * 3] - PALETTE[j * 3]) + Math.abs(PALETTE[i * 3 + 1] - PALETTE[j * 3 + 1]) + Math.abs(PALETTE[i * 3 + 2] - PALETTE[j * 3 + 2])
      PAL_DIST[i * 256 + j] = d; PAL_DIST[j * 256 + i] = d
    }
  }
  return PAL_DIST[a * 256 + b]
}

// ========================= PNG =========================
let CRC = null
function crc32(b) {
  if (!CRC) {
    CRC = []
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ih = Buffer.alloc(13)
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4) }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0)
    const tt = Buffer.from(t, 'ascii')
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt, d])), 0)
    return Buffer.concat([l, tt, d, cr])
  }
  return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, 6)), chunk('IEND', Buffer.alloc(0))])
}
function colorPng(data, W, H, sc) {
  const SW = W * sc, SH = H * sc
  const rgba = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++) {
    const srow = Math.floor(y / sc) * W
    for (let x = 0; x < SW; x++) {
      const v = data[srow + Math.floor(x / sc)]
      const i = (y * SW + x) * 4
      rgba[i] = PALETTE[v * 3]; rgba[i + 1] = PALETTE[v * 3 + 1]; rgba[i + 2] = PALETTE[v * 3 + 2]; rgba[i + 3] = 255
    }
  }
  return encodePng(SW, SH, rgba)
}
function bwPng(mask, W, H, sc) {
  const SW = W * sc, SH = H * sc, rgba = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++) {
    const srow = Math.floor(y / sc) * W
    for (let x = 0; x < SW; x++) {
      const v = mask[srow + Math.floor(x / sc)] ? 30 : 255
      const i = (y * SW + x) * 4
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255
    }
  }
  return encodePng(SW, SH, rgba)
}

// ========================= МОРФОЛОГИЯ / OCR =========================
const NB8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
function erode(m, W, H) { const o = new Uint8Array(m.length); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (m[i] && m[i - 1] && m[i + 1] && m[i - W] && m[i + W]) o[i] = 1 }; return o }
function dilate(m, W, H) { const o = new Uint8Array(m.length); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])) o[i] = 1 }; return o }
function opening(m, W, H, r) { let x = m; for (let i = 0; i < r; i++) x = erode(x, W, H); for (let i = 0; i < r; i++) x = dilate(x, W, H); return x }
function closing(m, W, H, r) { let x = m; for (let i = 0; i < r; i++) x = dilate(x, W, H); for (let i = 0; i < r; i++) x = erode(x, W, H); return x }

function components(mask, W, H, wantPx) {
  const vis = new Uint8Array(mask.length), out = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (!mask[i] || vis[i]) continue
    const st = [x, y]; vis[i] = 1
    let a = 0, mnX = x, mxX = x, mnY = y, mxY = y, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
    const px = wantPx ? [i] : null
    while (st.length) {
      const cy = st.pop(), cx = st.pop()
      a++; sx += cx; sy += cy; sxx += cx * cx; syy += cy * cy; sxy += cx * cy
      if (cx < mnX) mnX = cx; if (cx > mxX) mxX = cx
      if (cy < mnY) mnY = cy; if (cy > mxY) mxY = cy
      for (const nb of NB8) {
        const nx = cx + nb[0], ny = cy + nb[1]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const ni = ny * W + nx
        if (mask[ni] && !vis[ni]) { vis[ni] = 1; st.push(nx, ny); if (wantPx) px.push(ni) }
      }
    }
    const mx = sx / a, my = sy / a
    const vx = sxx / a - mx * mx, vy = syy / a - my * my, vxy = sxy / a - mx * my
    const half = (vx + vy) / 2, det = vx * vy - vxy * vxy
    const disc = Math.sqrt(Math.max(0, half * half - Math.max(0, det)))
    out.push({ mnX, mxX, mnY, mxY, a, px, varMinor: Math.max(0, half - disc), cx: mx, cy: my })
  }
  return out
}
function isStraight(c, w, h) { return c.varMinor < 10 && (w + h) > 100 }

function inkMaskWall(data, W, H) {
  const total = data.length
  const wc = new Int32Array(256)
  for (let i = 0; i < total; i++) wc[data[i]]++
  const order = []
  for (let v = 0; v < 256; v++) if (wc[v]) order.push(v)
  order.sort((a, b) => wc[b] - wc[a])
  // фон = несколько самых частых цветов (не более 4 и не более 60% пикселей)
  const bg = new Set()
  let acc = 0
  for (const v of order) {
    if (bg.size >= 4 || acc >= total * 0.6) break
    if (bg.size > 0 && wc[v] < total * 0.02) break
    bg.add(v); acc += wc[v]
  }
  let ink = new Uint8Array(total), inkCount = 0
  for (let i = 0; i < total; i++) if (!bg.has(data[i])) { ink[i] = 1; inkCount++ }
  // полярность: если «чернил» больше половины — значит фон и цифры перепутаны местами
  let inverted = false
  if (inkCount > total * 0.5) {
    const inv = new Uint8Array(total)
    for (let i = 0; i < total; i++) inv[i] = ink[i] ? 0 : 1
    ink = inv; inkCount = total - inkCount; inverted = true
  }
  return { ink, inkCount, bg: [...bg], inverted }
}
function dropLines(mask, W, H) {
  const out = new Uint8Array(mask.length)
  for (const c of components(mask, W, H, true)) {
    const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
    const isLine = (w > W * 0.85 || h > H * 0.85) || (w + h > 320 && (c.a) / (w * h) < 0.12)
    if (!isLine) for (const i of c.px) out[i] = 1
  }
  return out
}

const DIGITS = { '0': [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '1': [[0,0,1,0,0],[0,1,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,1,1,0]], '2': [[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]], '3': [[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '4': [[0,0,0,1,0],[0,0,1,1,0],[0,1,0,1,0],[1,0,0,1,0],[1,1,1,1,1],[0,0,0,1,0],[0,0,0,1,0]], '5': [[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '6': [[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '7': [[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]], '8': [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '9': [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,1],[0,0,0,0,1],[0,0,0,0,1],[0,1,1,1,0]] }

function matchPat(mask, W, H, bx, by, bw, bh) {
  const pat = []
  for (let py = 0; py < 7; py++) {
    const row = []
    for (let px = 0; px < 5; px++) {
      const sx = bx + Math.floor(px * bw / 5), ex = bx + Math.floor((px + 1) * bw / 5)
      const sy = by + Math.floor(py * bh / 7), ey = by + Math.floor((py + 1) * bh / 7)
      let c = 0, t = 0
      for (let y = sy; y < ey; y++) for (let x = sx; x < ex; x++) { c += mask[y * W + x]; t++ }
      row.push(t && (c / t) > 0.35 ? 1 : 0)
    }
    pat.push(row)
  }
  let bd = '?', bs = 0
  for (const d in DIGITS) { let m = 0; for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (pat[y][x] === DIGITS[d][y][x]) m++; const s = m / 35; if (s > bs) { bs = s; bd = d } }
  return { best: bd, score: Math.round(bs * 100) / 100 }
}
function ocr(mask, W, H) {
  const digits = []
  for (const c of components(mask, W, H, false)) {
    const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
    if (c.a < Math.max(80, W * H / 1600)) continue
    if (w < W * 0.02 || w > W * 0.5) continue
    if (h < H * 0.07 || h > H * 0.92) continue
    if (isStraight(c, w, h)) continue
    const m = matchPat(mask, W, H, c.mnX, c.mnY, w, h)
    digits.push({ x: c.mnX, best: m.best, score: m.score })
  }
  digits.sort((a, b) => a.x - b.x)
  let text = ''
  for (const d of digits) if (d.score >= 0.5) text += d.best
  return { text, digits }
}
function buildVariants(ink, W, H) {
  return [
    { name: 'v0_raw', mask: dropLines(ink, W, H) },
    { name: 'v1_open2', mask: dropLines(opening(ink, W, H, 2), W, H) },
    { name: 'v2_open3', mask: dropLines(opening(ink, W, H, 3), W, H) },
    { name: 'v3_close1_open2', mask: dropLines(opening(closing(ink, W, H, 1), W, H, 2), W, H) }
  ]
}
function pickOcr(vars, W, H) {
  let best = { name: 'none', text: '', n: 0, plausible: false, conf: 0, score: -1 }
  for (const v of vars) {
    const r = ocr(v.mask, W, H)
    const n = r.digits.filter(d => d.score >= 0.5).length
    const plausible = n >= 3 && n <= 8
    const conf = r.digits.filter(d => d.score >= 0.65).reduce((a, d) => a + d.score, 0)
    const score = (plausible ? 1000 : 0) + conf * 100 + n * 10 - (n > 8 ? 800 : 0)
    if (score > best.score) best = { name: v.name, text: r.text, n, plausible, conf, score }
  }
  return best
}

// ========================= ГЕОМЕТРИЯ: СЕТКА СТЕНЫ =========================
function rotQ(d, q) {
  q = ((q % 4) + 4) % 4
  if (!q) return Uint8Array.from(d)
  const o = new Uint8Array(d.length)
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const v = d[y * 128 + x]
    if (q === 1) o[x * 128 + 127 - y] = v
    else if (q === 2) o[(127 - y) * 128 + (127 - x)] = v
    else o[(127 - x) * 128 + y] = v
  }
  return o
}

function clusterValues(vals, tol) {
  if (!vals || !vals.length) return []
  const sorted = vals.slice().sort((a, b) => a - b)
  const groups = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const cur = groups[groups.length - 1]
    if (sorted[i] - cur[cur.length - 1] <= tol) cur.push(sorted[i])
    else groups.push([sorted[i]])
  }
  return groups.map(g => ({ value: g.reduce((s, x) => s + x, 0) / g.length, n: g.length }))
}
function nearestIdx(centers, v) {
  let bi = 0, bd = Infinity
  for (let i = 0; i < centers.length; i++) { const d = Math.abs(centers[i] - v); if (d < bd) { bd = d; bi = i } }
  return { idx: bi, dist: bd }
}

// все плоскости-стены: x=const и z=const.
// Отбрасываем «линии» (ряд рамок в одну строку/колонку) — иначе каждая колонка
// настоящей стены выглядит отдельной стеной и уводит выбор.
function detectWalls(frames, minFrames) {
  const walls = []
  for (const axis of ['x', 'z']) {
    const horiz = axis === 'x' ? 'z' : 'x'
    const cl = clusterValues(frames.map(f => f[axis]), 0.45)
    for (const c of cl) {
      const members = frames.filter(f => Math.abs(f[axis] - c.value) <= 0.45)
      if (members.length < (minFrames || 4)) continue
      const nH = clusterValues(members.map(f => f[horiz]), 0.45).length
      const nY = clusterValues(members.map(f => f.y), 0.45).length
      if (nH < 2 || nY < 2) continue
      walls.push({ axis, value: c.value, frames: members, tag: axis + Math.round(c.value), span: nH + '×' + nY })
    }
  }
  walls.sort((a, b) => b.frames.length - a.frames.length)
  return walls
}
// минимальное число рамок, чтобы плоскость считалась стеной-кандидатом
function wallMinFrames(linkedCount) {
  return Math.max(3, Math.min(CAP.minTiles, linkedCount || 3))
}

// сетка стены: cols × rows, cells[r*cols+c] = frame|null
function buildGrid(wall) {
  const horiz = wall.axis === 'x' ? 'z' : 'x'
  const hCl = clusterValues(wall.frames.map(f => f[horiz]), 0.45)
  const yCl = clusterValues(wall.frames.map(f => f.y), 0.45)
  const cols = hCl.length, rows = yCl.length
  const hC = hCl.map(c => c.value), yC = yCl.map(c => c.value)
  const cells = new Array(cols * rows).fill(null)
  let dup = 0, far = 0
  for (const f of wall.frames) {
    const hc = nearestIdx(hC, f[horiz]), yc = nearestIdx(yC, f.y)
    if (hc.dist > 0.45 || yc.dist > 0.45) { far++; continue }
    const idx = yc.idx * cols + hc.idx
    if (cells[idx]) { dup++; if ((f.filled || 0) > (cells[idx].filled || 0)) cells[idx] = f; continue }
    cells[idx] = f
  }
  return { wall, horiz, cols, rows, cells, hCenters: hC, yCenters: yC, dup, far, total: cols * rows }
}

// направление «лево→право» по позиции наблюдателя
function viewpointHAsc(grid, view) {
  if (!view || typeof view.x !== 'number') return null
  const v = grid.wall.value
  if (grid.wall.axis === 'z') return view.z > v ? true : false    // смотрим на север → слева меньшие x
  return view.x < v ? true : false                                // смотрим на восток → слева меньшие z
}

function orientationCandidates(grid, view) {
  const det = viewpointHAsc(grid, view)
  const base = det === null ? true : det
  const list = [
    { hAsc: base, yAsc: false, tag: det === null ? 'guess' : 'view' },
    { hAsc: !base, yAsc: false, tag: 'view-mirror' },
    { hAsc: base, yAsc: true, tag: 'view-flipy' },
    { hAsc: !base, yAsc: true, tag: 'mirror-flipy' }
  ]
  const seen = new Set()
  return list.filter(o => { const k = o.hAsc + '/' + o.yAsc; if (seen.has(k)) return false; seen.add(k); return true })
}

// кандидаты на правило поворота плитки
function rotationCandidates(frames) {
  const rots = frames.map(f => Number(f.rotation) || 0)
  const hasRot = rots.some(r => r !== 0)
  const cands = []
  const add = (name, fn) => cands.push({ name, fn })
  add('meta', f => ((Number(f.rotation) || 0) % 4 + 4) % 4)                 // по метаданным, по часовой
  add('meta-ccw', f => (4 - (((Number(f.rotation) || 0) % 4 + 4) % 4)) % 4)  // против часовой
  add('half', f => (Math.floor((Number(f.rotation) || 0) / 2) % 4 + 4) % 4)  // сервер пишет шаги по 45°
  add('none', () => 0)                                                      // игнорировать поворот
  // если все rotation==0 — все кандидаты кроме 'none' идентичны, оставляем 2
  if (!hasRot) return [cands[0], cands[3]]
  return cands
}

// собрать картинку стены
function composeImage(grid, tiles, rotFn, ori) {
  const { cols, rows, cells } = grid
  const W = cols * 128, H = rows * 128
  const out = new Uint8Array(W * H)
  const used = new Map()
  let placed = 0
  for (let r = 0; r < rows; r++) {
    const srcRow = ori.yAsc ? r : rows - 1 - r
    for (let c = 0; c < cols; c++) {
      const srcCol = ori.hAsc ? c : cols - 1 - c
      const f = cells[srcRow * cols + srcCol]
      const dx = c * 128, dy = r * 128
      if (!f || !tiles.has(f.mapId)) continue
      const raw = tiles.get(f.mapId)
      const d = rotFn ? rotQ(raw, rotFn(f)) : raw
      used.set(f.mapId, (used.get(f.mapId) || 0) + 1)
      placed++
      const dst0 = dy * W + dx
      for (let y = 0; y < 128; y++) {
        const src0 = y * 128, dst = dst0 + y * W
        for (let x = 0; x < 128; x++) out[dst + x] = d[src0 + x]
      }
    }
  }
  return { data: out, W, H, placed, missing: cols * rows - placed }
}

// Стоимость шва = «насколько стык плиток хуже обычного соседства пикселей».
// Учитываем ТОЛЬКО информативные пиксели стыка: если с обеих сторон локально
// плоский фон, позиция не несёт информации и в расчёт не идёт (иначе фон
// заглушает реальные разрывы линий). Меньше = лучше, ≈0 = идеальный стык.
// Доминирующий цвет = фон. Гистограмма набора плиток НЕ зависит от раскладки
// (повороты и перестановки её не меняют), поэтому bg одинаков для всех
// кандидатов и стоимости строго сравнимы между собой.
function dominantColor(tilesArr) {
  const wc = new Int32Array(256)
  for (const t of tilesArr) { if (!t) continue; for (let i = 0; i < t.length; i++) wc[t[i]]++ }
  let bg = 0, bc = -1
  for (let v = 0; v < 256; v++) if (wc[v] > bc) { bc = wc[v]; bg = v }
  return bg
}

// Одна позиция стыка оценивается двумя составляющими:
//  • inkFrac — доля позиций, где «чернильность» слева и справа не совпала
//    (главный признак: линия должна продолжаться через границу плиток);
//  • colorScore — насколько стык «резче» обычного соседства пикселей внутри плиток.
// Итог: inkFrac*50 + colorScore. Меньше = лучше, ~0 = идеальный стык.
const INK_WEIGHT = 50

function seamStatsV(A, B, bg) {
  let seam = 0, ns = 0, inner = 0, ni = 0, mism = 0
  for (let y = 0; y < 128; y++) {
    const o = y * 128
    const a = A[o + 127], b = B[o]
    if ((a === bg) !== (b === bg)) mism++
    seam += palDist(a, b); ns++
    inner += palDist(A[o + 126], a); ni++
    inner += palDist(b, B[o + 1]); ni++
  }
  return { seam, ns, inner, ni, mism }
}
function seamStatsH(A, B, bg) {
  let seam = 0, ns = 0, inner = 0, ni = 0, mism = 0
  for (let x = 0; x < 128; x++) {
    const a = A[127 * 128 + x], b = B[x]
    if ((a === bg) !== (b === bg)) mism++
    seam += palDist(a, b); ns++
    inner += palDist(A[126 * 128 + x], a); ni++
    inner += palDist(b, B[128 + x]); ni++
  }
  return { seam, ns, inner, ni, mism }
}
function newStats() { return { seam: 0, ns: 0, inner: 0, ni: 0, mism: 0 } }
function addStats(t, s) { t.seam += s.seam; t.ns += s.ns; t.inner += s.inner; t.ni += s.ni; t.mism += s.mism }
function statsScore(acc) {
  const s = acc.ns ? acc.seam / acc.ns : 0
  const b = acc.ni ? acc.inner / acc.ni : 0
  const inkFrac = acc.ns ? acc.mism / acc.ns : 0
  return inkFrac * INK_WEIGHT + (s - b)
}

function imageSeamCost(data, W, H, cols, rows, bg) {
  const acc = newStats()
  for (let k = 1; k < cols; k++) {
    const x = k * 128
    if (x < 2 || x + 1 >= W) continue
    for (let y = 0; y < H; y++) {
      const o = y * W
      const a = data[o + x - 1], b = data[o + x]
      if ((a === bg) !== (b === bg)) acc.mism++
      acc.seam += palDist(a, b); acc.ns++
      acc.inner += palDist(data[o + x - 2], a); acc.ni++
      acc.inner += palDist(b, data[o + x + 1]); acc.ni++
    }
  }
  for (let k = 1; k < rows; k++) {
    const y = k * 128
    if (y < 2 || y + 1 >= H) continue
    for (let x = 0; x < W; x++) {
      const a = data[(y - 1) * W + x], b = data[y * W + x]
      if ((a === bg) !== (b === bg)) acc.mism++
      acc.seam += palDist(a, b); acc.ns++
      acc.inner += palDist(data[(y - 2) * W + x], a); acc.ni++
      acc.inner += palDist(b, data[(y + 1) * W + x]); acc.ni++
    }
  }
  return Math.round(statsScore(acc) * 1000) / 1000
}

// то же по отдельным плиткам и для произвольной перестановки колонок.
// ВАЖНО: rotTiles — в ЭКРАННЫХ координатах (индекс = displayRow*cols + displayCol).
function permSeamCost(rotTiles, cols, rows, colPerm, bg) {
  const acc = newStats()
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols - 1; k++) {
    const A = rotTiles[r * cols + colPerm[k]], B = rotTiles[r * cols + colPerm[k + 1]]
    if (!A || !B) continue
    addStats(acc, seamStatsV(A, B, bg))
  }
  for (let k = 0; k < cols; k++) for (let r = 0; r < rows - 1; r++) {
    const A = rotTiles[r * cols + colPerm[k]], B = rotTiles[(r + 1) * cols + colPerm[k]]
    if (!A || !B) continue
    addStats(acc, seamStatsH(A, B, bg))
  }
  return statsScore(acc)
}
function perms(arr, limit) {
  if (arr.length <= 1) return [arr.slice()]
  const res = []
  const rec = (rest, acc) => {
    if (res.length >= limit) return
    if (!rest.length) { res.push(acc); return }
    for (let i = 0; i < rest.length; i++) rec(rest.slice(0, i).concat(rest.slice(i + 1)), acc.concat([rest[i]]))
  }
  rec(arr, [])
  return res
}

// собрать картинку из массива плиток в экранных координатах
function composeFromDisp(dispTiles, cols, rows) {
  const W = cols * 128, H = rows * 128
  const out = new Uint8Array(W * H)
  let placed = 0
  for (let dr = 0; dr < rows; dr++) for (let dc = 0; dc < cols; dc++) {
    const t = dispTiles[dr * cols + dc]
    if (!t) continue
    placed++
    const dst0 = dr * 128 * W + dc * 128
    for (let y = 0; y < 128; y++) { const s0 = y * 128, d0 = dst0 + y * W; for (let x = 0; x < 128; x++) out[d0 + x] = t[s0 + x] }
  }
  return { data: out, W, H, placed, missing: cols * rows - placed }
}

// цена стыка двух плиток: B стоит справа/снизу/слева/сверху от A
function pairSeam(A, B, dr, dc, bg) {
  let s
  if (dc === 1) s = seamStatsV(A, B, bg)
  else if (dc === -1) s = seamStatsV(B, A, bg)
  else if (dr === 1) s = seamStatsH(A, B, bg)
  else s = seamStatsH(B, A, bg)
  return statsScore(s)
}

// локальная цена стыков одной плитки с соседями (для подбора поворота)
function cellSeamCost(dispTiles, cols, rows, idx, T, bg) {
  const r = Math.floor(idx / cols), c = idx % cols
  let cost = 0
  if (c > 0 && dispTiles[idx - 1]) cost += pairSeam(dispTiles[idx - 1], T, 0, 1, bg)
  if (c < cols - 1 && dispTiles[idx + 1]) cost += pairSeam(T, dispTiles[idx + 1], 0, 1, bg)
  if (r > 0 && dispTiles[idx - cols]) cost += pairSeam(dispTiles[idx - cols], T, 1, 0, bg)
  if (r < rows - 1 && dispTiles[idx + cols]) cost += pairSeam(T, dispTiles[idx + cols], 1, 0, bg)
  return cost
}

// Координатный спуск по поворотам (полировка).
function optimizeRotations(dispTiles, cols, rows, passes, bg) {
  const tilesOut = dispTiles.slice()
  const applied = new Array(cols * rows).fill(0)
  let improvedAny = false
  for (let p = 0; p < (passes || 3); p++) {
    let improved = false
    for (let idx = 0; idx < tilesOut.length; idx++) {
      const cur = tilesOut[idx]
      if (!cur) continue
      let bestQ = 0, bestT = cur, bestC = cellSeamCost(tilesOut, cols, rows, idx, cur, bg)
      for (let q = 1; q < 4; q++) {
        const t = rotQ(cur, q)
        const c = cellSeamCost(tilesOut, cols, rows, idx, t, bg)
        if (c < bestC - 1e-9) { bestC = c; bestT = t; bestQ = q }
      }
      if (bestQ) { tilesOut[idx] = bestT; applied[idx] = (applied[idx] + bestQ) % 4; improved = true; improvedAny = true }
    }
    if (!improved) break
  }
  return { tiles: tilesOut, applied, improved: improvedAny }
}

// Расстановка поворотов «распространением»: фиксируем опорную плитку,
// затем BFS — каждый сосед получает поворот с минимальной ценой стыка.
// Даёт глобально согласованную картину (в отличие от жадного спуска).
function propagateRotations(dispTiles, cols, rows, seedIdx, seedQ, bg) {
  const n = cols * rows
  const out = new Array(n).fill(null)
  const q = new Array(n).fill(0)
  out[seedIdx] = rotQ(dispTiles[seedIdx], seedQ)
  q[seedIdx] = seedQ
  const seen = new Uint8Array(n); seen[seedIdx] = 1
  const queue = [seedIdx]
  while (queue.length) {
    const idx = queue.shift()
    const r = Math.floor(idx / cols), c = idx % cols
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nr = r + dr, nc = c + dc
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
      const ni = nr * cols + nc
      if (seen[ni] || !dispTiles[ni]) continue
      seen[ni] = 1
      let bestQ = 0, bestC = Infinity
      for (let qq = 0; qq < 4; qq++) {
        const t = rotQ(dispTiles[ni], qq)
        const cc = pairSeam(out[idx], t, dr, dc, bg)
        if (cc < bestC) { bestC = cc; bestQ = qq }
      }
      q[ni] = bestQ
      out[ni] = rotQ(dispTiles[ni], bestQ)
      queue.push(ni)
    }
  }
  return { tiles: out, q }
}

// полный подбор поворотов: 2 опорные плитки × 4 глобальных поворота + полировка
function solveRotations(dispTiles, cols, rows, bg) {
  const present = []
  for (let i = 0; i < dispTiles.length; i++) if (dispTiles[i]) present.push(i)
  if (present.length < 2) return null
  const center = (dispTiles.length - 1) / 2
  present.sort((a, b) => Math.abs(a - center) - Math.abs(b - center))
  let best = null
  for (const seedIdx of present.slice(0, 2)) {
    for (let seedQ = 0; seedQ < 4; seedQ++) {
      const p = propagateRotations(dispTiles, cols, rows, seedIdx, seedQ, bg)
      const img = composeFromDisp(p.tiles, cols, rows)
      const cost = imageSeamCost(img.data, img.W, img.H, cols, rows, bg)
      if (!best || cost < best.cost) best = { tiles: p.tiles, q: p.q, cost, seedIdx, seedQ }
    }
  }
  if (!best) return null
  const pol = optimizeRotations(best.tiles, cols, rows, 2, bg)
  if (pol.improved) {
    const img2 = composeFromDisp(pol.tiles, cols, rows)
    const cost2 = imageSeamCost(img2.data, img2.W, img2.H, cols, rows, bg)
    if (cost2 < best.cost) {
      return { tiles: pol.tiles, q: pol.applied.map((a, i) => (a + best.q[i]) % 4), cost: cost2, seedIdx: best.seedIdx, seedQ: best.seedQ, polished: true }
    }
  }
  return best
}

// достройка пустых ячеек неиспользованными картами (в экранных координатах)
function fillHolesDisplay(dispTiles, dispFrames, cols, rows, img, tiles, bg) {
  const usedIds = new Set()
  for (const f of (dispFrames || [])) if (f && f.mapId !== null && f.mapId !== undefined) usedIds.add(f.mapId)
  const free = []
  for (const id of tiles.keys()) if (!usedIds.has(id)) free.push(id)
  const empty = []
  for (let i = 0; i < dispTiles.length; i++) if (!dispTiles[i]) empty.push(i)
  if (!free.length || !empty.length) return { filled: 0, assignments: [] }
  const W = cols * 128
  const data = img.data
  const assignments = []
  let filled = 0
  for (const idx of empty) {
    const r = Math.floor(idx / cols), c = idx % cols
    let best = null
    for (const id of free) {
      const raw = tiles.get(id)
      for (let q = 0; q < 4; q++) {
        const d = rotQ(raw, q)
        const probe = dispTiles.slice()
        probe[idx] = d
        const sc = cellSeamCost(probe, cols, rows, idx, d, bg)
        if (!best || sc < best.sc) best = { sc, id, q, d }
      }
    }
    if (!best || !isFinite(best.sc)) continue
    const dx = c * 128, dy = r * 128
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) data[(dy + y) * W + dx + x] = best.d[y * 128 + x]
    dispTiles[idx] = best.d
    const fi = free.indexOf(best.id)
    if (fi >= 0) free.splice(fi, 1)
    assignments.push({ row: r, col: c, mapId: best.id, rot: best.q, seam: Math.round(best.sc * 100) / 100 })
    filled++
  }
  return { filled, assignments }
}

// главный сборщик: перебирает ориентации × правила поворота, выбирает по швам
function assembleWallSmart(wall, tiles, view, opts) {
  opts = opts || {}
  const grid = buildGrid(wall)
  if (!grid.cols || !grid.rows) return null
  const framesWithData = grid.cells.filter(f => f && tiles.has(f.mapId))
  if (!framesWithData.length) return null

  const rotCands = rotationCandidates(framesWithData)
  const oriCands = orientationCandidates(grid, view)
  const rawTiles = []
  for (const f of grid.cells) if (f && tiles.has(f.mapId)) rawTiles.push(tiles.get(f.mapId))
  const bg = dominantColor(rawTiles)
  const trials = []

  for (const ori of oriCands) {
    for (const rc of rotCands) {
      const img = composeImage(grid, tiles, rc.fn, ori)
      if (!img.placed) continue
      const cost = imageSeamCost(img.data, img.W, img.H, grid.cols, grid.rows, bg)
      trials.push({ ori, rot: rc.name, img, cost })
    }
  }
  if (!trials.length) return null
  trials.forEach((t, i) => { t.order = i })
  const tol = opts.costTolerance == null ? 0.06 : opts.costTolerance
  // минимум швов = лучшее совпадение картинки (метрика может быть отрицательной — 0 ≈ идеальный стык)
  const bestCost = trials.reduce((m, t) => Math.min(m, t.cost), Infinity)
  const slack = Math.max(1.0, Math.abs(bestCost) * tol)
  // среди «почти равных» (в пределах slack) берём приоритетного кандидата:
  // view-ориентация + meta-поворот идут первыми в списке
  const near = trials.filter(t => t.cost <= bestCost + slack)
  near.sort((a, b) => a.order - b.order)
  const best = near[0]

  const { ori, rot } = best
  const rotFn = rotCands.find(r => r.name === rot).fn
  const cols = grid.cols, rows = grid.rows

  // --- раскладываем плитки в ЭКРАННЫЕ координаты (строка 0 = верх картинки) ---
  let dispTiles = new Array(cols * rows).fill(null)
  const dispFrames = new Array(cols * rows).fill(null)
  for (let dr = 0; dr < rows; dr++) {
    const srcRow = ori.yAsc ? dr : rows - 1 - dr
    for (let dc = 0; dc < cols; dc++) {
      const srcCol = ori.hAsc ? dc : cols - 1 - dc
      const f = grid.cells[srcRow * cols + srcCol]
      if (f && tiles.has(f.mapId)) {
        dispTiles[dr * cols + dc] = rotQ(tiles.get(f.mapId), rotFn(f))
        dispFrames[dr * cols + dc] = f
      }
    }
  }

  // --- порядок колонок: координаты авторитетны, перестановка только если ЯВНО лучше ---
  const identity = [...Array(cols).keys()]
  const natCost = permSeamCost(dispTiles, cols, rows, identity, bg)
  let colPerm = identity, permCost = natCost, permUsed = false
  // Перестановка — АВВАРИЙНЫЙ путь: координаты рамок есть истина.
  // Включаем поиск, только если естественный порядок явно «рваный»
  // (PERM_TRIGGER), и принимаем перестановку, только если она лучше
  // минимум вдвое и сама по себе хорошая (PERM_ACCEPT_MAX).
  const PERM_TRIGGER = opts.permTrigger == null ? 12 : opts.permTrigger
  const PERM_ACCEPT_MAX = opts.permAcceptMax == null ? 8 : opts.permAcceptMax
  if (cols >= 3 && cols <= 6 && opts.tryPerms !== false && natCost > PERM_TRIGGER) {
    let bp = null
    for (const p of perms(identity, 720)) {
      const c = permSeamCost(dispTiles, cols, rows, p, bg)
      if (!bp || c < bp.c) bp = { c, p }
    }
    if (bp && bp.c < natCost * 0.5 && bp.c < PERM_ACCEPT_MAX) { colPerm = bp.p; permCost = bp.c; permUsed = true }
  }
  if (permUsed) {
    const nt = new Array(cols * rows).fill(null)
    const nf = new Array(cols * rows).fill(null)
    for (let dr = 0; dr < rows; dr++) for (let c = 0; c < cols; c++) {
      nt[dr * cols + c] = dispTiles[dr * cols + colPerm[c]]
      nf[dr * cols + c] = dispFrames[dr * cols + colPerm[c]]
    }
    dispTiles = nt
    for (let i = 0; i < nf.length; i++) dispFrames[i] = nf[i]
  }

  let img = composeFromDisp(dispTiles, cols, rows)
  const placedFromFrames = img.placed
  let costNow = imageSeamCost(img.data, img.W, img.H, cols, rows, bg)
  const seamCostFrames = costNow

  // --- швы рвутся (Rotation не пришёл / иной порядок) => доворачиваем плитки поодиночке ---
  const ROT_OPT_THRESHOLD = opts.rotOptThreshold == null ? 8 : opts.rotOptThreshold
  let rotOpt = null
  if (opts.allowRotOpt !== false && costNow > ROT_OPT_THRESHOLD && placedFromFrames >= 3) {
    const s = solveRotations(dispTiles, cols, rows, bg)
    if (s && s.cost < costNow * 0.6) {
      dispTiles = s.tiles
      img = composeFromDisp(s.tiles, cols, rows)
      rotOpt = { applied: s.q, before: costNow, after: s.cost, seedIdx: s.seedIdx, seedQ: s.seedQ, polished: !!s.polished }
      costNow = s.cost
    }
  }

  // --- достройка дырок свободными картами ---
  const holes = fillHolesDisplay(dispTiles, dispFrames, cols, rows, img, tiles, bg)
  const finalCost = imageSeamCost(img.data, img.W, img.H, cols, rows, bg)

  const layout = []
  for (let dr = 0; dr < rows; dr++) for (let c = 0; c < cols; c++) {
    const idx = dr * cols + c
    const f = dispFrames[idx]
    const hole = holes.assignments.find(a => a.row === dr && a.col === c)
    const extra = rotOpt ? rotOpt.applied[idx] : 0
    layout.push({
      row: dr, col: c,
      mapId: f ? f.mapId : (hole ? hole.mapId : null),
      rotation: f ? ((rotFn(f) + extra) % 4) : (hole ? hole.rot : null),
      rotExtra: extra || 0,
      source: f ? 'frame' : (hole ? 'hole-fill' : 'empty'),
      x: f ? f.x : null, y: f ? f.y : null, z: f ? f.z : null
    })
  }

  return {
    grid, ori, rotRule: rotOpt ? (rot + '+optimized') : rot,
    data: img.data, W: img.W, H: img.H,
    placed: placedFromFrames, missing: cols * rows - placedFromFrames - holes.filled,
    holesFilled: holes.filled, holeAssignments: holes.assignments,
    seamCost: finalCost, seamCostFrames, natSeamCost: Math.round(natCost * 1000) / 1000,
    permSeamCost: Math.round(permCost * 1000) / 1000, permUsed, colPerm, layout, rotOpt,
    trials: trials.map(t => ({ ori: t.ori.tag, hAsc: t.ori.hAsc, yAsc: t.ori.yAsc, rot: t.rot, cost: Math.round(t.cost * 1000) / 1000, chosen: t === best }))
  }
}

// оценка «похоже ли на капчу с цифрами»
function captchaLikeness(asm) {
  const im = inkMaskWall(asm.data, asm.W, asm.H)
  const vars = buildVariants(im.ink, asm.W, asm.H)
  const pick = pickOcr(vars, asm.W, asm.H)
  const density = im.inkCount / (asm.W * asm.H)
  return { inkCount: im.inkCount, density: Math.round(density * 10000) / 10000, ocr: pick, variants: vars, ink: im.ink }
}

function wallDot(wall, view) {
  if (!view || typeof view.yaw !== 'number') return null
  let cx = 0, cz = 0
  for (const f of wall.frames) { cx += f.x; cz += f.z }
  cx /= wall.frames.length; cz /= wall.frames.length
  let dx = cx - view.x, dz = cz - view.z
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.001) return 0
  dx /= len; dz /= len
  return (-Math.sin(view.yaw) * dx + Math.cos(view.yaw) * dz)
}

// ========================= РАЗБОР МЕТАДАННЫХ ENTITY =========================
function toBuf(d) {
  if (Buffer.isBuffer(d)) return d
  if (d && d.type === 'Buffer' && Array.isArray(d.data)) return Buffer.from(d.data)
  if (d instanceof Uint8Array) return Buffer.from(d.buffer, d.byteOffset, d.byteLength)
  if (Array.isArray(d)) return Buffer.from(d)
  if (d && d.buffer) return Buffer.from(d.buffer, d.byteOffset || 0, d.length)
  return null
}

// универсальный поиск map_id внутри значения слота (любая версия протокола)
function findMapIdDeep(val, depth) {
  if (val == null || depth > 7) return null
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return null
  if (Array.isArray(val)) { for (const x of val) { const r = findMapIdDeep(x, depth + 1); if (r !== null) return r } return null }
  if (typeof val !== 'object') return null
  // data components (1.20.5+): { type: 'map_id' | 'minecraft:map_id', data: N }
  const t = String(val.type != null ? val.type : (val.name != null ? val.name : '')).replace(/^minecraft:/, '')
  if ((t === 'map_id' || t === 'map') && val.data != null) {
    if (typeof val.data === 'number') return val.data
    const d2 = firstNumberDeep(val.data, 0)
    if (d2 !== null) return d2
  }
  // NBT-тег map: { map: { type:'int', value:N } } (1.17–1.20.4) либо { map: N }
  for (const k of ['map_id', 'mapId', 'map', 'MapId', 'Map']) {
    if (typeof val[k] === 'number') return val[k]
    if (val[k] && typeof val[k] === 'object') { const n = firstNumberDeep(val[k], 0); if (n !== null) return n }
  }
  // старый формат (1.13–1.20.4): { blockId, itemCount, itemDamage }
  if (typeof val.itemDamage === 'number' && (typeof val.blockId === 'number' || typeof val.itemId === 'number')) return val.itemDamage
  // NBT: { value: { map: { type:'int', value:N } } }
  if (val.value && typeof val.value === 'object') {
    const r = findMapIdDeep(val.value, depth + 1)
    if (r !== null) return r
  }
  for (const k of Object.keys(val)) {
    if (k === 'type' || k === 'name') continue
    const r = findMapIdDeep(val[k], depth + 1)
    if (r !== null) return r
  }
  return null
}

function metaEntries(meta) {
  // nmp: [{key,type,value}] ; иногда объект {8:{...}}
  if (Array.isArray(meta)) return meta.filter(e => e && typeof e === 'object')
  if (meta && typeof meta === 'object') {
    return Object.keys(meta).map(k => {
      const e = meta[k]
      if (e && typeof e === 'object' && ('value' in e)) return { key: Number(e.key != null ? e.key : k), type: e.type, value: e.value }
      return { key: Number(k), type: null, value: e }
    })
  }
  return []
}

// первое число внутри объекта (для { data: { value: N } } и подобных)
function firstNumberDeep(val, depth) {
  if (val == null || depth > 5) return null
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (typeof val !== 'object') return null
  if (Array.isArray(val)) { for (const x of val) { const r = firstNumberDeep(x, depth + 1); if (r !== null) return r } return null }
  for (const k of ['value', 'val', 'id', 'map_id', 'mapId', 'map']) if (typeof val[k] === 'number') return val[k]
  for (const k of Object.keys(val)) { const r = firstNumberDeep(val[k], depth + 1); if (r !== null) return r }
  return null
}

// Извлечение map_id + rotation из метаданных item_frame.
// Работает и с «сырым» пакетом nmp ([{key,type,value}], type — ЧИСЛО или строка),
// и с object-формой mineflayer (entity.metadata = { '8': {...slot}, '9': 0 }).
function extractFrameInfo(meta) {
  const entries = metaEntries(meta)
  if (!entries.length) return null
  let mapId = null
  const rotCands = []

  for (const e of entries) {
    const key = Number(e.key)
    const typeStr = String(e.type == null ? '' : e.type).toLowerCase()
    const v = e.value
    // ---- слот предмета: у item_frame это key 8 (1.14+) ----
    const looksLikeSlot = !!v && typeof v === 'object' && !Array.isArray(v) &&
      ('blockId' in v || 'itemId' in v || 'components' in v || 'itemDamage' in v || 'nbtData' in v || 'present' in v)
    const isSlot = /slot|item/.test(typeStr) || key === 8 || looksLikeSlot
    if (isSlot && mapId === null) {
      const m = findMapIdDeep(v, 0)
      if (m !== null) mapId = m
    }
    // ---- rotation: целое 0..7 (у item_frame это key 9) ----
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7) rotCands.push({ key, v })
  }

  let rotation = null
  if (rotCands.length) {
    const k9 = rotCands.find(r => r.key === 9)
    const other = rotCands.find(r => r.key === 7 || r.key === 10 || r.key === 8)
    rotation = (k9 || other || rotCands[rotCands.length - 1]).v
  }
  if (mapId === null && rotation === null) return null
  return { mapId, rotation }
}

function getMapIdFromPacket(p) {
  if (!p) return null
  for (const k of ['mapId', 'itemDamage', 'map_id', 'id', 'map']) if (typeof p[k] === 'number') return p[k]
  return null
}

// ========================= ЗАПИСЬ РАУНДА =========================
async function saveRecord(outDir, snap, label, roundNo) {
  fs.mkdirSync(outDir, { recursive: true })
  const frames = (snap.frames || []).map(f => Object.assign({}, f))
  const tiles = snap.maps
  fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(frames, null, 2))
  fs.writeFileSync(path.join(outDir, 'chat.log'), (snap.chats || []).join('\n'))
  fs.writeFileSync(path.join(outDir, 'session_log.txt'), (snap.events || []).join('\n'))
  if (snap.view) fs.writeFileSync(path.join(outDir, 'view.json'), JSON.stringify(snap.view, null, 2))
  if (snap.metaDump) { try { fs.writeFileSync(path.join(outDir, 'metadata_dump.json'), JSON.stringify(snap.metaDump, null, 2)) } catch (e) {} }

  const linked = frames.filter(f => f.mapId !== null && f.mapId !== undefined && tiles.has(f.mapId))
  step(label + ': frames=' + frames.length + ' linked=' + linked.length + ' maps=' + tiles.size)

  const minFrames = wallMinFrames(linked.length)
  const walls = detectWalls(linked, minFrames)
  if (!walls.length) {
    step(label + ': ❌ стен не найдено (нужно ≥' + minFrames + ' рамок в одной плоскости)')
    fs.writeFileSync(path.join(outDir, 'FAIL.txt'), 'no walls detected; linked=' + linked.length + '\n')
    return null
  }
  step(label + ': плоскостей-кандидатов: ' + walls.map(w => w.tag + '(' + w.frames.length + ')').join(', '))

  const rfDeadline = ROBOFLOW.enabled ? Date.now() + RF_TOTAL_BUDGET_MS : 0
  const stats = []
  for (const w of walls.slice(0, 4)) {
    let asm = null
    try { asm = assembleWallSmart(w, tiles, snap.view, {}) } catch (e) { step(label + ' ' + w.tag + ': assemble err ' + e.message) }
    if (!asm) continue
    const like = captchaLikeness(asm)
    const dot = wallDot(w, snap.view)
    const dotBonus = (dot !== null && dot * VIEW_SIGN >= 0.8) ? 400 : 0
    const fillRatio = asm.placed / Math.max(1, asm.grid.total)

    let rf = { ok: false, status: 0, attempt: 'skipped', predictions: [], metrics: rfMetrics([]), error: 'not sent' }
    if (ROBOFLOW.enabled && Date.now() < rfDeadline) {
      try {
        const png = colorPng(asm.data, asm.W, asm.H, ROBOFLOW.scale)
        const fname = 'captcha_' + w.tag + '.png'
        fs.writeFileSync(path.join(outDir, 'ROBOFLOW_input_' + w.tag + '.png'), png)
        rf = await sendToRoboflow(png, fname, outDir, label + ' ' + w.tag, rfDeadline)
        fs.writeFileSync(path.join(outDir, 'roboflow_' + w.tag + '.json'), JSON.stringify({
          ok: rf.ok, status: rf.status, attempt: rf.attempt, error: rf.error || null, metrics: rf.metrics,
          predictionsCount: (rf.predictions || []).length, predictions: (rf.predictions || []).slice(0, 60), modelId: rf.modelId || ROBOFLOW.modelId
        }, null, 2))
      } catch (e) {
        rf = { ok: false, status: 0, attempt: 'exception', predictions: [], metrics: rfMetrics([]), error: e.message }
      }
    }
    const rfScore = rf.ok && rf.metrics ? rf.metrics.score : 0
    const score = rfScore * 100000 + (like.ocr.plausible ? 1500 : 0) + Math.round(fillRatio * 1000) +
      like.ocr.n * 60 + dotBonus - Math.round(asm.seamCost * 20)
    stats.push({ w, asm, like, dot, dotBonus, fillRatio, rf, rfScore, score })
  }

  if (!stats.length) { step(label + ': ❌ ни одна стена не собралась'); fs.writeFileSync(path.join(outDir, 'FAIL.txt'), 'no wall assembled\n'); return null }
  stats.sort((a, b) => b.score - a.score)
  const best = stats[0]
  const asm = best.asm

  // ---- сохраняем лучшую ----
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA.png'), colorPng(asm.data, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_x1.png'), colorPng(asm.data, asm.W, asm.H, 1))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask.png'), bwPng(best.like.ink, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_raw.bin'), Buffer.from(asm.data))
  fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify(asm.layout, null, 2))
  fs.writeFileSync(path.join(outDir, 'assembly_debug.json'), JSON.stringify({
    wall: best.w.tag, axis: best.w.axis, value: best.w.value,
    cols: asm.grid.cols, rows: asm.grid.rows, cells: asm.grid.total,
    placed: asm.placed, missing: asm.missing, holesFilled: asm.holesFilled, holeAssignments: asm.holeAssignments,
    orientation: asm.ori, rotationRule: asm.rotRule, permUsed: asm.permUsed, colPerm: asm.colPerm,
    seamCost: asm.seamCost, natSeamCost: asm.natSeamCost, permSeamCost: asm.permSeamCost,
    view: snap.view || null, trials: asm.trials, ocr: best.like.ocr, inkDensity: best.like.density
  }, null, 2))

  fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true })
  let ti = 0
  for (const f of linked) {
    const raw = tiles.get(f.mapId)
    if (raw) fs.writeFileSync(path.join(outDir, 'tiles', 'tile_' + String(ti++).padStart(2, '0') + '_map' + f.mapId + '_rot' + (f.rotation || 0) + '.bin'), Buffer.from(raw))
  }
  fs.mkdirSync(path.join(outDir, 'variants'), { recursive: true })
  const ocrLines = []
  for (const v of best.like.variants) {
    fs.writeFileSync(path.join(outDir, 'variants', v.name + '.png'), bwPng(v.mask, asm.W, asm.H, 2))
    const r = ocr(v.mask, asm.W, asm.H)
    ocrLines.push(v.name + ': "' + r.text + '" digits=' + r.digits.length)
  }
  fs.writeFileSync(path.join(outDir, 'ocr_variants.txt'), ocrLines.join('\n'))

  // ---- декаи (другие стены) ----
  for (const s of stats.slice(1)) {
    try {
      fs.writeFileSync(path.join(outDir, 'DECOY_NOT_ORIGINAL_' + s.w.tag + '.png'), colorPng(s.asm.data, s.asm.W, s.asm.H, 2))
    } catch (e) {}
  }

  // ---- плоская копия в records/captchas ----
  let capFile = null
  if (CAP_ROOT && roundNo) {
    try {
      fs.mkdirSync(CAP_ROOT, { recursive: true })
      capFile = 'round_' + String(roundNo).padStart(2, '0') + '.png'
      fs.writeFileSync(path.join(CAP_ROOT, capFile), colorPng(asm.data, asm.W, asm.H, 2))
      fs.writeFileSync(path.join(CAP_ROOT, capFile.replace(/\.png$/, '.json')), JSON.stringify({
        round: roundNo, wall: best.w.tag, cols: asm.grid.cols, rows: asm.grid.rows,
        placed: asm.placed, missing: asm.missing, holesFilled: asm.holesFilled,
        orientation: asm.ori, rotationRule: asm.rotRule, permUsed: asm.permUsed,
        seamCost: asm.seamCost, ocr: best.like.ocr.text, ocrVia: best.like.ocr.name,
        rf: { ok: best.rf.ok, status: best.rf.status, text: best.rf.metrics ? best.rf.metrics.text : '', n: best.rf.metrics ? best.rf.metrics.n : 0, error: best.rf.error || null },
        dir: path.relative(REC_ROOT, outDir), view: snap.view || null
      }, null, 2))
    } catch (e) { step('captchas copy err: ' + e.message) }
  }

  step(label + ': ✅ ORIGINAL=' + best.w.tag + ' ' + asm.grid.cols + '×' + asm.grid.rows +
    ' placed=' + asm.placed + '/' + asm.grid.total + (asm.missing ? ' holes+' + asm.holesFilled : '') +
    ' ori=' + asm.ori.tag + '(hAsc=' + asm.ori.hAsc + ',yAsc=' + asm.ori.yAsc + ')' +
    ' rot=' + asm.rotRule + (asm.permUsed ? ' PERM!' : '') +
    ' seam=' + asm.seamCost +
    ' ocr="' + best.like.ocr.text + '"' +
    ' rf=' + (best.rf.ok ? '"' + (best.rf.metrics ? best.rf.metrics.text : '') + '"' : (best.rf.status || 'off')))

  return {
    wall: best.w.tag, cols: asm.grid.cols, rows: asm.grid.rows,
    tilesCount: asm.placed, tilesExpected: asm.grid.total, missing: asm.missing, holesFilled: asm.holesFilled,
    ori: asm.ori.tag, hAsc: asm.ori.hAsc, yAsc: asm.ori.yAsc, rotRule: asm.rotRule, permUsed: asm.permUsed, colPerm: asm.colPerm,
    seamCost: asm.seamCost, natSeamCost: asm.natSeamCost,
    ocrText: best.like.ocr.text, ocrVia: best.like.ocr.name, ocrDigits: best.like.ocr.n, plausible: best.like.ocr.plausible,
    rf: best.rf, rfScore: best.rfScore, rfMetrics: best.rf.metrics || rfMetrics([]),
    inkDensity: best.like.density, layout: asm.layout, dir: outDir, capFile,
    originalFile: 'ORIGINAL_CAPTCHA.png'
  }
}

// ========================= ЗАХВАТ =========================
function connectAndCapture(tag) {
  return new Promise(resolve => {
    const col = {
      maps: new Map(), mapFilled: new Map(), mapUpdatedAt: new Map(),
      frames: [], framesById: new Map(), chats: [], events: [], prompts: 0,
      dead: false, reason: '', metaDump: [], firstFrameAt: 0, lastMapAt: 0, lastChangeAt: 0
    }
    const ev = s => { col.events.push(new Date().toISOString().slice(11, 23) + ' ' + s); step('[' + tag + '] ' + s) }

    let finished = false, bot = null
    let pollT = null, hardT = null, settleT = null, loginT = null, spawnT = null
    let readySince = 0

    const linkedFrames = () => col.frames.filter(f => f.mapId !== null && f.mapId !== undefined && col.maps.has(f.mapId))

    function bestWallNow() {
      const linked = linkedFrames()
      if (linked.length < 2) return null
      const walls = detectWalls(linked, wallMinFrames(linked.length))
      return walls.length ? walls[0] : null
    }
    function readiness() {
      const w = bestWallNow()
      if (!w) return { ready: false, why: 'нет стены', have: 0, need: 0, total: 0 }
      const grid = buildGrid(w)
      const have = grid.cells.filter(f => f && col.maps.has(f.mapId)).length
      const need = Math.max(CAP.minTiles, Math.ceil(grid.total * MIN_TILES_FRACTION))
      const allHave = have >= grid.total
      // «тишина»: ни новых рамок, ни новых метаданных, ни новых байт карты
      const quiet = col.lastChangeAt ? (Date.now() - col.lastChangeAt) >= CAP.stableMs : true
      const enough = have >= Math.min(need, grid.total)
      const promptOk = CAP.needPrompt ? col.prompts >= 1 : true
      const ok = enough && quiet && promptOk
      return {
        ready: ok,
        why: ok ? 'ok' : (!enough ? 'не хватает плиток (' + have + '/' + Math.min(need, grid.total) + ')'
          : (!quiet ? 'ждём тишины ' + CAP.stableMs + 'мс' : 'ждём промпт капчи')),
        have, need: Math.min(need, grid.total), total: grid.total, quiet
      }
    }

    const finish = (ok, note) => {
      if (finished) return
      finished = true
      for (const t of [hardT, loginT, spawnT, settleT]) { try { if (t) clearTimeout(t) } catch (e) {} }
      try { if (pollT) clearInterval(pollT) } catch (e) {}
      let view = null
      try { if (bot && bot.entity && bot.entity.position) view = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch } } catch (e) {}
      const snap = {
        maps: col.maps, frames: col.frames.map(f => Object.assign({}, f)),
        chats: col.chats.slice(), events: col.events.slice(), view, metaDump: col.metaDump.slice(0, 6)
      }
      try { if (bot) bot.end('done') } catch (e) {}
      resolve(ok ? { ok: true, snap, note } : { ok: false, note: note || col.reason || 'fail' })
    }

    if (!mineflayer) { finish(false, 'mineflayer не установлен (npm i mineflayer)'); return }
    if (!SocksClient) { finish(false, 'модуль socks не установлен'); return }

    hardT = setTimeout(() => {
      const r = readiness()
      ev('жёсткий таймаут ' + (CAP.timeoutMs / 1000) + 'с: have=' + r.have + '/' + (r.total || '?'))
      finish(r.have >= CAP.minTiles, 'timeout(have=' + r.have + ')')
    }, CAP.timeoutMs)

    if (!PROXY.host) { finish(false, 'нет proxy.host в конфиге'); return }

    SocksClient.createConnection({
      proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password },
      command: 'connect', destination: { host: MC.host, port: MC.port }
    }).then(conn => {
      ev('socks ok -> ' + MC.host + ':' + MC.port)
      const nick = (NICK_PREFIX + Math.floor(Math.random() * 9000 + 1000)).slice(0, 16)
      const tConn = Date.now()
      spawnT = setTimeout(() => { if (!finished) finish(false, 'spawn timeout') }, CONNECT_TIMEOUT_MS)
      loginT = setTimeout(() => { if (!finished) { ev('login timeout ' + (LOGIN_TIMEOUT_MS / 1000) + 'с'); finish(false, 'login timeout') } }, LOGIN_TIMEOUT_MS)

      bot = mineflayer.createBot({
        username: nick, host: MC.host, port: MC.port, version: MC.version,
        socket: conn.socket, hideErrors: true, auth: 'offline', keepAlive: true, checkTimeoutInterval: 60
      })

      // ---------- map_data ----------
      const onMap = pkt => {
        try {
          const id = getMapIdFromPacket(pkt)
          if (id === null) return
          const cols = pkt.columns || 0, rows = pkt.rows || 0
          if (!cols || !rows) return
          const buf = toBuf(pkt.data)
          if (!buf || !buf.length) return
          let canvas = col.maps.get(id)
          if (!canvas) { canvas = new Uint8Array(16384); col.maps.set(id, canvas); col.mapFilled.set(id, 0) }
          const x0 = pkt.x || 0, y0 = pkt.y || 0
          let touched = 0
          const n = Math.min(buf.length, cols * rows)
          for (let i = 0; i < n; i++) {
            const cx = x0 + (i % cols), cy = y0 + Math.floor(i / cols)
            if (cx < 0 || cy < 0 || cx >= 128 || cy >= 128) continue
            canvas[cy * 128 + cx] = buf[i]; touched++
          }
          col.mapFilled.set(id, (col.mapFilled.get(id) || 0) + touched)
          col.mapUpdatedAt.set(id, Date.now())
          col.lastMapAt = Date.now()
          col.lastChangeAt = Date.now()
          if (col.maps.size <= 3 || (col.maps.size % 8 === 0)) dbg('map ' + id + ' +' + touched + ' px (' + cols + '×' + rows + ' @' + x0 + ',' + y0 + ')')
        } catch (e) { dbg('onMap err ' + e.message) }
      }
      for (const nm of ['map_data', 'map', 'update_map']) { try { bot._client.on(nm, onMap) } catch (e) {} }

      // ---------- рамки ----------
      const isFrameName = e => /item_frame/i.test(String((e && (e.name || e.displayName || e.type || e.entityType || e.kind)) || ''))
      function addFrame(id, pos, info) {
        if (col.framesById.has(id)) return col.framesById.get(id)
        const f = { id, x: pos.x, y: pos.y, z: pos.z, mapId: null, rotation: 0, metaSeen: false }
        if (info) {
          if (info.mapId !== null && info.mapId !== undefined) { f.mapId = info.mapId; f.metaSeen = true }
          if (info.rotation !== null && info.rotation !== undefined) f.rotation = info.rotation
        }
        col.frames.push(f); col.framesById.set(id, f)
        if (!col.firstFrameAt) col.firstFrameAt = Date.now()
        col.lastChangeAt = Date.now()
        return f
      }
      function applyMeta(f, meta) {
        const info = extractFrameInfo(meta)
        f.metaSeen = true
        if (!info) {
          // метаданные есть, но map_id не распознан — сохраним сырьё для диагностики
          if (!f.dumped && col.metaDump.length < 6) {
            f.dumped = true
            try { col.metaDump.push({ entityId: f.id, problem: 'map_id не найден в метаданных', raw: JSON.parse(JSON.stringify(meta)) }) } catch (e) {}
          }
          return false
        }
        let changed = false
        if (info.mapId !== null && info.mapId !== undefined && f.mapId !== info.mapId) { f.mapId = info.mapId; changed = true }
        if (info.rotation !== null && info.rotation !== undefined && f.rotation !== info.rotation) { f.rotation = info.rotation; changed = true }
        if (changed) {
          col.lastChangeAt = Date.now()
          if (col.metaDump.length < 6) {
            try { col.metaDump.push({ entityId: f.id, mapId: f.mapId, rotation: f.rotation, raw: JSON.parse(JSON.stringify(meta)) }) } catch (e) {}
          }
        }
        return changed
      }

      bot.on('entitySpawn', ent => {
        try {
          if (!ent || !ent.position) return
          if (!isFrameName(ent)) return
          const info = ent.metadata ? extractFrameInfo(ent.metadata) : null
          const f = addFrame(ent.id, ent.position, info)
          if (f && !f.metaSeen && ent.metadata) applyMeta(f, ent.metadata)
          dbg('frame #' + ent.id + ' ' + String(ent.name || ent.displayName || '') + ' @' + ent.position.x.toFixed(2) + ',' + ent.position.y.toFixed(2) + ',' + ent.position.z.toFixed(2) + (f && f.mapId !== null ? ' map=' + f.mapId + ' rot=' + f.rotation : ''))
        } catch (e) { dbg('entitySpawn err ' + e.message) }
      })

      // имя пакета метаданных differs по версиям: entity_metadata / set_entity_metadata /
      // set_entity_data — слушаем все варианты сразу
      const onMetaPkt = pk => {
        try {
          const f = col.framesById.get(pk.entityId)
          if (f) { applyMeta(f, pk.metadata); return }
          // рамка могла прийти метаданными раньше, чем spawn
          const info = extractFrameInfo(pk.metadata)
          if (info && info.mapId !== null && bot && bot.entities && bot.entities[pk.entityId] && bot.entities[pk.entityId].position) {
            addFrame(pk.entityId, bot.entities[pk.entityId].position, info)
          }
        } catch (e) { dbg('meta pkt err ' + e.message) }
      }
      for (const nm of ['set_entity_metadata', 'entity_metadata', 'set_entity_data', 'entityMetadata']) { try { bot._client.on(nm, onMetaPkt) } catch (e) {} }

      // подстраховка: читаем уже распарсенные метаданные из mineflayer
      function scanEntities() {
        if (!bot || !bot.entities) return
        for (const key in bot.entities) {
          const e = bot.entities[key]
          if (!e || !e.position) continue
          const id = Number(key)
          let f = col.framesById.get(id)
          if (!f) {
            // берём всё, что похоже на рамку; а если имя не распознано —
            // смотрим, нет ли в метаданных map_id (подстраховка от странностей registry)
            let adopt = isFrameName(e)
            let info = null
            if (!adopt && e.metadata) {
              info = extractFrameInfo(e.metadata)
              adopt = !!(info && info.mapId !== null && info.mapId !== undefined)
            }
            if (!adopt) continue
            f = addFrame(id, e.position, info)
            if (adopt && !isFrameName(e)) ev('внимание: сущность #' + id + ' (' + String(e.name || e.type || '?') + ') не item_frame, но держит карту — считаю рамкой')
          }
          if (f && e.metadata && (f.mapId === null || f.mapId === undefined || !f.metaSeen)) applyMeta(f, e.metadata)
        }
      }

      // ---------- чат / title / actionbar ----------
      const PROMPT_RE = /введи|введите|номер|цифр|капч|captcha|код с|число/i
      const onText = (t, src) => {
        const s = String(t || '')
        if (!s) return
        col.chats.push('[' + src + '] ' + s)
        if (PROMPT_RE.test(s) && /номер|цифр|капч|captcha|код|число/i.test(s)) { col.prompts++; ev('промпт капчи #' + col.prompts + ' (' + src + '): ' + s.slice(0, 80)) }
      }
      bot.on('message', m => { let t = ''; try { t = m.toString() } catch (e) {}; onText(t, 'chat') })
      try { bot.on('messagestr', s => onText(s, 'chatstr')) } catch (e) {}
      for (const nm of ['set_title_text', 'set_title_subtitle', 'set_action_bar_text', 'system_chat', 'disguised_chat', 'set_title_title']) {
        try {
          bot._client.on(nm, pk => {
            let t = ''
            try {
              if (typeof pk.text === 'string') t = pk.text
              else if (pk.text && typeof pk.text === 'object') t = JSON.stringify(pk.text)
              else if (pk.content) t = typeof pk.content === 'string' ? pk.content : JSON.stringify(pk.content)
              t = t.replace(/\\u[0-9a-f]{4}/gi, '')
            } catch (e) {}
            onText(t, nm)
          })
        } catch (e) {}
      }

      bot.on('login', () => { try { clearTimeout(loginT) } catch (e) {}; ev('login ok (' + nick + ') за ' + (Date.now() - tConn) + 'мс') })
      bot.on('spawn', () => { try { clearTimeout(spawnT) } catch (e) {}; ev('spawn ok за ' + (Date.now() - tConn) + 'мс') })
      bot.on('kicked', r => {
        if (finished) return
        col.dead = true; col.reason = 'kicked'
        ev('kicked: ' + String((r && (r.reason || r.message)) || r || '').slice(0, 140))
        const rd = readiness()
        setTimeout(() => { if (!finished) finish(rd.have >= CAP.minTiles, 'kicked(have=' + rd.have + ')') }, 400)
      })
      bot.on('end', reason => {
        if (finished) return
        col.dead = true
        if (!col.reason) col.reason = 'end: ' + String(reason || '').slice(0, 100)
        ev(col.reason)
        const rd = readiness()
        setTimeout(() => { if (!finished) finish(rd.have >= CAP.minTiles, col.reason + '(have=' + rd.have + ')') }, 400)
      })
      bot.on('error', e => {
        if (finished) return
        col.dead = true
        if (!col.reason) col.reason = 'error: ' + e.message
        ev(col.reason)
        const rd = readiness()
        if (rd.have < CAP.minTiles) finish(false, col.reason)
      })

      pollT = setInterval(() => {
        if (finished) return
        try { scanEntities() } catch (e) {}
        const rd = readiness()
        if (rd.ready) {
          if (!readySince) { readySince = Date.now(); ev('данные готовы: ' + rd.have + '/' + rd.total + ' — добираю ' + SETTLE_MS + 'мс') }
          if (!settleT) settleT = setTimeout(() => finish(true, 'captured ' + rd.have + '/' + rd.total), SETTLE_MS)
        } else {
          readySince = 0
          if (settleT) { clearTimeout(settleT); settleT = null }
          if (col.dead && rd.have >= CAP.minTiles) finish(true, 'captured-before-kick ' + rd.have)
        }
      }, 300)
    }).catch(e => { ev('socks fail: ' + e.message); finish(false, 'socks: ' + e.message) })
  })
}

// ========================= SELFTEST (геометрия без сервера) =========================
function makeSyntheticCaptcha(cols, rows, seed) {
  let s = seed || 12345
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const W = cols * 128, H = rows * 128
  const img = new Uint8Array(W * H)
  const BG = 34                                    // белая шерсть (base 8, shade 2)
  for (let i = 0; i < img.length; i++) img[i] = BG
  const COLORS = [118, 122, 30, 26, 114, 46, 102, 98, 54, 50, 78, 74]   // разные базы и оттенки
  const put = (x, y, v, r) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue
      const X = x + dx, Y = y + dy
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      img[Y * W + X] = v
    }
  }
  // пятна-шум (разноцветные)
  for (let k = 0; k < cols * rows * 6; k++) {
    put(Math.floor(rnd() * W), Math.floor(rnd() * H), COLORS[Math.floor(rnd() * COLORS.length)], 3 + Math.floor(rnd() * 12))
  }
  // «цифры»: ломаные линии разного цвета и толщины, непрерывные через границы плиток
  for (let k = 0; k < cols * rows * 3; k++) {
    let cx = 10 + rnd() * (W - 20), cy = 10 + rnd() * (H - 20)
    const col = COLORS[Math.floor(rnd() * COLORS.length)]
    const thick = 2 + Math.floor(rnd() * 3)
    for (let seg = 0; seg < 5; seg++) {
      const nx = Math.max(4, Math.min(W - 5, cx + (rnd() - 0.5) * 90))
      const ny = Math.max(4, Math.min(H - 5, cy + (rnd() - 0.5) * 90))
      const steps = Math.max(Math.abs(nx - cx), Math.abs(ny - cy)) | 0
      for (let i = 0; i <= steps; i++) put(Math.round(cx + (nx - cx) * i / steps), Math.round(cy + (ny - cy) * i / steps), col, thick)
      cx = nx; cy = ny
    }
  }
  return img
}

async function selftest() {
  const rfWas = ROBOFLOW.enabled
  ROBOFLOW.enabled = false   // в самопроверке сеть не трогаем
  console.log('=== SELFTEST v3.8.0: геометрия сборки ===')
  let fails = 0
  // сначала — чистая проверка правила «с какой стороны смотрим → где лево»
  const hAscCases = [
    { axis: 'z', plane: 300, view: { x: 0, y: 70, z: 295 }, want: false, name: 'z-стена, бот с -z (смотрит на юг): слева большие x' },
    { axis: 'z', plane: 300, view: { x: 0, y: 70, z: 305 }, want: true, name: 'z-стена, бот с +z (смотрит на север): слева меньшие x' },
    { axis: 'x', plane: 300, view: { x: 295, y: 70, z: 0 }, want: true, name: 'x-стена, бот с -x (смотрит на восток): слева меньшие z' },
    { axis: 'x', plane: 300, view: { x: 305, y: 70, z: 0 }, want: false, name: 'x-стена, бот с +x (смотрит на запад): слева большие z' }
  ]
  console.log('--- правило стороны обзора (viewpointHAsc) ---')
  for (const hc of hAscCases) {
    const grid = { wall: { axis: hc.axis, value: hc.plane } }
    const got = viewpointHAsc(grid, hc.view)
    const ok = got === hc.want
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + hc.name + ' → hAsc=' + got + (ok ? '' : ' (ожидалось ' + hc.want + ')'))
  }

  console.log('--- сквозная сборка синтетической стены ---')
  const cases = [
    { cols: 3, rows: 2, axis: 'z', viewSide: -1, rots: true, name: 'z-стена 3×2, бот с -z, повороты' },
    { cols: 4, rows: 3, axis: 'z', viewSide: +1, rots: true, name: 'z-стена 4×3, бот с +z, повороты' },
    { cols: 2, rows: 3, axis: 'x', viewSide: -1, rots: true, name: 'x-стена 2×3, бот с -x, повороты' },
    { cols: 3, rows: 3, axis: 'z', viewSide: -1, rots: false, name: 'z-стена 3×3, без поворотов' },
    { cols: 4, rows: 2, axis: 'z', viewSide: -1, rots: true, name: 'z-стена 4×2, повороты (зеркальный кейс)' },
    // раскладка согласована с точкой обзора: должна выбираться ориентация 'view'
    { cols: 3, rows: 2, axis: 'z', viewSide: -1, rots: true, viewConsistent: true, wantOri: 'view', name: 'z-стена 3×2, раскладка «как видит бот с -z»' },
    { cols: 4, rows: 2, axis: 'x', viewSide: +1, rots: true, viewConsistent: true, wantOri: 'view', name: 'x-стена 4×2, раскладка «как видит бот с +x»' }
  ]
  for (const cs of cases) {
    const orig = makeSyntheticCaptcha(cs.cols, cs.rows, 7777 + cs.cols * 31 + cs.rows * 7)
    const W = cs.cols * 128, H = cs.rows * 128
    const tiles = new Map()
    const frames = []
    let id = 100
    for (let r = 0; r < cs.rows; r++) for (let c = 0; c < cs.cols; c++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      const q = cs.rots ? ((r * 3 + c * 2 + id) % 4) : 0
      // сервер хранит карту «до поворота рамки»: mapData = rotQ(tile, -q)
      tiles.set(id, rotQ(tile, (4 - q) % 4))
      // куда физически встанет плитка с колонкой c изображения
      const hAscExpected = cs.axis === 'z' ? (cs.viewSide > 0) : (cs.viewSide < 0)
      const ni = cs.viewConsistent ? (hAscExpected ? c : cs.cols - 1 - c) : c
      const pos = cs.axis === 'z'
        ? { x: 200.5 + ni, y: 70.5 - r, z: 300 + cs.viewSide * 0.0625 }
        : { x: 300 + cs.viewSide * 0.0625, y: 70.5 - r, z: 200.5 + ni }
      frames.push({ id: id, x: pos.x, y: pos.y, z: pos.z, mapId: id, rotation: q })
      id++
    }
    const planeVal = cs.axis === 'z' ? frames[0].z : frames[0].x
    const view = cs.axis === 'z'
      ? { x: 202, y: 70, z: planeVal + cs.viewSide * 5, yaw: cs.viewSide < 0 ? 0 : Math.PI }
      : { x: planeVal + cs.viewSide * 5, y: 70, z: 202, yaw: cs.viewSide < 0 ? -Math.PI / 2 : Math.PI / 2 }
    const wall = { axis: cs.axis, value: planeVal, frames, tag: cs.axis + Math.round(planeVal) }
    const asm = assembleWallSmart(wall, tiles, view, {})
    if (!asm) { console.log('  ❌ ' + cs.name + ': не собралось'); fails++; continue }
    let diff = 0
    for (let i = 0; i < orig.length; i++) if (orig[i] !== asm.data[i]) diff++
    const pct = (100 * diff / orig.length)
    const okpct = pct < 0.5
    const okOri = !cs.wantOri || asm.ori.tag === cs.wantOri
    console.log('  ' + (okpct && okOri ? '✅' : '❌') + ' ' + cs.name +
      ' → ori=' + asm.ori.tag + ' hAsc=' + asm.ori.hAsc + ' rot=' + asm.rotRule +
      ' perm=' + asm.permUsed + ' seam=' + asm.seamCost + ' placed=' + asm.placed + '/' + asm.grid.total +
      ' расхождений=' + pct.toFixed(3) + '%' + (okOri ? '' : ' [ОРИЕНТАЦИЯ НЕ ТА: ждали ' + cs.wantOri + ']'))
    if (!okpct || !okOri) {
      fails++
      try {
        const d = path.join(__dirname, 'records', 'selftest')
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, cs.name.replace(/[^\w\-]+/g, '_') + '_expected.png'), colorPng(orig, W, H, 1))
        fs.writeFileSync(path.join(d, cs.name.replace(/[^\w\-]+/g, '_') + '_got.png'), colorPng(asm.data, asm.W, asm.H, 1))
      } catch (e) {}
    }
  }
  // ---- стресс: сервер НЕ прислал Rotation (в метаданных 0), плитки реально повёрнуты ----
  console.log('--- стресс-кейсы ---')
  {
    const cols = 3, rows = 2, viewSide = -1
    const orig = makeSyntheticCaptcha(cols, rows, 424242)
    const W = cols * 128
    const tiles = new Map(), frames = []
    let id = 300
    const hAscExpected = viewSide > 0
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      const q = (r + c * 2 + 1) % 4
      tiles.set(id, rotQ(tile, (4 - q) % 4))
      const ni = hAscExpected ? c : cols - 1 - c
      frames.push({ id, x: 200.5 + ni, y: 70.5 - r, z: 300 + viewSide * 0.0625, mapId: id, rotation: 0 })
      id++
    }
    const view = { x: 202, y: 70, z: 300 + viewSide * 5, yaw: 0 }
    const wall = { axis: 'z', value: frames[0].z, frames, tag: 'z300' }
    const asm = assembleWallSmart(wall, tiles, view, {})
    let diff = 0
    if (asm) for (let i = 0; i < orig.length; i++) if (orig[i] !== asm.data[i]) diff++
    const pct = asm ? 100 * diff / orig.length : 100
    const ok = !!asm && pct < 0.5
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' Rotation в метаданных нет (все 0) \u2192 ' +
      (asm ? 'rot=' + asm.rotRule + ' seam=' + asm.seamCost + ' расхождений=' + pct.toFixed(3) + '%' : 'не собралось'))
  }

  // ---- стресс: одна плитка не пришла (дырка в сетке) ----
  {
    const cols = 3, rows = 3, viewSide = -1
    const orig = makeSyntheticCaptcha(cols, rows, 999111)
    const W = cols * 128
    const tiles = new Map(), frames = []
    let id = 400
    const holeIdx = 4 // центральная плитка
    let k = 0
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++, k++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      if (k !== holeIdx) tiles.set(id, tile)
      frames.push({ id, x: 200.5 + (cols - 1 - c), y: 70.5 - r, z: 300 + viewSide * 0.0625, mapId: id, rotation: 0 })
      id++
    }
    // как в saveRecord: в стену попадают только рамки с пришедшими данными
    const linked = frames.filter(f => tiles.has(f.mapId))
    const view = { x: 202, y: 70, z: 300 + viewSide * 5, yaw: 0 }
    const wall = { axis: 'z', value: frames[0].z, frames: linked, tag: 'z300' }
    const asm = assembleWallSmart(wall, tiles, view, {})
    let badCells = 0
    if (asm) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        let same = true
        for (let y = 0; y < 128 && same; y++) for (let x = 0; x < 128; x++) {
          if (orig[(r * 128 + y) * W + c * 128 + x] !== asm.data[(r * 128 + y) * asm.W + c * 128 + x]) { same = false; break }
        }
        if (!same) badCells++
      }
    }
    const ok = !!asm && asm.grid.cols === 3 && asm.grid.rows === 3 && asm.placed === 8 && asm.missing === 1 && badCells === 1
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' нет данных одной плитки \u2192 ' +
      (asm ? 'сетка=' + asm.grid.cols + '\u00d7' + asm.grid.rows + ' placed=' + asm.placed + ' missing=' + asm.missing +
        ' битых ячеек=' + badCells + ' (ожидалась 1 \u2014 сама дырка)' : 'не собралось'))
  }

  // ---- разбор метаданных item_frame (все известные формы протокола) ----
  console.log('--- разбор map_id / Rotation из метаданных ---')
  const metaCases = [
    {
      name: '1.21.1 сырой пакет nmp (type — число, data components)',
      meta: [
        { key: 0, type: 0, value: 0 }, { key: 1, type: 1, value: 300 },
        { key: 8, type: 7, value: { present: true, itemCount: 1, itemId: 638, addedComponentCount: 1, removedComponentCount: 0, components: [{ type: 'map_id', data: 17 }], removeComponents: [] } },
        { key: 9, type: 1, value: 2 }
      ], wantMap: 17, wantRot: 2
    },
    {
      name: '1.21.x mineflayer entity.metadata (объект, minecraft:map_id, data-объект)',
      meta: { 0: 0, 1: 300, 8: { present: true, itemCount: 1, itemId: 638, components: [{ type: 'minecraft:map_id', data: { value: 5 } }] }, 9: 1 },
      wantMap: 5, wantRot: 1
    },
    {
      name: '1.16 slot через blockId/itemDamage',
      meta: [{ key: 8, type: 6, value: { blockId: 358, itemCount: 1, itemDamage: 42, nbtData: null } }, { key: 9, type: 1, value: 3 }],
      wantMap: 42, wantRot: 3
    },
    {
      name: '1.17–1.20.4 slot с NBT-тегом map',
      meta: [{ key: 8, type: 'slot', value: { itemId: 638, itemCount: 1, nbtData: { type: 'compound', value: { map: { type: 'int', value: 99 } } } } }, { key: 9, type: 'varint', value: 0 }],
      wantMap: 99, wantRot: 0
    },
    {
      name: 'пустая рамка (нет карты)',
      meta: [{ key: 8, type: 7, value: { present: false, itemCount: 0 } }, { key: 9, type: 1, value: 0 }],
      wantMap: null, wantRot: 0
    }
  ]
  for (const mc of metaCases) {
    const got = extractFrameInfo(mc.meta) || {}
    const okMap = (got.mapId === null || got.mapId === undefined) ? mc.wantMap === null : got.mapId === mc.wantMap
    const okRot = (got.rotation === null || got.rotation === undefined) ? mc.wantRot === null : got.rotation === mc.wantRot
    const ok = okMap && okRot
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + mc.name + ' → mapId=' + (got.mapId === undefined ? 'undef' : got.mapId) +
      ' rotation=' + (got.rotation === undefined ? 'undef' : got.rotation) +
      (ok ? '' : ' (ожидалось mapId=' + mc.wantMap + ' rotation=' + mc.wantRot + ')'))
  }

  // ---- сквозной прогон saveRecord (как после живого раунда) ----
  console.log('--- сквозной прогон saveRecord ---')
  {
    const cols = 4, rows = 3
    const orig = makeSyntheticCaptcha(cols, rows, 31337)
    const W = cols * 128
    const maps = new Map()
    const frames = []
    let id = 500
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      const q = (r * 2 + c) % 4
      maps.set(id, rotQ(tile, (4 - q) % 4))
      frames.push({ id, x: 200.5 + (cols - 1 - c), y: 70.5 - r, z: 299.9375, mapId: id, rotation: q })
      id++
    }
    const view = { x: 202, y: 70, z: 294.9, yaw: 0, pitch: 0 }
    const outDir = path.join(REC_ROOT || __dirname, 'selftest_e2e')
    const snap = { maps, frames, chats: ['[chat] Введите номер с картинки'], events: ['selftest'], view, metaDump: [] }
    let rec = null, err = null
    try { rec = await saveRecord(outDir, snap, 'SELFTEST', null) } catch (e) { err = e }
    if (err) { console.log('  \u274c saveRecord бросил: ' + err.message); fails++ }
    else if (!rec) { console.log('  \u274c saveRecord вернул null'); fails++ }
    else {
      let diff = 0
      try {
        const got = fs.readFileSync(path.join(outDir, 'ORIGINAL_raw.bin'))
        for (let i = 0; i < orig.length; i++) if (got[i] !== orig[i]) diff++
      } catch (e) { diff = orig.length }
      const pct = 100 * diff / orig.length
      const filesOk = ['ORIGINAL_CAPTCHA.png', 'ORIGINAL_CAPTCHA_x1.png', 'layout.json', 'assembly_debug.json', 'ORIGINAL_raw.bin']
        .every(f => fs.existsSync(path.join(outDir, f)))
      const ok = pct < 0.5 && filesOk && rec.tilesCount === cols * rows
      if (!ok) fails++
      console.log('  ' + (ok ? '\u2705' : '\u274c') + ' saveRecord ' + rec.cols + '\u00d7' + rec.rows +
        ' tiles=' + rec.tilesCount + '/' + rec.tilesExpected + ' ori=' + rec.ori + ' rot=' + rec.rotRule +
        (rec.permUsed ? ' PERM!' : '') + ' seam=' + rec.seamCost +
        ' файлы=' + (filesOk ? 'все' : 'НЕ ВСЕ') + ' расхождений=' + pct.toFixed(3) + '%')
    }
  }

  ROBOFLOW.enabled = rfWas
  console.log(fails ? '=== SELFTEST: ' + fails + ' ПРОВАЛОВ ===' : '=== SELFTEST: ВСЁ ОК ===')
  return fails === 0
}

// ========================= REPLAY: пересобрать из записи =========================
function replayDir(dir) {
  step('REPLAY: ' + dir)
  const framesPath = path.join(dir, 'frames.json')
  if (!fs.existsSync(framesPath)) { step('нет frames.json в ' + dir); return null }
  const frames = JSON.parse(fs.readFileSync(framesPath, 'utf8'))
  const maps = new Map()
  const tilesDirs = ['tiles', '.'].map(x => path.join(dir, x))
  for (const td of tilesDirs) {
    if (!fs.existsSync(td)) continue
    for (const f of fs.readdirSync(td)) {
      const m = f.match(/map(\d+)(?:_rot\d+)?\.bin$/)
      if (!m) continue
      const id = Number(m[1])
      if (maps.has(id)) continue
      const buf = fs.readFileSync(path.join(td, f))
      maps.set(id, new Uint8Array(buf.buffer, buf.byteOffset, buf.length))
    }
  }
  step('загружено tiles=' + maps.size + ' frames=' + frames.length)
  let view = null
  try { view = JSON.parse(fs.readFileSync(path.join(dir, 'view.json'), 'utf8')) } catch (e) {}
  const snap = { maps, frames, chats: [], events: ['replay'], view }
  const out = path.join(dir, 'rebuild_' + STAMP)
  return { snap, out }
}

// ========================= MAIN =========================
async function main() {
  step('=== СТАРТ v3.8.0 ===')

  if (CLI.selftest) { process.exit((await selftest()) ? 0 : 1) }

  if (CLI.rfTest) {
    const f = CLI.rfTest
    if (!fs.existsSync(f)) { step('файл не найден: ' + f); process.exit(1) }
    const buf = fs.readFileSync(f)
    const r = await sendToRoboflow(buf, path.basename(f), path.dirname(f), 'rf-test', Date.now() + RF_TOTAL_BUDGET_MS)
    step('RF test: ok=' + r.ok + ' status=' + r.status + ' text="' + (r.metrics ? r.metrics.text : '') + '" err=' + (r.error || '-'))
    process.exit(r.ok ? 0 : 1)
  }

  if (CLI.replay) {
    const rp = replayDir(CLI.replay)
    if (!rp) process.exit(1)
    const rec = await saveRecord(rp.out, rp.snap, 'REPLAY', null)
    step(rec ? 'REPLAY OK: ' + rec.wall + ' ' + rec.cols + '×' + rec.rows + ' → ' + rp.out : 'REPLAY FAIL')
    setTimeout(() => process.exit(rec ? 0 : 1), 300)
    return
  }

  if (!CFG_PATH) { step('НЕ НАЙДЕН config.json'); process.exit(1) }
  step('config: ' + CFG_PATH + ' parse=' + CFG_STRATEGY)
  step('MC: ' + MC.host + ':' + MC.port + ' v' + MC.version + ' | прокси MC: ' + (PROXY.host || 'НЕТ') + ':' + PROXY.port)
  step('RF SOCKS: ' + (RF_SOCKS ? RF_SOCKS.host + ':' + RF_SOCKS.port : 'нет (direct)'))
  step('ROBOFLOW: ' + (ROBOFLOW.enabled ? ('ВКЛ model=' + ROBOFLOW.modelId + ' key=' + ROBOFLOW.apiKey.slice(0, 4) + '...') : 'ВЫКЛ (только сбор картинок)'))
  step('capture: minTiles=' + CAP.minTiles + ' stableMs=' + CAP.stableMs + ' timeout=' + (CAP.timeoutMs / 1000) + 'с needPrompt=' + CAP.needPrompt)

  await killPort9001()
  currentRunIp = await rotateIp()
  step('IP забега: ' + (currentRunIp || '?'))

  const results = []
  const tGlobal = Date.now()
  let rotationsUsed = 0, consecutiveNetFails = 0, proxyFails = 0, aborted = false

  for (let r = 1; r <= TARGET_ROUNDS && !aborted; r++) {
    let rec = null, lastNetFail = null, lastNote = ''
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ROUND && !rec && !aborted; attempt++) {
      if (attempt > 1 && (lastNetFail || consecutiveNetFails > 0) && rotationsUsed < MAX_ROTATIONS_ON_FAIL) {
        rotationsUsed++
        step('🔄 ротация IP (' + rotationsUsed + '/' + MAX_ROTATIONS_ON_FAIL + ')')
        await rotateIp(); await sleep(2500)
      } else if (attempt > 1) await sleep(1500)
      else await sleep(1000 + Math.floor(Math.random() * 1000))

      step('--- РАУНД ' + r + '/' + TARGET_ROUNDS + ' (попытка ' + attempt + ', IP ' + (currentRunIp || '?') + ') ---')
      const res = await connectAndCapture('r' + r + 'a' + attempt)
      lastNetFail = !!(res && !res.ok && NET_FAIL_RE.test(res.note || ''))
      lastNote = res ? res.note : '?'

      if (res && res.ok) {
        consecutiveNetFails = 0; proxyFails = 0
        const dir = path.join(REC_ROOT, 'round' + String(r).padStart(2, '0') + '_a' + attempt + '_' + STAMP)
        const candidate = await saveRecord(dir, res.snap, 'РАУНД' + r, r)
        if (candidate) {
          const need = Math.max(CAP.minTiles, Math.ceil(candidate.tilesExpected * MIN_TILES_FRACTION))
          if (candidate.tilesCount >= Math.min(need, candidate.tilesExpected)) rec = candidate
          else step('РАУНД ' + r + ': мало плиток ' + candidate.tilesCount + '/' + candidate.tilesExpected + ' (нужно ' + need + ')')
        }
      } else {
        step('раунд ' + r + ' попытка ' + attempt + ': ' + lastNote)
        if (FATAL_RE.test(lastNote)) {
          aborted = true
          step('❌ ФАТАЛЬНО: ' + lastNote + ' — дальнейшие попытки бессмысленны')
        } else if (PROXY_DEAD_RE.test(lastNote)) {
          proxyFails++
          if (proxyFails >= 2) { proxyDead = true; aborted = true; step('ПРОКСИ МЁРТВ') }
        } else if (lastNetFail) {
          if (currentRunIp) badIPs.add(currentRunIp)
          consecutiveNetFails++
          if (consecutiveNetFails >= 6) { aborted = true; step('6 сетевых фейлов подряд') }
        } else consecutiveNetFails = 0
      }
    }
    if (rec) {
      results.push({ n: r, ok: true, rec })
      step('РАУНД ' + r + ' ✅ ' + rec.cols + '×' + rec.rows + ' tiles=' + rec.tilesCount + '/' + rec.tilesExpected +
        ' ori=' + rec.ori + ' rot=' + rec.rotRule + ' seam=' + rec.seamCost + ' ocr="' + rec.ocrText + '"' +
        (rec.capFile ? ' → records/captchas/' + rec.capFile : ''))
    } else if (!aborted) {
      results.push({ n: r, ok: false, note: lastNote || 'fail' })
      step('РАУНД ' + r + ' ❌ провален (' + (lastNote || 'fail') + ')')
    }
    if (r < TARGET_ROUNDS && !aborted) await sleep(PAUSE_BETWEEN_MS)
  }

  const okList = results.filter(x => x.ok)
  const L = ['=== СВОДКА ' + TARGET_ROUNDS + ' РАУНДОВ (v3.8.0) ===']
  L.push('успешных: ' + okList.length + '/' + TARGET_ROUNDS + ' | время: ' + Math.round((Date.now() - tGlobal) / 1000) + 'с')
  for (const x of results) {
    L.push('  #' + x.n + ': ' + (x.rec
      ? 'OK ' + x.rec.cols + '×' + x.rec.rows + ' tiles=' + x.rec.tilesCount + '/' + x.rec.tilesExpected +
        ' ori=' + x.rec.ori + ' rot=' + x.rec.rotRule + (x.rec.permUsed ? ' PERM' : '') +
        ' seam=' + x.rec.seamCost + ' ocr="' + x.rec.ocrText + '"' +
        (x.rec.rf && x.rec.rf.ok ? ' rf="' + x.rec.rfMetrics.text + '"' : '') +
        (x.rec.capFile ? ' [captchas/' + x.rec.capFile + ']' : '')
      : 'FAIL (' + (x.note || '') + ')'))
  }
  L.push('')
  L.push('Картинки: ' + CAP_ROOT)
  step('готово.')
  flushReport(L.join('\n'))
  try {
    fs.writeFileSync(path.join(REC_ROOT, 'summary.json'), JSON.stringify({
      stamp: STAMP, version: '3.8.0', rounds: TARGET_ROUNDS, ok: okList.length,
      seconds: Math.round((Date.now() - tGlobal) / 1000),
      results: results.map(x => x.rec ? {
        round: x.n, ok: true, wall: x.rec.wall, grid: x.rec.cols + 'x' + x.rec.rows,
        tiles: x.rec.tilesCount + '/' + x.rec.tilesExpected, holesFilled: x.rec.holesFilled,
        orientation: x.rec.ori, rotationRule: x.rec.rotRule, permUsed: x.rec.permUsed,
        seamCost: x.rec.seamCost, ocr: x.rec.ocrText,
        rf: { ok: x.rec.rf.ok, status: x.rec.rf.status, text: x.rec.rfMetrics ? x.rec.rfMetrics.text : null, error: x.rec.rf.error || null },
        file: x.rec.capFile, dir: x.rec.dir
      } : { round: x.n, ok: false, note: x.note })
    }, null, 2))
  } catch (e) { console.error('summary.json err:', e.message) }
  console.log('\n' + L.join('\n'))
  setTimeout(() => process.exit(0), 1500)
}

if (require.main === module) {
  main().catch(e => {
    console.error('\n!!! FATAL MAIN ERROR !!!\nMessage:', e.message, '\nStack:', e.stack)
    flushReport('FATAL: ' + (e.stack || e.message))
    setTimeout(() => process.exit(1), 1500)
  })
}

module.exports = {
  PALETTE, SHADE_MULT, BASE_COLORS, LUM, palDist, rotQ, encodePng, colorPng, bwPng,
  clusterValues, detectWalls, wallMinFrames, buildGrid, viewpointHAsc, orientationCandidates, rotationCandidates,
  dominantColor, composeImage, composeFromDisp, imageSeamCost, permSeamCost, pairSeam,
  optimizeRotations, propagateRotations, solveRotations, fillHolesDisplay,
  assembleWallSmart, captchaLikeness,
  extractFrameInfo, findMapIdDeep, getMapIdFromPacket, inkMaskWall, ocr,
  selftest, makeSyntheticCaptcha, saveRecord
}
