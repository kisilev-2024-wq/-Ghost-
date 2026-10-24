#!/usr/bin/env node
// ============================================================================
// an309_pair_direct.js — СЕССИЯ 10, шаг 41 (задача владельца):
//   «Скрипт, который зайдёт С МОЕГО IP (напрямую, без прокси) на Анархию-309
//    с двух ботов: ПЕРВЫЙ ЧИТАЕТ чат, ВТОРОЙ ПИШЕТ «1234». Ники и пароли
//    рандомные (свежие аккаунты, регистрация при входе).»
//
// Схема (на базе проверенного an310_pair.js):
//   - ОБА бота идут НАПРЯМУЮ с вашего IP (proxy.allowDirect=true, без ротаций —
//     мобильный прокси не трогается, ваш личный бот на нём не пострадает);
//   - 2 бота на 1 IP ≤ серверного лимита 3/IP ✓;
//   - аккаунты СВЕЖИЕ: randomNick/randomPass, /register при первом входе,
//     после успеха пишутся в learn/accounts_db.json;
//   - ПИСАТЕЛЬ (W) заходит первым: хаб → /an309 → инстанс → отстой 15с →
//     ХОДЬБА ≥5 блоков (детектор rubberband) → пишет «1234» КАЖДУЮ МИНУТУ,
//     фиксируя реакцию сервера (доставлено / «недостаточно наиграли» /
//     привязка ВК-TG / тишина);
//   - ЧИТАТЕЛЬ (R) заходит фоном вторым: собирает ВЕСЬ эфир инстанса
//     (reader_chat.jsonl) и верифицирует каждую доставку «1234» от писателя;
//   - после ПЕРВОЙ подтверждённой доставки писатель замолкает (не спамим),
//     оба держатся ещё --hold-after сек и выходят (--until-delivered=0 —
//     писать до дедлайна);
//   - смерть → один ре-вход (аккаунт уже зарегистрирован → /login);
//   - всё пишется в records/pair309d_<штамп>/ (лог, RESULT json, эфир).
//
// Запуск (на вашем ПК, из папки с main.js):
//   node tools/an309_pair_direct.js [--an=309] [--deadline=3600] [--walk=5]
//        [--every=60] [--text=1234] [--until-delivered=1] [--hold-after=90]
//        [--dry]   (dry = только проверка конфига/IP, без входа)
//
// v2 (шаг 43): фикс «M.randomNick is not a function» — скрипт больше не берёт
//   первый попавшийся main.js: кандидаты (./main.js, ../main.js, ./env/main.js,
//   ../env/main.js) ПРОВЕРЯЮТСЯ на наличие connectAndSolve/solveCaptchaOnLive/
//   nbtChatText; неподходящие (старые) отбрасываются с диагностикой; генераторы
//   ников/паролей имеют локальный фолбэк; краш на старте = немедленный exit(1).
// ============================================================================
'use strict'
const fs = require('fs')
const pathMod = require('path')

// Загрузка main.js с ВАЛИДАЦИЕЙ (фикс шага 43: рядом может лежать СТАРЫЙ main.js
// без нужных экспортов — раньше скрипт брал его вслепую и падал на randomNick).
// ОБЯЗАТЕЛЬНО: connectAndSolve, solveCaptchaOnLive, nbtChatText.
// randomNick/randomPass — желательны (есть локальный фолбэк), currentIp/dbMarkRegistered — опциональны.
const REQUIRED_FNS = ['connectAndSolve', 'solveCaptchaOnLive', 'nbtChatText']
const CANDIDATES = ['./main.js', '../main.js', './env/main.js', '../env/main.js']
let M = null, MAIN_DIR = null, MAIN_PATH = null
const REJECTS = []
for (const cand of CANDIDATES) {
  let mod = null
  try { mod = require(cand) } catch (e) {
    REJECTS.push(cand + ': ' + ((e && e.code === 'MODULE_NOT_FOUND') ? 'нет файла' : 'ошибка загрузки: ' + String((e && e.message) || e).split('\n')[0].slice(0, 80)))
    continue
  }
  let resolved = cand
  try { resolved = require.resolve(cand) } catch (e) {}
  const missing = REQUIRED_FNS.filter(fn => typeof mod[fn] !== 'function')
  if (missing.length) {
    REJECTS.push(cand + ' (' + resolved + '): НЕ ПОДХОДИТ — нет ' + missing.join(', ') + ((mod && mod.VERSION) ? ' [это v' + mod.VERSION + ']' : ' [версия неизвестна — вероятно, старый/чужой main.js]'))
    continue
  }
  M = mod; MAIN_PATH = resolved; MAIN_DIR = pathMod.dirname(resolved)
  console.log('✅ main.js: ' + resolved + ((M && M.VERSION) ? ' (v' + M.VERSION + ')' : ''))
  break
}
if (!M) {
  console.error('❌ Не найден ПОДХОДЯЩИЙ main.js (нужен v5.3.x с экспортами ' + REQUIRED_FNS.join('/') + ').')
  console.error('   Пробовал:')
  for (const r of REJECTS) console.error('     • ' + r)
  console.error('   Решение: положите ЭТОТ скрипт в ту же папку, где лежит ваш рабочий main.js (D:\\captcha\\env), и запускайте оттуда.')
  process.exit(1)
}

const argStr = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d }
const argNum = (n, d) => { const v = Number(argStr(n, String(d))); return Number.isFinite(v) && v >= 0 ? v : d }
const hasArg = n => process.argv.includes('--' + n)

const AN = argNum('an', 309)
const DEADLINE_S = argNum('deadline', 3600)
const WALK_BLOCKS = argNum('walk', 5)
const WRITE_EVERY_S = argNum('every', 60)
const CHAT_TEXT = argStr('text', '1234')
const UNTIL_DELIVERED = argNum('until-delivered', 1) === 1
const HOLD_AFTER_S = argNum('hold-after', 90)
const DRY = hasArg('dry')

// ---- префлIGHT: allowDirect в конфиге (иначе main.js не пустит напрямую) ----
let cfgPath = null
for (const c of [pathMod.join(MAIN_DIR, 'config.json'), pathMod.join(__dirname, '..', 'config.json')]) {
  try { fs.accessSync(c); cfgPath = c; break } catch (e) {}
}
let cfgOk = true
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const ad = cfg && cfg.proxy && cfg.proxy.allowDirect
  if (ad !== true) {
    cfgOk = false
    console.error('❌ В ' + cfgPath + ' не включён прямой заход: нужно "proxy": { "allowDirect": true } — иначе боты не пойдут с вашего IP без прокси.')
  }
} catch (e) { console.error('⚠️ не смог прочитать config.json (' + e.message + ') — продолжаю, положусь на main.js') }
if (!cfgOk) process.exit(1)

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const REC = pathMod.join(MAIN_DIR, 'records', 'pair309d_' + STAMP)
try { fs.mkdirSync(REC, { recursive: true }) } catch (e) {}
const OUT = []
const T0 = Date.now()
const say = s => { const line = '[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + s; try { console.log(line) } catch (e) {} OUT.push(line); try { fs.writeFileSync(pathMod.join(REC, 'pair309.log'), OUT.join('\n') + '\n') } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let BOOT_OK = false   // фикс шага 43: краш ДО старта = немедленный выход (иначе процесс висел бы до дедлайна)
process.on('uncaughtException', e => {
  const msg = String((e && e.message) || e)
  if (/EPIPE/.test(msg)) { try { process.stdout.write = () => true } catch (e2) {}; return }
  try { say('⚠️ uncaughtException: ' + msg.slice(0, 180)) } catch (e2) {}
  if (!BOOT_OK) {
    try { console.error('❌ КРАШ НА СТАРТЕ — выход (code 1). Полный стек: ' + String((e && e.stack) || e).slice(0, 500)) } catch (e2) {}
    process.exit(1)
  }
})
process.on('unhandledRejection', e => { try { say('⚠️ unhandledRejection: ' + String((e && e.message) || e).slice(0, 180)) } catch (e2) {} })

let HARD_STOP = false
let finishFn = null
const deadlineT = setTimeout(() => { HARD_STOP = true; say('⏰ ДЕДЛАЙН ' + DEADLINE_S + 'с'); try { if (finishFn) finishFn() } catch (e) {}; setTimeout(() => process.exit(0), 600) }, DEADLINE_S * 1000)

// ---- случайные аккаунты (свежие → регистрация при входе) ----
// Генераторы: из main.js, если есть; иначе локальные точные копии (фикс шага 43)
const PASS_CHARS_L = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
const NICK_USED_L = new Set()
function localRandomNick(prefix) {
  const p = String(prefix || 'Player').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 10) || 'Player'
  for (let i = 0; i < 500; i++) {
    const n = (p + Math.floor(Math.random() * 900000 + 100000)).slice(0, 16)
    if (!NICK_USED_L.has(n)) { NICK_USED_L.add(n); return n }
  }
  const n = (p + Date.now().toString(36)).slice(0, 16)
  NICK_USED_L.add(n)
  return n
}
function localRandomPass(len) {
  const n = Math.max(6, Math.min(32, Number(len) || 10))
  let s = ''
  for (let i = 0; i < n; i++) s += PASS_CHARS_L[Math.floor(Math.random() * PASS_CHARS_L.length)]
  return s
}
const randomNick = typeof M.randomNick === 'function' ? M.randomNick : localRandomNick
const randomPass = typeof M.randomPass === 'function' ? M.randomPass : localRandomPass
const W_ACC = { nick: randomNick('Player'), pass: randomPass(), fresh: true }
const R_ACC = { nick: randomNick('Player'), pass: randomPass(), fresh: true }

const STATE = {
  ip: '?', reader: null, writer: null,
  writerAttempts: [], delivered: [], firstDeliveryAt: null,
  walk: null, readerAmbient: 0, readerLines: [], readerSaw1234: 0,
  scoreboards: { R: [], W: [] }
}
BOOT_OK = true   // синхронная инициализация завершена без краша

function attachBot(role, st) {
  const { live, bot, client } = st
  bot.on('kicked', r => { let s2 = ''; try { s2 = M.nbtChatText({ content: r }) || JSON.stringify(r).slice(0, 160) } catch (e) { s2 = String(r).slice(0, 160) }; say('[' + role + '] 👢 KICKED: ' + String(s2).replace(/\s+/g, ' ').slice(0, 160)) })
  bot.on('end', reason => { st.dead = true; if (st.afk) clearInterval(st.afk); say('[' + role + '] 🔌 end: ' + reason) })
  client.on('position', () => { st.corrections++ })
  client.on('scoreboard_objective', d => {
    try {
      const t = M.nbtChatText({ content: d.displayText }) || ''
      if (t) { const row = String(t).replace(/\s+/g, ' ').slice(0, 60); const arr = STATE.scoreboards[role]; if (!arr.includes(row) && arr.length < 5) { arr.push(row); say('[' + role + '] 🏆 SCOREBOARD: «' + row + '»') } }
    } catch (e) {}
  })
  client.on('custom_payload', d => { try { if (String(d.channel) === 'minecraft:brand') st.brand = (Buffer.isBuffer(d.data) ? d.data : Buffer.from(d.data || [])).toString('utf8').replace(/\0/g, '').trim() } catch (e) {} })
  // сбор эфира + верификация доставок «1234»
  for (const nm of ['player_chat', 'profileless_chat']) {
    client.prependListener(nm, pk => {
      try {
        let txt = ''
        try { txt = M.nbtChatText({ content: pk && (pk.message !== undefined ? pk.message : pk.content) }) } catch (e) {}
        txt = String(txt || '').replace(/\s+/g, ' ').trim()
        if (!txt) return
        st.chatPkts++
        if (role === 'R') {
          STATE.readerAmbient++
          const row = { at: Math.round((Date.now() - T0) / 1000), text: txt.slice(0, 300) }
          if (STATE.readerLines.length < 2000) STATE.readerLines.push(row)
          try { fs.appendFileSync(pathMod.join(REC, 'reader_chat.jsonl'), JSON.stringify(row) + '\n') } catch (e) {}
          if (txt.indexOf(CHAT_TEXT) >= 0 && txt.toLowerCase().indexOf(W_ACC.nick.toLowerCase()) >= 0) {
            STATE.readerSaw1234++
            STATE.delivered.push(row)
            if (!STATE.firstDeliveryAt) { STATE.firstDeliveryAt = row.at; say('[R] 🎉🎉 ДОСТАВКА! Читатель ВИДИТ «' + CHAT_TEXT + '» от писателя: ' + txt.slice(0, 150)) }
            else say('[R] 🎉 доставка #' + STATE.delivered.length + ': ' + txt.slice(0, 150))
            saveResult()
          } else if (STATE.readerLines.length <= 30 || STATE.readerAmbient % 25 === 0) {
            say('[R] 💬 #' + STATE.readerAmbient + ' ' + txt.slice(0, 140))
          }
        }
      } catch (e) {}
    })
  }
  st.afk = setInterval(() => {
    try {
      if (st.dead || live.isDead() || !bot.entity || client.state !== 'play') return
      bot.look((Number(bot.entity.yaw) || 0) + (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.4, true)
      if (bot.swingArm) bot.swingArm('right')
      if (Math.random() < 0.35) {
        bot.setControlState('forward', true)
        setTimeout(() => { try { bot.setControlState('forward', false); bot.setControlState('back', true); setTimeout(() => { try { bot.setControlState('back', false) } catch (e) {} }, 800) } catch (e) {} }, 800)
      }
    } catch (e) {}
  }, 15000)
}

async function enterInstance(role, acc, loginFirst) {
  if (loginFirst === undefined || loginFirst === null) loginFirst = !acc.fresh
  for (let a = 1; a <= 3; a++) {
    if (HARD_STOP) return null
    say('[' + role + '] попытка ' + a + ' (' + acc.nick + ', loginFirst=' + !!loginFirst + ', НАПРЯМУЮ с вашего IP)')
    const conn = await M.connectAndSolve('p309' + role, { direct: true, nick: acc.nick })
    if (!conn.ok) { say('[' + role + '] ❌ connect: ' + conn.note); await sleep(10000); continue }
    const live = conn.live, bot = live.bot, client = bot._client
    const st = { live, bot, client, corrections: 0, brand: '', chatPkts: 0, dead: false, afk: null, nick: acc.nick }
    attachBot(role, st)
    const res = await M.solveCaptchaOnLive(live, { label: 'p309' + role, dirTag: 'p309d_' + role + '_' + a, roundNo: a, acc, loginFirst: !!loginFirst })
    if (!res.ok) {
      say('[' + role + '] ❌ капча/авторизация: ' + (res.note || res.stage))
      try { live.end('captcha fail') } catch (e) {}
      await sleep(10000)
      continue
    }
    say('[' + role + '] ✅ капча+авторизация («' + (res.ans && res.ans.digits) + '», ' + (res.auth && res.auth.ok ? res.auth.via : '?') + ')')
    if (acc.fresh && res.auth && res.auth.ok) {
      try {
        if (typeof M.dbMarkRegistered === 'function') {
          M.dbMarkRegistered({ nick: acc.nick, pass: acc.pass, owner: 'algo', tunnel: 'algo', ip: STATE.ip, status: 'new', createdAt: new Date().toISOString(), lastUsed: new Date().toISOString(), regConfirmed: false, anarchy: null, note: 'pair309d', busy: false })
        }
      } catch (e) {}
      acc.fresh = false   // регистрация подтверждена сервером — при ре-входе нужен /login, а не /register
    }
    // хаб грузится медленнее и имеет лимит простоя (~90с, кик «Вы не успели
    // войти в игру :()») — порог 120 чанков / 40с, пауза 5с
    for (let i = 0; i < 40; i++) {
      if (live.isDead()) break
      if (live.chunks() >= 120 && client.state === 'play') break
      await sleep(1000)
    }
    if (live.isDead()) { say('[' + role + '] ❌ умер на хабе'); await sleep(8000); continue }
    say('[' + role + '] 🏠 хаб: чанков=' + live.chunks() + ' — пауза 5с')
    await sleep(5000)
    if (live.isDead()) { say('[' + role + '] ❌ умер на паузе'); await sleep(10000); continue }
    let ok = false
    for (let t = 1; t <= 4 && !ok; t++) {
      if (live.isDead()) break
      const st0 = (live.cfgPkts() || {}).start || 0
      say('[' + role + '] 🌀 /an' + AN + ' (' + t + '/4)')
      live.chat('/an' + AN)
      const tW = Date.now()
      let started = false
      while (Date.now() - tW < 20000) {
        if (live.isDead()) break
        if (((live.cfgPkts() || {}).start || 0) > st0) { started = true; break }
        await sleep(500)
      }
      if (!started) { say('[' + role + ']    передача не стартовала за 20с — повтор через 12с'); await sleep(12000); continue }
      const lg0 = live.logins ? live.logins() : 0, c0 = live.chunks(), tI = Date.now()
      while (Date.now() - tI < 90000) {
        if (live.isDead()) break
        if (client.state === 'play' && /UniverseSpigot/i.test(st.brand) && (live.chunks() > c0 + 20 || (live.logins ? live.logins() : 0) > lg0)) break
        await sleep(500)
      }
      if (!live.isDead() && client.state === 'play' && /UniverseSpigot/i.test(st.brand)) ok = true
      else await sleep(6000)
    }
    if (!ok || live.isDead()) { say('[' + role + '] ❌ инстанс не достигнут'); try { live.end('no instance') } catch (e) {}; await sleep(10000); continue }
    say('[' + role + '] 🌍 В ИНСТАНСЕ /an' + AN + ': чанков=' + live.chunks() + ' TAB=' + Object.keys(bot.players || {}).length + ' скорборд=' + (STATE.scoreboards[role].join('|') || '?'))
    return st
  }
  return null
}

async function walkBlocks(st, blocks) {
  const bot = st.bot
  const corr0 = st.corrections
  let best = 0
  for (let dirI = 0; dirI < 4 && best < blocks; dirI++) {
    try {
      await bot.look((Number(bot.entity.yaw) || 0) + dirI * Math.PI / 2, 0, true)
      await sleep(350)
      const p0 = bot.entity.position.clone()
      bot.setControlState('forward', true)
      const tW = Date.now()
      let last = 0
      while (Date.now() - tW < 4500) {
        await sleep(300)
        const p = bot.entity.position
        const d = Math.sqrt((p.x - p0.x) ** 2 + (p.z - p0.z) ** 2)
        if (d > best) best = d
        if (d >= blocks) break
        if (Date.now() - tW > 2000 && Math.abs(d - last) < 0.15) break
        last = d
      }
      bot.setControlState('forward', false)
      await sleep(400)
    } catch (e) { try { bot.setControlState('forward', false) } catch (e2) {} }
  }
  return { dist: +best.toFixed(2), corrections: st.corrections - corr0 }
}

function saveResult() {
  try {
    fs.writeFileSync(pathMod.join(REC, 'RESULT_pair309d.json'), JSON.stringify({
      ts: new Date().toISOString(), anarchy: AN, mode: 'direct(ваш IP)', ip: STATE.ip,
      writer: W_ACC.nick, reader: R_ACC.nick,
      walk: STATE.walk, attempts: STATE.writerAttempts.length,
      delivered: STATE.delivered.length, firstDeliveryAtSec: STATE.firstDeliveryAt,
      readerAmbient: STATE.readerAmbient, readerSaw1234: STATE.readerSaw1234,
      scoreboards: STATE.scoreboards,
      lastAttempts: STATE.writerAttempts.slice(-25),
      readerLinesSample: STATE.readerLines.slice(0, 60)
    }, null, 2))
  } catch (e) {}
}
const saveT = setInterval(saveResult, 300000); saveT.unref && saveT.unref()

;(async () => {
  say('=== PAIR309-DIRECT: ПРЯМОЙ заход с ВАШЕГО IP (без прокси) | an' + AN + ' ===')
  say('    читатель ' + R_ACC.nick + ' (эфир) + писатель ' + W_ACC.nick + ' («' + CHAT_TEXT + '» каждые ' + WRITE_EVERY_S + 'с после ходьбы ' + WALK_BLOCKS + ' блоков)')
  say('    дедлайн ' + DEADLINE_S + 'с | стоп после доставки: ' + (UNTIL_DELIVERED ? 'да (+' + HOLD_AFTER_S + 'с на удержание)' : 'нет (пишет до дедлайна)'))
  say('⚠️ памятка: свежим аккаунтам сервер может отвечать «Вы ещё недостаточно наиграли» — это гейт наигрыша; скрипт продолжает попытки каждую минуту и сам зафиксирует момент, когда запись пройдёт.')
  try { STATE.ip = typeof M.currentIp === 'function' ? await M.currentIp({ directOnly: true, quiet: true }) : '?' } catch (e) { STATE.ip = '?' }
  say('🌐 ваш внешний IP = ' + STATE.ip)
  if (DRY) { say('--dry: проверка завершена, без входа на сервер.'); try { clearTimeout(deadlineT) } catch (e) {}; process.exit(0) }
  say('🕐 8с до первого коннекта…')
  await sleep(8000)

  // 1) ПИСАТЕЛЬ первым (главный актёр; читатель входит фоном)
  let W = await enterInstance('W', W_ACC)
  if (!W) { say('❌ писатель не вошёл за 3 попытки') }
  else {
    STATE.writer = W
    say('[W] ⏳ отстой 15с…')
    await sleep(15000)
    if (!W.dead && !W.live.isDead()) {
      STATE.walk = await walkBlocks(W, WALK_BLOCKS)
      say('[W] 🚶 ХОДЬБА: ' + STATE.walk.dist + ' блоков (цель ≥' + WALK_BLOCKS + ') | коррекций: ' + STATE.walk.corrections + (STATE.walk.corrections > 0 ? ' (RUBBERBAND)' : ' (чисто)') + ' → ' + (STATE.walk.dist >= WALK_BLOCKS ? '✅ ПРОШЁЛ' : '⚠️ НЕДОШЁЛ'))
    }
  }
  // 2) ЧИТАТЕЛЬ фоном (верификация доставок; если не войдёт — писатель всё равно работает)
  STATE.readerEntering = true
  ;(async () => {
    const R = await enterInstance('R', R_ACC)
    STATE.readerEntering = false
    if (R) { STATE.reader = R; say('[R] 👂 читатель на позиции — собираю эфир и жду «' + CHAT_TEXT + '» от ' + W_ACC.nick) }
    else say('[R] ❌ читатель не вошёл — писатель работает без верификации доставки')
  })()
  if (!W) { say('❌ прогон без писателя бессмыслен'); process.exit(1) }

  // 3) ЦИКЛ ЗАПИСИ каждую минуту + надзор за смертями
  let attempt = 0
  let nextWrite = Date.now() + 5000
  let lastSupervise = 0
  let stopAt = 0
  say('🔁 цикл «' + CHAT_TEXT + '» каждые ' + WRITE_EVERY_S + 'с…')
  while (!HARD_STOP) {
    await sleep(3000)
    // надзор: писатель умер → один ре-вход (уже зарегистрирован → /login)
    if ((!STATE.writer || STATE.writer.dead || STATE.writer.live.isDead()) && !W_ACC.reentered && !HARD_STOP && Date.now() - lastSupervise > 30000) {
      lastSupervise = Date.now()
      W_ACC.reentered = true
      say('[W] 💀 писатель умер — РЕ-ВХОД (тот же IP, /login)…')
      const W2 = await enterInstance('W', W_ACC, true)
      if (W2) { STATE.writer = W2; nextWrite = Date.now() + 10000; say('[W] ♻️ писатель снова в инстансе — цикл записи продолжен') }
      else say('[W] ❌ ре-вход не удался — остаётся читатель')
    }
    // надзор: читатель умер → ре-вход
    if ((!STATE.reader || STATE.reader.dead || STATE.reader.live.isDead()) && !R_ACC.reentered && !STATE.readerEntering && !HARD_STOP) {
      R_ACC.reentered = true
      say('[R] 💀 читатель умер — РЕ-ВХОД…')
      const R2 = await enterInstance('R', R_ACC, true)
      if (R2) { STATE.reader = R2; say('[R] ♻️ читатель снова в инстансе') }
    }
    // запись каждую минуту (до первой подтверждённой доставки, если until-delivered)
    const W = STATE.writer
    if (W && !W.dead && !W.live.isDead() && Date.now() >= nextWrite && !(stopAt && Date.now() >= stopAt)) {
      nextWrite = Date.now() + WRITE_EVERY_S * 1000
      attempt++
      const mk = W.live.chatsLen()
      W.live.chat(CHAT_TEXT)
      await sleep(12000)
      const own = W.live.chatsFrom(mk).slice(0, 6).map(x => String(x).replace(/\s+/g, ' ').slice(0, 160))
      const gate = own.find(x => /наиграли/i.test(x)) ? 'недостаточно наиграли'
        : own.find(x => /привяз|\/vk или \/tg/i.test(x)) ? 'привязка ВК/TG'
        : own.find(x => /прошептал|отправл/i.test(x)) ? 'ПОДТВЕРЖДЕНИЕ ОТПРАВКИ'
        : own.length ? 'другое: ' + own[0].slice(0, 90) : 'тишина (0 реакций)'
      STATE.writerAttempts.push({ n: attempt, at: Math.round((Date.now() - T0) / 1000), gate, own: own.slice(0, 4) })
      say('[W] 📨 «' + CHAT_TEXT + '» #' + attempt + ' → ' + gate + (STATE.delivered.length ? ' | ДОСТАВОК читателем seen: ' + STATE.delivered.length : ''))
      if (attempt % 10 === 0) saveResult()
      if (UNTIL_DELIVERED && STATE.delivered.length && !stopAt) {
        stopAt = Date.now() + HOLD_AFTER_S * 1000
        say('[W] ✅ доставка подтверждена — запись остановлена, удержание ' + HOLD_AFTER_S + 'с и выход')
      }
    }
    // читатель: периодический статус
    if (STATE.reader && !STATE.reader.dead && Math.floor((Date.now() - T0) / 300000) !== STATE.lastReaderStat) {
      STATE.lastReaderStat = Math.floor((Date.now() - T0) / 300000)
      if (STATE.lastReaderStat > 0) say('[R] 📊 эфир: ' + STATE.readerAmbient + ' сообщений игроков | доставок «' + CHAT_TEXT + '»: ' + STATE.delivered.length + ' | писатель: попыток ' + attempt)
    }
    if (stopAt && Date.now() >= stopAt) { HARD_STOP = true; break }
    if (!W && !STATE.reader) break
    if ((STATE.writer == null || STATE.writer.dead) && W_ACC.reentered && (!STATE.reader || STATE.reader.dead)) break
  }

  finishFn = null
  say('==================================================')
  say('🏁 ИТОГ PAIR309-DIRECT (an' + AN + ', ваш IP ' + STATE.ip + '):')
  say('   писатель ' + W_ACC.nick + ': ходьба ' + (STATE.walk ? STATE.walk.dist + ' бл (корр ' + STATE.walk.corrections + ')' : 'не выполнена') + ' | попыток «' + CHAT_TEXT + '»: ' + attempt + ' | скорборд: ' + (STATE.scoreboards.W.join('|') || '?'))
  const gates = {}
  for (const a of STATE.writerAttempts) gates[a.gate.slice(0, 30)] = (gates[a.gate.slice(0, 30)] || 0) + 1
  say('   реакции сервера на запись: ' + JSON.stringify(gates))
  say('   читатель ' + R_ACC.nick + ': эфира собрано ' + STATE.readerAmbient + ' сообщений | 🎉 доставок «' + CHAT_TEXT + '» от писателя: ' + STATE.delivered.length + (STATE.firstDeliveryAt ? ' (первая на ' + STATE.firstDeliveryAt + 'с)' : '') + ' | скорборд: ' + (STATE.scoreboards.R.join('|') || '?'))
  say('   ВЕРДИКТ: ' + (STATE.delivered.length ? '🎉 ЗАПИСЬ В ЧАТ РАБОТАЕТ (доставлено ' + STATE.delivered.length + ')' : '⛔ запись отбрасывается (гейт: ' + Object.keys(gates).join(', ') + ')'))
  say('   аккаунты сохранены в learn/accounts_db.json: ' + W_ACC.nick + ', ' + R_ACC.nick + ' (пароли там же)')
  saveResult()
  say('💾 ' + pathMod.join(REC, 'RESULT_pair309d.json'))
  try { clearTimeout(deadlineT) } catch (e) {}
  for (const st of [STATE.reader, STATE.writer]) { if (st) { try { clearInterval(st.afk) } catch (e) {}; try { st.live.end('done') } catch (e) {} } }
  setTimeout(() => process.exit(0), 1200)
})().catch(e => { say('FATAL: ' + String((e && e.stack) || e).slice(0, 300)); saveResult(); process.exit(1) })
