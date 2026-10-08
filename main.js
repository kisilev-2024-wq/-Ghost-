// test_rf.js — Автономный тест подключения к Roboflow
// Не требует установки Python, Docker или inference server
// Просто: node test_rf.js

const https = require('https')
const http = require('http')
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

// ========================= Читаем конфиг =========================
const CFG_PATH = path.join(__dirname, 'config.json')
let RF_CFG = {
  apiKey: 'kTAPmOyqKcxeBTyi18FD',
  modelId: 'captchas-gz2yx/funtimecaptcha/1',
  detectUrl: 'http://localhost:9001',
  confidence: 25,
  overlap: 20
}

if (fs.existsSync(CFG_PATH)) {
  try {
    const raw = fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')
    const cfg = JSON.parse(raw)
    if (cfg.roboflow) Object.assign(RF_CFG, cfg.roboflow)
    console.log('[CFG] Загружен config.json')
  } catch (e) {
    console.log('[CFG] Не удалось прочитать config.json: ' + e.message)
  }
}

console.log('')
console.log('╔══════════════════════════════════════════════════════════╗')
console.log('║   ТЕСТ ROBLOX API ПОДКЛЮЧЕНИЯ  (без установки ничего)   ║')
console.log('╚══════════════════════════════════════════════════════════╝')
console.log('')
console.log('  apiKey:     ' + (RF_CFG.apiKey ? RF_CFG.apiKey.slice(0, 8) + '...' : '❌ ПУСТО'))
console.log('  modelId:    ' + RF_CFG.modelId)
console.log('  detectUrl:  ' + RF_CFG.detectUrl)
console.log('  confidence: ' + RF_CFG.confidence)
console.log('')

// ========================= Генерация тестового PNG =========================
const CRC = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  CRC[n] = c >>> 0
}
function crc32(b) {
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

function makeTestPng() {
  // 200x200 белая картинка с простой "капчей" - цифра "5" в центре
  const W = 200, H = 200
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    rgba[i*4] = 255; rgba[i*4+1] = 255; rgba[i*4+2] = 255; rgba[i*4+3] = 255
  }
  // Рисуем цифру "5" 30x42 пикселя
  const digit5 = [
    "111111",
    "100000",
    "100000",
    "111110",
    "000001",
    "000001",
    "111110",
    "100001",
    "111110"
  ]
  const ox = 85, oy = 79
  const sx = 5, sy = 5
  for (let py = 0; py < digit5.length; py++) {
    for (let px = 0; px < digit5[py].length; px++) {
      if (digit5[py][px] === '1') {
        for (let y = 0; y < sy; y++) {
          for (let x = 0; x < sx; x++) {
            const i = ((oy + py*sy + y) * W + (ox + px*sx + x)) * 4
            rgba[i] = 30; rgba[i+1] = 30; rgba[i+2] = 30
          }
        }
      }
    }
  }
  return encodePng(W, H, rgba)
}

// Также попробуем найти реальный PNG из records/
let realPng = null
try {
  const recordsDir = path.join(__dirname, 'records')
  if (fs.existsSync(recordsDir)) {
    const rounds = fs.readdirSync(recordsDir).filter(d => d.startsWith('live_round')).sort().reverse()
    for (const r of rounds) {
      const p = path.join(recordsDir, r, 'ORIGINAL_CAPTCHA.png')
      if (fs.existsSync(p)) {
        realPng = { path: p, buf: fs.readFileSync(p) }
        break
      }
    }
  }
} catch (e) {}

// ========================= HTTP helper =========================
function httpPost(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(new Error('bad url: ' + e.message)) }
    const mod = u.protocol === 'https:' ? https : http
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: headers,
      timeout: timeoutMs,
      // Игнорируем самоподписанные сертификаты (если есть локальный сервер)
      rejectUnauthorized: false
    }
    const t0 = Date.now()
    const req = mod.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          timeMs: Date.now() - t0
        })
      })
      res.on('error', e => reject(e))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + timeoutMs + 'ms')) })
    req.on('error', e => reject(e))
    if (body) req.write(body)
    req.end()
  })
}

function httpGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(new Error('bad url: ' + e.message)) }
    const mod = u.protocol === 'https:' ? https : http
    const t0 = Date.now()
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeout: timeoutMs,
      rejectUnauthorized: false
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), timeMs: Date.now() - t0 })
      })
      res.on('error', e => reject(e))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + timeoutMs + 'ms')) })
    req.on('error', e => reject(e))
  })
}

// ========================= Тесты =========================

async function testLocalServer() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('⚙️  TEST 1: Проверка локального сервера на ' + RF_CFG.detectUrl)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  
  try {
    const r = await httpGet(RF_CFG.detectUrl + '/', 2000)
    console.log('  ✅ Локальный сервер ОТВЕЧАЕТ: HTTP ' + r.status + ' (' + r.timeMs + 'ms)')
    return true
  } catch (e) {
    console.log('  ⚠️  Локальный сервер НЕ отвечает: ' + e.message)
    console.log('  → Это нормально, если вы ещё не запустили inference server.')
    return false
  }
}

async function testCloudRoboflow(pngBuffer, label) {
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('☁️  TEST 2: Cloud Roboflow (detect.roboflow.com) [' + label + ']')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  
  const model = String(RF_CFG.modelId).replace(/^\/+|\/+$/g, '')
  const url = 'https://detect.roboflow.com/' + model + 
              '?api_key=' + encodeURIComponent(RF_CFG.apiKey) +
              '&confidence=' + (RF_CFG.confidence || 25) +
              '&overlap=' + (RF_CFG.overlap || 20)
  
  console.log('  URL: POST ' + url)
  console.log('  Размер картинки: ' + pngBuffer.length + ' байт')
  
  try {
    const r = await httpPost(url, {
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.length,
      'User-Agent': 'MC_Bot_Test/1.0'
    }, pngBuffer, 15000)
    
    console.log('  Статус: ' + r.status + ' (' + r.timeMs + 'ms)')
    
    if (r.status >= 200 && r.status < 300) {
      try {
        const j = JSON.parse(r.body)
        const preds = j.predictions || j.results || []
        console.log('  ✅ УСПЕХ! Получено предсказаний: ' + preds.length)
        
        if (preds.length > 0) {
          console.log('')
          console.log('  Первые 5 результатов:')
          for (const p of preds.slice(0, 5)) {
            const cls = p.class || p.class_name || p.label || '?'
            const conf = p.confidence != null ? (p.confidence > 1 ? p.confidence.toFixed(1) + '%' : (p.confidence*100).toFixed(1) + '%') : '?'
            const x = p.x != null ? 'x=' + Math.round(p.x) : ''
            const y = p.y != null ? 'y=' + Math.round(p.y) : ''
            console.log('    • ' + cls.padEnd(10) + ' conf=' + conf.padEnd(7) + ' ' + x + ' ' + y)
          }
        } else {
          console.log('  ⚠️  Ответ валидный, но предсказаний 0 (картинка не похожа на капчу)')
          console.log('  Body (first 500): ' + r.body.slice(0, 500))
        }
        return { ok: true, status: r.status, preds: preds.length }
      } catch (e) {
        console.log('  ⚠️  Ответ получен, но не JSON: ' + r.body.slice(0, 300))
        return { ok: false, status: r.status }
      }
    } else {
      console.log('  ❌ HTTP ' + r.status + ': ' + r.body.slice(0, 300).replace(/\n/g, ' '))
      if (r.status === 401) console.log('     → Неверный API ключ. Проверьте roboflow.apiKey в config.json')
      if (r.status === 404) console.log('     → Модель не найдена. Проверьте roboflow.modelId')
      if (r.status === 429) console.log('     → Лимит запросов исчерпан. Подождите или используйте другой ключ')
      return { ok: false, status: r.status }
    }
  } catch (e) {
    console.log('  ❌ ОШИБКА: ' + e.message)
    if (/ECONNREFUSED|ETIMEDOUT/.test(e.message)) {
      console.log('     → Cloud Roboflow недоступен из вашей сети (блокировка провайдера/РКН).')
      console.log('     → Потребуется HTTP-прокси для обхода блокировки.')
    }
    return { ok: false, error: e.message }
  }
}

async function testLocalInfer(pngBuffer, label) {
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🏠 TEST 3: Inference на локальном сервере [' + label + ']')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  
  const base = RF_CFG.detectUrl.replace(/\/+$/, '')
  const model = String(RF_CFG.modelId).replace(/^\/+|\/+$/g, '')
  const url = base + '/' + model + 
              '?api_key=' + encodeURIComponent(RF_CFG.apiKey) +
              '&confidence=' + (RF_CFG.confidence || 25) +
              '&overlap=' + (RF_CFG.overlap || 20)
  
  console.log('  URL: POST ' + url)
  
  try {
    const r = await httpPost(url, {
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.length
    }, pngBuffer, 30000)
    
    console.log('  Статус: ' + r.status + ' (' + r.timeMs + 'ms)')
    
    if (r.status >= 200 && r.status < 300) {
      try {
        const j = JSON.parse(r.body)
        const preds = j.predictions || j.results || []
        console.log('  ✅ УСПЕХ! Предсказаний: ' + preds.length)
        for (const p of preds.slice(0, 5)) {
          const cls = p.class || p.class_name || p.label || '?'
          const conf = p.confidence != null ? (p.confidence > 1 ? p.confidence.toFixed(1) + '%' : (p.confidence*100).toFixed(1) + '%') : '?'
          console.log('    • ' + cls + ' (' + conf + ')')
        }
        return { ok: true, status: r.status }
      } catch (e) {
        console.log('  ⚠️  Не JSON: ' + r.body.slice(0, 300))
        return { ok: false, status: r.status }
      }
    } else {
      console.log('  ❌ ' + r.body.slice(0, 300))
      return { ok: false, status: r.status }
    }
  } catch (e) {
    console.log('  ❌ ' + e.message)
    return { ok: false, error: e.message }
  }
}

// ========================= Главная функция =========================

async function main() {
  const testPng = makeTestPng()
  console.log('[PNG] Синтетическая картинка: ' + testPng.length + ' байт (цифра "5" на белом фоне)')
  if (realPng) {
    console.log('[PNG] Найден реальный PNG из records: ' + realPng.path + ' (' + realPng.buf.length + ' байт)')
  }
  console.log('')
  
  // TEST 1: локальный сервер
  const localUp = await testLocalServer()
  
  let cloudOk = false
  let localOk = false
  
  // TEST 2: Cloud Roboflow (всегда проверяем)
  const cloud1 = await testCloudRoboflow(testPng, 'синтетика')
  if (cloud1.ok) cloudOk = true
  if (!cloud1.ok && realPng) {
    const cloud2 = await testCloudRoboflow(realPng.buf, 'реальная капча')
    if (cloud2.ok) cloudOk = true
  }
  
  // TEST 3: локальный сервер (только если он отвечает)
  if (localUp) {
    const loc1 = await testLocalInfer(testPng, 'синтетика')
    if (loc1.ok) localOk = true
    if (!loc1.ok && realPng) {
      const loc2 = await testLocalInfer(realPng.buf, 'реальная капча')
      if (loc2.ok) localOk = true
    }
  }
  
  // ========================= ИТОГОВЫЙ ОТЧЁТ =========================
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║                     ИТОГ                                ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')
  console.log('  Cloud Roboflow:  ' + (cloudOk ? '✅ РАБОТАЕТ' : '❌ НЕ РАБОТАЕТ'))
  console.log('  Local Server:    ' + (localUp ? (localOk ? '✅ РАБОТАЕТ' : '⚠️  Запущен, но inference не проходит') : '❌ НЕ ЗАПУЩЕН'))
  console.log('')
  
  if (cloudOk) {
    console.log('🎉 ОТЛИЧНО! Cloud Roboflow работает с вашим API ключом.')
    console.log('')
    console.log('Что делать дальше:')
    console.log('')
    console.log('  ┌───────────────────────────────────────────────────────┐')
    console.log('  │ ВАРИАНТ A: Использовать Cloud (просто и быстро)       │')
    console.log('  ├───────────────────────────────────────────────────────┤')
    console.log('  │ В config.json измените:                               │')
    console.log('  │   "detectUrl": "https://detect.roboflow.com",         │')
    console.log('  │   "serverlessUrl": "https://serverless.roboflow.com", │')
    console.log('  │                                                       │')
    console.log('  │ Но: нужен HTTP-прокси для обхода блокировок РФ.       │')
    console.log('  │ Добавьте в roboflow:                                  │')
    console.log('  │   "httpProxy": "http://user:pass@proxy.com:8080"      │')
    console.log('  └───────────────────────────────────────────────────────┘')
    console.log('')
    console.log('  ┌───────────────────────────────────────────────────────┐')
    console.log('  │ ВАРИАНТ B: Локальный сервер (быстрее, без прокси)     │')
    console.log('  ├───────────────────────────────────────────────────────┤')
    console.log('  │ 1. Установите Python 3.9+ с python.org                │')
    console.log('  │ 2. pip install inference                              │')
    console.log('  │ 3. inference server start --port 9001                 │')
    console.log('  │                                                       │')
    console.log('  │ Тогда оставьте в конфиге:                             │')
    console.log('  │   "detectUrl": "http://localhost:9001"                │')
    console.log('  │   (и НЕ нужен httpProxy)                              │')
    console.log('  └───────────────────────────────────────────────────────┘')
    console.log('')
    console.log('main.js v3.5.0 автоматически определит localhost и пойдёт')
    console.log('напрямую без SOCKS-прокси, а для cloud — через httpProxy.')
  } else if (localOk) {
    console.log('✅ Локальный сервер работает. Cloud недоступен (блокировка сети).')
    console.log('')
    console.log('Используйте localhost:9001 — он у вас уже работает.')
  } else {
    console.log('❌ НЕ РАБОТАЕТ ни cloud, ни локальный сервер.')
    console.log('')
    console.log('Возможные причины:')
    console.log('  1. Cloud Roboflow заблокирован провайдером/РКН')
    console.log('     → Решается HTTP-прокси (прокси-сервис с HTTPS-поддержкой)')
    console.log('  2. Неверный API ключ (попробуйте получить новый на roboflow.com)')
    console.log('  3. Лимит бесплатных запросов исчерпан')
    console.log('  4. Локальный сервер не установлен/не запущен')
    console.log('')
    console.log('Рекомендация: установите inference server локально.')
    console.log('  pip install inference')
    console.log('  inference server start --port 9001')
  }
  
  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('Тест завершён.')
  console.log('═══════════════════════════════════════════════════════════')
}

main().catch(e => {
  console.error('FATAL: ' + e.message)
  console.error(e.stack)
  process.exit(1)
})
