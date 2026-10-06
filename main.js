// rf_diag.js
// Прямая диагностика Roboflow: DNS, TLS, HTTP, API-статусы, тип ответа.
// БЕЗ прокси, БЕЗ обхода Cloudflare/WAF, БЕЗ подмены браузерных отпечатков, БЕЗ ретраев.
// Цель: понять, почему Roboflow не отвечает нормально, а не обойти защиту.

'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const dns = require('dns')
const tls = require('tls')
const zlib = require('zlib')

const REPORT_FILE = path.join(__dirname, 'rf_diag_report.json')
const CONFIG_CANDIDATES = [
  path.join(__dirname, 'config.json'),
  path.join(__dirname, '..', 'config.json')
]

const report = []

function log() {
  console.log.apply(console, arguments)
}

function hr() {
  log('-'.repeat(78))
}

function maskSecret(s) {
  s = String(s || '')
  if (!s) return 'EMPTY'
  if (s.length <= 8) return '***'
  return s.slice(0, 4) + '...' + s.slice(-4)
}

function maskUrl(u) {
  return String(u || '')
    .replace(/(api_key=)[^&]+/gi, '$1MASKED')
    .replace(/(key=)[^&]+/gi, '$1MASKED')
}

function safeJsonParse(s) {
  try { return JSON.parse(s) } catch (e) { return null }
}

function extractJsonText(t) {
  const s = String(t || '').replace(/^\uFEFF/, '')
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) return s.slice(i, j + 1)
  return s
}

function softCleanJson(t) {
  let s = String(t || '').replace(/^\uFEFF/, '')
  s = s.replace(/:\s*""(?=[^",\s\]}])/g, ': "')
  s = s.replace(/,\s*([}\]])/g, '$1')
  s = s.replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
  return s
}

function readConfig() {
  for (const p of CONFIG_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue
      const raw = fs.readFileSync(p, 'utf8')
      const candidates = [
        raw,
        extractJsonText(raw),
        softCleanJson(raw),
        softCleanJson(extractJsonText(raw))
      ]
      for (const c of candidates) {
        const parsed = safeJsonParse(c)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { path: p, ok: true, data: parsed }
        }
      }
      return { path: p, ok: false, error: 'JSON parse failed' }
    } catch (e) {
      return { path: p, ok: false, error: (e && e.message) || String(e) }
    }
  }
  return { path: null, ok: false, error: 'config.json not found' }
}

// ========================= PNG placeholder =========================
let CRC_TABLE = null

function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const tt = Buffer.from(type, 'ascii')
  const cr = Buffer.alloc(4)
  cr.writeUInt32BE(crc32(Buffer.concat([tt, data])), 0)
  return Buffer.concat([len, tt, data, cr])
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function makePlaceholderPng() {
  // 1x1 красный RGBA PNG. Нужен только для проверки транспорта/авторизации, не для качества OCR.
  const rgba = Buffer.from([255, 0, 0, 255])
  return encodePng(1, 1, rgba)
}

const PLACEHOLDER_PNG = makePlaceholderPng()

// ========================= DNS / TLS / HTTP =========================
function dnsLookup(host) {
  return new Promise(resolve => {
    try {
      dns.lookup(host, { all: true }, (err, addresses) => {
        if (err) {
          resolve({ ok: false, host: host, error: (err.code ? err.code + ' ' : '') + (err.message || String(err)) })
          return
        }
        resolve({
          ok: true,
          host: host,
          addresses: (addresses || []).map(a => String(a.address) + (a.family ? ' ipv' + a.family : ''))
        })
      })
    } catch (e) {
      resolve({ ok: false, host: host, error: (e && e.message) || String(e) })
    }
  })
}

function tlsCheck(host, port, timeoutMs) {
  port = Number(port || 443)
  timeoutMs = Number(timeoutMs || 15000)

  return new Promise(resolve => {
    let done = false
    const finish = obj => {
      if (done) return
      done = true
      resolve(obj)
    }

    let sock = null
    try {
      sock = tls.connect({
        host: host,
        port: port,
        servername: host,
        minVersion: 'TLSv1.2',
        timeout: timeoutMs
      }, () => {
        try {
          const cert = sock.getPeerCertificate(true)
          const proto = sock.getProtocol()
          const cipher = sock.getCipher()
          finish({
            ok: true,
            host: host,
            port: port,
            protocol: proto || '',
            cipher: cipher && cipher.name ? cipher.name : '',
            authorized: !!sock.authorized,
            authorizationError: sock.authorizationError || null,
            cert: cert ? {
              subjectCN: cert.subject && cert.subject.CN ? cert.subject.CN : '',
              issuerCN: cert.issuer && cert.issuer.CN ? cert.issuer.CN : '',
              validFrom: cert.valid_from || '',
              validTo: cert.valid_to || '',
              fingerprint256: cert.fingerprint256 || ''
            } : null
          })
        } catch (e) {
          finish({ ok: false, host: host, port: port, error: (e && e.message) || String(e) })
        } finally {
          try { sock.destroy() } catch (e) {}
        }
      })
    } catch (e) {
      finish({ ok: false, host: host, port: port, error: (e && e.message) || String(e) })
      return
    }

    sock.on('error', e => {
      finish({
        ok: false,
        host: host,
        port: port,
        error: ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e))
      })
      try { sock.destroy() } catch (x) {}
    })

    sock.on('timeout', () => {
      finish({ ok: false, host: host, port: port, error: 'TLS TIMEOUT ' + timeoutMs + 'ms' })
      try { sock.destroy() } catch (x) {}
    })
  })
}

function httpRequest(urlStr, options, timeoutMs) {
  options = options || {}
  timeoutMs = Number(timeoutMs || 20000)

  return new Promise(resolve => {
    let u = null
    try { u = new URL(urlStr) } catch (e) {
      resolve({ ok: false, url: maskUrl(urlStr), error: 'BAD_URL ' + ((e && e.message) || e) })
      return
    }

    const mod = u.protocol === 'https:' ? https : http
    const defaultPort = u.protocol === 'https:' ? 443 : 80
    const start = Date.now()
    let done = false

    const finish = obj => {
      if (done) return
      done = true
      obj.elapsedMs = Date.now() - start
      resolve(obj)
    }

    const reqOptions = {
      hostname: u.hostname,
      port: u.port || defaultPort,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: timeoutMs
    }

    let req = null
    try {
      req = mod.request(reqOptions, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const text = buf.toString('utf8')
          finish({
            ok: true,
            url: maskUrl(urlStr),
            status: res.statusCode,
            contentType: res.headers['content-type'] || '',
            server: res.headers['server'] || '',
            cfRay: res.headers['cf-ray'] || '',
            bodyBytes: buf.length,
            bodyText: text.slice(0, 4000)
          })
        })
        res.on('error', e => {
          finish({
            ok: false,
            url: maskUrl(urlStr),
            error: 'RES_ERR ' + ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e))
          })
        })
      })
    } catch (e) {
      finish({
        ok: false,
        url: maskUrl(urlStr),
        error: 'REQ_THROW ' + ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e))
      })
      return
    }

    req.on('error', e => {
      finish({
        ok: false,
        url: maskUrl(urlStr),
        error: 'REQ_ERR ' + ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || String(e))
      })
    })

    req.on('timeout', () => {
      try { req.destroy() } catch (e) {}
      finish({ ok: false, url: maskUrl(urlStr), error: 'HTTP TIMEOUT ' + timeoutMs + 'ms' })
    })

    if (options.body != null) req.write(options.body)
    req.end()
  })
}

function classifyResponse(r) {
  if (!r.ok) {
    return { verdict: 'NETWORK_ERROR', detail: r.error || 'unknown' }
  }

  const status = Number(r.status || 0)
  const ct = String(r.contentType || '').toLowerCase()
  const body = String(r.bodyText || '')
  const lower = body.toLowerCase()
  const trimmed = lower.trim()

  if (status >= 200 && status < 300) {
    if (ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const j = safeJsonParse(body)
      if (j && Array.isArray(j.predictions)) {
        return {
          verdict: 'OK_PREDICTIONS',
          predictionsCount: j.predictions.length,
          sample: j.predictions.slice(0, 3)
        }
      }
      if (j && (j.error || j.message || j.err)) {
        return { verdict: 'API_ERROR_JSON', error: j.error || j.message || j.err }
      }
      return { verdict: 'OK_JSON', sample: body.slice(0, 300) }
    }

    if (lower.includes('<!doctype') || lower.includes('<html')) {
      return {
        verdict: 'HTML_RESPONSE',
        detail: 'HTTP 2xx HTML. Может быть тестовой страницей эндпоинта или WAF/challenge страницей.'
      }
    }

    return { verdict: 'OK_OTHER', contentType: ct }
  }

  const looksHtml = lower.includes('<!doctype') || lower.includes('<html')
  const looksWaf = lower.includes('cloudflare') || lower.includes('cf-ray') || lower.includes('attention required') || lower.includes('just a moment') || lower.includes('checking your browser')

  if ((status === 401 || status === 403 || status === 503) && (looksHtml || looksWaf)) {
    return {
      verdict: 'WAF_OR_CLOUDFLARE_HTML_BLOCK',
      status: status,
      detail: 'Получен HTML-блок/challenge вместо JSON API. Это периметровая защита, не обычная ошибка Roboflow API.'
    }
  }

  if (status === 401) return { verdict: 'API_UNAUTHORIZED', detail: 'Невалидный или отсутствующий API-ключ.' }
  if (status === 403) {
    const j = safeJsonParse(body)
    return { verdict: 'API_FORBIDDEN', detail: (j && (j.error || j.message)) || 'Нет доступа к модели/ключу.' }
  }
  if (status === 404) return { verdict: 'NOT_FOUND', detail: 'Неверный путь, modelId или версия модели.' }
  if (status === 429) return { verdict: 'RATE_LIMITED', detail: 'Слишком много запросов / лимит.' }
  if (status >= 500) return { verdict: 'SERVER_ERROR', status: status }

  return { verdict: 'HTTP_' + status }
}

function multipartBody(buffer, filename, boundary) {
  const safeName = String(filename || 'image.png').replace(/"/g, '')
  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + safeName + '"\r\n' +
    'Content-Type: image/png\r\n\r\n'
  )
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n')
  return Buffer.concat([head, buffer, tail])
}

async function runRequest(name, url, options) {
  const masked = maskUrl(url)
  log('')
  hr()
  log('REQUEST: ' + name)
  log('URL: ' + masked)
  log('METHOD: ' + ((options && options.method) || 'GET'))

  const r = await httpRequest(url, options || {}, 20000)
  const c = classifyResponse(r)
  Object.assign(r, { name: name, url: masked }, c)

  log('ok: ' + (r.ok ? 'yes' : 'no'))
  log('status: ' + (r.status !== undefined ? r.status : (r.error || 'n/a')))
  log('verdict: ' + r.verdict)
  if (r.detail) log('detail: ' + r.detail)
  if (r.error) log('error: ' + r.error)
  if (r.contentType) log('content-type: ' + r.contentType)
  if (r.server) log('server: ' + r.server)
  if (r.cfRay) log('cf-ray: ' + r.cfRay)
  if (r.elapsedMs !== undefined) log('elapsed: ' + r.elapsedMs + 'ms')
  if (r.bodyBytes !== undefined) log('body bytes: ' + r.bodyBytes)
  if (r.predictionsCount !== undefined) log('predictions: ' + r.predictionsCount)
  if (r.bodyText) log('body snippet: ' + String(r.bodyText).replace(/\s+/g, ' ').slice(0, 360))

  report.push(r)
  return r
}

async function main() {
  log('Roboflow direct diagnostic')
  log('No proxy. No Cloudflare/WAF bypass. No browser fingerprint spoofing. No retry storm.')
  hr()

  const cfgInfo = readConfig()
  const cfg = cfgInfo.data || {}
  const rfCfg = cfg.roboflow || {}

  const apiKey = String(process.env.ROBOFLOW_API_KEY || rfCfg.apiKey || '')
  const modelId = String(process.env.ROBOFLOW_MODEL_ID || rfCfg.modelId || 'captchas-gz2yx/funtimecaptcha/1')
    .replace(/^\/+|\/+$/g, '')
  const detectBase = String(rfCfg.detectUrl || 'https://detect.roboflow.com').replace(/\/+$/, '')
  const serverlessBase = String(rfCfg.serverlessUrl || 'https://serverless.roboflow.com').replace(/\/+$/, '')
  const confidence = Number(rfCfg.confidence || 25)
  const overlap = Number(rfCfg.overlap || 20)
  const enabled = rfCfg.enabled !== false

  let imageBuffer = PLACEHOLDER_PNG
  let imageName = 'placeholder_1x1.png'
  let imageNote = 'placeholder 1x1 PNG used'

  if (process.argv[2]) {
    const p = path.resolve(process.argv[2])
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p)
      if (stat.size > 10 * 1024 * 1024) {
        imageNote = 'image too large (>10MB), fallback to placeholder'
      } else {
        imageBuffer = fs.readFileSync(p)
        imageName = path.basename(p)
        imageNote = 'user image used'
      }
    } else {
      imageNote = 'image path not found, fallback to placeholder'
    }
  }

  log('config path: ' + (cfgInfo.path || 'NOT FOUND'))
  log('config parse: ' + (cfgInfo.ok ? 'OK' : ('FAILED: ' + cfgInfo.error)))
  log('roboflow.enabled: ' + enabled)
  log('roboflow.apiKey: ' + maskSecret(apiKey))
  log('roboflow.modelId: ' + modelId)
  log('roboflow.detectUrl: ' + detectBase)
  log('roboflow.serverlessUrl: ' + serverlessBase)
  log('roboflow.confidence: ' + confidence)
  log('roboflow.overlap: ' + overlap)
  log('image: ' + imageName + ' (' + imageBuffer.length + ' bytes) - ' + imageNote)

  report.push({
    section: 'config',
    configPath: cfgInfo.path,
    configParseOk: cfgInfo.ok,
    configError: cfgInfo.error || null,
    enabled: enabled,
    apiKeyMasked: maskSecret(apiKey),
    modelId: modelId,
    detectBase: detectBase,
    serverlessBase: serverlessBase,
    confidence: confidence,
    overlap: overlap,
    imageFile: imageName,
    imageBytes: imageBuffer.length,
    imageNote: imageNote
  })

  let detectHost = ''
  let serverlessHost = ''
  try { detectHost = new URL(detectBase).hostname } catch (e) {}
  try { serverlessHost = new URL(serverlessBase).hostname } catch (e) {}

  hr()
  log('DNS / TLS CHECKS')

  if (detectHost) {
    const d = await dnsLookup(detectHost)
    log('')
    log('DNS ' + detectHost + ': ' + (d.ok ? d.addresses.join(', ') : ('ERROR ' + d.error)))
    report.push(Object.assign({ section: 'dns_detect' }, d))

    const t = await tlsCheck(detectHost, 443, 15000)
    log('TLS ' + detectHost + ': ' + (t.ok ? ('protocol=' + t.protocol + ' cipher=' + t.cipher + ' authorized=' + t.authorized) : ('ERROR ' + t.error)))
    if (t.ok && t.cert) {
      log('  cert subject CN: ' + t.cert.subjectCN)
      log('  cert issuer CN: ' + t.cert.issuerCN)
      log('  cert valid to: ' + t.cert.validTo)
      log('  cert fingerprint256: ' + t.cert.fingerprint256)
    }
    report.push(Object.assign({ section: 'tls_detect' }, t))
  }

  if (serverlessHost) {
    const d = await dnsLookup(serverlessHost)
    log('')
    log('DNS ' + serverlessHost + ': ' + (d.ok ? d.addresses.join(', ') : ('ERROR ' + d.error)))
    report.push(Object.assign({ section: 'dns_serverless' }, d))

    const t = await tlsCheck(serverlessHost, 443, 15000)
    log('TLS ' + serverlessHost + ': ' + (t.ok ? ('protocol=' + t.protocol + ' cipher=' + t.cipher + ' authorized=' + t.authorized) : ('ERROR ' + t.error)))
    if (t.ok && t.cert) {
      log('  cert subject CN: ' + t.cert.subjectCN)
      log('  cert issuer CN: ' + t.cert.issuerCN)
      log('  cert valid to: ' + t.cert.validTo)
      log('  cert fingerprint256: ' + t.cert.fingerprint256)
    }
    report.push(Object.assign({ section: 'tls_serverless' }, t))
  }

  hr()
  log('HTTP CHECKS')

  // 1. Корень detect. Обычно отдаёт HTML-форму/страницу. Если 403 HTML - видно сразу.
  await runRequest('detect_root_get', detectBase + '/', {
    method: 'GET',
    headers: {
      'Accept': 'text/html,application/json,*/*',
      'User-Agent': 'rf-diag/1.0'
    }
  })

  const detectInferUrl = detectBase + '/' + modelId +
    '?api_key=' + encodeURIComponent(apiKey) +
    '&confidence=' + encodeURIComponent(confidence) +
    '&overlap=' + encodeURIComponent(overlap)

  if (!apiKey) {
    log('')
    log('SKIP detect API POST: apiKey empty')
    report.push({ section: 'detect_api_post', skipped: true, reason: 'apiKey empty' })
  } else {
    // 2. detect multipart
    const b1 = '----RFDiagMultipart' + Date.now()
    const mp1 = multipartBody(imageBuffer, imageName, b1)
    await runRequest('detect_multipart_post', detectInferUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + b1,
        'Content-Length': mp1.length,
        'Accept': 'application/json',
        'User-Agent': 'rf-diag/1.0'
      },
      body: mp1
    })

    // 3. detect raw PNG
    await runRequest('detect_raw_post', detectInferUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': imageBuffer.length,
        'Accept': 'application/json',
        'User-Agent': 'rf-diag/1.0'
      },
      body: imageBuffer
    })
  }

  // 4. Корень serverless.
  await runRequest('serverless_root_get', serverlessBase + '/', {
    method: 'GET',
    headers: {
      'Accept': 'text/html,application/json,*/*',
      'User-Agent': 'rf-diag/1.0'
    }
  })

  // 5. Serverless infer. Формат может зависеть от версии Inference server.
  // Нужен только чтобы увидеть статус/тип ответа, не для обхода.
  if (!apiKey) {
    log('')
    log('SKIP serverless infer POST: apiKey empty')
    report.push({ section: 'serverless_infer_post', skipped: true, reason: 'apiKey empty' })
  } else {
    const b2 = '----RFDiagServerless' + Date.now()
    const mp2 = multipartBody(imageBuffer, imageName, b2)
    const inferUrl = serverlessBase + '/infer?model_id=' + encodeURIComponent(modelId)
    await runRequest('serverless_infer_bearer_post', inferUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + b2,
        'Content-Length': mp2.length,
        'Accept': 'application/json',
        'User-Agent': 'rf-diag/1.0'
      },
      body: mp2
    })
  }

  hr()
  log('SUMMARY')

  const verdicts = report.filter(x => x && x.verdict).map(x => x.name + ' -> ' + x.verdict)
  if (!verdicts.length) {
    log('No HTTP verdicts collected.')
  } else {
    for (const v of verdicts) log(v)
  }

  const allVerdicts = report.filter(x => x && x.verdict).map(x => x.verdict)
  const hasNetworkError = allVerdicts.includes('NETWORK_ERROR')
  const hasWafBlock = allVerdicts.includes('WAF_OR_CLOUDFLARE_HTML_BLOCK')
  const hasUnauthorized = allVerdicts.includes('API_UNAUTHORIZED')
  const hasForbidden = allVerdicts.includes('API_FORBIDDEN')
  const hasNotFound = allVerdicts.includes('NOT_FOUND')
  const hasPredictions = allVerdicts.includes('OK_PREDICTIONS')
  const hasApiErrorJson = allVerdicts.includes('API_ERROR_JSON')

  log('')
  log('INTERPRETATION')

  if (hasWafBlock) {
    log('- Есть WAF/Cloudflare HTML-блок. Это значит, что запрос не доходит до обычного JSON API Roboflow.')
    log('- Данный скрипт специально НЕ пытается обойти блок прокси, заголовками, ретраями или сменой отпечатка.')
    log('- Дальше только легальные варианты: поддержка Roboflow/Cloudflare, белый список, свой inference server, или отказ от внешнего Roboflow.')
  }

  if (hasNetworkError && !hasWafBlock) {
    log('- Есть сетевые ошибки без HTML-блока: firewall, антивирус, провайдер, DNS, TLS, обрыв TCP.')
    log('- Смотри error-строки: ECONNRESET, ETIMEDOUT, ENOTFOUND, CERT_*, SELF_SIGNED и т.п.')
  }

  if (hasUnauthorized) {
    log('- 401: API-ключ невалиден или не передан корректно.')
  }

  if (hasForbidden && !hasWafBlock) {
    log('- 403 JSON: ключ валиден, но нет доступа к модели/воркспейсу, или модель приватная.')
  }

  if (hasNotFound) {
    log('- 404: неверный modelId/версия или неверный путь эндпоинта.')
  }

  if (hasApiErrorJson) {
    log('- Roboflow ответил JSON-ошибкой. Значит транспорт и авторизация прошли дальше, чем при HTML-блоке.')
  }

  if (hasPredictions) {
    log('- Есть OK_PREDICTIONS: API отвечает предсказаниями. Если digits=0 в основном bot, проблема уже в модели/изображении/параметрах, не в транспорте.')
  }

  if (!hasWafBlock && !hasNetworkError && !hasUnauthorized && !hasForbidden && !hasNotFound && !hasPredictions && !hasApiErrorJson) {
    log('- Явного блока/ошибки авторизации не видно. Смотри статусы и body snippet выше.')
  }

  log('')
  log('Report JSON: ' + REPORT_FILE)
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8')
    log('Report saved.')
  } catch (e) {
    log('Failed to save report: ' + ((e && e.message) || e))
  }
}

main().catch(e => {
  console.error('FATAL: ' + ((e && e.stack) || (e && e.message) || e))
  process.exit(1)
})
