// test_roboflow.js
// Тестовый скрипт для проверки локального Roboflow Inference Server
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ========================= Чтение конфига =========================
const CFG_PATH = path.join(__dirname, 'config.json')
const raw = fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')
const CFG = JSON.parse(raw)
const RF = CFG.roboflow

console.log('=== Roboflow connection test ===')
console.log('apiKey:', RF.apiKey)
console.log('modelId:', RF.modelId)
console.log('detectUrl:', RF.detectUrl)
console.log('serverlessUrl:', RF.serverlessUrl)
console.log('confidence:', RF.confidence, 'overlap:', RF.overlap)
console.log('')

// ========================= Генерация тестового PNG =========================
// Генерируем простой 128x128 PNG с цифрой "5" для теста
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
  // Простое изображение 200x200 с цифрой "5" (белый фон, чёрные пиксели)
  const W = 200, H = 200
  const rgba = Buffer.alloc(W * H * 4)
  // Фон белый
  for (let i = 0; i < W * H; i++) {
    rgba[i*4] = 255; rgba[i*4+1] = 255; rgba[i*4+2] = 255; rgba[i*4+3] = 255
  }
  // Простая цифра "5" в центре (30x50 пикселей)
  const digit5 = [
    "11111",
    "10000",
    "11110",
    "00001",
    "11110",
    "10001",
    "01110"
  ]
  const ox = 85, oy = 75
  const sx = 6, sy = 7
  for (let py = 0; py < 7; py++) {
    for (let px = 0; px < 5; px++) {
      if (digit5[py][px] === '1') {
        for (let y = 0; y < sy; y++) {
          for (let x = 0; x < sx; x++) {
            const i = ((oy + py*sy + y) * W + (ox + px*sx + x)) * 4
            rgba[i] = 0; rgba[i+1] = 0; rgba[i+2] = 0
          }
        }
      }
    }
  }
  return encodePng(W, H, rgba)
}

const testPng = makeTestPng()
console.log('Тестовый PNG: ' + testPng.length + ' байт')

// Ищем также реальный PNG из records/, если есть
let realPng = null
const recordsDir = path.join(__dirname, 'records')
if (fs.existsSync(recordsDir)) {
  const rounds = fs.readdirSync(recordsDir).filter(d => d.startsWith('live_round'))
  for (const r of rounds.slice(-3).reverse()) {
    const p = path.join(recordsDir, r, 'ORIGINAL_CAPTCHA.png')
    if (fs.existsSync(p)) {
      realPng = { path: p, buf: fs.readFileSync(p) }
      console.log('Найден реальный PNG: ' + p + ' (' + realPng.buf.length + ' байт)')
      break
    }
  }
}

// ========================= HTTP helper =========================
function httpPost(urlStr, headers, body, timeoutMs = 15000) {
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
      timeout: timeoutMs
    }
    
    const t0 = Date.now()
    const req = mod.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body,
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

function httpGet(urlStr, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(new Error('bad url: ' + e.message)) }
    
    const mod = u.protocol === 'https:' ? https : http
    const t0 = Date.now()
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeout: timeoutMs
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          timeMs: Date.now() - t0
        })
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + timeoutMs + 'ms')) })
    req.on('error', e => reject(e))
  })
}

// ========================= Тесты =========================
async function test1_health() {
  console.log('\n===== TEST 1: Health check =====')
  const base = RF.detectUrl.replace(/\/+$/, '')
  const url = base + '/'
  
  try {
    const r = await httpGet(url, 5000)
    console.log('GET ' + url + ' -> ' + r.status + ' (' + r.timeMs + 'ms)')
    console.log('Body (first 500 chars):')
    console.log(r.body.slice(0, 500))
    return r.status === 200
  } catch (e) {
    console.log('FAIL: ' + e.message)
    console.log('')
    console.log('⚠️  Сервер не отвечает! Проверьте:')
    console.log('   1. Запущен ли Roboflow Inference Server')
    console.log('   2. Команда запуска: pip install inference && inference server start')
    console.log('   3. Docker: docker run -p 9001:9001 roboflow/roboflow-inference-server-cpu')
    return false
  }
}

async function test2_models() {
  console.log('\n===== TEST 2: List available models =====')
  const base = RF.detectUrl.replace(/\/+$/, '')
  const url = base + '/model/registry'
  
  try {
    const r = await httpGet(url, 5000)
    console.log('GET ' + url + ' -> ' + r.status + ' (' + r.timeMs + 'ms)')
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body)
        console.log('Available models:')
        console.log(JSON.stringify(j, null, 2).slice(0, 2000))
      } catch (e) {
        console.log('Body: ' + r.body.slice(0, 500))
      }
    } else {
      console.log('Body: ' + r.body.slice(0, 500))
    }
  } catch (e) {
    console.log('FAIL: ' + e.message)
  }
}

async function test3_infer_direct(pngBuffer, label) {
  console.log('\n===== TEST 3: Inference (direct detect) [' + label + '] =====')
  const base = RF.detectUrl.replace(/\/+$/, '')
  const model = String(RF.modelId).replace(/^\/+|\/+$/g, '')
  const url = base + '/' + model + '?api_key=' + encodeURIComponent(RF.apiKey) + 
              '&confidence=' + (RF.confidence || 25) + 
              '&overlap=' + (RF.overlap || 20)
  
  console.log('POST ' + url)
  console.log('Image size: ' + pngBuffer.length + ' bytes')
  
  try {
    const r = await httpPost(url, {
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.length
    }, pngBuffer, 30000)
    
    console.log('Status: ' + r.status + ' (' + r.timeMs + 'ms)')
    console.log('Content-Type: ' + r.headers['content-type'])
    
    if (r.status >= 200 && r.status < 300) {
      try {
        const j = JSON.parse(r.body)
        console.log('✅ УСПЕХ! Предсказаний: ' + (j.predictions ? j.predictions.length : 'n/a'))
        console.log(JSON.stringify(j, null, 2).slice(0, 2000))
        return true
      } catch (e) {
        console.log('Body (не JSON): ' + r.body.slice(0, 500))
      }
    } else {
      console.log('❌ Body: ' + r.body.slice(0, 1000))
    }
    return false
  } catch (e) {
    console.log('FAIL: ' + e.message)
    return false
  }
}

async function test4_infer_multipart(pngBuffer, label) {
  console.log('\n===== TEST 4: Inference (multipart) [' + label + '] =====')
  const base = RF.serverlessUrl.replace(/\/+$/, '')
  const model = String(RF.modelId).replace(/^\/+|\/+$/g, '')
  const url = base + '/infer?model_id=' + model
  
  const boundary = '----TestBoundary' + Date.now()
  const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n')
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n')
  const body = Buffer.concat([head, pngBuffer, tail])
  
  console.log('POST ' + url)
  console.log('Multipart size: ' + body.length + ' bytes')
  
  try {
    const r = await httpPost(url, {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length,
      'Authorization': 'Bearer ' + RF.apiKey
    }, body, 30000)
    
    console.log('Status: ' + r.status + ' (' + r.timeMs + 'ms)')
    
    if (r.status >= 200 && r.status < 300) {
      try {
        const j = JSON.parse(r.body)
        console.log('✅ УСПЕХ! Предсказаний: ' + (j.predictions ? j.predictions.length : 'n/a'))
        console.log(JSON.stringify(j, null, 2).slice(0, 2000))
        return true
      } catch (e) {
        console.log('Body (не JSON): ' + r.body.slice(0, 500))
      }
    } else {
      console.log('❌ Body: ' + r.body.slice(0, 1000))
    }
    return false
  } catch (e) {
    console.log('FAIL: ' + e.message)
    return false
  }
}

async function test5_cloud_roboflow(pngBuffer) {
  console.log('\n===== TEST 5: Cloud Roboflow (detect.roboflow.com) =====')
  console.log('⚠️  Этот тест идёт напрямую на detect.roboflow.com БЕЗ прокси.')
  console.log('   Если у вас заблокирован roboflow.com на уровне сети — будет ECONNREFUSED.')
  
  const model = String(RF.modelId).replace(/^\/+|\/+$/g, '')
  const url = 'https://detect.roboflow.com/' + model + '?api_key=' + encodeURIComponent(RF.apiKey) + 
              '&confidence=' + (RF.confidence || 25) + 
              '&overlap=' + (RF.overlap || 20)
  
  console.log('POST ' + url)
  
  try {
    const r = await httpPost(url, {
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.length
    }, pngBuffer, 15000)
    
    console.log('Status: ' + r.status + ' (' + r.timeMs + 'ms)')
    if (r.status >= 200 && r.status < 300) {
      try {
        const j = JSON.parse(r.body)
        console.log('✅ Cloud Roboflow работает! Предсказаний: ' + (j.predictions ? j.predictions.length : 'n/a'))
        console.log(JSON.stringify(j, null, 2).slice(0, 1500))
      } catch (e) {
        console.log('Body: ' + r.body.slice(0, 500))
      }
    } else {
      console.log('❌ Body: ' + r.body.slice(0, 500))
    }
  } catch (e) {
    console.log('FAIL: ' + e.message)
    console.log('   Cloud Roboflow недоступен напрямую — нужен HTTP/HTTPS прокси')
  }
}

async function main() {
  const ok1 = await test1_health()
  
  if (!ok1) {
    console.log('\n❌ Сервер не запущен. Дальнейшие тесты бессмысленны.')
    process.exit(1)
  }
  
  await test2_models()
  
  // Тест на синтетическом PNG
  await test3_infer_direct(testPng, 'синтетический PNG "5"')
  
  // Тест на реальном PNG из records/, если есть
  if (realPng) {
    await test3_infer_direct(realPng.buf, 'реальная капча')
    await test4_infer_multipart(realPng.buf, 'реальная капча multipart')
  }
  
  await test5_cloud_roboflow(testPng)
  
  console.log('\n=== ИТОГО ===')
  console.log('Если TEST 3/4 прошли — локальный сервер работает, проблема была только в SOCKS.')
  console.log('Если TEST 5 прошёл — cloud Roboflow тоже доступен напрямую (без прокси).')
  console.log('Если TEST 5 упал с ECONNREFUSED — нужен HTTP-прокси для cloud.')
}

main().catch(e => {
  console.error('FATAL:', e.message)
  console.error(e.stack)
  process.exit(1)
})
