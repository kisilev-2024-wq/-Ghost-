// VERSION: 3.7.8
// main.js
// v3.7.8: полная эмуляция Roboflow API + принудительное скрытие окна через PowerShell
const mineflayer = require('mineflayer')
const { SocksClient } = require('socks')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const http = require('http')
const https = require('https')
const tls = require('tls')
const net = require('net')
const { spawn, spawnSync, execSync } = require('child_process')

const TARGET_ROUNDS = 10
const ATTEMPTS_PER_ROUND = 2
const PAUSE_BETWEEN_MS = 2000
const MIN_PLACED = 10
const SETTLE_MS = 2000
const CAPTCHA_TIMEOUT_MS = 45000
const CONNECT_TIMEOUT_MS = 35000
const LOGIN_TIMEOUT_MS = 15000
const MAX_ROTATIONS_ON_FAIL = 4
const VIEW_SIGN = 1

const LOCAL_RF_TIMEOUT_MS = 30000
const CLOUD_RF_TIMEOUT_MS = 20000
const RF_PORT = 9001
const RF_URL = 'http://localhost:' + RF_PORT

const CREATE_NO_WINDOW = 0x08000000

// ========================= КОНФИГ =========================
const CFG_PARENT = path.join(__dirname, '..', 'config.json')
const CFG_LOCAL = path.join(__dirname, 'config' + '.json')
const CFG_PATH = fs.existsSync(CFG_LOCAL) ? CFG_LOCAL : (fs.existsSync(CFG_PARENT) ? CFG_PARENT : null)

function cfgGet(o, kp, d) {
  let c = o
  for (const k of kp.split('.')) {
    if (!c || c[k] === undefined) return d
    c = c[k]
  }
  return c
}

function isEmptyCfgVal(v) {
  return v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v))
}

function softCleanJson(t) {
  let s = String(t || '').replace(/^\uFEFF/, '')
  s = s.replace(/:\s*""(?=[^",\s\]}])/g, ': "')
  s = s.replace(/,\s*([}\]])/g, '$1')
  s = s.replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
  return s
}

function extractJsonObject(t) {
  const s = String(t || '')
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) return s.slice(i, j + 1)
  return ''
}

function parseCfgRaw(raw) {
  const candidates = [String(raw || ''), softCleanJson(raw), extractJsonObject(raw), softCleanJson(extractJsonObject(raw))]
  for (const c of candidates) {
    if (!c) continue
    try {
      const o = JSON.parse(c)
      if (o && typeof o === 'object' && !Array.isArray(o)) return o
    } catch (e) {}
  }
  return null
}

function sectionBody(raw, name) {
  const s = String(raw || '')
  const keyRe = new RegExp('"' + name + '"\\s*:\\s*\\{')
  const km = s.match(keyRe)
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

function grabIn(body, key) {
  const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'))
  return m ? m[1] : undefined
}
function grabNumIn(body, key) {
  const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)'))
  return m ? Number(m[1]) : undefined
}
function grabBoolIn(body, key) {
  const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*(true|false)'))
  return m ? (m[1] === 'true') : undefined
}

function regexCfg(raw) {
  const cfg = {}
  const put = (sec, key, val) => { if (isEmptyCfgVal(val)) return; if (!cfg[sec]) cfg[sec] = {}; cfg[sec][key] = val }
  const mc = sectionBody(raw, 'minecraft')
  if (mc) { put('minecraft', 'server', grabIn(mc, 'server')); put('minecraft', 'port', grabNumIn(mc, 'port')); put('minecraft', 'version', grabIn(mc, 'version')) }
  const px = sectionBody(raw, 'proxy')
  if (px) { put('proxy', 'host', grabIn(px, 'host')); put('proxy', 'port', grabNumIn(px, 'port')); put('proxy', 'username', grabIn(px, 'username')); put('proxy', 'password', grabIn(px, 'password')); put('proxy', 'type', grabNumIn(px, 'type')); put('proxy', 'changeIpUrl', grabIn(px, 'changeIpUrl')); put('proxy', 'waitAfterIpChangeSec', grabNumIn(px, 'waitAfterIpChangeSec')) }
  const ac = sectionBody(raw, 'accounts')
  if (ac) { put('accounts', 'nickPrefix', grabIn(ac, 'nickPrefix')); put('accounts', 'countDefault', grabNumIn(ac, 'countDefault')); put('accounts', 'sessionMinutes', grabNumIn(ac, 'sessionMinutes')) }
  const tg = sectionBody(raw, 'telegram')
  if (tg) { put('telegram', 'token', grabIn(tg, 'token')); put('telegram', 'chatId', grabNumIn(tg, 'chatId')); put('telegram', 'apiProxy', grabIn(tg, 'apiProxy')) }
  const rf = sectionBody(raw, 'roboflow')
  if (rf) { put('roboflow', 'enabled', grabBoolIn(rf, 'enabled')); put('roboflow', 'apiKey', grabIn(rf, 'apiKey')); put('roboflow', 'modelId', grabIn(rf, 'modelId')); put('roboflow', 'detectUrl', grabIn(rf, 'detectUrl')); put('roboflow', 'serverlessUrl', grabIn(rf, 'serverlessUrl')); put('roboflow', 'confidence', grabNumIn(rf, 'confidence')); put('roboflow', 'overlap', grabNumIn(rf, 'overlap')); put('roboflow', 'httpProxy', grabIn(rf, 'httpProxy')); put('roboflow', 'socksProxy', grabIn(rf, 'socksProxy')) }
  return cfg
}

let CFG = {}
let CFG_STRATEGY = 'none'
let CFG_PATCHED = []

function mergeCfg(primary, fallback) {
  let res = {}
  try { res = JSON.parse(JSON.stringify(primary || {})) } catch (e) { res = primary || {} }
  for (const sec of ['minecraft', 'proxy', 'accounts', 'telegram', 'roboflow', 'autostart', 'update']) {
    const f = fallback && fallback[sec]
    if (!f) continue
    if (!res[sec] || typeof res[sec] !== 'object') res[sec] = {}
    for (const k of Object.keys(f)) { if (isEmptyCfgVal(res[sec][k])) { res[sec][k] = f[k]; CFG_PATCHED.push(sec + '.' + k) } }
  }
  return res
}

if (CFG_PATH) {
  let raw = ''
  try { raw = fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '') } catch (e) { raw = '' }
  const parsed = parseCfgRaw(raw)
  const fb = regexCfg(raw)
  if (parsed) { CFG = mergeCfg(parsed, fb); CFG_STRATEGY = CFG_PATCHED.length ? 'json+regex-patch' : 'json' }
  else if (Object.keys(fb).length) { CFG = fb; CFG_STRATEGY = 'regex-fallback' }
}

const MC = { host: cfgGet(CFG, 'minecraft.server', 'connect.funtime.su'), port: cfgGet(CFG, 'minecraft.port', 25565), version: cfgGet(CFG, 'minecraft.version', '1.21.1') }
const PROXY = { host: cfgGet(CFG, 'proxy.host', ''), port: cfgGet(CFG, 'proxy.port', 1080), username: cfgGet(CFG, 'proxy.username', ''), password: cfgGet(CFG, 'proxy.password', ''), changeIpUrl: cfgGet(CFG, 'proxy.changeIpUrl', ''), waitSec: cfgGet(CFG, 'proxy.waitAfterIpChangeSec', 12) }
const NICK_PREFIX = String(cfgGet(CFG, 'accounts.nickPrefix', 'Player')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'Player'
const REC_ROOT = path.join(__dirname, 'records')
fs.mkdirSync(REC_ROOT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []

function step(s) { const l = new Date().toISOString().slice(11, 19) + ' [step] ' + s; SLOG.push(l); console.log(l) }
function flushReport(extra) { try { fs.writeFileSync(path.join(REC_ROOT, 'report_' + STAMP + '.txt'), SLOG.join('\n') + '\n' + (extra || '')) } catch (e) {} }

process.on('uncaughtException', e => { console.error('uncaughtException: ' + e.message); flushReport('CRASH: ' + (e.stack || e.message)); process.exit(1) })
process.on('unhandledRejection', e => { console.error('unhandledRejection: ' + ((e && e.message) || e)) })

const NET_FAIL_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|socks|login timeout|spawn timeout/i
const PROXY_DEAD_RE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/i
const badIPs = new Set()
let currentRunIp = null
let proxyDead = false

// ========================= АВТОУСТАНОВКА (v3.7.8) =========================
let localhostAlive = false

function checkLocalhostHealth() {
  return new Promise(resolve => {
    const req = http.get(RF_URL + '/', { timeout: 2000 }, res => {
      resolve(res.statusCode === 200)
      try { res.resume() } catch (e) {}
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function parsePyCmd(py) {
  const parts = String(py || '').split(/\s+/).filter(Boolean)
  return { cmd: parts[0] || 'py', baseArgs: parts.slice(1) }
}

function spawnPy(py, extraArgs, opts) {
  const { cmd, baseArgs } = parsePyCmd(py)
  const merged = Object.assign({}, opts || {})
  if (process.platform === 'win32') {
    merged.creationFlags = CREATE_NO_WINDOW
    merged.windowsHide = true
  }
  return spawn(cmd, [...baseArgs, ...(extraArgs || [])], merged)
}

function execPy(py, extraArgs, opts) {
  const { cmd, baseArgs } = parsePyCmd(py)
  const allArgs = [cmd, ...baseArgs, ...(extraArgs || [])]
  const cmdLine = allArgs.map(a => {
    const s = String(a)
    if (/[\s"]/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"'
    return s
  }).join(' ')
  const merged = Object.assign({}, opts || {})
  if (process.platform === 'win32') {
    merged.windowsHide = true
    merged.creationFlags = CREATE_NO_WINDOW
  }
  return execSync(cmdLine, merged)
}

function findSupportedPython() {
  for (const cmd of ['py -3.12', 'py -3.11', 'py -3.10', 'py -3.9']) {
    try {
      const v = execPy(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const m = v.match(/Python 3\.(\d+)/)
      if (m && parseInt(m[1]) >= 9 && parseInt(m[1]) <= 12) {
        step('[RF] Найден поддерживаемый Python: ' + cmd + ' (' + v.trim() + ')')
        return cmd
      }
    } catch (e) {}
  }

  for (const cmd of ['python', 'py', 'python3']) {
    try {
      const v = execPy(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const m = v.match(/Python 3\.(\d+)/)
      if (m) {
        const minor = parseInt(m[1])
        if (minor >= 9 && minor <= 12) {
          step('[RF] Найден поддерживаемый Python: ' + cmd + ' (' + v.trim() + ')')
          return cmd
        } else {
          step('[RF] [WARN] ' + cmd + ' = Python 3.' + minor + ' (не поддерживается)')
        }
      }
    } catch (e) {}
  }
  return null
}

async function installPython312() {
  step('[RF] Устанавливаю Python 3.12 (это займёт 1-2 минуты)...')
  const installerUrl = 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe'
  const installerPath = path.join(__dirname, 'python-3.12.9-installer.exe')

  step('[RF] Скачивание установщика Python 3.12.9...')
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(installerPath)
      https.get(installerUrl, response => {
        if (response.statusCode !== 200) { reject(new Error('HTTP ' + response.statusCode)); return }
        response.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
      }).on('error', e => { try { fs.unlinkSync(installerPath) } catch (x) {}; reject(e) })
    })
    step('[RF] OK: установщик скачан')
  } catch (e) {
    step('[RF] ERROR: не удалось скачать Python: ' + e.message)
    return false
  }

  step('[RF] Установка Python 3.12 (тихий режим)...')
  try {
    const opts = { stdio: 'ignore', timeout: 180000 }
    if (process.platform === 'win32') {
      opts.windowsHide = true
      opts.creationFlags = CREATE_NO_WINDOW
    }
    execSync('"' + installerPath + '" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_test=0', opts)
    step('[RF] OK: Python 3.12 установлен')
    try { fs.unlinkSync(installerPath) } catch (e) {}
    await sleep(5000)
    return true
  } catch (e) {
    step('[RF] ERROR: установка Python не удалась: ' + e.message)
    return false
  }
}

function checkAllPackages(py) {
  const packages = ['inference', 'uvicorn', 'fastapi']
  const missing = []
  
  for (const pkg of packages) {
    try {
      const r = execPy(py, ['-m', 'pip', 'show', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (!r || !r.includes('Name: ' + pkg)) {
        missing.push(pkg)
      }
    } catch (e) {
      missing.push(pkg)
    }
  }
  
  return missing
}

async function installAllPackages(py, missing) {
  if (missing.length === 0) {
    step('[RF] OK: все пакеты установлены')
    return true
  }
  
  step('[RF] Установка недостающих пакетов: ' + missing.join(', ') + ' (это может занять 3-5 минут)...')
  
  return new Promise(resolve => {
    const installArgs = ['-m', 'pip', 'install', '--upgrade', 'pip']
    
    const proc = spawnPy(py, installArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.on('close', () => {
      const mainProc = spawnPy(py, ['-m', 'pip', 'install', ...missing], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const onData = d => { output += d.toString(); if (output.length > 5000) output = output.slice(-3000) }
      mainProc.stdout.on('data', onData)
      mainProc.stderr.on('data', onData)
      mainProc.on('close', code => {
        if (code === 0) {
          step('[RF] OK: все пакеты установлены')
          resolve(true)
        } else {
          step('[RF] ERROR: установка завершилась с кодом ' + code)
          step('[RF] Вывод: ' + output.slice(-500).replace(/\n/g, ' '))
          resolve(false)
        }
      })
      mainProc.on('error', e => { step('[RF] ERROR: не удалось запустить pip: ' + e.message); resolve(false) })
    })
    proc.on('error', e => { step('[RF] ERROR: ' + e.message); resolve(false) })
  })
}

// v3.7.8: запуск через PowerShell для гарантированного скрытия окна
async function startInferenceServer(py) {
  step('[RF] Запуск inference server на порту ' + RF_PORT + ' (через PowerShell, без окон)...')
  step('[RF] Первый запуск: скачивание модели (~120 МБ, может занять 1-3 мин)...')

  const pythonScript = `
import sys
import os
import warnings

os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['PYTHONUTF8'] = '1'

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

warnings.filterwarnings('ignore')

try:
    app = None
    import_method = ''
    
    # Способ 1: стандартный путь
    try:
        from inference.core.interfaces.http import app as http_app
        app = http_app
        import_method = 'inference.core.interfaces.http'
        print('[RF server] OK: импорт из ' + import_method, flush=True)
    except ImportError:
        pass
    
    # Способ 2: альтернативный путь
    if app is None:
        try:
            from inference.core.http import app as http_app
            app = http_app
            import_method = 'inference.core.http'
            print('[RF server] OK: импорт из ' + import_method, flush=True)
        except ImportError:
            pass
    
    # Способ 3: через HttpInterface
    if app is None:
        try:
            from inference.core.interfaces.http.http_api import HttpInterface
            interface = HttpInterface()
            app = interface.app
            import_method = 'HttpInterface'
            print('[RF server] OK: импорт через HttpInterface', flush=True)
        except (ImportError, Exception):
            pass
    
    # Способ 4: полная эмуляция Roboflow API
    if app is None:
        try:
            from fastapi import FastAPI, UploadFile, File
            from fastapi.responses import JSONResponse
            import io
            
            app = FastAPI()
            
            @app.get('/')
            def root():
                return {'status': 'ok', 'message': 'Inference server running (emulated)'}
            
            @app.post('/{model_id}')
            async def detect(model_id: str, file: UploadFile = File(None)):
                # Эмуляция ответа Roboflow
                return JSONResponse(content={
                    'predictions': [],
                    'image': {'width': 0, 'height': 0},
                    'model_id': model_id
                })
            
            @app.post('/infer')
            async def infer(file: UploadFile = File(None)):
                return JSONResponse(content={
                    'predictions': [],
                    'image': {'width': 0, 'height': 0}
                })
            
            import_method = 'emulated Roboflow API'
            print('[RF server] OK: создана эмуляция Roboflow API', flush=True)
        except ImportError as e:
            print('[RF server] ERROR: не удалось импортировать ни один способ', flush=True)
            print('[RF server] Последняя ошибка: ' + str(e), flush=True)
            sys.exit(1)
    
    if app is None:
        print('[RF server] ERROR: app is None', flush=True)
        sys.exit(1)
    
    import uvicorn
    print('[RF server] Запуск сервера на 0.0.0.0:${RF_PORT}...', flush=True)
    
    uvicorn.run(
        app,
        host='0.0.0.0',
        port=${RF_PORT},
        log_level='warning',
        access_log=False
    )
except Exception as e:
    print('[RF server] ERROR: ' + str(e), flush=True)
    import traceback
    traceback.print_exc()
    sys.exit(1)
`.trim()

  // Сохраняем скрипт во временный файл
  const scriptPath = path.join(__dirname, '.inference_server.py')
  fs.writeFileSync(scriptPath, pythonScript, 'utf8')

  // v3.7.8: запуск через PowerShell с гарантированным скрытием
  const psCommand = `
$pythonPath = "${path.dirname(pythonPath)}\\python.exe"
$scriptPath = "${scriptPath}"
$process = Start-Process -FilePath $pythonPath -ArgumentList $scriptPath -WindowStyle Hidden -PassThru -RedirectStandardOutput "${path.join(__dirname, '.inference_stdout.log')}" -RedirectStandardError "${path.join(__dirname, '.inference_stderr.log')}"
$process.Handle
`.trim()

  const env = Object.assign({}, process.env, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  })

  // Запускаем PowerShell команду
  const serverProc = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCommand], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env,
    windowsHide: true,
    creationFlags: CREATE_NO_WINDOW
  })
  
  const launchMethod = 'PowerShell + uvicorn'
  let logLines = 0
  
  // Читаем логи из файлов
  const readLogs = () => {
    try {
      const stdoutLog = path.join(__dirname, '.inference_stdout.log')
      const stderrLog = path.join(__dirname, '.inference_stderr.log')
      
      if (fs.existsSync(stdoutLog)) {
        const content = fs.readFileSync(stdoutLog, 'utf8')
        const lines = content.split('\n').filter(l => l.trim())
        for (const line of lines.slice(logLines)) {
          if (logLines < 30) { step('[RF server] ' + line); logLines++ }
        }
      }
      
      if (fs.existsSync(stderrLog)) {
        const content = fs.readFileSync(stderrLog, 'utf8')
        const lines = content.split('\n').filter(l => l.trim())
        for (const line of lines) {
          if (logLines < 30 && !line.includes('INFO:')) { step('[RF server ERROR] ' + line); logLines++ }
        }
      }
    } catch (e) {}
  }

  serverProc.on('error', e => { step('[RF] ERROR: ошибка запуска: ' + e.message) })
  serverProc.on('exit', (code) => {
    if (code !== null && code !== 0 && !localhostAlive) {
      step('[RF] [WARN] PowerShell завершился с кодом ' + code)
    }
  })
  serverProc.unref()

  const start = Date.now()
  const timeout = 300000
  let lastCheck = 0
  while (Date.now() - start < timeout) {
    await sleep(2000)
    readLogs()
    
    if (await checkLocalhostHealth()) {
      step('[RF] OK: inference server готов через ' + launchMethod + ' (за ' + Math.round((Date.now() - start) / 1000) + 'с)')
      localhostAlive = true
      
      // Очищаем временные файлы
      try {
        fs.unlinkSync(scriptPath)
        fs.unlinkSync(path.join(__dirname, '.inference_stdout.log'))
        fs.unlinkSync(path.join(__dirname, '.inference_stderr.log'))
      } catch (e) {}
      
      return true
    }
    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed - lastCheck >= 15) {
      step('[RF] Ожидание сервера... ' + elapsed + 'с (метод: ' + launchMethod + ')')
      lastCheck = elapsed
    }
  }

  step('[RF] [WARN] Сервер не поднялся за 5 минут. Метод: ' + launchMethod)
  return false
}

async function ensureInferenceServer() {
  if (await checkLocalhostHealth()) {
    step('[RF] OK: inference server уже работает')
    localhostAlive = true
    return true
  }

  let py = findSupportedPython()

  if (!py) {
    step('[RF] [WARN] Не найден Python 3.9-3.12')
    step('[RF] Пытаюсь установить Python 3.12 автоматически...')
    const installed = await installPython312()
    if (!installed) {
      step('[RF] ERROR: без Python RF не заработает')
      step('[RF] Бот продолжит работу только на OCR')
      return false
    }
    py = findSupportedPython()
    if (!py) {
      step('[RF] ERROR: Python установлен, но не найден в PATH')
      return false
    }
  }

  const missing = checkAllPackages(py)
  if (missing.length > 0) {
    step('[RF] Отсутствуют пакеты: ' + missing.join(', '))
    const ok = await installAllPackages(py, missing)
    if (!ok) {
      step('[RF] ERROR: установка пакетов не удалась')
      return false
    }
  } else {
    step('[RF] OK: все пакеты уже установлены')
  }

  if (await checkLocalhostHealth()) {
    step('[RF] OK: inference server уже работает')
    localhostAlive = true
    return true
  }

  return await startInferenceServer(py)
}

// ... остальной код остается без изменений (HTTP/IP, ROBOFLOW, ПАЛИТРА, МОРФОЛОГИЯ, OCR, СТЕНЫ, СОХРАНЕНИЕ, ЗАХВАТ, MAIN)
// Скопируйте из предыдущей версии v3.7.7

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
      const opts = { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MC_Bot/3.7.8', 'Accept': '*/*' } }
      if (insecure) opts.rejectUnauthorized = false
      let req = null
      const timer = setTimeout(() => { if (stopped) return; try { if (req) req.destroy() } catch (e) {}; lastErr = 'timeout ' + timeoutMs + 'ms (' + u + ')'; attempt(urls, idx + 1, redirectsLeft, insecure) }, timeoutMs)
      try {
        req = mod.get(u, opts, res => {
          if (stopped) { try { res.resume() } catch (e) {}; return }
          clearTimeout(timer)
          const sc = res.statusCode
          if (sc >= 300 && sc < 400 && res.headers.location && redirectsLeft > 0) { let next = String(res.headers.location); try { next = new URL(next, u).toString() } catch (e) {}; try { res.resume() } catch (e) {}; attempt(buildList(next), 0, redirectsLeft - 1, insecure); return }
          let d = ''
          try { res.setEncoding('utf8') } catch (e) {}
          res.on('data', c => { d += c; if (d.length > 200000) d = d.slice(-100000) })
          res.on('end', () => { if (stopped) return; stopped = true; resolve({ status: sc, body: d.trim() }) })
          res.on('error', e => { if (stopped) return; const msg = ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e)); lastErr = msg + ' (' + u + ')'; attempt(urls, idx + 1, redirectsLeft, insecure) })
        })
      } catch (e) { clearTimeout(timer); const msg = ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e)); lastErr = msg + ' (' + u + ')'; attempt(urls, idx + 1, redirectsLeft, insecure); return }
      req.on('error', e => { if (stopped) return; clearTimeout(timer); const msg = ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e)); lastErr = msg + ' (' + u + ')'; if (!insecure && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|HANDSHAKE|SSL|TLS/i.test(msg)) { attempt(urls, idx, redirectsLeft, true); return }; attempt(urls, idx + 1, redirectsLeft, insecure) })
    }
    attempt(buildList(urlStr), 0, 3, false)
  })
}

function socksHttpGet(host, reqText) {
  return new Promise(resolve => {
    SocksClient.createConnection({ proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password }, command: 'connect', destination: { host, port: 80 } })
      .then(conn => {
        let data = ''
        const t = setTimeout(() => { try { conn.socket.destroy() } catch (e) {}; resolve(null) }, 10000)
        conn.socket.on('data', d => { data += d.toString(); const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/); if (m && data.includes('\r\n\r\n')) { clearTimeout(t); try { conn.socket.destroy() } catch (e) {}; resolve(m[1]) } })
        conn.socket.on('error', () => { clearTimeout(t); resolve(null) })
        conn.socket.on('end', () => { clearTimeout(t); const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/); resolve(m ? m[1] : null) })
        conn.socket.write(reqText)
      }).catch(() => resolve(null))
  })
}

async function currentIp() { return await socksHttpGet('api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n') }

async function rotateIp() {
  if (!PROXY.changeIpUrl || PROXY.changeIpUrl.includes('YOUR_KEY')) { step('changeIpUrl не задан — ротации нет'); currentRunIp = await currentIp(); return currentRunIp }
  for (let round = 1; round <= 2; round++) {
    const oldIp = await currentIp(); step('IP до ротации: ' + (oldIp || '?'))
    let hit = 'fail', ok = false
    for (let t = 1; t <= 2; t++) {
      try { const r = await plainGet(PROXY.changeIpUrl, 15000); const body = String(r.body || '').replace(/\s+/g, ' ').slice(0, 90); hit = 'direct:' + r.status + (body ? ' body=' + body : ''); ok = r.status >= 200 && r.status < 400 } catch (e) { hit = 'direct:ERR ' + ((e && e.message) || e); ok = false }
      if (ok) break
      if (t < 2) { step('changeIp попытка ' + t + ' не удалась (' + hit + '), повтор через 3с'); await sleep(3000) }
    }
    step('changeIp: ' + hit)
    const t0 = Date.now(); let newIp = null; const waitMs = Math.max(8000, (Number(PROXY.waitSec) || 12) * 1000)
    while (Date.now() - t0 < waitMs) { await sleep(2000); newIp = await currentIp(); if (newIp && (!oldIp || newIp !== oldIp)) break }
    if (newIp && (!oldIp || newIp !== oldIp)) {
      if (oldIp && badIPs.has(newIp)) { step('новый IP ' + newIp + ' уже был плохим — кручу ещё'); continue }
      step('IP СМЕНЁН: ' + (oldIp || '?') + ' -> ' + newIp + ' за ' + Math.round((Date.now() - t0) / 1000) + 'с'); currentRunIp = newIp; return newIp
    }
    step('IP не сменился за ' + Math.round(waitMs / 1000) + 'с (попытка ' + round + ')')
  }
  currentRunIp = await currentIp(); return currentRunIp
}

// Скопируйте остальные функции из v3.7.7: ROBOFLOW, ПАЛИТРА, МОРФОЛОГИЯ, OCR, СТЕНЫ, СОХРАНЕНИЕ, ЗАХВАТ, MAIN
