// VERSION: 5.1.1
// main.js — АВТОРЕШАТЕЛЬ капчи FunTime + TELEGRAM-ПУЛЬТ управления
//           заход → капча → /reg → HUB → /anN-анархия → релей чата из Telegram.
//
// ============ ЧТО ИЗМЕНЕНО В v5.1.1 ============
// ФИКС «💀 Соединение закрыто: error: Parse error for play.toClient: Read error for
//   undefined»: (1) ошибки РАЗБОРА пакетов в живой фазе больше НЕ убивают сессию —
//   minecraft-protocol при них переподключает стрим и продолжает (пакет потерян, соединение
//   живо); смерть по-прежнему определяется по 'end'/'kicked'. Такие ошибки = сервер/BotFilter
//   шлёт пакеты, неизвестные протоколу configured-версии; (2) АВТООПРЕДЕЛЕНИЕ ВЕРСИИ при
//   старте: status-пинг через туннель (minecraft.autoVersion, по умолчанию вкл) — грязное
//   имя («BotFilter 1.8.x-26.x») распознаётся по номеру протокола (767=1.21.1 и т.д.),
//   при расхождении minecraft.version переключается на серверную; (3) статус-блок TG:
//   полный текст ошибки (100 симв.) + счётчик «⚠️ Ошибок разбора пакетов: N» пока сессия жива.
//
// ============ ЧТО ИЗМЕНЕНО В v5.1.0 (над v5.0.0) ============
// ЭКРАННЫЕ КНОПКИ: «🧩 Алгоритмы» и «👤 Личный заход» — reply-клавиатура Telegram,
//   постоянно ВНИЗУ ЭКРАНА (не привязана к сообщению в чате); действия разделов
//   (▶️ Запуск / 🔄 Смена ника / ⏹ Выключить / 🔀 Смена анархии) — под сообщениями.
// ТУННЕЛИ = ФИЗИЧЕСКИЕ КАНАЛЫ MOBILEPROXY (один канал = один случайный IP из пула,
//   смена через changeip API):
//   - АВТОСОЗДАНИЕ ПО УМОЛЧАНИЮ: нет секции "tunnels" → из "proxy" создаётся пара
//     «algo» (алгоритмы) + «personal» (личные заходы) на общем физканале;
//   - личный туннель РОВНО ОДИН (лишние personal понижаются до algo; если в "tunnels"
//     личного нет — выводится из первого); алгоритмических может быть НЕСКОЛЬКО;
//   - связанные логические туннели делят физканал: общий IP, общий мьютекс/лимит 30с
//     ротации, общие слоты (≤5 ЛЮБЫХ аккаунтов на канал), --proxy-check без дублей.
// АУДИТ/ФИКСЫ: соединение закрывается даже при стопе во время захода (не «висит» в игре);
//   date-фильтр призраков больше НЕ режет callback'и на старых сообщениях (кнопки работают
//   после рестарта); сводка CLI-пула не зависает, если ботов больше, чем слотов (печатается
//   через 20с после первого финиша, очередь видна в сводке); при недопустимой правке
//   статус-блока он пересоздаётся новым сообщением; релей сообщает о закрытом соединении.
// ИНТЕРФЕЙС: статус-блок — таймер сессии ⏱, попытка захода, подсказки по состоянию
//   (в HUB — список анархий и /anN; в анархии — как работает релей; после стопа — повтор);
//   панель личного захода — статус аккаунта, IP регистрации, свободные слоты; /help.
// ПРИВАТНОСТЬ (не палим данные владельца): в Telegram НЕ уходят — пароли аккаунтов
//   (везде ••••••), логины/пароли прокси, ключ Roboflow, токен бота, содержимое конфигов;
//   чужие chat_id игнорируются без ответов (whitelist); сообщения релея и /anN удаляются.
// ============ v5.0.0 (база этой сборки) ============
// ФИКС checkTimeoutInterval 60→60000мс («client timed out after 60 milliseconds»);
//   Telegram-пульт (статус-блоки 1️⃣ заход / 2️⃣ HUB / 3️⃣ анархия N, «написано аккаунтом»,
//   whitelist, offset-flush + date-фильтр, троттлинг правок 1.2с); релей ТГ→игра с
//   удалением сообщений; база аккаунтов learn/accounts_db.json (повторное использование,
//   /l-first, приоритет «тот же IP → тот же туннель → любой»); слоты ≤5 на канал
//   (приоритет algo > personal); анти-афк (swingArm + микро-look ~45с±15с); анархии
//   /anN по диапазонам (102-112; 202-234; 302-323; 502-514; 902-904, премиум не входит);
//   ускорение: settle 800→150мс при полных данных, ответ 400-900мс, IP при старте
//   держится (rotateOnStart=false, --rotate); headless-пул --bots/--rounds через сессии
//   (algo.anarchy); --tg-test диагностика транспортов.
// IP-ПРИВЯЗКА: точный IP у MobileProxy заказать НЕЛЬЗЯ (у changeip только proxy_key/format)
//   → IP туннеля держится, аккаунт запоминает IP регистрации → повторный заход с того же IP.
// ========================================================================

'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const http = require('http')
const https = require('https')
const tls = require('tls')
const net = require('net')     // свой SOCKS5-клиент: туннели, диагностика прокси, резервный хост
const dns = require('dns')

// mineflayer/socks нужны только для живого забега. Для --selftest — не нужны.
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
const strVal = name => { const v = argVal(name, ''); return (typeof v === 'string' && v !== '') ? v : '' }
const CLI = {
  selftest: ARGV.includes('--selftest'),
  // сколько заходов делает КАЖДЫЙ бот, пока не решит капчу (0 = из конфига, по умолчанию 5)
  rounds: Number(argVal('rounds', 0)) || 0,
  // сколько ботов запустить параллельно (0 = из конфига accounts.count, по умолчанию 1)
  bots: Number(argVal('bots', 0)) || 0,
  debug: ARGV.includes('--debug'),
  perms: ARGV.includes('--perms'),
  proxyCheck: ARGV.includes('--proxy-check') || ARGV.includes('--proxy'),
  // разовые проверки распознавателей (без подключения к MC)
  rfTest: ARGV.includes('--rf-test') || ARGV.includes('--roboflow-test'),
  rfTestFile: strVal('rf-test') || strVal('roboflow-test'),
  yoloTest: strVal('yolo-test'),
  // выйти сразу после успеха (не оставаться в игре)
  noHold: ARGV.includes('--no-hold'),
  // диагностика связи с Telegram (какой транспорт живой)
  tgTest: ARGV.includes('--tg-test'),
  // сменить IP туннелей при старте (по умолчанию IP ДЕРЖИТСЯ: solver.rotateOnStart=false)
  rotate: ARGV.includes('--rotate')
}

// ========================= КОНСТАНТЫ ЗАБЕГА =========================
const PAUSE_BETWEEN_MS = 2000   // пауза между заходами одного бота
const SETTLE_MS = 800           // добор данных после «готово»

const STABLE_MS = 1500            // поток map_data должен затихнуть на это время
const CAPTCHA_TIMEOUT_MS = 75000  // жёсткий лимит на подключение+сбор картинки
const CONNECT_TIMEOUT_MS = 35000
const LOGIN_TIMEOUT_MS = 30000
const MAX_ROTATIONS_ON_FAIL = 6   // сколько раз подряд крутить IP одному боту без успеха
const MIN_TILES_DEFAULT = 6       // минимум плиток, чтобы считать стену собранной
const MIN_TILES_FRACTION = 0.6    // или 60% от размера сетки
const VIEW_SIGN = 1

// ========================= ГЛОБАЛЬНЫЕ =========================
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []
let REC_ROOT = null
let CAP_ROOT = null
// каталог для rf_answers.jsonl (бесплатная разметка реальных капч ответами облака —
// пригодится, если позже будем обучать свою YOLO; локальной базы цифр больше нет)
let LEARN_DIR = process.env.LEARN_DIR ? path.resolve(process.env.LEARN_DIR) : path.join(__dirname, 'learn')

function logStamp() {
  if (!LOG_LOCAL_TIME) return new Date().toISOString().slice(11, 19)
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function step(s) {
  const l = logStamp() + ' [step] ' + s
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
  if (rf) {
    put('roboflow', 'enabled', /"enabled"\s*:\s*true/.test(rf))
    put('roboflow', 'apiKey', grabIn(rf, 'apiKey'))
    put('roboflow', 'modelId', grabIn(rf, 'modelId'))
    put('roboflow', 'host', grabIn(rf, 'host'))
    put('roboflow', 'field', grabIn(rf, 'field'))
    put('roboflow', 'confidence', grabNumIn(rf, 'confidence'))
    put('roboflow', 'overlap', grabNumIn(rf, 'overlap'))
    put('roboflow', 'timeoutMs', grabNumIn(rf, 'timeoutMs'))
    put('roboflow', 'digits', grabNumIn(rf, 'digits'))
    put('roboflow', 'askConf', grabNumIn(rf, 'askConf'))
    put('roboflow', 'autoLabel', /"autoLabel"\s*:\s*true/.test(rf))
    put('roboflow', 'useSocks', /"useSocks"\s*:\s*true/.test(rf))
  }
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
// ========================= КОНСТАНТЫ ИЗ КОНФИГА =========================
// СКОЛЬКО ЦИФР В КАПЧЕ. На funtime всегда ровно 5 — ни больше, ни меньше.
const DIGITS_EXPECTED = Math.max(0, Number(cfgGet(CFG, 'digits.expected', 5)) || 0)
// log.localTime=true — таймстампы в местном времени вместо UTC (по умолчанию UTC)
const LOG_LOCAL_TIME = cfgGet(CFG, 'log.localTime', false) === true

// перестановка колонок — аварийный режим (по умолчанию координаты авторитетны)
const TRY_COL_PERMS = CLI.perms === true || cfgGet(CFG, 'capture.tryColPerms', false) === true
// порог «швы плохие» — повод предупредить о возможной неверной раскладке
const SEAM_WARN = Number(cfgGet(CFG, 'capture.seamWarn', 40)) || 40

const CAP = {
  minTiles: Number(cfgGet(CFG, 'capture.minTiles', MIN_TILES_DEFAULT)) || MIN_TILES_DEFAULT,
  stableMs: Number(cfgGet(CFG, 'capture.stableMs', STABLE_MS)) || STABLE_MS,
  timeoutMs: Number(cfgGet(CFG, 'capture.timeoutMs', CAPTCHA_TIMEOUT_MS)) || CAPTCHA_TIMEOUT_MS,
  needPrompt: cfgGet(CFG, 'capture.needPrompt', false) === true,
  allowDirect: cfgGet(CFG, 'proxy.allowDirect', false) === true
}

// быстрый режим capture.fast=true: короче паузы ожидания данных (экономит ~1 с на заход)
const FAST = {
  stableMs: 600,          // вместо 1500 (ожидание «тишины» в потоке данных)
  settleMs: 200           // вместо 800  (добор после «готово»)
}
let FAST_MODE = cfgGet(CFG, 'capture.fast', false) === true

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

// ========================= ТУННЕЛИ (прокси-каналы со своим IP) =========================
// Туннель = независимый прокси-канал: свой хост/порт/логин, своя ссылка смены IP,
// свой запомненный живой хост (bproxy/mproxy), свой счётчик ошибок и своя ротация IP.
// Боты распределяются по туннелям round-robin; ротация IP сериализуется внутри туннеля
// (два бота не дёргают changeIp одного канала одновременно) и соблюдает лимит 30 с.
// Конфиг: "tunnels": [ {name,host,port,username,password,altHosts,changeIpUrl,...}, ... ]
// Если секции tunnels нет — один туннель строится из классической секции "proxy".
function makeTunnel(src, idx) {
  const host = String((src && src.host) || '').trim()
  if (!host) return null
  const alt = []
  if (Array.isArray(src.altHosts)) for (const h of src.altHosts) if (String(h || '').trim()) alt.push(String(h).trim())
  return {
    id: idx,
    name: String(src.name || ('tunnel' + (idx + 1))),
    role: tunnelRole(src),   // 'algo' (по умолчанию) | 'personal' (v5)
    cfg: {
      host,
      port: Number(src.port) || 1080,
      username: String(src.username || ''),
      password: String(src.password || ''),
      altHosts: alt,
      changeIpUrl: String(src.changeIpUrl || ''),
      waitSec: Number(src.waitAfterIpChangeSec) || 12
    },
    okHost: null,          // хост, через который реально удалось пройти
    state: 'unknown',      // unknown | alive | dead
    errs: [],              // последние ошибки туннеля
    ip: null,              // текущий внешний IP туннеля
    lastChangeAt: 0,       // лимит провайдера: 30 с между сменами IP
    lastLimited: false,
    rotating: null,        // промис текущей ротации (мьютекс)
    failStreak: 0,         // сетевые фейлы подряд (порог rotateOnNetFails)
    slots: { active: [], waiters: [] }   // v5: ≤maxAccountsPerTunnel одновременных аккаунтов
  }
}
// (v5.1) tunnelsFromConfig переехал в блок «ТУННЕЛИ v5.1» ниже: автосоздание пары
// algo+personal из "proxy", общий физканал (IP/ротация/слоты), личный туннель ровно один.
// Объявление функции всплывает сюда, поэтому TUNNELS = tunnelsFromConfig() выше работает.
const TUNNELS = tunnelsFromConfig()

// ========================= АККАУНТЫ (ники/пароли, мультибот) =========================
const ACCOUNTS = {
  count: Math.max(1, Number(CLI.bots || cfgGet(CFG, 'accounts.count', cfgGet(CFG, 'accounts.countDefault', 1))) || 1),
  nickPrefix: NICK_PREFIX,
  passwordLength: Math.max(6, Math.min(32, Number(cfgGet(CFG, 'accounts.passwordLength', 10)) || 10)),
  regTemplate: String(cfgGet(CFG, 'accounts.regTemplate', '/reg {pass}') || '/reg {pass}'),
  loginTemplate: String(cfgGet(CFG, 'accounts.loginTemplate', '/l {pass}') || '/l {pass}'),
  staggerMs: Math.max(0, Number(cfgGet(CFG, 'accounts.staggerMs', 2500)) || 0)
}

const NICK_USED = new Set()
function randomNick(prefix) {
  const p = String(prefix || ACCOUNTS.nickPrefix || 'Player').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 10) || 'Player'
  for (let i = 0; i < 500; i++) {
    const n = (p + Math.floor(Math.random() * 900000 + 100000)).slice(0, 16)
    if (!NICK_USED.has(n)) { NICK_USED.add(n); return n }
  }
  const n = (p + Date.now().toString(36)).slice(0, 16)
  NICK_USED.add(n)
  return n
}
const PASS_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function randomPass(len) {
  const n = Math.max(6, Math.min(32, Number(len) || ACCOUNTS.passwordLength || 10))
  let s = ''
  for (let i = 0; i < n; i++) s += PASS_CHARS[Math.floor(Math.random() * PASS_CHARS.length)]
  return s
}
// «/reg {pass}» + пароль → команда; если плейсхолдера нет — пароль дописывается через пробел
function buildAuthCommand(template, pass) {
  const t = String(template || '').trim()
  if (!t) return ''
  if (t.includes('{pass}')) return t.split('{pass}').join(pass)
  return t + ' ' + pass
}

// ========================= РЕШАТЕЛЬ (слова-маркеры и тайминги) =========================
function wordsCfg(key, dflt) {
  const v = cfgGet(CFG, 'solver.' + key, null)
  if (Array.isArray(v) && v.length) return v.map(x => String(x).toLowerCase()).filter(Boolean)
  return dflt
}
const SOLVER = {
  roundsPerBot: CLI.rounds > 0 ? CLI.rounds : (Math.max(1, Number(cfgGet(CFG, 'solver.roundsPerBot', 5)) || 5)),
  // сколько раз подряд ответить на капчу в рамках ОДНОГО захода (сервер обычно даёт 2-3 попытки)
  triesPerJoin: Math.max(1, Number(cfgGet(CFG, 'solver.triesPerJoin', 3)) || 3),
  answerDelayMin: Math.max(0, Number(cfgGet(CFG, 'solver.answerDelayMin', 400)) || 0),
  answerDelayRnd: Math.max(0, Number(cfgGet(CFG, 'solver.answerDelayRnd', 500)) || 0),
  verifyMs: Math.max(2000, Number(cfgGet(CFG, 'solver.verifyMs', 10000)) || 10000),
  regDelayMs: Math.max(0, Number(cfgGet(CFG, 'solver.regDelayMs', 1500)) || 0),
  regVerifyMs: Math.max(2000, Number(cfgGet(CFG, 'solver.regVerifyMs', 9000)) || 9000),
  stayOnline: CLI.noHold ? false : cfgGet(CFG, 'solver.stayOnline', true) !== false,
  holdMinutes: Math.max(0, Number(cfgGet(CFG, 'solver.holdMinutes', 0)) || 0),
  // таймаут ожидания реакции сервера: считать ли «тишину» успехом (по умолчанию нет)
  unknownIsSuccess: cfgGet(CFG, 'solver.unknownIsSuccess', false) === true,
  // особые случаи для смены IP туннеля
  rotateOnFailStreak: Math.max(1, Number(cfgGet(CFG, 'solver.rotateOnFailStreak', 2)) || 2),
  rotateOnNetFails: Math.max(1, Number(cfgGet(CFG, 'solver.rotateOnNetFails', 2)) || 2),
  // капча прошла / не прошла / зовёт регистрироваться
  successWords: wordsCfg('successWords', ['успешно', 'прошли капчу', 'прошел капчу', 'прошёл капчу', 'добро пожаловать', 'верификац', 'подтвержд', 'captcha solved', 'captcha accepted']),
  failWords: wordsCfg('failWords', ['неверно', 'не верно', 'неправиль', 'не совпад', 'ошибк', 'попробуй', 'попробуйте', 'wrong', 'incorrect', 'неудач']),
  authWords: wordsCfg('authWords', ['зарегистр', 'авториз', '/reg', '/l ', '/login', '/register', 'войдите', 'вход на сервер']),
  regOkWords: wordsCfg('regOkWords', ['успешно зарегистрир', 'регистрация заверш', 'регистрация успеш', 'успешно заверш', 'вы зарегистрир', 'авторизован', 'успешный вход', 'вы вошли', 'successfully registered', 'successfully authenticated', 'успешно авториз']),
  regExistsWords: wordsCfg('regExistsWords', ['уже зарегистрирован', 'уже зарег', 'вы уже', 'already registered', 'is already', 'авторизуйтесь', 'введите /l', 'используйте /l', '/l <пароль>']),
  regFailWords: wordsCfg('regFailWords', ['неверный пароль', 'ошибка регистрации', 'неверно', 'не правильный', 'коротк', 'слишком', 'не удалось', 'invalid', 'error', 'incorrect']),
  // слова в причине кика, при которых IP туннеля надо срочно менять
  banWords: wordsCfg('banWords', ['ban', 'бан', 'забанен', 'blocked', 'заблок', 'blacklist', 'чёрный список', 'черный список', 'timed out', 'переподключ']),
  newCaptchaWords: wordsCfg('newCaptchaWords', ['новую капчу', 'новый код', 'обновил', 'ещё раз', 'еще раз', 'заново', 'повтор'])
}
// регистронезависимый поиск любого из слов
function matchAny(text, words) {
  const s = String(text || '').toLowerCase()
  if (!s) return false
  for (const w of (words || [])) if (w && s.indexOf(w) >= 0) return w
  return false
}

// резервный SOCKS-транспорт для облака Roboflow (roboflow.socksUrl; если пусто —
// пробуем старый ключ telegram.apiProxy из прежних конфигов)
const RF_SOCKS_URL = String(cfgGet(CFG, 'roboflow.socksUrl', '') || cfgGet(CFG, 'telegram.apiProxy', '') || '')

// ========================= ТУННЕЛИ v5.1: ФИЗКАНАЛЫ, РОЛИ, АВТОСОЗДАНИЕ =========================
// Туннель (глазами пользователя) = схема-прокси MobileProxy, у которой IP меняется через
// changeip API на случайный из пула. Один купленный прокси = ОДИН физический канал (один IP
// на всех, кто через него идёт). Логических туннелей на одном канале может быть несколько
// (например «algo» + «personal») — тогда у них ОБЩИЕ: IP, смена IP (мьютекс + лимит 30с),
// живой хост, ошибки и СЛОТЫ (≤maxAccountsPerTunnel ЛЮБЫХ аккаунтов на физический канал).
// Несколько независимых каналов = несколько разных прокси в "tunnels".
//
// АВТОСОЗДАНИЕ ПО УМОЛЧАНИЮ: если секции "tunnels" нет — из секции "proxy" создаётся пара:
// «algo» (для алгоритмов, может быть несколько при явной настройке) + «personal» (РОВНО ОДИН,
// для личных заходов). Если "tunnels" заданы, но личного среди них нет — он выводится из
// первого (общий физканал). Лишние «personal»понижаются до algo: личный туннель только один.
function physKey(T) {
  const c = (T && T.cfg) || {}
  return [String(c.host || '').toLowerCase(), Number(c.port) || 0, String(c.username || ''), String(c.password || ''), String(c.changeIpUrl || '')].join('|')
}
// привязать логический туннель T к физическому каналу P (общее состояние через геттеры)
function linkToPhysical(T, P) {
  if (!T || !P || T === P) return
  for (const k of ['okHost', 'state', 'errs', 'ip', 'lastChangeAt', 'lastLimited', 'rotating', 'failStreak']) {
    try { Object.defineProperty(T, k, { get: () => P[k], set: v => { P[k] = v }, configurable: true, enumerable: true }) } catch (e) {}
  }
  T.physical = P
  T.slots = P.slots          // общая очередь слотов: ≤5 ЛЮБЫХ аккаунтов на физический канал
}
// сгруппировать логические туннели по физическим каналам
function dedupePhysical(list) {
  const seen = new Map()
  for (const T of list) {
    const k = physKey(T)
    if (seen.has(k)) linkToPhysical(T, seen.get(k))
    else { T.physical = T; seen.set(k, T) }
  }
  return list
}
// личный туннель ТОЛЬКО ОДИН: первый остаётся personal, остальные понижаются до algo
function enforceSinglePersonal(list, notes) {
  let kept = null
  for (const T of list) {
    if (T.role !== 'personal') continue
    if (!kept) { kept = T; continue }
    T.role = 'algo'
    if (notes) notes.push('туннель «' + T.name + '»: role=personal встречается больше одного раза — личный туннель только ОДИН (оставлен «' + kept.name + '»), этот переведён в algo')
  }
  return list
}
// Построение списка туннелей (функция объявлена здесь, но всплывает до вызова на уровне модуля)
function tunnelsFromConfig(quiet) {
  const out = []
  const notes = quiet ? null : (out.notes = [])
  const list = cfgGet(CFG, 'tunnels', null)
  if (Array.isArray(list) && list.length) {
    list.forEach((t, i) => { const x = makeTunnel(t || {}, i); if (x) out.push(x) })
    // «tunnels» заданы, но личного нет — выводим из первого (общий физический канал)
    if (out.length && !out.some(t => t.role === 'personal')) {
      const base = out[0]
      const p = makeTunnel({
        name: base.name + '-personal', host: base.cfg.host, port: base.cfg.port,
        username: base.cfg.username, password: base.cfg.password, altHosts: base.cfg.altHosts,
        changeIpUrl: base.cfg.changeIpUrl, waitAfterIpChangeSec: base.cfg.waitSec, role: 'personal'
      }, out.length)
      if (p) {
        out.push(p)
        if (notes) notes.push('в "tunnels" нет туннеля с role=personal — автосоздан «' + p.name + '» (один физический канал с «' + base.name + '»: общие IP/ротация/слоты). Для ОТДЕЛЬНОГО личного IP добавьте второй прокси в "tunnels"')
      }
    }
  }
  if (!out.length && PROXY.host) {
    // ПО УМОЛЧАНИЮ: один физический канал из "proxy" → логические «algo» + «personal»
    const base = {
      host: PROXY.host, port: PROXY.port, username: PROXY.username, password: PROXY.password,
      altHosts: cfgGet(CFG, 'proxy.altHosts', []) || [], changeIpUrl: PROXY.changeIpUrl,
      waitAfterIpChangeSec: PROXY.waitSec
    }
    const algo = makeTunnel(Object.assign({ name: 'algo', role: 'algo' }, base), 0)
    const pers = makeTunnel(Object.assign({ name: 'personal', role: 'personal' }, base), 1)
    if (algo) out.push(algo)
    if (pers) out.push(pers)
    if (notes && algo && pers) notes.push('нет секции "tunnels" — созданы туннели по умолчанию: «algo» (алгоритмы) + «personal» (личные заходы, ровно 1) на ОДНОМ физическом канале из "proxy" (общий IP, общая ротация, общие слоты ≤' + (Number(cfgGet(CFG, 'solver.maxAccountsPerTunnel', 5)) || 5) + '). Несколько независимых IP = несколько прокси в "tunnels"')
  }
  enforceSinglePersonal(out, notes)
  dedupePhysical(out)
  return out
}
function distinctPhysical(list) {
  const seen = new Set(), out = []
  for (const T of (list || [])) { const P = T.physical || T; if (!seen.has(P)) { seen.add(P); out.push(T) } }
  return out
}

// ========================= КОНФИГ v5: TG-ПУЛЬТ, СЛОТЫ, АНАРХИИ, АНТИ-АФК =========================
// дополнения SOLVER (v5)
SOLVER.rotateOnStart = CLI.rotate ? true : cfgGet(CFG, 'solver.rotateOnStart', false) === true
SOLVER.maxAccountsPerTunnel = Math.max(1, Number(cfgGet(CFG, 'solver.maxAccountsPerTunnel', 5)) || 5)
SOLVER.regNotRegWords = wordsCfg('regNotRegWords', ['не зарегистрирован', 'незарегистрирован', 'вы не зарег', 'сначала зарегистрир', 'not registered', 'register first'])

// ---- Telegram-пульт ----
const TG_CFG = {
  enabled: cfgGet(CFG, 'telegram.enabled', true) !== false,
  token: String(cfgGet(CFG, 'telegram.token', '') || ''),
  // apiUrl меняется только в selftest (мок на 127.0.0.1) — не выносить в конфиг-документацию
  apiUrl: String(cfgGet(CFG, 'telegram.apiUrl', 'https://api.telegram.org') || 'https://api.telegram.org'),
  socksUrl: String(cfgGet(CFG, 'telegram.apiProxy', '') || ''),
  preferSocks: cfgGet(CFG, 'telegram.preferSocks', true) !== false,
  useMcProxy: cfgGet(CFG, 'telegram.useMcProxy', true) !== false,
  pollTimeoutSec: Math.max(3, Math.min(50, Number(cfgGet(CFG, 'telegram.pollTimeoutSec', 25)) || 25)),
  timeoutMs: 35000,
  // whitelist: кому разрешено управлять. Одиночный telegram.chatId принимается как наследие v3.
  allowedChatIds: (() => {
    const v = cfgGet(CFG, 'telegram.allowedChatIds', null)
    const out = []
    if (Array.isArray(v)) for (const x of v) { const n = Number(x); if (Number.isFinite(n)) out.push(n) }
    else if (v !== null && v !== undefined && v !== '') { const n = Number(v); if (Number.isFinite(n)) out.push(n) }
    else { const c = cfgGet(CFG, 'telegram.chatId', null); const n = Number(c); if (c !== null && Number.isFinite(n)) out.push(n) }
    return out
  })()
}
TG_CFG.ready = !!(TG_CFG.enabled && TG_CFG.token)
function tgAllowed(chatId) {
  if (!TG_CFG.allowedChatIds.length) return false      // пустой whitelist = никому (защита)
  return TG_CFG.allowedChatIds.indexOf(Number(chatId)) >= 0
}

// ---- Анти-афк (свой модуль: в mineflayer 4.25.0 встроенного нет) ----
const ANTI_AFK = {
  enabled: cfgGet(CFG, 'antiAfk.enabled', true) !== false,
  everyMs: Math.max(10000, Number(cfgGet(CFG, 'antiAfk.everyMs', 45000)) || 45000),
  jitterMs: Math.max(0, Number(cfgGet(CFG, 'antiAfk.jitterMs', 15000)) || 0)
}

// ---- Анархии: диапазоны (премиальные НЕ входят), парсер ТОЛЬКО /anN ----
const ANARCHY = {
  ranges: (() => {
    const v = cfgGet(CFG, 'anarchy.ranges', null)
    const def = [[102, 112], [202, 234], [302, 323], [502, 514], [902, 904]]
    if (!Array.isArray(v) || !v.length) return def
    const out = []
    for (const r of v) {
      if (Array.isArray(r) && r.length === 2 && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1]))) {
        const a = Math.min(Number(r[0]), Number(r[1])), b = Math.max(Number(r[0]), Number(r[1]))
        out.push([a, b])
      }
    }
    return out.length ? out : def
  })(),
  allowAny: cfgGet(CFG, 'anarchy.allowAny', false) === true
}
// номер анархии валиден, если попадает в диапазоны (или allowAny)
function anarchyOk(n) {
  n = Number(n)
  if (!Number.isFinite(n) || n <= 0) return false
  if (ANARCHY.allowAny) return true
  for (const r of ANARCHY.ranges) if (n >= r[0] && n <= r[1]) return true
  return false
}
// принимаем ТОЛЬКО команду вида /anN («304» без /an — это текст для релея, не смена)
function parseAnarchyCmd(text) {
  const m = String(text || '').trim().match(/^\/an(\d{1,5})$/i)
  if (!m) return null
  const n = Number(m[1])
  return anarchyOk(n) ? n : null
}
function anarchyListText() {
  return ANARCHY.ranges.map(r => r[0] + '-' + r[1]).join('; ')
}

// ---- headless-пул: анархия для CLI-забега (null = остаться в HUB) ----
const ALGO = {
  anarchy: (() => {
    const v = cfgGet(CFG, 'algo.anarchy', null)
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    if (!anarchyOk(n)) return null
    return n
  })()
}

// ---- база аккаунтов ----
const ACCOUNTS_DB_PATH = process.env.ACCOUNTS_DB ? path.resolve(process.env.ACCOUNTS_DB) : path.join(LEARN_DIR, 'accounts_db.json')

// ---- роли туннелей и ёмкость слотов ----
// role: 'algo' (общий пул/алгоритмы, по умолчанию) | 'personal' (только личные ручные заходы)
function tunnelRole(src) { return String((src && src.role) || 'algo').toLowerCase() === 'personal' ? 'personal' : 'algo' }
function personalTunnels() { return TUNNELS.filter(t => t.role === 'personal') }
function algoTunnels() { return TUNNELS.filter(t => t.role !== 'personal') }
// очередь слотов: algo (приоритет 0) проходит раньше personal (приоритет 1).
// Слоты живут на ФИЗИЧЕСКОМ канале (у связанных туннелей T.slots === P.slots) —
// ≤maxAccountsPerTunnel ЛЮБЫХ аккаунтов на один реальный прокси/IP.
const SLOT_PRIORITY = { algo: 0, personal: 1 }
function acquireSlot(T, kind, holder) {
  kind = SLOT_PRIORITY[kind] !== undefined ? kind : 'algo'
  if (!T) return Promise.resolve(true)                    // direct-режим: слотов нет
  return new Promise(resolve => {
    const max = SOLVER.maxAccountsPerTunnel
    if (T.slots.active.length < max) { T.slots.active.push(kind); resolve(true); return }
    const w = { kind, resolve, at: Date.now(), holder: holder || null }
    if (holder) holder.slotWaiter = w
    T.slots.waiters.push(w)
    T.slots.waiters.sort((a, b) => (SLOT_PRIORITY[a.kind] - SLOT_PRIORITY[b.kind]) || (a.at - b.at))
  })
}
function releaseSlot(T, kind, holder) {
  if (!T) return
  const i = T.slots.active.lastIndexOf(kind)
  if (i >= 0) T.slots.active.splice(i, 1)
  if (holder) holder.slotWaiter = null
  const w = T.slots.waiters.shift()                        // уже отсортированы по приоритету
  if (w) { T.slots.active.push(w.kind); if (w.holder) w.holder.slotWaiter = null; try { w.resolve(true) } catch (e) {} }
}
function slotsUsed(T) { return T ? T.slots.active.length : 0 }
function slotsFree(T) { return T ? Math.max(0, SOLVER.maxAccountsPerTunnel - T.slots.active.length) : 0 }

// ========================= YOLO API (распознавание капчи FunTime) =========================
// v3.14.0: основной распознаватель — ХОСТ-МОДЕЛЬ ROBOFLOW (см. блок ROBOFLOW ниже).
// Здесь остались запасные локальные серверы на случай, если облако недоступно.
// Источники: github.com/mmeerrkkaa/funtime-captcha-verifed (lib/localOCR.js) и
// тред yougame.biz/threads/368895 (YOLO12n, ~91% на FunTime).
// Контракт: POST multipart/form-data, поле "image" (PNG) ->
//   { "success": true, "answer": "12345" }   (публичный сервер /recognize)
//   { "result": "12345" }                    (Flask-бэк из треда, /solve)
// Своя модель (91%): python yolo_server.py -> http://localhost:5000/recognize
// v3.14.0: 212.22.70.39:5000 УБРАН — сервер мёртв (ECONNREFUSED и в песочнице, и в логах
// пользователя), а попытка подключения съедала ~4 секунды каждого раунда.
const YOLO_DEFAULT_URLS = [
  'http://127.0.0.1:5000/recognize'        // свой локальный сервер (если запущен)
]
function yoloUrls() {
  const out = []
  const one = String(cfgGet(CFG, 'yolo.url', '') || '').trim()
  if (one && /^https?:\/\//i.test(one)) out.push(one)
  const list = cfgGet(CFG, 'yolo.urls', null)
  if (Array.isArray(list)) for (const u of list) if (typeof u === 'string' && /^https?:\/\//i.test(u)) out.push(u.trim())
  for (const u of YOLO_DEFAULT_URLS) if (out.indexOf(u) < 0) out.push(u)
  return out
}
const YOLO = {
  enabled: cfgGet(CFG, 'yolo.enabled', true) !== false,
  urls: yoloUrls(),
  field: String(cfgGet(CFG, 'yolo.field', 'image') || 'image'),
  timeoutMs: Math.max(2000, Number(cfgGet(CFG, 'yolo.timeoutMs', 9000)) || 9000),
  autoLabel: cfgGet(CFG, 'yolo.autoLabel', false) === true,
  // сколько цифр ждём от API: из config, иначе DIGITS_EXPECTED (5 для funtime)
  digitsCfg: Number(cfgGet(CFG, 'yolo.digits', 0)) || 0
}
const yoloWantDigits = () => YOLO.digitsCfg || DIGITS_EXPECTED || 5
// ========================= ROBOFLOW: хост-модель YOLOv12 (captcha-funtime/2) =========================
// Как это работает (проверено живьём 2026-10-20):
//   POST https://serverless.roboflow.com/<modelId>?api_key=<ключ>&confidence=<0..100>&overlap=<0..100>
//   тело: multipart/form-data, ОДНО файловое поле с именем "file" (именно "file" — при "image"
//         сервер отвечает 400 «Expected image to be send in part named 'file'»);
//   ответ: { image:{width,height}, predictions:[{x,y,width,height,confidence,class,class_id}], ... }
//         x,y — ЦЕНТР рамки, координаты в пикселях ПРИСЛАННОЙ картинки (не 640×640).
// Точность на 12 реальных капчах FunTime с независимой разметкой: 12/12 = 100%.
const RF_DEFAULT_MODEL = 'captcha-funtime/2'
const RF_DEFAULT_HOST = 'serverless.roboflow.com'
function rfMaskKey(k) { const s = String(k || ''); return s ? (s.slice(0, 4) + '…(' + s.length + ' симв.)') : '(нет)' }
function rfCfg() {
  const key = String(cfgGet(CFG, 'roboflow.apiKey', '') || '').trim()
  const model = String(cfgGet(CFG, 'roboflow.modelId', RF_DEFAULT_MODEL) || RF_DEFAULT_MODEL).trim().replace(/^\/+|\/+$/g, '')
  // confidence/overlap в конфиге лежат в процентах (как в веб-интерфейсе Roboflow): 25 -> 0.25
  const pc = v => { const n = Number(v); if (!isFinite(n)) return null; return n > 1 ? n / 100 : n }
  const clamp = (v, a, b, d) => (v === null || v === undefined ? d : Math.max(a, Math.min(b, v)))
  const conf = clamp(pc(cfgGet(CFG, 'roboflow.confidence', 25)), 0.01, 0.95, 0.25)
  const overlap = clamp(pc(cfgGet(CFG, 'roboflow.overlap', 20)), 0.05, 0.9, 0.2)
  return {
    enabled: cfgGet(CFG, 'roboflow.enabled', !!key) !== false,
    apiKey: key,
    model: model,
    host: String(cfgGet(CFG, 'roboflow.host', RF_DEFAULT_HOST) || RF_DEFAULT_HOST).replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
    field: String(cfgGet(CFG, 'roboflow.field', 'file') || 'file'),
    conf, overlap,
    timeoutMs: Math.max(5000, Number(cfgGet(CFG, 'roboflow.timeoutMs', 20000)) || 20000),
    digits: Number(cfgGet(CFG, 'roboflow.digits', 0)) || 0,
    // просить у сервера НИЗКИЙ порог, а отбор делать здесь: так мы сами подбираем
    // порог, при котором получается ровно N цифр (см. rfBoxesToDigits)
    askConf: Math.max(1, Math.round(100 * clamp(pc(cfgGet(CFG, 'roboflow.askConf', 10)), 0.01, 0.2, 0.1))),
    // сколько раз повторить запрос при временных сбоях (Cloudflare 403/429/5xx/обрыв)
    retries: Math.max(1, Math.min(6, Number(cfgGet(CFG, 'roboflow.retries', 3)) || 3)),
    // минимальная пауза между запросами в облако: Cloudflare блокирует СЕРИИ запросов,
    // а не сами запросы (замер: 12 подряд -> 2 блока 403 HTML). Бот шлёт 1 картинку за раунд,
    // так что в бою пауза почти никогда не срабатывает — она защищает тесты и догоняющие раунды.
    paceMs: Math.max(0, Math.min(10000, Number(cfgGet(CFG, 'roboflow.paceMs', 1200)) || 0)),
    // запасной транспорт: SOCKS-прокси (roboflow.socksUrl), если прямой доступ к облаку закрыт
    useSocks: cfgGet(CFG, 'roboflow.useSocks', true) !== false
  }
}
const RF = rfCfg()
RF.ready = !!(RF.enabled && RF.apiKey && RF.model && !/YOUR_|CHANGE_ME|XXXX/i.test(RF.apiKey))
RF.calls = 0            // сколько картинок ушло в облако (инференс = кредиты Roboflow)
RF.lastCallAt = 0       // для темпа запросов (roboflow.paceMs)
RF.fails = 0            // ошибки подряд
RF.lastError = ''
RF.disabledReason = ''  // если облако отключено насовсем (например, 401 — неверный ключ)
const RF_MAX_FAILS = 8

// полный URL запроса (ключ — в query, как требует Roboflow; в логи НЕ печатаем)
function rfUrl(askConf) {
  const c = Number.isFinite(askConf) ? askConf : RF.askConf
  return 'https://' + RF.host + '/' + RF.model + '?api_key=' + encodeURIComponent(RF.apiKey) +
    '&confidence=' + c + '&overlap=' + Math.round(RF.overlap * 100)
}
function rfIoU(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  const inter = ix * iy
  const uni = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
  return uni > 0 ? inter / uni : 0
}
// горизонтальное перекрытие (доля от меньшей ширины): одна и та же цифра часто даёт
// две рамки с разным IoU, но почти совпадающие по x
function rfXov(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const mw = Math.min(a.x2 - a.x1, b.x2 - b.x1)
  return mw > 0 ? ix / mw : 0
}
// жадный отбор: самые уверенные рамки, дубли (IoU > overlap или x-перекрытие > 0.6) гасятся
function rfSelect(boxes, want, overlap) {
  const kept = []
  for (const b of boxes.slice().sort((p, q) => q.conf - p.conf)) {
    if (kept.some(k => rfIoU(k, b) > overlap || rfXov(k, b) > 0.6)) continue
    kept.push(b)
    if (want > 0 && kept.length >= want) break
  }
  return kept.sort((p, q) => p.cx - q.cx)   // порядок цифр — слева направо
}
// predictions -> строка цифр. Порог уверенности ПОДБИРАЕТСЯ: первым берётся вариант,
// где получилось ровно want цифр (иначе на капче с шумом ответ «уезжает»).
function rfBoxesToDigits(preds, opts) {
  const o = opts || {}
  const want = Number(o.want) || 0
  const overlap = o.overlap != null ? o.overlap : RF.overlap
  const boxes = (Array.isArray(preds) ? preds : []).filter(p => p && isFinite(p.x) && isFinite(p.y)).map(p => {
    const w = Math.max(1, Number(p.width) || 1), h = Math.max(1, Number(p.height) || 1)
    const cx = Number(p.x), cy = Number(p.y)
    const cls = String(p.class !== undefined && p.class !== null && p.class !== '' ? p.class : (p.class_id !== undefined ? p.class_id : ''))
    return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, cx, cy, w, h, conf: Number(p.confidence) || 0, cls }
  }).filter(b => /^[0-9]$/.test(b.cls))     // классы-не-цифры игнорируем
  const confs = Array.isArray(o.confs) && o.confs.length ? o.confs : [0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05]
  for (const c of confs) {
    const sel = rfSelect(boxes.filter(b => b.conf >= c), want, overlap)
    if (!want || sel.length === want) return { digits: sel.map(b => b.cls).join(''), boxes: sel, conf: c, rawBoxes: boxes.length, exact: !want || sel.length === want }
  }
  const mc = o.minConf != null ? o.minConf : RF.conf
  const sel = rfSelect(boxes.filter(b => b.conf >= mc), want, overlap)
  return { digits: sel.map(b => b.cls).join(''), boxes: sel, conf: mc, rawBoxes: boxes.length, exact: !want || sel.length === want, incomplete: true }
}
function rfReset() { RF.fails = 0; RF.lastError = ''; RF.disabledReason = '' }

// ответ Cloudflare (HTML) — это НЕ отказ ключа, а временная блокировка/лимит: надо повторить
function rfIsHtml(t) {
  const s = String(t || '').trim()
  return /^</.test(s) || /<html|<!doctype|cloudflare/i.test(s.slice(0, 400))
}
// Ответ Cloudflare (HTML-страница, чаще 403) — это НЕ «плохой ключ», а временный блок
// на частые запросы. Настоящий отказ ключа приходит JSON'ом: {"status":401,"message":
// "Unauthorized api_key. This key is not authorized for serverless inference."}
// Различаем их, иначе один случайный блок навсегда выключил бы облако на всю сессию.
function rfIsHtml(t) { return /^\s*<(!doctype|html)/i.test(String(t || '').slice(0, 300)) }
function rfHint(status, text) {
  const s = String(text || '')
  if (rfIsHtml(s)) return 'Cloudflare вернул HTML вместо JSON (HTTP ' + status + ') — временный блок частых запросов'
  if (status === 401 || status === 403) return 'ключ отклонён (' + status + '): ' + (s.slice(0, 140) || 'проверьте roboflow.apiKey — app.roboflow.com → Settings → API key (Private API Key)')
  if (status === 402) return 'кончились кредиты Roboflow (402): бесплатный лимит исчерпан, нужен другой ключ/тариф'
  if (status === 404) return 'модель не найдена (404): roboflow.modelId должен быть вида «' + RF_DEFAULT_MODEL + '» (workspace/model/version)'
  if (status === 413) return 'картинка слишком большая (413)'
  if (status === 429) return 'слишком много запросов (429) — облако тормозит нас, пауза и повтор'
  if (status === 400) return 'сервер не принял запрос (400): ' + (/part named 'file'/.test(s) ? 'поле должно называться "file" (roboflow.field)' : s.slice(0, 120))
  if (status >= 500) return 'сбой на стороне Roboflow (' + status + ')'
  return s.slice(0, 160) || ('HTTP ' + status)
}
// фатально = повторять бессмысленно, пока не поправишь конфиг
function rfFatal(status, text) {
  if (rfIsHtml(text)) return false
  if (status === 404 || status === 402 || status === 413) return true
  if (status === 401 || status === 403) return /api_key|unauthoriz|not authorized|invalid|forbidden/i.test(String(text))
  return false
}

// основной вызов облака. Возвращает тот же формат, что yoloRecognize (+ boxes/provider),
// либо null, если облако не ответило — тогда yoloRecognize пойдёт по запасным серверам.
async function rfRecognize(png, label, fileOpts) {
  if (!RF.ready || RF.disabledReason) return null
  if (RF.fails >= RF_MAX_FAILS) {
    if (RF.fails === RF_MAX_FAILS) { yoloLog('⚠️ Roboflow: ' + RF_MAX_FAILS + ' ошибок подряд — облако в этой сессии больше не дёргаю'); RF.fails++ }
    return null
  }
  if (!png || !png.length) return null
  const want = RF.digits || yoloWantDigits()
  const fo = fileOpts || { name: 'captcha.png', type: 'image/png' }
  const mp = multipart({}, { field: RF.field, name: fo.name, type: fo.type, data: png })
  let u
  try { u = new URL(rfUrl()) } catch (e) { RF.lastError = 'не собрался URL: ' + e.message; return null }
  // транспорты: сначала напрямую, потом (если разрешено) через SOCKS-прокси roboflow.socksUrl
  const socks = RF.useSocks ? parseSocksUrl(RF_SOCKS_URL) : null
  const routes = [{ name: 'direct', socks: null }]
  if (socks) routes.push({ name: 'socks(' + socks.host + ')', socks })
  let lastErr = '', lastStatus = 0, waitNext = 0
  for (let attempt = 1; attempt <= RF.retries; attempt++) {
    // темп: Cloudflare блокирует серии запросов чаще, чем сами запросы
    if (RF.paceMs > 0) {
      const since = Date.now() - RF.lastCallAt
      if (RF.lastCallAt && since < RF.paceMs) await sleep(RF.paceMs - since)
    }
    for (const route of routes) {
      RF.lastCallAt = Date.now()
      const t0 = RF.lastCallAt
      const r = await httpsRequest({
        // порт берём из URL: roboflow.host можно задать как «example.com:8443» (по умолчанию 443)
        host: u.hostname, port: Number(u.port || 443), path: u.pathname + u.search, method: 'POST', secure: true,
        headers: { 'Content-Type': mp.contentType, 'Accept': 'application/json', 'User-Agent': 'mc-captcha/3.14' },
        body: mp.body, timeoutMs: RF.timeoutMs, socks: route.socks || undefined
      })
      const ms = Date.now() - t0
      RF.calls++
      if (!r.ok) { lastErr = route.name + ': ' + (r.error || 'нет ответа'); waitNext = 700 * attempt; dbg('[RF] ' + lastErr); continue }
      lastStatus = r.status
      const body = r.body ? r.body.toString('utf8') : ''
      if (r.status === 200) {
        let j = null
        try { j = JSON.parse(body) } catch (e) {}
        if (!j || !Array.isArray(j.predictions)) { lastErr = 'ответ без predictions: ' + body.slice(0, 120); waitNext = 700 * attempt; dbg('[RF] ' + lastErr); continue }
        const out = rfBoxesToDigits(j.predictions, { want, overlap: RF.overlap })
        RF.fails = 0; RF.lastError = ''
        const img = j.image || {}
        yoloLog((label || '') + ' ☁️ Roboflow ' + RF.model + ' -> «' + (out.digits || '—') + '»' +
          (out.exact ? '' : ' ⚠️ цифр ' + out.digits.length + ' вместо ' + want) +
          ' рамок=' + (out.boxes || []).length + '/' + out.rawBoxes + ' порог=' + out.conf +
          ' img=' + (img.width || '?') + '×' + (img.height || '?') + ' за ' + ms + 'мс (' + route.name +
          (attempt > 1 ? ', попытка ' + attempt : '') + ', всего в облако ушло ' + RF.calls + ' картинок)')
        return {
          digits: out.digits, exact: !!out.exact, boxes: out.boxes, conf: out.conf,
          url: 'https://' + RF.host + '/' + RF.model, host: 'roboflow:' + RF.model,
          field: RF.field, ms, status: 200, provider: 'roboflow', model: RF.model,
          imgW: img.width || 0, imgH: img.height || 0, inferenceId: j.inference_id || ''
        }
      }
      if (rfFatal(r.status, body)) {
        RF.disabledReason = rfHint(r.status, body)
        yoloLog((label || '') + ' ❌ Roboflow: ' + RF.disabledReason + ' — облако отключено до перезапуска (дальше пойдут запасные серверы)')
        return null
      }
      lastErr = rfHint(r.status, body)
      // блок Cloudflare/лимит запросов держится секунды — ждём дольше, чем при обрыве связи
      waitNext = (r.status === 429 || rfIsHtml(body)) ? Math.max(2000, 2000 * attempt) : 700 * attempt
      dbg('[RF] ' + route.name + ' HTTP ' + r.status + ': ' + lastErr)
    }
    if (attempt < RF.retries) { dbg('[RF] временная ошибка, повтор через ' + waitNext + 'мс'); await sleep(waitNext) }
  }
  RF.fails++
  RF.lastError = lastErr || ('HTTP ' + lastStatus) || 'нет соединения'
  yoloLog((label || '') + ' Roboflow не ответил после ' + RF.retries + ' попыток: ' + RF.lastError + ' (ошибок подряд ' + RF.fails + ')')
  return null
}

let yoloAlive = null      // запомненный рабочий url
let yoloFails = 0
const yoloUrlFails = {}   // сколько раз каждый url не ответил (чтобы не ждать таймаут заново)
const YOLO_MAX_FAILS = 6  // после серии ошибок перестаём дёргать API (экономим время раунда)

function yoloLog(m) {
  step('[YOLO] ' + m)
  // дублируем в records/yolo.log — иначе в логе не видно, отвечал ли API
  try { if (REC_ROOT) { fs.mkdirSync(REC_ROOT, { recursive: true }); fs.appendFileSync(path.join(REC_ROOT, 'yolo.log'), logStamp() + ' [YOLO] ' + m + '\n') } } catch (e) {}
}
// сброс запомненного рабочего эндпоинта и счётчика ошибок (для тестов и команды /yolo)
function yoloReset() { yoloAlive = null; yoloFails = 0; for (const k of Object.keys(yoloUrlFails)) delete yoloUrlFails[k] }

function multipart(fields, file) {
  const b = '----mc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  const parts = []
  for (const k of Object.keys(fields || {})) {
    if (fields[k] === undefined || fields[k] === null) continue
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + String(fields[k]) + '\r\n'))
  }
  if (file) {
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + file.field + '"; filename="' + file.name + '"\r\nContent-Type: ' + (file.type || 'application/octet-stream') + '\r\n\r\n'))
    parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from('--' + b + '--\r\n'))
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + b }
}

// разбор ответа: поддерживаем все известные формы
function parseYoloAnswer(text) {
  const s = String(text || '')
  if (/^\s*</.test(s) || /<\/?html|<body|<!doctype/i.test(s.slice(0, 500))) return { digits: '', rejected: true, raw: 'HTML вместо JSON: ' + s.slice(0, 120) }
  let j = null
  try { j = JSON.parse(s) } catch (e) {}
  let raw = ''
  if (j && typeof j === 'object') {
    if (j.success === false) return { digits: '', rejected: true, raw: s.slice(0, 200) }
    const d = j.data && typeof j.data === 'object' ? j.data : {}
    const cand = [j.answer, j.result, j.text, j.digits, j.captcha, j.code, d.answer, d.result, d.text, d.digits]
    for (const c of cand) if (c !== undefined && c !== null && String(c).trim()) { raw = String(c); break }
    if (!raw && Array.isArray(j.boxes)) raw = j.boxes.map(b => b && (b.class !== undefined ? b.class : b.label)).join('')
  }
  if (!raw) raw = s
  return { digits: raw.replace(/[^0-9]/g, ''), rejected: false, raw: s.slice(0, 200) }
}

async function yoloRecognize(png, label) {
  if (!YOLO.enabled || !png || !png.length) return null
  // v3.14.0: ПЕРВЫМ идёт хост-модель Roboflow (100% на контрольных 12 капчах).
  // Если облако не ответило/не настроено — падаем на локальные YOLO-серверы ниже.
  if (RF.ready) {
    const rr = await rfRecognize(png, label)
    if (rr && rr.digits && rr.digits.length >= 3) return rr
    if (rr) dbg('[YOLO] Roboflow дал ' + (rr.digits || 0) + ' цифр — пробую запасные серверы')
  }
  if (yoloFails >= YOLO_MAX_FAILS) {
    if (yoloFails === YOLO_MAX_FAILS) { yoloLog('⚠️ ' + YOLO_MAX_FAILS + ' ошибок подряд — API больше не дёргаю в этой сессии'); yoloFails++ }
    return null
  }
  const order = yoloAlive ? [yoloAlive].concat(YOLO.urls.filter(u => u !== yoloAlive)) : YOLO.urls
  // имя поля: сначала из конфига, потом запасной вариант (image <-> file)
  const fields = [YOLO.field, YOLO.field === 'file' ? 'image' : 'file']
  for (const url of order) {
    if ((yoloUrlFails[url] || 0) >= 2) { dbg('[YOLO] пропускаю ' + url + ' (2 отказа подряд в этой сессии)'); continue }
    let urlFailed = false
    for (const field of fields) {
      const mp = multipart({}, { field, name: 'captcha.png', type: 'image/png', data: png })
      let u
      try { u = new URL(url) } catch (e) { continue }
      const t0 = Date.now()
      const r = await httpsRequest({
        host: u.hostname, port: Number(u.port || (u.protocol === 'http:' ? 80 : 443)),
        path: (u.pathname || '/') + (u.search || ''), method: 'POST',
        headers: { 'Content-Type': mp.contentType, 'Accept': 'application/json', 'User-Agent': 'mc-captcha/3.11' },
        body: mp.body, timeoutMs: YOLO.timeoutMs, secure: u.protocol !== 'http:'
      })
      const ms = Date.now() - t0
      if (!r.ok) { yoloLog((label || '') + ' ' + u.host + ' [' + field + ']: ' + r.error + ' (' + ms + 'мс)'); urlFailed = true; continue }
      const parsed = parseYoloAnswer(r.body ? r.body.toString('utf8') : '')
      if (parsed.digits && parsed.digits.length >= 3) {
        yoloAlive = url
        yoloFails = 0
        yoloUrlFails[url] = 0
        const want = yoloWantDigits()
        const exact = parsed.digits.length === want
        yoloLog((label || '') + ' ✅ ' + u.host + ' [' + field + '] -> "' + parsed.digits + '"' + (exact ? '' : ' ⚠️ длина ' + parsed.digits.length + ' вместо ' + want) + ' за ' + ms + 'мс')
        return { digits: parsed.digits, exact, url, host: u.host, field, ms, status: r.status }
      }
      yoloLog((label || '') + ' ' + u.host + ' [' + field + ']: HTTP ' + r.status + ', ответ без цифр: ' + parsed.raw.slice(0, 120))
      urlFailed = true
    }
    if (urlFailed) yoloUrlFails[url] = (yoloUrlFails[url] || 0) + 1
  }
  yoloFails++
  yoloLog((label || '') + ' ❌ ни один YOLO-эндпоинт не ответил (ошибок подряд: ' + yoloFails + ')')
  return null
}


// v3.14.0: ответ облака — в learn/rf_answers.jsonl и rf_boxes.json в папке раунда.
// Это бесплатная разметка РЕАЛЬНЫХ капч: из неё потом можно обучить свою YOLO
// (--export-yolo берёт ответы человека; rf_answers.jsonl — тот же формат, но ещё и с рамками).
function rfSaveAnswer(rec, round) {
  try {
    const y = rec && rec.yolo
    if (!y || y.provider !== 'roboflow') return false
    fs.mkdirSync(LEARN_DIR, { recursive: true })
    const boxes = (y.boxes || []).map(b => ({
      digit: b.cls, conf: Math.round(b.conf * 1000) / 1000,
      x1: Math.round(b.x1), y1: Math.round(b.y1), x2: Math.round(b.x2), y2: Math.round(b.y2),
      // нормированные cx cy w h — формат меток YOLO
      n: (y.imgW && y.imgH)
        ? [((b.x1 + b.x2) / 2 / y.imgW), ((b.y1 + b.y2) / 2 / y.imgH), ((b.x2 - b.x1) / y.imgW), ((b.y2 - b.y1) / y.imgH)].map(v => Math.round(v * 1e6) / 1e6)
        : null
    }))
    const line = {
      round: Number(round) || null, dir: rec.dir ? path.basename(rec.dir) : '', answer: y.digits,
      model: y.model || RF.model, conf: y.conf, ms: y.ms, imgW: y.imgW, imgH: y.imgH,
      inferenceId: y.inferenceId || '', boxes, ts: new Date().toISOString()
    }
    fs.appendFileSync(path.join(LEARN_DIR, 'rf_answers.jsonl'), JSON.stringify(line) + '\n')
    if (rec.dir) { try { fs.writeFileSync(path.join(rec.dir, 'rf_boxes.json'), JSON.stringify(line, null, 1)) } catch (e) {} }
    return true
  } catch (e) { dbg('rfSaveAnswer: ' + e.message); return false }
}

// самая свежая собранная картинка капчи — для node main.js --rf-test без аргумента
function rfNewestCaptcha() {
  const cands = []
  const roots = []
  try { if (REC_ROOT) roots.push(REC_ROOT) } catch (e) {}
  try { roots.push(path.join(__dirname, 'records')) } catch (e) {}
  for (const root of roots) {
    let dirs = []
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name)) } catch (e) {}
    for (const d of dirs) {
      for (const n of ['ORIGINAL_CAPTCHA_x1.png', 'ORIGINAL_CAPTCHA.png']) {
        const p = path.join(d, n)
        try { if (fs.existsSync(p)) cands.push({ p, m: fs.statSync(p).mtimeMs }) } catch (e) {}
      }
    }
    try {
      const cd = path.join(root, 'captchas')
      for (const n of fs.readdirSync(cd)) if (/\.png$/i.test(n)) { const p = path.join(cd, n); cands.push({ p, m: fs.statSync(p).mtimeMs }) }
    } catch (e) {}
  }
  if (!cands.length) return ''
  cands.sort((a, b) => b.m - a.m)
  return cands[0].p
}

// node main.js --rf-test [файл] — разовая проверка облака Roboflow (без подключения к MC)
async function runRfTest(fileArg) {
  step('=== ПРОВЕРКА ХОСТ-МОДЕЛИ ROBOFLOW (--rf-test) ===')
  step('config: ' + (CFG_PATH || 'НЕТ') + ' parse=' + CFG_STRATEGY)
  step('roboflow: enabled=' + RF.enabled + ' ключ=' + rfMaskKey(RF.apiKey) + ' модель=' + RF.model +
    ' поле="' + RF.field + '" порог-запрос=' + RF.askConf + '% overlap=' + Math.round(RF.overlap * 100) + '% таймаут=' + RF.timeoutMs + 'мс')
  if (!RF.ready) {
    step('❌ облако не готово: ' + (RF.disabledReason || (!RF.apiKey ? 'нет roboflow.apiKey в config.json (app.roboflow.com → Settings → API key)' : 'roboflow.enabled=false или ключ-заглушка')))
    step('   подсказка: модель задаётся как roboflow.modelId="captcha-funtime/2"')
    return false
  }
  let f = String(fileArg || '').trim()
  if (!f) { f = rfNewestCaptcha(); step('файл не указан — беру последнюю собранную капчу') }
  if (!f || !fs.existsSync(f)) { step('❌ картинка не найдена: ' + (f || '(в records/ пусто — сначала соберите раунд)')); return false }
  const buf = fs.readFileSync(f)
  const isJpg = /\.jpe?g$/i.test(f)
  step('файл: ' + f + ' (' + buf.length + ' байт, ' + (isJpg ? 'JPEG' : 'PNG') + ')')
  const t0 = Date.now()
  const r = await rfRecognize(buf, 'RF-TEST', { name: isJpg ? 'captcha.jpg' : 'captcha.png', type: isJpg ? 'image/jpeg' : 'image/png' })
  if (!r) {
    step('❌ облако не ответило за ' + (Date.now() - t0) + 'мс: ' + (RF.disabledReason || RF.lastError || 'неизвестная ошибка'))
    step('   если ошибка соединения — проверьте, открывается ли https://roboflow.com в браузере (или включите roboflow.useSocks=true)')
    return false
  }
  const want = RF.digits || yoloWantDigits()
  step('✅ Roboflow: «' + r.digits + '»' + (r.exact ? '' : ' ⚠️ цифр ' + r.digits.length + ' вместо ' + want) +
    ' за ' + r.ms + 'мс (inference ' + (r.inferenceId || '?') + ')')
  step('   картинка в облаке ' + r.imgW + '×' + r.imgH + ', рамок выбрано ' + (r.boxes || []).length + ', порог отбора ' + r.conf)
  for (const b of (r.boxes || [])) {
    step('   «' + b.cls + '» x=' + Math.round(b.x1) + '..' + Math.round(b.x2) + ' y=' + Math.round(b.y1) + '..' + Math.round(b.y2) + ' conf=' + b.conf.toFixed(3))
  }
  step('   всего картинок ушло в облако за процесс: ' + RF.calls)
  return true
}
// ========================= ТРАНСПОРТ: SOCKS + TLS (общий, для облака и API) =========================
// принимает: socks5://u:p@host:port, socks5h://u:p@host:port, socks4://...,
//            u:p@host:port и host:port (без схемы и без логина)
function parseSocksUrl(s) {
  try {
    let str = String(s || '').trim()
    if (!str) return null
    let type = 5
    const pm = str.match(/^(socks[45])h?:\/\//i)
    if (pm) { type = pm[1].toLowerCase() === 'socks4' ? 4 : 5; str = str.slice(pm[0].length) }
    else if (/^[a-z0-9]+:\/\//i.test(str)) return null
    const at = str.lastIndexOf('@')
    let user = '', pass = ''
    if (at >= 0) {
      const auth = str.slice(0, at)
      str = str.slice(at + 1)
      const ci = auth.indexOf(':')
      if (ci >= 0) { user = auth.slice(0, ci); pass = auth.slice(ci + 1) } else user = auth
    }
    const hm = str.match(/^\[?([^\]:]+)\]?:(\d+)\/?$/)
    if (!hm) return null
    return {
      type, host: hm[1], port: Number(hm[2]),
      username: decodeURIComponent(user), password: decodeURIComponent(pass)
    }
  } catch (e) { return null }
}

// открывает туннель до (host:port) через SOCKS и возвращает «голый» сокет.
// type 4 → модуль socks (если есть); type 5 → встроенный клиент (работает без npm-пакета socks).
async function openSocksTunnel(host, port, socks, timeoutMs) {
  const type = Number(socks.type) || 5
  if (type !== 5 && SocksClient) {
    const conn = await SocksClient.createConnection({
      proxy: { host: socks.host, port: socks.port, type, userId: socks.username, password: socks.password },
      command: 'connect', destination: { host, port }
    })
    return conn.socket
  }
  if (SocksClient && type === 5) {
    try {
      const conn = await SocksClient.createConnection({
        proxy: { host: socks.host, port: socks.port, type: 5, userId: socks.username, password: socks.password },
        command: 'connect', destination: { host, port }
      })
      return conn.socket
    } catch (e) { /* пробуем встроенный клиент (резервный хост и т.п.) */ }
  }
  return await socks5Open({ host: socks.host, port: socks.port, userId: socks.username, password: socks.password }, host, port, timeoutMs || 25000)
}

function socksTlsConnect(host, port, socks, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false, raw = null
    const to = setTimeout(() => { if (!done) { done = true; try { if (raw) raw.destroy() } catch (e) {}; reject(new Error('SOCKS timeout')) } }, timeoutMs || 25000)
    openSocksTunnel(host, port, socks, timeoutMs || 25000).then(sock => {
      raw = sock
      if (done) { try { sock.destroy() } catch (e) {} return }
      let secure = null
      try {
        secure = tls.connect({ socket: sock, servername: host, minVersion: 'TLSv1.2' }, () => {
          if (done) return
          done = true; clearTimeout(to)
          resolve({ socket: secure, cleanup() { try { secure.destroy() } catch (e) {} try { sock.destroy() } catch (e) {} } })
        })
      } catch (e) { if (!done) { done = true; clearTimeout(to); try { sock.destroy() } catch (x) {}; reject(e) }; return }
      secure.on('error', e => { if (!done) { done = true; clearTimeout(to); try { sock.destroy() } catch (x) {}; reject(e) } })
    }).catch(e => { if (!done) { done = true; clearTimeout(to); reject(e) } })
  })
}

async function httpsRequest(o) {
  const secure = o.secure !== false
  const host = o.host, port = o.port || (secure ? 443 : 80)
  const mod = secure ? https : http
  let sock = null
  if (o.socks) {
    if (!secure) { /* через SOCKS без TLS не ходим */ }
    else {
      try { sock = await socksTlsConnect(host, port, o.socks, Math.min(25000, o.timeoutMs || 30000)) }
      catch (e) { return { ok: false, error: 'SOCKS: ' + ((e && e.message) || e) } }
    }
  }
  return await new Promise(resolve => {
    const headers = Object.assign({}, o.headers || {})
    if (o.body) headers['Content-Length'] = Buffer.isBuffer(o.body) ? o.body.length : Buffer.byteLength(o.body)
    const opts = { hostname: host, port, path: o.path, method: o.method || 'POST', timeout: o.timeoutMs || 30000, headers }
    if (sock) opts.createConnection = () => sock.socket
    let req
    try {
      req = mod.request(opts, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => { if (sock) try { sock.cleanup() } catch (e) {}; resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks) }) })
        res.on('error', e => { if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: 'RES: ' + e.message }) })
      })
    } catch (e) { if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: 'REQ: ' + ((e && e.message) || e) }); return }
    req.on('error', e => { if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: ((e && e.code) ? e.code + ' ' : '') + e.message }) })
    req.on('timeout', () => { try { req.destroy() } catch (e) {}; if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: 'timeout' }) })
    if (o.body) req.write(o.body)
    req.end()
  })
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
function isIpV4(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '').trim()) }

// bproxy.site <-> mproxy.site (http-хост того же порта у MobileProxy.Space)
function altHostOf(host) {
  const h = String(host || '').toLowerCase()
  if (h.startsWith('bproxy.')) return 'mproxy.' + h.slice(7)
  if (h.startsWith('mproxy.')) return 'bproxy.' + h.slice(7)
  return null
}
// ========================= ТУННЕЛЬ: подключение, IP, состояние =========================
// Список хостов-кандидатов туннеля: запомненный живой → из конфига → altHosts → производный
// (у MobileProxy.Space один порт слушают два хоста: bproxy.site = SOCKS5, mproxy.site = HTTP).
function proxyHostCandidates(T, host) {
  const out = []
  const push = h => { h = String(h || '').trim().toLowerCase(); if (h && out.indexOf(h) < 0) out.push(h) }
  const base = host || (T && T.cfg.host) || ''
  if (T) push(T.okHost)
  push(base)
  if (T && Array.isArray(T.cfg.altHosts)) for (const h of T.cfg.altHosts) push(h)
  const alt = altHostOf(base)
  if (alt) push(alt)
  return out
}

// TCP-туннель до (destHost:destPort) через туннель T: сначала SOCKS5, при отказе — HTTP CONNECT
// на запасном хосте. T=null → прямой net.connect (если разрешено proxy.allowDirect).
async function proxyTunnel(destHost, destPort, opt) {
  opt = opt || {}
  const T = opt.T || TUNNELS[0] || null
  const timeoutMs = opt.timeoutMs || 15000
  if (!T || !T.cfg.host) {
    if (CAP.allowDirect) return await new Promise((resolve, reject) => {
      const s = net.connect({ host: destHost, port: Number(destPort) })
      const to = setTimeout(() => { try { s.destroy() } catch (e) {}; reject(new Error('direct connect timeout')) }, timeoutMs)
      s.once('connect', () => { clearTimeout(to); resolve(s) })
      s.once('error', e => { clearTimeout(to); reject(e) })
    })
    throw new Error('нет proxy.host в конфиге')
  }
  const pxy = {
    host: opt.host || T.cfg.host, port: opt.port || T.cfg.port,
    userId: opt.username !== undefined ? opt.username : T.cfg.username,
    password: opt.password !== undefined ? opt.password : T.cfg.password
  }
  if (opt.method === 'http') return await httpConnect(pxy, destHost, destPort, timeoutMs)
  try {
    return await socks5Open(pxy, destHost, destPort, timeoutMs)
  } catch (e) {
    const alt = opt.allowAlt === false ? null : altHostOf(pxy.host)
    if (alt && /ОТКАЗАЛ|не удалось определить|недоступен|не SOCKS5/i.test(e.message)) {
      try { return await httpConnect(Object.assign({}, pxy, { host: alt }), destHost, destPort, timeoutMs) } catch (e2) { throw e }
    }
    throw e
  }
}

async function socksHttpGet2(host, reqText, opt) {
  const sock = await proxyTunnel(host, 80, opt)
  return await httpThrough(sock, host, reqText, (opt && opt.timeoutMs) || 10000)
}

function rememberProxyErr(T, host, e) {
  if (!T) return
  T.errs.push({ host: host || T.cfg.host, msg: String((e && e.message) || e), ts: Date.now() })
  if (T.errs.length > 12) T.errs.shift()
}

// живой сокет до цели через туннель: пробуем запомненный хост, затем из конфига, затем запасные
async function proxyConnect(destHost, destPort, timeoutMs, T) {
  T = T || TUNNELS[0] || null
  if (!T || !T.cfg.host) {
    if (CAP.allowDirect) return await proxyTunnel(destHost, destPort, { T: null, timeoutMs: timeoutMs || 15000 })
    throw new Error('нет proxy.host в конфиге')
  }
  const hosts = proxyHostCandidates(T)
  let last = null
  for (const h of hosts) {
    try {
      const sock = await socks5Open({ host: h, port: T.cfg.port, userId: T.cfg.username, password: T.cfg.password }, destHost, destPort, timeoutMs || 15000)
      if (T.okHost !== h) {
        if (T.okHost) step('туннель ' + T.name + ': хост ' + T.okHost + ' не отвечает — работаю через ' + h)
        T.okHost = h
      }
      T.state = 'alive'
      T.failStreak = 0
      return sock
    } catch (e) { last = e; rememberProxyErr(T, h, e) }
  }
  T.state = 'dead'
  T.failStreak++
  throw last || new Error('прокси недоступен')
}

// внешний IP туннеля: через прокси (это IP, с которого нас видит сервер), при неудаче —
// напрямую (чтобы в логе не было «?»). opts: {T, directOnly, proxyOnly, quiet, timeoutMs, tagDirect}
async function currentIp(opts) {
  opts = opts || {}
  const T = opts.T || TUNNELS[0] || null
  if (!opts.directOnly && T && T.cfg.host) {
    try {
      const body = await socksHttpGet2('api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n', { timeoutMs: opts.timeoutMs || 10000, T })
      const m = String(body || '').trim().match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/)
      if (m) { T.state = 'alive'; T.ip = m[1]; return m[1] }
    } catch (e) {
      if (!T.errs.length || T.errs[T.errs.length - 1].msg !== String(e.message)) rememberProxyErr(T, T.okHost || T.cfg.host, e)
    }
  }
  if (opts.proxyOnly) return null
  try {
    const r = await plainGet('https://api.ipify.org', 8000)
    const m = String(r.body || '').trim().match(/^<?\s*(\d{1,3}(?:\.\d{1,3}){3})\s*>?$/)
    if (m) { if (opts.tagDirect !== false && !opts.quiet) step('IP определён НАПРЯМУЮ (прокси не отвечает): ' + m[1]); return m[1] }
  } catch (e) {}
  return null
}
function readExact(sock, n, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), to = null
    const onData = d => {
      buf = Buffer.concat([buf, d])
      if (buf.length >= n) {
        const extra = buf.slice(n)
        cleanup()
        // ВАЖНО: возвращаем «лишние» байты в сокет, иначе следующий слушатель
        // (mineflayer после CONNECT) потеряет начало данных сервера, если они
        // пришли одним TCP-сегментом с SOCKS-ответом.
        if (extra.length) { try { sock.unshift(extra) } catch (e) {} }
        resolve(buf.slice(0, n))
      }
    }
    const onErr = e => { cleanup(); reject(new Error((label || 'read') + ': ' + e.message)) }
    const onEnd = () => { cleanup(); reject(new Error((label || 'read') + ': соединение закрыто (недополучено ' + (n - buf.length) + ' байт)')) }
    const cleanup = () => { try { clearTimeout(to) } catch (e) {}; sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('end', onEnd) }
    to = setTimeout(() => { cleanup(); reject(new Error((label || 'read') + ': таймаут ' + Math.round(timeoutMs / 1000) + 'с')) }, timeoutMs)
    sock.on('data', onData); sock.on('error', onErr); sock.on('end', onEnd)
  })
}

// Полный SOCKS5-handshake своими силами: greeting -> auth -> CONNECT.
// Возвращает живой net.Socket до цели. Ошибки — человекочитаемые (для лога и --proxy-check).
function socks5Open(pxy, destHost, destPort, timeoutMs) {
  timeoutMs = timeoutMs || 15000
  return new Promise((resolve, reject) => {
    let sock = null
    try {
      sock = net.connect({ host: pxy.host, port: Number(pxy.port) })
    } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return }

    let settled = false
    let buf = Buffer.alloc(0)          // единый буфер: данные не теряются между чтениями
    let need = 0, onHave = null, onWantReject = null
    const fail = e => {
      if (settled) return
      settled = true; try { clearTimeout(to) } catch (x) {}
      const r = onWantReject; onHave = null; onWantReject = null
      try { sock.destroy() } catch (x) {}
      if (r) r(e instanceof Error ? e : new Error(String(e)))
      else reject(e instanceof Error ? e : new Error(String(e)))
    }
    const to = setTimeout(() => fail(new Error('таймаут подключения к прокси ' + Math.round(timeoutMs / 1000) + 'с')), timeoutMs)
    sock.setTimeout(timeoutMs, () => fail(new Error('таймаут сокета прокси')))
    sock.on('error', e => {
      const m = String(e.message || e); let msg = m
      if (e.code === 'ECONNREFUSED') msg = 'прокси ' + pxy.host + ':' + pxy.port + ' ОТКАЗАЛ в соединении (ECONNREFUSED) — порт не слушает: аренда истекла / прокси выключен / неверный порт'
      else if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') msg = 'не удалось определить адрес ' + pxy.host + ' (' + e.code + ') — DNS/интернет'
      else if (e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') msg = pxy.host + ':' + pxy.port + ' недоступен (' + e.code + ') — файрвол/провайдер блокирует порт, или прокси выключен'
      fail(new Error(msg))
    })
    const onEnd = () => fail(new Error('прокси закрыл соединение до завершения handshake'))
    sock.on('end', onEnd)
    // постоянный слушатель: копит байты, отдаёт текущему «хочу N байт»
    const onData = d => {
      buf = Buffer.concat([buf, d])
      if (onHave && buf.length >= need) {
        const chunk = buf.slice(0, need); buf = buf.slice(need)
        const cb = onHave; onHave = null; onWantReject = null
        cb(chunk)
      }
    }
    sock.on('data', onData)
    const read = (n, label) => new Promise((res, rej) => {
      if (settled) { rej(new Error(label + ': сокет уже закрыт')); return }
      if (buf.length >= n) { const c = buf.slice(0, n); buf = buf.slice(n); res(c); return }
      need = n; onHave = res; onWantReject = rej
    })

    sock.once('connect', async () => {
      try {
        const user = pxy.userId || pxy.username || ''
        const pass = pxy.password || ''
        const auth = !!(user || pass)
        sock.write(auth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))
        const g = await read(2, 'SOCKS greeting')
        if (g[0] !== 0x05) throw new Error('это не SOCKS5 (первый байт 0x' + g[0].toString(16) + ') — вероятно, порт HTTP-прокси')
        if (g[1] === 0xff) throw new Error('прокси не принял ни один метод авторизации (0xFF)')
        if (g[1] === 0x02) {
          const ub = Buffer.from(String(user), 'utf8'), pb = Buffer.from(String(pass), 'utf8')
          sock.write(Buffer.concat([Buffer.from([0x01, ub.length & 255]), ub, Buffer.from([pb.length & 255]), pb]))
          const ab = await read(2, 'SOCKS auth')
          if (ab[0] !== 0x01) throw new Error('мусор в ответе авторизации SOCKS')
          if (ab[1] !== 0x00) throw new Error('прокси ОТВЕРГ логин/пароль (status 0x' + ab[1].toString(16) + ')')
        }
        // CONNECT
        const h = String(destHost)
        let head
        if (isIpV4(h)) head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(h.split('.').map(x => Number(x) & 255))])
        else { const hb = Buffer.from(h, 'utf8'); head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length & 255]), hb]) }
        const pb = Buffer.alloc(2); pb.writeUInt16BE(Number(destPort) & 0xffff, 0)
        sock.write(Buffer.concat([head, pb]))
        const rp = await read(4, 'SOCKS reply')
        if (rp[0] !== 0x05) throw new Error('мусор в ответе SOCKS (0x' + rp[0].toString(16) + ')')
        const code = rp[1]
        if (code !== 0x00) {
          const names = { 1: 'общий сбой прокси', 2: 'соединение ЗАПРЕЩЕНО правилами прокси', 3: 'сеть недоступна', 4: 'хост недоступен', 5: 'отказано в соединении с целью', 6: 'TTL истёк', 7: 'команда не поддержана', 8: 'тип адреса не поддержан' }
          throw new Error('SOCKS5 отказ 0x' + code.toString(16) + ' — ' + (names[code] || 'неизвестно') + (code === 2 ? ' (обычно неверный логин/пароль или привязка по IP)' : '') + (code === 5 ? ' (цель ' + destHost + ':' + destPort + ' не пускает)' : ''))
        }
        const at = rp[3]
        if (at === 1) await read(4 + 2, 'SOCKS bind')
        else if (at === 4) await read(16 + 2, 'SOCKS bind')
        else if (at === 3) { const lb = await read(1, 'SOCKS bind-len'); await read(lb[0] + 2, 'SOCKS bind') }
        else throw new Error('непонятный тип адреса 0x' + at.toString(16))

        // handshake завершён: снимаем свой слушатель и возвращаем «лишние» байты в сокет,
        // чтобы mineflayer получил всё, что сервер прислал сразу за SOCKS-ответом.
        if (settled) return
        settled = true; clearTimeout(to); try { sock.setTimeout(0) } catch (e) {}
        sock.removeListener('data', onData)
        sock.removeListener('end', onEnd)
        if (buf.length) { try { sock.unshift(buf) } catch (e) {} }
        buf = Buffer.alloc(0)
        resolve(sock)
      } catch (e) { fail(e) }
    })
  })
}

// HTTP-запрос через уже открытый туннель (сокеты после socks5Open / httpConnect)
function httpThrough(sock, host, reqText, timeoutMs) {
  timeoutMs = timeoutMs || 10000
  return new Promise(resolve => {
    let data = '', fin = false
    const end = v => { if (fin) return; fin = true; try { clearTimeout(t) } catch (e) {}; try { sock.destroy() } catch (e) {}; resolve(v) }
    const t = setTimeout(() => end(data), timeoutMs)
    sock.on('data', d => {
      data += d.toString('utf8')
      if (data.indexOf('\r\n\r\n') >= 0) {
        const body = data.split('\r\n\r\n').slice(1).join('\r\n\r\n')
        if (body.trim()) end(body.trim())
      }
      if (data.length > 200000) end(data)
    })
    sock.on('error', () => end(data))
    sock.on('end', () => end(data))
    try { sock.write(reqText) } catch (e) { end('') }
  })
}

// HTTP-прокси методом CONNECT (mproxy.site — тот же порт, но протокол HTTP)
function httpConnect(pxy, destHost, destPort, timeoutMs) {
  timeoutMs = timeoutMs || 15000
  return new Promise((resolve, reject) => {
    let sock = null
    try { sock = net.connect({ host: pxy.host, port: Number(pxy.port) }) } catch (e) { reject(e); return }
    let done = false
    const fail = e => { if (done) return; done = true; try { clearTimeout(to) } catch (x) {}; try { sock.destroy() } catch (x) {}; reject(e instanceof Error ? e : new Error(String(e))) }
    const to = setTimeout(() => fail(new Error('таймаут HTTP CONNECT ' + Math.round(timeoutMs / 1000) + 'с')), timeoutMs)
    sock.once('error', e => fail(new Error('HTTP-прокси ' + pxy.host + ':' + pxy.port + ': ' + (e.code === 'ECONNREFUSED' ? 'ОТКАЗ в соединении (порт не слушает)' : e.message))))
    let head = 'CONNECT ' + destHost + ':' + destPort + ' HTTP/1.1\r\nHost: ' + destHost + ':' + destPort + '\r\n'
    if (pxy.userId || pxy.username) head += 'Proxy-Authorization: Basic ' + Buffer.from((pxy.userId || pxy.username) + ':' + (pxy.password || '')).toString('base64') + '\r\n'
    head += '\r\n'
    sock.once('connect', () => { try { sock.write(head) } catch (e) { fail(e) } })
    let buf = Buffer.alloc(0)
    const onData = d => {
      buf = Buffer.concat([buf, d])
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) { if (buf.length > 65536) fail(new Error('HTTP-прокси: мусор вместо ответа CONNECT')); return }
      sock.removeListener('data', onData)
      const line = buf.slice(0, i).toString('latin1').split('\r\n')[0]
      if (done) return
      done = true; clearTimeout(to)
      if (!/ 200\b/.test(line)) { try { sock.destroy() } catch (e) {}; reject(new Error('HTTP-прокси ответил «' + line.slice(0, 60) + '»' + (/ 407\b/.test(line) ? ' — неверный логин/пароль' : ''))); return }
      const rest = buf.slice(i + 4)          // «лишние» байты — назад в сокет без потерь
      if (rest.length) { try { sock.unshift(rest) } catch (e) {} }
      resolve(sock)
    }
    sock.on('data', onData)
  })
}

// туннель к цели: сначала SOCKS5, при неудаче — HTTP CONNECT (если host похож на mproxy)
// разбираем ответ ссылки смены IP. Чистые функции — покрыты selftest.
function parseChangeIpResponse(status, body, url) {
  const out = { status: Number(status) || 0, kind: 'unknown', newIp: null, rt: null, rateLimited: false, title: '', text: '', hint: '' }
  const raw = String(body == null ? '' : body)
  out.text = raw.replace(/\s+/g, ' ').trim().slice(0, 200)
  const low = raw.toLowerCase()
  if (low.indexOf('<!doctype html') >= 0 || low.indexOf('<html') >= 0) {
    out.kind = 'html'
    const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    out.title = t ? t[1].replace(/\s+/g, ' ').trim().slice(0, 90) : ''
    const isMps = /mobileproxy\.space|changeip\./i.test(String(url || ''))
    out.hint = isMps
      ? 'ссылка вернула ВЕБ-СТРАНИЦУ («' + (out.title || 'без заголовка') + '»), а не ответ API. Возьмите ссылку в панели «Мои прокси» → колонка «Смена IP» и добавьте &format=json'
      : 'ссылка вернула ВЕБ-СТРАНИЦУ («' + (out.title || 'без заголовка') + '»), а не JSON/текст — похоже, это не API смены IP (или нужна авторизация)'
    return out
  }
  const jm = raw.match(/\{[\s\S]*\}/)
  if (jm) {
    try {
      const j = JSON.parse(jm[0])
      out.kind = 'json'
      out.newIp = isIpV4(j.new_ip || j.newIp || j.ip || j.newip) ? String(j.new_ip || j.newIp || j.ip || j.newip) : null
      out.rt = j.rt !== undefined ? String(j.rt) : null
      out.status0 = j.status !== undefined ? String(j.status) : null
      const s = String(j.status || j.error || j.message || '').toLowerCase()
      if (/30\s*(сек|sec|second)|часто|too\s*often|rate|limit|ждите|подождите/i.test(s + ' ' + out.text.toLowerCase())) out.rateLimited = true
      if (!out.newIp) { const m = out.text.match(/(\d{1,3}(?:\.\d{1,3}){3})/); if (m && isIpV4(m[1])) out.newIp = m[1] }
      if (out.rateLimited) out.hint = 'прокси меняет IP не чаще раза в 30 секунд — запрос отброшен, ждём'
      else if (j.status && !/^ok$/i.test(String(j.status))) out.hint = 'API ответил status=' + j.status + (j.error ? ' error=' + j.error : '')
      return out
    } catch (e) { /* не JSON — падём ниже */ }
  }
  const m = raw.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
  if (m && isIpV4(m[1])) { out.kind = 'ip'; out.newIp = m[1]; return out }
  if (/30\s*(сек|sec|second)|часто|too\s*often|rate|limit/i.test(low)) { out.kind = 'rate'; out.rateLimited = true; out.hint = 'слишком частая смена IP (лимит 30 секунд)'; return out }
  if (/ok|success|changed|сменен|изменен/i.test(low)) { out.kind = 'ok-text'; return out }
  out.kind = raw.trim() ? 'text' : 'empty'
  if (!raw.trim()) out.hint = 'пустой ответ — ссылка не сработала'
  return out
}

// дописать format=json к ссылке смены IP (MobileProxy.Space умеет отдавать JSON)
function ensureJsonParam(url) {
  const u = String(url || '')
  if (!u) return u
  if (/[?&]format=/i.test(u)) return u
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'format=json'
}
// человекочитаемое «что это за ссылка»
function describeChangeIpUrl(u) {
  const s = String(u || '')
  if (!s) return 'не задана (proxy.changeIpUrl)'
  if (/changeip\.mobileproxy\.space/i.test(s)) return 'API MobileProxy.Space (changeip.mobileproxy.space)'
  if (/mobileproxy\.space/i.test(s)) return 'сайт MobileProxy.Space'
  try { const p = new URL(s); return p.host + p.pathname } catch (e) { return s.slice(0, 60) }
}
const CHANGE_IP_MIN_MS = 30000   // лимит провайдера: минимум 30 секунд между сменами IP

// Быстрая проверка «жив ли туннель» — до ротации, чтобы не жечь попытки впустую.
async function proxyAlive(T, timeoutMs) {
  T = T || TUNNELS[0] || null
  if (!T || !T.cfg.host) return false
  try { await proxyConnect('api.ipify.org', 80, timeoutMs || 7000, T); return true } catch (e) { return false }
}

// подсказка к ошибке прокси — прямо в лог (раньше было просто «socks: ...»)
function socksHint(msg, T) {
  const s = String(msg || '')
  const hp = T ? ((T.okHost || T.cfg.host) + ':' + T.cfg.port) : 'прокси'
  if (/ConnectionRefused|ECONNREFUSED|ОТКАЗАЛ/i.test(s)) return [
    '🔌 ' + hp + ' не принимает соединения (порт не слушает).',
    '   Чаще всего это значит: аренда мобильного прокси истекла или порт выключен.',
    '   Что сделать:',
    '     1) node main.js --proxy-check   — полная диагностика (DNS, SOCKS5, HTTP-резерв, ссылка смены IP, пинг MC-сервера)',
    '     2) панель провайдера → «Мои прокси»: проверить срок аренды, нажать «Renew» / «Перезагрузить оборудование» / «Сменить оборудование»',
    '     3) сверить host / port / логин / пароль в config.json (секции proxy или tunnels) со свежими данными из панели',
    '     4) если прокси больше не нужен — включите "proxy": { "allowDirect": true } (бот пойдёт напрямую)'
  ].join('\n')
  if (/ОТВЕРГ логин|407|неверный логин|ПРАВИЛАМИ|запрещено|0x02/i.test(s)) return [
    '🔐 прокси не принял авторизацию/правила.',
    '   Проверьте username и password туннеля в config.json (свежие — в панели провайдера),',
    '   и не включена ли у провайдера привязка по IP (тогда ваш IP нужно добавить в белый список).',
    '   Диагностика: node main.js --proxy-check'
  ].join('\n')
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|недоступен|таймаут/i.test(s)) return [
    '⏳ ' + hp + ' не отвечает (таймаут/недоступен).',
    '   Варианты: прокси выключен, ваш провайдер/файрвол блокирует исходящие на этот порт,',
    '   или оборудование «зависло» — в панели провайдера нажмите «Перезагрузить оборудование».',
    '   Диагностика: node main.js --proxy-check'
  ].join('\n')
  if (/не SOCKS5|первый байт/i.test(s)) return [
    '🔀 порт отвечает, но это не SOCKS5. У MobileProxy.space порт один на два протокола:',
    '   SOCKS5-хост bproxy.site, HTTP-хост mproxy.site. Бот пробует оба сам.',
    '   Диагностика: node main.js --proxy-check'
  ].join('\n')
  if (/ENOTFOUND|EAI_AGAIN|определить адрес/i.test(s)) return [
    '🌐 не удалось определить адрес ' + hp + ' (DNS).',
    '   Проверьте интернет и DNS; при необходимости пропишите host туннеля IP-адресом из панели.'
  ].join('\n')
  return ''
}

// Смена IP ОДНОГО туннеля. Сериализуется (T.rotating), чтобы несколько ботов одного
// туннеля не дёргали changeIp одновременно; соблюдает лимит провайдера 30 с.
// Возвращает новый IP (или текущий, если смена не удалась).
function rotateIp(T, opt) {
  T = T || TUNNELS[0] || null
  opt = opt || {}
  if (!T) return Promise.resolve(null)
  if (T.rotating) return T.rotating            // кто-то уже крутит — ждём тот же результат
  const p = rotateIpNow(T, opt).finally(() => { T.rotating = null })
  T.rotating = p
  return p
}

async function rotateIpNow(T, opt) {
  const tag = '[' + T.name + '] '
  const url = String(T.cfg.changeIpUrl || '').trim()
  if (!url || url.includes('YOUR_KEY')) { T.ip = await currentIp({ T, quiet: true }); return T.ip }

  // сначала убеждаемся, что туннель вообще жив: иначе «IP не сменился» — это не про IP,
  // а про то, что спросить не у кого
  const alive = await proxyAlive(T, 7000)
  if (!alive) {
    step('⚠️ туннель ' + T.name + ' (' + (T.okHost || T.cfg.host) + ':' + T.cfg.port + ') НЕ отвечает — IP через него не узнать' +
      (T.errs.length ? ' (' + T.errs[T.errs.length - 1].msg.slice(0, 120) + ')' : ''))
    if (!opt.quiet) { const h = socksHint(T.errs.length ? T.errs[T.errs.length - 1].msg : 'ECONNREFUSED', T); if (h) h.split('\n').forEach(l => step('   ' + l)) }
  }

  for (let round = 1; round <= 2; round++) {
    const oldIp = await currentIp({ T, quiet: true })
    step(tag + 'IP до ротации: ' + (oldIp || '?') + (T.state === 'dead' ? ' (напрямую — прокси мёртв)' : ''))

    // лимит провайдера: 30 секунд между сменами IP (иначе запрос молча отбрасывается)
    const since = Date.now() - T.lastChangeAt
    if (T.lastChangeAt && since < CHANGE_IP_MIN_MS && !opt.force) {
      const w = Math.ceil((CHANGE_IP_MIN_MS - since) / 1000)
      step(tag + '⏱ смена IP была ' + Math.round(since / 1000) + 'с назад — лимит провайдера 30с, жду ' + w + 'с')
      await sleep(CHANGE_IP_MIN_MS - since + 300)
    }

    // API MobileProxy.Space отдаёт JSON, если попросить format=json, и требует браузерный User-Agent
    const reqUrl = ensureJsonParam(url)
    if (reqUrl !== url) dbg(tag + 'changeIp: добавил format=json → ' + reqUrl.slice(0, 120))
    let res = null, p = null, hit = 'fail'
    for (let t = 1; t <= 2; t++) {
      try {
        res = await plainGet(reqUrl, 15000)
        p = parseChangeIpResponse(res.status, res.body, reqUrl)
        hit = 'HTTP ' + res.status + ' → ' + p.kind +
          (p.newIp ? ' new_ip=' + p.newIp : '') + (p.rt ? ' rt=' + p.rt + 'с' : '') +
          (p.title ? ' title=«' + p.title + '»' : '') +
          (p.kind === 'text' || p.kind === 'ok-text' ? ' «' + p.text.slice(0, 60) + '»' : '')
        if (res.status >= 200 && res.status < 400 && p.kind !== 'html' && p.kind !== 'empty') break
        if (p.kind === 'html' || p.kind === 'empty') break   // повторять бессмысленно — ссылка не та
      } catch (e) { hit = 'ERR ' + ((e && e.message) || e); p = null }
      if (t < 2) { step(tag + 'changeIp: ' + hit + ' — повтор через 3с'); await sleep(3000) }
    }
    T.lastChangeAt = Date.now()
    step(tag + 'changeIp (' + describeChangeIpUrl(reqUrl) + '): ' + hit)
    if (p && p.hint) step('  ℹ️ ' + p.hint)
    if (p && p.kind === 'html') {
      step('  ⚠️ IP так НЕ меняют: сервер отдал веб-страницу. Нужна ссылка из панели «Мои прокси» → колонка «Смена IP»' +
        ' (вид https://changeip.mobileproxy.space/?proxy_key=XXXX), желательно с &format=json.')
      step('  ⚠️ Без рабочей смены IP бот будет каждый раз заходить с одного и того же адреса — FunTime его быстро забанит.')
      T.ip = oldIp || await currentIp({ T, quiet: true })
      return T.ip
    }
    T.lastLimited = !!(p && p.rateLimited)

    // ждём подтверждения: сначала из ответа API (быстро и не зависит от прокси), потом опросом
    const t0 = Date.now(); let newIp = (p && p.newIp) || null
    const waitMs = Math.max(8000, (Number(T.cfg.waitSec) || 12) * 1000) * (T.lastLimited ? 2 : 1)
    while (!(newIp && (!oldIp || newIp !== oldIp)) && Date.now() - t0 < waitMs) {
      await sleep(2000)
      const q = await currentIp({ T, quiet: true })
      if (q && (!oldIp || q !== oldIp)) newIp = q
    }
    if (newIp && (!oldIp || newIp !== oldIp)) {
      if (oldIp && badIPs.has(newIp)) { step(tag + 'новый IP ' + newIp + ' уже плох — кручу'); continue }
      step(tag + 'IP СМЕНЁН: ' + (oldIp || '?') + ' -> ' + newIp + (T.state === 'dead' ? ' (⚠️ сам туннель по-прежнему не отвечает — заход не подключится)' : ''))
      T.ip = newIp; return newIp
    }
    if (T.state === 'dead') step(tag + 'IP не сменился: прокси мёртв, проверить смену нечем → node main.js --proxy-check')
    else step(tag + 'IP не сменился' + (T.lastLimited ? ' (лимит 30с — следующий запрос пройдёт)' : ' (провайдер иногда выдаёт тот же адрес — это нормально, пробую ещё раз)'))
  }
  T.ip = await currentIp({ T, quiet: true }); return T.ip
}

// ========================= ДИАГНОСТИКА ТУННЕЛЕЙ: node main.js --proxy-check =========================
async function checkOneTunnel(T) {
  const L = []
  const say = s => { L.push(s); step(s) }
  say('--- ТУННЕЛЬ «' + T.name + '» ---')
  say('прокси из config    : ' + T.cfg.host + ':' + T.cfg.port + ' | логин ' + (T.cfg.username ? '«' + T.cfg.username + '» (есть)' : 'НЕТ') + ' | пароль ' + (T.cfg.password ? 'есть' : 'НЕТ'))
  say('ссылка смены IP     : ' + describeChangeIpUrl(T.cfg.changeIpUrl) + (T.cfg.changeIpUrl ? ' → ' + T.cfg.changeIpUrl : ''))

  // 1. DNS
  const hosts = proxyHostCandidates(T)
  say(' 1. DNS:')
  for (const h of hosts) {
    const ips = await new Promise(r => dns.lookup(h, { all: true, verbatim: true }, (e, a) => r(e ? null : a.map(x => x.address))))
    say('  ' + h.padEnd(22) + (ips ? '→ ' + ips.join(', ') : '❌ не определяется (нет интернета/DNS или домен не существует)'))
  }

  // 2. прямой интернет
  const directIp = await currentIp({ directOnly: true })
  say(' 2. интернет без прокси: ' + (directIp ? '✅ ваш IP напрямую: ' + directIp : '❌ не удалось выйти в интернет даже напрямую (api.ipify.org недоступен) — проверьте сеть/файрвол'))

  // 3. SOCKS5 по всем кандидатам
  say(' 3. SOCKS5 handshake (подключение к api.ipify.org:80):')
  let liveHost = null, liveIp = null, errs = []
  for (const h of hosts) {
    const t0 = Date.now()
    try {
      const sock = await socks5Open({ host: h, port: T.cfg.port, userId: T.cfg.username, password: T.cfg.password }, 'api.ipify.org', 80, 10000)
      const body = await httpThrough(sock, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n', 10000)
      const ip = String(body || '').trim()
      say('  ✅ ' + h + ':' + T.cfg.port + ' РАБОТАЕТ за ' + (Date.now() - t0) + 'мс → внешний IP ' + (isIpV4(ip) ? ip : '«' + ip.slice(0, 40) + '»'))
      if (!liveHost) { liveHost = h; liveIp = isIpV4(ip) ? ip : null }
    } catch (e) { errs.push({ host: h, msg: String(e.message || e) }); say('  ❌ ' + h + ':' + T.cfg.port + ' — ' + String(e.message || e).slice(0, 160)) }
  }

  // 4. HTTP CONNECT на запасном хосте
  if (!liveHost) {
    const alt = (Array.isArray(T.cfg.altHosts) && T.cfg.altHosts[0]) || altHostOf(T.cfg.host) || T.cfg.host
    say(' 4. HTTP CONNECT (протокол HTTP на том же порту):')
    const t0 = Date.now()
    try {
      const sock = await httpConnect({ host: alt, port: T.cfg.port, userId: T.cfg.username, password: T.cfg.password }, 'api.ipify.org', 80, 10000)
      const body = await httpThrough(sock, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n', 10000)
      const ip = String(body || '').trim()
      say('  ✅ HTTP-прокси ' + alt + ':' + T.cfg.port + ' работает за ' + (Date.now() - t0) + 'мс → ' + ip.slice(0, 40))
      say('  ℹ️ значит прокси ЖИВ, но в config.json нужен host=' + alt + ' (SOCKS5-порт у провайдера может отличаться)')
      liveHost = alt; liveIp = isIpV4(ip) ? ip : null
    } catch (e) { say('  ❌ ' + alt + ':' + T.cfg.port + ' — ' + String(e.message || e).slice(0, 160)) }
  }

  // 5. внешний IP через прокси
  if (liveHost) { T.okHost = liveHost; T.state = 'alive' } else T.state = 'dead'
  say(' 5. внешний IP: через прокси ' + (liveIp || '—') + (liveHost ? ' (хост ' + liveHost + ')' : '') + ' | напрямую ' + (directIp || '—'))
  if (liveIp && directIp) say(liveIp === directIp ? '  ⚠️ IP совпадают — прокси не подменяет адрес (трафик идёт мимо него?)' : '  ✅ IP разные — трафик действительно идёт через прокси')

  // 6. ссылка смены IP
  say(' 6. ссылка смены IP:')
  let ch = null, chUrl = ''
  if (!T.cfg.changeIpUrl || /YOUR_KEY/.test(T.cfg.changeIpUrl)) {
    say('  ⚠️ changeIpUrl не задан — IP меняться не будет, бот каждый раз заходит с одного адреса')
  } else {
    chUrl = ensureJsonParam(T.cfg.changeIpUrl)
    say('  проверяю: ' + chUrl + (chUrl !== T.cfg.changeIpUrl ? '   (автоматически добавил format=json)' : ''))
    const t0 = Date.now()
    try {
      const r = await plainGet(chUrl, 15000)
      ch = parseChangeIpResponse(r.status, r.body, chUrl)
      say('  HTTP ' + r.status + ' за ' + (Date.now() - t0) + 'мс → ответ: ' + ch.kind + (ch.newIp ? ', new_ip=' + ch.newIp : '') + (ch.rt ? ', rt=' + ch.rt + 'с' : '') + (ch.title ? ', title=«' + ch.title + '»' : ''))
      if (ch.text && ch.kind !== 'html') say('  текст: «' + ch.text.slice(0, 140) + '»')
      if (ch.kind === 'html') say('  ❌ это ВЕБ-СТРАНИЦА, а не ответ API — IP так не меняется. ' + ch.hint)
      else if (ch.rateLimited) say('  ⚠️ ' + ch.hint + ' (это не ошибка, просто подождите)')
      else if (ch.newIp) say('  ✅ ссылка рабочая, провайдер выдал ' + ch.newIp)
      else if (ch.kind === 'ok-text' || ch.kind === 'json') say('  ✅ ссылка отвечает; новый IP придёт следующим запросом (лимит 30 секунд)')
      else say('  ⚠️ ответ непонятный — сверьте ссылку с панелью провайдера')
    } catch (e) { say('  ❌ запрос не прошёл: ' + String(e.message || e).slice(0, 160)) }
    if (liveHost && ch && ch.newIp) {
      await sleep(4000)
      const nowIp = await currentIp({ T, proxyOnly: true, timeoutMs: 10000 })
      say('  проверка через прокси: текущий IP ' + (nowIp || '?') + (nowIp === ch.newIp ? ' ✅ совпал с new_ip' : (nowIp ? ' (отличается — провайдер ещё меняет адрес или new_ip устарел)' : '')))
    } else if (!liveHost) say('  ℹ️ проверить смену IP через прокси не могу — прокси не отвечает')
  }

  // 7. пинг MC-сервера через прокси
  say(' 7. Minecraft-сервер через прокси:')
  if (!liveHost) say('  ⏭ пропущено: нет живого прокси')
  else {
    const t0 = Date.now()
    try {
      const sock = await socks5Open({ host: liveHost, port: T.cfg.port, userId: T.cfg.username, password: T.cfg.password }, MC.host, MC.port, 15000)
      const r = await mcStatusPing(sock, 12000)
      if (r.ok) {
        const v = r.json && (r.json.version || {})
        say('  ✅ ' + MC.host + ':' + MC.port + ' отвечает через прокси за ' + r.ms + 'мс' + (v.name ? ' (сервер: ' + v.name + ', protocol ' + v.protocol + ')' : ''))
        const pl = r.json && r.json.players
        if (pl) say('     игроков: ' + pl.online + '/' + pl.max)
      } else say('  ❌ туннель открылся, но сервер не ответил на status-пинг: ' + r.err)
    } catch (e) { say('  ❌ не удалось: ' + String(e.message || e).slice(0, 160)) }
    say('  (замер ' + (Date.now() - t0) + 'мс)')
  }

  // 8. вердикт по туннелю
  if (liveHost) {
    T.ip = liveIp || T.ip
    say(' ВЕРДИКТ: ✅ ТУННЕЛЬ «' + T.name + '» ЖИВ: ' + liveHost + ':' + T.cfg.port + ', внешний IP ' + (liveIp || '?') + '.')
    if (ch && ch.kind === 'html') say('⚠️ осталось починить смену IP: замените changeIpUrl на ссылку из панели «Мои прокси» → «Смена IP» (вид https://changeip.mobileproxy.space/?proxy_key=XXXX&format=json).')
    else if (!chUrl) say('⚠️ добавьте changeIpUrl — иначе после бана IP бот не сможет его сменить.')
    return true
  }
  const refused = errs.filter(e => /ОТКАЗАЛ|ECONNREFUSED/i.test(e.msg)).length
  if (refused >= 1 && errs.length === hosts.length) {
    say(' ВЕРДИКТ: ❌ ТУННЕЛЬ «' + T.name + '» МЁРТВ: ни ' + hosts.join(', ') + ' на порту ' + T.cfg.port + ' не принимают TCP-соединение.')
    say('   Это НЕ ошибка бота: на том конце никто не слушает порт. Диагноз в 9 случаях из 10:')
    say('     • аренда мобильного прокси ИСТЕКЛА → панель «Мои прокси» → включить «Показать истёкшие» → «Продлить»')
    say('     • оборудование выключено/зависло → «Операции» → «Перезагрузить оборудование», затем «Сменить оборудование»')
    say('     • порт/логин/пароль в config.json не совпадают с тем, что сейчас в панели')
    if (directIp) say('   Временно можно включить "proxy": { "allowDirect": true } — бот пойдёт напрямую с IP ' + directIp + ' (FunTime может быстро забанить такой IP).')
  } else {
    say(' ВЕРДИКТ: ❌ туннель «' + T.name + '» не работает. Ошибки по хостам:')
    for (const e of errs) say('   • ' + e.host + ' — ' + e.msg.slice(0, 160))
    say('   Проверьте: прокси включён в панели? порт тот же? логин/пароль свежие? ваш провайдер не блокирует исходящие на порт ' + T.cfg.port + '?')
  }
  return false
}

async function runProxyCheck() {
  step('=== ДИАГНОСТИКА ПРОКСИ/ТУННЕЛЕЙ (v5.1.1) ===')
  step('модуль socks: ' + (SocksClient ? 'установлен' : 'НЕТ (используется встроенный SOCKS5-клиент)'))
  if (!TUNNELS.length) {
    step('❌ в config.json нет ни секции "tunnels", ни proxy.host — заход возможен только напрямую')
    step('   Пропишите мобильный прокси: "proxy": { "host": "bproxy.site", "port": 23750, "username": "...", "password": "..." }')
    if (!CAP.allowDirect) return false
    const directIp = await currentIp({ directOnly: true })
    step('   proxy.allowDirect=true — бот будет ходить напрямую, ваш IP: ' + (directIp || '?') + ' (FunTime может быстро забанить его)')
    return !!directIp
  }
  let allOk = true
  for (const T of distinctPhysical(TUNNELS)) {   // v5.1: один физканал не диагностируется дважды
    const ok = await checkOneTunnel(T)
    if (!ok) allOk = false
    step('')
  }
  step('=== ИТОГ: ' + TUNNELS.map(T => '«' + T.name + '» ' + (T.state === 'alive' ? 'ЖИВ' : 'МЁРТВ')).join(', ') + ' ===')
  if (allOk) step('Можно запускать: node main.js')
  return allOk
}
async function mcStatusPing(sock, timeoutMs) {
  const varint = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x) } while (n); return Buffer.from(b) }
  const pkt = body => Buffer.concat([varint(body.length), body])
  const hsBody = Buffer.concat([
    varint(0x00), varint(767), varint(Buffer.byteLength(MC.host)), Buffer.from(MC.host, 'utf8'),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(MC.port, 0); return b })(), varint(1)
  ])
  return new Promise(resolve => {
    let done = false, buf = Buffer.alloc(0), t0 = Date.now()
    const fin = r => { if (done) return; done = true; try { clearTimeout(to) } catch (e) {}; try { sock.destroy() } catch (e) {}; resolve(r) }
    const to = setTimeout(() => fin({ ok: false, err: 'таймаут ' + Math.round((timeoutMs || 12000) / 1000) + 'с' }), timeoutMs || 12000)
    sock.on('error', e => fin({ ok: false, err: e.message }))
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      if (buf.length < 3) return
      let len = 0, shift = 0, i = 0
      for (; i < Math.min(5, buf.length); i++) { const b = buf[i]; len |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) { i++; break } }
      if (buf.length < i + len) return
      const s = buf.slice(i, i + len).toString('utf8')
      const m = s.match(/\{[\s\S]*\}/)
      if (m) {
        let j = null; try { j = JSON.parse(m[0]) } catch (e) {}
        fin({ ok: true, ms: Date.now() - t0, json: j })
      } else fin({ ok: true, ms: Date.now() - t0, raw: s.slice(0, 120) })
    })
    try { sock.write(Buffer.concat([pkt(hsBody), pkt(Buffer.from([0x00]))])) } catch (e) { fin({ ok: false, err: 'write: ' + e.message }) }
  })
}
// ========================= ВЕРСИЯ СЕРВЕРА: АВТООПРЕДЕЛЕНИЕ (v5.1.1) =========================
// status-пинг через туннель: BotFilter отвечает даже без логина. Имя версии бывает «грязным»
// («BotFilter 1.8.x-26.x») — тогда версию даём по номеру протокола.
const PROTOCOL_VERSIONS = {
  754: '1.16.5', 755: '1.17', 756: '1.17.1', 757: '1.18.1', 758: '1.18.2',
  759: '1.19', 760: '1.19.2', 761: '1.19.3', 762: '1.19.4', 763: '1.20.1',
  764: '1.20.2', 765: '1.20.4', 766: '1.20.6', 767: '1.21.1', 768: '1.21.3',
  769: '1.21.4', 770: '1.21.5', 771: '1.21.6', 772: '1.21.7'
}
function protocolToVersion(p) { return PROTOCOL_VERSIONS[Number(p)] || null }
function cleanVersionName(name) {
  const m = String(name || '').trim().match(/^v?(\d+\.\d+(?:\.\d+)?)$/i)
  return m ? m[1] : null
}
async function detectMcVersion(T, timeoutMs) {
  try {
    const sock = await proxyConnect(MC.host, MC.port, 15000, T)
    return await mcStatusPing(sock, timeoutMs || 8000)    // mcStatusPing сам закрывает сокет
  } catch (e) { return { ok: false, err: String((e && e.message) || e) } }
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

// максимальный разброс yaw в группе (с учётом перехода через ±PI)
function yawSpread(frames) {
  const ys = frames.map(f => f.yaw).filter(v => typeof v === 'number' && isFinite(v))
  if (ys.length < 2) return 0
  let maxGap = 0
  const sorted = ys.slice().sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1])
  const wrap = (sorted[0] + Math.PI * 2) - sorted[sorted.length - 1]
  // наибольший «пустой» сектор => все остальные лежат в дуге (2PI - maxGap)
  const largest = Math.max(maxGap, wrap)
  return Math.round((Math.PI * 2 - largest) * 1000) / 1000
}

// максимальный промежуток между соседними центрами колонок/строк сетки
function maxGridGap(centers) {
  if (!centers || centers.length < 2) return 0
  const s = centers.slice().sort((a, b) => a - b)
  let g = 0
  for (let i = 1; i < s.length; i++) g = Math.max(g, s[i] - s[i - 1])
  return Math.round(g * 1000) / 1000
}

// все плоскости-стены: x=const и z=const.
// Отбрасываем:
//  • «линии» (ряд рамок в одну строку/колонку);
//  • СКВОЗНЫЕ артефакты: если на сервере две параллельные стены капчи, рамки
//    обеих стен с одинаковым x попадают в одну «плоскость» x=const, но колонки
//    у неё рваные (промежуток в несколько блоков) и yaw рамок смотрит в
//    противоположные стороны. Именно так в v3.8.0 раунд 6 выбрал мусорную
//    «стену» 2×3 вместо настоящей 4×3.
function detectWalls(frames, minFrames) {
  const walls = []
  for (const axis of ['x', 'z']) {
    const horiz = axis === 'x' ? 'z' : 'x'
    const cl = clusterValues(frames.map(f => f[axis]), 0.45)
    for (const c of cl) {
      const members = frames.filter(f => Math.abs(f[axis] - c.value) <= 0.45)
      if (members.length < (minFrames || 4)) continue
      const hC = clusterValues(members.map(f => f[horiz]), 0.45).map(x => x.value)
      const yC = clusterValues(members.map(f => f.y), 0.45).map(x => x.value)
      if (hC.length < 2 || yC.length < 2) continue
      const gap = Math.max(maxGridGap(hC), maxGridGap(yC))
      const ys = yawSpread(members)
      const contiguous = gap <= 1.3
      // жёстко отбрасываем явные сквозные артефакты
      if (gap > 2.5) continue
      if (ys > 2.2) continue
      walls.push({
        axis, value: c.value, frames: members, tag: axis + Math.round(c.value),
        span: hC.length + '×' + yC.length, gap, contiguous, yawSpread: ys
      })
    }
  }
  walls.sort((a, b) => (b.contiguous - a.contiguous) || (b.frames.length - a.frames.length))
  return walls
}

// расстояние от точки обзора до центра стены
function wallDist(wall, view) {
  if (!view || typeof view.x !== 'number') return null
  let cx = 0, cy = 0, cz = 0
  for (const f of wall.frames) { cx += f.x; cy += f.y; cz += f.z }
  const n = wall.frames.length || 1
  cx /= n; cy /= n; cz /= n
  const dx = cx - view.x, dy = cy - (view.y + 1.6), dz = cz - view.z
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100
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
  // По умолчанию ВЫКЛЮЧЕНО: координаты рамок — это истина, а перестановка
  // может «улучшить» швы на удачном совпадении и испортить правильную картинку.
  // Включается capture.tryColPerms=true / --perms, если раскладка реально едет.
  const tryPerms = opts.tryPerms != null ? opts.tryPerms : TRY_COL_PERMS
  if (cols >= 3 && cols <= 6 && tryPerms && natCost > PERM_TRIGGER) {
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
// ========================= ЗАПИСЬ РАУНДА (облегчённая, v4.0.0) =========================
// Сохраняет собранную картинку и диагностику выбора стены. Локальной сегментации/глифов
// больше нет: цифры приходят из облака (Roboflow) или YOLO-сервера уже ПОСЛЕ записи.
function saveRound(outDir, snap, label, roundNo, opts) {
  opts = opts || {}
  fs.mkdirSync(outDir, { recursive: true })
  const frames = (snap.frames || []).map(f => Object.assign({}, f))
  const tiles = snap.maps
  fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(frames, null, 2))
  fs.writeFileSync(path.join(outDir, 'chat.log'), (snap.chats || []).join('\n'))
  fs.writeFileSync(path.join(outDir, 'session_log.txt'), (snap.events || []).join('\n'))
  if (snap.view) fs.writeFileSync(path.join(outDir, 'view.json'), JSON.stringify(snap.view, null, 2))
  try { fs.writeFileSync(path.join(outDir, 'metadata_dump.json'), JSON.stringify(snap.metaDump || [], null, 2)) } catch (e) {}

  const linked = frames.filter(f => f.mapId !== null && f.mapId !== undefined && tiles.has(f.mapId))
  step(label + ': frames=' + frames.length + ' linked=' + linked.length + ' maps=' + tiles.size)

  if (!linked.length) {
    const d = [
      'ДИАГНОСТИКА: нет ни одной рамки со ссылкой на карту (map_id).',
      'frames всего: ' + frames.length + ', карт получено (map_data): ' + tiles.size,
      'Смотрите metadata_dump.json — там сырые метаданные рамок.',
      'Если файл пустой, значит метаданные item_frame не приходят вовсе.'
    ]
    fs.writeFileSync(path.join(outDir, 'DIAGNOSTICS.txt'), d.join('\n') + '\n')
    step(label + ': ❌ нет linked-рамок (см. DIAGNOSTICS.txt)')
    return null
  }

  const minFrames = wallMinFrames(linked.length)
  const walls = detectWalls(linked, minFrames)
  if (!walls.length) {
    step(label + ': ❌ стен не найдено (нужно ≥' + minFrames + ' рамок в одной плоскости, без рваных сеток)')
    fs.writeFileSync(path.join(outDir, 'FAIL.txt'), 'no walls detected; linked=' + linked.length + '\n')
    return null
  }
  step(label + ': плоскостей-кандидатов: ' + walls.map(w => w.tag + '(' + w.frames.length + ',gap' + w.gap + ')').join(', '))

  const stats = []
  for (const w of walls.slice(0, 6)) {
    let asm = null
    try { asm = assembleWallSmart(w, tiles, snap.view, {}) } catch (e) { step(label + ' ' + w.tag + ': assemble err ' + e.message) }
    if (!asm) continue

    const im = inkMaskWall(asm.data, asm.W, asm.H)
    const like = captchaLikeness(asm)

    const dot = wallDot(w, snap.view)
    const dist = wallDist(w, snap.view)
    const fillRatio = asm.placed / Math.max(1, asm.grid.total)

    // ---- скоринг: ГЕОМЕТРИЯ решает всё (локального распознавания больше нет) ----
    const seamPenalty = Math.max(0, asm.seamCost <= 25 ? asm.seamCost * 12 : 300 + (asm.seamCost - 25) * 40)
    const sizeBonus = asm.placed * 90
    const fillBonus = Math.round(fillRatio * 1500)
    // Дистанция — самый надёжный признак: бота телепортируют вплотную к СВОЕЙ капче
    // (в логах 2.4-3.7 блока у правильной стены и десятки у соседней).
    // yaw (dot) ненадёжен: сервер не всегда его ставит, поэтому вес маленький.
    const distBonus = dist === null ? 0
      : (dist <= 6 ? 2200 : dist <= 12 ? 1500 : dist <= 20 ? 700 : dist <= 35 ? 0 : dist <= 60 ? -1500 : -3000)
    const dotBonus = dot === null ? 0
      : (dot >= 0.7 ? 500 : dot >= 0.2 ? 150 : dot >= -0.3 ? -150 : -500)
    const gapPenalty = w.contiguous ? 0 : 1200
    const yawPenalty = w.yawSpread > 0.6 ? 1500 : 0
    const score = Math.round(sizeBonus + fillBonus + dotBonus + distBonus - seamPenalty - gapPenalty - yawPenalty)

    stats.push({
      w, asm, im, like, dot, dist, fillRatio, score,
      breakdown: {
        sizeBonus, fillBonus, dotBonus, distBonus,
        seamPenalty: Math.round(seamPenalty), gapPenalty, yawPenalty,
        seamCost: asm.seamCost, contiguous: w.contiguous, gap: w.gap, yawSpread: w.yawSpread,
        inkDensity: Math.round((im.inkCount / (asm.W * asm.H)) * 10000) / 10000,
        ocrHint: (like && like.ocr && like.ocr.text) || ''
      }
    })
  }

  if (!stats.length) { step(label + ': ❌ ни одна стена не собралась'); fs.writeFileSync(path.join(outDir, 'FAIL.txt'), 'no wall assembled\n'); return null }
  stats.sort((a, b) => b.score - a.score)
  const best = stats[0]
  const asm = best.asm

  // ---- отладка выбора стены ----
  try {
    fs.writeFileSync(path.join(outDir, 'walls_debug.json'), JSON.stringify({
      chosen: best.w.tag, view: snap.view || null,
      candidates: stats.map(s => Object.assign({ wall: s.w.tag, axis: s.w.axis, value: s.w.value,
        cols: s.asm.grid.cols, rows: s.asm.grid.rows, placed: s.asm.placed, total: s.asm.grid.total,
        orientation: s.asm.ori.tag, rotationRule: s.asm.rotRule, permUsed: s.asm.permUsed,
        score: s.score }, s.breakdown))
    }, null, 2))
  } catch (e) {}

  // ---- сохраняем лучшую ----
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA.png'), colorPng(asm.data, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_x1.png'), colorPng(asm.data, asm.W, asm.H, 1))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_raw.bin'), Buffer.from(asm.data))
  fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify(asm.layout, null, 2))
  fs.writeFileSync(path.join(outDir, 'assembly_debug.json'), JSON.stringify({
    wall: best.w.tag, axis: best.w.axis, value: best.w.value, gap: best.w.gap, contiguous: best.w.contiguous,
    yawSpread: best.w.yawSpread,
    cols: asm.grid.cols, rows: asm.grid.rows, cells: asm.grid.total,
    placed: asm.placed, missing: asm.missing, holesFilled: asm.holesFilled, holeAssignments: asm.holeAssignments,
    orientation: asm.ori, rotationRule: asm.rotRule, permUsed: asm.permUsed, colPerm: asm.colPerm,
    seamCost: asm.seamCost, natSeamCost: asm.natSeamCost, permSeamCost: asm.permSeamCost,
    view: snap.view || null, dot: best.dot, dist: best.dist, trials: asm.trials,
    inkDensity: best.fillRatio, ocrHint: best.breakdown.ocrHint
  }, null, 2))

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
        seamCost: asm.seamCost, score: best.score, dot: best.dot, dist: best.dist,
        ocrHint: best.breakdown.ocrHint,
        candidates: stats.map(s => ({ wall: s.w.tag, score: s.score, cols: s.asm.grid.cols, rows: s.asm.grid.rows })),
        dir: path.relative(REC_ROOT, outDir), view: snap.view || null
      }, null, 2))
    } catch (e) { step('captchas copy err: ' + e.message) }
  }

  step(label + ': ✅ ORIGINAL=' + best.w.tag + ' ' + asm.grid.cols + '×' + asm.grid.rows +
    ' placed=' + asm.placed + '/' + asm.grid.total +
    ' ori=' + asm.ori.tag + '(hAsc=' + asm.ori.hAsc + ')' +
    ' rot=' + asm.rotRule + (asm.permUsed ? ' PERM!' : '') +
    ' seam=' + asm.seamCost + ' dot=' + (best.dot === null ? '?' : best.dot.toFixed(2)) +
    ' dist=' + (best.dist === null ? '?' : best.dist) +
    ' score=' + best.score + ' / конкуренты: ' + stats.slice(1).map(s => s.w.tag + '=' + s.score).join(','))
  if (asm.seamCost > SEAM_WARN) {
    step(label + ': ⚠️ ВНИМАНИЕ: швы плохие (seam=' + asm.seamCost + ' > ' + SEAM_WARN +
      ') — картинка может быть собрана неверно. Проверьте ORIGINAL_CAPTCHA.png' +
      (TRY_COL_PERMS ? '' : '; при необходимости запустите с --perms'))
  }

  return {
    wall: best.w.tag, cols: asm.grid.cols, rows: asm.grid.rows,
    tilesCount: asm.placed, tilesExpected: asm.grid.total, missing: asm.missing, holesFilled: asm.holesFilled,
    ori: asm.ori.tag, hAsc: asm.ori.hAsc, yAsc: asm.ori.yAsc, rotRule: asm.rotRule, permUsed: asm.permUsed, colPerm: asm.colPerm,
    seamCost: asm.seamCost, natSeamCost: asm.natSeamCost, score: best.score, dot: best.dot, dist: best.dist,
    ocrHint: best.breakdown.ocrHint, inkDensity: best.breakdown.inkDensity,
    pngFile: path.join(outDir, 'ORIGINAL_CAPTCHA_x1.png'),
    pngFile2x: path.join(outDir, 'ORIGINAL_CAPTCHA.png'),
    png2x: colorPng(asm.data, asm.W, asm.H, 2),
    candidates: stats.map(s => ({ wall: s.w.tag, score: s.score, breakdown: s.breakdown })),
    layout: asm.layout, dir: outDir, capFile, originalFile: 'ORIGINAL_CAPTCHA.png'
  }
}
// классификатор ошибок разбора протокола (текст зависит от версии minecraft-protocol/protodef)
function isProtocolParseError(msg) {
  return /Parse error for|Deserialization error for|Serialization error for|Read error for undefined/i.test(String(msg || ''))
}

// ========================= ЗАХОД: подключение и ЖИВОЕ соединение =========================
// В отличие от v3.x (снял картинку → отключился), здесь после сборки капчи соединение
// ОСТАЁТСЯ ЖИВЫМ: через handle.chat() бот отправляет ответ, слушает реакцию сервера
// (успех / «неверно» / кик / новая капча), регистрируется и остаётся в игре.
function connectAndSolve(tag, opt) {
  opt = opt || {}
  return new Promise(resolve => {
    const T = opt.T || TUNNELS[0] || null
    const col = {
      maps: new Map(), mapFilled: new Map(), mapUpdatedAt: new Map(),
      frames: [], framesById: new Map(), chats: [], events: [], prompts: 0,
      dead: false, reason: '', metaDump: [], firstFrameAt: 0, lastMapAt: 0, lastChangeAt: 0,
      parseErrs: 0     // v5.1.1: ошибки разбора пакетов (несмертельны; признак «чужой» версии)
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
      const cells = grid.cells.filter(f => f && col.maps.has(f.mapId))
      const have = cells.length
      // плитка ПОЛНОСТЬЮ получена, если пришли все 16384 байта (128×128) —
      // это намного быстрее, чем ждать «тишины» в потоке пакетов.
      const full = cells.filter(f => (col.mapFilled.get(f.mapId) || 0) >= 16384).length
      const allComplete = full >= grid.total && grid.total > 0
      const stableMs = FAST_MODE ? FAST.stableMs : CAP.stableMs
      // «тишина»: ни новых рамок, ни новых метаданных, ни новых байт карты
      const quiet = col.lastChangeAt ? (Date.now() - col.lastChangeAt) >= stableMs : true
      const need = Math.max(CAP.minTiles, Math.ceil(grid.total * MIN_TILES_FRACTION))
      const enough = have >= Math.min(need, grid.total)
      const promptOk = CAP.needPrompt ? col.prompts >= 1 : true
      const ok = enough && (allComplete || quiet) && promptOk
      return {
        ready: ok, allComplete, full,
        why: ok ? (allComplete ? 'ok(все байты)' : 'ok(тишина)')
          : (!enough ? 'не хватает плиток (' + have + '/' + Math.min(need, grid.total) + ')'
            : (!quiet ? 'ждём тишины ' + stableMs + 'мс' : 'ждём промпт капчи')),
        have, need: Math.min(need, grid.total), total: grid.total, quiet
      }
    }

    const clearPhaseTimers = () => {
      for (const t of [hardT, loginT, spawnT, settleT]) { try { if (t) clearTimeout(t) } catch (e) {} }
    }
    const botView = () => {
      try { if (bot && bot.entity && bot.entity.position) return { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch } } catch (e) {}
      return null
    }
    const snapCopy = () => ({
      maps: new Map(col.maps), frames: col.frames.map(f => Object.assign({}, f)),
      chats: col.chats.slice(), events: col.events.slice(), view: botView(),
      metaDump: col.metaDump.slice(0, 6), lastChangeAt: col.lastChangeAt, prompts: col.prompts
    })

    // провал ДО получения картинки (соединение закрывается)
    const finishFail = note => {
      if (finished) return
      finished = true
      clearPhaseTimers()
      try { if (pollT) clearInterval(pollT) } catch (e) {}
      try { if (bot) bot.end('fail') } catch (e) {}
      resolve({ ok: false, note: note || col.reason || 'fail' })
    }

    // картинка собрана → переходим в ЖИВУЮ фазу: ответ в чат, регистрация, удержание
    const goLive = note => {
      if (finished) return
      finished = true
      clearPhaseTimers()
      const live = {
        tag, T,
        get bot() { return bot },
        snap: snapCopy,
        chatsLen: () => col.chats.length,
        chatsFrom: m => col.chats.slice(Number(m) || 0),
        chat(text) {
          try { bot.chat(String(text)); ev('💬 chat → «' + String(text).slice(0, 40) + '»'); return true }
          catch (e) { ev('chat err: ' + e.message); return false }
        },
        isDead: () => !!col.dead,
        deadReason: () => col.reason || '',
        parseErrs: () => col.parseErrs || 0,   // v5.1.1: диагностика версии протокола
        lastChange: () => col.lastChangeAt,
        readiness: () => { try { return readiness() } catch (e) { return { ready: false, why: e.message } } },
        // ждать закрытия соединения (кик/таймаут сервера): true = соединение умерло
        async waitDead(ms) {
          const t0 = Date.now()
          while (Date.now() - t0 < (ms || 30000)) {
            if (col.dead) return true
            await sleep(150)
          }
          return col.dead
        },
        // ждать, пока придут СВЕЖИЕ данные карты (сервер показал новую капчу) и поток затихнет
        async waitFreshWall(ms) {
          const base = col.lastChangeAt
          const t0 = Date.now()
          let changed = false
          while (Date.now() - t0 < (ms || 20000)) {
            if (col.dead) return false
            if (!changed && col.lastChangeAt > base) changed = true
            if (changed) {
              const quietMs = FAST_MODE ? FAST.stableMs : Math.min(900, CAP.stableMs)
              if (Date.now() - col.lastChangeAt >= quietMs) {
                const rd = readiness()
                if (rd.ready) return true
              }
            }
            await sleep(200)
          }
          return false
        },
        end(reason) {
          try { if (pollT) clearInterval(pollT) } catch (e) {}
          pollT = null
          try { if (bot) bot.end(reason || 'done') } catch (e) {}
        }
      }
      resolve({ ok: true, live, note: note || '' })
    }

    if (!mineflayer) { finishFail('mineflayer не установлен (npm i mineflayer)'); return }
    hardT = setTimeout(() => {
      const r = readiness()
      ev('жёсткий таймаут ' + (CAP.timeoutMs / 1000) + 'с: have=' + r.have + '/' + (r.total || '?'))
      if (r.have >= CAP.minTiles && !col.dead) goLive('timeout-but-tiles(have=' + r.have + ')')
      else finishFail('timeout(have=' + r.have + ')')
    }, CAP.timeoutMs)

    proxyConnect(MC.host, MC.port, CONNECT_TIMEOUT_MS, T).then(sock => {
      const conn = { socket: sock }
      ev('туннель ' + (T ? '«' + T.name + '» ' : '(direct) ') + 'ok -> ' + MC.host + ':' + MC.port +
        (T && T.okHost && T.okHost !== T.cfg.host ? ' (через резерв ' + T.okHost + ')' : ''))
      const nick = opt.nick || randomNick()
      col.nick = nick
      const tConn = Date.now()
      spawnT = setTimeout(() => { if (!finished) finishFail('spawn timeout') }, CONNECT_TIMEOUT_MS)
      loginT = setTimeout(() => { if (!finished) { ev('login timeout ' + (LOGIN_TIMEOUT_MS / 1000) + 'с'); finishFail('login timeout') } }, LOGIN_TIMEOUT_MS)

      bot = mineflayer.createBot({
        username: nick, host: MC.host, port: MC.port, version: MC.version,
        socket: conn.socket, hideErrors: true, auth: 'offline', keepAlive: true, checkTimeoutInterval: 60000   // v5-фикс: опция В МС (было 60 → обрыв через 60мс)
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
        const f = { id, x: pos.x, y: pos.y, z: pos.z, mapId: null, rotation: 0, metaSeen: false, yaw: (pos && typeof pos.yaw === 'number') ? pos.yaw : null }
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
          const pos = { x: ent.position.x, y: ent.position.y, z: ent.position.z, yaw: (typeof ent.yaw === 'number' ? ent.yaw : null) }
          const f = addFrame(ent.id, pos, info)
          if (f && !f.metaSeen && ent.metadata) applyMeta(f, ent.metadata)
          dbg('frame #' + ent.id + ' ' + String(ent.name || ent.displayName || '') + ' @' + ent.position.x.toFixed(2) + ',' + ent.position.y.toFixed(2) + ',' + ent.position.z.toFixed(2) + (f && f.mapId !== null ? ' map=' + f.mapId + ' rot=' + f.rotation : ''))
        } catch (e) { dbg('entitySpawn err ' + e.message) }
      })

      // имя пакета метаданных differs по версиям: слушаем все варианты сразу
      const onMetaPkt = pk => {
        try {
          const f = col.framesById.get(pk.entityId)
          if (f) { applyMeta(f, pk.metadata); return }
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
            let adopt = isFrameName(e)
            let info = null
            if (!adopt && e.metadata) {
              info = extractFrameInfo(e.metadata)
              adopt = !!(info && info.mapId !== null && info.mapId !== undefined)
            }
            if (!adopt) continue
            f = addFrame(id, { x: e.position.x, y: e.position.y, z: e.position.z, yaw: (typeof e.yaw === 'number' ? e.yaw : null) }, info)
            if (adopt && !isFrameName(e)) ev('внимание: сущность #' + id + ' (' + String(e.name || e.type || '?') + ') не item_frame, но держит карту — считаю рамкой')
          }
          if (f && typeof e.yaw === 'number' && f.yaw === null) f.yaw = e.yaw
          if (f && e.metadata && (f.mapId === null || f.mapId === undefined || !f.metaSeen)) applyMeta(f, e.metadata)
        }
      }

      // ---------- чат / title / actionbar ----------
      const PROMPT_RE = /введи|введите|номер|цифр|капч|captcha|код с|число/i
      const onText = (t, src) => {
        const s = String(t || '')
        if (!s) return
        col.chats.push('[' + src + '] ' + s)
        col.lastChatAt = Date.now()
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
        col.dead = true; col.reason = 'kicked'
        const why = String((r && (r.reason || r.message)) || r || '').slice(0, 200)
        ev('kicked: ' + why)
        col.kickReason = why
        if (!finished) {
          const rd = readiness()
          // для решателя мёртвое соединение бесполезно даже с собранной картинкой —
          // ответ отправить некому, это провал захода
          setTimeout(() => { if (!finished) finishFail('kicked(have=' + rd.have + ') ' + why.slice(0, 80)) }, 300)
        }
      })
      bot.on('end', reason => {
        col.dead = true
        if (!col.reason) col.reason = 'end: ' + String(reason || '').slice(0, 100)
        if (!finished) {
          ev(col.reason)
          const rd = readiness()
          setTimeout(() => { if (!finished) finishFail(col.reason + '(have=' + rd.have + ')') }, 300)
        }
      })
      bot.on('error', e => {
        const msg = String((e && e.message) || e)
        if (finished) {
          // v5.1.1: ЖИВАЯ ФАЗА — ошибка сама по себе НЕ убивает сессию. minecraft-protocol
          // при ошибке разбора переподключает стрим и продолжает (пакет потерян, соединение
          // живо); реальную смерть ловят обработчики 'end'/'kicked'. Раньше здесь ставился
          // col.dead=true → «Parse error for play.toClient: Read error for undefined»
          // (сервер/BotFilter прислал пакет, неизвестный протоколу версии) ронял рабочий заход.
          if (col.events.length < 3000) col.events.push(new Date().toISOString().slice(11, 23) + ' error(live): ' + msg.slice(0, 200))
          if (isProtocolParseError(msg)) {
            col.parseErrs++
            if (col.parseErrs === 1 || col.parseErrs % 25 === 0) {
              ev('⚠️ ошибка разбора пакета #' + col.parseErrs + ' (НЕ фатально, соединение живо): ' + msg.slice(0, 170))
              if (col.parseErrs === 1) ev('   ↳ сервер прислал пакет, неизвестный протоколу ' + MC.version + ' — часто это кастомные пакеты BotFilter/бэкенда; если ошибки сыплются постоянно и что-то не работает: node main.js --proxy-check (версия сервера) и minecraft.version в конфиге')
            }
          } else {
            ev('error(live, не фатально): ' + msg.slice(0, 170))
          }
          return
        }
        col.dead = true
        if (!col.reason) col.reason = 'error: ' + msg
        ev(col.reason)
        const rd = readiness()
        if (rd.have < CAP.minTiles) finishFail(col.reason)
      })

      pollT = setInterval(() => {
        try { scanEntities() } catch (e) {}
        if (finished) return          // живая фаза: только сканим сущности, готовность не проверяем
        const rd = readiness()
        if (rd.ready) {
          // v5: при ПОЛНЫХ данных всех плиток добор не нужен — 150мс вместо 800мс
          const settleMs = FAST_MODE ? FAST.settleMs : (rd.allComplete ? Math.min(150, SETTLE_MS) : SETTLE_MS)
          if (!readySince) { readySince = Date.now(); ev('данные готовы (' + rd.why + '): ' + rd.have + '/' + rd.total + ' — добираю ' + settleMs + 'мс') }
          if (!settleT) settleT = setTimeout(() => goLive('captured ' + rd.have + '/' + rd.total + ' ' + rd.why), settleMs)
        } else {
          readySince = 0
          if (settleT) { clearTimeout(settleT); settleT = null }
        }
      }, 300)
    }).catch(e => {
      const msg = String((e && e.message) || e)
      ev('socks fail: ' + msg)
      const hint = socksHint(msg, T)
      if (hint) hint.split('\n').forEach(l => ev(l))
      finishFail('socks: ' + msg)
    })
  })
}
// ========================= РАСПОЗНАВАНИЕ (только внешние сервисы) =========================
// Локальной нейросети больше нет: текст картинки дают облако Roboflow (основной путь)
// и/или YOLO HTTP-серверы (yolo_server.py). Все запросы сериализуются общей очередью —
// параллельные боты не устраивают гонку по Cloudflare-лимиту и не жгут кредиты впустую.
let recQueue = Promise.resolve()
function doRecognize(png, label) {
  if (RF.ready) return yoloRecognize(png, label)          // внутри: сначала Roboflow, потом запасные URL
  if (YOLO.enabled) return yoloRecognize(png, label)      // облако не настроено — только запасные
  return Promise.resolve(null)
}
function recognizePng(png, label) {
  const run = () => doRecognize(png, label)
  const p = recQueue.then(run, run)
  recQueue = p.catch(() => {})
  return p
}

// ========================= ВЕРДИКТ СЕРВЕРА ПОСЛЕ ОТВЕТА =========================
// Ждём реакцию сервера на отправленные цифры: успех / «неверно» / кик / новая капча / тишина.
// kind: 'success' | 'auth' | 'fail' | 'kick' | 'newwall' | 'timeout'
async function waitVerdict(live, opt) {
  opt = opt || {}
  const ms = Math.max(1500, Number(opt.ms) || SOLVER.verifyMs)
  const mark = Number(opt.mark) || 0
  const baseChange = Number(opt.baseChange) || 0
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (live.isDead()) return { kind: 'kick', reason: live.deadReason(), ms: Date.now() - t0 }
    const lines = live.chatsFrom(mark)
    for (const ln of lines) {
      const wS = matchAny(ln, SOLVER.successWords); if (wS) return { kind: 'success', line: ln, word: wS, ms: Date.now() - t0 }
      const wA = matchAny(ln, SOLVER.authWords);    if (wA) return { kind: 'auth', line: ln, word: wA, ms: Date.now() - t0 }
      const wF = matchAny(ln, SOLVER.failWords);    if (wF) return { kind: 'fail', line: ln, word: wF, ms: Date.now() - t0 }
    }
    // сервер молчит, но показывает НОВУЮ капчу (свежие байты карт + стена снова готова) —
    // это значит прошлый ответ не принят
    if (baseChange && live.lastChange() > baseChange) {
      const rd = live.readiness()
      if (rd.ready || (Date.now() - live.lastChange() >= 1200)) return { kind: 'newwall', ms: Date.now() - t0 }
    }
    await sleep(250)
  }
  if (live.isDead()) return { kind: 'kick', reason: live.deadReason(), ms: Date.now() - t0 }
  return { kind: SOLVER.unknownIsSuccess ? 'success' : 'timeout', ms: Date.now() - t0, unknown: true }
}

// ========================= АВТОРИЗАЦИЯ: /reg или /l (v5: loginFirst для базы) =========================
// kind: 'ok' | 'exists' | 'notreg' | 'fail' | 'kick' | 'timeout'
async function waitAuthResult(live, mark, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < (ms || SOLVER.regVerifyMs)) {
    if (live.isDead()) return { kind: 'kick', reason: live.deadReason() }
    for (const ln of live.chatsFrom(mark)) {
      const wO = matchAny(ln, SOLVER.regOkWords);      if (wO) return { kind: 'ok', line: ln, word: wO }
      const wN = matchAny(ln, SOLVER.regNotRegWords);  if (wN) return { kind: 'notreg', line: ln, word: wN }
      const wE = matchAny(ln, SOLVER.regExistsWords);  if (wE) return { kind: 'exists', line: ln, word: wE }
      const wF = matchAny(ln, SOLVER.regFailWords);    if (wF) return { kind: 'fail', line: ln, word: wF }
    }
    await sleep(250)
  }
  if (live.isDead()) return { kind: 'kick', reason: live.deadReason() }
  return { kind: 'timeout' }
}

// opt.loginFirst — аккаунт ИЗ БАЗЫ (status='registered'): сначала /l, при «не зарегистрированы»
// или провале — /reg. Новый аккаунт: /reg → (exists) /l.
async function authPhase(live, w, label, opt) {
  opt = opt || {}
  if (!ACCOUNTS.regTemplate && !ACCOUNTS.loginTemplate) return { ok: true, via: 'skip' }
  await sleep(SOLVER.regDelayMs)
  if (live.isDead()) return { ok: false, stage: 'reg', kind: 'kick', reason: live.deadReason() }
  const pass = w.pass

  // ---- режим базы: /l первым ----
  if (opt.loginFirst && ACCOUNTS.loginTemplate) {
    let markL = live.chatsLen()
    live.chat(buildAuthCommand(ACCOUNTS.loginTemplate, pass))
    step(label + ': 🔑 /l отправлен (аккаунт из базы, ник «' + w.nick + '»)')
    const resL = await waitAuthResult(live, markL, SOLVER.regVerifyMs)
    if (resL.kind === 'ok') { step(label + ': ✅ вход подтверждён: ' + String(resL.line || '').slice(0, 90)); return { ok: true, via: 'login', line: resL.line } }
    if (resL.kind === 'kick') return { ok: false, stage: 'login', kind: 'kick', reason: resL.reason }
    if (resL.kind === 'notreg') step(label + ': сервер: «не зарегистрированы» — ухожу на /reg')
    else step(label + ': ⚠️ /l не принят (' + resL.kind + (resL.line ? ': ' + String(resL.line).slice(0, 70) : '') + ') — пробую /reg')
  }

  let mark = live.chatsLen()
  const regCmd = buildAuthCommand(ACCOUNTS.regTemplate, pass)
  if (regCmd) {
    live.chat(regCmd)
    step(label + ': 🔑 /reg отправлен (ник «' + w.nick + '», пароль не печатаем)')
    let res = await waitAuthResult(live, mark, SOLVER.regVerifyMs)
    if (res.kind === 'ok') { step(label + ': ✅ регистрация подтверждена: ' + String(res.line || '').slice(0, 90)); return { ok: true, via: 'reg', line: res.line } }
    if (res.kind === 'exists') {
      step(label + ': аккаунт уже существует — пробую /l («' + String(res.line || '').slice(0, 70) + '»)')
    } else if (res.kind === 'fail' || res.kind === 'notreg') {
      // сервер не принял пароль/команду — один повтор со свежим паролем, затем /l
      step(label + ': ⚠️ /reg не принят: ' + String(res.line || '').slice(0, 90))
      w.pass = randomPass()
      mark = live.chatsLen()
      live.chat(buildAuthCommand(ACCOUNTS.regTemplate, w.pass))
      res = await waitAuthResult(live, mark, SOLVER.regVerifyMs)
      if (res.kind === 'ok') return { ok: true, via: 'reg2', line: res.line }
      if (res.kind !== 'exists') return { ok: false, stage: 'reg', kind: res.kind, line: res.line }
    } else {
      return { ok: false, stage: 'reg', kind: res.kind, line: res.line }
    }
  }
  // /l — аккаунт уже был зарегистрирован
  const logCmd = buildAuthCommand(ACCOUNTS.loginTemplate, pass)
  if (!logCmd) return { ok: false, stage: 'login', kind: 'no-template' }
  mark = live.chatsLen()
  live.chat(logCmd)
  step(label + ': 🔑 /l отправлен')
  const res2 = await waitAuthResult(live, mark, SOLVER.regVerifyMs)
  if (res2.kind === 'ok') { step(label + ': ✅ вход подтверждён: ' + String(res2.line || '').slice(0, 90)); return { ok: true, via: 'login', line: res2.line } }
  return { ok: false, stage: 'login', kind: res2.kind, line: res2.line }
}

// ========================= РЕШЕНИЕ КАПЧИ НА ЖИВОМ СОЕДИНЕНИИ (общее для CLI и TG-сессий) =========================
// Вынесено из solveJoin v4: цикл попыток (solver.triesPerJoin) — снимок стены → распознавание
// → ответ в чат → вердикт → авторизация. ctx: {label, dirTag, roundNo, acc, loginFirst, isStopped}
async function solveCaptchaOnLive(live, ctx) {
  ctx = ctx || {}
  const label = ctx.label || 'сессия'
  const dirTag = ctx.dirTag || 'sess'
  const acc = ctx.acc || { nick: '?', pass: '' }
  const roundNo = Number(ctx.roundNo) || 1
  const attempts = []
  let lastRec = null, lastAns = null, lastVerdict = null
  for (let t = 1; t <= SOLVER.triesPerJoin; t++) {
    if (ctx.isStopped && ctx.isStopped()) { lastVerdict = { kind: 'stopped' }; break }
    if (live.isDead()) { lastVerdict = { kind: 'kick', reason: live.deadReason() }; break }
    const snap = live.snap()
    const dir = path.join(REC_ROOT, dirTag + '_a' + t + '_' + STAMP)
    let rec = null
    try { rec = saveRound(dir, snap, label + ' п' + t, roundNo) } catch (e) { step(label + ': saveRound err: ' + e.message) }
    if (!rec) { attempts.push({ t, fail: 'wall-not-assembled' }); break }
    lastRec = rec

    let png = null
    try { png = fs.readFileSync(rec.pngFile) } catch (e) {}
    if (!png) { attempts.push({ t, fail: 'no-png' }); break }
    const ans = await recognizePng(png, label + ' п' + t)
    if (!ans || !ans.digits) {
      attempts.push({ t, fail: 'recognition-unavailable' })
      step(label + ': ❌ распознавание не дало цифр (Roboflow/YOLO недоступны или не настроены)')
      break
    }
    lastAns = ans
    rec.yolo = ans
    try { rfSaveAnswer({ yolo: ans, dir: rec.dir }, roundNo) } catch (e) {}
    step(label + ': 🔢 «' + ans.digits + '» (' + (ans.host || '?') + ', ' + ans.ms + 'мс' + (ans.exact === false ? ', ⚠️ не ровно ' + DIGITS_EXPECTED + ' цифр' : '') + ')')

    // ---- отправка ответа В ЧАТ СЕРВЕРА ----
    const delay = SOLVER.answerDelayMin + Math.floor(Math.random() * SOLVER.answerDelayRnd)
    await sleep(delay)
    if (live.isDead()) { lastVerdict = { kind: 'kick', reason: live.deadReason() }; break }
    const baseChange = live.lastChange()
    const mark = live.chatsLen()
    if (!live.chat(ans.digits)) { lastVerdict = { kind: 'kick', reason: 'chat failed' }; break }
    step(label + ': 💬 ответ «' + ans.digits + '» отправлен в чат (пауза ' + delay + 'мс) — жду реакцию сервера')

    const verdict = await waitVerdict(live, { ms: SOLVER.verifyMs, mark, baseChange })
    lastVerdict = verdict
    attempts.push({ t, digits: ans.digits, provider: ans.host, verdict: verdict.kind, line: (verdict.line || verdict.reason || '').slice(0, 120), ms: verdict.ms })
    writeResult(dir, { label, attempt: t, rec, ans, verdict, ts: new Date().toISOString() })

    if (verdict.kind === 'success' || verdict.kind === 'auth') {
      step(label + ': ✅ КАПЧА ПРОЙДЕНА («' + ans.digits + '», реакция: ' + verdict.kind + (verdict.line ? ' — ' + String(verdict.line).slice(0, 80) : '') + ')')
      const auth = await authPhase(live, acc, label, { loginFirst: !!ctx.loginFirst })
      writeResult(dir, { label, attempt: t, rec, ans, verdict, auth, ts: new Date().toISOString() })
      return { ok: true, stage: 'solved', rec, ans, verdict, auth, live, attempts, dir }
    }
    if (verdict.kind === 'kick') {
      step(label + ': ❌ кикнули после ответа: ' + String(verdict.reason || '').slice(0, 120))
      break
    }
    // fail / newwall / timeout — сервер не принял ответ
    step(label + ': ⚠️ ответ не принят (' + verdict.kind + (verdict.line ? ': ' + String(verdict.line).slice(0, 80) : '') + ')')
    if (t < SOLVER.triesPerJoin) {
      step(label + ': жду новую капчу для попытки ' + (t + 1) + '…')
      const fresh = await live.waitFreshWall(20000)
      if (!fresh) {
        if (live.isDead()) { lastVerdict = { kind: 'kick', reason: live.deadReason() } }
        else step(label + ': новая капча не появилась за 20с')
        break
      }
    }
  }

  const why = lastVerdict ? (lastVerdict.kind + (lastVerdict.reason ? ': ' + String(lastVerdict.reason).slice(0, 80) : '')) : 'wall/recognition fail'
  return { ok: false, stage: 'captcha', note: why, kick: lastVerdict && lastVerdict.kind === 'kick', kickReason: (lastVerdict && lastVerdict.reason) || '', rec: lastRec, ans: lastAns, attempts }
}

// result.json в папке захода: распознавание + вердикт + авторизация
function writeResult(dir, obj) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
      label: obj.label, attempt: obj.attempt, ts: obj.ts,
      wall: obj.rec ? { wall: obj.rec.wall, grid: obj.rec.cols + 'x' + obj.rec.rows, seam: obj.rec.seamCost, score: obj.rec.score, ocrHint: obj.rec.ocrHint } : null,
      recognition: obj.ans ? { digits: obj.ans.digits, host: obj.ans.host, provider: obj.ans.provider || 'yolo', ms: obj.ans.ms, conf: obj.ans.conf, exact: obj.ans.exact } : null,
      verdict: obj.verdict || null,
      auth: obj.auth || null
    }, null, 2))
  } catch (e) { dbg('writeResult err: ' + e.message) }
}

// (v5) holdOnline удалён: удержание в игре живёт в движке сессий (hub/anarchy + анти-афк).
let SHUTDOWN = false
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

// синтетическая капча с настоящими цифрами (для проверки цикла обучения)
function makeSyntheticDigits(cols, rows, digits, seed) {
  let s = seed || 1
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const W = cols * 128, H = rows * 128
  const img = new Uint8Array(W * H)
  for (let i = 0; i < img.length; i++) img[i] = 34          // белая шерсть (base 8, shade 2)
  // шум только сверху/снизу, чтобы не мешать строке цифр
  const NOISE = [122, 30, 46, 98, 74]
  for (let k = 0; k < 24; k++) {
    const cx = Math.floor(rnd() * W)
    const cy = rnd() < 0.5 ? Math.floor(rnd() * H * 0.18) : Math.floor(H * 0.82 + rnd() * H * 0.18)
    const r = 3 + Math.floor(rnd() * 7)
    const v = NOISE[Math.floor(rnd() * NOISE.length)]
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue
      const X = cx + x, Y = cy + y
      if (X >= 0 && Y >= 0 && X < W && Y < H) img[Y * W + X] = v
    }
  }
  // масштаб так, чтобы все цифры влезли по ширине И высоте (и не касались границ плиток)
  const n = digits.length
  const scH = Math.floor(H * 0.42 / 7)
  const scW = Math.floor((W * 0.86) / (n * 5 + (n - 1) * 1.15))
  const sc = Math.max(6, Math.min(scH, scW))
  const gap = Math.max(sc, Math.floor(sc * 1.15))
  const dw = 5 * sc
  const x0 = Math.floor((W - (n * dw + (n - 1) * gap)) / 2)
  const y0 = Math.floor((H - 7 * sc) / 2)
  const centers = []
  digits.split('').forEach((d, i) => {
    const pat = DIGITS[d]
    const ox = x0 + i * (dw + gap)
    centers.push({ x: ox + dw / 2, digit: d })
    if (!pat) return
    for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
      if (!pat[y][x]) continue
      for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) {
        const X = ox + x * sc + dx, Y = y0 + y * sc + dy
        if (X >= 0 && Y >= 0 && X < W && Y < H) img[Y * W + X] = 118   // чёрная шерсть (base 29, shade 2)
      }
    }
  })
  return { img, W, H, centers }
}

// собрать из картинки «снапшот раунда»: плитки на стене + рамки + точка обзора
function makeWallSnapshot(img, W, H, opts) {
  opts = opts || {}
  const cols = W / 128, rows = H / 128
  const axis = opts.axis || 'z'
  const viewSide = opts.viewSide || -1
  const OX = opts.ox || 200, OY = opts.oy || 70, OZ = opts.oz || 300
  const maps = new Map()
  const frames = []
  let id = opts.id0 || 700
  const hAscExpected = axis === 'z' ? (viewSide > 0) : (viewSide < 0)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const tile = new Uint8Array(16384)
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = img[(r * 128 + y) * W + c * 128 + x]
    const q = opts.rots ? ((r * 2 + c + id) % 4) : 0
    maps.set(id, rotQ(tile, (4 - q) % 4))
    const ni = hAscExpected ? c : cols - 1 - c
    const pos = axis === 'z'
      ? { x: OX + 0.5 + ni, y: OY + 0.5 - r, z: OZ + viewSide * 0.0625 }
      : { x: OZ + viewSide * 0.0625, y: OY + 0.5 - r, z: OX + 0.5 + ni }
    frames.push({ id, x: pos.x, y: pos.y, z: pos.z, mapId: id, rotation: q, yaw: axis === 'z' ? (viewSide < 0 ? 0 : Math.PI) : (viewSide < 0 ? -Math.PI / 2 : Math.PI / 2) })
    id++
  }
  const plane = axis === 'z' ? frames[0].z : frames[0].x
  const view = opts.view || (axis === 'z'
    ? { x: OX + 2, y: OY, z: plane + viewSide * 5, yaw: viewSide < 0 ? 0 : Math.PI, pitch: 0 }
    : { x: plane + viewSide * 5, y: OY, z: OX + 2, yaw: viewSide < 0 ? -Math.PI / 2 : Math.PI / 2, pitch: 0 })
  return { maps, frames, chats: ['[chat] BotFilter >> Введите номер с картинки в чат'], events: ['selftest'], view, metaDump: [] }
}
// ========================= TELEGRAM: ТРАНСПОРТ (порт из v3.14.0, battle-tested) =========================
// Чистый https/socks без npm-пакетов: прямой доступ, telegram.apiProxy (SOCKS5h),
// туннель MC-прокси; 429 retry_after; запоминание рабочего транспорта.
function tgLogFile() { return path.join(REC_ROOT || __dirname, 'telegram.log') }
function tgLog(msg) {
  const line = logStamp() + ' [TG] ' + msg
  try { fs.mkdirSync(REC_ROOT || __dirname, { recursive: true }); fs.appendFileSync(tgLogFile(), line + '\n') } catch (e) {}
  step('[TG] ' + msg)
}

let tgTransport = null
function tgTransports() {
  let isHttp = false
  try { isHttp = new URL(TG_CFG.apiUrl).protocol === 'http:' } catch (e) {}
  if (isHttp) return ['direct']        // локальный/тестовый endpoint — прокси не нужен

  const direct = 'direct'
  const s = parseSocksUrl(TG_CFG.socksUrl)
  const tgProxy = s ? { name: 'tg-proxy(' + s.host + ':' + s.port + ')', socks: s } : null
  const mc = (TG_CFG.useMcProxy && PROXY.host)
    ? { name: 'mc-proxy(' + PROXY.host + ')', socks: { type: 5, host: PROXY.host, port: PROXY.port, username: PROXY.username, password: PROXY.password } }
    : null
  // специальный прокси первым (если задан): прямой доступ к Telegram обычно заблокирован
  const list = []
  if (tgProxy && TG_CFG.preferSocks) list.push(tgProxy)
  list.push(direct)
  if (tgProxy && !TG_CFG.preferSocks) list.push(tgProxy)
  if (mc) list.push(mc)
  return list
}

// вызов метода Telegram Bot API: сначала рабочий транспорт, потом остальные
async function tgApi(method, params, file, timeoutMs, onlyTransport) {
  if (!TG_CFG.token) return { ok: false, description: 'нет telegram.token' }
  let u
  try { u = new URL(TG_CFG.apiUrl + '/bot' + TG_CFG.token + '/' + method) } catch (e) { return { ok: false, description: 'плохой telegram.apiUrl' } }
  const order = []
  if (onlyTransport) order.push(onlyTransport)
  else {
    if (tgTransport) order.push(tgTransport)
    for (const t of tgTransports()) if (order.indexOf(t) < 0) order.push(t)
  }

  const errs = []
  let lastErr = 'нет транспорта'
  for (const tr of order) {
    for (let retry = 0; retry < 2; retry++) {
      let body = null, headers = {}
      if (file) { const mp = multipart(params || {}, file); body = mp.body; headers['Content-Type'] = mp.contentType }
      else { body = JSON.stringify(params || {}); headers['Content-Type'] = 'application/json' }
      const socks = (tr === 'direct') ? null : tr.socks
      const tName = (tr === 'direct') ? 'direct' : tr.name
      const secure = u.protocol !== 'http:'
      const r = await httpsRequest({ host: u.hostname, port: Number(u.port || (secure ? 443 : 80)), path: u.pathname + u.search, method: 'POST', headers, body, timeoutMs: timeoutMs || TG_CFG.timeoutMs, socks, secure })
      if (!r.ok) {
        lastErr = tName + ': ' + r.error
        if (errs.indexOf(lastErr) < 0) errs.push(lastErr)
        if (/модуль socks не установлен/.test(r.error)) tgLog('⚠️ нужен пакет socks: npm i socks (без него прокси-транспорты не работают)')
        else tgLog('API ' + method + ' через ' + tName + ' не прошёл: ' + r.error)
        break
      }
      let json = null
      try { json = JSON.parse(r.body.toString('utf8')) } catch (e) {}
      if (r.status === 429) {
        const ra = json && json.parameters && json.parameters.retry_after ? Number(json.parameters.retry_after) : 3
        tgLog('429 too many requests, жду ' + ra + 'с')
        await sleep(Math.min(30, ra) * 1000)
        continue
      }
      if (json && json.ok) {
        if (tgTransport !== tr) { tgTransport = tr; tgLog('транспорт: ' + tName) }
        return json
      }
      const d = (json && json.description) || ('HTTP ' + r.status + ' ' + r.body.toString('utf8').slice(0, 200))
      return { ok: false, error_code: r.status, description: tName + ': ' + d }
    }
  }
  return { ok: false, description: errs.length ? errs.join(' | ') : lastErr }
}

// ---- обёртки UI-слоя ----
async function tgSend(chatId, text, kb) {
  const p = { chat_id: chatId, text: String(text), disable_web_page_preview: true }
  if (kb) p.reply_markup = JSON.stringify(kb)
  const r = await tgApi('sendMessage', p)
  if (!r.ok) tgLog('sendMessage ошибка: ' + (r.description || r.error_code))
  return r
}
async function tgEdit(chatId, messageId, text, kb) {
  const p = { chat_id: chatId, message_id: messageId, text: String(text), disable_web_page_preview: true }
  if (kb) p.reply_markup = JSON.stringify(kb)
  const r = await tgApi('editMessageText', p)
  // «message is not modified» — не ошибка: текст и так актуален
  if (!r.ok && /not modified/i.test(String(r.description || ''))) return { ok: true, unchanged: true }
  if (!r.ok && /message can't be edited|message to edit not found/i.test(String(r.description || ''))) return { ok: false, gone: true, description: r.description }
  if (!r.ok) tgLog('editMessageText ошибка: ' + (r.description || r.error_code))
  return r
}
async function tgDelete(chatId, messageId) {
  const r = await tgApi('deleteMessage', { chat_id: chatId, message_id: messageId })
  if (!r.ok && !/can't be deleted|message to delete not found/i.test(String(r.description || ''))) tgLog('deleteMessage ошибка: ' + (r.description || r.error_code))
  return r
}
async function tgAnswerCb(callbackQueryId, text) {
  const p = { callback_query_id: callbackQueryId }
  if (text) p.text = String(text).slice(0, 190)
  return await tgApi('answerCallbackQuery', p)
}
async function tgGetUpdates(offset, timeoutSec) {
  return await tgApi('getUpdates', {
    offset: Number(offset) || 0,
    timeout: Math.max(0, Number(timeoutSec) || 0),
    allowed_updates: ['message', 'callback_query']
  }, null, ((Number(timeoutSec) || 0) + 20) * 1000)
}

// ---- диагностика связи: node main.js --tg-test ----
async function runTgTest() {
  console.log('=== ПРОВЕРКА TELEGRAM (v5) ===')
  if (!TG_CFG.token) { console.log('❌ нет telegram.token в конфиге'); return false }
  const list = tgTransports()
  let working = null
  for (const tr of list) {
    const name = (tr === 'direct') ? 'direct' : tr.name
    process.stdout.write('  транспорт ' + name + ': getMe … ')
    const r = await tgApi('getMe', null, null, 15000, tr)
    if (r.ok && r.result) { console.log('✅ бот @' + r.result.username + ' (id ' + r.result.id + ')'); working = { name, bot: r.result }; break }
    console.log('❌ ' + String(r.description || r.error_code || '').slice(0, 140))
  }
  if (!working) { console.log('❌ ни один транспорт не работает'); return false }
  const chat = TG_CFG.allowedChatIds[0]
  if (chat) {
    const r = await tgApi('sendMessage', { chat_id: chat, text: '✅ Связь есть. Транспорт: ' + working.name + '\nБот @' + working.bot.username + ' готов (v5.0.0, Telegram-пульт).' })
    console.log(r.ok ? '  ✅ тестовое сообщение отправлено в chat_id ' + chat : '  ⚠️ сообщение не отправлено: ' + String(r.description || '').slice(0, 140))
  } else {
    console.log('  ⚠️ telegram.allowedChatIds пуст — тестовое сообщение не отправлялось')
  }
  return true
}

// ========================= БАЗА АККАУНТОВ (learn/accounts_db.json) =========================
// Созданный аккаунт сохраняется: ник, пароль, туннель, IP регистрации, владелец.
// Когда нужны аккаунты — сначала берутся ИЗ БАЗЫ (заход через /l; если IP туннеля совпадает
// с IP регистрации, сервер может вообще не показать капчу), и только потом создаются новые.
// owner: 'algo' (общий пул) | 'tg:<chatId>' (личный, алгоритмам НЕ выдаётся).
let DB_PATH = ACCOUNTS_DB_PATH
const DB = { version: 1, savedAt: null, accounts: [] }

function dbSetPath(p) { DB_PATH = p }   // только для selftest
function dbLoad(force) {
  if (!force && DB.accounts.length) return DB
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8')
    const j = JSON.parse(raw)
    DB.accounts = Array.isArray(j.accounts) ? j.accounts : []
    DB.version = Number(j.version) || 1
    DB.savedAt = j.savedAt || null
  } catch (e) {
    if (e && e.code !== 'ENOENT') step('[db] не удалось прочитать ' + DB_PATH + ': ' + e.message + ' — начинаю с пустой базы')
    DB.accounts = []
  }
  return DB
}
function dbSave() {
  try {
    DB.savedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
    const tmp = DB_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: DB.version, savedAt: DB.savedAt, accounts: DB.accounts }, null, 1) + '\n')
    fs.renameSync(tmp, DB_PATH)      // атомарная запись: читатели не видят половинный файл
    return true
  } catch (e) { step('[db] запись ошибки: ' + e.message); return false }
}
function dbNewRecord(owner, T, opts) {
  opts = opts || {}
  return {
    nick: opts.nick || randomNick(),
    pass: opts.pass || randomPass(),
    tunnel: (T && T.name) || opts.tunnel || '',
    ip: (T && T.ip) || opts.ip || '',
    owner: String(owner || 'algo'),
    status: 'new',
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    regConfirmed: false,
    anarchy: null,
    note: opts.note || '',
    busy: true
  }
}
// создать аккаунт (owner: 'algo' | 'tg:<chatId>')
function dbCreate(owner, T, opts) {
  dbLoad()
  const acc = dbNewRecord(owner, T, opts)
  DB.accounts.push(acc)
  dbSave()
  return acc
}
// личный аккаунт пользователя ТГ: ПОСТОЯННЫЙ (создаётся один раз, сам не меняется)
function dbPersonal(tgId, T) {
  dbLoad()
  const owner = 'tg:' + tgId
  let acc = null
  for (const a of DB.accounts) if (a.owner === owner && a.status !== 'retired') acc = a   // берём последний живой
  if (acc) {
    if (T && acc.tunnel !== T.name) { acc.tunnel = T.name; acc.ip = (T && T.ip) || acc.ip; dbSave() }
    return acc
  }
  return dbCreate(owner, T)
}
// «смена ника»: старый аккаунт остаётся в базе (retired), создаётся новый случайный
function dbPersonalRotate(tgId, T) {
  dbLoad()
  const owner = 'tg:' + tgId
  for (const a of DB.accounts) if (a.owner === owner && a.status !== 'retired') { a.status = 'retired'; a.busy = false; a.note = (a.note ? a.note + '; ' : '') + 'retired ' + new Date().toISOString() }
  return dbCreate(owner, T)
}
// свободный аккаунт АЛГОРИТМАМ: приоритет — тот же IP → тот же туннель → любой свободный.
// личные (owner tg:*) и занятые (busy) НЕ выдаются. Возвращает null, если в базе пусто.
function dbTakeFreeAlgo(T) {
  dbLoad()
  const cands = DB.accounts.filter(a => a.owner === 'algo' && !a.busy && a.status === 'registered')
  if (!cands.length) return null
  const ip = (T && T.ip) || ''
  const tn = (T && T.name) || ''
  const pick = cands.find(a => ip && a.ip === ip) || cands.find(a => tn && a.tunnel === tn) || cands[0]
  pick.busy = true
  pick.lastUsed = new Date().toISOString()
  dbSave()
  return pick
}
function dbMarkBusy(acc, b) { if (!acc) return; acc.busy = !!b; acc.lastUsed = new Date().toISOString(); dbSave() }
function dbMarkRegistered(acc) {
  if (!acc) return
  acc.status = 'registered'; acc.regConfirmed = true; acc.lastUsed = new Date().toISOString()
  dbSave()
}
function dbSetAnarchy(acc, n) { if (!acc) return; acc.anarchy = (n === null || n === undefined) ? null : Number(n); dbSave() }
function dbSummary() {
  dbLoad()
  const s = { total: DB.accounts.length, registered: 0, personal: 0, algo: 0, busy: 0, retired: 0 }
  for (const a of DB.accounts) {
    if (a.status === 'registered') s.registered++
    if (a.status === 'retired') s.retired++
    if (String(a.owner || '').indexOf('tg:') === 0) s.personal++; else s.algo++
    if (a.busy) s.busy++
  }
  return s
}

// ========================= СЕССИИ v5 (единый движок для TG-пульта и CLI) =========================
// Состояния: queued → joining → captcha → hub → anarchy(N) → stopped/dead/error.
// sentLog — «то, что написал аккаунт» (пароль маскируется, чистится при смене анархии).
// Анти-афк — свой (в mineflayer 4.25.0 встроенного нет): swingArm + микро-look каждые ~45с±15с.
// Ротация IP — только «особые случаи»: бан-кик, серия провалов капчи, серия сетевых фейлов.
const SESSIONS = []
let SESS_SEQ = 0
let GLOBAL_FATAL = ''            // фатальная ошибка окружения (нет mineflayer/proxy.host) — гасит CLI-пул
// хуки только для selftest-моков (в бою всегда null)
const SESS_HOOKS = { connect: null, solve: null }

function sessionLabel(S) {
  return S.kind === 'personal' ? ('ЛИЧНЫЙ-' + S.tgChatId) : ('БОТ-' + S.id)
}
function sessionTag(S, r) { return 's' + S.id + 'r' + r }

function makeSession(opt) {
  opt = opt || {}
  const S = {
    id: ++SESS_SEQ,
    kind: opt.kind === 'personal' ? 'personal' : 'algo',   // 'algo' покрывает и CLI-пул
    tgChatId: opt.tgChatId || null,
    acc: opt.acc || null,
    T: opt.T || null,
    state: 'queued',
    anarchy: null,
    sentLog: [],
    live: null,
    stop: false,
    error: '',
    lastError: '',
    rotations: 0, failStreak: 0, netFails: 0,
    roundNo: 0, roundNoBase: Number(opt.roundNoBase) || 0,
    presetAnarchy: (opt.presetAnarchy === undefined || opt.presetAnarchy === null) ? null : Number(opt.presetAnarchy),
    startedAt: 0, finishedAt: 0,
    slotHeld: false, slotWaiter: null,
    afkTimer: null,
    solved: false, solvedRound: 0, ans: null, auth: null,
    ui: null,                    // {chatId, messageId} — статус-блок в TG (ставит UI-слой)
    onChanged: [],
    notify() { for (const f of S.onChanged.slice()) { try { f(S) } catch (e) {} } },
    setState(st) { if (S.state !== st) { S.state = st; step(sessionLabel(S) + ': состояние → ' + st.toUpperCase()); } S.notify(); S.settleCheck() },
    logSent(text) {
      S.sentLog.push(maskSecret(text, S.acc))
      if (S.sentLog.length > 50) S.sentLog.shift()
      S.notify()
    },
    // «номер статуса» для TG-блока: 1 — заход на сервер, 2 — HUB, 3 — анархия N
    statusNo() {
      if (S.state === 'anarchy') return 3
      if (S.state === 'hub') return 2
      return 1
    }
  }
  // обещание «сессия дошла до HUB/анархии или завершилась» — для сводки CLI-пула
  S.settledPromise = new Promise(res => { S._settle = res })
  S._settledDone = false
  S.settleCheck = function () {
    if (S._settledDone) return
    if (['hub', 'anarchy', 'stopped', 'dead', 'error'].indexOf(S.state) >= 0) { S._settledDone = true; try { S._settle(S) } catch (e) {} }
  }
  return S
}

// пароль аккаунта никогда не печатается
function maskSecret(text, acc) {
  let s = String(text === undefined || text === null ? '' : text)
  if (acc && acc.pass && s.indexOf(acc.pass) >= 0) s = s.split(acc.pass).join('••••••')
  return s
}

// ---- анти-афк ----
function antiAfkInterval() {
  const j = ANTI_AFK.jitterMs > 0 ? Math.floor((Math.random() * 2 - 1) * ANTI_AFK.jitterMs) : 0
  return Math.max(5000, ANTI_AFK.everyMs + j)
}
function startAntiAfk(S) {
  if (!ANTI_AFK.enabled) return
  stopAntiAfk(S)
  const tick = () => {
    S.afkTimer = setTimeout(() => {
      try {
        const live = S.live
        if (live && !live.isDead() && live.bot) {
          const bot = live.bot
          try { if (bot.swingArm) bot.swingArm('right') } catch (e) {}
          try {
            if (bot.entity && bot.look) {
              const yaw = (Number(bot.entity.yaw) || 0) + (Math.random() - 0.5) * 0.2
              const pitch = Math.max(-1.4, Math.min(1.4, (Number(bot.entity.pitch) || 0) + (Math.random() - 0.5) * 0.1))
              bot.look(yaw, pitch, true)
            }
          } catch (e) {}
          dbg(sessionLabel(S) + ': анти-афк (swingArm + микро-look)')
        }
      } catch (e) {}
      if (!S.stop && ['hub', 'anarchy'].indexOf(S.state) >= 0) tick()
    }, antiAfkInterval())
  }
  tick()
}
function stopAntiAfk(S) { if (S.afkTimer) { try { clearTimeout(S.afkTimer) } catch (e) {} S.afkTimer = null } }

// ---- смена анархии: /anN в игру, очистка «написанного» ----
async function setAnarchy(S, n, opt) {
  opt = opt || {}
  n = Number(n)
  if (!anarchyOk(n)) return { ok: false, error: 'анархия ' + n + ' вне диапазонов (' + anarchyListText() + ')' + (ANARCHY.allowAny ? '' : '; anarchy.allowAny=false') }
  if (!S.live || S.live.isDead()) return { ok: false, error: 'нет живого соединения с сервером' }
  const prev = S.anarchy
  if (prev !== null) S.sentLog = []       // при СМЕНЕ анархии список «написанного» очищается
  S.live.chat('/an' + n)                 // обёртка chat → sentLog добавит «/anN» первой строкой нового списка
  // идемпотентная запись: в сессии chat() обёрнут (пишет сам), вне сессии (тесты) — пишем здесь
  if (S.sentLog[S.sentLog.length - 1] !== '/an' + n) S.logSent('/an' + n)
  S.anarchy = n
  dbSetAnarchy(S.acc, n)
  S.setState('anarchy')
  step(sessionLabel(S) + ': 🌀 анархия /an' + n + (prev !== null ? ' (смена с ' + prev + ')' : '') + ' — релей чата включён')
  return { ok: true, prev }
}

// «особые случаи» для смены IP (как в v4: бан-кик, серии провалов)
function sessionNeedsRotation(S, res) {
  if (!S.T) return false
  if (res && res.kick && matchAny(res.kickReason, SOLVER.banWords)) return true
  if (S.failStreak >= SOLVER.rotateOnFailStreak) return true
  if (S.netFails >= SOLVER.rotateOnNetFails) return true
  return false
}

async function runSession(S) {
  S.startedAt = Date.now()
  const label = sessionLabel(S)
  try {
    S.setState('queued')
    const got = await acquireSlot(S.T, S.kind, S)
    if (!got || S.stop) { if (!S.stop) S.error = 'слот отменён'; S.setState(S.stop ? 'stopped' : 'error'); return S }
    S.slotHeld = true

    let solved = false
    const maxAttempts = Math.max(1, SOLVER.roundsPerBot)
    for (let r = 1; r <= maxAttempts && !S.stop && !solved; r++) {
      if (r > 1) await sleep(PAUSE_BETWEEN_MS + Math.floor(Math.random() * 600))
      S.roundNo = r
      S.setState('joining')
      step('--- ' + label + ' заход ' + r + ' (ник ' + S.acc.nick + ', туннель «' + (S.T ? S.T.name : 'direct') + '», IP ' + ((S.T && S.T.ip) || '?') + ') ---')
      const tJoin = Date.now()
      const tag = sessionTag(S, r)
      let conn = null
      try {
        conn = SESS_HOOKS.connect ? await SESS_HOOKS.connect(tag, { T: S.T, nick: S.acc.nick })
                                  : await connectAndSolve(tag, { T: S.T, nick: S.acc.nick })
      } catch (e) { conn = { ok: false, note: 'exception: ' + e.message } }
      // сначала назначаем live (даже при stop — чтобы finally гарантированно закрыл соединение),
      // потом проверяем стоп: иначе живой бот «повиснет» в игре после остановки
      if (conn && conn.ok) S.live = conn.live
      if (S.stop) break
      if (!conn || !conn.ok) {
        const note = (conn && conn.note) || 'connect fail'
        step(label + ' заход ' + r + ': ❌ подключение/сбор не удались: ' + note)
        S.lastError = note
        if (FATAL_RE.test(note)) {
          S.error = note
          GLOBAL_FATAL = note
          S.setState('error')
          return S
        }
        const netFail = NET_FAIL_RE.test(note)
        if (netFail) { S.netFails++; if (S.T) S.T.failStreak = (S.T.failStreak || 0) + 1 } else { S.netFails = 0; S.failStreak++ }
        const res = { stage: 'connect', note, kick: /kicked/.test(note), kickReason: note }
        if (await specialRotation(S, res, label)) continue
        if (S.rotations >= MAX_ROTATIONS_ON_FAIL) { S.error = 'лимит ротаций IP исчерпан (' + S.rotations + ')'; S.setState('error'); return S }
        continue
      }

      // живое соединение: заворачиваем chat(), чтобы всё написанное аккаунтом попало в sentLog
      const rawChat = S.live.chat.bind(S.live)
      S.live.chat = function (t) { S.logSent(t); return rawChat(t) }
      step(label + ': 🖼 картинка собрана за ' + ((Date.now() - tJoin) / 1000).toFixed(1) + 'с — решаю')
      S.setState('captcha')

      let res = null
      try {
        res = SESS_HOOKS.solve ? await SESS_HOOKS.solve(S.live, { label, tag, roundNo: S.roundNoBase + r, acc: S.acc })
                               : await solveCaptchaOnLive(S.live, {
                                   label, dirTag: 'sess' + S.id + '_r' + r, roundNo: S.roundNoBase + r,
                                   acc: S.acc, loginFirst: S.acc.status === 'registered',
                                   isStopped: () => S.stop
                                 })
      } catch (e) { res = { ok: false, stage: 'exception', note: e.message } }
      if (S.stop) break

      if (res && res.ok) {
        solved = true
        S.solved = true; S.solvedRound = r; S.ans = res.ans || null; S.auth = res.auth || null
        S.failStreak = 0; S.netFails = 0
        dbMarkRegistered(S.acc)
        step('=== ' + label + ' ✅ КАПЧА РЕШЕНА' + (S.auth && S.auth.ok ? ' + АВТОРИЗОВАН (' + S.auth.via + ')' : ' (авторизация не подтверждена)') +
          ' | ник «' + S.acc.nick + '» | цифр «' + (res.ans ? res.ans.digits : '?') + '» | заходов: ' + r + '/' + maxAttempts + ' ===')
        S.setState('hub')
        continue
      }

      // ---- провал капчи ----
      const note = (res && res.note) || 'captcha fail'
      S.lastError = note
      step(label + ' заход ' + r + ': ❌ ' + note)
      S.netFails = 0; S.failStreak++
      if (res && res.kick && matchAny(res.kickReason, SOLVER.banWords)) step(label + ': ⚠️ кик с признаком бана: ' + String(res.kickReason).slice(0, 100))
      if (await specialRotation(S, res || {}, label)) continue
      if (S.rotations >= MAX_ROTATIONS_ON_FAIL) { S.error = 'лимит ротаций IP исчерпан (' + S.rotations + ')'; break }
    }

    if (S.stop) { S.setState('stopped') }
    else if (!solved) { S.error = S.lastError || 'капча не решена'; S.setState('error') }
    else {
      // ---- HUB / АНАРХИЯ: держим соединение до остановки или смерти ----
      startAntiAfk(S)
      if (S.presetAnarchy && anarchyOk(S.presetAnarchy)) {
        await setAnarchy(S, S.presetAnarchy)
      } else if (S.presetAnarchy) {
        step(label + ': ⚠️ algo.anarchy=' + S.presetAnarchy + ' вне диапазонов — остаюсь в HUB')
      }
      while (!S.stop) {
        if (S.live && S.live.isDead()) {
          S.error = S.live.deadReason() || 'соединение закрыто'
          step(label + ': соединение закрыто сервером (' + S.error + ')')
          S.setState('dead')
          break
        }
        await sleep(400)
      }
      stopAntiAfk(S)
      if (S.stop && S.state !== 'dead') S.setState('stopped')
    }
  } catch (e) {
    S.error = (e && e.message) || String(e)
    step(label + ': исключение сессии: ' + S.error)
    S.setState('error')
  } finally {
    stopAntiAfk(S)
    try { if (S.live) S.live.end('session done') } catch (e) {}
    S.live = null
    if (S.slotHeld) { releaseSlot(S.T, S.kind, S); S.slotHeld = false }
    try { dbMarkBusy(S.acc, false) } catch (e) {}
    S.finishedAt = Date.now()
    S.settleCheck()
    S.notify()
  }
  return S
}

// ротация IP в «особых случаях»; true = ротация выполнена (можно повторять заход)
async function specialRotation(S, res, label) {
  if (!sessionNeedsRotation(S, res)) return false
  if (!S.T) return false
  if (S.rotations >= MAX_ROTATIONS_ON_FAIL) {
    step(label + ': лимит ротаций IP исчерпан (' + S.rotations + ') — прекращаю заходы')
    return false
  }
  S.rotations++
  S.failStreak = 0; S.netFails = 0
  if (S.T) S.T.failStreak = 0
  step(label + ': 🔄 особый случай — меняю IP туннеля «' + S.T.name + '» (ротация ' + S.rotations + '/' + MAX_ROTATIONS_ON_FAIL + ')')
  try { await rotateIp(S.T) } catch (e) { step(label + ': ротация IP ошибка: ' + e.message) }
  await sleep(2500)
  return true
}

function stopSession(S, reason) {
  if (!S || S.stop) return
  S.stop = true
  if (reason) S.error = S.error || reason
  // если ждём слот — вынуть из очереди немедленно
  if (S.slotWaiter && S.T) {
    const i = S.T.slots.waiters.indexOf(S.slotWaiter)
    if (i >= 0) { S.T.slots.waiters.splice(i, 1); try { S.slotWaiter.resolve(false) } catch (e) {} }
  }
  try { if (S.live) S.live.end('stopped: ' + (reason || 'user')) } catch (e) {}
  if (S.state === 'queued') S.setState('stopped')
}
function stopAllSessions(reason) { for (const S of SESSIONS.slice()) stopSession(S, reason) }
function activeSessionOfChat(chatId) {
  for (const S of SESSIONS) if (S.kind === 'personal' && String(S.tgChatId) === String(chatId) &&
    ['stopped', 'dead', 'error'].indexOf(S.state) < 0) return S
  return null
}
function sessionsSummary() {
  const L = []
  for (const S of SESSIONS) {
    L.push('  ' + sessionLabel(S) + ' ник «' + (S.acc ? S.acc.nick : '?') + '» туннель «' + (S.T ? S.T.name : 'direct') + '»: ' +
      S.state.toUpperCase() + (S.anarchy ? ' (' + S.anarchy + ')' : '') +
      (S.solved ? ' ✅ капча решена (заход ' + S.solvedRound + ')' : '') +
      (S.error ? ' | ' + String(S.error).slice(0, 80) : '') + ' | ротаций IP: ' + S.rotations)
  }
  return L
}

// ========================= TELEGRAM-ПУЛЬТ (v5.1: экранные кнопки, статус-блок, релей) =========================
// Основный режим запуска. whitelist — telegram.allowedChatIds; чужие chat_id игнорируются.
// Кнопки «Алгоритмы» и «Личный заход» — REPLY-клавиатура: она живёт ВНИЗУ ЭКРАНА Telegram
// (постоянно на экране, не привязана к сообщению). Действия раздела (Запуск/Смена ника,
// Выключить/Смена анархии) — inline-кнопки под соответствующим сообщением.
// Защита от «призрачных» апдейтов: offset flush при старте + date-фильтр СООБЩЕНИЙ
// (callback'и не фильтруем по дате: нажатие кнопки на старом сообщении — легитимно).
// Приватность: в Telegram никогда не уходят пароли (маскировка ••••••), логины/пароли прокси,
// ключи Roboflow, токен бота — только ник, имя туннеля, IP прокси, слоты и игровой лог.
const TG_UI = {
  running: false,
  startedAt: 0,          // unix-секунды старта (date-фильтр призраков)
  offset: 0,
  flushDone: false,      // offset-flush завершён (для тестов: инъекции только после него)
  throttle: {},          // key chatId:messageId → {last, timer} (editMessageText ≤ 1 раз/1.2с)
  byChat: {}             // chatId → {pendingAnarchy: bool}
}

// ---- экранные кнопки (reply-клавиатура, постоянно внизу экрана) ----
const BTN_ALGO = '🧩 Алгоритмы'
const BTN_PERSONAL = '👤 Личный заход'
function kbScreen() {
  return {
    keyboard: [[{ text: BTN_ALGO }, { text: BTN_PERSONAL }]],
    resize_keyboard: true,
    is_persistent: true
  }
}
function kbInline(rows) { return { inline_keyboard: rows } }
function kbPersonalPanel() {
  return kbInline([
    [{ text: '▶️ Запуск', callback_data: 'p:start' }, { text: '🔄 Смена ника', callback_data: 'p:rotate' }]
  ])
}
function statusKb(S) {
  const rows = [[
    { text: '⏹ Выключить бота', callback_data: 's:stop' },
    { text: '🔀 Смена анархии', callback_data: 's:anarchy' }
  ]]
  if (['stopped', 'dead', 'error'].indexOf(S.state) >= 0) rows.push([{ text: '▶️ Запустить заново', callback_data: 'p:start' }])
  return kbInline(rows)
}

// время сессии в статус-блоке (мм:сс)
function sessUptime(S) {
  if (!S.startedAt) return ''
  const s = Math.max(0, Math.floor(((S.finishedAt || Date.now()) - S.startedAt) / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return mm + ':' + ss
}

// текст статус-блока: статус 1/2/3 + подсказка + «написано аккаунтом» (между статусом и кнопками)
function statusBlockText(S) {
  const L = []
  L.push('👤 Личный заход — ' + (S.acc ? S.acc.nick : '?'))
  const st = S.state
  if (st === 'queued') L.push('Статус: 1️⃣ Заход на сервер… (в очереди за слотом: ' + slotsUsed(S.T) + '/' + SOLVER.maxAccountsPerTunnel + ')')
  else if (st === 'joining') L.push('Статус: 1️⃣ Заход на сервер… (подключение' + (S.roundNo > 1 ? ', попытка ' + S.roundNo : '') + ')')
  else if (st === 'captcha') L.push('Статус: 1️⃣ Заход на сервер… (решаю капчу' + (S.roundNo > 1 ? ', попытка ' + S.roundNo : '') + ')')
  else if (st === 'hub') L.push('Статус: 2️⃣ HUB — выберите анархию')
  else if (st === 'anarchy') L.push('Статус: 3️⃣ Анархия ' + S.anarchy)
  else if (st === 'stopped') L.push('Статус: ⏹ Выключен')
  else if (st === 'dead') L.push('Статус: 💀 Соединение закрыто' + (S.error ? ': ' + String(S.error).slice(0, 100) : ''))
  else if (st === 'error') L.push('Статус: ❌ Ошибка: ' + String(S.error || S.lastError || '?').slice(0, 80))
  else L.push('Статус: ' + st)
  const up = sessUptime(S)
  L.push('Туннель «' + (S.T ? S.T.name : 'direct') + '» · IP ' + ((S.T && S.T.ip) || '?') + ' · слоты ' + slotsUsed(S.T) + '/' + SOLVER.maxAccountsPerTunnel + (up ? ' · ⏱ ' + up : ''))
  try {
    const pe = (S.live && S.live.parseErrs) ? S.live.parseErrs() : 0
    if (pe > 0) L.push('⚠️ Ошибок разбора пакетов: ' + pe + ' — соединение ЖИВО (сервер шлёт пакеты не нашей версии; если что-то не работает: node main.js --proxy-check и minecraft.version)')
  } catch (e) {}
  L.push('────────────')
  if (st === 'hub') {
    L.push('📜 Список анархий: ' + anarchyListText())
    L.push('Отправьте /anN (например /an304). Премиальные в список не входят.')
  } else if (st === 'anarchy') {
    L.push('✍️ Релей: всё, что напишете сюда, уходит в игровой чат (сообщения здесь удаляются).')
    L.push('Смена анархии: /anN или кнопка 🔀.')
  } else if (st === 'stopped' || st === 'dead' || st === 'error') {
    L.push('Повтор: кнопка «▶️ Запустить заново» ниже.')
  } else {
    L.push('⏳ Идёт заход и решение капчи — статус обновляется автоматически.')
  }
  L.push('────────────')
  L.push('📝 Написано аккаунтом:')
  if (S.sentLog.length) for (const s of S.sentLog.slice(-12)) L.push('> ' + s)
  else L.push('> (пока пусто)')
  return L.join('\n')
}

// editMessageText с троттлингом 1.2с на сообщение (Telegram лимитирует частые правки)
function scheduleStatusEdit(S, force) {
  const ui = S.ui
  if (!ui || !ui.messageId) return
  const key = String(ui.chatId) + ':' + ui.messageId
  const rec = TG_UI.throttle[key] || (TG_UI.throttle[key] = { last: 0, timer: null })
  const doEdit = () => {
    rec.last = Date.now(); rec.timer = null
    Promise.resolve(tgEdit(ui.chatId, ui.messageId, statusBlockText(S), statusKb(S))).catch(() => {})
  }
  if (force) { if (rec.timer) { clearTimeout(rec.timer); rec.timer = null }; doEdit(); return }
  const wait = 1200 - (Date.now() - rec.last)
  if (wait <= 0) { if (!rec.timer) doEdit() }
  else if (!rec.timer) rec.timer = setTimeout(doEdit, wait)
}

const MENU_TEXT = '🎮 FunTime captcha-bot · пульт управления v5.1.1\n\nКнопки ВНИЗУ ЭКРАНА (постоянно):\n' + BTN_ALGO + ' — готовые сценарии (пока заглушка)\n' + BTN_PERSONAL + ' — ваш постоянный аккаунт + личный туннель\n\nКоманды: /start меню · /status статус · /stop остановить · /cancel отмена смены анархии · /accounts база аккаунтов · /help справка'
const ALGO_STUB_TEXT = '🧩 Алгоритмы — ЗАГЛУШКА (в разработке).\n\nКаркас уже готов и работает: сессии, слоты физических каналов (≤' + SOLVER.maxAccountsPerTunnel + ' аккаунтов), приоритет алгоритмов выше личных, база аккаунтов, пресет анархии (algo.anarchy), headless-пул (--bots).\n\nВ следующей итерации здесь появится: выбор/настройка сценария (последовательность действий после анархии) и кнопка запуска.'

function personalPanelText(chatId) {
  const T = personalTunnels()[0]
  dbLoad()
  const owner = 'tg:' + chatId
  let acc = null
  for (const a of DB.accounts) if (a.owner === owner && a.status !== 'retired') acc = a
  const L = ['👤 Личный заход']
  if (acc) {
    L.push('Ваш ПОСТОЯННЫЙ аккаунт: ' + acc.nick)
    L.push('Статус: ' + (acc.status === 'registered' ? 'зарегистрирован (заход через /l)' : 'новый (будет /reg)') + (acc.ip ? ' · IP регистрации ' + acc.ip : '') + (acc.anarchy ? ' · анархия ' + acc.anarchy : ''))
  } else {
    L.push('Личный аккаунт ещё не создан — создадим при первом «▶️ Запуск».')
  }
  if (T) {
    const phys = T.physical || T
    L.push('Личный туннель: «' + T.name + '»' + (phys !== T ? ' (общий канал с «' + phys.name + '»)' : '') + ' · IP ' + (T.ip || '?') + ' · свободно слотов ' + slotsFree(T) + '/' + SOLVER.maxAccountsPerTunnel)
  } else {
    L.push('⚠️ Личный туннель не задан — добавьте в config.json "tunnels": [ { …, "role": "personal" } ]')
  }
  L.push('')
  L.push('«🔄 Смена ника» — новый случайный аккаунт (старый остаётся в базе).')
  return L.join('\n')
}

async function sendMenu(chatId) {
  return await tgApi('sendMessage', { chat_id: chatId, text: MENU_TEXT, disable_web_page_preview: true, reply_markup: JSON.stringify(kbScreen()) })
}
async function sendAlgoStub(chatId) {
  return await tgApi('sendMessage', { chat_id: chatId, text: ALGO_STUB_TEXT, disable_web_page_preview: true, reply_markup: JSON.stringify(kbScreen()) })
}
async function sendPersonalPanel(chatId) {
  return await tgSend(chatId, personalPanelText(chatId), kbPersonalPanel())
}

async function startPersonal(chatId, messageId) {
  const existing = activeSessionOfChat(chatId)
  if (existing) {
    if (existing.ui && existing.ui.messageId === messageId) { scheduleStatusEdit(existing, true); return }
    await tgSend(chatId, '⚠️ Заход уже идёт (статус: ' + existing.state.toUpperCase() + (existing.anarchy ? ' ' + existing.anarchy : '') + '). Сначала «⏹ Выключить бота» или /stop.')
    return
  }
  const T = personalTunnels()[0]
  if (!T) {
    tgLog('личный заход chat ' + chatId + ': личный туннель не задан')
    await tgEdit(chatId, messageId, '⚠️ Личный туннель не задан.\n\nДобавьте в config.json второй прокси с ролью personal:\n"tunnels": [ { "name": "my", "host": "…", "port": …, "username": "…", "password": "…", "changeIpUrl": "…", "role": "personal" } ]\n\n(По умолчанию бот и сам создаёт «personal» из секции "proxy" — этой надписи быть не должно, если в конфиге есть хотя бы proxy.host.)', kbInline([]))
    return
  }
  const acc = dbPersonal(chatId, T)
  const S = makeSession({ kind: 'personal', tgChatId: chatId, acc, T })
  SESSIONS.push(S)
  S.ui = { chatId, messageId }
  S.onChanged.push(() => scheduleStatusEdit(S))
  const r = await tgEdit(chatId, messageId, statusBlockText(S), statusKb(S))   // сообщение ЗАМЕНЯЕТСЯ статус-блоком
  if (!r.ok) {
    // старое сообщение править нельзя (удалено/старое) — шлём новый статус-блок
    const r2 = await tgSend(chatId, statusBlockText(S), statusKb(S))
    if (r2.ok && r2.result) S.ui = { chatId, messageId: r2.result.message_id }
  }
  tgLog('личный заход запущен: chat ' + chatId + ', ник ' + acc.nick + ', туннель «' + T.name + '»')
  runSession(S).catch(e => { S.error = (e && e.message) || String(e); S.setState('error') })
}

async function rotatePersonal(chatId, messageId) {
  const existing = activeSessionOfChat(chatId)
  if (existing) { await tgSend(chatId, '⚠️ Сначала остановите текущий заход («⏹ Выключить бота» или /stop), потом меняйте ник.', kbScreen()); return }
  const T = personalTunnels()[0] || null
  const acc = dbPersonalRotate(chatId, T)
  tgLog('смена ника chat ' + chatId + ': новый аккаунт ' + acc.nick)
  await tgEdit(chatId, messageId, personalPanelText(chatId) + '\n✅ Новый ник: ' + acc.nick, kbPersonalPanel())
}

async function onCallback(chatId, data, message) {
  const mid = message && message.message_id
  if (data === 'menu:back' || data === 'menu') { await tgEdit(chatId, mid, MENU_TEXT, kbInline([])); return }
  if (data === 'menu:algo') { await tgEdit(chatId, mid, ALGO_STUB_TEXT, kbInline([])); return }
  if (data === 'menu:personal') { await tgEdit(chatId, mid, personalPanelText(chatId), kbPersonalPanel()); return }
  if (data === 'p:start' || data === 'p:restart') { await startPersonal(chatId, mid); return }
  if (data === 'p:rotate') { await rotatePersonal(chatId, mid); return }
  if (data === 's:stop') {
    const S = activeSessionOfChat(chatId)
    if (!S) { await tgSend(chatId, 'Активная сессия не найдена.', kbScreen()); return }
    stopSession(S, 'остановлено из Telegram')
    tgLog('стоп сессии ' + sessionLabel(S) + ' из chat ' + chatId)
    if (S.ui) scheduleStatusEdit(S, true)
    return
  }
  if (data === 's:anarchy') {
    const S = activeSessionOfChat(chatId)
    if (!S || (S.state !== 'hub' && S.state !== 'anarchy')) { await tgSend(chatId, 'Смена анархии доступна только в активном заходе (HUB/анархия).', kbScreen()); return }
    const st = TG_UI.byChat[chatId] || (TG_UI.byChat[chatId] = {})
    st.pendingAnarchy = true
    await tgSend(chatId, '🔀 Отправьте команду /anN (например /an304).\nСписок анархий: ' + anarchyListText() + '\n/cancel — отмена.')
    return
  }
}

async function onMessage(chatId, messageId, text) {
  const t = String(text || '').trim()
  const st = TG_UI.byChat[chatId] || (TG_UI.byChat[chatId] = {})
  const S = activeSessionOfChat(chatId)

  // ---- экранные кнопки (reply-клавиатура приходит обычным текстом) ----
  if (t === BTN_ALGO) { await sendAlgoStub(chatId); return }
  if (t === BTN_PERSONAL) { await sendPersonalPanel(chatId); return }

  // ---- команды ----
  if (/^\/(start|menu)(\b|$)/i.test(t)) { await sendMenu(chatId); return }
  if (/^\/status(\b|$)/i.test(t)) {
    if (!S) { await tgSend(chatId, 'Активных заходов нет. Кнопка «' + BTN_PERSONAL + '» внизу экрана — личный заход.', kbScreen()); return }
    await tgSend(chatId, statusBlockText(S), statusKb(S))
    return
  }
  if (/^\/stop(\b|$)/i.test(t)) {
    if (!S) { await tgSend(chatId, 'Активных заходов нет.', kbScreen()); return }
    stopSession(S, 'остановлено из Telegram (/stop)')
    tgLog('стоп сессии ' + sessionLabel(S) + ' (/stop, chat ' + chatId + ')')
    return
  }
  if (/^\/cancel(\b|$)/i.test(t)) { st.pendingAnarchy = false; await tgSend(chatId, 'Отменено.', kbScreen()); return }
  if (/^\/accounts(\b|$)/i.test(t)) {
    const s = dbSummary()
    await tgSend(chatId, '🗄 База аккаунтов (' + s.total + '): зарегистрировано ' + s.registered + ', личных ' + s.personal + ', алгоритмических ' + s.algo + ', занято ' + s.busy + ', в архиве ' + s.retired + '.\nФайл: learn/accounts_db.json', kbScreen())
    return
  }
  if (/^\/help(\b|$)/i.test(t)) {
    await tgSend(chatId, '🎮 Пульт v5.1.1\n\nЭкранные кнопки (внизу): «' + BTN_ALGO + '», «' + BTN_PERSONAL + '».\nВ личном заходе: ▶️ Запуск → статус-блок (1️⃣ заход / 2️⃣ HUB / 3️⃣ анархия N) → в HUB отправьте /anN → в анархии любой текст уходит в игровой чат (сообщения здесь удаляются).\n\nКоманды: /start · /status · /stop · /cancel · /accounts · /help', kbScreen())
    return
  }

  // /anN — смена анархии (только команда, «304» без /an — это релей)
  const n = parseAnarchyCmd(t)
  if (n !== null) {
    st.pendingAnarchy = false
    if (!S || (S.state !== 'hub' && S.state !== 'anarchy')) { await tgSend(chatId, 'Анархию можно выбрать только в активном заходе (статус HUB или анархия).', kbScreen()); return }
    const r = await setAnarchy(S, n)
    if (!r.ok) { await tgSend(chatId, '⚠️ ' + r.error); return }
    await tgDelete(chatId, messageId)          // команду тоже удаляем — не засорять чат
    if (S.ui) scheduleStatusEdit(S, true)
    return
  }

  // релей: в анархии любой текст → в игровой чат, сообщение в ТГ удалить
  if (S && S.state === 'anarchy' && S.live && !S.live.isDead()) {
    if (!t) return
    const okChat = S.live.chat(t)              // обёртка chat() сама добавит строку в sentLog
    if (okChat === false) { await tgSend(chatId, '⚠️ Сообщение не ушло: соединение с сервером закрыто.'); return }
    await tgDelete(chatId, messageId)
    if (S.ui) scheduleStatusEdit(S)
    return
  }
  if (S && S.state === 'hub') { await tgSend(chatId, 'Сначала выберите анархию: /anN (список: ' + anarchyListText() + ')'); return }
  if (S) { await tgSend(chatId, 'Сессия в состоянии «' + S.state + '» — релей текста доступен только в анархии.'); return }
  await tgSend(chatId, 'Нет активного захода. Нажмите «' + BTN_PERSONAL + '» внизу экрана (или /start — меню).', kbScreen())
}

async function handleUpdate(u) {
  const cq = u.callback_query
  const msg = u.message
  const chatId = cq ? (cq.message && cq.message.chat && cq.message.chat.id) : (msg && msg.chat && msg.chat.id)
  if (chatId === undefined || chatId === null) return
  // whitelist: чужие chat_id игнорируются (никаких ответов и логов содержимого)
  if (!tgAllowed(chatId)) { tgLog('запрет доступа: chat_id=' + chatId); return }
  if (cq) {
    try { await tgAnswerCb(cq.id) } catch (e) {}
    await onCallback(chatId, String(cq.data || ''), cq.message || {})
    return
  }
  const text = (msg.text === undefined || msg.text === null) ? '' : String(msg.text)
  await onMessage(chatId, msg.message_id, text)
}

async function tgUiLoop() {
  // защита от «призрачных» апдейтов: сбрасываем накопившуюся очередь (offset:-1)
  TG_UI.flushDone = false
  try {
    const flush = await tgApi('getUpdates', { offset: -1, timeout: 0 })
    if (flush && flush.ok && Array.isArray(flush.result) && flush.result.length) {
      const last = flush.result[flush.result.length - 1]
      TG_UI.offset = (last.update_id || 0) + 1
      tgLog('offset flush: сброшено старых апдейтов ' + flush.result.length + ' (offset=' + TG_UI.offset + ')')
    } else if (flush && flush.ok) {
      TG_UI.offset = 0
    }
  } catch (e) { tgLog('offset flush ошибка: ' + e.message) }
  TG_UI.flushDone = true

  let errStreak = 0
  while (TG_UI.running) {
    let r = null
    try { r = await tgGetUpdates(TG_UI.offset, TG_CFG.pollTimeoutSec) } catch (e) { r = { ok: false, description: e.message } }
    if (!TG_UI.running) break
    if (!r || !r.ok) {
      errStreak++
      tgLog('getUpdates ошибка: ' + ((r && (r.description || r.error_code)) || '?') + (errStreak > 3 ? ' (повтор через 10с)' : ' — повтор через 3с'))
      await sleep(errStreak > 3 ? 10000 : 3000)
      continue
    }
    errStreak = 0
    const list = Array.isArray(r.result) ? r.result : []
    for (const u of list) {
      if (u && u.update_id) TG_UI.offset = u.update_id + 1     // offset сразу за апдейт (flush)
      try {
        // date-фильтр призраков — ТОЛЬКО для сообщений: апдейты ДО старта пульта игнорируем
        // (date=0 — мок/локальный endpoint, пропускаем). Callback'и не фильтруем: нажатие
        // кнопки на «старом» статус-блоке после рестарта — легитимное действие.
        const d = u && u.message ? u.message.date : 0
        if (d && TG_UI.startedAt && d < TG_UI.startedAt - 30) { dbg('[tg] призрачный апдейт ' + u.update_id + ' (date=' + d + ') — пропущен'); continue }
        await handleUpdate(u)
      } catch (e) { tgLog('handleUpdate ошибка: ' + e.message) }
    }
    if (!list.length && TG_CFG.pollTimeoutSec <= 0) await sleep(500)   // коротко-поллинговый режим (мок)
  }
  tgLog('пульт остановлен')
}

function tgUiStart() {
  if (TG_UI.running) return
  TG_UI.running = true
  TG_UI.startedAt = Math.floor(Date.now() / 1000)
  step('📱 TELEGRAM-ПУЛЬТ: запущен (бот id ' + (TG_CFG.token ? TG_CFG.token.split(':')[0] : '?') + ', whitelist: ' + (TG_CFG.allowedChatIds.join(', ') || 'ПУСТО — никто не подключится') + ')')
  step('   кнопки «' + BTN_ALGO + '» и «' + BTN_PERSONAL + '» — на экране телефона (reply-клавиатура); отправьте /start в чат бота, если их не видно')
  tgLog('пульт v5.1.1 запущен; allowedChatIds=' + JSON.stringify(TG_CFG.allowedChatIds))
  tgUiLoop().catch(e => { tgLog('tgUiLoop fatal: ' + e.message); TG_UI.running = false })
}
function tgUiStop() { TG_UI.running = false }

// ========================= SELFTEST (офлайн, без сервера и интернета) =========================
async function selftest() {
  console.log('=== SELFTEST v5.1.1: геометрия сборки + туннели/физканалы + решатель + база аккаунтов + слоты + TG-пульт (мок) ===')
  // самопроверка НЕ выходит в интернет: хост-модель Roboflow на это время выключаем,
  // иначе yoloRecognize сходил бы в облако вместо локального мок-сервера (и потратил кредиты)
  const rfReadyWas = RF.ready
  const rfDisabledWas = RF.disabledReason
  RF.ready = false
  RF.disabledReason = 'selftest: облако отключено (офлайн-режим)'
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
  console.log('--- сквозной прогон saveRound (облегчённая запись v4) ---')
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
    try { rec = saveRound(outDir, snap, 'SELFTEST', null) } catch (e) { err = e }
    if (err) { console.log('  \u274c saveRound бросил: ' + err.message); fails++ }
    else if (!rec) { console.log('  \u274c saveRound вернул null'); fails++ }
    else {
      let diff = 0
      try {
        const got = fs.readFileSync(path.join(outDir, 'ORIGINAL_raw.bin'))
        for (let i = 0; i < orig.length; i++) if (got[i] !== orig[i]) diff++
      } catch (e) { diff = orig.length }
      const pct = 100 * diff / orig.length
      const filesOk = ['ORIGINAL_CAPTCHA.png', 'ORIGINAL_CAPTCHA_x1.png', 'layout.json', 'assembly_debug.json', 'walls_debug.json', 'ORIGINAL_raw.bin', 'chat.log', 'session_log.txt']
        .every(f => fs.existsSync(path.join(outDir, f)))
      // локальной нейросети больше нет: в папке раунда НЕ должно быть glyphs/, variants/, tiles/, digits.json
      const noLegacy = !fs.existsSync(path.join(outDir, 'glyphs')) && !fs.existsSync(path.join(outDir, 'variants')) &&
        !fs.existsSync(path.join(outDir, 'tiles')) && !fs.existsSync(path.join(outDir, 'digits.json')) &&
        !fs.existsSync(path.join(outDir, 'debug_segmentation.png'))
      const ok = pct < 0.5 && filesOk && noLegacy && rec.tilesCount === cols * rows
      if (!ok) fails++
      console.log('  ' + (ok ? '\u2705' : '\u274c') + ' saveRound ' + rec.cols + '\u00d7' + rec.rows +
        ' tiles=' + rec.tilesCount + '/' + rec.tilesExpected + ' ori=' + rec.ori + ' rot=' + rec.rotRule +
        (rec.permUsed ? ' PERM!' : '') + ' seam=' + rec.seamCost +
        ' файлы=' + (filesOk ? 'все' : 'НЕ ВСЕ') +
        ' без-легаси=' + (noLegacy ? 'ок (glyphs/variants/tiles/digits.json не пишутся)' : 'СБОЙ') +
        ' расхождений=' + pct.toFixed(3) + '%')
    }
  }
  // ---- выбор настоящей стены среди соседей (регрессия раунда 6, теперь на чистой геометрии) ----
  console.log('--- выбор настоящей стены среди соседей (регрессия раунда 6) ---')
  {
    const cols = 4, rows = 3
    const trueDigits = '42715', decoyDigits = '99331'
    const gA = makeSyntheticDigits(cols, rows, trueDigits, 5150)
    const gB = makeSyntheticDigits(cols, rows, decoyDigits, 7777)
    const view = { x: 202, y: 70, z: 294.9, yaw: 0, pitch: 0 }   // бот смотрит на юг (+z)
    // настоящая стена: прямо перед ботом (z=299.94)
    const A = makeWallSnapshot(gA.img, gA.W, gA.H, { axis: 'z', viewSide: -1, rots: true, id0: 2000, ox: 200, oy: 70, oz: 300, view })
    // соседняя стена: сбоку и дальше (перпендикулярная, x=210)
    const B = makeWallSnapshot(gB.img, gB.W, gB.H, { axis: 'x', viewSide: +1, rots: true, id0: 2100, ox: 300, oy: 70, oz: 210, view })
    const maps = new Map([...A.maps, ...B.maps])
    const frames = A.frames.concat(B.frames)
    const snap = { maps, frames, chats: [], events: ['selftest'], view, metaDump: [] }
    const cands = detectWalls(frames.filter(f => maps.has(f.mapId)), wallMinFrames(frames.length))
    const outDir = path.join(REC_ROOT || __dirname, 'selftest_learn', 'walls')
    const rec = saveRound(outDir, snap, 'WALLS', null)
    const expectTag = 'z300'
    const okWall = !!rec && rec.wall === expectTag
    const okNoArtifact = cands.every(w => w.frames.length === 12)     // никаких «сквозных» 6-рамочных псевдостен
    const ok = okWall && okNoArtifact
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' кандидатов=' + cands.map(w => w.tag + '(' + w.frames.length + ')').join(',') +
      ' | выбрана=' + (rec ? rec.wall : 'нет') + ' (ждали ' + expectTag + ')' +
      ' | сквозных артефактов: ' + (okNoArtifact ? 'нет' : 'ЕСТЬ') +
      (rec ? ' | счёт: ' + rec.candidates.map(c => c.wall + '=' + c.score).join(', ') : ''))
  }

  // ---- РЕГРЕССИЯ: бот стоит вплотную к капче, но yaw смотрит назад (dot≈-1) ----
  console.log('--- ближайшая стена выигрывает, даже если бот смотрит не на неё ---')
  {
    const cols = 4, rows = 3
    const gA = makeSyntheticDigits(cols, rows, '53091', 2468)
    const gB = makeSyntheticDigits(cols, rows, '1111', 1357)
    const view = { x: 202, y: 70, z: 305, yaw: 0, pitch: 0 }   // бот смотрит на +z (на юг)
    // A — капча: вплотную, но ЗА спиной (dot ≈ -1).  B — соседняя: далеко ВПЕРЕДИ (dot ≈ +1)
    const A = makeWallSnapshot(gA.img, gA.W, gA.H, { axis: 'z', viewSide: +1, rots: true, id0: 4000, ox: 200, oy: 70, oz: 302, view })
    const B = makeWallSnapshot(gB.img, gB.W, gB.H, { axis: 'z', viewSide: -1, rots: true, id0: 4100, ox: 200, oy: 70, oz: 365, view })
    const maps = new Map([...A.maps, ...B.maps])
    const snap = { maps, frames: A.frames.concat(B.frames), chats: [], events: ['selftest'], view, metaDump: [] }
    const outDir = path.join(REC_ROOT || __dirname, 'selftest_learn', 'behind')
    const rec = saveRound(outDir, snap, 'BEHIND', null)
    const ok = !!rec && rec.wall === 'z302' && rec.dot < 0
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' выбрана=' + (rec ? rec.wall : 'нет') + ' (ждали z302, dot<0)' +
      ' dot=' + (rec ? rec.dot.toFixed(2) : '?') + ' dist=' + (rec ? rec.dist : '?') +
      (rec ? ' | счёт: ' + rec.candidates.map(c => c.wall + '=' + c.score).join(', ') : ''))
  }
  console.log('--- YOLO API (мок-сервер, без интернета) ---')
  {
    const http = require('http')
    const PORT = 0
    const srv = http.createServer((rq, rs) => {
      const b = []
      rq.on('data', c => b.push(c))
      rq.on('end', () => {
        const buf = Buffer.concat(b), s = buf.toString('latin1')
        const j = o => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)) }
        const field = (s.match(/name="([^"]+)"; filename=/) || [])[1] || null
        if (rq.url.indexOf('/recognize') === 0) return j({ success: true, answer: '48152', field, conf: 0.6, ms: 90 })
        if (rq.url.indexOf('/solve') === 0) return j({ result: '13579' })
        if (rq.url.indexOf('/html') === 0) { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end('<html><body>404</body></html>'); return }
        if (rq.url.indexOf('/bad') === 0) return j({ success: false, error: 'no boxes' })
        j({ success: false, error: 'route?' })
      })
    })
    await new Promise(r => srv.listen(PORT, '127.0.0.1', r))
    const port = srv.address().port
    const savedUrls = YOLO.urls.slice(), savedAlive = yoloAlive
    const g = makeSyntheticDigits(4, 3, '48152', 555)
    const png = colorPng(g.img, g.W, g.H, 1)
    const checks = []

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/recognize']
    let r1 = await yoloRecognize(png, 'st1')
    checks.push(['формат {success,answer} + поле image', !!r1 && r1.digits === '48152' && r1.field === 'image'])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/solve']
    let r2 = await yoloRecognize(png, 'st2')
    checks.push(['формат {result} (Flask из треда)', !!r2 && r2.digits === '13579'])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/html']
    let r3 = await yoloRecognize(png, 'st3')
    checks.push(['HTML-страница НЕ принимается за цифры', r3 === null])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/bad']
    let r4 = await yoloRecognize(png, 'st4')
    checks.push(['success:false -> нет ответа', r4 === null])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:1/recognize', 'http://127.0.0.1:' + port + '/recognize']
    let r5 = await yoloRecognize(png, 'st5')
    checks.push(['fallback на следующий URL', !!r5 && r5.digits === '48152'])

    srv.close()
    YOLO.urls = savedUrls
    yoloReset()
    for (const [name, ok] of checks) { if (!ok) fails++; console.log('  ' + (ok ? '\u2705' : '\u274c') + ' ' + name) }
  }


  console.log('--- v3.13.0: диагностика прокси (parseChangeIpResponse, SOCKS5, HTTP CONNECT, MC status) ---')
  {
    // 1) чистые функции разбора
    const cj = parseChangeIpResponse(200, '{"status":"OK","new_ip":"94.25.229.79","rt":"5.15"}', 'https://changeip.mobileproxy.space/?proxy_key=X&format=json')
    const ch = parseChangeIpResponse(200, '<!DOCTYPE html><html><head><title>Мои прокси</title></head>', 'https://mobileproxy.space/user.html')
    const ci = parseChangeIpResponse(200, '94.25.229.79', 'x')
    const cr = parseChangeIpResponse(200, 'Please wait 30 seconds', 'x')
    const ce = parseChangeIpResponse(200, '', 'x')
    const okParse = cj.kind === 'json' && cj.newIp === '94.25.229.79' && cj.rt === '5.15' &&
      ch.kind === 'html' && ch.title === 'Мои прокси' && /ВЕБ-СТРАНИЦУ/.test(ch.hint) &&
      ci.kind === 'ip' && ci.newIp === '94.25.229.79' &&
      cr.rateLimited === true && ce.kind === 'empty'
    if (!okParse) fails++
    console.log('  ' + (okParse ? '✅' : '❌') + ' parseChangeIpResponse: json/html(«' + ch.title + '»)/ip/rate/empty')

    const okAlt = altHostOf('bproxy.site') === 'mproxy.site' && altHostOf('mproxy.site') === 'bproxy.site' && altHostOf('x.com') === null
    if (!okAlt) fails++
    console.log('  ' + (okAlt ? '✅' : '❌') + ' altHostOf: bproxy↔mproxy, чужой хост → null')

    const okJson = ensureJsonParam('https://x/?k=1') === 'https://x/?k=1&format=json' &&
      ensureJsonParam('https://x/?format=json') === 'https://x/?format=json' &&
      ensureJsonParam('https://x') === 'https://x?format=json'
    if (!okJson) fails++
    console.log('  ' + (okJson ? '✅' : '❌') + ' ensureJsonParam: дописывает format=json, не дублирует')

    const okHint = /proxy-check/.test(socksHint('ConnectionRefused')) && /password|авториз/i.test(socksHint('прокси ОТВЕРГ логин/пароль'))
    if (!okHint) fails++
    console.log('  ' + (okHint ? '✅' : '❌') + ' socksHint: подсказка для ECONNREFUSED и для отказа авторизации')

    // 2) живой SOCKS5 handshake против мок-сервера (с авторизацией, домен-бинд, «лишние» байты одним сегментом)
    const mkSocks = (bindAtyp, creds) => net.createServer(sock => {
      let stage = 0
      sock.on('data', d => {
        if (stage === 0) { const ms = Array.from(d.slice(2, 2 + d[1])); if (ms.includes(0x02)) { sock.write(Buffer.from([0x05, 0x02])); stage = 1 } else { sock.write(Buffer.from([0x05, 0x00])); stage = 2 }; return }
        if (stage === 1) { const ul = d[1], u = d.slice(2, 2 + ul).toString(), pl = d[2 + ul], p = d.slice(3 + ul, 3 + ul + pl).toString(); if (u === creds[0] && p === creds[1]) { sock.write(Buffer.from([0x01, 0x00])); stage = 2 } else { sock.write(Buffer.from([0x01, 0x01])); sock.end() }; return }
        if (stage === 2) {
          stage = 3
          let reply
          if (bindAtyp === 1) reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50])
          else { const h = Buffer.from('api.ipify.org'); reply = Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x03, h.length]), h, Buffer.from([0x00, 0x50])]) }
          sock.write(Buffer.concat([reply, Buffer.from('HTTP/1.1 200 OK\r\n\r\n9.9.9.9')]))
          setTimeout(() => sock.end(), 80)
        }
      })
    })
    const srv1 = mkSocks(3, ['good', 'pass'])
    await new Promise(r => srv1.listen(0, '127.0.0.1', r))
    const p1 = srv1.address().port
    let s1body = null, s1err = null
    try { const s = await socks5Open({ host: '127.0.0.1', port: p1, userId: 'good', password: 'pass' }, 'api.ipify.org', 80, 5000); s1body = await httpThrough(s, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\n\r\n', 3000) } catch (e) { s1err = e.message }
    srv1.close()
    const okSocks = !s1err && /9\.9\.9\.9/.test(String(s1body))
    if (!okSocks) fails++
    console.log('  ' + (okSocks ? '✅' : '❌') + ' socks5Open+httpThrough: handshake с auth, домен-бинд, «лишние» байты не потеряны → «' + String(s1body || s1err).slice(0, 30) + '»')

    // 3) SOCKS5 отвергает неверный пароль
    const srv2 = mkSocks(1, ['good', 'pass'])
    await new Promise(r => srv2.listen(0, '127.0.0.1', r))
    const p2 = srv2.address().port
    let s2err = null
    try { await socks5Open({ host: '127.0.0.1', port: p2, userId: 'bad', password: 'x' }, 'api.ipify.org', 80, 5000) } catch (e) { s2err = e.message }
    srv2.close()
    const okReject = /ОТВЕРГ логин/.test(String(s2err))
    if (!okReject) fails++
    console.log('  ' + (okReject ? '✅' : '❌') + ' socks5Open: неверный пароль отвергнут → «' + String(s2err || 'НЕ ОТВЕРГНУТ').slice(0, 50) + '»')

    // 4) ConnectionRefused → понятная ошибка (как в логе 21:19)
    let s3err = null
    try { await socks5Open({ host: '127.0.0.1', port: p2 + 1, userId: 'a', password: 'b' }, 'x', 80, 3000) } catch (e) { s3err = e.message }
    const okRefused = /ОТКАЗАЛ в соединении \(ECONNREFUSED\)/.test(String(s3err))
    if (!okRefused) fails++
    console.log('  ' + (okRefused ? '✅' : '❌') + ' socks5Open: мёртвый порт → «' + String(s3err || 'нет ошибки').slice(0, 70) + '»')

    // 5) HTTP CONNECT (mproxy.site) + авторизация Basic
    const srvH = net.createServer(sock => {
      let head = ''
      sock.on('data', d => {
        head += d.toString('latin1')
        if (head.indexOf('\r\n\r\n') < 0) return
        if (!/^CONNECT /.test(head)) { sock.end('HTTP/1.1 400 Bad\r\n\r\n'); return }
        const okAuth = /Proxy-Authorization: Basic /.test(head)
        if (!okAuth) { sock.end('HTTP/1.1 407 Proxy Auth Required\r\n\r\n'); return }
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n')
        sock.write('HTTP/1.1 200 OK\r\n\r\n7.7.7.7'); setTimeout(() => sock.end(), 80)
      })
    })
    await new Promise(r => srvH.listen(0, '127.0.0.1', r))
    const pH = srvH.address().port
    let hbody = null, herr = null
    try { const s = await httpConnect({ host: '127.0.0.1', port: pH, userId: 'u', password: 'p' }, 'api.ipify.org', 80, 5000); hbody = await httpThrough(s, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\n\r\n', 3000) } catch (e) { herr = e.message }
    srvH.close()
    const okHttp = !herr && /7\.7\.7\.7/.test(String(hbody))
    if (!okHttp) fails++
    console.log('  ' + (okHttp ? '✅' : '❌') + ' httpConnect: HTTP-прокси + Basic-auth → «' + String(hbody || herr).slice(0, 30) + '»')

    // 6) mcStatusPing: мок MC-сервера отдаёт status JSON
    const varint = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x) } while (n); return Buffer.from(b) }
    const srvM = net.createServer(sock => {
      sock.on('data', () => {
        const json = JSON.stringify({ version: { name: '1.21.1', protocol: 767 }, players: { max: 100, online: 42 }, description: { text: 'FunTime' } })
        const body = Buffer.concat([varint(0x00), Buffer.from(json, 'utf8')])
        sock.write(Buffer.concat([varint(body.length), body])); setTimeout(() => sock.end(), 60)
      })
    })
    await new Promise(r => srvM.listen(0, '127.0.0.1', r))
    const pM = srvM.address().port
    const msock = net.connect({ host: '127.0.0.1', port: pM })
    await new Promise(r => msock.once('connect', r))
    const mp = await mcStatusPing(msock, 5000)
    srvM.close()
    const okMc = mp.ok && mp.json && mp.json.version && mp.json.version.protocol === 767 && mp.json.players.online === 42
    if (!okMc) fails++
    console.log('  ' + (okMc ? '✅' : '❌') + ' mcStatusPing: разобрал status-ответ сервера (protocol ' + (mp.json && mp.json.version ? mp.json.version.protocol : '?') + ', online ' + (mp.json && mp.json.players ? mp.json.players.online : '?') + ')')
  }


  // ============ v3.13.1: installer-safe header (защита от брака установщика) ============
  console.log('--- v3.13.1: installer-safe header (START.bat не должен отвергнуть файл) ---')
  {
    // Установщик (looksLikeHtmlFile в START.bat) читает первые 4096 байт файла и
    // ищет HTML-маркеры; если найдёт — отбракует скачанный main.js («gave invalid»).
    // В v3.13.0 маркер doctype стоял в комментарии P2 — установщик падал с кодом 1.
    // Здесь ловим рецидив: ни одного маркера в первых 4096 байтах быть не должно.
    const mfp = path.join(__dirname, 'main.js')
    const fd = fs.openSync(mfp, 'r')
    const hb = Buffer.alloc(4096)
    const hn = fs.readSync(fd, hb, 0, 4096, 0)
    fs.closeSync(fd)
    const head = hb.slice(0, hn).toString('utf8').replace(/^\uFEFF/, '').trim().slice(0, 3000).toLowerCase()
    const markers = ['<!doctype', '<html', '<head', '<body', '<title', 'you signed in', 'reload to refresh your session', 'switched accounts']
    const hit = markers.filter(m => head.indexOf(m) >= 0)
    const okHead = hit.length === 0
    if (!okHead) fails++
    console.log('  ' + (okHead ? '✅' : '❌') + ' installer-safe header: HTML-маркеров в первых 4096 байтах нет' +
      (okHead ? '' : ' → найдены: ' + hit.join(', ') + ' (перепишите комментарий, установщик отвергнет файл)'))
  }


  console.log('--- v3.14.0: Roboflow captcha-funtime/2 (predictions -> цифры, поле "file") ---')
  {
    // ответ облака ровно в том виде, в каком он пришёл 2026-10-20 (капча 58656)
    const resp = {
      image: { width: 512, height: 384 },
      predictions: [
        { x: 364.5, y: 216.0, width: 135, height: 196, confidence: 0.97, class: '5', class_id: 5 },
        { x: 157.5, y: 148.0, width: 97, height: 104, confidence: 0.96, class: '8', class_id: 8 },
        { x: 460.5, y: 128.5, width: 69, height: 93, confidence: 0.96, class: '6', class_id: 6 },
        { x: 55.5, y: 238.0, width: 105, height: 152, confidence: 0.96, class: '5', class_id: 5 },
        { x: 262.5, y: 290.0, width: 55, height: 100, confidence: 0.95, class: '6', class_id: 6 }
      ]
    }
    const a = rfBoxesToDigits(resp.predictions, { want: 5, overlap: 0.2 })
    const okOrder = a.digits === '58656' && a.exact === true
    if (!okOrder) fails++
    console.log('  ' + (okOrder ? '✅' : '❌') + ' реальный ответ облака -> «' + a.digits + '» (жду 58656), рамок ' + a.boxes.length + '/5, порядок слева направо')

    // мусорные рамки той же цифры должны гаситься overlap'ом, а не удваивать цифру
    const noisy = resp.predictions.concat([
      { x: 160, y: 150, width: 100, height: 108, confidence: 0.41, class: '8', class_id: 8 },   // дубль «8»
      { x: 366, y: 218, width: 130, height: 190, confidence: 0.33, class: '5', class_id: 5 },   // дубль «5»
      { x: 300, y: 330, width: 40, height: 40, confidence: 0.12, class: '1', class_id: 1 }       // шум
    ])
    const b = rfBoxesToDigits(noisy, { want: 5, overlap: 0.2 })
    const okNoise = b.digits === '58656' && b.rawBoxes === 8
    if (!okNoise) fails++
    console.log('  ' + (okNoise ? '✅' : '❌') + ' 8 рамок с дублями/шумом -> «' + b.digits + '» (порог ' + b.conf + '), лишнее подавлено overlap')

    // не-цифровые классы и пустой ответ не должны ронять разбор
    const c = rfBoxesToDigits([{ x: 10, y: 10, width: 5, height: 5, confidence: 0.9, class: 'digit', class_id: 0 }], { want: 5 })
    const d = rfBoxesToDigits([], { want: 5 })
    const okEmpty = c.digits === '' && c.exact === false && d.digits === '' && d.incomplete === true
    if (!okEmpty) fails++
    console.log('  ' + (okEmpty ? '✅' : '❌') + ' классы-не-цифры и пустой predictions -> цифр нет, exact=false (бот пойдёт запасным путём)')

    // запрос: поле ОБЯЗАНО называться "file", ключ — в query, в логах ключа нет
    const mp = multipart({}, { field: RF.field, name: 'captcha.png', type: 'image/png', data: Buffer.from([1, 2, 3]) })
    const body = mp.body.toString('latin1')
    const u = rfUrl()
    const okReq = /name="file"/.test(body) && /^https:\/\/serverless\.roboflow\.com\/captcha-funtime\/2\?api_key=/.test(u.replace(RF.apiKey || '@@@', 'KEY')) &&
      /confidence=\d+/.test(u) && /overlap=\d+/.test(u) && RF.field === 'file'
    if (!okReq) fails++
    console.log('  ' + (okReq ? '✅' : '❌') + ' запрос: multipart-поле «' + RF.field + '», URL ' + u.replace(/api_key=[^&]*/, 'api_key=***') +
      ' (ключ в лог не печатаем: ' + rfMaskKey(RF.apiKey) + ')')

    // сообщения об ошибках облака понятные и не содержат ключ
    const h401 = rfHint(401, '{"message":"Unauthorized api_key"}')
    const okHint = /ключ/i.test(h401) && rfHint(404, '').indexOf('modelId') > 0 && rfHint(402, '').indexOf('кредит') > 0 && rfHint(429, '').length > 5
    if (!okHint) fails++
    console.log('  ' + (okHint ? '✅' : '❌') + ' подсказки: 401 -> «' + h401.slice(0, 60) + '…»')

    // Cloudflare-блок (HTML 403) НЕ должен навсегда выключать облако, а JSON-401 — должен
    const okClass = rfFatal(403, '<!DOCTYPE html><html>Sorry</html>') === false &&
      rfFatal(401, '{"status":401,"message":"Unauthorized api_key. This key is not authorized for serverless inference."}') === true &&
      rfFatal(404, '{"message":"Requested Roboflow resource not found."}') === true &&
      rfFatal(429, '{"message":"slow down"}') === false
    if (!okClass) fails++
    console.log('  ' + (okClass ? '✅' : '❌') + ' классификация ошибок: HTML-403 (Cloudflare) = временно, JSON-401 (ключ) и 404 (модель) = фатально, 429 = повтор')

    // недоступное облако: rfRecognize обязан вернуть null быстро и не уронить бота
    const sv = { ready: RF.ready, host: RF.host, retries: RF.retries, fails: RF.fails, dis: RF.disabledReason, key: RF.apiKey, useSocks: RF.useSocks }
    RF.ready = true; RF.apiKey = 'TESTKEY'; RF.host = '127.0.0.1:1'; RF.retries = 1; RF.fails = 0; RF.disabledReason = ''; RF.useSocks = false
    let dead = 'не вернул null', tDead = Date.now()
    try { dead = await rfRecognize(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'SELFTEST-DEAD') } catch (e) { dead = 'исключение: ' + e.message }
    const msDead = Date.now() - tDead
    const okDead = dead === null && RF.fails === 1 && !!RF.lastError && msDead < 8000
    if (!okDead) fails++
    console.log('  ' + (okDead ? '✅' : '❌') + ' облако недоступно -> null за ' + msDead + 'мс, ошибок подряд ' + RF.fails +
      ', причина: «' + String(RF.lastError).slice(0, 50) + '» (бот уйдёт на локальную модель)')
    RF.ready = sv.ready; RF.apiKey = sv.key; RF.host = sv.host; RF.retries = sv.retries; RF.fails = sv.fails; RF.disabledReason = sv.dis; RF.useSocks = sv.useSocks
  }

  // ============ v4.0.0: туннели, авторизация, вердикты чата, ники/пароли ============
  console.log('--- v4.0.0: туннели из конфига (proxy → 1 туннель, tunnels[] → N) ---')
  {
    const T1 = makeTunnel({ host: 'bproxy.site', port: 23750, username: 'u', password: 'p', changeIpUrl: 'https://changeip.mobileproxy.space/?proxy_key=X', waitAfterIpChangeSec: 12 }, 0)
    const ok1 = !!T1 && T1.cfg.host === 'bproxy.site' && T1.cfg.port === 23750 && T1.state === 'unknown' && T1.name === 'tunnel1'
    // хосты-кандидаты: запомненный живой → конфиг → altHosts → производный mproxy/bproxy
    T1.okHost = null
    const cand = proxyHostCandidates(T1)
    const ok2 = cand[0] === 'bproxy.site' && cand.indexOf('mproxy.site') > 0
    T1.okHost = 'mproxy.site'
    const cand2 = proxyHostCandidates(T1)
    const ok3 = cand2[0] === 'mproxy.site'
    // пустой хост → туннель не создаётся
    const ok4 = makeTunnel({ host: '' }, 0) === null && makeTunnel({}, 1) === null
    // без туннеля proxyHostCandidates(host) не падает
    const ok5 = proxyHostCandidates(null, 'bproxy.site').indexOf('bproxy.site') === 0
    const okAll = ok1 && ok2 && ok3 && ok4 && ok5
    if (!okAll) fails++
    console.log('  ' + (okAll ? '✅' : '❌') + ' makeTunnel/proxyHostCandidates: конфиг, живой хост в приоритете, altHosts+bproxy↔mproxy, пустой хост отброшен')
  }

  console.log('--- v4.0.0: команды авторизации /reg и /l ---')
  {
    const ok1 = buildAuthCommand('/reg {pass}', 'aB3xY9') === '/reg aB3xY9'
    const ok2 = buildAuthCommand('/l {pass}', 'aB3xY9') === '/l aB3xY9'
    const ok3 = buildAuthCommand('/register {pass} {pass}', 'q1') === '/register q1 q1'
    const ok4 = buildAuthCommand('/reg', 'q1') === '/reg q1'          // без плейсхолдера — через пробел
    const ok5 = buildAuthCommand('', 'q1') === ''                       // пустой шаблон — ничего не шлём
    const okAll = ok1 && ok2 && ok3 && ok4 && ok5
    if (!okAll) fails++
    console.log('  ' + (okAll ? '✅' : '❌') + ' buildAuthCommand: /reg {pass}, /l {pass}, двойной пароль, без плейсхолдера, пустой шаблон')
  }

  console.log('--- v4.0.0: классификатор ответов сервера (matchAny + waitVerdict-логика) ---')
  {
    const okSuccess = !!matchAny('[chat] Вы успешно прошли капчу!', SOLVER.successWords)
    const okAuth = !!matchAny('[chat] Зарегистрируйтесь: /reg <пароль>', SOLVER.authWords)
    const okFail = !!matchAny('[chat] Неверно! Введите код ещё раз', SOLVER.failWords)
    const okBan = !!matchAny('Вы забанены на этом сервере', SOLVER.banWords)
    const okRegOk = !!matchAny('[chat] Регистрация успешно завершена!', SOLVER.regOkWords)
    const okRegExists = !!matchAny('[chat] Этот игрок уже зарегистрирован. Авторизуйтесь: /l', SOLVER.regExistsWords)
    const okNone = !matchAny('[chat] <Player123> 48152', SOLVER.successWords.concat(SOLVER.failWords, SOLVER.authWords))
    const okCase = !!matchAny('[chat] УСПЕШНО ПРОШЛИ КАПЧУ', SOLVER.successWords)   // регистронезависимо
    const okAll = okSuccess && okAuth && okFail && okBan && okRegOk && okRegExists && okNone && okCase
    if (!okAll) fails++
    console.log('  ' + (okAll ? '✅' : '❌') + ' matchAny: успех/«зарегистрируйтесь»/«неверно»/бан/reg-ok/«уже зарегистрирован»/эхо-своего-чата/регистр')
    // успех НЕ должен путаться с провалом: порядок проверки success → auth → fail (как в waitVerdict)
    const line = '[chat] Капча решена успешно! Введите /reg пароль'
    const first = matchAny(line, SOLVER.successWords) ? 'success' : (matchAny(line, SOLVER.authWords) ? 'auth' : (matchAny(line, SOLVER.failWords) ? 'fail' : 'none'))
    const okOrder = first === 'success'
    if (!okOrder) fails++
    console.log('  ' + (okOrder ? '✅' : '❌') + ' приоритет вердикта: «успешно…/reg» → success (не fail)')
  }

  console.log('--- v4.0.0: генерация ников и паролей ---')
  {
    const nicks = new Set()
    for (let i = 0; i < 200; i++) nicks.add(randomNick('Player'))
    const okNick = nicks.size === 200 && [...nicks].every(n => /^Player\d+$/.test(n) && n.length <= 16)
    const p = randomPass(10)
    const okPass = p.length === 10 && /^[A-Za-z0-9]+$/.test(p) && !/[Il1O0]/.test(p)   // без неоднозначных символов
    const okLen = randomPass(3).length === 6 && randomPass(99).length === 32           // клампы 6..32
    const okAll = okNick && okPass && okLen
    if (!okAll) fails++
    console.log('  ' + (okAll ? '✅' : '❌') + ' randomNick (200 уникальных, ≤16 симв.) + randomPass (10 симв., без I/l/1/O/0, клампы)')
  }

  console.log('--- v4.0.0: очередь распознавания сериализует параллельные запросы ---')
  {
    const order = []
    const slow = (name, ms) => new Promise(res => setTimeout(() => { order.push(name); res({ digits: '12345', host: name, ms }) }, ms))
    let q = Promise.resolve()
    const via = (name, ms) => { const run = () => slow(name, ms); const p = q.then(run, run); q = p.catch(() => {}); return p }
    await Promise.all([via('a', 30), via('b', 5), via('c', 5)])
    const okQ = order.join('') === 'abc'
    if (!okQ) fails++
    console.log('  ' + (okQ ? '✅' : '❌') + ' параллельные вызовы выстраиваются в очередь (порядок a,b,c: ' + order.join(',') + ')')
  }
  // ============ v5.0.0: АНАРХИИ (диапазоны + парсер ТОЛЬКО /anN) ============
  console.log('--- v5.0.0: анархии (диапазоны, парсер /anN, список) ---')
  {
    const okRanges = anarchyOk(102) && anarchyOk(112) && !anarchyOk(113) && anarchyOk(202) && anarchyOk(304) &&
      anarchyOk(514) && anarchyOk(902) && anarchyOk(904) && !anarchyOk(905) && !anarchyOk(999) && !anarchyOk(0) && !anarchyOk(-5)
    if (!okRanges) fails++
    console.log('  ' + (okRanges ? '✅' : '❌') + ' диапазоны: границы 102/112/202/304/514/902/904 — в списке; 113/905/999/0 — нет')

    const okParse = parseAnarchyCmd('/an304') === 304 && parseAnarchyCmd(' /an305 ') === 305 &&
      parseAnarchyCmd('/AN102') === 102 && parseAnarchyCmd('304') === null && parseAnarchyCmd('/an999') === null &&
      parseAnarchyCmd('an304') === null && parseAnarchyCmd('/an') === null && parseAnarchyCmd('') === null
    if (!okParse) fails++
    console.log('  ' + (okParse ? '✅' : '❌') + ' парсер: «/an304»→304; «304» без /an НЕ принимается (это релей); /an999 вне диапазонов→null')

    const list = anarchyListText()
    const okList = list.indexOf('102-112') >= 0 && list.indexOf('902-904') >= 0 && list.split(';').length === ANARCHY.ranges.length
    if (!okList) fails++
    console.log('  ' + (okList ? '✅' : '❌') + ' список анархий: «' + list + '»')
  }

  // ============ v5.1.0: автосоздание туннелей (1 personal + ≥1 algo, общий физканал) ============
  console.log('--- v5.1.0: туннели — автосоздание и физические каналы ---')
  {
    const tl = tunnelsFromConfig(true)          // quiet: не писать в TUNNELS.notes
    const pers = tl.filter(t => t.role === 'personal')
    const algo = tl.filter(t => t.role === 'algo')
    const okAuto = PROXY.host ? (pers.length === 1 && algo.length >= 1) : tl.length === 0
    if (!okAuto) fails++
    console.log('  ' + (okAuto ? '✅' : '❌') + ' «tunnels» пуста → автосозданы: personal ровно 1 + algo ≥1 (proxy.host=' + (PROXY.host || 'нет') + ')')
    if (PROXY.host && pers.length === 1 && algo.length >= 1) {
      const okShare = pers[0].physical === algo[0].physical && pers[0].slots === algo[0].slots
      algo[0].ip = '7.7.7.7'
      const okIp = pers[0].ip === '7.7.7.7'
      algo[0].ip = null
      algo[0].lastChangeAt = 123
      const okMutex = pers[0].lastChangeAt === 123
      algo[0].lastChangeAt = 0
      const okDedup = distinctPhysical(tl).length === 1
      const okAll = okShare && okIp && okMutex && okDedup
      if (!okAll) fails++
      console.log('  ' + (okAll ? '✅' : '❌') + ' общий физканал: IP/ротация/слоты разделяются (запись через algo видна в personal), дедуп=1 канал')
    }
    // личный туннель ТОЛЬКО ОДИН: лишние personal понижаются до algo
    const l2 = [makeTunnel({ name: 'p1', host: 'h1.example', port: 1, role: 'personal' }, 0),
                makeTunnel({ name: 'p2', host: 'h2.example', port: 2, role: 'personal' }, 1),
                makeTunnel({ name: 'a1', host: 'h3.example', port: 3, role: 'algo' }, 2)]
    const notes2 = []
    enforceSinglePersonal(l2, notes2)
    dedupePhysical(l2)
    const okSingle = l2.filter(t => t.role === 'personal').length === 1 && l2[0].role === 'personal' &&
      l2[1].role === 'algo' && notes2.length === 1 && l2[0].physical !== l2[1].physical
    if (!okSingle) fails++
    console.log('  ' + (okSingle ? '✅' : '❌') + ' личный туннель только один: 2-й personal → algo (с заметкой); разные прокси = разные физканалы')
  }

  // ============ v5.1.1: версия сервера + классификация ошибок разбора пакетов ============
  console.log('--- v5.1.1: автоверсия (cleanVersionName/protocolToVersion) + isProtocolParseError ---')
  {
    const okV = cleanVersionName('1.21.1') === '1.21.1' && cleanVersionName('v1.20.4') === '1.20.4' &&
      cleanVersionName('1.16.5') === '1.16.5' && cleanVersionName('BotFilter 1.8.x-26.x') === null &&
      cleanVersionName('1.8-1.21') === null && cleanVersionName('') === null && cleanVersionName(null) === null
    if (!okV) fails++
    console.log('  ' + (okV ? '✅' : '❌') + ' cleanVersionName: «1.21.1»/«v1.20.4» → версия; «BotFilter 1.8.x-26.x»/диапазон/мусор → null')
    const okP = protocolToVersion(767) === '1.21.1' && protocolToVersion(754) === '1.16.5' && protocolToVersion('767') === '1.21.1' &&
      protocolToVersion(769) === '1.21.4' && protocolToVersion(999999) === null && protocolToVersion(0) === null
    if (!okP) fails++
    console.log('  ' + (okP ? '✅' : '❌') + ' protocolToVersion: 767→1.21.1, 754→1.16.5, 769→1.21.4, неизвестный→null')
    const okE = isProtocolParseError('Parse error for play.toClient: Read error for undefined') === true &&
      isProtocolParseError('Deserialization error for play.toClient.field : boom') === true &&
      isProtocolParseError('Read error for undefined : x') === true &&
      isProtocolParseError('client timed out after 60000 milliseconds') === false &&
      isProtocolParseError('ECONNRESET') === false && isProtocolParseError('') === false
    if (!okE) fails++
    console.log('  ' + (okE ? '✅' : '❌') + ' isProtocolParseError: Parse/Deserialization/«Read error for undefined» → true; таймаут/ECONNRESET → false')
  }

  // ============ v5.0.0: БАЗА АККАУНТОВ (9 кейсов, временный файл) ============
  console.log('--- v5.0.0: база аккаунтов learn/accounts_db.json (9 кейсов) ---')
  {
    const dbDir = path.join(REC_ROOT || __dirname, 'selftest_db')
    const tmpDb = path.join(dbDir, 'accounts_db.json')
    const realPath = DB_PATH
    try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch (e) {}
    dbSetPath(tmpDb)
    DB.accounts = []

    // 1. создание + атомарная запись на диск
    const a1 = dbCreate('algo', { name: 'tx', ip: '1.1.1.1' })
    const ok1 = !!a1 && /^Player\d+$/.test(a1.nick) && a1.pass.length >= 6 && a1.status === 'new' && a1.busy === true &&
      a1.owner === 'algo' && a1.tunnel === 'tx' && a1.ip === '1.1.1.1' && fs.existsSync(tmpDb)
    if (!ok1) fails++
    console.log('  ' + (ok1 ? '✅' : '❌') + ' 1. dbCreate: ник/пароль/туннель/IP, статус new, busy, файл записан (tmp+rename)')

    // 2. личный аккаунт ПОСТОЯНЕН: повторный dbPersonal возвращает ТОТ ЖЕ
    const p1 = dbPersonal(777, { name: 'pers', ip: '2.2.2.2' })
    const p2 = dbPersonal(777, { name: 'pers', ip: '2.2.2.2' })
    const ok2 = p1 === p2 && p1.owner === 'tg:777'
    if (!ok2) fails++
    console.log('  ' + (ok2 ? '✅' : '❌') + ' 2. dbPersonal: один и тот же аккаунт (сам не меняется), owner=tg:777')

    // 3. «смена ника»: старый остаётся в базе (retired), новый — другой ник
    const p3 = dbPersonalRotate(777, { name: 'pers', ip: '2.2.2.2' })
    const retired = DB.accounts.filter(a => a.owner === 'tg:777' && a.status === 'retired')
    const ok3 = p3.nick !== p1.nick && retired.length === 1 && retired[0].busy === false &&
      DB.accounts.filter(a => a.owner === 'tg:777' && a.status !== 'retired').length === 1
    if (!ok3) fails++
    console.log('  ' + (ok3 ? '✅' : '❌') + ' 3. dbPersonalRotate: старый → retired (остаётся в базе), новый случайный ник')

    // 4. повторное использование: зарегистрированные algo-аккаунты выдаются из базы
    const a2 = dbCreate('algo', { name: 'tx', ip: '1.1.1.2' })
    dbMarkRegistered(a1); dbMarkRegistered(a2)
    a1.busy = false; a2.busy = false
    const take1 = dbTakeFreeAlgo({ name: 'other', ip: '9.9.9.9' })
    const ok4 = !!take1 && take1.status === 'registered' && take1.busy === true
    if (!ok4) fails++
    console.log('  ' + (ok4 ? '✅' : '❌') + ' 4. dbTakeFreeAlgo: выдаёт зарегистрированный из базы и помечает busy')

    // 5. приоритет «тот же IP»
    take1.busy = false
    const tIp = dbTakeFreeAlgo({ name: 'other', ip: '1.1.1.2' })
    const ok5 = tIp === a2                                  // у a2 ip 1.1.1.2
    if (!ok5) fails++
    console.log('  ' + (ok5 ? '✅' : '❌') + ' 5. приоритет: совпал IP туннеля → выдан аккаунт с этим IP регистрации')

    // 6. приоритет «тот же туннель»
    tIp.busy = false
    const a3 = dbCreate('algo', { name: 'tx', ip: '3.3.3.3' }); dbMarkRegistered(a3); a3.busy = false
    const a4 = dbCreate('algo', { name: 'zz', ip: '4.4.4.4' }); dbMarkRegistered(a4); a4.busy = false
    const tTun = dbTakeFreeAlgo({ name: 'zz', ip: '8.8.8.8' })
    const ok6 = tTun === a4                                  // ip не совпал, туннель «zz» совпал
    if (!ok6) fails++
    console.log('  ' + (ok6 ? '✅' : '❌') + ' 6. приоритет: IP не совпал → выдан аккаунт того же туннеля')

    // 7. занятые не выдаются; исчерпано → null
    for (const a of DB.accounts) a.busy = true
    const ok7 = dbTakeFreeAlgo({ name: 'tx', ip: '1.1.1.1' }) === null
    if (!ok7) fails++
    console.log('  ' + (ok7 ? '✅' : '❌') + ' 7. все заняты (busy) → dbTakeFreeAlgo вернул null')

    // 8. личные (owner tg:*) алгоритмам НЕ выдаются
    for (const a of DB.accounts) a.busy = false
    const personalBefore = DB.accounts.filter(a => a.owner.indexOf('tg:') === 0).length
    let leaked = false
    for (let i = 0; i < DB.accounts.length + 2; i++) { const x = dbTakeFreeAlgo({ name: 'q', ip: 'q' }); if (x && x.owner.indexOf('tg:') === 0) leaked = true; if (x) x.busy = true; else break }
    const ok8 = !leaked && personalBefore > 0
    for (const a of DB.accounts) a.busy = false
    if (!ok8) fails++
    console.log('  ' + (ok8 ? '✅' : '❌') + ' 8. личные аккаунты (tg:*) алгоритмам не выдаются')

    // 9. битый файл переносится gracefully + сводка
    fs.writeFileSync(tmpDb, '{ oops not json')
    DB.accounts = [{ owner: 'x' }]                            // грязное состояние в памяти
    dbLoad(true)
    const s = dbSummary()
    const ok9 = DB.accounts.length === 0 && s.total === 0
    if (!ok9) fails++
    console.log('  ' + (ok9 ? '✅' : '❌') + ' 9. битый accounts_db.json → пустая база без падения; dbSummary считает')

    // статус-блоки используют tmp-путь (dbSetAnarchy пишет туда же)
    console.log('--- v5.0.0: статус-блок TG (6 кейсов) ---')
    const fakeT = { name: 'personal-test', ip: '5.6.7.8', role: 'personal', slots: { active: ['personal'], waiters: [] } }
    const S = makeSession({ kind: 'personal', tgChatId: 1, acc: { nick: 'Player777', pass: 'SECRET123', status: 'new', owner: 'tg:1', anarchy: null }, T: fakeT })
    S.setState('joining')
    const t1 = statusBlockText(S)
    const c1 = t1.indexOf('1️⃣') >= 0 && t1.indexOf('Заход на сервер') >= 0 && t1.indexOf('Player777') >= 0
    S.setState('captcha')
    const c1b = statusBlockText(S).indexOf('решаю капчу') >= 0
    S.setState('hub')
    const t2 = statusBlockText(S)
    const c2 = t2.indexOf('2️⃣') >= 0 && t2.indexOf('выберите анархию') >= 0 && t2.indexOf('102-112') >= 0 && t2.indexOf('902-904') >= 0
    S.logSent('48152')
    S.logSent('/reg SECRET123')
    const t3pre = statusBlockText(S)
    const c4 = t3pre.indexOf('••••••') >= 0 && t3pre.indexOf('SECRET123') < 0 && t3pre.indexOf('> 48152') >= 0
    const fakeLive = { chat(x) { fakeLive.sent.push(String(x)); return true }, sent: [], isDead: () => false, deadReason: () => '', end() {} }
    S.live = fakeLive
    await setAnarchy(S, 304)
    const t3 = statusBlockText(S)
    const c3 = t3.indexOf('3️⃣') >= 0 && t3.indexOf('Анархия 304') >= 0
    S.logSent('привет всем')
    await setAnarchy(S, 310)                                  // СМЕНА анархии → список очищен
    const t4 = statusBlockText(S)
    const c5 = S.sentLog.length === 1 && S.sentLog[0] === '/an310' && t4.indexOf('привет всем') < 0 && t4.indexOf('> /an310') >= 0
    const c6 = t4.indexOf('слоты 1/' + SOLVER.maxAccountsPerTunnel) >= 0 && t4.indexOf('Туннель «personal-test»') >= 0 && t4.indexOf('IP 5.6.7.8') >= 0
    const okSt = c1 && c1b && c2 && c3 && c4 && c5 && c6
    if (!okSt) fails++
    console.log('  ' + (okSt ? '✅' : '❌') + ' статус 1️⃣/2️⃣/3️⃣ + список анархий в HUB + пароль •••••• + очистка при смене + «Туннель/IP/слоты»' +
      (okSt ? '' : ' [c1=' + c1 + ' c1b=' + c1b + ' c2=' + c2 + ' c3=' + c3 + ' c4=' + c4 + ' c5=' + c5 + ' c6=' + c6 + ']'))
    S.live = null

    console.log('--- v5.0.0: слоты туннелей (ёмкость ≤' + SOLVER.maxAccountsPerTunnel + ', приоритет algo > personal) ---')
    {
      const TS = makeTunnel({ name: 'slot-test', host: '127.0.0.1', port: 1 }, 0)
      const got = []
      for (let i = 0; i < SOLVER.maxAccountsPerTunnel; i++) got.push(await acquireSlot(TS, 'algo'))
      const okCap = got.every(Boolean) && TS.slots.active.length === SOLVER.maxAccountsPerTunnel
      // занято: personal встал в очередь ПЕРВЫМ, algo вторым — освободившийся слот достанется algo
      let persDone = false, algoDone = false
      const pP = acquireSlot(TS, 'personal').then(r => { persDone = r; return r })
      await sleep(10)
      const aP = acquireSlot(TS, 'algo').then(r => { algoDone = r; return r })
      await sleep(10)
      releaseSlot(TS, 'algo')
      await sleep(10)
      const okPrio1 = algoDone === true && persDone === false && TS.slots.waiters.length === 1 && TS.slots.waiters[0].kind === 'personal'
      releaseSlot(TS, 'algo')
      await Promise.all([pP, aP])
      const okPrio2 = persDone === true && TS.slots.active.length === SOLVER.maxAccountsPerTunnel
      // отмена ожидания слота (стоп сессии в очереди)
      let cancelled = null
      const cP = acquireSlot(TS, 'personal', { slotWaiter: null }).then(r => { cancelled = r; return r })
      await sleep(10)
      const holder = TS.slots.waiters[TS.slots.waiters.length - 1]
      if (holder) { const i = TS.slots.waiters.indexOf(holder); TS.slots.waiters.splice(i, 1); holder.resolve(false) }
      await cP
      const okCancel = cancelled === false
      const okSlots = okCap && okPrio1 && okPrio2 && okCancel
      if (!okSlots) fails++
      console.log('  ' + (okSlots ? '✅' : '❌') + ' ёмкость ' + SOLVER.maxAccountsPerTunnel + ' + очередь: algo раньше personal + отмена ожидания' +
        (okSlots ? '' : ' [cap=' + okCap + ' prio1=' + okPrio1 + ' prio2=' + okPrio2 + ' cancel=' + okCancel + ']'))
    }

    // восстановить реальный путь базы
    dbSetPath(realPath)
    DB.accounts = []
    dbLoad(true)
    try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch (e) {}
  }

  // ============ v5.1.0: TELEGRAM-ПУЛЬТ на мок-Bot-API (10 кейсов, офлайн) ============
  console.log('--- v5.1.0: Telegram-пульт на мок-Bot-API (10 кейсов) ---')
  {
    const dbDir2 = path.join(REC_ROOT || __dirname, 'selftest_tg_db')
    const tmpDb2 = path.join(dbDir2, 'accounts_db.json')
    const realPath2 = DB_PATH
    const tgLogPath = path.join(REC_ROOT || __dirname, 'telegram.log')
    try { fs.rmSync(dbDir2, { recursive: true, force: true }) } catch (e) {}
    try { fs.rmSync(tgLogPath, { force: true }) } catch (e) {}
    dbSetPath(tmpDb2)
    DB.accounts = []

    // ---- мок Telegram Bot API на локальном http-сервере ----
    const sent = [], edits = [], deletes = [], cbAnswers = []
    let pending = [], nextMid = 100, uid = 90000
    const srv = http.createServer((rq, rs) => {
      const b = []
      rq.on('data', c => b.push(c))
      rq.on('end', () => {
        const buf = Buffer.concat(b)
        const m = rq.url.split('/').pop()
        const j = o => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)) }
        let p = {}; try { p = JSON.parse(buf.toString('utf8')) } catch (e) {}
        if (m === 'getMe') return j({ ok: true, result: { id: 1, username: 'selftest_v5_bot' } })
        if (m === 'sendMessage') { const mid = ++nextMid; sent.push({ params: p, mid }); return j({ ok: true, result: { message_id: mid } }) }
        if (m === 'editMessageText') { edits.push({ params: p, mid: p.message_id }); return j({ ok: true, result: { message_id: p.message_id } }) }
        if (m === 'deleteMessage') { deletes.push({ params: p }); return j({ ok: true, result: true }) }
        if (m === 'answerCallbackQuery') { cbAnswers.push({ params: p }); return j({ ok: true, result: true }) }
        if (m === 'getUpdates') {
          if (p.offset === -1) { const out = pending.slice(); pending = []; return j({ ok: true, result: out }) }   // offset flush
          if (typeof p.offset === 'number' && p.offset > 0) pending = pending.filter(u => u.update_id >= p.offset)
          const out = pending.splice(0, pending.length)
          if (out.length) return j({ ok: true, result: out })
          setTimeout(() => j({ ok: true, result: [] }), 40)
          return
        }
        j({ ok: true, result: {} })
      })
    })
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port

    // ---- переключаем окружение на мок ----
    const savedTG = { apiUrl: TG_CFG.apiUrl, token: TG_CFG.token, allowed: TG_CFG.allowedChatIds.slice(), poll: TG_CFG.pollTimeoutSec }
    TG_CFG.apiUrl = 'http://127.0.0.1:' + port
    TG_CFG.token = 'SELFTEST'
    TG_CFG.allowedChatIds = [1]
    TG_CFG.pollTimeoutSec = 0
    tgTransport = null
    // убираем АВТОСОЗДАННЫЙ личный туннель (кейс 4 проверяет предупреждение без него)
    const autoPers = personalTunnels().slice()
    for (const t of autoPers) { const i = TUNNELS.indexOf(t); if (i >= 0) TUNNELS.splice(i, 1) }
    const persT = makeTunnel({ name: 'personal-test', host: '127.0.0.1', port: 9, role: 'personal' }, 900)
    persT.ip = '5.6.7.8'

    function makeFakeLive() {
      const L = {
        sent: [],
        bot: { swingArm() {}, look() {}, entity: { yaw: 0, pitch: 0 } },
        snap: () => ({ maps: new Map(), frames: [], chats: [], events: [], metaDump: [] }),
        chatsLen: () => L.chats.length,
        chatsFrom: mm => L.chats.slice(Number(mm) || 0),
        chats: [],
        chat(t) { L.sent.push(String(t)); return true },
        isDead: () => false,
        deadReason: () => '',
        lastChange: () => Date.now(),
        readiness: () => ({ ready: true }),
        waitDead: async () => false,
        waitFreshWall: async () => false,
        end() {}
      }
      return L
    }
    let lastLive = null
    const savedHooks = { c: SESS_HOOKS.connect, s: SESS_HOOKS.solve }
    SESS_HOOKS.connect = async () => { lastLive = makeFakeLive(); return { ok: true, live: lastLive } }
    SESS_HOOKS.solve = async live => { live.chat('48152'); return { ok: true, ans: { digits: '48152', host: 'mock', ms: 1 }, auth: { ok: true, via: 'reg' }, attempts: [] } }

    const inject = u => { u.update_id = ++uid; pending.push(u) }
    const injMsg = (chatId, mid, text, date) => inject({ message: { message_id: mid, chat: { id: chatId }, text, date: date || 0 } })
    const injCb = (chatId, mid, data) => inject({ callback_query: { id: 'cb' + mid + data, message: { message_id: mid, chat: { id: chatId } }, data } })
    async function waitFor(cond, ms) {
      const t0 = Date.now()
      while (Date.now() - t0 < (ms || 4000)) { let v = false; try { v = cond() } catch (e) {}; if (v) return true; await sleep(40) }
      return false
    }

    TG_UI.running = true
    TG_UI.startedAt = Math.floor(Date.now() / 1000)
    TG_UI.offset = 0
    const loopP = tgUiLoop()
    // ВАЖНО: инъекции только ПОСЛЕ offset-flush (иначе первый апдейт съест флаш)
    await waitFor(() => TG_UI.flushDone === true, 3000)

    const results = []
    const caseOk = (name, ok, extra) => { if (!ok) fails++; results.push('  ' + (ok ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : '')) }
    const editWith = frag => edits.some(e => String((e.params && e.params.text) || '').indexOf(frag) >= 0)

    // 1: /start → приветствие + ЭКРАННАЯ reply-клавиатура (внизу экрана, не в сообщении)
    injMsg(1, 11, '/start')
    const okMenu = await waitFor(() => sent.length >= 1)
    const menuRec = sent[0] || {}
    const menuText = String((menuRec.params && menuRec.params.text) || '')
    let kb = null; try { kb = JSON.parse((menuRec.params && menuRec.params.reply_markup) || 'null') } catch (e) {}
    const okKb = !!kb && Array.isArray(kb.keyboard) && kb.resize_keyboard === true &&
      kb.keyboard[0].length === 2 && kb.keyboard[0][0].text === BTN_ALGO && kb.keyboard[0][1].text === BTN_PERSONAL
    caseOk('1. /start → приветствие v5.1.1 + ЭКРАННАЯ клавиатура (🧩 Алгоритмы | 👤 Личный заход, resize+persistent)',
      okMenu && menuText.indexOf('пульт управления v5.1.1') >= 0 && menuRec.params && menuRec.params.chat_id === 1 && okKb)

    // 2: нажатие экранной кнопки «🧩 Алгоритмы» (приходит текстом) → заглушка
    injMsg(1, 12, BTN_ALGO)
    const okStub = await waitFor(() => sent.some(s => String(s.params.text).indexOf('ЗАГЛУШКА') >= 0 && s.params.chat_id === 1))
    caseOk('2. экранная кнопка «🧩 Алгоритмы» → сообщение-заглушка (каркас описан)', okStub)

    // 3: нажатие «👤 Личный заход» → панель с inline-кнопками ▶️ Запуск / 🔄 Смена ника
    injMsg(1, 13, BTN_PERSONAL)
    const okPanel = await waitFor(() => sent.some(s => String(s.params.text).indexOf('👤 Личный заход') >= 0 &&
      String(s.params.reply_markup || '').indexOf('p:start') >= 0 && String(s.params.reply_markup || '').indexOf('p:rotate') >= 0))
    const panelRec = sent.find(s => String(s.params.text).indexOf('👤 Личный заход') >= 0) || {}
    const panelMid = panelRec.mid
    caseOk('3. экранная кнопка «👤 Личный заход» → панель аккаунта + [▶️ Запуск][🔄 Смена ника]', okPanel && !!panelMid)

    // 4: личного туннеля нет → предупреждение (запуск не стартует)
    const sessBefore = SESSIONS.length
    injCb(1, panelMid, 'p:start')
    const okWarn = await waitFor(() => editWith('Личный туннель не задан'))
    caseOk('4. без туннеля role=personal: «⚠️ Личный туннель не задан», сессия не создана', okWarn && SESSIONS.length === sessBefore)

    // 5: добавляем личный туннель → Запуск → статус-блок 1️⃣ → 2️⃣ HUB + список анархий
    TUNNELS.push(persT)
    injCb(1, panelMid, 'p:start')
    const okSess = await waitFor(() => SESSIONS.some(x => x.kind === 'personal' && String(x.tgChatId) === '1'))
    const S = SESSIONS.find(x => x.kind === 'personal' && String(x.tgChatId) === '1') || null
    const okBlock1 = await waitFor(() => editWith('👤 Личный заход —') && editWith('слоты'))
    const okHub = !!S && await waitFor(() => S.state === 'hub', 6000)
    const okBlock2 = await waitFor(() => edits.some(e => String(e.params.text).indexOf('2️⃣') >= 0 &&
      String(e.params.text).indexOf('Список анархий: 102-112') >= 0 && String(e.params.text).indexOf('> 48152') >= 0))
    caseOk('5. «▶️ Запуск» → статус-блок: 1️⃣ заход → 2️⃣ HUB + список анархий + «написано аккаунтом»', okSess && okBlock1 && okHub && okBlock2, 'состояние: ' + (S ? S.state : 'нет сессии'))

    if (S) {
      // 6: /an305 → в игру + ТГ-сообщение удалено; /an310 → смена + очистка sentLog
      injMsg(1, 22, '/an305')
      const okAn = await waitFor(() => S.state === 'anarchy' && S.anarchy === 305 &&
        deletes.some(d => d.params.message_id === 22 && d.params.chat_id === 1) &&
        lastLive && lastLive.sent.indexOf('/an305') >= 0)
      injMsg(1, 23, '/an310')
      const okSwitch = await waitFor(() => S.anarchy === 310 && S.sentLog.length === 1 && S.sentLog[0] === '/an310')
      caseOk('6. /an305 → команда в игру, ТГ-сообщение удалено; /an310 → смена анархии, «написанное» очищено', okAn && okSwitch)

      // 7: релей — текст из ТГ → игровой чат + deleteMessage + sentLog
      injMsg(1, 24, 'привет всем')
      const okRelay = await waitFor(() => lastLive && lastLive.sent.indexOf('привет всем') >= 0 &&
        deletes.some(d => d.params.message_id === 24) && S.sentLog.indexOf('привет всем') >= 0)
      caseOk('7. релей в анархии: текст → в игровой чат, ТГ-сообщение удалено, строка в sentLog', okRelay)

      // 8: «305» без /an — релей, НЕ смена анархии
      injMsg(1, 25, '305')
      const ok305 = await waitFor(() => lastLive && lastLive.sent.indexOf('305') >= 0)
      caseOk('8. «305» без /an — это релей (анархия осталась ' + S.anarchy + ')', ok305 && S.anarchy === 310)

      // 9: чужой chat_id игнорируется + «призрачный» апдейт (date до старта) отброшен
      const sentBefore = sent.length
      injMsg(999, 26, '/start')
      injMsg(1, 27, '/accounts', TG_UI.startedAt - 300)
      await sleep(1500)
      let logHasBan = false
      try { logHasBan = fs.readFileSync(tgLogPath, 'utf8').indexOf('запрет доступа') >= 0 } catch (e) {}
      const newSent = sent.slice(sentBefore)
      const okIgnore = !newSent.some(s => s.params.chat_id === 999) &&
        !newSent.some(s => String(s.params.text || '').indexOf('База аккаунтов') >= 0) &&
        !edits.some(e => e.params.chat_id === 999) && logHasBan
      caseOk('9. чужой chat_id игнорируется («запрет доступа» в records/telegram.log), призрачный апдейт отброшен', okIgnore)

      // 10: «⏹ Выключить бота» → сессия stopped + финальный статус-блок
      injCb(1, panelMid, 's:stop')
      const okStop = await waitFor(() => S.state === 'stopped', 5000)
      const okFinal = await waitFor(() => editWith('⏹ Выключен'))
      caseOk('10. «⏹ Выключить бота» → сессия остановлена (stopped), финальный блок', okStop && okFinal)
    } else {
      for (let k = 6; k <= 10; k++) caseOk(k + '. (пропущено — нет сессии)', false)
    }

    for (const r of results) console.log(r)

    // ---- уборка: гасим цикл, мок, хуки, туннели, конфиг, базу ----
    TG_UI.running = false
    try { await Promise.race([loopP, sleep(1500)]) } catch (e) {}
    try { srv.close() } catch (e) {}
    SESS_HOOKS.connect = savedHooks.c; SESS_HOOKS.solve = savedHooks.s
    const iT = TUNNELS.indexOf(persT); if (iT >= 0) TUNNELS.splice(iT, 1)
    for (const t of autoPers) if (TUNNELS.indexOf(t) < 0) TUNNELS.push(t)
    TG_CFG.apiUrl = savedTG.apiUrl; TG_CFG.token = savedTG.token
    TG_CFG.allowedChatIds = savedTG.allowed; TG_CFG.pollTimeoutSec = savedTG.poll
    tgTransport = null
    for (const k of Object.keys(TG_UI.throttle)) { const rec = TG_UI.throttle[k]; if (rec && rec.timer) { try { clearTimeout(rec.timer) } catch (e) {} } delete TG_UI.throttle[k] }
    TG_UI.byChat = {}
    if (S) { const iS = SESSIONS.indexOf(S); if (iS >= 0) SESSIONS.splice(iS, 1) }
    dbSetPath(realPath2)
    DB.accounts = []
    dbLoad(true)
    if (!CLI.debug) {
      try { fs.rmSync(dbDir2, { recursive: true, force: true }) } catch (e) {}
      try { fs.rmSync(tgLogPath, { force: true }) } catch (e) {}
    }
  }

  RF.ready = rfReadyWas
  RF.disabledReason = rfDisabledWas
  if (!CLI.debug) {
    for (const d of ['selftest_e2e', 'selftest_e2e_light', 'selftest_learn', 'selftest_yolo', 'selftest', 'selftest_db', 'selftest_tg_db']) {
      try { fs.rmSync(path.join(REC_ROOT || __dirname, d), { recursive: true, force: true }) } catch (e) {}
    }
  } else console.log('  (--debug: артефакты самопроверки оставлены в ' + path.join(REC_ROOT || __dirname, 'selftest_e2e') + ')')
  console.log(fails ? '=== SELFTEST: ' + fails + ' ПРОВАЛОВ ===' : '=== SELFTEST: ВСЁ ОК ===')
  return fails === 0
}
// ========================= КЛИЕНТСКИЙ ПУЛ v5 (headless, --bots/--rounds) =========================
// Тот же движок сессий, что и у TG-пульта: аккаунты БЕРУТСЯ ИЗ БАЗЫ (зарегистрированные,
// приоритет: тот же IP → тот же туннель → любой свободный), иначе создаются новые.
// Анархия headless-забега: algo.anarchy (null = остаться в HUB).
function buildCliSessions() {
  const n = Math.max(1, ACCOUNTS.count)
  const pool = algoTunnels().length ? algoTunnels() : TUNNELS
  const out = []
  for (let i = 0; i < n; i++) {
    const T = pool.length ? pool[i % pool.length] : null
    let acc = T ? dbTakeFreeAlgo(T) : null
    if (!acc) acc = dbCreate('algo', T)
    out.push(makeSession({
      kind: 'algo', acc, T,
      presetAnarchy: ALGO.anarchy,
      roundNoBase: i * 100               // нумерация файлов раундов не пересекается между ботами
    }))
  }
  return out
}

async function runCliPool(sessions) {
  const t0 = Date.now()
  // ёмкость: слоты считаются на ФИЗИЧЕСКИЙ канал (общий IP)
  const capacity = distinctPhysical(TUNNELS).length * SOLVER.maxAccountsPerTunnel
  step('ПУЛ v5: ' + sessions.length + ' сессия(й) × до ' + SOLVER.roundsPerBot + ' заходов | туннелей: ' + (TUNNELS.length || 0) +
    ' (algo: ' + algoTunnels().length + ', personal: ' + personalTunnels().length + ', физканалов: ' + distinctPhysical(TUNNELS).length + ')' +
    ' | слоты ≤' + SOLVER.maxAccountsPerTunnel + '/канал (всего ' + capacity + ')' +
    ' | старт вразнобой через ' + ACCOUNTS.staggerMs + 'мс | после успеха: HUB' + (ALGO.anarchy ? ' → /an' + ALGO.anarchy : ' (анархия не задана)'))
  if (capacity > 0 && sessions.length > capacity) {
    step('⚠️ сессий (' + sessions.length + ') больше, чем слотов (' + capacity + ') — остальные стартуют, когда слот освободится (сводка будет через 20с после первого финиша)')
  }
  for (const S of sessions) {
    SESSIONS.push(S)
    step(sessionLabel(S) + ': ник «' + S.acc.nick + '» (' + (S.acc.status === 'registered' ? 'из базы, /l' : 'новый, /reg') + '), туннель «' + (S.T ? S.T.name : 'direct') + '»')
  }
  const tasks = sessions.map((S, i) => (async () => {
    if (i > 0 && ACCOUNTS.staggerMs > 0) await sleep(i * ACCOUNTS.staggerMs + Math.floor(Math.random() * 400))
    if (S.stop) return
    await runSession(S)
  })())
  // ждём, пока ВСЕ сессии дойдут до HUB/анархии или завершатся; но если часть стоит в очереди
  // за слотами (ёмкость исчерпана) — сводка печатается через 20с после первого финиша
  const allSettled = Promise.all(sessions.map(S => S.settledPromise))
  const firstSettled = Promise.race(sessions.map(S => S.settledPromise)).then(() => sleep(20000))
  await Promise.race([allSettled, firstSettled])
  return { t0, tasks }
}

function printSummary(sessions, t0) {
  const solved = sessions.filter(S => S.solved).length
  const online = sessions.filter(S => ['hub', 'anarchy'].indexOf(S.state) >= 0).length
  const L = ['=== СВОДКА v5.1.1 ===']
  L.push('сессий: ' + sessions.length + ' | решено капч: ' + solved + '/' + sessions.length + ' | в игре: ' + online + ' | время: ' + Math.round((Date.now() - t0) / 1000) + 'с')
  for (const l of sessionsSummary()) L.push(l)
  L.push('')
  L.push('Картинки и результаты: ' + CAP_ROOT + ' и records/sess*_a*/result.json')
  step('готово.')
  flushReport(L.join('\n'))
  try {
    fs.writeFileSync(path.join(REC_ROOT, 'summary.json'), JSON.stringify({
      stamp: STAMP, version: '5.1.0', sessions: sessions.length, solved, online,
      seconds: Math.round((Date.now() - t0) / 1000),
      results: sessions.map(S => ({
        id: S.id, kind: S.kind, nick: S.acc ? S.acc.nick : '', tunnel: S.T ? S.T.name : 'direct',
        state: S.state, anarchy: S.anarchy, solved: S.solved, solvedRound: S.solvedRound,
        digits: S.ans ? S.ans.digits : '', auth: S.auth ? (S.auth.ok ? S.auth.via : 'fail:' + (S.auth.kind || S.auth.stage)) : '',
        rotations: S.rotations, error: S.error || ''
      }))
    }, null, 2))
  } catch (e) { console.error('summary.json err:', e.message) }
  console.log('\n' + L.join('\n'))
  return { solved, online }
}

// ========================= MAIN (v5: по умолчанию — Telegram-пульт) =========================
function printConfigSummary() {
  step('config: ' + (CFG_PATH || 'НЕТ') + ' parse=' + CFG_STRATEGY)
  step('MC: ' + MC.host + ':' + MC.port + ' v' + MC.version)
  if (TUNNELS.length) {
    for (const T of TUNNELS) {
      const phys = T.physical || T
      step('🔌 туннель «' + T.name + '» (role: ' + T.role + (phys !== T ? ', общий канал с «' + phys.name + '»' : '') + '): ' + T.cfg.host + ':' + T.cfg.port + (T.cfg.username ? ' (логин ' + T.cfg.username + ')' : '') + ' | смена IP: ' + describeChangeIpUrl(T.cfg.changeIpUrl))
    }
    step('   физканалов: ' + distinctPhysical(TUNNELS).length + ' | слоты: ≤' + SOLVER.maxAccountsPerTunnel + ' ЛЮБЫХ аккаунтов на физканал (приоритет algo > personal)')
    for (const n of (TUNNELS.notes || [])) step('   ℹ️ ' + n)
    if (!personalTunnels().length) step('⚠️ нет туннеля с role=personal — «Личный заход» в Telegram не запустится (добавьте в "tunnels")')
  } else {
    step('⚠️ туннели/прокси НЕ заданы' + (CAP.allowDirect ? ' — заход НАПРЯМУЮ (proxy.allowDirect=true), FunTime может быстро забанить ваш IP' : ' — заходы невозможны (нет proxy.host; для прямого захода включите "proxy": { "allowDirect": true })'))
  }
  step('☁️ ROBOFLOW: ' + (RF.ready
    ? 'ВКЛ → https://' + RF.host + '/' + RF.model + ' (поле "' + RF.field + '", порог ' + RF.askConf + '%, overlap ' +
      Math.round(RF.overlap * 100) + '%, таймаут ' + RF.timeoutMs + 'мс, ключ ' + rfMaskKey(RF.apiKey) + ', темп ' + RF.paceMs + 'мс)'
    : (RF.enabled ? 'ВКЛ, но нет roboflow.apiKey — облако не используется' : 'ВЫКЛ (roboflow.enabled=false)')))
  step('🌐 YOLO API (запасной): ' + (YOLO.enabled ? 'ВКЛ → ' + YOLO.urls.join(' → ') : 'ВЫКЛ (yolo.enabled=false)'))
  if (!RF.ready && !YOLO.enabled) step('⚠️ распознавание ВЫКЛЮЧЕНО полностью: текст с картинки брать неоткуда — заходы бессмысленны')
  step('АККАУНТЫ: префикс ника «' + ACCOUNTS.nickPrefix + '», пароль ' + ACCOUNTS.passwordLength + ' симв. (случайный), reg=«' + ACCOUNTS.regTemplate + '» login=«' + ACCOUNTS.loginTemplate + '» | база: ' + ACCOUNTS_DB_PATH)
  step('РЕШАТЕЛЬ: до ' + SOLVER.triesPerJoin + ' попыток на заход, verifyMs=' + SOLVER.verifyMs + ', слоты ≤' + SOLVER.maxAccountsPerTunnel + ' аккаунтов на туннель, rotateOnStart=' + SOLVER.rotateOnStart)
  step('АНАРХИИ: ' + anarchyListText() + (ANARCHY.allowAny ? ' (allowAny)' : '') + ' | АНТИ-АФК: ' + (ANTI_AFK.enabled ? 'каждые ' + Math.round(ANTI_AFK.everyMs / 1000) + 'с ±' + Math.round(ANTI_AFK.jitterMs / 1000) + 'с' : 'ВЫКЛ'))
  step('📱 TELEGRAM: ' + (TG_CFG.ready ? 'ВКЛ — пульт управления (whitelist: ' + (TG_CFG.allowedChatIds.join(', ') || 'ПУСТО') + ')' : (TG_CFG.enabled ? 'ВКЛ, но нет telegram.token — пульт не запустится' : 'ВЫКЛ (telegram.enabled=false)')))
}

async function main() {
  step('=== СТАРТ v5.1.1 (авторешатель капчи FunTime + Telegram-пульт) ===')

  if (CLI.selftest) { process.exit((await selftest()) ? 0 : 1) }
  if (CLI.tgTest) { const okTg = await runTgTest(); setTimeout(() => process.exit(okTg ? 0 : 1), 300); return }
  if (CLI.rfTest) { const okRf = await runRfTest(CLI.rfTestFile); setTimeout(() => process.exit(okRf ? 0 : 1), 300); return }
  if (CLI.yoloTest) {
    const f = CLI.yoloTest
    if (!fs.existsSync(f)) { step('файл не найден: ' + f); process.exit(1) }
    step('YOLO-тест файла ' + f + ' (' + fs.statSync(f).size + ' байт)')
    step('эндпоинты: ' + (RF.ready ? 'Roboflow ' + RF.model + ' → ' : '') + YOLO.urls.join(' → '))
    const t0 = Date.now()
    const r = await recognizePng(fs.readFileSync(f), 'тест')
    if (r) step('✅ ответ: «' + r.digits + '» от ' + r.host + ' за ' + r.ms + 'мс (всего ' + (Date.now() - t0) + 'мс)')
    else step('❌ ни один распознаватель не ответил. Проверьте roboflow.apiKey или поднимите: python yolo_server.py')
    setTimeout(() => process.exit(r ? 0 : 1), 300)
    return
  }
  if (CLI.proxyCheck) {
    printConfigSummary()
    const ok = await runProxyCheck()
    setTimeout(() => process.exit(ok ? 0 : 1), 300)
    return
  }

  if (!CFG_PATH) { step('НЕ НАЙДЕН config.json'); process.exit(1) }
  printConfigSummary()

  const headless = CLI.bots > 0 || CLI.rounds > 0
  if (!mineflayer) {
    step('❌ mineflayer не установлен — выполните: npm install mineflayer socks')
    process.exit(1)
  }
  if (!headless && !TG_CFG.ready) {
    step('❌ telegram.token не задан (telegram.enabled=' + TG_CFG.enabled + ') — основной режим v5 это Telegram-пульт.')
    step('   Варианты: заполнить "telegram" в config.json, или запустить headless-пул: node main.js --bots 1')
    process.exit(1)
  }

  // ---- IP при старте: по умолчанию ДЕРЖИТСЯ (узнаётся currentIp и фиксируется) ----
  // ротация — только solver.rotateOnStart=true / --rotate / «особые случаи» в сессиях.
  // Опрос/ротация — по РАЗЛИЧНЫМ физическим каналам (связанные логические туннели делят IP)
  for (const T of distinctPhysical(TUNNELS)) {
    const names = TUNNELS.filter(x => (x.physical || x) === T).map(x => '«' + x.name + '»').join('+')
    if (SOLVER.rotateOnStart) {
      try { T.ip = await rotateIp(T) } catch (e) { step('ротация IP ' + names + ': ' + e.message) }
    } else {
      try { T.ip = await currentIp({ T, quiet: true }) } catch (e) {}
      if (T.ip) step('туннель ' + names + ': IP ' + T.ip + ' (держится; ротация только особые случаи' + (CLI.rotate ? '' : '; --rotate = сменить при старте') + ')')
      else step('туннель ' + names + ': IP не определён' + (T.state === 'dead' ? ' (прокси не отвечает — node main.js --proxy-check)' : ''))
    }
  }

  // ---- версия сервера: status-пинг приоритетнее конфига (бэкенд за BotFilter мог обновиться;
  //      «Parse error for play.toClient: Read error for undefined» — типичный симптом чужой версии) ----
  if (cfgGet(CFG, 'minecraft.autoVersion', true) !== false && (TUNNELS.length || CAP.allowDirect)) {
    const T0 = distinctPhysical(TUNNELS)[0] || null
    step('🔎 проверяю версию сервера status-пингом' + (T0 ? ' через туннель «' + T0.name + '»' : ' напрямую') + '… (minecraft.autoVersion; выкл: "autoVersion": false)')
    const st = await detectMcVersion(T0)
    if (st && st.ok && st.json && st.json.version) {
      const vname = st.json.version.name
      const vproto = st.json.version.protocol
      const clean = cleanVersionName(vname) || protocolToVersion(vproto)
      const pl = st.json.players ? (', игроков ' + st.json.players.online + '/' + st.json.players.max) : ''
      step('🔎 сервер ответил за ' + st.ms + 'мс: «' + vname + '», protocol ' + vproto + (clean ? ' (= ' + clean + ')' : ' (версию по номеру не знаю)') + pl)
      if (clean && clean !== MC.version) {
        step('⚠️ в конфиге minecraft.version=' + MC.version + ' — ПЕРЕКЛЮЧАЮСЬ на версию сервера ' + clean + ': иначе будут «Parse error for play.toClient» и обрывы')
        MC.version = clean
      } else if (clean) {
        step('   версия совпадает с конфигом (' + MC.version + ') — ок')
      } else {
        step('   имя версии нестандартное, а protocol ' + vproto + ' мне не известен — остаюсь на minecraft.version=' + MC.version)
      }
    } else {
      step('🔎 пинг не прошёл (' + ((st && st.err) || 'нет ответа') + ') — остаюсь на minecraft.version=' + MC.version)
    }
  }

  // ---- graceful shutdown: Ctrl+C / сигнал — корректно гасим ВСЕ сессии ----
  const onSignal = sig => {
    if (SHUTDOWN) { process.exit(0); return }
    SHUTDOWN = true
    tgUiStop()
    step('получен ' + sig + ' — завершаю сессии…')
    try { stopAllSessions(sig) } catch (e) {}
    setTimeout(() => { flushReport('SHUTDOWN ' + sig); process.exit(0) }, 1200)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  // ---- режим 1 (по умолчанию): TELEGRAM-ПУЛЬТ ----
  if (!headless) {
    dbLoad(true)
    const s = dbSummary()
    step('🗄 база аккаунтов: ' + s.total + ' (зарегистрировано ' + s.registered + ', личных ' + s.personal + ', algo ' + s.algo + ')')
    tgUiStart()
    step('🟢 процесс живёт, пока работает пульт. Остановка: Ctrl+C')
    return
  }

  // ---- режим 2: headless-пул (--bots/--rounds) ----
  dbLoad(true)
  const sessions = buildCliSessions()
  const t0 = Date.now()
  await runCliPool(sessions)
  const sum = printSummary(sessions, t0)
  if (GLOBAL_FATAL) { step('❌ ФАТАЛЬНО: ' + GLOBAL_FATAL + (mineflayer ? '' : ' — установите зависимости: npm install mineflayer socks')); setTimeout(() => process.exit(1), 800); return }
  if (sum.online > 0) step('🟢 процесс остаётся живым: ' + sum.online + ' сессия(й) в игре (HUB/анархия). Остановка: Ctrl+C')
  else setTimeout(() => process.exit(sum.solved > 0 ? 0 : 1), 1500)
}

if (require.main === module) {
  main().catch(e => {
    console.error('\n!!! FATAL MAIN ERROR !!!\nMessage:', e.message, '\nStack:', e.stack)
    flushReport('FATAL: ' + (e.stack || e.message))
    setTimeout(() => process.exit(1), 1500)
  })
}
module.exports = {
  VERSION: '5.1.1',
  // палитра/PNG/геометрия (используют tools/*)
  PALETTE, SHADE_MULT, BASE_COLORS, LUM, palDist, rotQ, encodePng, colorPng, bwPng,
  clusterValues, detectWalls, wallMinFrames, buildGrid, viewpointHAsc, orientationCandidates, rotationCandidates,
  dominantColor, composeImage, composeFromDisp, imageSeamCost, permSeamCost, pairSeam,
  optimizeRotations, propagateRotations, solveRotations, fillHolesDisplay,
  assembleWallSmart, captchaLikeness,
  extractFrameInfo, findMapIdDeep, getMapIdFromPacket, inkMaskWall, ocr,
  yawSpread, maxGridGap, wallDist, wallDot,
  selftest, makeSyntheticCaptcha, makeSyntheticDigits, makeWallSnapshot, saveRound,
  // распознавание (внешние сервисы)
  YOLO, yoloRecognize, parseYoloAnswer, multipart, yoloReset,
  RF, RF_DEFAULT_MODEL, RF_DEFAULT_HOST, rfCfg, rfUrl, rfMaskKey, rfHint, rfReset, rfSaveAnswer,
  rfIsHtml, rfFatal, rfIoU, rfXov, rfSelect, rfBoxesToDigits, rfRecognize, rfNewestCaptcha, runRfTest,
  recognizePng, DIGITS_EXPECTED,
  // транспорт
  httpsRequest, parseSocksUrl, socksTlsConnect, openSocksTunnel,
  // туннели/прокси/слоты
  TUNNELS, makeTunnel, tunnelsFromConfig, tunnelRole, personalTunnels, algoTunnels,
  physKey, linkToPhysical, dedupePhysical, enforceSinglePersonal, distinctPhysical,
  SLOT_PRIORITY, acquireSlot, releaseSlot, slotsUsed, slotsFree,
  proxyHostCandidates, socks5Open, httpConnect, httpThrough, proxyTunnel,
  proxyConnect, proxyAlive, currentIp, socksHint, parseChangeIpResponse, ensureJsonParam,
  describeChangeIpUrl, runProxyCheck, checkOneTunnel, mcStatusPing, PROXY, rotateIp, isIpV4, altHostOf,
  // решатель/аккаунты/авторизация
  SOLVER, ACCOUNTS, buildAuthCommand, matchAny, randomNick, randomPass,
  connectAndSolve, waitVerdict, waitAuthResult, authPhase, solveCaptchaOnLive, writeResult,
  // Telegram-пульт (транспорт + UI)
  TG_CFG, tgAllowed, tgApi, tgSend, tgEdit, tgDelete, tgAnswerCb, tgGetUpdates, tgLog, tgTransports, runTgTest,
  TG_UI, tgUiStart, tgUiStop, tgUiLoop, handleUpdate, onMessage, onCallback, startPersonal, rotatePersonal, sendMenu,
  statusBlockText, statusKb, scheduleStatusEdit, kbInline, kbScreen, kbPersonalPanel, sessUptime,
  MENU_TEXT, ALGO_STUB_TEXT, personalPanelText, BTN_ALGO, BTN_PERSONAL, sendAlgoStub, sendPersonalPanel,
  // база аккаунтов
  DB, DB_PATH, dbSetPath, dbLoad, dbSave, dbCreate, dbPersonal, dbPersonalRotate, dbTakeFreeAlgo,
  dbMarkBusy, dbMarkRegistered, dbSetAnarchy, dbSummary, ACCOUNTS_DB_PATH,
  // сессии/анархии/анти-афк
  SESSIONS, SESS_SEQ, SESS_HOOKS, GLOBAL_FATAL, makeSession, runSession, stopSession, stopAllSessions,
  activeSessionOfChat, sessionLabel, sessionTag, sessionsSummary, setAnarchy, maskSecret, specialRotation,
  ANARCHY, anarchyOk, parseAnarchyCmd, anarchyListText, ALGO,
  ANTI_AFK, startAntiAfk, stopAntiAfk, antiAfkInterval,
  buildCliSessions, runCliPool, printSummary, printConfigSummary,
  step, dbg, sleep, flushReport
}
