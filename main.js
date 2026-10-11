// VERSION: 3.8.3
// main.js
// v3.8.3: row-consistency сегментация + per-digit Tesseract
//         kicked = провал (не успех!) + полное сохранение стен как в v3.7.x
const mineflayer = require('mineflayer')
const { SocksClient } = require('socks')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { spawn } = require('child_process')

const TARGET_ROUNDS = 10
const PAUSE_BETWEEN_MS = 3000
const MIN_PLACED = 10
const CAPTCHA_TIMEOUT_MS = 50000
const LOGIN_TIMEOUT_MS = 30000
const SILENT_PASS_MS = 12000

// ========================= ГЛОБАЛЬНЫЕ =========================
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []
let REC_ROOT = null
let tesseractWorker = null
let Tesseract = null

function step(s) { const l = new Date().toISOString().slice(11, 19) + ' [step] ' + s; SLOG.push(l); console.log(l) }
function flushReport(extra) { if (!REC_ROOT) return; try { fs.writeFileSync(path.join(REC_ROOT, 'report_' + STAMP + '.txt'), SLOG.join('\n') + '\n' + (extra || '')) } catch (e) {} }
process.on('uncaughtException', e => { console.error('!!! UNCAUGHT !!!', e.message, e.stack); flushReport('UNCAUGHT: ' + (e.stack || e.message)); setTimeout(() => process.exit(1), 1000) })
process.on('unhandledRejection', e => { console.error('!!! REJECTION !!!', e); flushReport('REJECTION: ' + String(e)) })

// ========================= АВТО-УСТАНОВКА =========================
function ensurePackageJson() {
  const p = path.join(__dirname, 'package.json')
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ name: 'funtime-captcha-bot', version: '3.8.3', private: true, dependencies: {} }, null, 2))
}
function installPackage(name) {
  return new Promise((resolve, reject) => {
    step('[NPM] npm install ' + name + ' ...')
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

// ========================= КОНФИГ =========================
let CFG_PATH, CFG = {}
try {
  const a = path.join(__dirname, 'config.json'), b = path.join(__dirname, '..', 'config.json')
  CFG_PATH = fs.existsSync(a) ? a : (fs.existsSync(b) ? b : null)
} catch (e) {}
function cfgGet(o, kp, d) { let c = o; for (const k of kp.split('.')) { if (!c || c[k] === undefined) return d; c = c[k] } return c }
if (CFG_PATH) { try { CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { CFG = {} } }

const MC = { host: cfgGet(CFG, 'minecraft.server', 'connect.funtime.su'), port: cfgGet(CFG, 'minecraft.port', 25565), version: cfgGet(CFG, 'minecraft.version', '1.21.1') }
const PROXY = { host: cfgGet(CFG, 'proxy.host', ''), port: cfgGet(CFG, 'proxy.port', 1080), username: cfgGet(CFG, 'proxy.username', ''), password: cfgGet(CFG, 'proxy.password', ''), changeIpUrl: cfgGet(CFG, 'proxy.changeIpUrl', ''), waitSec: cfgGet(CFG, 'proxy.waitAfterIpChangeSec', 12) }
const NICK_PREFIX = String(cfgGet(CFG, 'accounts.nickPrefix', 'Player')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'Player'
try { REC_ROOT = path.join(__dirname, 'records'); fs.mkdirSync(REC_ROOT, { recursive: true }) } catch (e) {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let currentRunIp = null
let consecutiveNetFails = 0

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
  sc = sc || 1
  const SW=w*sc, SH=h*sc, rgba=Buffer.alloc(SW*SH*4)
  for (let y=0;y<SH;y++) for (let x=0;x<SW;x++) {
    const d = m[Math.floor(y/sc)*w + Math.floor(x/sc)] ? 1 : 0
    const val = invert ? (d ? 255 : 0) : (d ? 0 : 255)
    const i=(y*SW+x)*4; rgba[i]=val; rgba[i+1]=val; rgba[i+2]=val; rgba[i+3]=255
  }
  return encodePng(SW,SH,rgba)
}

// ========================= МОРФОЛОГИЯ / КОМПОНЕНТЫ =========================
const NB8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
function erode(m,W,H){const o=new Uint8Array(m.length);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(m[i]&&m[i-1]&&m[i+1]&&m[i-W]&&m[i+W])o[i]=1}return o}
function dilate(m,W,H){const o=new Uint8Array(m.length);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(m[i]||(x>0&&m[i-1])||(x<W-1&&m[i+1])||(y>0&&m[i-W])||(y<H-1&&m[i+W]))o[i]=1}return o}
function closing(m,W,H,r){let x=m;for(let i=0;i<r;i++)x=dilate(x,W,H);for(let i=0;i<r;i++)x=erode(x,W,H);return x}

function inkMaskWall(data,W,H){const wc=new Int32Array(256);for(let i=0;i<data.length;i++) wc[data[i]]++;const bgW=new Set();for(let v=1;v<256;v++) if(wc[v]>=6000 && LUM[v]>=120) bgW.add(v);const iso={};for(let v=1;v<256;v++){const c=wc[v];if(c<150||c>6000||bgW.has(v)||LUM[v]<120) continue;const stp=Math.max(1,Math.floor(c/300));let checked=0,isolated=0;for(let i=v%7;i<data.length&&checked<300;i+=stp){if(data[i]!==v)continue;const x=i%W,y=(i/W)|0;if(x<1||x>=W-1||y<1||y>=H-1)continue;checked++;let same=false;for(const nb of NB8){const nx=x+nb[0],ny=y+nb[1];if(data[ny*W+nx]===v){same=true;break}};if(!same)isolated++};iso[v]=checked?isolated/checked:0;if(iso[v]>=0.6)bgW.add(v)};const ink=new Uint8Array(data.length);for(let r=0;r<H/128;r++)for(let c=0;c<W/128;c++){const counts=new Int32Array(256);const x0=c*128,y0=r*128;for(let y=0;y<128;y++)for(let x=0;x<128;x++)counts[data[(y0+y)*W+x0+x]]++;const bg=new Set(bgW);for(let v=1;v<256;v++){if(LUM[v]>=120 && (counts[v]>=1200 || (iso[v]||0)>=0.6)) bg.add(v)};for(let y=0;y<128;y++)for(let x=0;x<128;x++){const i=(y0+y)*W+x0+x;const v=data[i];if(v!==0&&!bg.has(v))ink[i]=1}};return { ink }}

function compsList(mask, W, H, wantPx) {
  const vis = new Uint8Array(mask.length), out = []; const i0 = (x,y) => y*W+x
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = i0(x,y); if (!mask[i] || vis[i]) continue
    const st = [x,y]; vis[i] = 1; let a = 0, mnX = x, mxX = x, mnY = y, mxY = y
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
    const px = wantPx ? [i] : null
    while (st.length) {
      const cy = st.pop(), cx = st.pop(); a++; sx += cx; sy += cy; sxx += cx*cx; syy += cy*cy; sxy += cx*cy
      if (cx<mnX) mnX=cx; if (cx>mxX) mxX=cx; if (cy<mnY) mnY=cy; if (cy>mxY) mxY=cy
      for (const nb of NB8) { const nx=cx+nb[0], ny=cy+nb[1]; if (nx<0||ny<0||nx>=W||ny>=H) continue; const ni = i0(nx,ny); if (mask[ni] && !vis[ni]) { vis[ni]=1; st.push(nx,ny); if (wantPx) px.push(ni) } }
    }
    const mx = sx/a, my = sy/a, vx = sxx/a - mx*mx, vy = syy/a - my*my, vxy = sxy/a - mx*my
    const half = (vx + vy) / 2, det = vx*vy - vxy*vxy
    const disc = Math.sqrt(Math.max(0, half*half - Math.max(0, det)))
    out.push({ mnX, mxX, mnY, mxY, a, px, varMinor: Math.max(0, half - disc), cx: mx, cy: my })
  }
  return out
}
function isStraight(c, w, h) { return c.varMinor < 10 && (w + h) > 100 }

// ========================= v3.8.3: ROW-CONSISTENCY СЕГМЕНТАЦИЯ =========================
// Ищем ОДИН цвет, чьи компоненты = ровный ряд из 4-8 цифр одинаковой высоты
function findDigitRow(data, ink, W, H) {
  const colorCounts = new Int32Array(256)
  for (let i = 0; i < ink.length; i++) if (ink[i]) colorCounts[data[i]]++
  let best = null
  
  for (let v = 1; v < 256; v++) {
    if (colorCounts[v] < 100) continue
    const m = new Uint8Array(ink.length)
    for (let i = 0; i < ink.length; i++) if (ink[i] && data[i] === v) m[i] = 1
    
    const comps = compsList(m, W, H, true).filter(c => {
      const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
      if (c.a < 60) return false
      if (h < H * 0.08 || h > H * 0.60) return false
      if (w < 8 || w > W * 0.25) return false
      if (c.a / (w * h) < 0.08) return false
      if (isStraight(c, w, h)) return false
      return true
    })
    if (comps.length < 4) continue
    
    // группируем по Y в ряды
    const rows = []
    for (const c of comps) {
      let row = rows.find(r => Math.abs(r.cy - c.cy) < H * 0.07)
      if (!row) { row = { cy: c.cy, items: [] }; rows.push(row) }
      row.items.push(c)
      row.cy = row.items.reduce((s, x) => s + x.cy, 0) / row.items.length
    }
    
    for (const row of rows) {
      const n = row.items.length
      if (n < 4 || n > 8) continue
      row.items.sort((a, b) => a.cx - b.cx)
      
      // одинаковость высот
      const hs = row.items.map(c => c.mxY - c.mnY + 1)
      const hMin = Math.min(...hs), hMax = Math.max(...hs)
      if (hMax / Math.max(1, hMin) > 1.7) continue
      
      // одинаковость промежутков
      const gaps = []
      for (let i = 1; i < n; i++) gaps.push(row.items[i].mnX - row.items[i-1].mxX)
      const gAvg = gaps.reduce((a, b) => a + b, 0) / gaps.length
      const gBad = gaps.filter(g => Math.abs(g - gAvg) > Math.max(8, Math.abs(gAvg))).length
      
      // перекрытий быть не должно
      let overlap = 0
      for (let i = 1; i < n; i++) if (row.items[i].mnX < row.items[i-1].mxX) overlap++
      if (overlap > 0) continue
      
      const hAvg = hs.reduce((a, b) => a + b, 0) / n
      const score = n * 100 - gBad * 25 - (hMax/hMin - 1) * 40 + (hAvg > H * 0.15 ? 25 : 0)
      
      if (!best || score > best.score) best = { score, color: v, items: row.items, n, hAvg, gBad }
    }
  }
  return best
}

function getBBox(mask, W, H) {
  let mnX = W, mnY = H, mxX = -1, mxY = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y*W+x]) { if (x<mnX) mnX=x; if (x>mxX) mxX=x; if (y<mnY) mnY=y; if (y>mxY) mxY=y }
  if (mxX < 0) return null
  return { x: mnX, y: mnY, w: mxX-mnX+1, h: mxY-mnY+1 }
}
function cropMask(mask, bbox, W, H, pad) {
  const cw = bbox.w + pad*2, ch = bbox.h + pad*2
  const out = new Uint8Array(cw*ch)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = bbox.x - pad + x, sy = bbox.y - pad + y
    if (sx >= 0 && sy >= 0 && sx < W && sy < H) out[y*cw+x] = mask[sy*W+sx] ? 1 : 0
  }
  return { mask: out, w: cw, h: ch }
}

// ========================= FALLBACK pattern OCR =========================
const DIGITS={'0':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'1':[[0,0,1,0,0],[0,1,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,1,1,0]],'2':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]],'3':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'4':[[0,0,0,1,0],[0,0,1,1,0],[0,1,0,1,0],[1,0,0,1,0],[1,1,1,1,1],[0,0,0,1,0],[0,0,0,1,0]],'5':[[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'6':[[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'7':[[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],'8':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'9':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,1],[0,0,0,0,1],[0,0,0,0,1],[0,1,1,1,0]]}
function matchPat(mask,W,H,bx,by,bw,bh){const pat=[];for(let py=0;py<7;py++){const row=[];for(let px=0;px<5;px++){const sx=bx+Math.floor(px*bw/5),ex=bx+Math.floor((px+1)*bw/5),sy=by+Math.floor(py*bh/7),ey=by+Math.floor((py+1)*bh/7);let c=0,t=0;for(let y=sy;y<ey;y++)for(let x=sx;x<ex;x++){c+=mask[y*W+x];t++};row.push(t&&(c/t)>0.35?1:0)};pat.push(row)};let bd='?',bs=0;for(const d in DIGITS){let m=0;for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(pat[y][x]===DIGITS[d][y][x])m++;const s=m/35;if(s>bs){bs=s;bd=d}};return{best:bd,score:Math.round(bs*100)/100}}

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

// v3.8.3: распознавание КАЖДОЙ цифры отдельно (psm 10 = один символ)
async function ocrRowDigits(rowMask, comps, W, H) {
  const worker = await initTesseract()
  let text = '', sumConf = 0, okCount = 0
  const parts = []
  for (const c of comps) {
    const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
    const cropped = cropMask(rowMask, { x: c.mnX, y: c.mnY, w, h }, W, H, 3)
    const scale = cropped.h < 24 ? 5 : cropped.h < 48 ? 3 : 2
    const png = maskToPng(cropped.mask, cropped.w, cropped.h, false, scale)
    let bestD = null
    for (const psm of ['10', '8']) {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: psm })
        const r = await worker.recognize(png)
        const d = (r.data.text || '').replace(/[^0-9]/g, '')
        const conf = r.data.confidence || 0
        if (d.length === 1 && (!bestD || conf > bestD.conf)) bestD = { d, conf, src: 'tess' + psm }
      } catch (e) {}
    }
    const pm = matchPat(rowMask, W, H, c.mnX, c.mnY, w, h)
    if (!bestD || (bestD.conf < 50 && pm.score >= 0.85)) bestD = { d: pm.best, conf: pm.score * 100, src: 'pattern' }
    if (bestD && bestD.d) { text += bestD.d; sumConf += bestD.conf; okCount++; parts.push(bestD.d + '(' + bestD.conf.toFixed(0) + ')') }
    else { text += '?'; parts.push('?') }
  }
  return { text, parts, avgConf: okCount ? sumConf / okCount : 0 }
}

// v3.8.3: полный OCR стены → список кандидатов ТОЛЬКО 4-8 цифр
async function ocrWall(asm, label, debugDir) {
  const W = asm.W, H = asm.H
  const im = inkMaskWall(asm.data, W, H)
  const row = findDigitRow(asm.data, im.ink, W, H)
  
  if (!row) {
    step('[OCR] ' + label + ': ❌ ряд цифр не найден')
    return { candidates: [], score: 0, row: null, ink: im.ink, rowMask: null }
  }
  
  const rowMask = new Uint8Array(W * H)
  for (const c of row.items) for (const i of c.px) rowMask[i] = 1
  
  const bbox = getBBox(rowMask, W, H)
  step('[OCR] ' + label + ': ряд из ' + row.n + ' цифр, цвет=' + row.color + ', bbox=' + (bbox ? bbox.w + 'x' + bbox.h : '?') + ', score=' + row.score.toFixed(0))
  
  if (debugDir && bbox) {
    try {
      fs.mkdirSync(debugDir, { recursive: true })
      fs.writeFileSync(path.join(debugDir, 'wall_' + label + '.png'), colorPng(asm.data, W, H, 2))
      fs.writeFileSync(path.join(debugDir, 'row_' + label + '.png'), bwPng(rowMask, W, H, 2))
      const cropped = cropMask(rowMask, bbox, W, H, 6)
      const sc = cropped.h < 60 ? 3 : 2
      fs.writeFileSync(path.join(debugDir, 'crop_' + label + '.png'), maskToPng(cropped.mask, cropped.w, cropped.h, false, sc))
    } catch (e) {}
  }
  
  const candidates = []
  const push = (digits, conf, src) => {
    const d = String(digits).replace(/[^0-9]/g, '')
    if (d.length >= 4 && d.length <= 8 && !candidates.some(c => c.digits === d)) {
      candidates.push({ digits: d, conf, src })
    }
  }
  
  // 1) per-digit (главный метод)
  const pd = await ocrRowDigits(rowMask, row.items, W, H)
  step('[OCR] ' + label + ': per-digit = "' + pd.text + '" [' + pd.parts.join(' ') + ']')
  if (!pd.text.includes('?')) push(pd.text, pd.avgConf + 20, 'per-digit')
  else {
    // заменяем '?' на pattern-догадки уже учтены; пропускаем если есть '?'
  }
  
  // 2) строка целиком Tesseract
  if (bbox) {
    const worker = await initTesseract()
    const cropped = cropMask(rowMask, bbox, W, H, 6)
    const scale = cropped.h < 40 ? 4 : cropped.h < 80 ? 3 : 2
    const pngB = maskToPng(cropped.mask, cropped.w, cropped.h, false, scale)
    const pngW = maskToPng(cropped.mask, cropped.w, cropped.h, true, scale)
    for (const psm of ['7', '6']) {
      for (let inv = 0; inv < 2; inv++) {
        try {
          await worker.setParameters({ tessedit_pageseg_mode: psm })
          const r = await worker.recognize(inv ? pngW : pngB)
          push((r.data.text || '').replace(/\s+/g, ''), r.data.confidence || 0, 'line-psm' + psm + (inv ? '-inv' : ''))
        } catch (e) {}
      }
    }
  }
  
  // 3) pattern по компонентам ряда
  let ptext = ''
  for (const c of row.items) {
    const pm = matchPat(rowMask, W, H, c.mnX, c.mnY, c.mxX - c.mnX + 1, c.mxY - c.mnY + 1)
    if (pm.score >= 0.5) ptext += pm.best
  }
  push(ptext, 40, 'pattern-row')
  
  candidates.sort((a, b) => b.conf - a.conf)
  step('[OCR] ' + label + ': кандидатов=' + candidates.length + (candidates[0] ? ' лучший="' + candidates[0].digits + '" (' + candidates[0].src + ')' : ''))
  for (const c of candidates.slice(0, 4)) step('[OCR]   "' + c.digits + '" conf=' + c.conf.toFixed(1) + ' [' + c.src + ']')
  
  return { candidates, score: row.score, row, ink: im.ink, rowMask }
}

// ========================= СБОРКА СТЕНЫ =========================
function rotQ(d,q){q=((q%4)+4)%4;if(!q)return Uint8Array.from(d);const o=new Uint8Array(16384);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const v=d[y*128+x];if(q===1)o[x*128+127-y]=v;else if(q===2)o[(127-y)*128+(127-x)]=v;else o[(127-x)*128+y]=v};return o}
function clusterWalls(frames){const counts={};frames.forEach(f=>{counts['x:'+Math.round(f.x)]=(counts['x:'+Math.round(f.x)]||0)+1;counts['z:'+Math.round(f.z)]=(counts['z:'+Math.round(f.z)]||0)+1});const planes=Object.entries(counts).filter(([,v])=>v>=8).sort((a,b)=>b[1]-a[1]);const walls=[],used=new Set();for(const[key]of planes){const[axis,val]=key.split(':');const members=frames.filter(f=>!used.has(f.id)&&Math.round(f[axis])===+val);if(members.length<8)continue;members.forEach(f=>used.add(f.id));let fSign=0;for(const f of members){const fr=f[axis]-Math.floor(f[axis]);if(Math.abs(fr-0.5)>0.1){fSign=fr<0.5?1:-1;break}};if(!fSign)fSign=1;walls.push({axis,value:+val,frames:members,fSign,tag:axis+val});if(walls.length===2)break};return walls}
function clusterCoords(vals){if(!vals||!vals.length)return[];const sorted=vals.slice().sort((a,b)=>a-b);const clusters=[];let cur=[sorted[0]];for(let i=1;i<sorted.length;i++){if(sorted[i]-cur[0]<0.6)cur.push(sorted[i]);else{clusters.push(cur.reduce((s,x)=>s+x,0)/cur.length);cur=[sorted[i]]}};clusters.push(cur.reduce((s,x)=>s+x,0)/cur.length);return clusters}
function wallCellsAdvanced(wall){const horiz=wall.axis==='x'?'z':'x';const hVals=wall.frames.map(f=>f[horiz]);const yVals=wall.frames.map(f=>f.y);const hCenters=clusterCoords(hVals);const yCenters=clusterCoords(yVals);const cols=hCenters.length,rows=yCenters.length;if(cols*rows!==wall.frames.length)return null;const results=[];for(const ori of [{hAsc:true,yAsc:false},{hAsc:false,yAsc:false},{hAsc:true,yAsc:true},{hAsc:false,yAsc:true}]){const hs=ori.hAsc?hCenters.slice():hCenters.slice().reverse();const ys=ori.yAsc?yCenters.slice():yCenters.slice().reverse();const cells=new Array(cols*rows).fill(null);let missing=0;for(const f of wall.frames){let bestH=0,minDh=1e9;for(let i=0;i<hs.length;i++){const d=Math.abs(f[horiz]-hs[i]);if(d<minDh){minDh=d;bestH=i}};let bestY=0,minDy=1e9;for(let i=0;i<ys.length;i++){const d=Math.abs(f.y-ys[i]);if(d<minDy){minDy=d;bestY=i}};const idx=bestY*cols+bestH;if(cells[idx])missing++;cells[idx]=f};if(missing>0||cells.some(c=>!c))continue;results.push({cells,cols,rows,ori})};return results.length?results:null}
function seamV_ink(inkA,inkB){let cost=0;for(let y=0;y<128;y++){const va=inkA[y*128+127],vb=inkB[y*128+0];if(va!==vb){const va1=y>0?inkA[(y-1)*128+127]:0,va2=y<127?inkA[(y+1)*128+127]:0,vb1=y>0?inkB[(y-1)*128+0]:0,vb2=y<127?inkB[(y+1)*128+0]:0,vaL=inkA[y*128+126],vbR=inkB[y*128+1];if(va===vb1||va===vb2||vaL===vb||va1===vb||va2===vb)cost+=2;else cost+=10}};return cost}
function seamH_ink(inkA,inkB){let cost=0;for(let x=0;x<128;x++){const va=inkA[127*128+x],vb=inkB[0*128+x];if(va!==vb){const vaL=x>0?inkA[127*128+x-1]:0,vaR=x<127?inkA[127*128+x+1]:0,vbL=x>0?inkB[0*128+x-1]:0,vbR=x<127?inkB[0*128+x+1]:0,vaU=inkA[126*128+x],vbD=inkB[1*128+x];if(va===vbL||va===vbR||vaL===vb||vaR===vb||vaU===vb||va===vbD)cost+=2;else cost+=10}};return cost}
function perms(arr){if(arr.length<=1)return[arr.slice()];const res=[];for(let i=0;i<arr.length;i++){const rest=arr.slice(0,i).concat(arr.slice(i+1));for(const p of perms(rest))res.push([arr[i]].concat(p))};return res}
function assembleWall(wall,tiles,raw){const wca=wallCellsAdvanced(wall);if(!wca||!wca.length)return null;const wc=wca[0];const W=wc.cols*128,H=wc.rows*128;const out=new Uint8Array(W*H);let placed=0;for(let i=0;i<wc.cells.length;i++){const f=wc.cells[i];const t=tiles.get(f.mapId);if(!t)continue;const q=raw?0:((f.rotation||0)%4);const d=rotQ(t,q);const cx=(i%wc.cols)*128,cy=((i/wc.cols)|0)*128;for(let y=0;y<128;y++)for(let x=0;x<128;x++)out[(cy+y)*W+cx+x]=d[y*128+x];placed++};return{data:out,W,H,placed,wc}}
function assembleWallAuto(wall,tiles){const wca=wallCellsAdvanced(wall);if(!wca||!wca.length)return null;let globalBest=null;for(const wc of wca){const{cells,cols,rows,ori}=wc;const colPerms=perms([...Array(cols).keys()]);const Ink=[];for(let i=0;i<cells.length;i++){const cell=cells[i];const t=tiles.get(cell.mapId);let ink=new Uint8Array(16384);if(t){const d=rotQ(t,(cell.rotation||0)%4);const im=inkMaskWall(d,128,128);ink=im.ink};Ink.push(ink)};for(const cp of colPerms){let cost=0;for(let r=0;r<rows;r++)for(let k=0;k<cols-1;k++)cost+=seamV_ink(Ink[r*cols+cp[k]],Ink[r*cols+cp[k+1]]);for(let k=0;k<cols;k++)for(let r=0;r<rows-1;r++)cost+=seamH_ink(Ink[r*cols+cp[k]],Ink[(r+1)*cols+cp[k]]);if(!globalBest||cost<globalBest.cost)globalBest={cost,cp,rp:[...Array(rows).keys()],ori,cells,cols,rows}}};if(!globalBest)return null;const{cp,cells,cols,rows,ori}=globalBest;const W=cols*128,H=rows*128;const out=new Uint8Array(W*H);let placed=0;for(let k=0;k<cols;k++)for(let m=0;m<rows;m++){const c=cp[k],r=m,cell=cells[r*cols+c];if(cell&&tiles.has(cell.mapId))placed++;const t=tiles.get(cell.mapId);let patch=new Uint8Array(16384);if(t)patch=rotQ(t,(cell.rotation||0)%4);for(let y=0;y<128;y++)for(let x=0;x<128;x++)out[(m*128+y)*W+(k*128+x)]=patch[y*128+x]};return{data:out,W,H,placed,wc:{cells,cols,rows},colPerm:cp,seamCost:globalBest.cost,ori:ori.name}}
function getMapId(p){if(!p)return null;for(const k of ['itemDamage','mapId','id','map'])if(typeof p[k]==='number')return p[k];return null}

// ========================= v3.8.3: нормальный kick reason =========================
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
  try {
    if (typeof r.toString === 'function') { const s = r.toString(); if (s && s !== '[object Object]') return s }
  } catch (e) {}
  const strs = extractStrings(r, [])
  if (strs.length) return strs.join('')
  try { return JSON.stringify(r).slice(0, 200) } catch (e) { return '' }
}

// ========================= IP =========================
async function getIp() {
  return new Promise(resolve => {
    SocksClient.createConnection({ proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password }, command: 'connect', destination: { host: 'api.ipify.org', port: 80 } })
      .then(conn => {
        let data = ''
        const t = setTimeout(() => { try { conn.socket.destroy() } catch (e) {}; resolve(null) }, 10000)
        conn.socket.on('data', d => { data += d.toString(); const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/); if (m && data.includes('\r\n\r\n')) { clearTimeout(t); try { conn.socket.destroy() } catch (e) {}; resolve(m[1]) } })
        conn.socket.on('error', () => { clearTimeout(t); resolve(null) })
        conn.socket.on('end', () => { clearTimeout(t); const m = data.match(/(\d{1,3}(?:\.\d{1,3}){3})/); resolve(m ? m[1] : null) })
        conn.socket.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n')
      }).catch(() => resolve(null))
  })
}
async function httpGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const req = (u.protocol === 'https:' ? require('https') : require('http')).get(urlStr, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}
async function rotateIp() {
  if (!PROXY.changeIpUrl || PROXY.changeIpUrl.includes('YOUR_KEY')) { step('changeIpUrl не задан'); return null }
  const oldIp = await getIp()
  step('IP до ротации: ' + (oldIp || '?'))
  try { const r = await httpGet(PROXY.changeIpUrl, 15000); step('changeIp: status=' + r.status) } catch (e) { step('changeIp fail: ' + e.message) }
  await sleep(Math.max(5000, (Number(PROXY.waitSec) || 12) * 1000))
  const newIp = await getIp()
  step(newIp && newIp !== oldIp ? ('IP СМЕНЁН: ' + oldIp + ' -> ' + newIp) : 'IP не сменился')
  currentRunIp = newIp
  return newIp
}

// ========================= СОХРАНЕНИЕ (ПОЛНОЕ, как в v3.7.x) =========================
function saveRecord(outDir, col, originalTag) {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(col.frames, null, 2))
    fs.writeFileSync(path.join(outDir, 'chat.log'), col.chats.join('\n'))
    fs.writeFileSync(path.join(outDir, 'packets.log'), col.packets.join('\n'))
    fs.writeFileSync(path.join(outDir, 'session_log.txt'), col.events.join('\n'))
    if (col.view) fs.writeFileSync(path.join(outDir, 'view.json'), JSON.stringify(col.view, null, 2))
    
    const ocrLines = []
    for (const wr of col.wallResults) {
      const isOrig = wr.tag === originalTag
      const asm = wr.asm
      
      if (isOrig) {
        fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA.png'), colorPng(asm.data, asm.W, asm.H, 2))
        const raw0 = assembleWall(wr.wall, col.maps, true)
        if (raw0) fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_no_rotate.png'), colorPng(raw0.data, raw0.W, raw0.H, 2))
        fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask.png'), bwPng(wr.ink, asm.W, asm.H, 2))
        if (wr.rowMask) {
          fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_digits.png'), bwPng(wr.rowMask, asm.W, asm.H, 2))
          fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_digits_x2.png'), bwPng(wr.rowMask, asm.W, asm.H, 2))
        }
        fs.writeFileSync(path.join(outDir, 'ORIGINAL_raw.bin'), Buffer.from(asm.data))
        const layout = []
        if (asm.wc) for (let i = 0; i < asm.wc.cells.length; i++) { const f = asm.wc.cells[i]; layout.push({ cell: i, tile: f.mapId, rot: (f.rotation || 0) % 4 }) }
        fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify(layout, null, 2))
        fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true })
        layout.forEach((L, i) => { const raw = col.maps.get(L.tile); if (raw) fs.writeFileSync(path.join(outDir, 'tiles', 'tile_' + String(i).padStart(2, '0') + '_map' + L.tile + '.bin'), Buffer.from(raw)) })
      } else {
        fs.writeFileSync(path.join(outDir, 'DECOY_NOT_ORIGINAL_' + wr.tag + '.png'), colorPng(asm.data, asm.W, asm.H, 2))
        const ddir = path.join(outDir, 'tiles_decoy_' + wr.tag)
        fs.mkdirSync(ddir, { recursive: true })
        wr.wall.frames.forEach((f, i) => { const raw = col.maps.get(f.mapId); if (raw) fs.writeFileSync(path.join(ddir, 'tile_' + String(i).padStart(2, '0') + '_map' + f.mapId + '.bin'), Buffer.from(raw)) })
      }
      
      ocrLines.push('=== WALL ' + wr.tag + (isOrig ? ' (ORIGINAL)' : ' (decoy)') + ' score=' + wr.score.toFixed(0) + ' ===')
      for (const c of wr.candidates) ocrLines.push('  "' + c.digits + '" conf=' + c.conf.toFixed(1) + ' [' + c.src + ']')
    }
    fs.writeFileSync(path.join(outDir, 'ocr_candidates.txt'), ocrLines.join('\n'))
    step('[SAVE] ' + outDir)
  } catch (e) { step('[SAVE] error: ' + e.message) }
}

// ========================= РАУНД =========================
async function doRound(roundNum) {
  return new Promise(resolve => {
    const col = {
      maps: new Map(), frames: [], framesById: new Map(),
      chats: [], packets: [], events: [], prompts: 0, dead: false,
      candidates: [], sentIndex: -1, answerResult: null, promptsSinceSend: 0,
      ocrRunning: false, wallResults: [], view: null,
      debugDir: path.join(REC_ROOT, 'round' + roundNum + '_' + STAMP)
    }
    const ev = s => { col.events.push(new Date().toISOString() + ' ' + s); step('[r' + roundNum + '] ' + s) }
    let finished = false, bot = null, hardT = null, loginT = null, watchdog = null
    
    const finish = (result) => {
      if (finished) return
      finished = true
      try { if (hardT) clearTimeout(hardT) } catch (e) {}
      try { if (loginT) clearTimeout(loginT) } catch (e) {}
      try { if (watchdog) clearTimeout(watchdog) } catch (e) {}
      try { if (bot && bot.entity && bot.entity.position) col.view = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch } } catch (e) {}
      try { if (bot) bot.end('done') } catch (e) {}
      resolve(result)
    }
    
    const armWatchdog = () => {
      try { if (watchdog) clearTimeout(watchdog) } catch (e) {}
      watchdog = setTimeout(() => {
        if (!finished && col.sentIndex >= 0) {
          ev('✅ тишина ' + (SILENT_PASS_MS/1000) + 'с после ответа = капча пройдена')
          finish({ ok: true, note: 'silent_pass', ocrSent: col.candidates[col.sentIndex] ? col.candidates[col.sentIndex].digits : '?' })
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
      if (col.ocrRunning || col.wallResults.length > 0) return
      col.ocrRunning = true
      try {
        const linked = col.frames.filter(f => f.mapId !== null && col.maps.has(f.mapId))
        ev('OCR: linked=' + linked.length)
        if (linked.length < MIN_PLACED) return
        const walls = clusterWalls(linked)
        for (const w of walls) {
          const asm = assembleWallAuto(w, col.maps)
          if (!asm || asm.placed < 8) continue
          const res = await ocrWall(asm, w.tag, col.debugDir)
          col.wallResults.push({ tag: w.tag, wall: w, asm, ink: res.ink, rowMask: res.rowMask, candidates: res.candidates, score: res.score })
        }
        // ORIGINAL = стена с лучшим score ряда
        col.wallResults.sort((a, b) => b.score - a.score)
        const all = []
        for (const wr of col.wallResults) for (const c of wr.candidates) all.push(Object.assign({ wall: wr.tag }, c))
        const seen = new Set()
        for (const c of all) if (!seen.has(c.digits)) { seen.add(c.digits); col.candidates.push(c) }
        col.candidates.sort((a, b) => b.conf - a.conf)
        ev('📋 кандидатов: ' + col.candidates.length + (col.candidates[0] ? ' лучший="' + col.candidates[0].digits + '" (стена ' + col.candidates[0].wall + ')' : ''))
      } catch (e) {
        ev('❌ OCR error: ' + e.message)
      } finally { col.ocrRunning = false }
    }
    
    hardT = setTimeout(() => finish({ ok: false, note: 'hard timeout' }), CAPTCHA_TIMEOUT_MS)
    if (!PROXY.host) { finish({ ok: false, note: 'нет proxy.host' }); return }
    
    SocksClient.createConnection({
      proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password },
      command: 'connect', destination: { host: MC.host, port: MC.port }
    }).then(conn => {
      ev('socks ok -> ' + MC.host)
      const nick = (NICK_PREFIX + Math.floor(Math.random() * 9000 + 1000)).slice(0, 16)
      loginT = setTimeout(() => { if (!finished) finish({ ok: false, note: 'login timeout' }) }, LOGIN_TIMEOUT_MS)
      
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
      
      bot.on('entitySpawn', ent => {
        const nm = String(ent.name || ent.type || '')
        if (!/item_frame|glow_item_frame/i.test(nm) || !ent.position) return
        if (col.framesById.has(ent.id)) return
        const f = { id: ent.id, x: ent.position.x, y: ent.position.y, z: ent.position.z, mapId: null, rotation: 0 }
        col.frames.push(f); col.framesById.set(ent.id, f)
      })
      bot._client.on('entity_metadata', pk => {
        try {
          const f = col.framesById.get(pk.entityId); if (!f) return
          for (const e of (pk.metadata || [])) {
            const val = e.value
            if (val && typeof val === 'object' && Array.isArray(val.components)) {
              for (const comp of val.components) if (comp && comp.type === 'map_id' && typeof comp.data === 'number') f.mapId = comp.data
            }
            if (typeof val === 'number' && (e.key === 9 || e.key === 10 || e.key === 8)) f.rotation = val
          }
        } catch (e) {}
      })
      
      bot.on('message', async msg => {
        let t = ''
        try { t = msg.toString() } catch (e) { try { t = JSON.stringify(msg.json || msg) } catch (e2) {} }
        col.chats.push(t)
        ev('💬 ' + t.slice(0, 100))
        const low = t.toLowerCase()
        
        // результат ответа
        if (col.sentIndex >= 0 && col.answerResult === null) {
          if (/неверн|incorrect|wrong|ошибк|неправильн|попробуй ещё|попробуйте ещё/i.test(low)) {
            col.answerResult = 'wrong'
            ev('❌ неверно → следующий кандидат')
            col.answerResult = null
            sendNext('retry после неверного')
            return
          }
          if (/принят|accepted|верно|correct|успеш|прошел|прошёл|добро пожал|welcome/i.test(low)) {
            col.answerResult = 'correct'
            finish({ ok: true, note: 'correct_answer', ocrSent: col.candidates[col.sentIndex].digits })
            return
          }
        }
        
        // промпт капчи
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
      
      bot.on('login', () => { clearTimeout(loginT); ev('login ok (' + nick + ')') })
      bot.on('kicked', r => {
        if (finished) return
        const reason = kickReason(r)
        ev('kicked: ' + reason.slice(0, 200))
        col.dead = true
        // v3.8.3: kick = ВСЕГДА провал (кончились попытки / антибот)
        finish({ ok: false, note: 'kicked: ' + reason.slice(0, 100), ocrSent: col.sentIndex >= 0 && col.candidates[col.sentIndex] ? col.candidates[col.sentIndex].digits : null })
      })
      bot.on('end', reason => { if (finished) return; col.dead = true; finish({ ok: false, note: 'end: ' + String(reason || '').slice(0, 80) }) })
      bot.on('error', e => { if (finished) return; col.dead = true; finish({ ok: false, note: 'error: ' + e.message }) })
    }).catch(e => { ev('socks fail: ' + e.message); finish({ ok: false, note: 'socks: ' + e.message }) })
  })
}

// ========================= MAIN =========================
async function main() {
  step('=== СТАРТ v3.8.3 — PER-DIGIT OCR + ЧЕСТНАЯ СТАТИСТИКА ===')
  await ensureAllDeps()
  step('')
  step('MC: ' + MC.host + ':' + MC.port + ' | proxy: ' + PROXY.host)
  if (!CFG_PATH) { step('НЕ НАЙДЕН config.json'); process.exit(1) }
  await initTesseract()
  
  const results = []; const tGlobal = Date.now(); let okCount = 0
  await rotateIp()
  
  for (let r = 1; r <= TARGET_ROUNDS; r++) {
    step('--- РАУНД ' + r + '/' + TARGET_ROUNDS + ' (IP ' + (currentRunIp || '?') + ') ---')
    const res = await doRound(r)
    
    // сохраняем ВСЕ стены раунда (original + decoys)
    if (res.wallResults || (res.col && res.col.wallResults)) {}
    try {
      // wallResults лежат внутри col, возвращаем их через res
      if (res.walls && res.walls.length) {
        const dir = path.join(REC_ROOT, 'live_round' + r + '_' + STAMP)
        saveRecord(dir, res.colData, res.originalTag)
      }
    } catch (e) {}
    
    if (res.ok) { okCount++; step('✅ РАУНД ' + r + ': "' + (res.ocrSent || '?') + '" | ' + res.note) }
    else {
      step('❌ РАУНД ' + r + ': ' + res.note + (res.ocrSent ? ' (отпр: "' + res.ocrSent + '")' : ''))
      if (/ECONNRESET|login timeout|socks/.test(res.note)) {
        consecutiveNetFails++
        if (consecutiveNetFails >= 2) { step('🔄 2 сетевых фейла → ротация IP'); await rotateIp(); consecutiveNetFails = 0; await sleep(2000) }
      } else consecutiveNetFails = 0
    }
    results.push({ n: r, ok: res.ok, note: res.note, ocr: res.ocrSent || '-' })
    if (r < TARGET_ROUNDS) await sleep(PAUSE_BETWEEN_MS)
  }
  
  if (tesseractWorker) { try { await tesseractWorker.terminate() } catch (e) {} }
  
  const L = ['=== СВОДКА ===', 'успех: ' + okCount + '/' + TARGET_ROUNDS + ' (' + Math.round(okCount/TARGET_ROUNDS*100) + '%)', '']
  for (const x of results) L.push('  #' + x.n + ': ' + (x.ok ? '✅' : '❌') + ' ocr="' + x.ocr + '" — ' + x.note)
  step('готово.')
  flushReport(L.join('\n')); console.log('\n' + L.join('\n'))
  setTimeout(() => process.exit(0), 2000)
}

main().catch(e => { console.error('!!! FATAL !!!', e.message, e.stack); flushReport('FATAL: ' + (e.stack || e.message)); setTimeout(() => process.exit(1), 2000) })
