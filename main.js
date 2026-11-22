#!/usr/bin/env node
/* ============================================================
   TG ARCHIVER — один файл, без зависимостей (Node 16+)
   Архив всех чатов через "Автоматизация чатов" + лог правок/удалений
   Уведомления — в личку от имени бота. SOCKS5/HTTP прокси.
   Запуск: node main.js
   ============================================================ */
"use strict";

/* ================== НАСТРОЙКИ ================== */
const CFG = {
  BOT_TOKEN: "8196128553:AAFUxzJghI0dbixX2LFxGKK_pdJldATeZIg",
  PROXY: "socks5://BPqEoK:QHM9DK@45.153.20.220:10379",
  PROXY_ALT_HOST: "",           // IPv6 отключён: у тебя нет IPv6 (ENETUNREACH)

  ARCHIVE_DIR: "",              // пусто = Рабочий стол\TelegramArchive
  NOTIFY: true,                 // писать в личку о правках/удалениях
  NOTIFY_OWN: false,            // сообщать и о ТВОИХ правках/удалениях
  GREET_ON_START: true,         // отвечать на /start
  LOG_REGULAR_CHATS: true,      // логировать и группы, где бот состоит обычным способом
  EXCLUDE_CHAT_IDS: [],         // доп. исключения: ["123456789"]

  DOWNLOAD_FILES: true,         // качать документы/голосовые/аудио/стикеры
  MAX_DOWNLOAD_MB: 20,          // лимит Bot API на скачивание
  SKIP_MEDIA: ["photo", "video", "animation", "video_note"], // только заглушка + ссылка

  POLL_TIMEOUT: 25,
  NOTIFY_PAUSE_MS: 1200,
  VERBOSE: true
};
/* =============================================== */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const readline = require("readline");

/* ---------- токен: token.txt -> CFG -> окружение ---------- */
(function loadToken() {
  const clean = s => String(s || "")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "").trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^https?:\/\/api\.telegram\.org\/bot/i, "")
    .replace(/^bot(?=\d)/i, "")
    .replace(/\s+/g, "");
  const ok = t => /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(t);
  const tf = path.join(__dirname, "token.txt");
  const fromFile = fs.existsSync(tf) ? clean(fs.readFileSync(tf, "utf8")) : "";
  const fromCfg = clean(CFG.BOT_TOKEN);
  const fromEnv = clean(process.env.BOT_TOKEN);
  CFG.BOT_TOKEN = [fromFile, fromCfg, fromEnv].find(ok) || fromCfg || fromFile || fromEnv;
})();

/* ---------- пути ---------- */
function desktopDir() {
  const h = os.homedir();
  const c = [path.join(h, "Desktop"), path.join(h, "OneDrive", "Desktop"), path.join(h, "OneDrive - Personal", "Desktop")];
  return c.find(p => fs.existsSync(p)) || c[0];
}
const ROOT = CFG.ARCHIVE_DIR || path.join(desktopDir(), "TelegramArchive");
const D_CHATS = path.join(ROOT, "chats");
const D_FILES = path.join(ROOT, "files");
const P_STATE = path.join(ROOT, "state.json");
const P_CHANGES = path.join(ROOT, "changes.txt");
const P_LIST = path.join(ROOT, "chats.txt");

/* ---------- утилиты ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const pad = n => String(n).padStart(2, "0");
const log = (...a) => { if (CFG.VERBOSE) console.log(...a); };
const uniq = a => [...new Set(a.filter(x => x != null).map(String))];

function fmtTime(sec) {
  if (!sec) return "-";
  const d = new Date(Number(sec) * 1000);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function parseTime(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s || "");
  return m ? Math.floor(new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime() / 1000) : 0;
}
const oneLine = s => String(s == null ? "" : s).replace(/\t/g, " ").replace(/\r?\n/g, " / ").replace(/[\x00-\x1f]/g, "").trim();
const cleanName = s => oneLine(s) || "без имени";
const fileSafe = s => oneLine(s).replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "_").slice(0, 50) || "chat";
function humanSize(b) {
  b = Number(b || 0); const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const dur = s => { s = Number(s || 0); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const cut = (s, n = 800) => { s = String(s == null ? "-" : s); return s.length > n ? s.slice(0, n) + "..." : s; };

/* ---------- состояние ---------- */
let state = { offset: 0, bot: null, connections: {}, notifyChatId: null, ownerIds: [], excluded: [], chats: {} };
let saveTimer = null, listTimer = null;

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fsp.writeFile(P_STATE, JSON.stringify(state), "utf8").catch(() => {}), 800);
}
async function flushState() {
  clearTimeout(saveTimer); clearTimeout(listTimer);
  await fsp.writeFile(P_STATE, JSON.stringify(state), "utf8").catch(() => {});
  await writeList().catch(() => {});
}
function scheduleList() { clearTimeout(listTimer); listTimer = setTimeout(() => writeList().catch(() => {}), 5000); }
const addExclude = id => { state.excluded = uniq([...state.excluded, id]); saveState(); };
const isExcluded = id => {
  const s = String(id);
  return s === String(state.notifyChatId) || state.excluded.includes(s) || CFG.EXCLUDE_CHAT_IDS.map(String).includes(s);
};
const isOwnId = id => id != null && state.ownerIds.includes(String(id));
const isOwnAuthor = a => state.ownerIds.some(id => String(a || "").includes(`id:${id})`));

/* ---------- формат строки: [дата время] {#id} [метки]\tАвтор\tтекст ---------- */
function buildLine(e) {
  let h = `[${fmtTime(e.ts)}] {#${e.id}}`;
  for (const t of e.flags || []) h += ` [${oneLine(t)}]`;
  if (e.editTs) h += ` [ИЗМЕНЕНО ${fmtTime(e.editTs)}]`;
  if (e.delTs) h += ` [УДАЛЕНО ${fmtTime(e.delTs)}]`;
  return `${h}\t${oneLine(e.author)}\t${oneLine(e.text)}`;
}
function flagTs(head, name) {
  const m = new RegExp(`\\[${name} ([^\\]]+)\\]`).exec(head);
  return m ? parseTime(m[1]) : 0;
}
function setFlag(head, name, ts) {
  return head.replace(new RegExp(` \\[${name} [^\\]]+\\]`), "") + ` [${name} ${fmtTime(ts)}]`;
}
function parseLine(line) {
  const p = line.split("\t");
  if (p.length < 3) return null;
  const m = /^\[([^\]]+)\] \{#(\d+)\}/.exec(p[0]);
  if (!m) return null;
  return { head: p[0], author: p[1], text: p.slice(2).join(" "), ts: parseTime(m[1]),
           id: Number(m[2]), editTs: flagTs(p[0], "ИЗМЕНЕНО"), delTs: flagTs(p[0], "УДАЛЕНО") };
}
const lineOf = p => `${p.head}\t${p.author}\t${p.text}`;

/* ---------- файлы ---------- */
async function rename(from, to) {
  for (let i = 0; i < 6; i++) {
    try { return await fsp.rename(from, to); }
    catch (e) { if (i === 5) throw e; await sleep(300); }
  }
}
function rl(file) { return readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity }); }

const idCache = new Map();
async function loadIds(chatId) {
  const k = String(chatId);
  if (idCache.has(k)) return idCache.get(k);
  const set = new Set();
  const file = chatFile(k);
  if (fs.existsSync(file)) for await (const l of rl(file)) { const p = parseLine(l); if (p) set.add(p.id); }
  idCache.set(k, set);
  return set;
}
function ensureChat(chat) {
  const id = String(chat.id);
  const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || ("id" + id);
  let c = state.chats[id];
  if (!c) {
    c = state.chats[id] = { id, type: chat.type || "private", title: cleanName(title), username: chat.username || null,
      file: path.join("chats", `${id}_${fileSafe(title)}.txt`), count: 0, lastTs: 0 };
    saveState(); scheduleList();
  } else if (c.title !== cleanName(title) || (chat.username || null) !== c.username) {
    c.title = cleanName(title); c.username = chat.username || null; saveState(); scheduleList();
  }
  return c;
}
const chatFile = id => path.join(ROOT, state.chats[String(id)].file);

async function appendEntry(chatId, e) {
  const ids = await loadIds(chatId);
  if (ids.has(Number(e.id))) return false;
  await fsp.appendFile(chatFile(chatId), buildLine(e) + "\n", "utf8");
  ids.add(Number(e.id));
  const c = state.chats[String(chatId)];
  c.count++; if (e.ts > c.lastTs) c.lastTs = e.ts;
  saveState(); scheduleList();
  return true;
}
async function rewriteBatch(chatId, wanted, transform) {
  const file = chatFile(chatId);
  if (!fs.existsSync(file)) return [];
  const tmp = file + ".tmp";
  const out = fs.createWriteStream(tmp, "utf8");
  const w = async s => { if (!out.write(s + "\n")) await new Promise(r => out.once("drain", r)); };
  const done = new Set(), found = [];
  for await (const l of rl(file)) {
    const p = parseLine(l);
    if (p && wanted.has(p.id) && !done.has(p.id)) {
      done.add(p.id);
      const r = transform(p);
      found.push({ p, info: r.info });
      await w(r.line);
    } else await w(l);
  }
  await new Promise(r => out.end(r));
  await rename(tmp, file);
  return found;
}
const logChange = text => fsp.appendFile(P_CHANGES, text + "\n", "utf8");

async function writeList() {
  const arr = Object.values(state.chats).sort((a, b) => b.lastTs - a.lastTs);
  const L = [`СПИСОК ЧАТОВ — обновлено ${fmtTime(nowSec())}`,
    `Чатов: ${arr.length} | сообщений: ${arr.reduce((s, c) => s + c.count, 0)}`, ""];
  for (const c of arr) L.push(`${c.id} | ${c.type} | ${c.title} | сообщений: ${c.count} | последнее: ${fmtTime(c.lastTs)} | ${c.file}`);
  await fsp.writeFile(P_LIST, L.join("\n") + "\n", "utf8");
}

/* ---------- транспорт: https + SOCKS5(логин/пароль) + HTTP-прокси ---------- */
const https = require("https");
const http = require("http");
const tls = require("tls");
const net = require("net");
try { require("dns").setDefaultResultOrder("ipv4first"); } catch {}

const PROXY = CFG.PROXY || process.env.HTTPS_PROXY || process.env.https_proxy ||
              process.env.HTTP_PROXY || process.env.http_proxy || "";

function errInfo(e) {
  const out = []; let c = e, i = 0;
  while (c && i++ < 6) { out.push([c.name, c.code, c.syscall, c.address, c.message].filter(Boolean).join(" ")); c = c.cause; }
  return out.join(" <- ");
}
const HINTS = {
  ENOTFOUND: "DNS не резолвит — проверь адрес прокси",
  ETIMEDOUT: "таймаут — прокси тормозит или блокировка",
  ECONNRESET: "соединение сброшено — у этого прокси бывает, ретрай поможет",
  ECONNREFUSED: "отказ соединения — не тот порт прокси",
  EPROTO: "TLS-сбой — антивирус или провайдер вмешивается",
  CERT_HAS_EXPIRED: "проверь дату и время Windows",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "антивирус подменяет сертификат",
  DEPTH_ZERO_SELF_SIGNED_CERT: "антивирус подменяет сертификат"
};
function hint(e) { let c = e, i = 0; while (c && i++ < 6) { if (c.code && HINTS[c.code]) return HINTS[c.code]; c = c.cause; } return ""; }

function socksOnce(proxyHost, proxyPort, user, pass, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const family = net.isIP(proxyHost) || 4;
    const s = net.connect({ host: proxyHost, port: proxyPort, family });
    let stage = 0, buf = Buffer.alloc(0), settled = false;
    const fail = e => { if (settled) return; settled = true; s.destroy(); reject(e); };
    const ok = () => {
      if (settled) return; settled = true;
      s.removeAllListeners("data"); s.removeAllListeners("error"); s.removeAllListeners("timeout");
      s.setTimeout(0); resolve(s);
    };
    s.setTimeout(timeout);
    s.on("timeout", () => fail(new Error("SOCKS5: таймаут " + timeout + "мс")));
    s.on("error", fail);
    const sendConnect = () => {
      const h = Buffer.from(host, "utf8");
      s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
    };
    s.on("connect", () => {
      const methods = user ? [0x00, 0x02] : [0x00];
      s.write(Buffer.from([5, methods.length, ...methods]));
    });
    s.on("data", d => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail(new Error("SOCKS5: неверная версия ответа"));
        const m = buf[1]; buf = buf.subarray(2);
        if (m === 0x02) {
          const u = Buffer.from(user, "utf8"), p = Buffer.from(pass, "utf8");
          if (u.length > 255 || p.length > 255) return fail(new Error("SOCKS5: логин/пароль длиннее 255 байт"));
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1;
        } else if (m === 0x00) { stage = 2; sendConnect(); }
        else return fail(new Error("SOCKS5: прокси отверг авторизацию (0x" + m.toString(16) + ")"));
      }
      if (stage === 1) {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail(new Error("SOCKS5: неверный логин/пароль"));
        buf = buf.subarray(2); stage = 2; sendConnect();
      }
      if (stage === 2) {
        if (buf.length < 4) return;
        if (buf[1] !== 0) return fail(new Error("SOCKS5: CONNECT отклонён, rep=" + buf[1]));
        const atyp = buf[3];
        let need;
        if (atyp === 1) need = 6;
        else if (atyp === 4) need = 18;
        else if (atyp === 3) { if (buf.length < 5) return; need = 1 + buf[4] + 2; }
        else return fail(new Error("SOCKS5: неизвестный atyp " + atyp));
        if (buf.length < 4 + need) return;
        ok();
      }
    });
  });
}
async function socksConnect(proxyUrl, host, port, timeout) {
  const p = new URL(proxyUrl.includes("://") ? proxyUrl : "socks5://" + proxyUrl);
  const user = decodeURIComponent(p.username || "");
  const pass = decodeURIComponent(p.password || "");
  const pp = Number(p.port || 1080);
  const hosts = [p.hostname];
  if (CFG.PROXY_ALT_HOST && !hosts.includes(CFG.PROXY_ALT_HOST)) hosts.push(CFG.PROXY_ALT_HOST);
  let last;
  for (const h of hosts) {
    try { return await socksOnce(h, pp, user, pass, host, port, timeout); }
    catch (e) { last = e; log(`SOCKS5 ${h}:${pp} — ${e.message}`); }
  }
  throw last || new Error("SOCKS5: не удалось подключиться");
}

function httpRequest(urlStr, opts) {
  const { method = "GET", headers = {}, body = null, timeout = 60000 } = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const port = Number(u.port || 443);
    let settled = false;
    const fail = e => { if (settled) return; settled = true; reject(e); };
    const done = v => { if (settled) return; settled = true; resolve(v); };

    const start = tlsSocket => {
      const h = Object.assign({}, headers);
      if (body != null) h["Content-Length"] = Buffer.byteLength(body);
      const req = https.request({
        hostname: u.hostname, port, path: u.pathname + u.search, method, headers: h,
        agent: null,                          // null, НЕ false — иначе Node идёт мимо прокси
        createConnection: () => tlsSocket,
        timeout
      }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("error", fail);
        res.on("end", () => done({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout " + timeout + "ms")));
      req.on("error", fail);
      if (body != null) req.write(body);
      req.end();
    };

    const wrapTls = raw => {
      const t = tls.connect({ socket: raw, servername: u.hostname });
      t.setTimeout(timeout, () => t.destroy(new Error("TLS timeout " + timeout + "ms")));
      t.on("error", fail);
      t.once("secureConnect", () => start(t));
    };

    if (!PROXY) {
      const raw = net.connect({ host: u.hostname, port, family: 4 });
      raw.setTimeout(timeout, () => raw.destroy(new Error("connect timeout")));
      raw.on("error", fail);
      wrapTls(raw);
      return;
    }

    const pu = new URL(PROXY.includes("://") ? PROXY : "http://" + PROXY);
    if (/^socks/i.test(pu.protocol)) {
      socksConnect(PROXY, u.hostname, port, 20000).then(wrapTls).catch(fail);
      return;
    }

    const ph = {};
    if (pu.username) ph["Proxy-Authorization"] = "Basic " + Buffer.from(decodeURIComponent(pu.username) + ":" + decodeURIComponent(pu.password)).toString("base64");
    const preq = http.request({ hostname: pu.hostname, port: Number(pu.port || 8080), method: "CONNECT",
      path: `${u.hostname}:${port}`, timeout: 20000, headers: ph });
    preq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return fail(new Error("proxy CONNECT HTTP " + res.statusCode)); }
      wrapTls(socket);
    });
    preq.on("timeout", () => preq.destroy(new Error("proxy timeout")));
    preq.on("error", fail);
    preq.end();
  });
}

async function api(method, params = {}, attempt = 0) {
  let j;
  try {
    const r = await httpRequest(`https://api.telegram.org/bot${CFG.BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params), timeout: (CFG.POLL_TIMEOUT + 25) * 1000
    });
    j = JSON.parse(r.body.toString("utf8"));
  } catch (e) {
    console.log(`сеть (попытка ${attempt + 1}/6):`, errInfo(e));
    const h = hint(e); if (h) console.log("   подсказка:", h);
    if (attempt >= 5) throw new Error("нет связи с api.telegram.org: " + errInfo(e));
    await sleep(2000 * (attempt + 1));
    return api(method, params, attempt + 1);
  }
  if (!j.ok) {
    if (j.error_code === 429 && attempt < 5) {
      const w = (j.parameters && j.parameters.retry_after ? j.parameters.retry_after : 3) + 1;
      log(`429 — жду ${w}с`); await sleep(w * 1000);
      return api(method, params, attempt + 1);
    }
    const err = new Error(`${j.error_code} ${j.description}`);
    err.code = j.error_code;
    throw err;
  }
  return j.result;
}
async function downloadFile(fileId, dest) {
  const f = await api("getFile", { file_id: fileId });
  if (!f.file_path) throw new Error("файл недоступен боту");
  const r = await httpRequest(`https://api.telegram.org/file/bot${CFG.BOT_TOKEN}/${f.file_path}`, { timeout: 180000 });
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, r.body);
}

/* ---------- уведомления ---------- */
const nq = []; let nBusy = false, warned403 = false;
function notify(text) { if (!CFG.NOTIFY) return; nq.push(String(text)); pump(); }
async function pump() {
  if (nBusy) return; nBusy = true;
  while (nq.length) {
    const target = state.notifyChatId;
    if (!target) { if (nq.length > 200) nq.splice(0, nq.length - 200); break; }
    const text = nq.shift().slice(0, 3900);
    try {
      await api("sendMessage", { chat_id: target, text, disable_web_page_preview: true });
    } catch (e) {
      if (e.code === 403 && !warned403) {
        warned403 = true;
        console.log("\n! Не могу написать в личку. Открой бота и нажми /start (один раз).\n");
      } else log("notify:", e.message);
    }
    await sleep(CFG.NOTIFY_PAUSE_MS);
  }
  nBusy = false;
}
function changeText(ev, forFile) {
  const link = linkOf(ev.chat, ev.id);
  const L = [];
  L.push(forFile ? "=".repeat(72) : (ev.type === "edit" ? "ИЗМЕНЕНО" : "УДАЛЕНО"));
  L.push(`Зафиксировано: ${fmtTime(ev.changeTs)}`);
  L.push(`Чат: ${ev.chatTitle} (id ${ev.chat.id}, ${ev.chat.type || "private"})`);
  L.push(`Автор: ${ev.author || "-"}`);
  L.push(`Сообщение #${ev.id} от ${fmtTime(ev.ts)}`);
  if (link) L.push(`Ссылка: ${link}`);
  L.push(`БЫЛО: ${forFile ? (ev.before == null ? "-" : ev.before) : cut(ev.before)}`);
  if (ev.type === "edit") L.push(`СТАЛО: ${forFile ? (ev.after == null ? "-" : ev.after) : cut(ev.after)}`);
  if (forFile) L.push("");
  return L.join("\n");
}
async function report(ev) {
  try {
    await logChange(changeText(ev, true));
    const own = ev.own || isOwnAuthor(ev.author);
    if (own && !CFG.NOTIFY_OWN) return;
    notify(changeText(ev, false));
    console.log(`${ev.type === "edit" ? "[правка]" : "[удаление]"} ${ev.chatTitle} #${ev.id}`);
  } catch (e) { log("report:", e.message); }
}

/* ---------- разбор сообщения ---------- */
function linkOf(chat, msgId) {
  const id = String(chat.id);
  if (chat.username) return `https://t.me/${chat.username}/${msgId}`;
  if (id.startsWith("-100")) return `https://t.me/c/${id.slice(4)}/${msgId}`;
  if (!id.startsWith("-")) return `tg://openmessage?user_id=${id}&message_id=${msgId}`;
  return null;
}
function authorOf(msg) {
  if (msg.sender_chat) return `${cleanName(msg.sender_chat.title || "канал")} (chat:${msg.sender_chat.id})`;
  const f = msg.from;
  if (!f) return "неизвестно";
  const n = cleanName([f.first_name, f.last_name].filter(Boolean).join(" ") || f.username || ("id" + f.id));
  return `${n}${f.username ? ` (@${f.username})` : ""} (id:${f.id})`;
}
function fwdName(o) {
  if (!o) return "";
  if (o.type === "user" && o.sender_user) return " от " + cleanName([o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" "));
  if (o.type === "hidden_user") return " от " + cleanName(o.sender_user_name);
  if (o.type === "chat") return " из " + cleanName(o.sender_chat && o.sender_chat.title);
  if (o.type === "channel") return " из " + cleanName(o.chat && o.chat.title) + (o.author_signature ? ` (${o.author_signature})` : "");
  return "";
}
function mediaOf(msg) {
  if (msg.photo) { const p = msg.photo[msg.photo.length - 1]; return { kind: "photo", label: "Фото", size: p.file_size, fileId: p.file_id }; }
  if (msg.video) return { kind: "video", label: `Видео ${dur(msg.video.duration)}`, size: msg.video.file_size, fileId: msg.video.file_id, name: msg.video.file_name };
  if (msg.animation) return { kind: "animation", label: "GIF", size: msg.animation.file_size, fileId: msg.animation.file_id, name: msg.animation.file_name };
  if (msg.video_note) return { kind: "video_note", label: `Видеосообщение ${dur(msg.video_note.duration)}`, size: msg.video_note.file_size, fileId: msg.video_note.file_id };
  if (msg.voice) return { kind: "voice", label: `Голосовое ${dur(msg.voice.duration)}`, size: msg.voice.file_size, fileId: msg.voice.file_id, name: `voice_${msg.message_id}.ogg` };
  if (msg.audio) return { kind: "audio", label: `Аудио ${[msg.audio.performer, msg.audio.title].filter(Boolean).join(" - ")} ${dur(msg.audio.duration)}`.trim(), size: msg.audio.file_size, fileId: msg.audio.file_id, name: msg.audio.file_name };
  if (msg.sticker) return { kind: "sticker", label: `Стикер ${msg.sticker.emoji || ""}`.trim(), size: msg.sticker.file_size, fileId: msg.sticker.file_id, name: `sticker_${msg.message_id}` };
  if (msg.document) return { kind: "document", label: `Документ ${msg.document.file_name || ""}`.trim(), size: msg.document.file_size, fileId: msg.document.file_id, name: msg.document.file_name || `file_${msg.message_id}` };
  if (msg.location) return { kind: "location", label: `Геолокация ${msg.location.latitude},${msg.location.longitude}` };
  if (msg.venue) return { kind: "venue", label: `Место: ${msg.venue.title}` };
  if (msg.contact) return { kind: "contact", label: `Контакт ${msg.contact.first_name || ""} ${msg.contact.phone_number || ""}`.trim() };
  if (msg.poll) return { kind: "poll", label: `Опрос: ${msg.poll.question}` };
  if (msg.dice) return { kind: "dice", label: `Дайс ${msg.dice.emoji} = ${msg.dice.value}` };
  if (msg.game) return { kind: "game", label: `Игра ${msg.game.title}` };
  if (msg.invoice) return { kind: "invoice", label: `Счёт: ${msg.invoice.title}` };
  if (msg.story) return { kind: "story", label: "История" };
  if (msg.paid_media) return { kind: "paid_media", label: "Платное медиа" };
  return null;
}
function serviceText(m) {
  if (m.new_chat_members) return "[служебное] добавлены: " + m.new_chat_members.map(u => cleanName(u.first_name)).join(", ");
  if (m.left_chat_member) return "[служебное] вышел/удалён: " + cleanName(m.left_chat_member.first_name);
  if (m.new_chat_title) return `[служебное] новое название: ${m.new_chat_title}`;
  if (m.new_chat_photo) return "[служебное] сменено фото чата";
  if (m.delete_chat_photo) return "[служебное] удалено фото чата";
  if (m.pinned_message) return `[служебное] закреплено #${m.pinned_message.message_id}: ${cut(m.pinned_message.text || m.pinned_message.caption || "", 200)}`;
  if (m.group_chat_created) return "[служебное] создана группа";
  if (m.supergroup_chat_created) return "[служебное] создана супергруппа";
  if (m.channel_chat_created) return "[служебное] создан канал";
  if (m.migrate_to_chat_id) return `[служебное] чат переехал в ${m.migrate_to_chat_id}`;
  if (m.migrate_from_chat_id) return `[служебное] чат переехал из ${m.migrate_from_chat_id}`;
  if (m.message_auto_delete_timer_changed) return `[служебное] автоудаление: ${m.message_auto_delete_timer_changed.message_auto_delete_time}с`;
  if (m.video_chat_started) return "[служебное] начат видеочат";
  if (m.video_chat_ended) return "[служебное] видеочат завершён";
  if (m.video_chat_scheduled) return "[служебное] видеочат запланирован";
  if (m.forum_topic_created) return `[служебное] создана тема: ${m.forum_topic_created.name}`;
  if (m.forum_topic_edited) return `[служебное] изменена тема: ${m.forum_topic_edited.name || ""}`;
  if (m.write_access_allowed) return "[служебное] разрешено писать";
  if (m.refunded_payment) return "[служебное] возврат платежа";
  return "";
}
async function buildEntry(msg, chat, download) {
  const flags = [];
  if (msg.forward_origin) flags.push("переслано" + fwdName(msg.forward_origin));
  if (msg.reply_to_message) flags.push(`ответ #${msg.reply_to_message.message_id}`);
  if (msg.via_bot) flags.push(`через @${msg.via_bot.username}`);
  if (msg.sender_business_bot) flags.push("от бота-помощника");
  if (msg.is_from_offline) flags.push("офлайн-ответ");
  if (msg.media_group_id) flags.push("альбом");

  let text = msg.text || msg.caption || serviceText(msg);
  const mi = mediaOf(msg);
  if (mi) {
    let part = `[${mi.label}${mi.size ? ", " + humanSize(mi.size) : ""}]`;
    const skip = CFG.SKIP_MEDIA.includes(mi.kind);
    const big = Number(mi.size || 0) > CFG.MAX_DOWNLOAD_MB * 1024 * 1024;
    if (mi.fileId && CFG.DOWNLOAD_FILES && !skip && !big && download) {
      try {
        const fname = `${msg.message_id}_${fileSafe(mi.name || mi.kind)}`;
        await downloadFile(mi.fileId, path.join(D_FILES, String(chat.id), fname));
        part += ` -> files/${chat.id}/${fname}`;
      } catch (e) { part += ` (не скачано: ${e.message})`; }
    } else if (big) part += " (больше лимита, только ссылка)";
    else if (skip) part += " (не сохраняется)";
    const link = linkOf(chat, msg.message_id);
    if (link) part += ` ${link}`;
    text = text ? `${part} — ${text}` : part;
  }
  if (!text) text = "[пустое/неподдерживаемое сообщение]";
  return { id: msg.message_id, ts: msg.date || nowSec(), author: authorOf(msg), flags, text,
           editTs: msg.edit_date || 0, delTs: 0 };
}

/* ---------- обработчики ---------- */
async function onConnection(bc) {
  state.connections[bc.id] = { user: bc.user && bc.user.id, username: bc.user && bc.user.username,
    userChatId: bc.user_chat_id, isEnabled: bc.is_enabled, canReply: bc.can_reply, date: bc.date };
  if (bc.user && bc.user.id) state.ownerIds = uniq([...state.ownerIds, bc.user.id]);
  if (bc.user_chat_id) { state.notifyChatId = bc.user_chat_id; addExclude(bc.user_chat_id); }
  saveState();
  if (bc.is_enabled) {
    console.log(`\n[OK] Подключение (Автоматизация чатов): @${(bc.user && (bc.user.username || bc.user.id)) || "?"}`);
    console.log(`Уведомления -> личка (chat ${bc.user_chat_id}). Архив: ${ROOT}\n`);
    notify(`Слежение включено.\nАрхив: ${ROOT}\nСюда будут приходить правки и удаления (было/стало + время).`);
  } else {
    console.log("\n[!] Подключение отключено в Автоматизации чатов.\n");
    notify("Подключение отключено — слежение на паузе.");
  }
}
async function onMessage(msg, business) {
  if (!msg || !msg.chat) return;
  const chat = msg.chat;
  if (chat.type === "private" && /^\/start\b/.test(msg.text || "")) {
    state.notifyChatId = chat.id;
    if (msg.from && msg.from.id) state.ownerIds = uniq([...state.ownerIds, msg.from.id]);
    addExclude(chat.id);
    if (CFG.GREET_ON_START) {
      await api("sendMessage", { chat_id: chat.id,
        text: `Архиватор на связи.\nПапка: ${ROOT}\nПодключи меня: Настройки -> Информация -> Автоматизация чатов -> @${state.bot && state.bot.username}` }).catch(() => {});
    }
    return;
  }
  if (isExcluded(chat.id)) return;
  if (!business && !CFG.LOG_REGULAR_CHATS) return;
  ensureChat(chat);
  const e = await buildEntry(msg, chat, true);
  if (await appendEntry(chat.id, e)) log(`+ ${state.chats[String(chat.id)].title} #${e.id}`);
}
async function onEdit(msg, business) {
  if (!msg || !msg.chat) return;
  const chat = msg.chat;
  if (isExcluded(chat.id) || (!business && !CFG.LOG_REGULAR_CHATS)) return;
  ensureChat(chat);
  const e = await buildEntry(msg, chat, false);
  const editTs = msg.edit_date || nowSec();
  const found = await rewriteBatch(chat.id, new Set([Number(e.id)]), p => ({
    line: `${setFlag(p.head, "ИЗМЕНЕНО", editTs)}\t${p.author}\t${oneLine(e.text)}`,
    info: { before: p.text, ts: p.ts, author: p.author }
  }));
  if (!found.length) { await appendEntry(chat.id, e); return; }
  const i = found[0].info;
  if (oneLine(i.before) === oneLine(e.text)) return;
  await report({ type: "edit", chat, chatTitle: state.chats[String(chat.id)].title, id: e.id,
    ts: i.ts, author: i.author, before: i.before, after: e.text, changeTs: editTs,
    own: isOwnId(msg.from && msg.from.id) });
}
async function onDeleted(payload) {
  const chat = payload.chat;
  if (!chat || isExcluded(chat.id)) return;
  ensureChat(chat);
  const title = state.chats[String(chat.id)].title;
  const ids = (payload.message_ids || []).map(Number);
  if (!ids.length) return;
  const known = await loadIds(chat.id);
  const when = nowSec();
  const found = await rewriteBatch(chat.id, new Set(ids), p => {
    if (p.delTs) return { line: lineOf(p), info: null };
    return { line: `${setFlag(p.head, "УДАЛЕНО", when)}\t${p.author}\t${p.text}`,
             info: { id: p.id, ts: p.ts, author: p.author, before: p.text } };
  });
  const events = found.filter(f => f.info).map(f => ({ type: "delete", chat, chatTitle: title, changeTs: when,
    id: f.info.id, ts: f.info.ts, author: f.info.author, before: f.info.before }));
  for (const id of ids) {
    if (found.some(f => f.p.id === id)) continue;
    events.push({ type: "delete", chat, chatTitle: title, id, ts: 0, author: "-",
      before: known.has(id) ? "(текст не найден)" : "(сообщение не попало в архив — отправлено до подключения)", changeTs: when });
  }
  if (events.length > 8) {
    for (const ev of events) await logChange(changeText(ev, true));
    notify(`${title}: удалено ${events.length} сообщений. Подробности в changes.txt`);
    console.log(`[удаление] ${title}: пакет из ${events.length}`);
  } else for (const ev of events) await report(ev);
}
async function handleUpdate(u) {
  if (u.business_connection) return onConnection(u.business_connection);
  if (u.business_message) return onMessage(u.business_message, true);
  if (u.edited_business_message) return onEdit(u.edited_business_message, true);
  if (u.deleted_business_messages) return onDeleted(u.deleted_business_messages);
  if (u.message) return onMessage(u.message, false);
  if (u.edited_message) return onEdit(u.edited_message, false);
  if (u.channel_post) return onMessage(u.channel_post, false);
  if (u.edited_channel_post) return onEdit(u.edited_channel_post, false);
}

/* ---------- цикл ---------- */
let running = true;
async function poll() {
  const allowed = ["message", "edited_message", "channel_post", "edited_channel_post",
    "business_connection", "business_message", "edited_business_message", "deleted_business_messages"];
  while (running) {
    let updates;
    try {
      updates = await api("getUpdates", { offset: state.offset, timeout: CFG.POLL_TIMEOUT, allowed_updates: allowed });
    } catch (e) {
      if (e.code === 409) { console.log("! 409 Conflict: запущена другая копия бота или стоит webhook."); await sleep(15000); continue; }
      log("getUpdates:", e.message); await sleep(3000); continue;
    }
    for (const u of updates) {
      try { await handleUpdate(u); } catch (e) { console.log("update:", e.message); }
      state.offset = u.update_id + 1; saveState();
    }
  }
}

/* ---------- старт ---------- */
(async () => {
  for (const d of [ROOT, D_CHATS, D_FILES]) await fsp.mkdir(d, { recursive: true });
  if (fs.existsSync(P_STATE)) { try { Object.assign(state, JSON.parse(await fsp.readFile(P_STATE, "utf8"))); } catch {} }
  if (!fs.existsSync(P_CHANGES)) await fsp.writeFile(P_CHANGES, "ЖУРНАЛ ИЗМЕНЕНИЙ И УДАЛЕНИЙ\n\n", "utf8");
  const readme = path.join(ROOT, "README.txt");
  if (!fs.existsSync(readme)) await fsp.writeFile(readme,
`chats.txt   — список всех чатов
changes.txt — журнал правок и удалений (было/стало + время)
chats\\<id>_<имя>.txt — история чата: одна строка = одно сообщение
files\\<id>\\ — скачанные документы/голосовые/аудио/стикеры
state.json  — служебное, не удалять

Формат строки (разделитель — табуляция):
[дата время] {#id} [метки]  Автор  текст
Метки: ИЗМЕНЕНО / УДАЛЕНО / переслано / ответ #id
Удалённый текст сохраняется. Переносы строк заменены на " / ".
`, "utf8");

  console.log("Файл скрипта:", __filename);
  console.log("Токен:", CFG.BOT_TOKEN ? `${CFG.BOT_TOKEN.slice(0, 6)}...${CFG.BOT_TOKEN.slice(-4)} (длина ${CFG.BOT_TOKEN.length})` : "(пусто)");
  console.log("Прокси:", PROXY ? PROXY.replace(/\/\/[^@]*@/, "//***:***@") : "нет (напрямую)");

  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(CFG.BOT_TOKEN)) {
    console.log("\nТокен не распознан. Нужен вид: 123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    process.exit(1);
  }

  await api("deleteWebhook", { drop_pending_updates: false }).catch(e => console.log("deleteWebhook:", e.message));
  let me;
  try { me = await api("getMe"); }
  catch (e) {
    console.log("\nTelegram не принял токен:", e.message);
    console.log("Сверь токен в @BotFather -> /mybots -> API Token.");
    process.exit(1);
  }

  state.bot = { id: me.id, username: me.username };
  for (const c of Object.values(state.connections)) {
    if (c.userChatId) { addExclude(c.userChatId); if (!state.notifyChatId) state.notifyChatId = c.userChatId; }
    if (c.user) state.ownerIds = uniq([...state.ownerIds, c.user]);
  }
  if (!state.notifyChatId && state.ownerIds.length) state.notifyChatId = Number(state.ownerIds[0]);
  saveState();

  console.log(`\nБот @${me.username} запущен.`);
  console.log(`Архив: ${ROOT}`);
  console.log(`Подключение: Настройки -> Информация -> Автоматизация чатов -> @${me.username}`);
  console.log("Если уже подключён — отключи и подключи заново, чтобы пришло событие. Ctrl+C — выход.\n");
  await writeList();
  poll();
})().catch(e => { console.error("Фатально:", errInfo(e)); process.exit(1); });

process.on("SIGINT", async () => { running = false; console.log("\nСохраняю..."); await flushState(); process.exit(0); });
process.on("unhandledRejection", e => console.log("unhandled:", (e && e.message) || e));
