// VERSION: 3.8.2
// main.js
// v3.8.2: color-сегментация + crop + upscale + Tesseract multi-PSM
//         + список кандидатов + retry при "неверно" + авто-установка
const mineflayer = require('mineflayer')
const { SocksClient } = require('socks')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { spawn } = require('child_process')

const TARGET_ROUNDS = 10
const PAUSE_BETWEEN_MS = 3000
const MIN_PLACED = 10
const CAPTCHA_TIMEOUT_MS = 45000
const LOGIN_TIMEOUT_MS = 30000

// ========================= ГЛОБАЛЬНЫЕ =========================
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []
let REC_ROOT = null
let tesseractWorker = null
let Tesseract = null

function step(s) {
  const l = new Date().toISOString().slice(11, 19) + ' [step] ' + s
  SLOG.push(l); console.log(l)
}
function flushReport(extra) {
  if (!REC_ROOT) return
  try { fs.writeFileSync(path.join(REC_ROOT, 'report_' + STAMP + '.txt'), SLOG.join('\n') + '\n' + (extra || '')) } catch (e) {}
}
process.on('uncaughtException', e => { console.error('!!! UNCAUGHT !!!', e.message, e.stack); flushReport('UNCAUGHT: ' + (e.stack || e.message)); setTimeout(() => process.exit(1), 1000) })
process.on('unhandledRejection', e => { console.error('!!! REJECTION !!!', e); flushReport('REJECTION: ' + String(e)) })

// ========================= АВТО-УСТАНОВКА =========================
function ensurePackageJson() {
  const pkgPath = path.join(__dirname, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'funtime-captcha-bot', version: '3.8.2', private: true, dependencies: {} }, null, 2))
    step('[SETUP] package.json создан')
  }
}
function installPackage(name) {
  return new Promise((resolve, reject) => {
    step('[NPM] npm install ' + name + ' ...')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', name, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: __dirname, stdio: 'inherit', shell: process.platform === 'win32' })
    const t = setTimeout(() => { try { child.kill() } catch (e) {}; reject(new Error('таймаут установки ' + name)) }, 180000)
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
  await ensureDep('mineflayer')
  await ensureDep('socks')
  await ensureDep('tesseract.js')
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

// ========================= МОРФОЛОГИЯ / СЕГМЕНТАЦИЯ =========================
const NB8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
function erode(m,W,H){const o=new Uint8Array(m.length);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(m[i]&&m[i-1]&&m[i+1]&&m[i-W]&&m[i+W])o[i]=1}return o}
function dilate(m,W,H){const o=new Uint8Array(m.length);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(m[i]||(x>0&&m[i-1])||(x<W-1&&m[i+1])||(y>0&&m[i-W])||(y<H-1&&m[i+W]))o[i]=1}return o}
function closing(m,W,H,r){let x=m;for(let i=0;i<r;i++)x=dilate(x,W,H);for(let i=0;i<r;i++)x=erode(x,W,H);return x}
function removeNoise(mask,W,H,minSize){const vis=new Uint8Array(mask.length),clean=new Uint8Array(mask.length);const i0=(x,y)=>y*W+x;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=i0(x,y);if(!mask[i]||vis[i])continue;const st=[x,y];vis[i]=1;const comp=[];let mnX=x,mxX=x,mnY=y,mxY=y;while(st.length){const cy=st.pop(),cx=st.pop();comp.push(cx,cy);if(cx<mnX)mnX=cx;if(cx>mxX)mxX=cx;if(cy<mnY)mnY=cy;if(cy>mxY)mxY=cy;for(const nb of NB8){const nx=cx+nb[0],ny=cy+nb[1];if(nx<0||ny<0||nx>=W||ny>=H)continue;const ni=i0(nx,ny);if(mask[ni]&&!vis[ni]){vis[ni]=1;st.push(nx,ny)}}};if(comp.length/2>=minSize)for(let k=0;k<comp.length;k+=2)clean[i0(comp[k],comp[k+1])]=1}return clean}

function inkMaskWall(data,W,H){const wc=new Int32Array(256);for(let i=0;i<data.length;i++) wc[data[i]]++;const bgW=new Set();for(let v=1;v<256;v++) if(wc[v]>=6000 && LUM[v]>=120) bgW.add(v);const iso={};for(let v=1;v<256;v++){const c=wc[v];if(c<150||c>6000||bgW.has(v)||LUM[v]<120) continue;const stp=Math.max(1,Math.floor(c/300));let checked=0,isolated=0;for(let i=v%7;i<data.length&&checked<300;i+=stp){if(data[i]!==v)continue;const x=i%W,y=(i/W)|0;if(x<1||x>=W-1||y<1||y>=H-1)continue;checked++;let same=false;for(const nb of NB8){const nx=x+nb[0],ny=y+nb[1];if(data[ny*W+nx]===v){same=true;break}};if(!same)isolated++};iso[v]=checked?isolated/checked:0;if(iso[v]>=0.6)bgW.add(v)};const ink=new Uint8Array(data.length);for(let r=0;r<H/128;r++)for(let c=0;c<W/128;c++){const counts=new Int32Array(256);const x0=c*128,y0=r*128;for(let y=0;y<128;y++)for(let x=0;x<128;x++)counts[data[(y0+y)*W+x0+x]]++;const bg=new Set(bgW);for(let v=1;v<256;v++){if(LUM[v]>=120 && (counts[v]>=1200 || (iso[v]||0)>=0.6)) bg.add(v)};for(let y=0;y<128;y++)for(let x=0;x<128;x++){const i=(y0+y)*W+x0+x;const v=data[i];if(v!==0&&!bg.has(v))ink[i]=1}};return { ink }}

// v3.8.2: ЦВЕТОВАЯ сегментация цифр (ключ к успеху!)
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

function analyzeColors(data, ink, W, H) {
  const colorCounts = new Int32Array(256)
  for (let i = 0; i < ink.length; i++) if (ink[i]) colorCounts[data[i]]++
  const digitMask = new Uint8Array(ink.length)
  let dmColor = 0
  for (let v = 1; v < 256; v++) {
    if (colorCounts[v] < 60) continue
    const m = new Uint8Array(ink.length)
    for (let i = 0; i < ink.length; i++) if (ink[i] && data[i] === v) m[i] = 1
    for (const c of compsList(m, W, H, true)) {
      const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
      if (c.a < 80) continue
      if (h < H * 0.07 || h > H * 0.85) continue
      if (w < W * 0.02 || w > W * 0.30) continue
      if (w + h > W * 0.75) continue
      const fill = c.a / (w * h)
      if (fill < 0.05 || fill > 0.97) continue
      if (isStraight(c, w, h)) continue
      dmColor++
      for (let k = 0; k < c.px.length; k++) digitMask[c.px[k]] = 1
    }
  }
  return { dmColor, digitMask }
}

// v3.8.2: bounding box + crop
function getBBox(mask, W, H) {
  let mnX = W, mnY = H, mxX = -1, mxY = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mask[y*W+x]) { if (x<mnX) mnX=x; if (x>mxX) mxX=x; if (y<mnY) mnY=y; if (y>mxY) mxY=y }
  }
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

// ========================= FALLBACK: pattern OCR =========================
const DIGITS={'0':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'1':[[0,0,1,0,0],[0,1,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,1,1,0]],'2':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]],'3':[[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'4':[[0,0,0,1,0],[0,0,1,1,0],[0,1,0,1,0],[1,0,0,1,0],[1,1,1,1,1],[0,0,0,1,0],[0,0,0,1,0]],'5':[[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'6':[[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'7':[[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],'8':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],'9':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,1],[0,0,0,0,1],[0,0,0,0,1],[0,1,1,1,0]]}
function matchPat(mask,W,H,bx,by,bw,bh){const pat=[];for(let py=0;py<7;py++){const row=[];for(let px=0;px<5;px++){const sx=bx+Math.floor(px*bw/5),ex=bx+Math.floor((px+1)*bw/5),sy=by+Math.floor(py*bh/7),ey=by+Math.floor((py+1)*bh/7);let c=0,t=0;for(let y=sy;y<ey;y++)for(let x=sx;x<ex;x++){c+=mask[y*W+x];t++};row.push(t&&(c/t)>0.35?1:0)};pat.push(row)};let bd='?',bs=0;for(const d in DIGITS){let m=0;for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(pat[y][x]===DIGITS[d][y][x])m++;const s=m/35;if(s>bs){bs=s;bd=d}};return{best:bd,score:Math.round(bs*100)/100}}
function patternOcr(mask,W,H){const digits=[];for (const c of compsList(mask, W, H, false)) {const w=c.mxX-c.mnX+1,h=c.mxY-c.mnY+1;if(c.a<Math.max(80,W*H/1600))continue;if(w<W*0.02||w>W*0.5)continue;if(h<H*0.07||h>H*0.92)continue;if(isStraight(c,w,h))continue;const m=matchPat(mask,W,H,c.mnX,c.mnY,w,h);digits.push({x:c.mnX,best:m.best,score:m.score})};digits.sort((a,b)=>a.x-b.x);let text='';for(const d of digits) if(d.score>=0.5) text+=d.best;return { text, count: digits.filter(d=>d.score>=0.5).length }}

// ========================= TESSERACT =========================
async function initTesseract() {
  if (tesseractWorker) return tesseractWorker
  step('[OCR] 🚀 Инициализация Tesseract (первый раз ~20-40с)...')
  tesseractWorker = await Tesseract.createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'loading language traineddata' && m.progress > 0 && m.progress < 1) {
        process.stdout.write('\r[OCR] 📥 lang data: ' + Math.round(m.progress*100) + '%   ')
      }
    }
  })
  process.stdout.write('\n')
  await tesseractWorker.setParameters({ tessedit_char_whitelist: '0123456789' })
  step('[OCR] ✅ Tesseract готов')
  return tesseractWorker
}

// v3.8.2: ГЛАВНАЯ OCR-функция — color mask → crop → upscale → Tesseract multi-PSM
async function ocrWall(asm, label, debugDir) {
  const W = asm.W, H = asm.H
  const im = inkMaskWall(asm.data, W, H)
  const ac = analyzeColors(asm.data, im.ink, W, H)
  
  let mask = ac.digitMask
  mask = closing(mask, W, H, 1)
  mask = removeNoise(mask, W, H, 25)
  
  const bbox = getBBox(mask, W, H)
  if (!bbox || bbox.w < 20 || bbox.h < 15) {
    step('[OCR] ' + label + ': ❌ маска цифр пустая (dmColor=' + ac.dmColor + ')')
    return []
  }
  step('[OCR] ' + label + ': маска цифр bbox=' + bbox.w + 'x' + bbox.h + ' (dmColor=' + ac.dmColor + ')')
  
  const pad = 6
  const cropped = cropMask(mask, bbox, W, H, pad)
  const scale = cropped.h < 40 ? 4 : cropped.h < 80 ? 3 : cropped.h < 160 ? 2 : 1
  
  const pngBlack = maskToPng(cropped.mask, cropped.w, cropped.h, false, scale)
  const pngWhite = maskToPng(cropped.mask, cropped.w, cropped.h, true, scale)
  
  if (debugDir) {
    try {
      fs.mkdirSync(debugDir, { recursive: true })
      fs.writeFileSync(path.join(debugDir, 'mask_' + label + '.png'), maskToPng(mask, W, H, false, 1))
      fs.writeFileSync(path.join(debugDir, 'crop_' + label + '.png'), pngBlack)
      fs.writeFileSync(path.join(debugDir, 'wall_' + label + '.png'), colorPng(asm.data, W, H, 2))
    } catch (e) {}
  }
  
  const worker = await initTesseract()
  const candidates = []
  
  // Tesseract: 3 PSM × 2 инверсии
  for (const psm of ['7', '6', '13']) {
    for (let inv = 0; inv < 2; inv++) {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: psm })
        const r = await worker.recognize(inv ? pngWhite : pngBlack)
        const digits = (r.data.text || '').replace(/[^0-9]/g, '')
        if (digits.length > 0) {
          candidates.push({ digits, conf: r.data.confidence || 0, src: 'tess-psm' + psm + (inv ? '-inv' : '') })
        }
      } catch (e) {}
    }
  }
  
  // Fallback: pattern OCR по цветной маске
  try {
    const pr = patternOcr(mask, W, H)
    if (pr.text && pr.count >= 3) candidates.push({ digits: pr.text, conf: 40, src: 'pattern' })
  } catch (e) {}
  
  // Сортировка: приоритет длине 4-7, потом confidence
  candidates.sort((a, b) => {
    const ag = (a.digits.length >= 4 && a.digits.length <= 7) ? 1 : 0
    const bg = (b.digits.length >= 4 && b.digits.length <= 7) ? 1 : 0
    if (ag !== bg) return bg - ag
    return b.conf - a.conf
  })
  
  // Убираем дубликаты
  const seen = new Set()
  const unique = []
  for (const c of candidates) {
    if (!seen.has(c.digits)) { seen.add(c.digits); unique.push(c) }
  }
  
  step('[OCR] ' + label + ': кандидатов=' + unique.length)
  for (const c of unique.slice(0, 5)) {
    step('[OCR]   "' + c.digits + '" conf=' + c.conf.toFixed(1) + ' [' + c.src + ']')
  }
  
  return unique
}

// ========================= СБОРКА СТЕНЫ =========================
function rotQ(d,q){q=((q%4)+4)%4;if(!q)return Uint8Array.from(d);const o=new Uint8Array(16384);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const v=d[y*128+x];if(q===1)o[x*128+127-y]=v;else if(q===2)o[(127-y)*128+(127-x)]=v;else o[(127-x)*128+y]=v};return o}
function clusterWalls(frames){const counts={};frames.forEach(f=>{counts['x:'+Math.round(f.x)]=(counts['x:'+Math.round(f.x)]||0)+1;counts['z:'+Math.round(f.z)]=(counts['z:'+Math.round(f.z)]||0)+1});const planes=Object.entries(counts).filter(([,v])=>v>=8).sort((a,b)=>b[1]-a[1]);const walls=[],used=new Set();for(const[key]of planes){const[axis,val]=key.split(':');const members=frames.filter(f=>!used.has(f.id)&&Math.round(f[axis])===+val);if(members.length<8)continue;members.forEach(f=>used.add(f.id));walls.push({axis,value:+val,frames:members,tag:axis+val});if(walls.length===2)break};return walls}
function clusterCoords(vals){if(!vals||!vals.length)return[];const sorted=vals.slice().sort((a,b)=>a-b);const clusters=[];let cur=[sorted[0]];for(let i=1;i<sorted.length;i++){if(sorted[i]-cur[0]<0.6)cur.push(sorted[i]);else{clusters.push(cur.reduce((s,x)=>s+x,0)/cur.length);cur=[sorted[i]]}};clusters.push(cur.reduce((s,x)=>s+x,0)/cur.length);return clusters}
function wallCellsAdvanced(wall){const horiz=wall.axis==='x'?'z':'x';const hVals=wall.frames.map(f=>f[horiz]);const yVals=wall.frames.map(f=>f.y);const hCenters=clusterCoords(hVals);const yCenters=clusterCoords(yVals);const cols=hCenters.length,rows=yCenters.length;if(cols*rows!==wall.frames.length)return null;const results=[];for(const ori of [{hAsc:true,yAsc:false},{hAsc:false,yAsc:false},{hAsc:true,yAsc:true},{hAsc:false,yAsc:true}]){const hs=ori.hAsc?hCenters.slice():hCenters.slice().reverse();const ys=ori.yAsc?yCenters.slice():yCenters.slice().reverse();const cells=new Array(cols*rows).fill(null);let missing=0;for(const f of wall.frames){let bestH=0,minDh=1e9;for(let i=0;i<hs.length;i++){const d=Math.abs(f[horiz]-hs[i]);if(d<minDh){minDh=d;bestH=i}};let bestY=0,minDy=1e9;for(let i=0;i<ys.length;i++){const d=Math.abs(f.y-ys[i]);if(d<minDy){minDy=d;bestY=i}};const idx=bestY*cols+bestH;if(cells[idx])missing++;cells[idx]=f};if(missing>0||cells.some(c=>!c))continue;results.push({cells,cols,rows})};return results.length?results:null}
function seamV_ink(inkA,inkB){let cost=0;for(let y=0;y<128;y++){if(inkA[y*128+127]!==inkB[y*128+0])cost+=10};return cost}
function perms(arr){if(arr.length<=1)return[arr.slice()];const res=[];for(let i=0;i<arr.length;i++){const rest=arr.slice(0,i).concat(arr.slice(i+1));for(const p of perms(rest))res.push([arr[i]].concat(p))};return res}
function assembleWallAuto(wall,tiles){const wca=wallCellsAdvanced(wall);if(!wca||!wca.length)return null;let globalBest=null;for(const wc of wca){const{cells,cols,rows}=wc;const colPerms=cols<=5?perms([...Array(cols).keys()]):[[...Array(cols).keys()]];const Ink=[];for(let i=0;i<cells.length;i++){const cell=cells[i];const t=tiles.get(cell.mapId);let ink=new Uint8Array(16384);if(t){const d=rotQ(t,(cell.rotation||0)%4);const im=inkMaskWall(d,128,128);ink=im.ink};Ink.push(ink)};for(const cp of colPerms){let cost=0;for(let r=0;r<rows;r++)for(let k=0;k<cols-1;k++)cost+=seamV_ink(Ink[r*cols+cp[k]],Ink[r*cols+cp[k+1]]);if(!globalBest||cost<globalBest.cost)globalBest={cost,cp,cells,cols,rows}}};if(!globalBest)return null;const{cp,cells,cols,rows}=globalBest;const W=cols*128,H=rows*128;const out=new Uint8Array(W*H);let placed=0;for(let k=0;k<cols;k++)for(let m=0;m<rows;m++){const c=cp[k],cell=cells[m*cols+c];if(cell&&tiles.has(cell.mapId))placed++;const t=tiles.get(cell.mapId);let patch=new Uint8Array(16384);if(t)patch=rotQ(t,(cell.rotation||0)%4);for(let y=0;y<128;y++)for(let x=0;x<128;x++)out[(m*128+y)*W+(k*128+x)]=patch[y*128+x]};return{data:out,W,H,placed}}
function getMapId(p){if(!p)return null;for(const k of ['itemDamage','mapId','id','map'])if(typeof p[k]==='number')return p[k];return null}

// v3.8.2: нормальное извлечение текста kick
function kickReason(r) {
  if (!r) return ''
  if (typeof r === 'string') return r
  if (typeof r.text === 'string' && r.text) return r.text
  if (Array.isArray(r.extra)) return r.extra.map(e => (e && e.text) || '').join('')
  try { return JSON.stringify(r).slice(0, 200) } catch (e) { return String(r) }
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

// ========================= РАУНД =========================
async function doRound(roundNum) {
  return new Promise(resolve => {
    const col = {
      maps: new Map(), frames: [], framesById: new Map(),
      prompts: 0, dead: false,
      candidates: [], sentIndex: -1, answerResult: null,
      ocrRunning: false, debugDir: path.join(REC_ROOT, 'round' + roundNum + '_' + STAMP)
    }
    let finished = false, bot = null, hardT = null, loginT = null
    
    const finish = (result) => {
      if (finished) return
      finished = true
      try { if (hardT) clearTimeout(hardT) } catch (e) {}
      try { if (loginT) clearTimeout(loginT) } catch (e) {}
      try { if (bot) bot.end('done') } catch (e) {}
      resolve(result)
    }
    
    // v3.8.2: отправка следующего кандидата
    const sendNext = (why) => {
      if (!bot || finished) return
      if (col.sentIndex + 1 >= col.candidates.length) {
        step('[r' + roundNum + '] ⚠️ кандидатов больше нет (' + why + ')')
        return false
      }
      col.sentIndex++
      const cand = col.candidates[col.sentIndex]
      step('[r' + roundNum + '] 📤 ОТПРАВЛЯЮ #' + (col.sentIndex+1) + ': "' + cand.digits + '" (' + why + ', conf=' + cand.conf.toFixed(1) + ', ' + cand.src + ')')
      try { bot.chat(cand.digits) } catch (e) { step('[r' + roundNum + '] ❌ chat error: ' + e.message) }
      return true
    }
    
    // v3.8.2: запуск OCR на всех стенах, сбор кандидатов
    const runOcr = async () => {
      if (col.ocrRunning) return
      col.ocrRunning = true
      try {
        const linked = col.frames.filter(f => f.mapId !== null && col.maps.has(f.mapId))
        step('[r' + roundNum + '] OCR: linked=' + linked.length)
        if (linked.length < MIN_PLACED) return
        const walls = clusterWalls(linked)
        const all = []
        for (const w of walls) {
          const asm = assembleWallAuto(w, col.maps)
          if (!asm || asm.placed < 8) continue
          const cands = await ocrWall(asm, w.tag, col.debugDir)
          for (const c of cands) all.push(c)
        }
        // мержим с уже имеющимися, убираем дубли
        const seen = new Set(col.candidates.map(c => c.digits))
        for (const c of all) if (!seen.has(c.digits)) { seen.add(c.digits); col.candidates.push(c) }
        col.candidates.sort((a, b) => {
          const ag = (a.digits.length >= 4 && a.digits.length <= 7) ? 1 : 0
          const bg = (b.digits.length >= 4 && b.digits.length <= 7) ? 1 : 0
          if (ag !== bg) return bg - ag
          return b.conf - a.conf
        })
        step('[r' + roundNum + '] 📋 всего кандидатов: ' + col.candidates.length + (col.candidates[0] ? ' лучший="' + col.candidates[0].digits + '"' : ''))
      } catch (e) {
        step('[r' + roundNum + '] ❌ OCR error: ' + e.message)
      } finally {
        col.ocrRunning = false
      }
    }
    
    hardT = setTimeout(() => finish({ ok: false, note: 'hard timeout' }), CAPTCHA_TIMEOUT_MS)
    if (!PROXY.host) { finish({ ok: false, note: 'нет proxy.host' }); return }
    
    SocksClient.createConnection({
      proxy: { host: PROXY.host, port: PROXY.port, type: 5, userId: PROXY.username, password: PROXY.password },
      command: 'connect', destination: { host: MC.host, port: MC.port }
    }).then(conn => {
      step('[r' + roundNum + '] socks ok -> ' + MC.host)
      const nick = (NICK_PREFIX + Math.floor(Math.random() * 9000 + 1000)).slice(0, 16)
      loginT = setTimeout(() => { if (!finished) finish({ ok: false, note: 'login timeout' }) }, LOGIN_TIMEOUT_MS)
      
      bot = mineflayer.createBot({ username: nick, host: MC.host, port: MC.port, version: MC.version, socket: conn.socket, hideErrors: true, auth: 'offline', keepAlive: true })
      
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
        step('[r' + roundNum + '] 💬 ' + t.slice(0, 100))
        const low = t.toLowerCase()
        
        // реакция на результат ответа
        if (col.sentIndex >= 0 && col.answerResult === null) {
          if (/неверн|incorrect|wrong|ошибк|неправильн|попробуй/i.test(low)) {
            step('[r' + roundNum + '] ❌ неверно, пробую следующего кандидата...')
            col.answerResult = null
            sendNext('retry после неверного')
            return
          }
          if (/принят|accepted|верно|correct|успешн|прош/i.test(low)) {
            col.answerResult = 'correct'
            finish({ ok: true, note: 'correct_answer', ocrSent: col.candidates[col.sentIndex] ? col.candidates[col.sentIndex].digits : '?' })
            return
          }
        }
        
        // промпт капчи
        if (/введите номер|номер с картинки|введите капчу|captcha|enter code/i.test(low)) {
          col.prompts++
          step('[r' + roundNum + '] ПРОМПТ #' + col.prompts)
          
          // каждый промпт = шанс дозагрузить тайлы и повторить OCR
          await runOcr()
          
          if (col.sentIndex < 0 && col.candidates.length > 0) {
            sendNext('первый ответ')
          } else if (col.sentIndex >= 0 && col.answerResult === null && col.prompts >= 3) {
            // сервер повторяет промпт = наш ответ не принят, пробуем следующий
            step('[r' + roundNum + '] ⚠️ промпт повторяется — ответ не принят')
            sendNext('retry по повторному промпту')
          }
        }
      })
      
      bot.on('login', () => { clearTimeout(loginT); step('[r' + roundNum + '] login ok (' + nick + ')') })
      bot.on('kicked', r => {
        if (finished) return
        const reason = kickReason(r)
        step('[r' + roundNum + '] kicked: ' + reason.slice(0, 150))
        if (col.sentIndex >= 0 && col.answerResult === null && /captcha|капч|filter|verify|auth/i.test(reason.toLowerCase()) === false) {
          // кик без причины капчи = возможно прошли
          step('[r' + roundNum + '] ✅ kicked после ответа = капча пройдена')
          finish({ ok: true, note: 'captcha_passed', ocrSent: col.candidates[col.sentIndex].digits })
          return
        }
        col.dead = true
        finish({ ok: false, note: 'kicked: ' + reason.slice(0, 80), ocrSent: col.sentIndex >= 0 && col.candidates[col.sentIndex] ? col.candidates[col.sentIndex].digits : null })
      })
      bot.on('end', reason => { if (finished) return; col.dead = true; finish({ ok: false, note: 'end: ' + String(reason || '').slice(0, 80) }) })
      bot.on('error', e => { if (finished) return; col.dead = true; finish({ ok: false, note: 'error: ' + e.message }) })
    }).catch(e => { step('[r' + roundNum + '] socks fail: ' + e.message); finish({ ok: false, note: 'socks: ' + e.message }) })
  })
}

// ========================= MAIN =========================
async function main() {
  step('=== СТАРТ v3.8.2 — COLOR-OCR + RETRY ===')
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
    if (res.ok) { okCount++; step('✅ РАУНД ' + r + ': "' + (res.ocrSent || '?') + '" | ' + res.note) }
    else {
      step('❌ РАУНД ' + r + ': ' + res.note + (res.ocrSent ? ' (отпр: "' + res.ocrSent + '")' : ''))
      if (/login timeout|kicked/.test(res.note)) { await rotateIp(); await sleep(2000) }
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
