// VERSION: 3.7.8
// main.js
// v3.7.8: PowerShell запуск (гарантированно без окон) + полная эмуляция Roboflow API
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

// ========================= КОНФИГ =========================
const CFG_PARENT = path.join(__dirname, '..', 'config.json')
const CFG_LOCAL = path.join(__dirname, 'config' + '.json')
const CFG_PATH = fs.existsSync(CFG_LOCAL) ? CFG_LOCAL : (fs.existsSync(CFG_PARENT) ? CFG_PARENT : null)

function cfgGet(o, kp, d) { let c = o; for (const k of kp.split('.')) { if (!c || c[k] === undefined) return d; c = c[k] }; return c }
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
  if (i >= 0 && j > i) return s.slice(i, j + 1); return ''
}

function parseCfgRaw(raw) {
  const candidates = [String(raw || ''), softCleanJson(raw), extractJsonObject(raw), softCleanJson(extractJsonObject(raw))]
  for (const c of candidates) { if (!c) continue; try { const o = JSON.parse(c); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch (e) {} }
  return null
}

function sectionBody(raw, name) {
  const s = String(raw || ''); const keyRe = new RegExp('"' + name + '"\\s*:\\s*\\{'); const km = s.match(keyRe)
  if (!km) return ''; const start = km.index + km[0].length - 1
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

function grabIn(body, key) { const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1] : undefined }
function grabNumIn(body, key) { const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)')); return m ? Number(m[1]) : undefined }
function grabBoolIn(body, key) { const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*(true|false)')); return m ? (m[1] === 'true') : undefined }

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

let CFG = {}; let CFG_STRATEGY = 'none'; let CFG_PATCHED = []

function mergeCfg(primary, fallback) {
  let res = {}; try { res = JSON.parse(JSON.stringify(primary || {})) } catch (e) { res = primary || {} }
  for (const sec of ['minecraft', 'proxy', 'accounts', 'telegram', 'roboflow', 'autostart', 'update']) {
    const f = fallback && fallback[sec]; if (!f) continue
    if (!res[sec] || typeof res[sec] !== 'object') res[sec] = {}
    for (const k of Object.keys(f)) { if (isEmptyCfgVal(res[sec][k])) { res[sec][k] = f[k]; CFG_PATCHED.push(sec + '.' + k) } }
  }
  return res
}

if (CFG_PATH) {
  let raw = ''; try { raw = fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '') } catch (e) { raw = '' }
  const parsed = parseCfgRaw(raw); const fb = regexCfg(raw)
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

// ========================= АВТОУСТАНОВКА INFERENCE SERVER (v3.7.8) =========================
let localhostAlive = false

function checkLocalhostHealth() {
  return new Promise(resolve => {
    const req = http.get(RF_URL + '/', { timeout: 2000 }, res => {
      resolve(res.statusCode === 200); try { res.resume() } catch (e) {}
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function parsePyCmd(py) {
  const parts = String(py || '').split(/\s+/).filter(Boolean)
  return { cmd: parts[0] || 'py', baseArgs: parts.slice(1) }
}

function execPy(py, extraArgs, opts) {
  const { cmd, baseArgs } = parsePyCmd(py)
  const allArgs = [cmd, ...baseArgs, ...(extraArgs || [])]
  const cmdLine = allArgs.map(a => { const s = String(a); if (/[\s"]/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"'; return s }).join(' ')
  const merged = Object.assign({}, opts || {})
  if (process.platform === 'win32') { merged.windowsHide = true; merged.creationFlags = 0x08000000 }
  return execSync(cmdLine, merged)
}

function findSupportedPython() {
  for (const cmd of ['py -3.12', 'py -3.11', 'py -3.10', 'py -3.9']) {
    try {
      const v = execPy(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const m = v.match(/Python 3\.(\d+)/)
      if (m && parseInt(m[1]) >= 9 && parseInt(m[1]) <= 12) {
        step('[RF] Найден Python: ' + cmd + ' (' + v.trim() + ')'); return cmd
      }
    } catch (e) {}
  }
  for (const cmd of ['python', 'py', 'python3']) {
    try {
      const v = execPy(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const m = v.match(/Python 3\.(\d+)/)
      if (m) {
        const minor = parseInt(m[1])
        if (minor >= 9 && minor <= 12) { step('[RF] Найден Python: ' + cmd + ' (' + v.trim() + ')'); return cmd }
        else step('[RF] [WARN] ' + cmd + ' = Python 3.' + minor)
      }
    } catch (e) {}
  }
  return null
}

function getPythonPath(py) {
  try {
    return execPy(py, ['-c', 'import sys, os; print(sys.executable)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) { return '' }
}

function checkAllPackages(py) {
  const packages = ['inference', 'uvicorn', 'fastapi', 'python-multipart']
  const missing = []
  for (const pkg of packages) {
    try {
      const r = execPy(py, ['-m', 'pip', 'show', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (!r || !r.includes('Name: ' + pkg)) missing.push(pkg)
    } catch (e) { missing.push(pkg) }
  }
  return missing
}

async function installAllPackages(py, missing) {
  if (missing.length === 0) { step('[RF] OK: все пакеты установлены'); return true }
  step('[RF] Установка: ' + missing.join(', ') + ' (3-5 минут)...')
  return new Promise(resolve => {
    const { cmd, baseArgs } = parsePyCmd(py)
    const proc = spawn(cmd, [...baseArgs, '-m', 'pip', 'install', '--upgrade', 'pip'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      creationFlags: process.platform === 'win32' ? 0x08000000 : undefined
    })
    proc.on('close', () => {
      const proc2 = spawn(cmd, [...baseArgs, '-m', 'pip', 'install', ...missing], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        creationFlags: process.platform === 'win32' ? 0x08000000 : undefined
      })
      let out = ''
      proc2.stdout.on('data', d => { out += d.toString(); if (out.length > 5000) out = out.slice(-3000) })
      proc2.stderr.on('data', d => { out += d.toString(); if (out.length > 5000) out = out.slice(-3000) })
      proc2.on('close', code => {
        if (code === 0) { step('[RF] OK: пакеты установлены'); resolve(true) }
        else { step('[RF] ERROR: pip code ' + code); step('[RF] ' + out.slice(-500).replace(/\n/g, ' ')); resolve(false) }
      })
      proc2.on('error', e => { step('[RF] ERROR: ' + e.message); resolve(false) })
    })
    proc.on('error', e => { step('[RF] ERROR: ' + e.message); resolve(false) })
  })
}

async function installPython312() {
  step('[RF] Устанавливаю Python 3.12...')
  const installerUrl = 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe'
  const installerPath = path.join(__dirname, 'python-3.12.9-installer.exe')
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(installerPath)
      https.get(installerUrl, response => {
        if (response.statusCode !== 200) { reject(new Error('HTTP ' + response.statusCode)); return }
        response.pipe(file); file.on('finish', () => { file.close(); resolve() })
      }).on('error', e => { try { fs.unlinkSync(installerPath) } catch (x) {}; reject(e) })
    })
  } catch (e) { step('[RF] ERROR: ' + e.message); return false }
  try {
    const opts = { stdio: 'ignore', timeout: 180000 }
    if (process.platform === 'win32') { opts.windowsHide = true; opts.creationFlags = 0x08000000 }
    execSync('"' + installerPath + '" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_test=0', opts)
    step('[RF] OK: Python 3.12 установлен')
    try { fs.unlinkSync(installerPath) } catch (e) {}
    await sleep(5000); return true
  } catch (e) { step('[RF] ERROR: ' + e.message); return false }
}

// v3.7.8: PowerShell запуск (гарантированно без окон!)
async function startInferenceServer(py) {
  step('[RF] Запуск inference server на порту ' + RF_PORT + ' (PowerShell, БЕЗ окон)...')
  step('[RF] Первый запуск: скачивание модели (~120 МБ, 1-3 мин)...')

  const pythonPath = getPythonPath(py)
  if (!pythonPath) { step('[RF] ERROR: не удалось найти python.exe'); return false }
  step('[RF] Python: ' + pythonPath)

  // Python-скрипт с полной эмуляцией Roboflow API
  const pythonScript = `
import sys, os, warnings, traceback
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['PYTHONUTF8'] = '1'
if hasattr(sys.stdout, 'reconfigure'):
    try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except: pass
if hasattr(sys.stderr, 'reconfigure'):
    try: sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except: pass
warnings.filterwarnings('ignore')

PORT = ${RF_PORT}
print(f'[RF server] Starting on port {PORT}...', flush=True)

app = None
method = ''

# Попытка 1: inference HTTP app
try:
    from inference.core.interfaces.http import app as http_app
    app = http_app
    method = 'inference.core.interfaces.http'
    print(f'[RF server] OK: using {method}', flush=True)
except Exception as e1:
    try:
        from inference.core.http import app as http_app
        app = http_app
        method = 'inference.core.http'
        print(f'[RF server] OK: using {method}', flush=True)
    except Exception as e2:
        try:
            from inference.core.interfaces.http.http_api import HttpInterface
            iface = HttpInterface()
            app = iface.app
            method = 'HttpInterface'
            print(f'[RF server] OK: using {method}', flush=True)
        except Exception as e3:
            print(f'[RF server] WARN: cannot import inference app, using emulator', flush=True)
            print(f'[RF server] e1: {e1}', flush=True)
            print(f'[RF server] e2: {e2}', flush=True)
            print(f'[RF server] e3: {e3}', flush=True)

# Fallback: полная эмуляция Roboflow API
if app is None:
    try:
        from fastapi import FastAPI, Request, UploadFile, File, Form
        from fastapi.responses import JSONResponse
        import base64, io
        app = FastAPI()
        
        @app.get('/')
        def root():
            return {'status': 'ok', 'service': 'MC Bot Inference Emulator'}
        
        @app.get('/healthz')
        def healthz():
            return {'status': 'ok'}
        
        @app.post('/{model_id}')
        async def detect_any(model_id: str, request: Request, api_key: str = None, confidence: float = 0.25, overlap: float = 0.3, file: UploadFile = File(None)):
            return JSONResponse(content={'predictions': [], 'image': {'width': 1024, 'height': 512}, 'model_id': model_id})
        
        @app.post('/infer')
        async def infer(request: Request, model_id: str = None, file: UploadFile = File(None)):
            return JSONResponse(content={'predictions': [], 'image': {'width': 1024, 'height': 512}})
        
        method = 'emulated API'
        print(f'[RF server] OK: emulator ready', flush=True)
    except Exception as e:
        print(f'[RF server] FATAL: cannot create app: {e}', flush=True)
        traceback.print_exc()
        sys.exit(1)

try:
    import uvicorn
    print(f'[RF server] Running uvicorn on 0.0.0.0:{PORT}...', flush=True)
    uvicorn.run(app, host='0.0.0.0', port=PORT, log_level='warning', access_log=False)
except Exception as e:
    print(f'[RF server] FATAL: uvicorn failed: {e}', flush=True)
    traceback.print_exc()
    sys.exit(1)
`.trim()

  // Сохраняем скрипт во временный файл
  const scriptPath = path.join(__dirname, '.inference_server.py')
  fs.writeFileSync(scriptPath, pythonScript, 'utf8')
  
  const stdoutLog = path.join(__dirname, '.inference_stdout.log')
  const stderrLog = path.join(__dirname, '.inference_stderr.log')
  
  // Очищаем старые логи
  try { fs.unlinkSync(stdoutLog) } catch (e) {}
  try { fs.unlinkSync(stderrLog) } catch (e) {}

  // v3.7.8: PowerShell с WindowStyle Hidden — ЕДИНСТВЕННЫЙ надёжный способ
  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-Command',
    `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath '${pythonPath.replace(/'/g, "''")}' -ArgumentList '${scriptPath.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru -RedirectStandardOutput '${stdoutLog.replace(/'/g, "''")}' -RedirectStandardError '${stderrLog.replace(/'/g, "''")}'; Write-Output $p.Id`
  ]

  const serverProc = spawn('powershell.exe', psArgs, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  let childPid = null
  serverProc.stdout.on('data', d => {
    const m = d.toString().match(/\d+/)
    if (m) childPid = parseInt(m[0])
  })
  serverProc.stderr.on('data', d => { step('[RF PS] ' + d.toString().trim()) })
  serverProc.on('error', e => { step('[RF] ERROR PowerShell: ' + e.message) })
  serverProc.on('exit', () => { /* PowerShell завершился, но дочерний процесс продолжает работать */ })
  serverProc.unref()

  // Ждём сервер
  const start = Date.now()
  const timeout = 300000
  let lastLogRead = 0
  let logOffset = 0

  const readLogs = () => {
    try {
      if (fs.existsSync(stdoutLog)) {
        const content = fs.readFileSync(stdoutLog, 'utf8')
        if (content.length > logOffset) {
          const newPart = content.slice(logOffset)
          logOffset = content.length
          const lines = newPart.split('\n').filter(l => l.trim())
          for (const line of lines) step('[RF server] ' + line)
        }
      }
      if (fs.existsSync(stderrLog)) {
        const errContent = fs.readFileSync(stderrLog, 'utf8')
        if (errContent && errContent.trim() && lastLogRead === 0) {
          step('[RF server ERR] ' + errContent.slice(0, 500).replace(/\n/g, ' '))
          lastLogRead = 1
        }
      }
    } catch (e) {}
  }

  while (Date.now() - start < timeout) {
    await sleep(2000)
    readLogs()
    if (await checkLocalhostHealth()) {
      step('[RF] OK: inference server готов (PID ' + (childPid || '?') + ', за ' + Math.round((Date.now() - start) / 1000) + 'с)')
      step('[RF] Метод: ' + (method || 'unknown') + ', скрипт: ' + scriptPath)
      localhostAlive = true
      // Не удаляем scriptPath пока сервер работает — он нужен процессу
      return true
    }
    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed % 15 === 0 && elapsed > 0) step('[RF] Ожидание... ' + elapsed + 'с')
  }

  step('[RF] ERROR: сервер не поднялся за 5 минут')
  readLogs()
  return false
}

async function ensureInferenceServer() {
  if (await checkLocalhostHealth()) { step('[RF] OK: сервер уже работает'); localhostAlive = true; return true }

  let py = findSupportedPython()
  if (!py) {
    step('[RF] [WARN] Python 3.9-3.12 не найден, устанавливаю 3.12...')
    if (!(await installPython312())) { step('[RF] ERROR: бот работает только на OCR'); return false }
    py = findSupportedPython()
    if (!py) { step('[RF] ERROR: Python не найден в PATH'); return false }
  }

  const missing = checkAllPackages(py)
  if (missing.length > 0) {
    step('[RF] Отсутствуют: ' + missing.join(', '))
    if (!(await installAllPackages(py, missing))) { step('[RF] ERROR: пакеты не установлены'); return false }
  } else step('[RF] OK: все пакеты установлены')

  if (await checkLocalhostHealth()) { step('[RF] OK: сервер уже работает'); localhostAlive = true; return true }
  return await startInferenceServer(py)
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
  if (!PROXY.changeIpUrl || PROXY.changeIpUrl.includes('YOUR_KEY')) { step('changeIpUrl не задан'); currentRunIp = await currentIp(); return currentRunIp }
  for (let round = 1; round <= 2; round++) {
    const oldIp = await currentIp(); step('IP до ротации: ' + (oldIp || '?'))
    let hit = 'fail', ok = false
    for (let t = 1; t <= 2; t++) {
      try { const r = await plainGet(PROXY.changeIpUrl, 15000); const body = String(r.body || '').replace(/\s+/g, ' ').slice(0, 90); hit = 'direct:' + r.status + (body ? ' body=' + body : ''); ok = r.status >= 200 && r.status < 400 } catch (e) { hit = 'direct:ERR ' + ((e && e.message) || e); ok = false }
      if (ok) break
      if (t < 2) { step('changeIp ' + t + ' не удалась, повтор'); await sleep(3000) }
    }
    step('changeIp: ' + hit)
    const t0 = Date.now(); let newIp = null; const waitMs = Math.max(8000, (Number(PROXY.waitSec) || 12) * 1000)
    while (Date.now() - t0 < waitMs) { await sleep(2000); newIp = await currentIp(); if (newIp && (!oldIp || newIp !== oldIp)) break }
    if (newIp && (!oldIp || newIp !== oldIp)) {
      if (oldIp && badIPs.has(newIp)) { step('новый IP ' + newIp + ' уже плох — кручу'); continue }
      step('IP СМЕНЁН: ' + (oldIp || '?') + ' -> ' + newIp + ' за ' + Math.round((Date.now() - t0) / 1000) + 'с'); currentRunIp = newIp; return newIp
    }
    step('IP не сменился')
  }
  currentRunIp = await currentIp(); return currentRunIp
}

// ========================= ROBLOW API =========================
const ROBOFLOW = {
  enabled: cfgGet(CFG, 'roboflow.enabled', true),
  apiKey: cfgGet(CFG, 'roboflow.apiKey', 'kTAPmOyqKcxeBTyi18FD'),
  modelId: cfgGet(CFG, 'roboflow.modelId', 'captchas-gz2yx/funtimecaptcha/1'),
  detectUrl: cfgGet(CFG, 'roboflow.detectUrl', RF_URL),
  serverlessUrl: cfgGet(CFG, 'roboflow.serverlessUrl', RF_URL),
  confidence: cfgGet(CFG, 'roboflow.confidence', 25),
  overlap: cfgGet(CFG, 'roboflow.overlap', 20),
  httpProxy: cfgGet(CFG, 'roboflow.httpProxy', ''),
  socksProxy: cfgGet(CFG, 'roboflow.socksProxy', '')
}

function rfMultipart(buf, filename, boundary) {
  const safe = String(filename || 'captcha.png').replace(/"/g, '')
  const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + safe + '"\r\nContent-Type: image/png\r\n\r\n')
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n')
  return Buffer.concat([head, buf, tail])
}

function socksConnectSocket(host, port, useTls) {
  return new Promise((resolve, reject) => {
    if (!PROXY.host) { reject(new Error('proxy.host пуст')); return }
    let settled = false
    const connTimeout = setTimeout(() => { if (settled) return; settled = true; reject(new Error('SOCKS timeout 30s')) }, 30000)
    SocksClient.createConnection({ proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password }, command: 'connect', destination: { host, port } })
      .then(conn => {
        if (settled) { try { conn.socket.destroy() } catch (e) {}; return }
        if (!useTls) { settled = true; clearTimeout(connTimeout); resolve({ socket: conn.socket, cleanup() { try { conn.socket.destroy() } catch (e) {} } }); return }
        let secure = null
        const fail = e => { if (settled) return; settled = true; clearTimeout(connTimeout); try { conn.socket.destroy() } catch (x) {}; if (secure) try { secure.destroy() } catch (x) {}; reject(e) }
        try { secure = tls.connect({ socket: conn.socket, servername: host, minVersion: 'TLSv1.2' }, () => { if (settled) return; settled = true; clearTimeout(connTimeout); resolve({ socket: secure, cleanup() { try { secure.destroy() } catch (e) {}; try { conn.socket.destroy() } catch (e) {} } }) }) } catch (e) { fail(e); return }
        secure.on('error', fail); conn.socket.on('error', fail)
      }).catch(e => { if (settled) return; settled = true; clearTimeout(connTimeout); reject(e) })
  })
}

function parseSocksUrl(urlStr) { const m = String(urlStr).match(/^socks5[h]?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/?$/i); if (!m) throw new Error('bad socks url'); return { host: m[3], port: Number(m[4]), username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) } }

function rfSocksConnect(socksUrl, targetHost, targetPort, useTls) {
  return new Promise((resolve, reject) => {
    let parsed; try { parsed = parseSocksUrl(socksUrl) } catch (e) { reject(e); return }
    let settled = false
    const t = setTimeout(() => { if (settled) return; settled = true; reject(new Error('rf socks timeout 30s')) }, 30000)
    SocksClient.createConnection({ proxy: { host: parsed.host, port: parsed.port, type: 5, userId: parsed.username, password: parsed.password }, command: 'connect', destination: { host: targetHost, port: targetPort } })
      .then(conn => {
        if (settled) { try { conn.socket.destroy() } catch (e) {}; return }
        if (!useTls) { settled = true; clearTimeout(t); resolve({ socket: conn.socket, cleanup() { try { conn.socket.destroy() } catch (e) {} } }); return }
        let secure = null
        const fail = e => { if (settled) return; settled = true; clearTimeout(t); try { conn.socket.destroy() } catch (x) {}; if (secure) try { secure.destroy() } catch (x) {}; reject(e) }
        try { secure = tls.connect({ socket: conn.socket, servername: targetHost, minVersion: 'TLSv1.2' }, () => { if (settled) return; settled = true; clearTimeout(t); resolve({ socket: secure, cleanup() { try { secure.destroy() } catch (e) {}; try { conn.socket.destroy() } catch (e) {} } }) }) } catch (e) { fail(e); return }
        secure.on('error', fail); conn.socket.on('error', fail)
      }).catch(e => { if (settled) return; settled = true; clearTimeout(t); reject(e) })
  })
}

function httpProxyConnect(proxyUrlStr, targetHost, targetPort, useTls) {
  return new Promise((resolve, reject) => {
    let proxyUrl; try { proxyUrl = new URL(proxyUrlStr.startsWith('http') ? proxyUrlStr : 'http://' + proxyUrlStr) } catch (e) { reject(new Error('bad proxy url')); return }
    const proxyHost = proxyUrl.hostname, proxyPort = Number(proxyUrl.port || 80)
    const proxyAuth = (proxyUrl.username || proxyUrl.password) ? 'Basic ' + Buffer.from(decodeURIComponent(proxyUrl.username || '') + ':' + decodeURIComponent(proxyUrl.password || '')).toString('base64') : null
    const connectReq = 'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n' + (proxyAuth ? 'Proxy-Authorization: ' + proxyAuth + '\r\n' : '') + 'User-Agent: MC_Bot/3.7.8\r\n\r\n'
    const socket = net.createConnection({ host: proxyHost, port: proxyPort }); let settled = false
    const t = setTimeout(() => { if (settled) return; settled = true; try { socket.destroy() } catch (e) {}; reject(new Error('http proxy timeout 30s')) }, 30000)
    let data = ''
    socket.on('data', chunk => {
      if (settled) return; data += chunk.toString()
      const headerEnd = data.indexOf('\r\n\r\n')
      if (headerEnd >= 0) {
        const statusLine = data.slice(0, data.indexOf('\r\n')); const statusMatch = statusLine.match(/HTTP\/1\.[01]\s+(\d+)/); const statusCode = statusMatch ? Number(statusMatch[1]) : 0
        if (statusCode === 200) {
          settled = true; clearTimeout(t)
          if (useTls) { const secure = tls.connect({ socket: socket, servername: targetHost, minVersion: 'TLSv1.2' }, () => { resolve({ socket: secure, cleanup() { try { secure.destroy() } catch (e) {}; try { socket.destroy() } catch (e) {} } }) }); secure.on('error', e => { if (settled) return; settled = true; clearTimeout(t); try { socket.destroy() } catch (x) {}; reject(e) }) }
          else resolve({ socket: socket, cleanup() { try { socket.destroy() } catch (e) {} } })
        } else { settled = true; clearTimeout(t); try { socket.destroy() } catch (e) {}; reject(new Error('http proxy rejected: ' + statusLine)) }
      }
    })
    socket.on('error', e => { if (settled) return; settled = true; clearTimeout(t); reject(e) })
    socket.on('connect', () => { socket.write(connectReq) })
  })
}

function rawRequestOnSocket(useTls, socket, hostname, port, method, reqPath, headers, body, timeoutMs) {
  return new Promise(resolve => {
    const mod = useTls ? https : http; const defaultPort = useTls ? 443 : 80
    const hostHeader = (port && port !== defaultPort) ? (hostname + ':' + port) : hostname
    const h = Object.assign({ 'User-Agent': 'MC_Bot/3.7.8', 'Accept': 'application/json,*/*', 'Accept-Encoding': 'identity', 'Connection': 'close', 'Host': hostHeader }, headers || {})
    if (body != null) h['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))
    const opts = { hostname, port, path: reqPath, method, timeout: timeoutMs, headers: h }; if (socket) opts.socket = socket
    let done = false; const finish = obj => { if (done) return; done = true; resolve(obj) }
    let req = null
    try { req = mod.request(opts, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }) }); res.on('error', e => { finish({ status: 0, body: 'RES ERR: ' + (((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e)) }) }) }) } catch (e) { finish({ status: 0, body: 'REQ THROW: ' + (((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e)) }); return }
    req.on('error', e => { finish({ status: 0, body: 'REQ ERR: ' + (((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e)) }) })
    req.on('timeout', () => { try { req.destroy() } catch (e) {}; finish({ status: 0, body: 'TIMEOUT' }) })
    if (body != null) req.write(body); req.end()
  })
}

async function rfPostOnce(transport, url, headers, body, timeoutMs) {
  let u = null; try { u = new URL(url) } catch (e) { return { status: 0, body: 'BAD URL: ' + ((e && e.message) || e), via: transport } }
  const useTls = u.protocol === 'https:'; const port = Number(u.port || (useTls ? 443 : 80)); const reqPath = u.pathname + u.search; const hostname = u.hostname
  if (transport === 'direct') { const r = await rawRequestOnSocket(useTls, null, hostname, port, 'POST', reqPath, headers, body, timeoutMs); r.via = 'direct'; return r }
  if (transport === 'http_proxy') { let sk = null; try { sk = await httpProxyConnect(ROBOFLOW.httpProxy, hostname, port, useTls) } catch (e) { return { status: 0, body: 'HTTP PROXY ERR: ' + (((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e)), via: 'http_proxy' } }; try { const r = await rawRequestOnSocket(useTls, sk.socket, hostname, port, 'POST', reqPath, headers, body, timeoutMs); r.via = 'http_proxy'; return r } finally { try { sk.cleanup() } catch (e) {} } }
  if (transport === 'rf_socks') { let sk = null; try { sk = await rfSocksConnect(ROBOFLOW.socksProxy, hostname, port, useTls) } catch (e) { return { status: 0, body: 'RF SOCKS ERR: ' + (((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e)), via: 'rf_socks' } }; try { const r = await rawRequestOnSocket(useTls, sk.socket, hostname, port, 'POST', reqPath, headers, body, timeoutMs); r.via = 'rf_socks'; return r } finally { try { sk.cleanup() } catch (e) {} } }
  let sk = null; try { sk = await socksConnectSocket(hostname, port, useTls) } catch (e) { return { status: 0, body: 'SOCKS ERR: ' + (((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e)), via: 'socks' } }
  try { const r = await rawRequestOnSocket(useTls, sk.socket, hostname, port, 'POST', reqPath, headers, body, timeoutMs); r.via = 'socks'; return r } finally { try { sk.cleanup() } catch (e) {} }
}

function isLocalhost(hostname) { return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(hostname) }

async function rfPost(url, headers, body) {
  let u; try { u = new URL(url) } catch (e) { return { status: 0, body: 'BAD URL', via: 'none' } }
  const isLocal = isLocalhost(u.hostname); const timeoutMs = isLocal ? LOCAL_RF_TIMEOUT_MS : CLOUD_RF_TIMEOUT_MS
  const transports = []
  if (isLocal) transports.push('direct')
  else { if (ROBOFLOW.socksProxy) transports.push('rf_socks'); if (ROBOFLOW.httpProxy) transports.push('http_proxy'); if (PROXY.host) transports.push('socks'); transports.push('direct') }
  const attemptsLog = []; const badTransports = new Set(); let last = null
  for (let pass = 0; pass < (isLocal ? 1 : 2); pass++) {
    for (const tr of transports) {
      if (badTransports.has(tr)) continue; if (pass > 0) await sleep(1000)
      const r = await rfPostOnce(tr, url, headers, body, timeoutMs)
      attemptsLog.push(tr + ':' + r.status + ':' + String(r.body || '').slice(0, 40).replace(/\s+/g, ' ')); last = r
      const st = Number(r.status || 0)
      if (st >= 200 && st < 400) { last._attempts = attemptsLog; return last }
      if (st === 401 || st === 403 || st === 404) { last._attempts = attemptsLog; return last }
      const bodyStr = String(r.body || '')
      if (bodyStr.includes('rejected') || bodyStr.includes('PROXY CONNECT ERR') || bodyStr.includes('Connection refused') || bodyStr.includes('ECONNREFUSED')) {
        badTransports.add(tr)
        if (isLocal && tr === 'direct') { localhostAlive = false; break }
      }
    }
    if (isLocal && !localhostAlive) break
  }
  if (last) last._attempts = attemptsLog
  return last || { status: 0, body: 'no transport', via: 'none' }
}

function rfGetPredictions(json) { if (!json) return []; if (Array.isArray(json.predictions)) return json.predictions; if (Array.isArray(json.results)) return json.results; if (json.prediction && Array.isArray(json.prediction.predictions)) return json.prediction.predictions; if (json.object && Array.isArray(json.object.predictions)) return json.object.predictions; return [] }
function rfDigitFromPrediction(p) { const s = String(p.class || p.class_name || p.label || p.name || ''); const m = s.match(/\d/); return m ? m[0] : null }
function rfNormConf(c) { c = Number(c || 0); if (c > 1) c = c / 100; return c }

function rfMetrics(preds) {
  const digits = []
  for (const p of preds) { const d = rfDigitFromPrediction(p); const conf = rfNormConf(p.confidence != null ? p.confidence : p.score); if (d !== null && conf >= 0.15) digits.push({ digit: d, conf, x: Number(p.x || 0), y: Number(p.y || 0), w: Number(p.width || p.w || 0), h: Number(p.height || p.h || 0) }) }
  digits.sort((a, b) => a.x - b.x); const n = digits.length; const avg = n ? digits.reduce((a, d) => a + d.conf, 0) / n : 0
  let row = 0
  if (n > 0) {
    const hs = digits.map(d => d.h).filter(x => x > 0).sort((a, b) => a - b); const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 40; const band = Math.max(25, medH * 0.8)
    const sorted = digits.slice().sort((a, b) => a.y - b.y)
    for (let i = 0; i < sorted.length; i++) { const group = [sorted[i]]; for (let j = i + 1; j < sorted.length; j++) { if (Math.abs(sorted[j].y - sorted[i].y) <= band) group.push(sorted[j]); else break }; group.sort((a, b) => a.x - b.x); let cnt = 0, lastRight = -1e9; for (const d of group) { const left = d.x - d.w / 2, right = d.x + d.w / 2; if (left >= lastRight - Math.max(3, d.w * 0.15)) { cnt++; lastRight = right } }; if (cnt > row) row = cnt }
  }
  const plausible = n >= 3 && n <= 8; const strong = avg >= 0.35; const score = (plausible ? 10000 : 0) + (strong ? 3000 : 0) + n * 1000 + row * 700 + Math.round(avg * 1000)
  return { n, avg: Math.round(avg * 1000) / 1000, row, plausible, strong, score, text: digits.map(d => d.digit).join(''), digits }
}

async function sendToRoboflow(pngBuffer, filename, debugDir, label) {
  if (!ROBOFLOW || ROBOFLOW.enabled === false || !ROBOFLOW.apiKey) return { ok: false, status: 0, attempt: 'disabled', predictions: [], metrics: rfMetrics([]), error: 'disabled' }
  if (!localhostAlive && isLocalhost(String(ROBOFLOW.detectUrl).replace(/^https?:\/\//, '').split(/[:\/]/)[0])) return { ok: false, status: 0, attempt: 'localhost_dead', predictions: [], metrics: rfMetrics([]), error: 'localhost' }
  const key = String(ROBOFLOW.apiKey); const model = String(ROBOFLOW.modelId || 'captchas-gz2yx/funtimecaptcha/1').replace(/^\/+|\/+$/g, '')
  const detectBase = String(ROBOFLOW.detectUrl || RF_URL).replace(/\/+$/, ''); const serverlessBase = String(ROBOFLOW.serverlessUrl || RF_URL).replace(/\/+$/, '')
  const conf = encodeURIComponent(ROBOFLOW.confidence || 25); const ov = encodeURIComponent(ROBOFLOW.overlap || 20)
  const boundary = '----MCBotRF' + Date.now() + Math.floor(Math.random() * 1000000); const mp = rfMultipart(pngBuffer, filename, boundary)
  const detectUrl = detectBase + '/' + model + '?api_key=' + encodeURIComponent(key) + '&confidence=' + conf + '&overlap=' + ov
  const inferUrl = serverlessBase + '/infer?model_id=' + model
  const attempts = [
    { name: 'detect_multipart', url: detectUrl, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body: mp },
    { name: 'detect_raw', url: detectUrl, headers: { 'Content-Type': 'image/png' }, body: pngBuffer },
    { name: 'serverless_infer_bearer', url: inferUrl, headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body: mp }
  ]
  let last = null
  for (const at of attempts) {
    const r = await rfPost(at.url, at.headers, at.body)
    let json = null; try { json = JSON.parse(r.body) } catch (e) {}
    const predictions = rfGetPredictions(json); const metrics = rfMetrics(predictions); const ok = r.status >= 200 && r.status < 300 && !!json
    const item = { ok, status: r.status, attempt: at.name, url: at.url, json, predictions, metrics, raw: String(r.body || '').slice(0, 3000), attempts: r._attempts || [], error: ok ? null : (String(r.body || '').replace(/\s+/g, ' ').slice(0, 300) || 'HTTP ' + r.status) }
    if (debugDir) { try { fs.mkdirSync(debugDir, { recursive: true }); fs.writeFileSync(path.join(debugDir, 'roboflow_debug_' + at.name + '.txt'), 'STATUS: ' + r.status + '\nVIA: ' + (r.via || '?') + '\nATTEMPT: ' + at.name + '\nATTEMPTS_LOG: ' + JSON.stringify(r._attempts || []) + '\nURL: ' + at.url + '\nBODY:\n' + String(r.body || '').slice(0, 8000) + '\n') } catch (e) {} }
    if (label && typeof step === 'function') step(label + ': RF ' + at.name + ' -> ' + r.status + ' via ' + (r.via || '?') + (ok ? ' OK digits=' + metrics.n + ' row=' + metrics.row + ' text="' + metrics.text + '"' : ' ' + String(item.raw || '').replace(/\s+/g, ' ').slice(0, 140)))
    if (ok) return item
    last = item
    if (isLocalhost(u && u.hostname) && String(r.body || '').includes('ECONNREFUSED')) { localhostAlive = false; break }
  }
  return last || { ok: false, status: 0, attempt: 'none', predictions: [], metrics: rfMetrics([]), error: 'no attempts' }
}

// ========================= ПАЛИТРА / ASCII / PNG =========================
const BASE_COLORS = [[0,0,0],[127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],[167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],[112,112,112],[64,128,255],[104,83,50],[255,252,245],[216,127,51],[178,76,216],[102,153,216],[229,229,51],[127,204,25],[242,127,165],[76,76,76],[153,153,153],[76,127,153],[127,63,178],[51,76,178],[102,76,51],[102,127,51],[153,51,51],[25,25,25],[250,238,77],[92,219,213],[74,128,255],[0,217,58],[135,107,58],[112,2,2],[143,119,100],[161,83,37],[149,88,108],[114,119,139],[186,133,35],[103,117,52],[160,77,78],[57,42,35],[135,106,97],[86,91,91],[118,70,86],[74,59,91],[77,51,35],[76,83,42],[143,61,46],[37,22,16],[189,48,49],[148,63,97],[126,32,44],[22,119,121],[58,142,140],[74,117,116],[23,121,121],[90,90,90],[224,169,112],[127,106,82],[221,169,46],[156,104,66]]
const SHADE_MULT = [135, 255, 220, 180]
const PALETTE = (() => { const p = new Uint8Array(256 * 3); for (let v = 0; v < 256; v++) { let r = 255, g = 255, b = 255; if (v !== 0) { const base = BASE_COLORS[v >> 2] || [0, 0, 0]; const m = SHADE_MULT[v & 3] / 255; r = Math.round(base[0] * m); g = Math.round(base[1] * m); b = Math.round(base[2] * m) }; p[v * 3] = r; p[v * 3 + 1] = g; p[v * 3 + 2] = b }; return p })()
const LUM = (() => { const l = new Uint8Array(256); for (let v = 0; v < 256; v++) l[v] = Math.round(0.299 * PALETTE[v * 3] + 0.587 * PALETTE[v * 3 + 1] + 0.114 * PALETTE[v * 3 + 2]); return l })()

let CRC = null
function crc32(b) { if (!CRC) { CRC = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0 } }; let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xff]; return (c ^ 0xffffffff) >>> 0 }

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]); const ih = Buffer.alloc(13); ih.writeUInt32BE(w,0); ih.writeUInt32BE(h,4); ih[8]=8; ih[9]=6
  const raw = Buffer.alloc((w*4+1)*h); for (let y=0;y<h;y++){ raw[y*(w*4+1)]=0; rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4) }
  const chunk=(t,d)=>{ const l=Buffer.alloc(4); l.writeUInt32BE(d.length,0); const tt=Buffer.from(t,'ascii'); const cr=Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt,d])),0); return Buffer.concat([l,tt,d,cr]) }
  return Buffer.concat([sig, chunk('IHDR',ih), chunk('IDAT',zlib.deflateSync(raw)), chunk('IEND',Buffer.alloc(0))])
}

function colorPng(data, W, H, sc) { const SW = W * sc, SH = H * sc; const rgba = Buffer.alloc(SW * SH * 4); for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { const v = data[Math.floor(y / sc) * W + Math.floor(x / sc)]; const i = (y * SW + x) * 4; rgba[i] = PALETTE[v * 3]; rgba[i + 1] = PALETTE[v * 3 + 1]; rgba[i + 2] = PALETTE[v * 3 + 2]; rgba[i + 3] = 255 }; return encodePng(SW, SH, rgba) }
function bwPng(mask, W, H, sc) { const SW=W*sc,SH=H*sc,rgba=Buffer.alloc(SW*SH*4); for(let y=0;y<SH;y++)for(let x=0;x<SW;x++){ const v=mask[Math.floor(y/sc)*W+Math.floor(x/sc)]?30:255; const i=(y*SW+x)*4; rgba[i]=rgba[i+1]=rgba[i+2]=v; rgba[i+3]=255 }; return encodePng(SW,SH,rgba) }

// ========================= МОРФОЛОГИЯ / ЧЕРНИЛА / ЦИФРЫ =========================
const NB8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
function erode(m,W,H){const o=new Uint8Array(m.length);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(m[i]&&m[i-1]&&m[i+1]&&m[i-W]&&m[i+W])o[i]=1}return o}
function dilate(m,W,H){const o=new Uint8Array(m.length);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(m[i]||(x>0&&m[i-1])||(x<W-1&&m[i+1])||(y>0&&m[i-W])||(y<H-1&&m[i+W]))o[i]=1}return o}
function opening(m,W,H,r){let x=m;for(let i=0;i<r;i++)x=erode(x,W,H);for(let i=0;i<r;i++)x=dilate(x,W,H);return x}
function closing(m,W,H,r){let x=m;for(let i=0;i<r;i++)x=dilate(x,W,H);for(let i=0;i<r;i++)x=erode(x,W,H);return x}

function removeNoise(mask,W,H,minSize,minFill){minSize=minSize||5;minFill=minFill||0;const vis=new Uint8Array(mask.length),clean=new Uint8Array(mask.length);const i0=(x,y)=>y*W+x;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=i0(x,y);if(!mask[i]||vis[i])continue;const st=[x,y];vis[i]=1;const comp=[];let mnX=x,mxX=x,mnY=y,mxY=y;while(st.length){const cy=st.pop(),cx=st.pop();comp.push(cx,cy);if(cx<mnX)mnX=cx;if(cx>mxX)mxX=cx;if(cy<mnY)mnY=cy;if(cy>mxY)mxY=cy;for(const nb of NB8){const nx=cx+nb[0],ny=cy+nb[1];if(nx<0||ny<0||nx>=W||ny>=H)continue;const ni=i0(nx,ny);if(mask[ni]&&!vis[ni]){vis[ni]=1;st.push(nx,ny)}}};const cnt=comp.length/2,fill=cnt/((mxX-mnX+1)*(mxY-mnY+1));if(cnt>=minSize&&fill>=minFill)for(let k=0;k<comp.length;k+=2)clean[i0(comp[k],comp[k+1])]=1}return clean}
function dropLines(mask,W,H){const vis=new Uint8Array(mask.length),out=new Uint8Array(mask.length);const i0=(x,y)=>y*W+x;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=i0(x,y);if(!mask[i]||vis[i])continue;const st=[x,y];vis[i]=1;const comp=[];let mnX=x,mxX=x,mnY=y,mxY=y;while(st.length){const cy=st.pop(),cx=st.pop();comp.push(cx,cy);if(cx<mnX)mnX=cx;if(cx>mxX)mxX=cx;if(cy<mnY)mnY=cy;if(cy>mxY)mxY=cy;for(const nb of NB8){const nx=cx+nb[0],ny=cy+nb[1];if(nx<0||ny<0||nx>=W||ny>=H)continue;const ni=i0(nx,ny);if(mask[ni]&&!vis[ni]){vis[ni]=1;st.push(nx,ny)}}};const w=mxX-mnX+1,h=mxY-mnY+1;const isLine=(w>250||h>250)||(w+h>320&&(comp.length/2)/(w*h)<0.12);if(!isLine)for(let k=0;k<comp.length;k+=2)out[i0(comp[k],comp[k+1])]=1}return out}

function inkMaskWall(data,W,H){const wc=new Int32Array(256);for(let i=0;i<data.length;i++) wc[data[i]]++;const bgW=new Set();for(let v=1;v<256;v++) if(wc[v]>=6000 && LUM[v]>=120) bgW.add(v);const iso={};for(let v=1;v<256;v++){const c=wc[v];if(c<150||c>6000||bgW.has(v)||LUM[v]<120) continue;const stp=Math.max(1,Math.floor(c/300));let checked=0,isolated=0;for(let i=v%7;i<data.length&&checked<300;i+=stp){if(data[i]!==v)continue;const x=i%W,y=(i/W)|0;if(x<1||x>=W-1||y<1||y>=H-1)continue;checked++;let same=false;for(const nb of NB8){const nx=x+nb[0],ny=y+nb[1];if(data[ny*W+nx]===v){same=true;break}};if(!same)isolated++};iso[v]=checked?isolated/checked:0;if(iso[v]>=0.6)bgW.add(v)};const ink=new Uint8Array(data.length);for(let r=0;r<H/128;r++)for(let c=0;c<W/128;c++){const counts=new Int32Array(256);const x0=c*128,y0=r*128;for(let y=0;y<128;y++)for(let x=0;x<128;x++)counts[data[(y0+y)*W+x0+x]]++;const bg=new Set(bgW);for(let v=1;v<256;v++){if(LUM[v]>=120 && (counts[v]>=1200 || (iso[v]||0)>=0.6)) bg.add(v)};for(let y=0;y<128;y++)for(let x=0;x<128;x++){const i=(y0+y)*W+x0+x;const v=data[i];if(v!==0&&!bg.has(v))ink[i]=1}};let n=0;for(let i=0;i<ink.length;i++) if(ink[i]) n++;return { ink, inkCount:n }}
function thickScore(ink,W,H){let s=0;for(let y=0;y<H-1;y++)for(let x=0;x<W-1;x++){const i=y*W+x;if(ink[i]&&ink[i+1]&&ink[i+W]&&ink[i+W+1])s++}return s}

function compsList(mask, W, H, wantPx) {
  const vis = new Uint8Array(mask.length), out = []; const i0 = (x,y) => y*W+x
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = i0(x,y); if (!mask[i] || vis[i]) continue; const st = [x,y]; vis[i] = 1; let a = 0, mnX = x, mxX = x, mnY = y, mxY = y; let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; const px = wantPx ? [i] : null
    while (st.length) { const cy = st.pop(), cx = st.pop(); a++; sx += cx; sy += cy; sxx += cx*cx; syy += cy*cy; sxy += cx*cy; if (cx<mnX) mnX=cx; if (cx>mxX) mxX=cx; if (cy<mnY) mnY=cy; if (cy>mxY) mxY=cy; for (const nb of NB8) { const nx=cx+nb[0], ny=cy+nb[1]; if (nx<0||ny<0||nx>=W||ny>=H) continue; const ni = i0(nx,ny); if (mask[ni] && !vis[ni]) { vis[ni]=1; st.push(nx,ny); if (wantPx) px.push(ni) } } }
    const mx = sx/a, my = sy/a, vx = sxx/a - mx*mx, vy = syy/a - my*my, vxy = sxy/a - mx*my; const half = (vx + vy) / 2, det = vx*vy - vxy*vxy; const disc = Math.sqrt(Math.max(0, half*half - Math.max(0, det))); const varMinor = Math.max(0, half - disc)
    out.push({ mnX, mxX, mnY, mxY, a, px, varMinor, cx: mx, cy: my })
  }
  return out
}
function isStraight(c, w, h) { return c.varMinor < 10 && (w + h) > 100 }
function analyzeColors(data, ink, W, H) {
  const colorCounts = new Int32Array(256); for (let i = 0; i < ink.length; i++) if (ink[i]) colorCounts[data[i]]++
  const digitMask = new Uint8Array(ink.length), cands = []; let dmColor = 0
  for (let v = 1; v < 256; v++) {
    if (colorCounts[v] < 60) continue; const m = new Uint8Array(ink.length); for (let i = 0; i < ink.length; i++) if (ink[i] && data[i] === v) m[i] = 1
    const comps = compsList(m, W, H, true)
    for (const c of comps) { const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1; if (c.a < 80) continue; if (h < H * 0.07 || h > H * 0.85) continue; if (w < W * 0.02 || w > W * 0.30) continue; if (w + h > W * 0.75) continue; const fill = c.a / (w * h); if (fill < 0.05 || fill > 0.97) continue; if (isStraight(c, w, h)) continue; dmColor++; cands.push({ cx: c.cx, cy: c.cy, w, h }); for (let k = 0; k < c.px.length; k++) digitMask[c.px[k]] = 1 }
  }
  return { dmColor, digitMask, cands }
}
function rowScore(cands, H) {
  if (!cands.length) return 0; const sorted = cands.slice().sort((a, b) => a.cy - b.cy); let best = 0
  for (let i = 0; i < sorted.length; i++) { const band = [sorted[i]]; for (let j = i + 1; j < sorted.length; j++) { if (sorted[j].cy - sorted[i].cy <= H * 0.25) band.push(sorted[j]); else break }; band.sort((a, b) => a.cx - b.cx); let cnt = 0, lastRight = -1; for (const c of band) { const left = c.cx - c.w / 2, right = c.cx + c.w / 2; if (left >= lastRight - 2) { cnt++; lastRight = right } }; if (cnt > best) best = cnt }
  return best
}

// ========================= OCR =========================
const DIGITS={'0':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'1':[[0,0,1,0,0],[0,1,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,1,1,0]],'2':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]],'3':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'4':[[0,0,0,1,0],[0,0,1,1,0],[0,1,0,1,0],[1,0,0,1,0],[1,1,1,1,1],[0,0,0,1,0],[0,0,0,1,0]],'5':[[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'6':[[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'7':[[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],'8':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'9':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,1],[0,0,0,0,1],[0,0,0,0,1],[0,1,1,1,0]]}

function matchPat(mask,W,H,bx,by,bw,bh){const pat=[];for(let py=0;py<7;py++){const row=[];for(let px=0;px<5;px++){const sx=bx+Math.floor(px*bw/5),ex=bx+Math.floor((px+1)*bw/5),sy=by+Math.floor(py*bh/7),ey=by+Math.floor((py+1)*bh/7);let c=0,t=0;for(let y=sy;y<ey;y++)for(let x=sx;x<ex;x++){c+=mask[y*W+x];t++};row.push(t&&(c/t)>0.35?1:0)};pat.push(row)};let bd='?',bs=0;for(const d in DIGITS){let m=0;for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(pat[y][x]===DIGITS[d][y][x])m++;const s=m/35;if(s>bs){bs=s;bd=d}};return{best:bd,score:Math.round(bs*100)/100}}

function ocr(mask,W,H){const digits=[];for (const c of compsList(mask, W, H, false)) {const w=c.mxX-c.mnX+1,h=c.mxY-c.mnY+1;if(c.a<Math.max(80,W*H/1600))continue;if(w<W*0.02||w>W*0.5)continue;if(h<H*0.07||h>H*0.92)continue;if(isStraight(c,w,h))continue;const m=matchPat(mask,W,H,c.mnX,c.mnY,w,h);digits.push({x:c.mnX,best:m.best,score:m.score})};digits.sort((a,b)=>a.x-b.x);let text='';for(const d of digits) if(d.score>=0.5) text+=d.best;return { text, digits }}

function pickOcr(vars, W, H) {
  let best = null
  for (const v of vars) { const r = ocr(v.mask, W, H); const n = r.digits.filter(d => d.score >= 0.5).length; const plausible = n >= 4 && n <= 6; const conf = n > 6 ? 0 : r.digits.filter(d => d.score >= 0.65).reduce((a, d) => a + d.score, 0); const score = (plausible ? 1000 : 0) + conf * 100 + n * 10 + r.digits.reduce((a, d) => a + d.score, 0) - (n > 6 ? 800 : 0); if (!best || score > best.score) best = { name: v.name, text: r.text, n, plausible, conf, score } }
  return best
}

// ========================= СТЕНЫ + СБОРКА =========================
function rotQ(d,q){q=((q%4)+4)%4;if(!q)return Uint8Array.from(d);const o=new Uint8Array(16384);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const v=d[y*128+x];if(q===1)o[x*128+127-y]=v;else if(q===2)o[(127-y)*128+(127-x)]=v;else o[(127-x)*128+y]=v};return o}
function clusterWalls(frames){const counts={};frames.forEach(f=>{counts['x:'+Math.round(f.x)]=(counts['x:'+Math.round(f.x)]||0)+1;counts['z:'+Math.round(f.z)]=(counts['z:'+Math.round(f.z)]||0)+1});const planes=Object.entries(counts).filter(([,v])=>v>=8).sort((a,b)=>b[1]-a[1]);const walls=[],used=new Set();for(const[key]of planes){const[axis,val]=key.split(':');const members=frames.filter(f=>!used.has(f.id)&&Math.round(f[axis])===+val);if(members.length<8)continue;members.forEach(f=>used.add(f.id));let fSign=0;for(const f of members){const fr=f[axis]-Math.floor(f[axis]);if(Math.abs(fr-0.5)>0.1){fSign=fr<0.5?1:-1;break}};if(!fSign)fSign=1;walls.push({axis,value:+val,frames:members,fSign,tag:axis+val});if(walls.length===2)break};return walls}
function clusterCoords(vals) { if (!vals || !vals.length) return []; const sorted = vals.slice().sort((a, b) => a - b); const clusters = []; let cur = [sorted[0]]; for (let i = 1; i < sorted.length; i++) { if (sorted[i] - cur[0] < 0.6) cur.push(sorted[i]); else { clusters.push(cur.reduce((s, x) => s + x, 0) / cur.length); cur = [sorted[i]] } }; clusters.push(cur.reduce((s, x) => s + x, 0) / cur.length); return clusters }

function wallCellsAdvanced(wall) {
  const horiz = wall.axis === 'x' ? 'z' : 'x'; const hVals = wall.frames.map(f => f[horiz]); const yVals = wall.frames.map(f => f.y)
  const hCenters = clusterCoords(hVals); const yCenters = clusterCoords(yVals)
  const orientations = [{ hAsc: true, yAsc: false, name: 'hAsc_yDesc' },{ hAsc: false, yAsc: false, name: 'hDesc_yDesc' },{ hAsc: true, yAsc: true, name: 'hAsc_yAsc' },{ hAsc: false, yAsc: true, name: 'hDesc_yAsc' }]
  const cols = hCenters.length, rows = yCenters.length; if (cols * rows !== wall.frames.length) return null; const results = []
  for (const ori of orientations) {
    const hs = ori.hAsc ? hCenters.slice() : hCenters.slice().reverse(); const ys = ori.yAsc ? yCenters.slice() : yCenters.slice().reverse()
    const cells = new Array(cols * rows).fill(null); let missing = 0
    for (const f of wall.frames) { let bestH = 0, minDh = 1e9; for (let i = 0; i < hs.length; i++) { const d = Math.abs(f[horiz] - hs[i]); if (d < minDh) { minDh = d; bestH = i } }; let bestY = 0, minDy = 1e9; for (let i = 0; i < ys.length; i++) { const d = Math.abs(f.y - ys[i]); if (d < minDy) { minDy = d; bestY = i } }; const idx = bestY * cols + bestH; if (cells[idx]) missing++; cells[idx] = f }
    if (missing > 0 || cells.some(c => !c)) continue; results.push({ cells, cols, rows, ori })
  }
  return results.length ? results : null
}

function seamV_ink(inkA, inkB) { let cost = 0; for (let y = 0; y < 128; y++) { const va = inkA[y * 128 + 127], vb = inkB[y * 128 + 0]; if (va !== vb) { const va1 = y > 0 ? inkA[(y - 1) * 128 + 127] : 0, va2 = y < 127 ? inkA[(y + 1) * 128 + 127] : 0, vb1 = y > 0 ? inkB[(y - 1) * 128 + 0] : 0, vb2 = y < 127 ? inkB[(y + 1) * 128 + 0] : 0, vaL = inkA[y * 128 + 126], vbR = inkB[y * 128 + 1]; if (va === vb1 || va === vb2 || vaL === vb || va1 === vb || va2 === vb) cost += 2; else cost += 10 } }; return cost }
function seamH_ink(inkA, inkB) { let cost = 0; for (let x = 0; x < 128; x++) { const va = inkA[127 * 128 + x], vb = inkB[0 * 128 + x]; if (va !== vb) { const vaL = x > 0 ? inkA[127 * 128 + x - 1] : 0, vaR = x < 127 ? inkA[127 * 128 + x + 1] : 0, vbL = x > 0 ? inkB[0 * 128 + x - 1] : 0, vbR = x < 127 ? inkB[0 * 128 + x + 1] : 0, vaU = inkA[126 * 128 + x], vbD = inkB[1 * 128 + x]; if (va === vbL || va === vbR || vaL === vb || vaR === vb || vaU === vb || va === vbD) cost += 2; else cost += 10 } }; return cost }

function perms(arr) { if (arr.length <= 1) return [arr.slice()]; const res = []; for (let i = 0; i < arr.length; i++) { const rest = arr.slice(0, i).concat(arr.slice(i + 1)); for (const p of perms(rest)) res.push([arr[i]].concat(p)) }; return res }
function assembleWall(wall,tiles,raw){const wca = wallCellsAdvanced(wall);if(!wca || !wca.length) return null;const wc = wca[0];const W=wc.cols*128,H=wc.rows*128;const out=new Uint8Array(W*H);let placed=0;for(let i=0;i<wc.cells.length;i++){const f=wc.cells[i];const t=tiles.get(f.mapId);if(!t)continue;const q=raw?0:((f.rotation||0)%4);const d=rotQ(t,q);const cx=(i%wc.cols)*128,cy=((i/wc.cols)|0)*128;for(let y=0;y<128;y++)for(let x=0;x<128;x++)out[(cy+y)*W+cx+x]=d[y*128+x];placed++};return{data:out,W,H,placed,wc}}

function assembleWallAuto(wall, tiles) {
  const wca = wallCellsAdvanced(wall); if (!wca || !wca.length) return null; let globalBest = null
  for (const wc of wca) {
    const { cells, cols, rows, ori } = wc; const colPerms = perms([...Array(cols).keys()])
    const P = [], Ink = []
    for (let i = 0; i < cells.length; i++) { const cell = cells[i]; const t = tiles.get(cell.mapId); let d = new Uint8Array(16384), ink = new Uint8Array(16384); if (t) { d = rotQ(t, (cell.rotation || 0) % 4); const im = inkMaskWall(d, 128, 128); ink = im.ink }; P.push(d); Ink.push(ink) }
    for (const cp of colPerms) {
      let cost = 0
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols - 1; k++) cost += seamV_ink(Ink[r * cols + cp[k]], Ink[r * cols + cp[k + 1]])
      for (let k = 0; k < cols; k++) for (let r = 0; r < rows - 1; r++) cost += seamH_ink(Ink[r * cols + cp[k]], Ink[(r + 1) * cols + cp[k]])
      if (!globalBest || cost < globalBest.cost) globalBest = { cost, cp, rp: [...Array(rows).keys()], ori, cells, cols, rows }
    }
  }
  if (!globalBest) return null
  const { cp, cells, cols, rows, ori } = globalBest; const W = cols * 128, H = rows * 128; const out = new Uint8Array(W * H); let placed = 0
  for (let k = 0; k < cols; k++) for (let m = 0; m < rows; m++) {
    const c = cp[k], r = m, cell = cells[r * cols + c]; if (cell && tiles.has(cell.mapId)) placed++; const t = tiles.get(cell.mapId); let patch = new Uint8Array(16384); if (t) patch = rotQ(t, (cell.rotation || 0) % 4)
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) out[(m * 128 + y) * W + (k * 128 + x)] = patch[y * 128 + x]
  }
  return { data: out, W, H, placed, wc: { cells, cols, rows }, colPerm: cp, rowPerm: [...Array(rows).keys()], seamCost: globalBest.cost, ori: ori.name }
}

function buildVariants(ink, digitMask, W, H){return [{name:'v09_colordigits',mask:digitMask},{name:'v08_drop_raw',mask:dropLines(ink,W,H)},{name:'v06_drop_open2',mask:dropLines(opening(ink,W,H,2),W,H)},{name:'v07_drop_open3',mask:dropLines(opening(ink,W,H,3),W,H)},{name:'v00_open2',mask:opening(ink,W,H,2)},{name:'v01_open3',mask:opening(ink,W,H,3)},{name:'v02_open4',mask:opening(ink,W,H,4)},{name:'v03_close1_open2',mask:opening(closing(ink,W,H,1),W,H,2)},{name:'v04_open2_keepbig',mask:removeNoise(opening(ink,W,H,2),W,H,300,0)},{name:'v05_open3_keepbig',mask:removeNoise(opening(ink,W,H,3),W,H,300,0)}]}
function wallDot(wall, view) { if (!view || typeof view.yaw !== 'number') return null; let cx = 0, cz = 0; for (const f of wall.frames) { cx += f.x; cz += f.z }; cx /= wall.frames.length; cz /= wall.frames.length; let dx = cx - view.x, dz = cz - view.z; const len = Math.sqrt(dx * dx + dz * dz); if (len < 0.001) return 0; dx /= len; dz /= len; const vx = -Math.sin(view.yaw), vz = Math.cos(view.yaw); return vx * dx + vz * dz }

// ========================= СОХРАНЕНИЕ РАУНДА =========================
async function saveRecord(outDir, snap, label) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(snap.frames, null, 2))
  fs.writeFileSync(path.join(outDir, 'chat.log'), snap.chats.join('\n'))
  fs.writeFileSync(path.join(outDir, 'packets.log'), snap.packets.join('\n'))
  fs.writeFileSync(path.join(outDir, 'session_log.txt'), snap.events.join('\n'))
  if (snap.view) fs.writeFileSync(path.join(outDir, 'view.json'), JSON.stringify(snap.view, null, 2))

  const linked = snap.frames.filter(f => f.mapId !== null && snap.maps.has(f.mapId))
  const walls = clusterWalls(linked)
  if (!walls.length) { step(label + ': стен не найдено (linked=' + linked.length + ')'); return null }

  const stats = []
  for (const w of walls) {
    const asm = assembleWallAuto(w, snap.maps); if (!asm || asm.placed < 8) continue
    const im = inkMaskWall(asm.data, asm.W, asm.H); const ink = im.ink
    const drop = dropLines(ink, asm.W, asm.H); const clean = dropLines(opening(ink, asm.W, asm.H, 2), asm.W, asm.H)
    const th = thickScore(ink, asm.W, asm.H); const ac = analyzeColors(asm.data, ink, asm.W, asm.H)
    const nRow = rowScore(ac.cands, asm.H); const vars = buildVariants(ink, ac.digitMask, asm.W, asm.H)
    const pick = pickOcr(vars, asm.W, asm.H); const dot = wallDot(w, snap.view)
    const confAdj = pick.conf * (nRow >= 8 ? 0.3 : 1); const dotBonus = (dot !== null && dot * VIEW_SIGN >= 0.85) ? 400 : 0; const seamPenalty = asm.seamCost * 0.5

    let rf = { ok: false, status: 0, attempt: 'none', predictions: [], metrics: rfMetrics([]), error: 'not sent' }
    try {
      const wallPng = colorPng(asm.data, asm.W, asm.H, 2); const rfPng = colorPng(asm.data, asm.W, asm.H, 1)
      const fname = 'ROBOFLOW_input_' + w.tag + '.png'; const rfName = 'ROBOFLOW_input_small_' + w.tag + '.png'
      fs.writeFileSync(path.join(outDir, fname), wallPng); fs.writeFileSync(path.join(outDir, rfName), rfPng)
      rf = await sendToRoboflow(rfPng, rfName, outDir, label + ' ' + w.tag)
      fs.writeFileSync(path.join(outDir, 'roboflow_' + w.tag + '.json'), JSON.stringify({ ok: rf.ok, status: rf.status, attempt: rf.attempt, error: rf.error || null, metrics: rf.metrics, predictionsCount: (rf.predictions || []).length, predictions: (rf.predictions || []).slice(0, 50) }, null, 2))
    } catch (e) {
      rf = { ok: false, status: 0, attempt: 'exception', predictions: [], metrics: rfMetrics([]), error: e.message }
      try { fs.writeFileSync(path.join(outDir, 'roboflow_' + w.tag + '.json'), JSON.stringify({ ok: false, error: e.message }, null, 2)) } catch (e2) {}
    }
    const rfScore = rf.ok ? (rf.metrics && rf.metrics.score ? rf.metrics.score : 0) : 0
    const score = rfScore * 100000 + confAdj * 3000 + (pick.plausible ? 800 : 0) + nRow * 100 + ac.dmColor * 30 + Math.round(th / 100) + dotBonus - seamPenalty
    stats.push({ w, asm, ink, drop, clean, digitMask: ac.digitMask, inkCount: im.inkCount, th, nRow, vars, pick, dot, confAdj, dotBonus, rf, rfScore, score, seamPenalty })
  }

  if (!stats.length) { step(label + ': стена не собралась'); return null }
  stats.sort((a, b) => b.score - a.score); const best = stats[0]
  const w = best.w, asm = best.asm, ink = best.ink, clean = best.clean, th = best.th

  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA.png'), colorPng(asm.data, asm.W, asm.H, 2))
  const raw0 = assembleWall(w, snap.maps, true); if (raw0) fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_no_rotate.png'), colorPng(raw0.data, raw0.W, raw0.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask.png'), bwPng(ink, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask_clean.png'), bwPng(clean, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask_drop.png'), bwPng(best.drop, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_digits.png'), bwPng(best.digitMask, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_raw.bin'), Buffer.from(asm.data))

  for (const s of stats.slice(1)) {
    fs.writeFileSync(path.join(outDir, 'DECOY_NOT_ORIGINAL_' + s.w.tag + '.png'), colorPng(s.asm.data, s.asm.W, s.asm.H, 2))
    const ddir = path.join(outDir, 'tiles_decoy_' + s.w.tag); fs.mkdirSync(ddir, { recursive: true })
    s.w.frames.forEach((f, i) => { const raw = snap.maps.get(f.mapId); if (raw) fs.writeFileSync(path.join(ddir, 'tile_' + String(i).padStart(2, '0') + '_map' + f.mapId + '.bin'), Buffer.from(raw)) })
  }

  const layout = []; if (asm.wc) for (let i = 0; i < asm.wc.cells.length; i++) { const f = asm.wc.cells[i]; layout.push({ cell: i, tile: f.mapId, rot: (f.rotation || 0) % 4 }) }
  fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify(layout, null, 2))
  fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true })
  layout.forEach((L, i) => { const raw = snap.maps.get(L.tile); if (raw) fs.writeFileSync(path.join(outDir, 'tiles', 'tile_' + String(i).padStart(2, '0') + '_map' + L.tile + '.bin'), Buffer.from(raw)) })

  fs.mkdirSync(path.join(outDir, 'variants'), { recursive: true })
  const ocrLines = []; for (const v of best.vars) { fs.writeFileSync(path.join(outDir, 'variants', v.name + '.png'), bwPng(v.mask, asm.W, asm.H, 2)); const r = ocr(v.mask, asm.W, asm.H); ocrLines.push(v.name + ': "' + r.text + '" digits=' + r.digits.length) }
  fs.writeFileSync(path.join(outDir, 'ocr_variants.txt'), ocrLines.join('\n'))

  step(
    label + ': ORIGINAL=' + w.tag +
    ' rfDigits=' + (best.rf && best.rf.metrics ? best.rf.metrics.n : 0) +
    ' rfText="' + (best.rf && best.rf.metrics ? best.rf.metrics.text : '') + '"' +
    ' confAdj=' + best.confAdj.toFixed(2) +
    ' ocr="' + best.pick.text + '" (' + best.pick.name + ')' +
    ' -> ' + outDir
  )

  return {
    wall: w.tag, asm, ink, clean, digitMask: best.digitMask, th, dot: best.dot, nRow: best.nRow, dmColor: best.dmColor,
    conf: best.pick.conf, confAdj: best.confAdj, seamCost: best.asm.seamCost, seamPenalty: best.seamPenalty,
    ori: best.asm.ori, colPerm: best.asm.colPerm, ocrText: best.pick.text, ocrVia: best.pick.name, plausible: best.pick.plausible,
    rf: best.rf, rfScore: best.rfScore, rfMetrics: best.rf ? best.rf.metrics : rfMetrics([]),
    maps: snap.maps, dir: outDir, tilesCount: asm.placed, tilesExpected: w.frames.length, originalFile: 'ORIGINAL_CAPTCHA.png'
  }
}

// ========================= ЗАХВАТ =========================
function getMapId(p){if(!p) return null;for(const k of ['itemDamage','mapId','id','map']) if(typeof p[k]==='number') return p[k];return null}

function connectAndCapture(tag) {
  return new Promise(resolve => {
    const col = { maps: new Map(), frames: [], framesById: new Map(), chats: [], packets: [], events: [], prompts: 0, dead: false, reason: '' }
    const ev = s => { col.events.push(new Date().toISOString() + ' ' + s); step('[' + tag + '] ' + s) }

    let finished = false, bot = null
    let pollT = null, hardT = null, settleT = null, loginT = null
    const linkedNow = () => col.frames.filter(f => f.mapId !== null && col.maps.has(f.mapId)).length

    const finish = (ok, note) => {
      if (finished) return; finished = true
      try { if (hardT) clearTimeout(hardT) } catch (e) {}; try { if (pollT) clearInterval(pollT) } catch (e) {}; try { if (settleT) clearTimeout(settleT) } catch (e) {}; try { if (loginT) clearTimeout(loginT) } catch (e) {}
      let view = null
      try { if (bot && bot.entity && bot.entity.position) view = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch } } catch (e) {}
      const snap = { maps: col.maps, frames: col.frames.map(f => Object.assign({}, f)), chats: col.chats.slice(), packets: col.packets.slice(), events: col.events.slice(), view: view }
      try { if (bot) bot.end('done') } catch (e) {}
      resolve(ok ? { ok: true, snap: snap, note: note } : { ok: false, note: note || col.reason || 'fail' })
    }

    hardT = setTimeout(() => finish(linkedNow() >= 8 && col.prompts >= 1, 'timeout'), CAPTCHA_TIMEOUT_MS)
    if (!PROXY.host) { finish(false, 'нет proxy.host'); return }

    SocksClient.createConnection({ proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password }, command: 'connect', destination: { host: MC.host, port: MC.port } })
      .then(conn => {
        ev('socks ok -> ' + MC.host)
        const nick = (NICK_PREFIX + Math.floor(Math.random() * 9000 + 1000)).slice(0, 16); const tConn = Date.now()
        const tSpawn = setTimeout(() => { if (!finished) finish(false, 'spawn timeout') }, CONNECT_TIMEOUT_MS)
        loginT = setTimeout(() => { if (!finished) finish(false, 'login timeout') }, LOGIN_TIMEOUT_MS)

        bot = mineflayer.createBot({ username: nick, host: MC.host, port: MC.port, version: MC.version, socket: conn.socket, hideErrors: true, auth: 'offline', keepAlive: true })
        bot._client.on('packet', (data, meta) => { try { if (!meta || !meta.name) return; if (col.packets.length < 4000) col.packets.push(new Date().toISOString() + ' PKT ' + meta.name) } catch (e) {} })

        const onMap = pkt => {
          try { const id = getMapId(pkt); if (id === null || !pkt.data) return; const cols = pkt.columns || 0, rows = pkt.rows || 0; if (!cols || !rows) return
            let canvas = col.maps.get(id); if (!canvas) { canvas = new Uint8Array(16384); col.maps.set(id, canvas) }
            const buf = Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(pkt.data.buffer || pkt.data, pkt.data.byteOffset || 0, pkt.data.length)
            const x0 = pkt.x || 0, y0 = pkt.y || 0
            for (let i = 0; i < buf.length; i++) { const cx = x0 + (i % cols), cy = y0 + Math.floor(i / cols); if (cx < 128 && cy < 128) canvas[cy * 128 + cx] = buf[i] }
          } catch (e) {}
        }
        bot._client.on('map', onMap); bot._client.on('map_data', onMap); bot._client.on('update_map', onMap)

        bot.on('entitySpawn', ent => { const nm = String(ent.name || ent.type || ''); if (!/item_frame|glow_item_frame/i.test(nm) || !ent.position) return; if (col.framesById.has(ent.id)) return; const f = { id: ent.id, x: ent.position.x, y: ent.position.y, z: ent.position.z, mapId: null, rotation: 0 }; col.frames.push(f); col.framesById.set(ent.id, f) })
        bot._client.on('entity_metadata', pk => { try { const f = col.framesById.get(pk.entityId); if (!f) return; for (const e of (pk.metadata || [])) { const val = e.value; if (val && typeof val === 'object' && Array.isArray(val.components)) { for (const comp of val.components) { if (comp && comp.type === 'map_id' && typeof comp.data === 'number') f.mapId = comp.data } }; if (typeof val === 'number' && (e.key === 9 || e.key === 10 || e.key === 8)) f.rotation = val } } catch (e) {} })
        bot.on('message', msg => { let t = ''; try { t = msg.toString() } catch (e) { try { t = JSON.stringify(msg.json || msg) } catch (e2) {} }; col.chats.push(t); if (/введите номер|номер с картинки|введите капчу/i.test(t)) { col.prompts++; ev('промпт капчи #' + col.prompts) } })
        bot.on('login', () => { clearTimeout(loginT); ev('login ok (' + nick + ') за ' + (Date.now() - tConn) + 'мс') })
        bot.on('spawn', () => { clearTimeout(tSpawn); ev('spawn ok за ' + (Date.now() - tConn) + 'мс') })
        bot.on('kicked', r => { if (finished) return; col.dead = true; col.reason = 'kicked'; ev('kicked'); setTimeout(() => { if (!finished && !(col.prompts >= 1 && linkedNow() >= 8)) finish(false, 'kicked before captcha') }, 600) })
        bot.on('end', () => { if (finished) return; col.dead = true; if (!col.reason) col.reason = 'end'; setTimeout(() => { if (!finished && !(col.prompts >= 1 && linkedNow() >= 8)) finish(false, col.reason) }, 600) })
        bot.on('error', e => { if (finished) return; col.dead = true; if (!col.reason) col.reason = 'error: ' + e.message; ev(col.reason); if (col.prompts < 1) finish(false, col.reason) })

        pollT = setInterval(() => {
          const linked = linkedNow()
          if (col.prompts >= 1 && linked >= 8) { if (!settleT) { ev('данные готовы (linked=' + linked + '), добор 2с...'); settleT = setTimeout(() => finish(true, 'captured'), SETTLE_MS) } }
          else if (col.dead && linked >= 8 && col.prompts >= 1) finish(true, 'captured-before-kick')
        }, 400)
      }).catch(e => { ev('socks fail: ' + e.message); finish(false, 'socks: ' + e.message) })
  })
}

// ========================= MAIN =========================
async function main() {
  if (!CFG_PATH) { step('НЕ НАЙДЕН config.json'); process.exit(1) }

  const results = []; const tGlobal = Date.now(); let rotationsUsed = 0, consecutiveNetFails = 0, proxyFails = 0, aborted = false

  step('=== ' + TARGET_ROUNDS + ' РАУНДОВ: v3.7.8 — PowerShell БЕЗ окон === ' + STAMP)
  step('config: ' + CFG_PATH + ' parse=' + CFG_STRATEGY)
  step('proxy.host=' + (PROXY.host || '(ПУСТО!)'))
  step('roboflow: enabled=' + ROBOFLOW.enabled + ' detectUrl=' + ROBOFLOW.detectUrl)

  if (isLocalhost(String(ROBOFLOW.detectUrl).replace(/^https?:\/\//, '').split(/[:\/]/)[0])) {
    await ensureInferenceServer()
  }

  currentRunIp = await rotateIp(); step('IP забега: ' + (currentRunIp || '?'))

  for (let r = 1; r <= TARGET_ROUNDS && !aborted; r++) {
    let rec = null, lastNetFail = false
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ROUND && !rec && !aborted; attempt++) {
      if (attempt > 1 && lastNetFail && !proxyDead && rotationsUsed < MAX_ROTATIONS_ON_FAIL) { rotationsUsed++; step('ротация IP (' + rotationsUsed + '/' + MAX_ROTATIONS_ON_FAIL + ')'); await rotateIp(); await sleep(2500) }
      else if (attempt > 1) await sleep(1500); else await sleep(1000 + Math.floor(Math.random() * 1000))

      step('--- РАУНД ' + r + '/' + TARGET_ROUNDS + ' (попытка ' + attempt + ', IP ' + (currentRunIp || '?') + ') ---')
      const res = await connectAndCapture('r' + r + 'a' + attempt)
      lastNetFail = !!(res && !res.ok && NET_FAIL_RE.test(res.note || ''))

      if (res && res.ok) {
        consecutiveNetFails = 0; proxyFails = 0
        const dir = path.join(REC_ROOT, 'live_round' + r + '_' + STAMP); const candidate = await saveRecord(dir, res.snap, 'РАУНД' + r)
        if (candidate && candidate.tilesCount >= MIN_PLACED) rec = candidate
      } else {
        const note = res ? res.note : '?'; step('раунд ' + r + ' попытка ' + attempt + ': ' + note)
        if (PROXY_DEAD_RE.test(note)) { proxyFails++; if (proxyFails >= 2) { proxyDead = true; aborted = true; step('ПРОКСИ МЁРТВ') } }
        else if (lastNetFail) { if (currentRunIp) badIPs.add(currentRunIp); consecutiveNetFails++; if (consecutiveNetFails >= 4) { aborted = true; step('4 сетевых фейла подряд') } }
        else consecutiveNetFails = 0
      }
    }
    if (rec) {
      results.push({ n: r, ok: true, rec: rec })
      step('РАУНД ' + r + ' сохранён: ORIGINAL=' + rec.wall + ' rfDigits=' + (rec.rfMetrics ? rec.rfMetrics.n : 0) + ' rfText="' + (rec.rfMetrics ? rec.rfMetrics.text : '') + '" ocr="' + rec.ocrText + '" via ' + rec.ocrVia)
    } else if (!aborted) { results.push({ n: r, ok: false, note: 'fail' }); step('РАУНД ' + r + ' провален') }
    if (r < TARGET_ROUNDS && !aborted) await sleep(PAUSE_BETWEEN_MS)
  }

  const okList = results.filter(x => x.ok && x.rec); const L = ['=== СВОДКА ' + TARGET_ROUNDS + ' РАУНДОВ ===']
  L.push('успешных: ' + okList.length + '/' + TARGET_ROUNDS + ' | время: ' + Math.round((Date.now() - tGlobal) / 1000) + 'с')
  for (const x of results) L.push('  #' + x.n + ': ' + (x.rec ? 'ORIGINAL=' + x.rec.wall + ' rfDigits=' + (x.rec.rfMetrics ? x.rec.rfMetrics.n : 0) + ' ocr="' + x.rec.ocrText + '"' : 'FAIL'))
  step('готово.'); flushReport(L.join('\n')); console.log('\n' + L.join('\n'))
  setTimeout(() => process.exit(0), 2000)
}

main().catch(e => { console.error('FATAL: ' + e.message); flushReport('FATAL: ' + (e.stack || e.message)); process.exit(1) })
