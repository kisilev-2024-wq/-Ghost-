// ========================= v3.7.31: ROBLOW SERVERLESS HTTP (DETAILED LOGGING) =========================
function rawRequestOnSocket(useTls, socket, hostname, port, method, reqPath, headers, body, timeoutMs) {
  return new Promise(resolve => {
    const mod = useTls ? https : http
    const defaultPort = useTls ? 443 : 80
    const hostHeader = (port && port !== defaultPort) ? (hostname + ':' + port) : hostname
    
    // v3.7.31: максимум browser-like заголовков для обхода Cloudflare
    const h = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive',
      'Host': hostHeader,
      'Origin': 'https://app.roboflow.com',
      'Referer': 'https://app.roboflow.com/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Ch-Ua': '"Google Chrome";v="129", "Chromium";v="129", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Ch-Ua-Platform-Version': '"15.0.0"',
      'Sec-Ch-Ua-Full-Version-List': '"Google Chrome";v="129.0.6668.100", "Chromium";v="129.0.6668.100", "Not_A Brand";v="24.0.0.0"',
      'Dnt': '1',
      'Upgrade-Insecure-Requests': '1'
    }, headers || {})
    
    if (body != null) h['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))
    
    const opts = { hostname, port, path: reqPath, method, timeout: timeoutMs, headers: h }
    if (socket) opts.socket = socket
    
    let done = false
    const finish = obj => { if (done) return; done = true; resolve(obj) }
    let req = null
    
    try {
      req = mod.request(opts, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', e => finish({ status: 0, body: 'RES ERR: ' + ((e && e.message) || e) }))
      })
    } catch (e) {
      finish({ status: 0, body: 'REQ THROW: ' + ((e && e.message) || e) })
      return
    }
    
    req.on('error', e => finish({ status: 0, body: 'REQ ERR: ' + ((e && e.message) || e) }))
    req.on('timeout', () => { try { req.destroy() } catch (e) {}; finish({ status: 0, body: 'TIMEOUT' }) })
    
    if (body != null) req.write(body)
    req.end()
  })
}

function socksConnectSocket(host, port, useTls, proxyHost, proxyPort, proxyUser, proxyPass) {
  return new Promise((resolve, reject) => {
    if (!proxyHost) { reject(new Error('proxy host пуст')); return }
    let settled = false
    const connTimeout = setTimeout(() => { if (settled) return; settled = true; reject(new Error('SOCKS timeout 30s')) }, 30000)
    SocksClient.createConnection({ proxy: { host: proxyHost, port: proxyPort, type: 5, userId: proxyUser, password: proxyPass }, command: 'connect', destination: { host, port } })
      .then(conn => {
        if (settled) { try { conn.socket.destroy() } catch (e) {}; return }
        if (!useTls) { settled = true; clearTimeout(connTimeout); resolve({ socket: conn.socket, cleanup() { try { conn.socket.destroy() } catch (e) {} } }); return }
        let secure = null
        const fail = e => { if (settled) return; settled = true; clearTimeout(connTimeout); try { conn.socket.destroy() } catch (x) {}; if (secure) try { secure.destroy() } catch (x) {}; reject(e) }
        try { 
          secure = tls.connect({ 
            socket: conn.socket, 
            servername: host, 
            minVersion: 'TLSv1.2',
            // v3.7.31: отключаем session tickets для меньшего fingerprint
            session: undefined
          }, () => { 
            if (settled) return
            settled = true
            clearTimeout(connTimeout)
            resolve({ socket: secure, cleanup() { try { secure.destroy() } catch (e) {}; try { conn.socket.destroy() } catch (e) {} } }) 
          }) 
        } catch (e) { fail(e); return }
        secure.on('error', fail)
        conn.socket.on('error', fail)
      }).catch(e => { if (settled) return; settled = true; clearTimeout(connTimeout); reject(e) })
  })
}

// v3.7.31: ЛОГИРУЕМ ВСЕ ошибки транспорта
async function rfPostOnce(transport, url, headers, body, timeoutMs) {
  let u = null
  try { u = new URL(url) } catch (e) { 
    step('[RF]    ❌ [' + transport + '] BAD URL: ' + ((e && e.message) || e))
    return { status: 0, body: 'BAD URL: ' + ((e && e.message) || e), via: transport } 
  }
  const useTls = u.protocol === 'https:'
  const port = Number(u.port || (useTls ? 443 : 80))
  const reqPath = u.pathname + u.search
  const hostname = u.hostname
  
  if (transport === 'direct') {
    step('[RF]    → [' + transport + '] запрос к ' + hostname + ':' + port)
    const r = await rawRequestOnSocket(useTls, null, hostname, port, 'POST', reqPath, headers, body, timeoutMs)
    r.via = 'direct'
    step('[RF]    ← [' + transport + '] status=' + r.status)
    return r
  }
  
  if (transport === 'socks') {
    step('[RF]    → [' + transport + '] подключение к ' + hostname + ':' + port + ' через ' + PROXY.host + ':' + PROXY.port)
    let sk = null
    try {
      sk = await socksConnectSocket(hostname, port, useTls, PROXY.host, PROXY.port, PROXY.username, PROXY.password)
      step('[RF]    ✓ [' + transport + '] SOCKS соединение установлено, отправляю запрос...')
    } catch (e) {
      const errMsg = ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || e)
      step('[RF]    ❌ [' + transport + '] SOCKS ошибка: ' + errMsg)
      return { status: 0, body: 'SOCKS ERR: ' + errMsg, via: 'socks' }
    }
    try {
      const r = await rawRequestOnSocket(useTls, sk.socket, hostname, port, 'POST', reqPath, headers, body, timeoutMs)
      r.via = 'socks'
      step('[RF]    ← [' + transport + '] status=' + r.status)
      return r
    } finally {
      try { sk.cleanup() } catch (e) {}
    }
  }
  
  return { status: 0, body: 'unknown transport', via: transport }
}

// v3.7.31: пробуем SOCKS ПЕРВЫМ, логируем ВСЕ попытки
async function rfPost(url, headers, body) {
  let u
  try { u = new URL(url) } catch (e) { return { status: 0, body: 'BAD URL', via: 'none' } }
  const timeoutMs = CLOUD_RF_TIMEOUT_MS
  
  // v3.7.31: порядок транспортов: SOCKS первым!
  const transports = []
  if (PROXY.host) transports.push('socks')
  transports.push('direct')
  
  step('[RF]  📡 Порядок транспортов: ' + transports.join(' → '))
  
  const attemptsLog = []
  let last = null
  
  for (const tr of transports) {
    const r = await rfPostOnce(tr, url, headers, body, timeoutMs)
    attemptsLog.push(tr + ':' + r.status)
    last = r
    const st = Number(r.status || 0)
    
    if (st >= 200 && st < 400) { 
      last._attempts = attemptsLog
      return last 
    }
    if (st === 401 || st === 404) { 
      last._attempts = attemptsLog
      return last 
    }
    
    // v3.7.31: 403 Cloudflare — пробуем следующий транспорт
    if (st === 403) {
      const bodyStr = String(r.body || '')
      if (bodyStr.includes('Cloudflare') || bodyStr.includes('Attention Required')) {
        step('[RF]  ⚠️ Cloudflare 403 via=' + tr + ', пробую следующий транспорт через 2с...')
        await sleep(2000)
        continue
      }
      // Если 403 но не Cloudflare — возвращаем сразу
      last._attempts = attemptsLog
      return last
    }
    
    // Другие ошибки — пробуем следующий
    await sleep(1000)
  }
  
  if (last) last._attempts = attemptsLog
  return last || { status: 0, body: 'no transport', via: 'none' }
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
  const m = s.match(/\d/)
  return m ? m[0] : null 
}
function rfNormConf(c) { c = Number(c || 0); if (c > 1) c = c / 100; return c }

function rfMetrics(preds) {
  const digits = []
  for (const p of preds) { 
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
      for (let j = i + 1; j < sorted.length; j++) { 
        if (Math.abs(sorted[j].y - sorted[i].y) <= band) group.push(sorted[j])
        else break 
      }
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

// v3.7.31: пробуем ОБА endpoint: serverless И detect через SOCKS
async function sendToRoboflow(pngBuffer, filename, debugDir, label) {
  if (!ROBOFLOW.enabled || !ROBOFLOW.apiKey) {
    return { ok: false, status: 0, attempt: 'disabled', predictions: [], metrics: rfMetrics([]), error: 'disabled' }
  }
  
  const key = String(ROBOFLOW.apiKey)
  const modelId = String(ROBOFLOW.modelId).replace(/^\/+|\/+$/g, '')
  const conf = encodeURIComponent(ROBOFLOW.confidence || 25)
  const ov = encodeURIComponent(ROBOFLOW.overlap || 20)
  
  // v3.7.31: 2 URL для попытки
  const endpoints = [
    { name: 'serverless', base: 'https://serverless.roboflow.com' },
    { name: 'detect',     base: 'https://detect.roboflow.com' }
  ]
  
  const boundary = '----WebKitFormBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  const mp = rfMultipart(pngBuffer, filename, boundary)
  
  // v3.7.31: перебираем оба endpoint
  for (const ep of endpoints) {
    const inferUrl = ep.base + '/' + modelId + '?confidence=' + conf + '&overlap=' + ov
    
    step('[RF] 🎯 Пробую endpoint: ' + ep.name + ' → ' + inferUrl)
    step('[RF]   Auth: Authorization: Bearer ' + key.slice(0, 6) + '...' + key.slice(-4))
    
    const attempts = [
      { 
        name: ep.name + '_multipart', 
        url: inferUrl, 
        headers: { 
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Authorization': 'Bearer ' + key
        }, 
        body: mp 
      },
      { 
        name: ep.name + '_raw', 
        url: inferUrl, 
        headers: { 
          'Content-Type': 'image/png',
          'Authorization': 'Bearer ' + key
        }, 
        body: pngBuffer 
      }
    ]
    
    let last = null
    for (const at of attempts) {
      const r = await rfPost(at.url, at.headers, at.body)
      const bodyPreview = String(r.body || '').slice(0, 500).replace(/\s+/g, ' ')
      step('[RF] Итог ' + at.name + ': status=' + r.status + ' via=' + (r.via || '?'))
      
      if (r.status === 401) {
        step('[RF] ❌ 401 — НЕВЕРНЫЙ API-КЛЮЧ!')
        return { ok: false, status: 401, attempt: at.name, predictions: [], metrics: rfMetrics([]), error: 'INVALID API KEY' }
      }
      if (r.status === 403) {
        const bodyStr = String(r.body || '')
        if (bodyStr.includes('Cloudflare') || bodyStr.includes('Attention Required')) {
          step('[RF] ❌ Cloudflare 403 на ' + ep.name + ' — пробую следующий endpoint через 3с...')
          await sleep(3000)
          break  // пробуем следующий endpoint
        }
        step('[RF] ❌ 403 Forbidden — нет доступа к модели')
        return { ok: false, status: 403, attempt: at.name, predictions: [], metrics: rfMetrics([]), error: 'ACCESS DENIED', raw: r.body }
      }
      if (r.status === 404) {
        step('[RF] ❌ 404 — модель ' + modelId + ' не найдена на ' + ep.name)
        break  // пробуем следующий endpoint
      }
      
      let json = null
      try { json = JSON.parse(r.body) } catch (e) {}
      const predictions = rfGetPredictions(json)
      const metrics = rfMetrics(predictions)
      const ok = r.status >= 200 && r.status < 300 && !!json
      
      const item = { 
        ok, status: r.status, attempt: at.name, url: at.url, json, predictions, metrics, 
        raw: String(r.body || '').slice(0, 3000), 
        attempts: r._attempts || [], 
        error: ok ? null : (bodyPreview.slice(0, 300) || 'HTTP ' + r.status),
        modelId: modelId
      }
      
      if (debugDir) {
        try {
          fs.mkdirSync(debugDir, { recursive: true })
          fs.writeFileSync(path.join(debugDir, 'roboflow_debug_' + at.name + '.txt'), 
            'STATUS: ' + r.status + '\nVIA: ' + (r.via || '?') + '\nURL: ' + inferUrl + 
            '\nATTEMPTS: ' + JSON.stringify(r._attempts || []) +
            '\nBODY:\n' + String(r.body || '').slice(0, 8000) + '\n')
        } catch (e) {}
      }
      
      if (label && typeof step === 'function') {
        step(label + ': RF ' + at.name + ' -> ' + r.status + ' via ' + (r.via || '?') + 
          (ok ? ' ✓ ЦИФР: ' + metrics.n + ' text="' + metrics.text + '"' 
              : ' ' + bodyPreview.slice(0, 140)))
      }
      
      if (ok) {
        step('[RF] ✅ ' + ep.name + ' РАБОТАЕТ! Запоминаю для следующих запросов.')
        return item
      }
      last = item
    }
    
    // Если на этом endpoint ничего не сработало — идем к следующему
    if (last) step('[RF] ⚠️ Endpoint ' + ep.name + ' не сработал, пробую следующий...')
  }
  
  return { ok: false, status: 0, attempt: 'none', predictions: [], metrics: rfMetrics([]), error: 'all endpoints failed' }
}
