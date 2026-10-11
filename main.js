// VERSION: 3.8.1
// main.js
// v3.8.1: АВТО-УСТАНОВКА tesseract.js + прогресс загрузки
const mineflayer = require('mineflayer')
const { SocksClient } = require('socks')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { spawn, spawnSync, execSync } = require('child_process')

const TARGET_ROUNDS = 10
const PAUSE_BETWEEN_MS = 3000
const MIN_PLACED = 10
const CAPTCHA_TIMEOUT_MS = 45000
const CONNECT_TIMEOUT_MS = 35000
const LOGIN_TIMEOUT_MS = 30000
const ANSWER_TIMEOUT_MS = 8000

// ========================= ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ =========================
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []
let REC_ROOT = null
let tesseractWorker = null
let Tesseract = null  // загружается динамически

function step(s) {
  const l = new Date().toISOString().slice(11, 19) + ' [step] ' + s
  SLOG.push(l)
  console.log(l)
}

function flushReport(extra) {
  if (!REC_ROOT) return
  try { fs.writeFileSync(path.join(REC_ROOT, 'report_' + STAMP + '.txt'), SLOG.join('\n') + '\n' + (extra || '')) } catch (e) {}
}

process.on('uncaughtException', e => {
  console.error('\n!!! UNCAUGHT !!!', e.message, '\n', e.stack)
  flushReport('UNCAUGHT: ' + (e.stack || e.message))
  setTimeout(() => process.exit(1), 1000)
})

process.on('unhandledRejection', e => {
  console.error('\n!!! REJECTION !!!', e)
  flushReport('REJECTION: ' + (e && e.message ? e.message : String(e)))
})

// ========================= АВТО-УСТАНОВКА ПАКЕТОВ =========================

// Проверка и установка tesseract.js
async function ensureTesseract() {
  const packagePath = path.join(__dirname, 'node_modules', 'tesseract.js', 'package.json')
  
  if (fs.existsSync(packagePath)) {
    step('[SETUP] ✓ tesseract.js уже установлен')
  } else {
    step('[SETUP] 📦 tesseract.js НЕ НАЙДЕН — устанавливаю...')
    step('[SETUP] ⏳ Это может занять 30-60 секунд (загрузка ~50МБ)')
    
    await installPackage('tesseract.js')
    
    if (!fs.existsSync(packagePath)) {
      throw new Error('Не удалось установить tesseract.js')
    }
    step('[SETUP] ✅ tesseract.js успешно установлен')
  }
  
  // Динамическая загрузка
  try {
    Tesseract = require('tesseract.js')
    step('[SETUP] ✓ Tesseract.js модуль загружен')
  } catch (e) {
    throw new Error('Не удалось загрузить tesseract.js: ' + e.message)
  }
}

// Проверка и установка mineflayer (на всякий случай)
async function ensureMineflayer() {
  const packagePath = path.join(__dirname, 'node_modules', 'mineflayer', 'package.json')
  if (fs.existsSync(packagePath)) {
    step('[SETUP] ✓ mineflayer уже установлен')
    return
  }
  step('[SETUP] 📦 mineflayer НЕ НАЙДЕН — устанавливаю...')
  await installPackage('mineflayer')
}

// Проверка socks
async function ensureSocks() {
  const packagePath = path.join(__dirname, 'node_modules', 'socks', 'package.json')
  if (fs.existsSync(packagePath)) {
    step('[SETUP] ✓ socks уже установлен')
    return
  }
  step('[SETUP] 📦 socks НЕ НАЙДЕН — устанавливаю...')
  await installPackage('socks')
}

// Установка npm-пакета с выводом прогресса
function installPackage(name) {
  return new Promise((resolve, reject) => {
    step('[NPM] Запуск: npm install ' + name)
    
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', name, '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
    
    const timeout = setTimeout(() => {
      try { child.kill() } catch (e) {}
      reject(new Error('Таймаут установки ' + name + ' (120с)'))
    }, 120000)
    
    child.on('close', code => {
      clearTimeout(timeout)
      if (code === 0) {
        step('[NPM] ✅ ' + name + ' установлен успешно')
        resolve()
      } else {
        reject(new Error('npm install ' + name + ' завершился с кодом ' + code))
      }
    })
    
    child.on('error', err => {
      clearTimeout(timeout)
      reject(new Error('Ошибка запуска npm: ' + err.message + '\nУбедитесь что Node.js и npm установлены: https://nodejs.org/'))
    })
  })
}

// Проверка что package.json существует, если нет — создаём
function ensurePackageJson() {
  const pkgPath = path.join(__dirname, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    step('[SETUP] 📝 Создаю package.json...')
    const pkg = {
      name: 'funtime-captcha-bot',
      version: '3.8.1',
      description: 'Minecraft captcha solver with Tesseract.js OCR',
      main: 'main.js',
      private: true,
      dependencies: {}
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    step('[SETUP] ✓ package.json создан')
  }
}

// ========================= КОНФИГ =========================
let CFG_PATH, CFG = {}, CFG_STRATEGY = 'none'

try {
  const CFG_PARENT = path.join(__dirname, '..', 'config.json')
  const CFG_LOCAL = path.join(__dirname, 'config.json')
  CFG_PATH = fs.existsSync(CFG_LOCAL) ? CFG_LOCAL : (fs.existsSync(CFG_PARENT) ? CFG_PARENT : null)
} catch (e) {}

function cfgGet(o, kp, d) {
  let c = o
  for (const k of kp.split('.')) { if (!c || c[k] === undefined) return d; c = c[k] }
  return c
}

function parseCfgSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch (e) { return {} }
}

if (CFG_PATH) { CFG = parseCfgSafe(CFG_PATH); CFG_STRATEGY = 'json' }

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

try {
  REC_ROOT = path.join(__dirname, 'records')
  fs.mkdirSync(REC_ROOT, { recursive: true })
} catch (e) {}

const sleep = ms => new Promise(r => setTimeout(r, ms))
let currentRunIp = null

// ========================= ПАЛИТРА / PNG =========================
const BASE_COLORS = [[0,0,0],[127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],[167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],[112,112,112],[64,128,255],[104,83,50],[255,252,245],[216,127,51],[178,76,216],[102,153,216],[229,229,51],[127,204,25],[242,127,165],[76,76,76],[153,153,153],[76,127,153],[127,63,178],[51,76,178],[102,76,51],[102,127,51],[153,51,51],[25,25,25],[250,238,77],[92,219,213],[74,128,255],[0,217,58],[135,107,58],[112,2,2],[143,119,100],[161,83,37],[149,88,108],[114,119,139],[186,133,35],[103,117,52],[160,77,78],[57,42,35],[135,106,97],[86,91,91],[118,70,86],[74,59,91],[77,51,35],[76,83,42],[143,61,46],[37,22,16],[189,48,49],[148,63,97],[126,32,44],[22,119,121],[58,142,140],[74,117,116],[23,121,121],[90,90,90],[224,169,112],[127,106,82],[221,169,46],[156,104,66]]
const SHADE_MULT = [135, 255, 220, 180]
const PALETTE = (() => {
  const p = new Uint8Array(256 * 3)
  for (let v = 0; v < 256; v++) {
    let r = 255, g = 255, b = 255
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

let CRC = null
function crc32(b) {
  if (!CRC) {
    CRC = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
  const ih = Buffer.alloc(13)
  ih.writeUInt32BE(w,0); ih.writeUInt32BE(h,4); ih[8]=8; ih[9]=6
  const raw = Buffer.alloc((w*4+1)*h)
  for (let y=0;y<h;y++){ raw[y*(w*4+1)]=0; rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4) }
  const chunk=(t,d)=>{
    const l=Buffer.alloc(4); l.writeUInt32BE(d.length,0)
    const tt=Buffer.from(t,'ascii')
    const cr=Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt,d])),0)
    return Buffer.concat([l,tt,d,cr])
  }
  return Buffer.concat([sig, chunk('IHDR',ih), chunk('IDAT',zlib.deflateSync(raw)), chunk('IEND',Buffer.alloc(0))])
}

function colorPng(data, W, H, sc) {
  const SW = W * sc, SH = H * sc
  const rgba = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const v = data[Math.floor(y / sc) * W + Math.floor(x / sc)]
    const i = (y * SW + x) * 4
    rgba[i] = PALETTE[v * 3]; rgba[i + 1] = PALETTE[v * 3 + 1]; rgba[i + 2] = PALETTE[v * 3 + 2]; rgba[i + 3] = 255
  }
  return encodePng(SW, SH, rgba)
}

// ========================= TESSERACT.JS ИНТЕГРАЦИЯ =========================

async function initTesseract() {
  if (tesseractWorker) return tesseractWorker
  
  step('[OCR] 🚀 Инициализация Tesseract.js...')
  step('[OCR] ⏳ Первый запуск: загрузка языковых данных (~20МБ)')
  const t0 = Date.now()
  
  let lastStatus = ''
  let lastProgress = -1
  
  try {
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status !== lastStatus) {
          lastStatus = m.status
          if (m.status === 'loading tesseract core') {
            step('[OCR] 📥 Загрузка ядра Tesseract...')
          } else if (m.status === 'initializing tesseract') {
            step('[OCR] ⚙️ Инициализация Tesseract...')
          } else if (m.status === 'loading language traineddata') {
            step('[OCR] 📥 Загрузка языковых данных (eng)...')
          } else if (m.status === 'initializing api') {
            step('[OCR] ⚙️ Инициализация API...')
          }
        }
        if (m.progress && Math.floor(m.progress * 10) !== lastProgress) {
          lastProgress = Math.floor(m.progress * 10)
          if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') {
            const pct = Math.round(m.progress * 100)
            process.stdout.write('\r[OCR] 📥 ' + m.status + ': ' + pct + '%   ')
            if (pct >= 100) process.stdout.write('\n')
          }
        }
      }
    })
    
    // Настраиваем только для цифр
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7',
      preserve_interword_spaces: '0'
    })
    
    const elapsed = Math.round((Date.now() - t0) / 1000)
    step('[OCR] ✅ Tesseract готов за ' + elapsed + 'с')
    return tesseractWorker
  } catch (e) {
    step('[OCR] ❌ Ошибка инициализации: ' + e.message)
    throw e
  }
}

function computeOtsuThreshold(data, W, H) {
  const histogram = new Array(256).fill(0)
  for (let i = 0; i < data.length; i++) histogram[LUM[data[i]]]++
  const total = W * H
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * histogram[i]
  let sumB = 0, wB = 0, wF = 0
  let maxVariance = 0, threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += histogram[t]
    if (wB === 0) continue
    wF = total - wB
    if (wF === 0) break
    sumB += t * histogram[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const variance = wB * wF * (mB - mF) * (mB - mF)
    if (variance > maxVariance) { maxVariance = variance; threshold = t }
  }
  return threshold
}

function preprocessVariant(data, W, H, variant) {
  const result = Buffer.alloc(W * H * 4)
  const threshold = variant === 'otsu' ? computeOtsuThreshold(data, W, H) : 128
  
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x
      const v = data[idx]
      const lum = LUM[v]
      let gray
      switch (variant) {
        case 'otsu': gray = lum < threshold ? 0 : 255; break
        case 'dark_only': gray = lum < 128 ? 0 : 255; break
        case 'bright_only': gray = lum >= 128 ? 255 : 0; break
        case 'high_contrast': gray = lum < 100 ? 0 : (lum > 200 ? 255 : Math.round((lum - 100) * 2.55)); break
        case 'inverted': gray = 255 - lum; break
        default: gray = lum
      }
      const i = idx * 4
      result[i] = gray; result[i + 1] = gray; result[i + 2] = gray; result[i + 3] = 255
    }
  }
  return result
}

async function ocrWithTesseract(data, W, H, label) {
  const worker = await initTesseract()
  if (!worker) return { text: '', confidence: 0, variants: [] }
  
  const variants = ['otsu', 'dark_only', 'high_contrast', 'inverted', 'bright_only']
  const results = []
  
  for (const variant of variants) {
    try {
      const preprocessed = preprocessVariant(data, W, H, variant)
      const pngBuffer = encodePng(W, H, preprocessed)
      const result = await worker.recognize(pngBuffer)
      const text = result.data.text.replace(/\s+/g, '').trim()
      const digits = text.replace(/[^0-9]/g, '')
      const conf = result.data.confidence || 0
      results.push({ variant, rawText: text, digits, confidence: conf, length: digits.length })
    } catch (e) {
      results.push({ variant, digits: '', confidence: 0, length: 0, error: e.message })
    }
  }
  
  results.sort((a, b) => {
    const aGood = a.length >= 4 && a.length <= 7 ? 1 : 0
    const bGood = b.length >= 4 && b.length <= 7 ? 1 : 0
    if (aGood !== bGood) return bGood - aGood
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    return b.length - a.length
  })
  
  if (label) {
    step('[OCR] Результаты для ' + label + ':')
    for (const r of results) {
      const marker = r === results[0] ? '⭐' : '  '
      step('[OCR]   ' + marker + ' ' + r.variant.padEnd(15) + ' | "' + r.digits.padEnd(8) + '" | conf=' + r.confidence.toFixed(1) + ' | len=' + r.length)
    }
  }
  
  const best = results[0]
  const validResults = results.filter(r => r.length >= 4 && r.length <= 7 && r.confidence > 30)
  
  if (validResults.length === 0) {
    return { text: best.digits, confidence: best.confidence, method: best.variant, variants: results, voting: false }
  }
  
  const maxLength = Math.max(...validResults.map(r => r.length))
  const votes = []
  for (let pos = 0; pos < maxLength; pos++) {
    const digitCounts = {}
    for (const r of validResults) {
      if (pos < r.digits.length) {
        const d = r.digits[pos]
        digitCounts[d] = (digitCounts[d] || 0) + 1
      }
    }
    let bestDigit = '0', bestCount = 0
    for (const [d, count] of Object.entries(digitCounts)) {
      if (count > bestCount) { bestCount = count; bestDigit = d }
    }
    votes.push({ digit: bestDigit, count: bestCount, total: validResults.length })
  }
  
  const votedText = votes.map(v => v.digit).join('')
  const avgConfidence = votes.reduce((a, v) => a + (v.count / v.total), 0) / votes.length * 100
  
  if (label) {
    step('[OCR] 🗳 Голосование: "' + votedText + '" (avg conf=' + avgConfidence.toFixed(1) + '%)')
    step('[OCR] 🏆 Лучший: "' + best.digits + '" (' + best.variant + ', conf=' + best.confidence.toFixed(1) + ')')
  }
  
  return { text: votedText, confidence: avgConfidence, method: 'voting', bestVariant: best.variant, bestSingle: best.digits, variants: results, voting: true }
}

// ========================= ОБРАБОТКА =========================
const NB8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]

function inkMaskWall(data,W,H){
  const wc=new Int32Array(256);for(let i=0;i<data.length;i++) wc[data[i]]++
  const bgW=new Set();for(let v=1;v<256;v++) if(wc[v]>=6000 && LUM[v]>=120) bgW.add(v)
  const iso={}
  for(let v=1;v<256;v++){
    const c=wc[v];if(c<150||c>6000||bgW.has(v)||LUM[v]<120) continue
    const stp=Math.max(1,Math.floor(c/300))
    let checked=0,isolated=0
    for(let i=v%7;i<data.length&&checked<300;i+=stp){if(data[i]!==v)continue;const x=i%W,y=(i/W)|0;if(x<1||x>=W-1||y<1||y>=H-1)continue;checked++;let same=false;for(const nb of NB8){const nx=x+nb[0],ny=y+nb[1];if(data[ny*W+nx]===v){same=true;break}};if(!same)isolated++}
    iso[v]=checked?isolated/checked:0
    if(iso[v]>=0.6)bgW.add(v)
  }
  const ink=new Uint8Array(data.length)
  for(let r=0;r<H/128;r++)for(let c=0;c<W/128;c++){
    const counts=new Int32Array(256);const x0=c*128,y0=r*128
    for(let y=0;y<128;y++)for(let x=0;x<128;x++)counts[data[(y0+y)*W+x0+x]]++
    const bg=new Set(bgW)
    for(let v=1;v<256;v++){if(LUM[v]>=120 && (counts[v]>=1200 || (iso[v]||0)>=0.6)) bg.add(v)}
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){const i=(y0+y)*W+x0+x;const v=data[i];if(v!==0&&!bg.has(v))ink[i]=1}
  }
  return { ink, inkCount: ink.reduce((a, b) => a + b, 0) }
}

function rotQ(d,q){
  q=((q%4)+4)%4
  if(!q)return Uint8Array.from(d)
  const o=new Uint8Array(16384)
  for(let y=0;y<128;y++)for(let x=0;x<128;x++){const v=d[y*128+x];if(q===1)o[x*128+127-y]=v;else if(q===2)o[(127-y)*128+(127-x)]=v;else o[(127-x)*128+y]=v}
  return o
}

function clusterWalls(frames){
  const counts={}
  frames.forEach(f=>{counts['x:'+Math.round(f.x)]=(counts['x:'+Math.round(f.x)]||0)+1;counts['z:'+Math.round(f.z)]=(counts['z:'+Math.round(f.z)]||0)+1})
  const planes=Object.entries(counts).filter(([,v])=>v>=8).sort((a,b)=>b[1]-a[1])
  const walls=[],used=new Set()
  for(const[key]of planes){
    const[axis,val]=key.split(':')
    const members=frames.filter(f=>!used.has(f.id)&&Math.round(f[axis])===+val)
    if(members.length<8)continue
    members.forEach(f=>used.add(f.id))
    walls.push({axis,value:+val,frames:members,tag:axis+val})
    if(walls.length===2)break
  }
  return walls
}

function clusterCoords(vals) {
  if (!vals || !vals.length) return []
  const sorted = vals.slice().sort((a, b) => a - b)
  const clusters = []
  let cur = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - cur[0] < 0.6) cur.push(sorted[i])
    else { clusters.push(cur.reduce((s, x) => s + x, 0) / cur.length); cur = [sorted[i]] }
  }
  clusters.push(cur.reduce((s, x) => s + x, 0) / cur.length)
  return clusters
}

function wallCellsAdvanced(wall) {
  const horiz = wall.axis === 'x' ? 'z' : 'x'
  const hVals = wall.frames.map(f => f[horiz])
  const yVals = wall.frames.map(f => f.y)
  const hCenters = clusterCoords(hVals)
  const yCenters = clusterCoords(yVals)
  const cols = hCenters.length, rows = yCenters.length
  if (cols * rows !== wall.frames.length) return null
  const orientations = [{hAsc:true,yAsc:false},{hAsc:false,yAsc:false},{hAsc:true,yAsc:true},{hAsc:false,yAsc:true}]
  const results = []
  for (const ori of orientations) {
    const hs = ori.hAsc ? hCenters.slice() : hCenters.slice().reverse()
    const ys = ori.yAsc ? yCenters.slice() : yCenters.slice().reverse()
    const cells = new Array(cols * rows).fill(null)
    let missing = 0
    for (const f of wall.frames) {
      let bestH = 0, minDh = 1e9
      for (let i = 0; i < hs.length; i++) { const d = Math.abs(f[horiz] - hs[i]); if (d < minDh) { minDh = d; bestH = i } }
      let bestY = 0, minDy = 1e9
      for (let i = 0; i < ys.length; i++) { const d = Math.abs(f.y - ys[i]); if (d < minDy) { minDy = d; bestY = i } }
      const idx = bestY * cols + bestH
      if (cells[idx]) missing++
      cells[idx] = f
    }
    if (missing > 0 || cells.some(c => !c)) continue
    results.push({ cells, cols, rows })
  }
  return results.length ? results : null
}

function seamV_ink(inkA, inkB) {
  let cost = 0
  for (let y = 0; y < 128; y++) {
    const va = inkA[y * 128 + 127], vb = inkB[y * 128 + 0]
    if (va !== vb) cost += 10
  }
  return cost
}

function perms(arr) {
  if (arr.length <= 1) return [arr.slice()]
  const res = []
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1))
    for (const p of perms(rest)) res.push([arr[i]].concat(p))
  }
  return res
}

function assembleWallAuto(wall, tiles) {
  const wca = wallCellsAdvanced(wall)
  if (!wca || !wca.length) return null
  let globalBest = null
  for (const wc of wca) {
    const { cells, cols, rows } = wc
    const colPerms = cols <= 5 ? perms([...Array(cols).keys()]) : [[...Array(cols).keys()]]
    const Ink = []
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]; const t = tiles.get(cell.mapId)
      let ink = new Uint8Array(16384)
      if (t) { const d = rotQ(t, (cell.rotation || 0) % 4); const im = inkMaskWall(d, 128, 128); ink = im.ink }
      Ink.push(ink)
    }
    for (const cp of colPerms) {
      let cost = 0
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols - 1; k++) cost += seamV_ink(Ink[r * cols + cp[k]], Ink[r * cols + cp[k + 1]])
      if (!globalBest || cost < globalBest.cost) globalBest = { cost, cp, cells, cols, rows }
    }
  }
  if (!globalBest) return null
  const { cp, cells, cols, rows } = globalBest
  const W = cols * 128, H = rows * 128
  const out = new Uint8Array(W * H)
  let placed = 0
  for (let k = 0; k < cols; k++) for (let m = 0; m < rows; m++) {
    const c = cp[k], cell = cells[m * cols + c]
    if (cell && tiles.has(cell.mapId)) placed++
    const t = tiles.get(cell.mapId)
    let patch = new Uint8Array(16384)
    if (t) patch = rotQ(t, (cell.rotation || 0) % 4)
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) out[(m * 128 + y) * W + (k * 128 + x)] = patch[y * 128 + x]
  }
  return { data: out, W, H, placed }
}

function getMapId(p){
  if(!p) return null
  for(const k of ['itemDamage','mapId','id','map']) if(typeof p[k]==='number') return p[k]
  return null
}

// ========================= IP / HTTP =========================
async function rotateIp() {
  if (!PROXY.changeIpUrl || PROXY.changeIpUrl.includes('YOUR_KEY')) {
    step('changeIpUrl не задан')
    return null
  }
  const oldIp = await getIp()
  step('IP до ротации: ' + (oldIp || '?'))
  try {
    const r = await httpGet(PROXY.changeIpUrl, 15000)
    step('changeIp: status=' + r.status)
  } catch (e) { step('changeIp fail: ' + e.message) }
  const waitMs = Math.max(5000, (Number(PROXY.waitSec) || 12) * 1000)
  await sleep(waitMs)
  const newIp = await getIp()
  if (newIp && newIp !== oldIp) {
    step('IP СМЕНЁН: ' + oldIp + ' -> ' + newIp)
    currentRunIp = newIp
    return newIp
  }
  step('IP не сменился')
  currentRunIp = newIp
  return newIp
}

async function getIp() {
  return new Promise(resolve => {
    SocksClient.createConnection({
      proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password },
      command: 'connect',
      destination: { host: 'api.ipify.org', port: 80 }
    }).then(conn => {
      let data = ''
      const t = setTimeout(() => { try { conn.socket.destroy() } catch (e) {}; resolve(null) }, 10000)
      conn.socket.on('data', d => {
        data += d.toString()
        const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
        if (m && data.includes('\r\n\r\n')) {
          clearTimeout(t)
          try { conn.socket.destroy() } catch (e) {}
          resolve(m[1])
        }
      })
      conn.socket.on('error', () => { clearTimeout(t); resolve(null) })
      conn.socket.on('end', () => {
        clearTimeout(t)
        const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
        resolve(m ? m[1] : null)
      })
      conn.socket.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n')
    }).catch(() => resolve(null))
  })
}

async function httpGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const opts = { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }
    const req = (u.protocol === 'https:' ? require('https') : require('http')).get(urlStr, opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ========================= ГЛАВНОЕ =========================
async function doRound(roundNum) {
  return new Promise(resolve => {
    const col = {
      maps: new Map(), frames: [], framesById: new Map(),
      chats: [], prompts: 0, dead: false,
      answerSent: false, answerResult: null, answerText: null
    }
    
    let finished = false, bot = null
    let hardT = null, loginT = null
    
    const finish = (result) => {
      if (finished) return
      finished = true
      try { if (hardT) clearTimeout(hardT) } catch (e) {}
      try { if (loginT) clearTimeout(loginT) } catch (e) {}
      try { if (bot) bot.end('done') } catch (e) {}
      resolve(result)
    }
    
    hardT = setTimeout(() => finish({ ok: false, note: 'hard timeout' }), CAPTCHA_TIMEOUT_MS)
    
    if (!PROXY.host) { finish({ ok: false, note: 'нет proxy.host' }); return }
    
    SocksClient.createConnection({
      proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password },
      command: 'connect',
      destination: { host: MC.host, port: MC.port }
    }).then(conn => {
      step('[r' + roundNum + '] socks ok -> ' + MC.host)
      const nick = (NICK_PREFIX + Math.floor(Math.random() * 9000 + 1000)).slice(0, 16)
      const tConn = Date.now()
      
      loginT = setTimeout(() => {
        if (!finished) finish({ ok: false, note: 'login timeout' })
      }, LOGIN_TIMEOUT_MS)
      
      bot = mineflayer.createBot({
        username: nick, host: MC.host, port: MC.port, version: MC.version,
        socket: conn.socket, hideErrors: true, auth: 'offline', keepAlive: true
      })
      
      const onMap = pkt => {
        try {
          const id = getMapId(pkt)
          if (id === null || !pkt.data) return
          const cols = pkt.columns || 0, rows = pkt.rows || 0
          if (!cols || !rows) return
          let canvas = col.maps.get(id)
          if (!canvas) { canvas = new Uint8Array(16384); col.maps.set(id, canvas) }
          const buf = Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(pkt.data.buffer || pkt.data, pkt.data.byteOffset || 0, pkt.data.length)
          const x0 = pkt.x || 0, y0 = pkt.y || 0
          for (let i = 0; i < buf.length; i++) {
            const cx = x0 + (i % cols), cy = y0 + Math.floor(i / cols)
            if (cx < 128 && cy < 128) canvas[cy * 128 + cx] = buf[i]
          }
        } catch (e) {}
      }
      bot._client.on('map', onMap)
      bot._client.on('map_data', onMap)
      bot._client.on('update_map', onMap)
      
      bot.on('entitySpawn', ent => {
        const nm = String(ent.name || ent.type || '')
        if (!/item_frame|glow_item_frame/i.test(nm) || !ent.position) return
        if (col.framesById.has(ent.id)) return
        const f = { id: ent.id, x: ent.position.x, y: ent.position.y, z: ent.position.z, mapId: null, rotation: 0 }
        col.frames.push(f)
        col.framesById.set(ent.id, f)
      })
      
      bot._client.on('entity_metadata', pk => {
        try {
          const f = col.framesById.get(pk.entityId)
          if (!f) return
          for (const e of (pk.metadata || [])) {
            const val = e.value
            if (val && typeof val === 'object' && Array.isArray(val.components)) {
              for (const comp of val.components) {
                if (comp && comp.type === 'map_id' && typeof comp.data === 'number') f.mapId = comp.data
              }
            }
            if (typeof val === 'number' && (e.key === 9 || e.key === 10 || e.key === 8)) f.rotation = val
          }
        } catch (e) {}
      })
      
      bot.on('message', msg => {
        let t = ''
        try { t = msg.toString() } catch (e) { try { t = JSON.stringify(msg.json || msg) } catch (e2) {} }
        col.chats.push(t)
        step('[r' + roundNum + '] 💬 ' + t.slice(0, 100))
        
        if (col.answerSent && col.answerResult === null) {
          if (/неверн|incorrect|wrong|ошибк|неправильн/i.test(t)) {
            step('[r' + roundNum + '] ❌ ответ НЕВЕРНЫЙ')
            col.answerResult = 'wrong'
            finish({ ok: false, note: 'wrong_answer', ocrSent: col.answerText })
            return
          }
          if (/принят|accepted|верно|correct|успешн|welcome/i.test(t)) {
            step('[r' + roundNum + '] ✅ ответ ВЕРНЫЙ')
            col.answerResult = 'correct'
            finish({ ok: true, note: 'correct_answer', ocrSent: col.answerText })
            return
          }
        }
        
        if (/введите номер|номер с картинки|введите капчу|captcha|enter code/i.test(t.toLowerCase())) {
          col.prompts++
          step('[r' + roundNum + '] 💬 ПРОМПТ КАПЧИ #' + col.prompts)
          if (col.prompts === 1 && !col.answerSent) {
            setTimeout(async () => {
              if (finished || col.answerSent) return
              await trySendAnswer(bot, col, roundNum)
            }, 2000)
          }
        }
      })
      
      bot.on('login', () => {
        clearTimeout(loginT)
        step('[r' + roundNum + '] login ok (' + nick + ') за ' + (Date.now() - tConn) + 'мс')
      })
      
      bot.on('kicked', r => {
        if (finished) return
        const reason = String(r || '')
        step('[r' + roundNum + '] kicked: ' + reason.slice(0, 150))
        if (col.answerSent && col.answerResult === null) {
          step('[r' + roundNum + '] ✅ KICKED после ответа = капча пройдена!')
          finish({ ok: true, note: 'captcha_passed', ocrSent: col.answerText })
          return
        }
        col.dead = true
        finish({ ok: false, note: 'kicked: ' + reason.slice(0, 80) })
      })
      
      bot.on('end', (reason) => {
        if (finished) return
        col.dead = true
        finish({ ok: false, note: 'end: ' + String(reason || '').slice(0, 80) })
      })
      
      bot.on('error', e => {
        if (finished) return
        col.dead = true
        finish({ ok: false, note: 'error: ' + e.message })
      })
      
    }).catch(e => {
      step('[r' + roundNum + '] socks fail: ' + e.message)
      finish({ ok: false, note: 'socks: ' + e.message })
    })
  })
}

async function trySendAnswer(bot, col, roundNum) {
  const linked = col.frames.filter(f => f.mapId !== null && col.maps.has(f.mapId))
  step('[r' + roundNum + '] linked=' + linked.length)
  
  if (linked.length < MIN_PLACED) {
    step('[r' + roundNum + '] ❌ Недостаточно данных')
    return
  }
  
  const walls = clusterWalls(linked)
  if (!walls.length) {
    step('[r' + roundNum + '] ❌ Стен не найдено')
    return
  }
  
  let bestOcr = null
  let bestWallData = null
  
  for (const w of walls) {
    const asm = assembleWallAuto(w, col.maps)
    if (!asm || asm.placed < 8) continue
    step('[r' + roundNum + '] OCR стена ' + w.tag + ' (' + asm.W + 'x' + asm.H + ')...')
    const result = await ocrWithTesseract(asm.data, asm.W, asm.H, w.tag)
    if (result.text && result.text.length >= 4 && result.text.length <= 7) {
      if (!bestOcr || result.confidence > bestOcr.confidence) {
        bestOcr = result
        bestWallData = asm
      }
    }
  }
  
  if (!bestOcr || !bestOcr.text) {
    step('[r' + roundNum + '] ❌ Не удалось распознать')
    return
  }
  
  step('[r' + roundNum + '] 🎯 ФИНАЛЬНЫЙ ОТВЕТ: "' + bestOcr.text + '" (conf=' + bestOcr.confidence.toFixed(1) + '%)')
  
  try {
    const outDir = path.join(REC_ROOT, 'captcha_' + roundNum + '_' + STAMP)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'captcha.png'), colorPng(bestWallData.data, bestWallData.W, bestWallData.H, 2))
    fs.writeFileSync(path.join(outDir, 'answer.txt'), bestOcr.text + '\n' + JSON.stringify(bestOcr, null, 2))
  } catch (e) {}
  
  try {
    col.answerSent = true
    col.answerText = bestOcr.text
    step('[r' + roundNum + '] 📤 ОТПРАВЛЯЮ В ЧАТ: "' + bestOcr.text + '"')
    bot.chat(bestOcr.text)
    setTimeout(() => {
      if (!col.answerResult && !col.dead) {
        step('[r' + roundNum + '] ⏱ Таймаут реакции')
      }
    }, ANSWER_TIMEOUT_MS)
  } catch (e) {
    step('[r' + roundNum + '] ❌ Ошибка отправки: ' + e.message)
    col.answerSent = false
  }
}

// ========================= MAIN =========================
async function main() {
  step('=== СТАРТ v3.8.1 — АВТО-УСТАНОВКА ВСЕХ ЗАВИСИМОСТЕЙ ===')
  step('')
  
  // ШАГ 1: Создаём package.json если нет
  ensurePackageJson()
  
  // ШАГ 2: Проверяем и устанавливаем все нужные пакеты
  step('[SETUP] 📦 Проверка зависимостей...')
  await ensureMineflayer()
  await ensureSocks()
  await ensureTesseract()  // это скачает ~50МБ при первом запуске
  step('')
  
  step('config: ' + CFG_PATH + ' parse=' + CFG_STRATEGY)
  step('MC: ' + MC.host + ':' + MC.port + ' v' + MC.version)
  step('proxy: ' + PROXY.host + ':' + PROXY.port)
  step('OCR: Tesseract.js (5 вариантов + голосование)')
  step('')
  
  if (!CFG_PATH) { step('НЕ НАЙДЕН config.json'); process.exit(1) }
  
  // Предварительная инициализация Tesseract
  try {
    await initTesseract()
  } catch (e) {
    step('❌ Не удалось инициализировать Tesseract: ' + e.message)
    process.exit(1)
  }
  
  const results = []
  const tGlobal = Date.now()
  let correctCount = 0
  
  await rotateIp()
  step('IP забега: ' + (currentRunIp || '?'))
  step('')
  
  for (let r = 1; r <= TARGET_ROUNDS; r++) {
    step('--- РАУНД ' + r + '/' + TARGET_ROUNDS + ' (IP ' + (currentRunIp || '?') + ') ---')
    const result = await doRound(r)
    if (result.ok) {
      correctCount++
      step('✅ РАУНД ' + r + ' УСПЕХ! ответ: "' + (result.ocrSent || '?') + '" | ' + result.note)
    } else {
      step('❌ РАУНД ' + r + ' fail: ' + result.note)
      if (result.ocrSent) step('   отправлен: "' + result.ocrSent + '"')
      if (result.note.includes('login timeout') || result.note.includes('kicked')) {
        step('🔄 Ротация IP...')
        await rotateIp()
        await sleep(2000)
      }
    }
    results.push({ n: r, ok: result.ok, note: result.note, ocr: result.ocrSent || '-' })
    if (r < TARGET_ROUNDS) await sleep(PAUSE_BETWEEN_MS)
    step('')
  }
  
  if (tesseractWorker) {
    try { await tesseractWorker.terminate() } catch (e) {}
  }
  
  const L = ['=== СВОДКА ===']
  L.push('успешных: ' + correctCount + '/' + TARGET_ROUNDS)
  L.push('точность: ' + Math.round(correctCount/TARGET_ROUNDS*100) + '%')
  L.push('время: ' + Math.round((Date.now() - tGlobal) / 1000) + 'с')
  L.push('')
  for (const x of results) {
    L.push('  #' + x.n + ': ' + (x.ok ? '✅' : '❌') + ' ocr="' + x.ocr + '" — ' + x.note)
  }
  
  step('готово.')
  flushReport(L.join('\n'))
  console.log('\n' + L.join('\n'))
  setTimeout(() => process.exit(0), 2000)
}

main().catch(e => {
  console.error('\n!!! FATAL !!!', e.message, '\n', e.stack)
  flushReport('FATAL: ' + (e.stack || e.message))
  setTimeout(() => process.exit(1), 2000)
})
