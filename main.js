// VERSION: 3.8.4
// main.js
// v3.8.4: БАЗА v3.7.32 + Tesseract.js (локально) вместо Roboflow API
//         + честная статистика (kicked = провал)
//         + авто-установка tesseract.js
//         + retry кандидатов при "неверно"
const mineflayer = require('mineflayer')
const { SocksClient } = require('socks')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const http = require('http')
const https = require('https')
const { spawn } = require('child_process')

const TARGET_ROUNDS = 10
const ATTEMPTS_PER_ROUND = 2
const PAUSE_BETWEEN_MS = 2000
const MIN_PLACED = 10
const SETTLE_MS = 2000
const CAPTCHA_TIMEOUT_MS = 60000
const CONNECT_TIMEOUT_MS = 35000
const LOGIN_TIMEOUT_MS = 30000
const MAX_ROTATIONS_ON_FAIL = 6
const VIEW_SIGN = 1
const SILENT_PASS_MS = 12000

const CREATE_NO_WINDOW = 0x08000000

// ========================= ГЛОБАЛЬНЫЕ =========================
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []
let REC_ROOT = null
let tesseractWorker = null
let Tesseract = null

function step(s) { const l = new Date().toISOString().slice(11, 19) + ' [step] ' + s; SLOG.push(l); console.log(l) }
function flushReport(extra) { if (!REC_ROOT) return; try { fs.writeFileSync(path.join(REC_ROOT, 'report_' + STAMP + '.txt'), SLOG.join('\n') + '\n' + (extra || '')) } catch (e) {} }
process.on('uncaughtException', e => { console.error('!!! UNCAUGHT !!!', e.message, '\n', e.stack); flushReport('UNCAUGHT: ' + (e.stack || e.message)); setTimeout(() => process.exit(1), 1000) })
process.on('unhandledRejection', e => { console.error('!!! REJECTION !!!', e); flushReport('REJECTION: ' + String(e)) })

// ========================= АВТО-УСТАНОВКА =========================
function ensurePackageJson() {
  const p = path.join(__dirname, 'package.json')
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ name: 'funtime-captcha-bot', version: '3.8.4', private: true, dependencies: {} }, null, 2))
}
function installPackage(name) {
  return new Promise((resolve, reject) => {
    step('[NPM] npm install ' + name)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', name, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: __dirname, stdio: 'inherit', shell: process.platform === 'win32' })
    const t = setTimeout(() => { try { child.kill() } catch (e) {} reject(new Error('таймаут установки ' + name)) }, 180000)
    child.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('npm exit ' + code)) })
    child.on('error', err => { clearTimeout(t); reject(err) })
  })
}
async function ensureDep(name) {
  const p = path.join(__dirname, 'node_modules', name, 'package.json')
  if (fs.existsSync(p)) { step('[SETUP] ✓ ' + name); return }
  step('[SETUP] 📦 ставлю ' + name + '...')
  await installPackage(name)
  if (!fs.existsSync(p)) throw new Error('не установился ' + name)
}
async function ensureAllDeps() {
  ensurePackageJson()
  await ensureDep('mineflayer'); await ensureDep('socks'); await ensureDep('tesseract.js')
  Tesseract = require('tesseract.js')
}

// ========================= КОНФИГ (из v3.7.32) =========================
let CFG_PARENT, CFG_LOCAL, CFG_PATH, CFG = {}, CFG_STRATEGY = 'none'

try {
  CFG_PARENT = path.join(__dirname, '..', 'config.json')
  CFG_LOCAL = path.join(__dirname, 'config.json')
  CFG_PATH = fs.existsSync(CFG_LOCAL) ? CFG_LOCAL : (fs.existsSync(CFG_PARENT) ? CFG_PARENT : null)
} catch (e) {}

function cfgGet(o, kp, d) { let c = o; for (const k of kp.split('.')) { if (!c || c[k] === undefined) return d; c = c[k] } return c }
function isEmptyCfgVal(v) { return v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v)) }
function softCleanJson(t) { let s = String(t || '').replace(/^\uFEFF/, ''); s = s.replace(/:\s*""(?=[^",\s\]}])/g, ': "'); s = s.replace(/,\s*([}\]])/g, '$1'); s = s.replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1'); return s }
function extractJsonObject(t) { const s = String(t || ''); const i = s.indexOf('{'); const j = s.lastIndexOf('}'); if (i >= 0 && j > i) return s.slice(i, j + 1); return '' }
function parseCfgRaw(raw) {
  const candidates = [String(raw || ''), softCleanJson(raw), extractJsonObject(raw), softCleanJson(extractJsonObject(raw))]
  for (const c of candidates) { if (!c) continue; try { const o = JSON.parse(c); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch (e) {} }
  return null
}
function sectionBody(raw, name) {
  const s = String(raw || ''); const keyRe = new RegExp('"' + name + '"\\s*:\\s*\\{'); const km = s.match(keyRe)
  if (!km) return ''; const start = km.index + km[0].length - 1
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) { const ch = s[i]; if (esc) { esc = false; continue }; if (ch === '\\') { esc = true; continue }; if (ch === '"') { inStr = !inStr; continue }; if (inStr) continue; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1) } }
  return ''
}
function grabIn(body, key) { const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1] : undefined }
function grabNumIn(body, key) { const m = String(body || '').match(new RegExp('"' + key + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)')); return m ? Number(m[1]) : undefined }
function regexCfg(raw) {
  const cfg = {}; const put = (sec, key, val) => { if (isEmptyCfgVal(val)) return; if (!cfg[sec]) cfg[sec] = {}; cfg[sec][key] = val }
  const mc = sectionBody(raw, 'minecraft'); if (mc) { put('minecraft', 'server', grabIn(mc, 'server')); put('minecraft', 'port', grabNumIn(mc, 'port')); put('minecraft', 'version', grabIn(mc, 'version')) }
  const px = sectionBody(raw, 'proxy'); if (px) { put('proxy', 'host', grabIn(px, 'host')); put('proxy', 'port', grabNumIn(px, 'port')); put('proxy', 'username', grabIn(px, 'username')); put('proxy', 'password', grabIn(px, 'password')); put('proxy', 'type', grabNumIn(px, 'type')); put('proxy', 'changeIpUrl', grabIn(px, 'changeIpUrl')); put('proxy', 'waitAfterIpChangeSec', grabNumIn(px, 'waitAfterIpChangeSec')) }
  const ac = sectionBody(raw, 'accounts'); if (ac) { put('accounts', 'nickPrefix', grabIn(ac, 'nickPrefix')); put('accounts', 'countDefault', grabNumIn(ac, 'countDefault')); put('accounts', 'sessionMinutes', grabNumIn(ac, 'sessionMinutes')) }
  return cfg
}
try {
  if (CFG_PATH) {
    let raw = ''; try { raw = fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '') } catch (e) {}
    const parsed = parseCfgRaw(raw); const fb = regexCfg(raw)
    if (parsed) { CFG = parsed; CFG_STRATEGY = 'json' }
    else if (Object.keys(fb).length) { CFG = fb; CFG_STRATEGY = 'regex-fallback' }
  }
} catch (e) {}

const MC = { host: cfgGet(CFG, 'minecraft.server', 'connect.funtime.su'), port: cfgGet(CFG, 'minecraft.port', 25565), version: cfgGet(CFG, 'minecraft.version', '1.21.1') }
const PROXY = { host: cfgGet(CFG, 'proxy.host', ''), port: cfgGet(CFG, 'proxy.port', 1080), username: cfgGet(CFG, 'proxy.username', ''), password: cfgGet(CFG, 'proxy.password', ''), changeIpUrl: cfgGet(CFG, 'proxy.changeIpUrl', ''), waitSec: cfgGet(CFG, 'proxy.waitAfterIpChangeSec', 12) }
const NICK_PREFIX = String(cfgGet(CFG, 'accounts.nickPrefix', 'Player')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'Player'

try { REC_ROOT = path.join(__dirname, 'records'); fs.mkdirSync(REC_ROOT, { recursive: true }) } catch (e) {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const badIPs = new Set()
let currentRunIp = null
let proxyDead = false

// ========================= HTTP / IP (из v3.7.32) =========================
function plainGet(urlStr, timeoutMs) {
  timeoutMs = timeoutMs || 15000
  const buildList = u => { u = String(u || ''); return u.startsWith('https:') ? [u, u.replace('https:', 'http:')] : [u, u.replace('http:', 'https:')] }
  return new Promise((resolve, reject) => {
    let stopped = false, lastErr = 'get failed'
    const attempt = (urls, idx, redirectsLeft, insecure) => {
      if (stopped) return
      if (idx >= urls.length) { stopped = true; reject(new Error(lastErr)); return }
      const u = urls[idx]; const mod = String(u).startsWith('https') ? https : http
      const opts = { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 MC_Bot/3.8.4', 'Accept': '*/*' } }
      if (insecure) opts.rejectUnauthorized = false
      let req = null
      const timer = setTimeout(() => { if (stopped) return; try { if (req) req.destroy() } catch (e) {}; lastErr = 'timeout'; attempt(urls, idx + 1, redirectsLeft, insecure) }, timeoutMs)
      try {
        req = mod.get(u, opts, res => {
          if (stopped) { try { res.resume() } catch (e) {}; return }
          clearTimeout(timer)
          const sc = res.statusCode
          if (sc >= 300 && sc < 400 && res.headers.location && redirectsLeft > 0) {
            let next = String(res.headers.location); try { next = new URL(next, u).toString() } catch (e) {}; try { res.resume() } catch (e) {}; attempt(buildList(next), 0, redirectsLeft - 1, insecure); return
          }
          let d = ''; try { res.setEncoding('utf8') } catch (e) {}
          res.on('data', c => { d += c; if (d.length > 200000) d = d.slice(-100000) })
          res.on('end', () => { if (stopped) return; stopped = true; resolve({ status: sc, body: d.trim() }) })
          res.on('error', e => { if (stopped) return; attempt(urls, idx + 1, redirectsLeft, insecure) })
        })
      } catch (e) { clearTimeout(timer); attempt(urls, idx + 1, redirectsLeft, insecure); return }
      req.on('error', e => { if (stopped) return; clearTimeout(timer); if (!insecure && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|HANDSHAKE|SSL|TLS/i.test((e && e.message) || '')) { attempt(urls, idx, redirectsLeft, true); return }; attempt(urls, idx + 1, redirectsLeft, insecure) })
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
      step('IP СМЕНЁН: ' + (oldIp || '?') + ' -> ' + newIp + ' за ' + Math.round((Date.now() - t0) / 1000) + 'с')
      currentRunIp = newIp; return newIp
    }
    step('IP не сменился')
  }
  currentRunIp = await currentIp(); return currentRunIp
}

// ========================= ПАЛИТРА / PNG =========================
const BASE_COLORS = [[0,0,0],[127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],[167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],[112,112,112],[64,128,255],[104,83,50],[255,252,245],[216,127,51],[178,76,216],[102,153,216],[229,229,51],[127,204,25],[242,127,165],[76,76,76],[153,153,153],[76,127,153],[127,63,178],[51,76,178],[102,76,51],[102,127,51],[153,51,51],[25,25,25],[250,238,77],[92,219,213],[74,128,255],[0,217,58],[135,107,58],[112,2,2],[143,119,100],[161,83,37],[149,88,108],[114,119,139],[186,133,35],[103,117,52],[160,77,78],[57,42,35],[135,106,97],[86,91,91],[118,70,86],[74,59,91],[77,51,35],[76,83,42],[143,61,46],[37,22,16],[189,48,49],[148,63,97],[126,32,44],[22,119,121],[58,142,140],[74,117,116],[23,121,121],[90,90,90],[224,169,112],[127,106,82],[221,169,46],[156,104,66]]
const SHADE_MULT = [135, 255, 220, 180]
const PALETTE = (() => { const p = new Uint8Array(256 * 3); for (let v = 0; v < 256; v++) { let r = 255, g = 255, b = 255; if (v !== 0) { const base = BASE_COLORS[v >> 2] || [0,0,0]; const m = SHADE_MULT[v & 3] / 255; r = Math.round(base[0]*m); g = Math.round(base[1]*m); b = Math.round(base[2]*m) } p[v*3]=r; p[v*3+1]=g; p[v*3+2]=b } return p })()
const LUM = (() => { const l = new Uint8Array(256); for (let v = 0; v < 256; v++) l[v] = Math.round(0.299*PALETTE[v*3] + 0.587*PALETTE[v*3+1] + 0.114*PALETTE[v*3+2]); return l })()

let CRC = null
function crc32(b) { if (!CRC) { CRC = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0 } } let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xff]; return (c ^ 0xffffffff) >>> 0 }
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]); const ih = Buffer.alloc(13); ih.writeUInt32BE(w,0); ih.writeUInt32BE(h,4); ih[8]=8; ih[9]=6
  const raw = Buffer.alloc((w*4+1)*h); for (let y=0;y<h;y++){ raw[y*(w*4+1)]=0; rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4) }
  const chunk=(t,d)=>{ const l=Buffer.alloc(4); l.writeUInt32BE(d.length,0); const tt=Buffer.from(t,'ascii'); const cr=Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt,d])),0); return Buffer.concat([l,tt,d,cr]) }
  return Buffer.concat([sig, chunk('IHDR',ih), chunk('IDAT',zlib.deflateSync(raw)), chunk('IEND',Buffer.alloc(0))])
}
function colorPng(data, W, H, sc) { const SW=W*sc, SH=H*sc, rgba=Buffer.alloc(SW*SH*4); for (let y=0;y<SH;y++) for (let x=0;x<SW;x++) { const v=data[Math.floor(y/sc)*W+Math.floor(x/sc)]; const i=(y*SW+x)*4; rgba[i]=PALETTE[v*3]; rgba[i+1]=PALETTE[v*3+1]; rgba[i+2]=PALETTE[v*3+2]; rgba[i+3]=255 } return encodePng(SW,SH,rgba) }
function bwPng(mask, W, H, sc) { const SW=W*sc,SH=H*sc,rgba=Buffer.alloc(SW*SH*4); for(let y=0;y<SH;y++)for(let x=0;x<SW;x++){ const v=mask[Math.floor(y/sc)*W+Math.floor(x/sc)]?30:255; const i=(y*SW+x)*4; rgba[i]=rgba[i+1]=rgba[i+2]=v; rgba[i+3]=255 } return encodePng(SW,SH,rgba) }
function maskToPng(m, w, h, invert, sc) {
  sc = sc || 1; const SW=w*sc, SH=h*sc, rgba=Buffer.alloc(SW*SH*4)
  for (let y=0;y<SH;y++) for (let x=0;x<SW;x++) {
    const d = m[Math.floor(y/sc)*w + Math.floor(x/sc)] ? 1 : 0
    const val = invert ? (d ? 255 : 0) : (d ? 0 : 255)
    const i=(y*SW+x)*4; rgba[i]=val; rgba[i+1]=val; rgba[i+2]=val; rgba[i+3]=255
  }
  return encodePng(SW,SH,rgba)
}

// ========================= МОРФОЛОГИЯ (из v3.7.32) =========================
const NB8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
function erode(m,W,H){const o=new Uint8Array(m.length);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(m[i]&&m[i-1]&&m[i+1]&&m[i-W]&&m[i+W])o[i]=1}return o}
function dilate(m,W,H){const o=new Uint8Array(m.length);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(m[i]||(x>0&&m[i-1])||(x<W-1&&m[i+1])||(y>0&&m[i-W])||(y<H-1&&m[i+W]))o[i]=1}return o}
function opening(m,W,H,r){let x=m;for(let i=0;i<r;i++)x=erode(x,W,H);for(let i=0;i<r;i++)x=dilate(x,W,H);return x}
function closing(m,W,H,r){let x=m;for(let i=0;i<r;i++)x=dilate(x,W,H);for(let i=0;i<r;i++)x=erode(x,W,H);return x}
function removeNoise(mask,W,H,minSize,minFill){minSize=minSize||5;minFill=minFill||0;const vis=new Uint8Array(mask.length),clean=new Uint8Array(mask.length);const i0=(x,y)=>y*W+x;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=i0(x,y);if(!mask[i]||vis[i])continue;const st=[x,y];vis[i]=1;const comp=[];let mnX=x,mxX=x,mnY=y,mxY=y;while(st.length){const cy=st.pop(),cx=st.pop();comp.push(cx,cy);if(cx<mnX)mnX=cx;if(cx>mxX)mxX=cx;if(cy<mnY)mnY=cy;if(cy>mxY)mxY=cy;for(const nb of NB8){const nx=cx+nb[0],ny=cy+nb[1];if(nx<0||ny<0||nx>=W||ny>=H)continue;const ni=i0(nx,ny);if(mask[ni]&&!vis[ni]){vis[ni]=1;st.push(nx,ny)}}};const cnt=comp.length/2,fill=cnt/((mxX-mnX+1)*(mxY-mnY+1));if(cnt>=minSize&&fill>=minFill)for(let k=0;k<comp.length;k+=2)clean[i0(comp[k],comp[k+1])]=1}return clean}
function dropLines(mask,W,H){const vis=new Uint8Array(mask.length),out=new Uint8Array(mask.length);const i0=(x,y)=>y*W+x;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=i0(x,y);if(!mask[i]||vis[i])continue;const st=[x,y];vis[i]=1;const comp=[];let mnX=x,mxX=x,mnY=y,mxY=y;while(st.length){const cy=st.pop(),cx=st.pop();comp.push(cx,cy);if(cx<mnX)mnX=cx;if(cx>mxX)mxX=cx;if(cy<mnY)mnY=cy;if(cy>mxY)mxY=cy;for(const nb of NB8){const nx=cx+nb[0],ny=cy+nb[1];if(nx<0||ny<0||nx>=W||ny>=H)continue;const ni=i0(nx,ny);if(mask[ni]&&!vis[ni]){vis[ni]=1;st.push(nx,ny)}}};const w=mxX-mnX+1,h=mxY-mnY+1;const isLine=(w>250||h>250)||(w+h>320&&(comp.length/2)/(w*h)<0.12);if(!isLine)for(let k=0;k<comp.length;k+=2)out[i0(comp[k],comp[k+1])]=1}return out}

// ========================= v3.7.32: РАБОЧАЯ СЕГМЕНТАЦИЯ =========================
function inkMaskWall(data,W,H){const wc=new Int32Array(256);for(let i=0;i<data.length;i++) wc[data[i]]++;const bgW=new Set();for(let v=1;v<256;v++) if(wc[v]>=6000 && LUM[v]>=120) bgW.add(v);const iso={};for(let v=1;v<256;v++){const c=wc[v];if(c<150||c>6000||bgW.has(v)||LUM[v]<120) continue;const stp=Math.max(1,Math.floor(c/300));let checked=0,isolated=0;for(let i=v%7;i<data.length&&checked<300;i+=stp){if(data[i]!==v)continue;const x=i%W,y=(i/W)|0;if(x<1||x>=W-1||y<1||y>=H-1)continue;checked++;let same=false;for(const nb of NB8){const nx=x+nb[0],ny=y+nb[1];if(data[ny*W+nx]===v){same=true;break}};if(!same)isolated++};iso[v]=checked?isolated/checked:0;if(iso[v]>=0.6)bgW.add(v)};const ink=new Uint8Array(data.length);for(let r=0;r<H/128;r++)for(let c=0;c<W/128;c++){const counts=new Int32Array(256);const x0=c*128,y0=r*128;for(let y=0;y<128;y++)for(let x=0;x<128;x++)counts[data[(y0+y)*W+x0+x]]++;const bg=new Set(bgW);for(let v=1;v<256;v++){if(LUM[v]>=120 && (counts[v]>=1200 || (iso[v]||0)>=0.6)) bg.add(v)};for(let y=0;y<128;y++)for(let x=0;x<128;x++){const i=(y0+y)*W+x0+x;const v=data[i];if(v!==0&&!bg.has(v))ink[i]=1}};let n=0;for(let i=0;i<ink.length;i++) if(ink[i]) n++;return { ink, inkCount:n }}
function thickScore(ink,W,H){let s=0;for(let y=0;y<H-1;y++)for(let x=0;x<W-1;x++){const i=y*W+x;if(ink[i]&&ink[i+1]&&ink[i+W]&&ink[i+W+1])s++}return s}

function compsList(mask, W, H, wantPx) {
  const vis = new Uint8Array(mask.length), out = []; const i0 = (x,y) => y*W+x
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = i0(x,y); if (!mask[i] || vis[i]) continue
    const st = [x,y]; vis[i] = 1; let a = 0, mnX = x, mxX = x, mnY = y, mxY = y
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; const px = wantPx ? [i] : null
    while (st.length) { const cy = st.pop(), cx = st.pop(); a++; sx += cx; sy += cy; sxx += cx*cx; syy += cy*cy; sxy += cx*cy; if (cx<mnX) mnX=cx; if (cx>mxX) mxX=cx; if (cy<mnY) mnY=cy; if (cy>mxY) mxY=cy; for (const nb of NB8) { const nx=cx+nb[0], ny=cy+nb[1]; if (nx<0||ny<0||nx>=W||ny>=H) continue; const ni = i0(nx,ny); if (mask[ni] && !vis[ni]) { vis[ni]=1; st.push(nx,ny); if (wantPx) px.push(ni) } } }
    const mx = sx/a, my = sy/a, vx = sxx/a - mx*mx, vy = syy/a - my*my, vxy = sxy/a - mx*my
    const half = (vx + vy) / 2, det = vx*vy - vxy*vxy; const disc = Math.sqrt(Math.max(0, half*half - Math.max(0, det)))
    out.push({ mnX, mxX, mnY, mxY, a, px, varMinor: Math.max(0, half - disc), cx: mx, cy: my })
  }
  return out
}
function isStraight(c, w, h) { return c.varMinor < 10 && (w + h) > 100 }

// АНАЛИЗ ЦВЕТОВ ИЗ v3.7.32 — РАБОТАЛ!
function analyzeColors(data, ink, W, H) {
  const colorCounts = new Int32Array(256); for (let i = 0; i < ink.length; i++) if (ink[i]) colorCounts[data[i]]++
  const digitMask = new Uint8Array(ink.length), cands = []; let dmColor = 0
  for (let v = 1; v < 256; v++) {
    if (colorCounts[v] < 60) continue
    const m = new Uint8Array(ink.length); for (let i = 0; i < ink.length; i++) if (ink[i] && data[i] === v) m[i] = 1
    const comps = compsList(m, W, H, true)
    for (const c of comps) {
      const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
      if (c.a < 80) continue
      if (h < H * 0.07 || h > H * 0.85) continue
      if (w < W * 0.02 || w > W * 0.30) continue
      if (w + h > W * 0.75) continue
      const fill = c.a / (w * h); if (fill < 0.05 || fill > 0.97) continue
      if (isStraight(c, w, h)) continue
      dmColor++; cands.push({ cx: c.cx, cy: c.cy, w, h })
      for (let k = 0; k < c.px.length; k++) digitMask[c.px[k]] = 1
    }
  }
  return { dmColor, digitMask, cands }
}
function rowScore(cands, H) {
  if (!cands.length) return 0; const sorted = cands.slice().sort((a, b) => a.cy - b.cy); let best = 0
  for (let i = 0; i < sorted.length; i++) { const band = [sorted[i]]; for (let j = i + 1; j < sorted.length; j++) { if (sorted[j].cy - sorted[i].cy <= H * 0.25) band.push(sorted[j]); else break }; band.sort((a, b) => a.cx - b.cx); let cnt = 0, lastRight = -1; for (const c of band) { const left = c.cx - c.w / 2, right = c.cx + c.w / 2; if (left >= lastRight - 2) { cnt++; lastRight = right } }; if (cnt > best) best = cnt }
  return best
}

// ========================= FALLBACK pattern OCR =========================
const DIGITS={'0':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'1':[[0,0,1,0,0],[0,1,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,1,1,0]],'2':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]],'3':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'4':[[0,0,0,1,0],[0,0,1,1,0],[0,1,0,1,0],[1,0,0,1,0],[1,1,1,1,1],[0,0,0,1,0],[0,0,0,1,0]],'5':[[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'6':[[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'7':[[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],'8':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'9':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,1],[0,0,0,0,1],[0,0,0,0,1],[0,1,1,1,0]]}
function matchPat(mask,W,H,bx,by,bw,bh){const pat=[];for(let py=0;py<7;py++){const row=[];for(let px=0;px<5;px++){const sx=bx+Math.floor(px*bw/5),ex=bx+Math.floor((px+1)*bw/5),sy=by+Math.floor(py*bh/7),ey=by+Math.floor((py+1)*bh/7);let c=0,t=0;for(let y=sy;y<ey;y++)for(let x=sx;x<ex;x++){c+=mask[y*W+x];t++};row.push(t&&(c/t)>0.35?1:0)};pat.push(row)};let bd='?',bs=0;for(const d in DIGITS){let m=0;for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(pat[y][x]===DIGITS[d][y][x])m++;const s=m/35;if(s>bs){bs=s;bd=d}};return{best:bd,score:Math.round(bs*100)/100}}
function ocr(mask,W,H){const digits=[];for (const c of compsList(mask, W, H, false)) {const w=c.mxX-c.mnX+1,h=c.mxY-c.mnY+1;if(c.a<Math.max(80,W*H/1600))continue;if(w<W*0.02||w>W*0.5)continue;if(h<H*0.07||h>H*0.92)continue;if(isStraight(c,w,h))continue;const m=matchPat(mask,W,H,c.mnX,c.mnY,w,h);digits.push({x:c.mnX,best:m.best,score:m.score})};digits.sort((a,b)=>a.x-b.x);let text='';for(const d of digits) if(d.score>=0.5) text+=d.best;return { text, digits }}
function pickOcr(vars, W, H) {
  let best = null
  for (const v of vars) { const r = ocr(v.mask, W, H); const n = r.digits.filter(d => d.score >= 0.5).length; const plausible = n >= 4 && n <= 6; const conf = n > 6 ? 0 : r.digits.filter(d => d.score >= 0.65).reduce((a, d) => a + d.score, 0); const score = (plausible ? 1000 : 0) + conf * 100 + n * 10 + r.digits.reduce((a, d) => a + d.score, 0) - (n > 6 ? 800 : 0); if (!best || score > best.score) best = { name: v.name, text: r.text, n, plausible, conf, score } }
  return best
}
function buildVariants(ink, digitMask, W, H){return [{name:'v09_colordigits',mask:digitMask},{name:'v08_drop_raw',mask:dropLines(ink,W,H)},{name:'v06_drop_open2',mask:dropLines(opening(ink,W,H,2),W,H)},{name:'v07_drop_open3',mask:dropLines(opening(ink,W,H,3),W,H)},{name:'v00_open2',mask:opening(ink,W,H,2)},{name:'v01_open3',mask:opening(ink,W,H,3)},{name:'v02_open4',mask:opening(ink,W,H,4)},{name:'v03_close1_open2',mask:opening(closing(ink,W,H,1),W,H,2)},{name:'v04_open2_keepbig',mask:removeNoise(opening(ink,W,H,2),W,H,300,0)},{name:'v05_open3_keepbig',mask:removeNoise(opening(ink,W,H,3),W,H,300,0)}]}

// ========================= TESSERACT =========================
async function initTesseract() {
  if (tesseractWorker) return tesseractWorker
  step('[OCR] 🚀 Инициализация Tesseract...')
  tesseractWorker = await Tesseract.createWorker('eng', 1, {
    logger: m => { if (m.status === 'loading language traineddata' && m.progress > 0 && m.progress < 1) process.stdout.write('\r[OCR] 📥 lang: ' + Math.round(m.progress*100) + '%   ') }
  })
  process.stdout.write('\n')
  await tesseractWorker.setParameters({ tessedit_char_whitelist: '0123456789' })
  step('[OCR] ✅ Tesseract готов')
  return tesseractWorker
}

// v3.8.4: ПОЛНЫЙ OCR СТЕНЫ — используя analyzeColors из v3.7.32
async function ocrWall(data, W, H, ink, label, debugDir) {
  const ac = analyzeColors(data, ink, W, H)
  step('[OCR] ' + label + ': dmColor=' + ac.dmColor + ' cands=' + ac.cands.length)
  
  if (ac.dmColor < 2) {
    step('[OCR] ' + label + ': ❌ мало цветных цифр')
    return []
  }
  
  // bbox всей digitMask
  let mnX=W, mnY=H, mxX=-1, mxY=-1
  for (let i = 0; i < ac.digitMask.length; i++) {
    if (ac.digitMask[i]) {
      const x = i % W, y = (i/W)|0
      if (x<mnX) mnX=x; if (x>mxX) mxX=x; if (y<mnY) mnY=y; if (y>mxY) mxY=y
    }
  }
  if (mxX < 0) { step('[OCR] ' + label + ': ❌ маска пуста'); return [] }
  
  const bbox = { x: mnX, y: mnY, w: mxX-mnX+1, h: mxY-mnY+1 }
  step('[OCR] ' + label + ': bbox=' + bbox.w + 'x' + bbox.h)
  
  // чистим маску
  let mask = closing(ac.digitMask, W, H, 1)
  mask = removeNoise(mask, W, H, 15, 0)
  
  // crop + upscale
  const pad = 6
  const cw = bbox.w + pad*2, ch = bbox.h + pad*2
  const cropped = new Uint8Array(cw*ch)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = bbox.x - pad + x, sy = bbox.y - pad + y
    if (sx >= 0 && sy >= 0 && sx < W && sy < H) cropped[y*cw+x] = mask[sy*W+sx] ? 1 : 0
  }
  const scale = ch < 30 ? 5 : ch < 60 ? 3 : 2
  
  const pngB = maskToPng(cropped, cw, ch, false, scale)
  const pngW = maskToPng(cropped, cw, ch, true, scale)
  
  if (debugDir) {
    try {
      fs.mkdirSync(debugDir, { recursive: true })
      fs.writeFileSync(path.join(debugDir, 'wall_' + label + '.png'), colorPng(data, W, H, 2))
      fs.writeFileSync(path.join(debugDir, 'mask_' + label + '.png'), bwPng(mask, W, H, 2))
      fs.writeFileSync(path.join(debugDir, 'crop_' + label + '.png'), pngB)
    } catch (e) {}
  }
  
  const worker = await initTesseract()
  const candidates = []
  const push = (digits, conf, src) => {
    const d = String(digits).replace(/[^0-9]/g, '')
    if (d.length >= 4 && d.length <= 8 && !candidates.some(c => c.digits === d)) {
      candidates.push({ digits: d, conf, src })
    }
  }
  
  // 1) Tesseract line (psm 7, 6)
  for (const psm of ['7', '6']) {
    for (let inv = 0; inv < 2; inv++) {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: psm })
        const r = await worker.recognize(inv ? pngW : pngB)
        push((r.data.text || '').replace(/\s+/g, ''), r.data.confidence || 0, 'tess-psm' + psm + (inv ? '-inv' : ''))
      } catch (e) {}
    }
  }
  
  // 2) Per-digit (psm 10) для каждой компоненты
  const comps = compsList(mask, W, H, false).filter(c => {
    const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
    return c.a >= 40 && w >= 8 && w <= bbox.w && h >= bbox.h * 0.3 && h <= bbox.h * 1.2
  }).sort((a, b) => a.cx - b.cx)
  
  if (comps.length >= 3 && comps.length <= 9) {
    let pdText = '', pdSumConf = 0, pdCount = 0
    for (const c of comps) {
      const dw = c.mxX - c.mnX + 1, dh = c.mxY - c.mnY + 1
      const dcw = dw + 6, dch = dh + 6
      const dm = new Uint8Array(dcw*dch)
      for (let y = 0; y < dch; y++) for (let x = 0; x < dcw; x++) {
        const sx = c.mnX - 3 + x, sy = c.mnY - 3 + y
        if (sx >= 0 && sy >= 0 && sx < W && sy < H) dm[y*dcw+x] = mask[sy*W+sx] ? 1 : 0
      }
      const dsc = dch < 20 ? 5 : dch < 40 ? 3 : 2
      const dpng = maskToPng(dm, dcw, dch, false, dsc)
      let bestD = null
      try {
        await worker.setParameters({ tessedit_pageseg_mode: '10' })
        const r = await worker.recognize(dpng)
        const d = (r.data.text || '').replace(/[^0-9]/g, '')
        if (d.length === 1) bestD = { d, conf: r.data.confidence || 0, src: 'tess10' }
      } catch (e) {}
      // fallback pattern
      const pm = matchPat(mask, W, H, c.mnX, c.mnY, dw, dh)
      if (!bestD || (bestD.conf < 50 && pm.score >= 0.8)) bestD = { d: pm.best, conf: pm.score * 100, src: 'pattern' }
      if (bestD && bestD.d) { pdText += bestD.d; pdSumConf += bestD.conf; pdCount++ }
      else pdText += '?'
    }
    if (!pdText.includes('?') && pdCount >= 3) push(pdText, pdSumConf / pdCount, 'per-digit')
    step('[OCR] ' + label + ': per-digit "' + pdText + '" (' + comps.length + ' comps)')
  }
  
  // 3) Pattern OCR по всем вариантам
  const vars = buildVariants(ink, ac.digitMask, W, H)
  const pick = pickOcr(vars, W, H)
  if (pick && pick.text) push(pick.text, pick.conf + 40, 'pattern-' + pick.name)
  
  candidates.sort((a, b) => b.conf - a.conf)
  step('[OCR] ' + label + ': ' + candidates.length + ' кандидатов' + (candidates[0] ? ' лучший="' + candidates[0].digits + '" (' + candidates[0].src + ')' : ''))
  for (const c of candidates.slice(0, 5)) step('[OCR]   "' + c.digits + '" conf=' + c.conf.toFixed(1) + ' [' + c.src + ']')
  return candidates
}

// ========================= СБОРКА СТЕНЫ (из v3.7.32) =========================
function rotQ(d,q){q=((q%4)+4)%4;if(!q)return Uint8Array.from(d);const o=new Uint8Array(16384);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const v=d[y*128+x];if(q===1)o[x*128+127-y]=v;else if(q===2)o[(127-y)*128+(127-x)]=v;else o[(127-x)*128+y]=v};return o}
function clusterWalls(frames){const counts={};frames.forEach(f=>{counts['x:'+Math.round(f.x)]=(counts['x:'+Math.round(f.x)]||0)+1;counts['z:'+Math.round(f.z)]=(counts['z:'+Math.round(f.z)]||0)+1});const planes=Object.entries(counts).filter(([,v])=>v>=8).sort((a,b)=>b[1]-a[1]);const walls=[],used=new Set();for(const[key]of planes){const[axis,val]=key.split(':');const members=frames.filter(f=>!used.has(f.id)&&Math.round(f[axis])===+val);if(members.length<8)continue;members.forEach(f=>used.add(f.id));let fSign=0;for(const f of members){const fr=f[axis]-Math.floor(f[axis]);if(Math.abs(fr-0.5)>0.1){fSign=fr<0.5?1:-1;break}};if(!fSign)fSign=1;walls.push({axis,value:+val,frames:members,fSign,tag:axis+val});if(walls.length===2)break};return walls}
function clusterCoords(vals) { if (!vals || !vals.length) return []; const sorted = vals.slice().sort((a, b) => a - b); const clusters = []; let cur = [sorted[0]]; for (let i = 1; i < sorted.length; i++) { if (sorted[i] - cur[0] < 0.6) cur.push(sorted[i]); else { clusters.push(cur.reduce((s, x) => s + x, 0) / cur.length); cur = [sorted[i]] } }; clusters.push(cur.reduce((s, x) => s + x, 0) / cur.length); return clusters }
function wallCellsAdvanced(wall) { const horiz = wall.axis === 'x' ? 'z' : 'x'; const hVals = wall.frames.map(f => f[horiz]); const yVals = wall.frames.map(f => f.y); const hCenters = clusterCoords(hVals); const yCenters = clusterCoords(yVals); const orientations = [{hAsc:true,yAsc:false},{hAsc:false,yAsc:false},{hAsc:true,yAsc:true},{hAsc:false,yAsc:true}]; const cols = hCenters.length, rows = yCenters.length; if (cols * rows !== wall.frames.length) return null; const results = []; for (const ori of orientations) { const hs = ori.hAsc ? hCenters.slice() : hCenters.slice().reverse(); const ys = ori.yAsc ? yCenters.slice() : yCenters.slice().reverse(); const cells = new Array(cols * rows).fill(null); let missing = 0; for (const f of wall.frames) { let bestH = 0, minDh = 1e9; for (let i = 0; i < hs.length; i++) { const d = Math.abs(f[horiz] - hs[i]); if (d < minDh) { minDh = d; bestH = i } }; let bestY = 0, minDy = 1e9; for (let i = 0; i < ys.length; i++) { const d = Math.abs(f.y - ys[i]); if (d < minDy) { minDy = d; bestY = i } }; const idx = bestY * cols + bestH; if (cells[idx]) missing++; cells[idx] = f }; if (missing > 0 || cells.some(c => !c)) continue; results.push({ cells, cols, rows, ori }) }; return results.length ? results : null }
function seamV_ink(inkA, inkB) { let cost = 0; for (let y = 0; y < 128; y++) { const va = inkA[y * 128 + 127], vb = inkB[y * 128 + 0]; if (va !== vb) { const va1 = y > 0 ? inkA[(y - 1) * 128 + 127] : 0, va2 = y < 127 ? inkA[(y + 1) * 128 + 127] : 0, vb1 = y > 0 ? inkB[(y - 1) * 128 + 0] : 0, vb2 = y < 127 ? inkB[(y + 1) * 128 + 0] : 0, vaL = inkA[y * 128 + 126], vbR = inkB[y * 128 + 1]; if (va === vb1 || va === vb2 || vaL === vb || va1 === vb || va2 === vb) cost += 2; else cost += 10 } }; return cost }
function seamH_ink(inkA, inkB) { let cost = 0; for (let x = 0; x < 128; x++) { const va = inkA[127 * 128 + x], vb = inkB[0 * 128 + x]; if (va !== vb) { const vaL = x > 0 ? inkA[127 * 128 + x - 1] : 0, vaR = x < 127 ? inkA[127 * 128 + x + 1] : 0, vbL = x > 0 ? inkB[0 * 128 + x - 1] : 0, vbR = x < 127 ? inkB[0 * 128 + x + 1] : 0, vaU = inkA[126 * 128 + x], vbD = inkB[1 * 128 + x]; if (va === vbL || va === vbR || vaL === vb || vaR === vb || vaU === vb || va === vbD) cost += 2; else cost += 10 } }; return cost }
function perms(arr) { if (arr.length <= 1) return [arr.slice()]; const res = []; for (let i = 0; i < arr.length; i++) { const rest = arr.slice(0, i).concat(arr.slice(i + 1)); for (const p of perms(rest)) res.push([arr[i]].concat(p)) }; return res }
function assembleWall(wall,tiles,raw){const wca = wallCellsAdvanced(wall);if(!wca || !wca.length) return null;const wc = wca[0];const W=wc.cols*128,H=wc.rows*128;const out=new Uint8Array(W*H);let placed=0;for(let i=0;i<wc.cells.length;i++){const f=wc.cells[i];const t=tiles.get(f.mapId);if(!t)continue;const q=raw?0:((f.rotation||0)%4);const d=rotQ(t,q);const cx=(i%wc.cols)*128,cy=((i/wc.cols)|0)*128;for(let y=0;y<128;y++)for(let x=0;x<128;x++)out[(cy+y)*W+cx+x]=d[y*128+x];placed++};return{data:out,W,H,placed,wc}}
function assembleWallAuto(wall, tiles) { const wca = wallCellsAdvanced(wall); if (!wca || !wca.length) return null; let globalBest = null; for (const wc of wca) { const { cells, cols, rows, ori } = wc; const colPerms = perms([...Array(cols).keys()]); const P = [], Ink = []; for (let i = 0; i < cells.length; i++) { const cell = cells[i]; const t = tiles.get(cell.mapId); let d = new Uint8Array(16384), ink = new Uint8Array(16384); if (t) { d = rotQ(t, (cell.rotation || 0) % 4); const im = inkMaskWall(d, 128, 128); ink = im.ink }; P.push(d); Ink.push(ink) }; for (const cp of colPerms) { let cost = 0; for (let r = 0; r < rows; r++) for (let k = 0; k < cols - 1; k++) cost += seamV_ink(Ink[r * cols + cp[k]], Ink[r * cols + cp[k + 1]]); for (let k = 0; k < cols; k++) for (let r = 0; r < rows - 1; r++) cost += seamH_ink(Ink[r * cols + cp[k]], Ink[(r + 1) * cols + cp[k]]); if (!globalBest || cost < globalBest.cost) globalBest = { cost, cp, rp: [...Array(rows).keys()], ori, cells, cols, rows } } }; if (!globalBest) return null; const { cp, cells, cols, rows, ori } = globalBest; const W = cols * 128, H = rows * 128; const out = new Uint8Array(W * H); let placed = 0; for (let k = 0; k < cols; k++) for (let m = 0; m < rows; m++) { const c = cp[k], r = m, cell = cells[r * cols + c]; if (cell && tiles.has(cell.mapId)) placed++; const t = tiles.get(cell.mapId); let patch = new Uint8Array(16384); if (t) patch = rotQ(t, (cell.rotation || 0) % 4); for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) out[(m * 128 + y) * W + (k * 128 + x)] = patch[y * 128 + x] }; return { data: out, W, H, placed, wc: { cells, cols, rows }, colPerm: cp, rowPerm: [...Array(rows).keys()], seamCost: globalBest.cost, ori: ori.name } }
function wallDot(wall, view) { if (!view || typeof view.yaw !== 'number') return null; let cx = 0, cz = 0; for (const f of wall.frames) { cx += f.x; cz += f.z }; cx /= wall.frames.length; cz /= wall.frames.length; let dx = cx - view.x, dz = cz - view.z; const len = Math.sqrt(dx * dx + dz * dz); if (len < 0.001) return 0; dx /= len; dz /= len; const vx = -Math.sin(view.yaw), vz = Math.cos(view.yaw); return vx * dx + vz * dz }
function getMapId(p){if(!p) return null;for(const k of ['itemDamage','mapId','id','map']) if(typeof p[k]==='number') return p[k];return null}

// ========================= v3.8.4: kick reason + saveRecord =========================
function extractStrings(o, out) {
  if (!o || typeof o !== 'object') return out
  if (o.type === 'string' && (typeof o.value === 'string' || typeof o.val === 'string')) out.push(o.value || o.val)
  if (typeof o.text === 'string') out.push(o.text)
  for (const k of Object.keys(o)) extractStrings(o[k], out)
  return out
}
function kickReason(r) {
  if (!r) return ''
  if (typeof r === 'string') return r
  try { if (typeof r.toString === 'function') { const s = r.toString(); if (s && s !== '[object Object]') return s } } catch (e) {}
  const strs = extractStrings(r, [])
  if (strs.length) return strs.join('')
  try { return JSON.stringify(r).slice(0, 200) } catch (e) { return '' }
}

// v3.8.4: ПОЛНОЕ СОХРАНЕНИЕ (из v3.7.32)
function saveRecord(outDir, snap, label, wallStats) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(snap.frames, null, 2))
  fs.writeFileSync(path.join(outDir, 'chat.log'), snap.chats.join('\n'))
  fs.writeFileSync(path.join(outDir, 'packets.log'), snap.packets.join('\n'))
  fs.writeFileSync(path.join(outDir, 'session_log.txt'), snap.events.join('\n'))
  if (snap.view) fs.writeFileSync(path.join(outDir, 'view.json'), JSON.stringify(snap.view, null, 2))
  
  if (!wallStats || !wallStats.length) { step(label + ': нет стен для сохранения'); return }
  wallStats.sort((a, b) => b.score - a.score)
  const best = wallStats[0]
  const w = best.w, asm = best.asm, ink = best.ink, clean = best.clean
  
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA.png'), colorPng(asm.data, asm.W, asm.H, 2))
  const raw0 = assembleWall(w, snap.maps, true)
  if (raw0) fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_no_rotate.png'), colorPng(raw0.data, raw0.W, raw0.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask.png'), bwPng(ink, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask_clean.png'), bwPng(clean, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask_drop.png'), bwPng(best.drop, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_digits.png'), bwPng(best.digitMask, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_raw.bin'), Buffer.from(asm.data))
  
  for (const s of wallStats.slice(1)) {
    fs.writeFileSync(path.join(outDir, 'DECOY_NOT_ORIGINAL_' + s.w.tag + '.png'), colorPng(s.asm.data, s.asm.W, s.asm.H, 2))
    const ddir = path.join(outDir, 'tiles_decoy_' + s.w.tag); fs.mkdirSync(ddir, { recursive: true })
    s.w.frames.forEach((f, i) => { const raw = snap.maps.get(f.mapId); if (raw) fs.writeFileSync(path.join(ddir, 'tile_' + String(i).padStart(2, '0') + '_map' + f.mapId + '.bin'), Buffer.from(raw)) })
  }
  
  const layout = []; if (asm.wc) for (let i = 0; i < asm.wc.cells.length; i++) { const f = asm.wc.cells[i]; layout.push({ cell: i, tile: f.mapId, rot: (f.rotation || 0) % 4 }) }
  fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify(layout, null, 2))
  fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true })
  layout.forEach((L, i) => { const raw = snap.maps.get(L.tile); if (raw) fs.writeFileSync(path.join(outDir, 'tiles', 'tile_' + String(i).padStart(2, '0') + '_map' + L.tile + '.bin'), Buffer.from(raw)) })
  
  fs.mkdirSync(path.join(outDir, 'variants'), { recursive: true })
  const ocrLines = []
  for (const v of best.vars) { fs.writeFileSync(path.join(outDir, 'variants', v.name + '.png'), bwPng(v.mask, asm.W, asm.H, 2)); const r = ocr(v.mask, asm.W, asm.H); ocrLines.push(v.name + ': "' + r.text + '" digits=' + r.digits.length) }
  fs.writeFileSync(path.join(outDir, 'ocr_variants.txt'), ocrLines.join('\n'))
  
  const candsLines = []
  for (const c of best.candidates) candsLines.push('"' + c.digits + '" conf=' + c.conf.toFixed(1) + ' [' + c.src + ']')
  fs.writeFileSync(path.join(outDir, 'ocr_candidates.txt'), candsLines.join('\n'))
  
  step(label + ': ORIGINAL=' + w.tag + ' dmColor=' + best.dmColor + ' top="' + (best.candidates[0] ? best.candidates[0].digits : '-') + '" -> ' + outDir)
}

// ========================= РАУНД (v3.8.4: с отправкой ответа) =========================
async function doRound(roundNum) {
  return new Promise(resolve => {
    const col = {
      maps: new Map(), frames: [], framesById: new Map(),
      chats: [], packets: [], events: [], prompts: 0, dead: false, reason: '',
      candidates: [], sentIndex: -1, answerResult: null, promptsSinceSend: 0,
      ocrRunning: false, wallStats: [], view: null,
      debugDir: path.join(REC_ROOT, 'round' + roundNum + '_' + STAMP)
    }
    const ev = s => { col.events.push(new Date().toISOString() + ' ' + s); step('[r' + roundNum + '] ' + s) }
    let finished = false, bot = null, pollT = null, hardT = null, settleT = null, loginT = null, watchdog = null
    const linkedNow = () => col.frames.filter(f => f.mapId !== null && col.maps.has(f.mapId)).length
    
    const finish = (ok, note) => {
      if (finished) return
      finished = true
      try { if (hardT) clearTimeout(hardT) } catch (e) {}
      try { if (pollT) clearInterval(pollT) } catch (e) {}
      try { if (settleT) clearTimeout(settleT) } catch (e) {}
      try { if (loginT) clearTimeout(loginT) } catch (e) {}
      try { if (watchdog) clearTimeout(watchdog) } catch (e) {}
      try { if (bot && bot.entity && bot.entity.position) col.view = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch } } catch (e) {}
      const snap = { maps: col.maps, frames: col.frames.map(f => Object.assign({}, f)), chats: col.chats.slice(), packets: col.packets.slice(), events: col.events.slice(), view: col.view }
      try { if (bot) bot.end('done') } catch (e) {}
      const ocrSent = col.sentIndex >= 0 && col.candidates[col.sentIndex] ? col.candidates[col.sentIndex].digits : null
      resolve(ok ? { ok: true, snap, note, ocrSent, wallStats: col.wallStats } : { ok: false, note: note || col.reason || 'fail', ocrSent, wallStats: col.wallStats })
    }
    
    const armWatchdog = () => {
      try { if (watchdog) clearTimeout(watchdog) } catch (e) {}
      watchdog = setTimeout(() => {
        if (!finished && col.sentIndex >= 0 && col.answerResult === null) {
          ev('✅ тишина ' + (SILENT_PASS_MS/1000) + 'с после ответа = капча пройдена')
          finish(true, 'silent_pass')
        }
      }, SILENT_PASS_MS)
    }
    
    const sendNext = (why) => {
      if (!bot || finished) return false
      if (col.sentIndex + 1 >= col.candidates.length) { ev('⚠️ кандидатов больше нет (' + why + ')'); return false }
      col.sentIndex++
      col.promptsSinceSend = 0
      const cand = col.candidates[col.sentIndex]
      ev('📤 ОТПРАВЛЯЮ #' + (col.sentIndex+1) + ': "' + cand.digits + '" (' + why + ', conf=' + cand.conf.toFixed(1) + ', ' + cand.src + ')')
      try { bot.chat(cand.digits) } catch (e) { ev('❌ chat error: ' + e.message) }
      armWatchdog()
      return true
    }
    
    const runOcr = async () => {
      if (col.ocrRunning || col.wallStats.length > 0) return
      col.ocrRunning = true
      try {
        const linked = col.frames.filter(f => f.mapId !== null && col.maps.has(f.mapId))
        ev('OCR: linked=' + linked.length)
        if (linked.length < MIN_PLACED) return
        const walls = clusterWalls(linked)
        const allCands = []
        for (const w of walls) {
          const asm = assembleWallAuto(w, col.maps)
          if (!asm || asm.placed < 8) continue
          const im = inkMaskWall(asm.data, asm.W, asm.H)
          const drop = dropLines(im.ink, asm.W, asm.H)
          const clean = dropLines(opening(im.ink, asm.W, asm.H, 2), asm.W, asm.H)
          const th = thickScore(im.ink, asm.W, asm.H)
          const ac = analyzeColors(asm.data, im.ink, asm.W, asm.H)
          const nRow = rowScore(ac.cands, asm.H)
          const vars = buildVariants(im.ink, ac.digitMask, asm.W, asm.H)
          const cands = await ocrWall(asm.data, asm.W, asm.H, im.ink, w.tag, col.debugDir)
          col.wallStats.push({ w, asm, ink: im.ink, drop, clean, digitMask: ac.digitMask, inkCount: im.inkCount, th, nRow, vars, dmColor: ac.dmColor, candidates: cands, score: (cands[0] ? cands[0].conf : 0) * 100 + ac.dmColor * 10 + nRow * 5 })
          for (const c of cands) allCands.push(Object.assign({ wall: w.tag }, c))
        }
        const seen = new Set()
        for (const c of allCands) if (!seen.has(c.digits)) { seen.add(c.digits); col.candidates.push(c) }
        col.candidates.sort((a, b) => b.conf - a.conf)
        ev('📋 кандидатов: ' + col.candidates.length + (col.candidates[0] ? ' лучший="' + col.candidates[0].digits + '" (стена ' + col.candidates[0].wall + ')' : ''))
      } catch (e) {
        ev('❌ OCR error: ' + e.message)
      } finally { col.ocrRunning = false }
    }
    
    hardT = setTimeout(() => finish(linkedNow() >= 8 && col.prompts >= 1, 'timeout'), CAPTCHA_TIMEOUT_MS)
    if (!PROXY.host) { finish(false, 'нет proxy.host'); return }
    
    SocksClient.createConnection({ proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password }, command: 'connect', destination: { host: MC.host, port: MC.port } })
      .then(conn => {
        ev('socks ok -> ' + MC.host)
        const nick = (NICK_PREFIX + Math.floor(Math.random() * 9000 + 1000)).slice(0, 16); const tConn = Date.now()
        const tSpawn = setTimeout(() => { if (!finished) finish(false, 'spawn timeout') }, CONNECT_TIMEOUT_MS)
        loginT = setTimeout(() => { if (!finished) { ev('⚠️ login timeout через 30с'); finish(false, 'login timeout') } }, LOGIN_TIMEOUT_MS)
        
        bot = mineflayer.createBot({ username: nick, host: MC.host, port: MC.port, version: MC.version, socket: conn.socket, hideErrors: true, auth: 'offline', keepAlive: true })
        bot._client.on('packet', (data, meta) => { try { if (!meta || !meta.name) return; if (col.packets.length < 4000) col.packets.push(new Date().toISOString() + ' PKT ' + meta.name) } catch (e) {} })
        
        const onMap = pkt => {
          try {
            const id = getMapId(pkt); if (id === null || !pkt.data) return
            const cols = pkt.columns || 0, rows = pkt.rows || 0; if (!cols || !rows) return
            let canvas = col.maps.get(id); if (!canvas) { canvas = new Uint8Array(16384); col.maps.set(id, canvas) }
            const buf = Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(pkt.data.buffer || pkt.data, pkt.data.byteOffset || 0, pkt.data.length)
            const x0 = pkt.x || 0, y0 = pkt.y || 0
            for (let i = 0; i < buf.length; i++) { const cx = x0 + (i % cols), cy = y0 + Math.floor(i / cols); if (cx < 128 && cy < 128) canvas[cy * 128 + cx] = buf[i] }
          } catch (e) {}
        }
        bot._client.on('map', onMap); bot._client.on('map_data', onMap); bot._client.on('update_map', onMap)
        
        bot.on('entitySpawn', ent => { const nm = String(ent.name || ent.type || ''); if (!/item_frame|glow_item_frame/i.test(nm) || !ent.position) return; if (col.framesById.has(ent.id)) return; const f = { id: ent.id, x: ent.position.x, y: ent.position.y, z: ent.position.z, mapId: null, rotation: 0 }; col.frames.push(f); col.framesById.set(ent.id, f) })
        bot._client.on('entity_metadata', pk => { try { const f = col.framesById.get(pk.entityId); if (!f) return; for (const e of (pk.metadata || [])) { const val = e.value; if (val && typeof val === 'object' && Array.isArray(val.components)) { for (const comp of val.components) { if (comp && comp.type === 'map_id' && typeof comp.data === 'number') f.mapId = comp.data } }; if (typeof val === 'number' && (e.key === 9 || e.key === 10 || e.key === 8)) f.rotation = val } } catch (e) {} })
        
        bot.on('message', async msg => {
          let t = ''; try { t = msg.toString() } catch (e) { try { t = JSON.stringify(msg.json || msg) } catch (e2) {} }
          col.chats.push(t); ev('💬 ' + t.slice(0, 100))
          const low = t.toLowerCase()
          
          if (col.sentIndex >= 0 && col.answerResult === null) {
            if (/неверн|incorrect|wrong|ошибк|неправильн|попробуй ещё|попробуйте ещё/i.test(low)) {
              col.answerResult = null
              ev('❌ неверно → следующий кандидат')
              sendNext('retry после неверного')
              return
            }
            if (/принят|accepted|верно|correct|успеш|прош/i.test(low)) {
              col.answerResult = 'correct'
              finish(true, 'correct_answer')
              return
            }
          }
          
          if (/введите номер|номер с картинки|введите капчу|captcha|enter code/i.test(low)) {
            col.prompts++
            if (col.sentIndex >= 0) col.promptsSinceSend++
            ev('ПРОМПТ #' + col.prompts)
            await runOcr()
            if (col.sentIndex < 0 && col.candidates.length > 0) {
              sendNext('первый ответ')
            } else if (col.sentIndex >= 0 && col.answerResult === null && col.promptsSinceSend >= 2) {
              ev('⚠️ промпты повторяются — ответ не принят')
              sendNext('retry по повторному промпту')
            }
          }
        })
        
        bot.on('login', () => { clearTimeout(loginT); ev('login ok (' + nick + ') за ' + (Date.now() - tConn) + 'мс') })
        bot.on('spawn', () => { clearTimeout(tSpawn); ev('spawn ok за ' + (Date.now() - tConn) + 'мс') })
        bot.on('kicked', r => {
          if (finished) return
          const reason = kickReason(r)
          ev('kicked: ' + reason.slice(0, 150))
          col.dead = true; col.reason = 'kicked: ' + reason
          // v3.8.4: kicked = ВСЕГДА провал
          setTimeout(() => { if (!finished) finish(false, 'kicked: ' + reason.slice(0, 100)) }, 500)
        })
        bot.on('end', (reason) => {
          if (finished) return
          col.dead = true; if (!col.reason) col.reason = 'end: ' + String(reason || '').slice(0, 100)
          ev('end: ' + col.reason)
          setTimeout(() => { if (!finished && !(col.prompts >= 1 && linkedNow() >= 8)) finish(false, col.reason) }, 500)
        })
        bot.on('error', e => { if (finished) return; col.dead = true; if (!col.reason) col.reason = 'error: ' + e.message; ev(col.reason); if (col.prompts < 1) finish(false, col.reason) })
        
        pollT = setInterval(() => {
          const linked = linkedNow()
          if (col.prompts >= 1 && linked >= 8) { if (!settleT) { ev('данные готовы (linked=' + linked + ')'); settleT = setTimeout(() => finish(true, 'captured'), SETTLE_MS) } }
          else if (col.dead && linked >= 8 && col.prompts >= 1) finish(true, 'captured-before-kick')
        }, 400)
      }).catch(e => { ev('socks fail: ' + e.message); finish(false, 'socks: ' + e.message) })
  })
}

// ========================= MAIN =========================
async function main() {
  step('=== СТАРТ v3.8.4 — БАЗА v3.7.32 + TESSERACT.JS ===')
  await ensureAllDeps()
  step('')
  
  if (!CFG_PATH) { step('НЕ НАЙДЕН config.json'); process.exit(1) }
  step('config: ' + CFG_PATH + ' parse=' + CFG_STRATEGY)
  step('MC: ' + MC.host + ':' + MC.port + ' v' + MC.version)
  step('proxy: ' + PROXY.host + ':' + PROXY.port)
  step('OCR: Tesseract.js (analyzeColors + crop + per-digit + pattern fallback)')
  step('kicked = всегда провал; успех = тишина 12с или сообщение сервера')
  step('')
  
  await initTesseract()
  
  const results = []; const tGlobal = Date.now()
  let rotationsUsed = 0, consecutiveNetFails = 0, proxyFails = 0, aborted = false
  let okCount = 0
  
  currentRunIp = await rotateIp(); step('IP забега: ' + (currentRunIp || '?'))
  
  for (let r = 1; r <= TARGET_ROUNDS && !aborted; r++) {
    let rec = null, lastNetFail = false
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ROUND && !rec && !aborted; attempt++) {
      if (attempt > 1 && (lastNetFail || consecutiveNetFails > 0) && !proxyDead && rotationsUsed < MAX_ROTATIONS_ON_FAIL) {
        rotationsUsed++; step('🔄 ротация IP (' + rotationsUsed + '/' + MAX_ROTATIONS_ON_FAIL + ')')
        await rotateIp(); await sleep(2500)
      } else if (attempt > 1) await sleep(1500)
      else await sleep(1000 + Math.floor(Math.random() * 1000))
      
      step('--- РАУНД ' + r + '/' + TARGET_ROUNDS + ' (попытка ' + attempt + ', IP ' + (currentRunIp || '?') + ') ---')
      const res = await doRound('r' + r + 'a' + attempt)
      lastNetFail = !!(res && !res.ok && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|login timeout|spawn timeout/i.test(res.note || ''))
      
      // сохраняем всегда (для отладки)
      if (res.snap && res.wallStats && res.wallStats.length) {
        const dir = path.join(REC_ROOT, 'live_round' + r + '_' + STAMP)
        saveRecord(dir, res.snap, 'РАУНД' + r, res.wallStats)
      }
      
      if (res && res.ok) {
        rec = res; consecutiveNetFails = 0; proxyFails = 0; okCount++
        step('✅ РАУНД ' + r + ': "' + (res.ocrSent || '-') + '" | ' + res.note)
      } else {
        const note = res ? res.note : '?'; step('❌ РАУНД ' + r + ' попытка ' + attempt + ': ' + note + (res.ocrSent ? ' (отпр: "' + res.ocrSent + '")' : ''))
        if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/.test(note)) { proxyFails++; if (proxyFails >= 2) { proxyDead = true; aborted = true; step('ПРОКСИ МЁРТВ') } }
        else if (lastNetFail) { if (currentRunIp) badIPs.add(currentRunIp); consecutiveNetFails++; if (consecutiveNetFails >= 6) { aborted = true; step('6 сетевых фейлов') } }
        else consecutiveNetFails = 0
      }
    }
    if (!aborted && !rec) step('РАУНД ' + r + ' провален')
    results.push({ n: r, ok: !!rec, note: rec ? rec.note : '-', ocr: rec && rec.ocrSent ? rec.ocrSent : '-' })
    if (r < TARGET_ROUNDS && !aborted) await sleep(PAUSE_BETWEEN_MS)
  }
  
  if (tesseractWorker) { try { await tesseractWorker.terminate() } catch (e) {} }
  
  const L = ['=== СВОДКА ' + TARGET_ROUNDS + ' РАУНДОВ ===', 'успешных: ' + okCount + '/' + TARGET_ROUNDS + ' | время: ' + Math.round((Date.now() - tGlobal) / 1000) + 'с']
  for (const x of results) L.push('  #' + x.n + ': ' + (x.ok ? '✅' : '❌') + ' ocr="' + x.ocr + '" — ' + x.note)
  step('готово.')
  flushReport(L.join('\n'))
  console.log('\n' + L.join('\n'))
  setTimeout(() => process.exit(0), 2000)
}

main().catch(e => { console.error('!!! FATAL !!!', e.message, '\n', e.stack); flushReport('FATAL: ' + (e.stack || e.message)); setTimeout(() => process.exit(1), 2000) })
