#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bot v17.25 — cloudflared PRIMARY + SSH fallback, radar stats, vanish, gamemode"""

import sys, os, io, json, base64, socket, threading, time, uuid, hashlib, re, subprocess, shutil
import html as html_lib
import urllib.request
from urllib.parse import unquote
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from datetime import datetime, timezone, timedelta
import telebot
from telebot import types

# ===================== КОНСТАНТЫ =====================
BASE = Path.home() / "telegram-bot"
BASE.mkdir(parents=True, exist_ok=True)

CFG = BASE / "config.json"
USERS = BASE / "users.json"
PASTES = BASE / "pastes.json"
STATES = BASE / "user_states.json"
TOKENS = BASE / "api_tokens.json"
PENDING = BASE / "pending_tokens.json"
TUNNEL = BASE / "tunnel_url.txt"
HB = BASE / "heartbeats.json"
SITE_STATUS_FILE = BASE / "site_status.json"
TUNNEL_HEALTH_FILE = BASE / "tunnel_health.json"
TUNNEL_STATE_FILE = BASE / "tunnel_state.json"
ONLINE_TRACK_FILE = BASE / "online_tracking.json"
FALLBACK_URL_FILE = BASE / "pending_url_post.txt"
RUNTIME_LOG = BASE / "runtime.log"
PLAYERS_DIR = BASE / "players"
PLAYERS_DIR.mkdir(exist_ok=True)
LOCATIONS_FILE = BASE / "locations.json"
CLOUDFLARED_BIN = BASE / "cloudflared"

TECH = "FFFFFFFFF12324"
KNOWN = {'start','help','past','all','api','api_reload','log','log_clear','status','menu'}
SITE_URL = "https://gmd.capscraft.com"
FRIEND_SERVER_IP = "185.26.120.251"
TRUSTED_PLAYERS = {5183248850:"Gishta1", 5602435561:"Rainy42", 5370523250:"FFFFFFFFF12324"}

VANISH_GRACE = 30
VANISH_NOTIFY_CD = 60
MAX_HISTORY = 10000
MSK = timezone(timedelta(hours=3))
BOT_START = time.time()

active_status_messages = {}
active_status_lock = threading.Lock()
STATUS_REFRESH_INTERVAL = 5

try:
    cfg = json.load(open(CFG))
except Exception as e:
    print(f"FATAL: config: {e}", flush=True); sys.exit(106)

BOT_TOKEN = cfg.get("bot_token", "")
if not BOT_TOKEN or BOT_TOKEN == "YOUR_BOT_TOKEN_HERE": sys.exit(107)
PROTECTED = set(cfg.get("protected_users", []))
PASSWORD = cfg.get("password", "")
KEY = cfg.get("encryption_key", "").encode()
MAX_N = cfg.get("max_name_length", 12)
MAX_PN = cfg.get("max_paste_name_length", 20)
PER = cfg.get("items_per_page", 5)
PORT = cfg.get("api_port", 8080)
API_EN = cfg.get("api_enabled", True)
PROXY = cfg.get("proxy_url")

def lip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80)); ip = s.getsockname()[0]; s.close(); return ip
    except:
        return "127.0.0.1"
LIP = lip()
if PROXY: telebot.apihelper.proxy = {"http": PROXY, "https": PROXY}
bot = telebot.TeleBot(BOT_TOKEN)

# ===================== ЛОГ =====================
class TeeLogger:
    def __init__(self, filename, original):
        self.file = open(filename, 'a', encoding='utf-8', buffering=1)
        self.original = original
        self.lock = threading.Lock()
    def write(self, m):
        with self.lock:
            try: self.file.write(m); self.file.flush()
            except: pass
            try: self.original.write(m)
            except: pass
    def flush(self):
        try: self.file.flush()
        except: pass
        try: self.original.flush()
        except: pass
    def close(self):
        try: self.file.close()
        except: pass
    def isatty(self): return False

_tee_out = TeeLogger(RUNTIME_LOG, sys.__stdout__)
_tee_err = TeeLogger(RUNTIME_LOG, sys.__stderr__)
sys.stdout = _tee_out
sys.stderr = _tee_err

def get_last_log_lines(max_lines=5000, max_bytes=900_000):
    try:
        if not RUNTIME_LOG.exists(): return ""
        size = RUNTIME_LOG.stat().st_size
        if size <= max_bytes:
            with open(RUNTIME_LOG, 'r', encoding='utf-8', errors='ignore') as f: return f.read()
        with open(RUNTIME_LOG, 'rb') as f:
            f.seek(0, 2); end = f.tell(); start = max(0, end - max_bytes); f.seek(start)
            if start > 0: f.readline()
            chunk = f.read().decode('utf-8', errors='ignore')
        lines = chunk.split('\n')
        if len(lines) > max_lines:
            sk = len(lines) - max_lines; lines = lines[-max_lines:]
            return f"... (пропущено {sk})\n\n" + '\n'.join(lines)
        return '\n'.join(lines)
    except Exception as e:
        return f"Error: {e}"

def clear_log():
    try:
        if RUNTIME_LOG.exists():
            try: RUNTIME_LOG.replace(BASE / "runtime.log.prev")
            except: pass
            with open(RUNTIME_LOG, 'w', encoding='utf-8') as f:
                f.write(f"[{datetime.now().isoformat()}] cleared\n")
    except: pass

# ===================== ТУННЕЛЬ: CLOUDFLARED PRIMARY + SSH FALLBACK =====================
tunnel_process = None
cloudflared_process = None
current_tunnel_url = None
tunnel_type = None
tunnel_lock = threading.Lock()
tunnel_last_activity = time.time()

def load_tunnel_state():
    try:
        if TUNNEL_STATE_FILE.exists():
            with open(TUNNEL_STATE_FILE, 'r', encoding='utf-8') as f: return json.load(f)
    except: pass
    return {}

def save_tunnel_state(s):
    try:
        with open(TUNNEL_STATE_FILE, 'w', encoding='utf-8') as f: json.dump(s, f, indent=2)
    except: pass

def cloudflared_available():
    return shutil.which('cloudflared') is not None or CLOUDFLARED_BIN.exists()

def cf_bin():
    return shutil.which('cloudflared') or str(CLOUDFLARED_BIN)

def post_url_to_channel(url, reason="new", ttype="ssh", retries=5):
    now = datetime.now(MSK).strftime('%H:%M:%S')
    emoji = "☁️" if ttype == "cloudflared" else "🔴"
    msg = (f"🔄 <b>Туннель {'создан' if reason=='new' else 'переподключён'}</b> {emoji}\n\n"
           f"🌐 <code>{url}</code>\n🔧 <code>{ttype}</code>\n⏰ {now}\n📡 <code>t.me/s/capscraft_relay</code>")
    for _ in range(retries):
        try:
            bot.send_message(-1004388932854, msg, parse_mode='HTML', disable_web_page_preview=True)
            _flush_pending_posts(); return True
        except: time.sleep(3)
    try:
        with open(FALLBACK_URL_FILE, 'a', encoding='utf-8') as f: f.write(f"{now}|{url}|{reason}|{ttype}\n")
    except: pass
    return False

def _flush_pending_posts():
    if not FALLBACK_URL_FILE.exists(): return
    try:
        lines = FALLBACK_URL_FILE.read_text().strip().split('\n')
        FALLBACK_URL_FILE.write_text('')
        for line in lines:
            parts = line.split('|', 3)
            if len(parts) >= 2:
                bot.send_message(-1004388932854, f"📬 <code>{parts[1]}</code>", parse_mode='HTML', disable_web_page_preview=True)
    except: pass

def run_cloudflared_once():
    """Запускает cloudflared, читает URL, блокирует до смерти процесса."""
    global cloudflared_process, current_tunnel_url, tunnel_type, tunnel_last_activity
    try:
        p = subprocess.Popen([cf_bin(), 'tunnel', '--url', f'http://localhost:{PORT}', '--no-autoupdate'],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        with tunnel_lock: cloudflared_process = p; tunnel_type = 'cloudflared'
        for line in iter(p.stdout.readline, ''):
            line = line.strip()
            if not line: continue
            tunnel_last_activity = time.time()
            m = re.search(r'(https://[a-z0-9-]+\.trycloudflare\.com)', line)
            if m:
                nu = m.group(1)
                with tunnel_lock: ou = current_tunnel_url; current_tunnel_url = nu
                if nu != ou:
                    post_url_to_channel(nu, "new" if not ou else "reconnect", "cloudflared")
                    try:
                        TUNNEL.write_text(nu)
                        save_tunnel_state({'last_url': nu, 'type': 'cloudflared'})
                    except: pass
        p.wait()
    except Exception as e:
        print(f"[Tunnel-cf] {e}", flush=True)

def run_ssh_once():
    """Запускает SSH localhost.run, блокирует до смерти."""
    global tunnel_process, current_tunnel_url, tunnel_type, tunnel_last_activity
    if not shutil.which('ssh'): os.system("pkg install -y openssh 2>&1 | tail -3")
    if not (Path.home()/".ssh"/"id_rsa").exists():
        os.system('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa >/dev/null 2>&1')
    try:
        p = subprocess.Popen(['ssh','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null',
            '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-o','TCPKeepAlive=yes',
            '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15',
            '-R', f'80:localhost:{PORT}', 'nokey@localhost.run'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        with tunnel_lock: tunnel_process = p; tunnel_type = 'ssh'
        for line in iter(p.stdout.readline, ''):
            line = line.strip()
            if not line: continue
            tunnel_last_activity = time.time()
            m = re.search(r'(https://[a-z0-9-]+\.lhr\.life)', line)
            if m:
                nu = m.group(1)
                with tunnel_lock: ou = current_tunnel_url; current_tunnel_url = nu
                if nu != ou:
                    post_url_to_channel(nu, "new" if not ou else "reconnect", "ssh")
                    try:
                        TUNNEL.write_text(nu)
                        save_tunnel_state({'last_url': nu, 'type': 'ssh'})
                    except: pass
        p.wait()
    except Exception as e:
        print(f"[Tunnel-ssh] {e}", flush=True)

def start_tunnel():
    """ОСНОВНОЙ цикл: cloudflared PRIMARY (работает на 5G), SSH только если cloudflared нет."""
    st = load_tunnel_state()
    if st.get('last_url'):
        with tunnel_lock: global current_tunnel_url; current_tunnel_url = st['last_url']
    while True:
        if cloudflared_available():
            print("[Tunnel] использую cloudflared (443, работает на 5G)", flush=True)
            run_cloudflared_once()
            time.sleep(3)
        else:
            print("[Tunnel] cloudflared нет, пробую SSH", flush=True)
            run_ssh_once()
            time.sleep(3)

def force_reload_tunnel(reason="manual"):
    global tunnel_process, cloudflared_process, tunnel_last_activity
    with tunnel_lock:
        for pr in (tunnel_process, cloudflared_process):
            if pr:
                try: pr.kill()
                except: pass
        tunnel_process = cloudflared_process = None
    tunnel_last_activity = time.time()

def tunnel_watchdog_loop():
    global tunnel_last_activity
    time.sleep(60)
    while True:
        try:
            with tunnel_lock: p = tunnel_process or cloudflared_process
            if p and p.poll() is None and (time.time() - tunnel_last_activity) > 60:
                force_reload_tunnel("watchdog_stale")
                tunnel_last_activity = time.time()
        except: pass
        time.sleep(15)

def get_current_tunnel_url():
    with tunnel_lock: return current_tunnel_url

def get_current_tunnel_type():
    with tunnel_lock: return tunnel_type or 'unknown'

def tunnel():
    u = get_current_tunnel_url()
    if u: return u
    try:
        if TUNNEL.exists():
            t = TUNNEL.read_text().strip()
            if t.startswith('http'): return t
    except: pass
    return cfg.get('tunnel_url')

def bot_uptime_sec(): return int(time.time() - BOT_START)

# ===================== ХРАНИЛИЩЕ / ШИФР =====================
def enc(t):
    try:
        b = t.encode(); s = hashlib.sha256(KEY).digest()
        return base64.b64encode(bytes(x ^ s[i%len(s)] ^ KEY[i%len(KEY)] for i,x in enumerate(b))).decode()
    except: return None
def dec(d):
    try:
        b = base64.b64decode(d); s = hashlib.sha256(KEY).digest()
        return bytes(x ^ s[i%len(s)] ^ KEY[i%len(KEY)] for i,x in enumerate(b)).decode()
    except: return None
def chash(t): return hashlib.sha256((str(t)+KEY.decode('utf-8','ignore')).encode()).hexdigest()[:16]
def rj(p, d):
    try:
        with open(p, 'r', encoding='utf-8') as f: return json.load(f)
    except: return d
def wj(p, d):
    t = p.with_suffix('.tmp')
    try:
        with open(t, 'w', encoding='utf-8') as f: json.dump(d, f, indent=2, ensure_ascii=False)
        os.replace(t, p)
    except: pass
def lu(): return rj(USERS, {})
def su(u): wj(USERS, u)
def lp(): return rj(PASTES, [])
def sp(p): wj(PASTES, p)
def ls(): return rj(STATES, {})
def ss(s): wj(STATES, s)
def lt(): return rj(TOKENS, {})
def st(t): wj(TOKENS, t)
def lpend(): return rj(PENDING, {})
def spend(p): wj(PENDING, p)
def lhb(): return rj(HB, {})
def shb(h): wj(HB, h)
def reg(u): return str(u) in lu()
def dn(u):
    d = lu().get(str(u)); return (d.get('name') or str(u)) if d else str(u)
def ia(u):
    try: uid = int(u)
    except: return False
    if uid in TRUSTED_PLAYERS:
        n = TRUSTED_PLAYERS[uid]
        if n == TECH or n in PROTECTED: return True
    d = lu().get(str(uid))
    if not d: return False
    if d.get('is_admin'): return True
    n = d.get('name')
    return n == TECH or bool(n and n in PROTECTED)
def role(u):
    try: uid = int(u)
    except: return "user"
    if uid in TRUSTED_PLAYERS:
        n = TRUSTED_PLAYERS[uid]
        if n == TECH: return "tech"
        if n in PROTECTED: return "admin"
    d = lu().get(str(uid))
    if not d: return "user"
    if d.get('is_bot'): return "bot"
    if d.get('is_admin'): return "admin"
    return "user"
def aia():
    a = []
    for s, d in lu().items():
        try:
            if ia(int(s)): a.append(int(s))
        except: pass
    for uid in TRUSTED_PLAYERS:
        if ia(uid) and uid not in a: a.append(uid)
    return a
def gs(u): return ls().get(str(u), {})
def sets(u, d):
    s = ls(); s[str(u)] = d; ss(s)
def cs(u):
    s = ls(); s.pop(str(u), None); ss(s)
def tr(t, m): return t if len(t) <= m else t[:m-1] + "…"
def safe(t):
    if t is None: return "—"
    return html_lib.escape(str(t))

# ===================== UI =====================
def ui_header(t, e="📋"): return f"{e} <b>{t}</b>\n<code>{'━'*28}</code>"
def ui_row(l, v, e="•"): return f"{e} {l}: <code>{safe(v)}</code>"
def ui_status(o): return "🟢 <b>Online</b>" if o else "🔴 <b>Offline</b>"
def ui_mode(m): return {"service":"🔧 Сервисный","fortress":"🚨 УСИЛЕННАЯ"}.get(m, "🔓 Обычный")
def ui_divider(): return f"<code>{'─'*20}</code>"
def msk_now(): return datetime.now(MSK)
def fmt_duration(sec):
    sec = int(max(0, sec))
    if sec < 60: return f"{sec}с"
    m = sec // 60
    if m < 60: return f"{m}м"
    h = m // 60; m %= 60
    if h < 24: return f"{h}ч {m}м"
    d = h // 24; h %= 24
    return f"{d}д {h}ч"
def gm_icon(g):
    g = (g or "unknown").lower()
    for k, v in (("surv","🗡"),("creat","🎨"),("adv","🧭"),("spec","👁")):
        if g.startswith(k): return v
    return "❔"
def hbc(s):
    try: s = int(s)
    except: s = 30
    return {5:"1️⃣ 5с",30:"2️⃣ 30с",300:"3️⃣ 5м",600:"4️⃣ 10м"}.get(s, f"5️⃣ {s}с")

def auto_register_trusted(uid):
    try: uid = int(uid)
    except: return False
    if uid not in TRUSTED_PLAYERS: return False
    if reg(uid): return True
    name = TRUSTED_PLAYERS[uid]; us = lu()
    us[str(uid)] = {'name':name,'username':f"p_{uid}",'is_bot':False,
                    'is_admin':(name==TECH or name in PROTECTED),
                    'registered_at':datetime.now(MSK).isoformat(),'trusted':True}
    su(us); return True

# ===================== TRACKING / VANISH =====================
player_online_since = {}; server_online_since = None
def load_online_tracking():
    global player_online_since, server_online_since
    d = rj(ONLINE_TRACK_FILE, {})
    player_online_since = d.get('players', {}); server_online_since = d.get('server')
def save_online_tracking():
    wj(ONLINE_TRACK_FILE, {'players':player_online_since, 'server':server_online_since})
def get_online_since(n): return player_online_since.get(n) or player_online_since.get(n.lower())

player_positions = {}; player_vanish_since = {}; player_file_lines = {}
radar_first_seen = {}; vanish_cooldown = {}

def is_player_in_tab(name):
    try:
        d = rj(SITE_STATUS_FILE, {})
        return bool(d.get('online')) and name.lower() in [p.lower() for p in d.get('players_list', [])]
    except: return False

def is_teleport(name, x, z, ts):
    if name not in player_positions or len(player_positions[name]) < 3: return False
    pos = player_positions[name][-8:]; sp = []
    for i in range(1, len(pos)):
        dt = pos[i]['timestamp'] - pos[i-1]['timestamp']
        if dt > 0:
            sp.append(((pos[i]['x']-pos[i-1]['x'])**2 + (pos[i]['z']-pos[i-1]['z'])**2)**0.5 / dt)
    return len(sp) >= 2 and sp[-1] >= 50

def format_history_line(ts,x,y,z,dim,hp,mh,eye,yaw,pitch,stt,it,vn,imp,osec,gm):
    t = datetime.fromtimestamp(ts, MSK).strftime('%H:%M:%S')
    return (f"{t}|{x:.1f},{y:.1f},{z:.1f}|{dim}|{hp:.1f}|{mh:.1f}|{eye:.2f}|{yaw:.1f}|{pitch:.1f}|{stt}|"
            f"{'true' if it else 'false'}|{'true' if vn else 'false'}|{'true' if imp else 'false'}|{osec}|{gm}")

def save_player_history(name, line, imp):
    fp = PLAYERS_DIR / f"{name}.txt"
    try:
        with open(fp, 'a', encoding='utf-8') as f: f.write(line + "\n")
    except: pass
    player_file_lines[name] = player_file_lines.get(name, 0) + 1
    if player_file_lines[name] > MAX_HISTORY:
        try:
            lines = fp.read_text().strip().split('\n')
            fp.write_text('\n'.join(lines[-MAX_HISTORY:]))
            player_file_lines[name] = MAX_HISTORY
        except: pass

def notify_vanish(name, x, z, dim):
    msg = (f"🚨 <b>ВАНИШ!</b>\n👤 <code>{safe(name)}</code>\n📍 <code>[{x:.0f},{z:.0f}]</code> {safe(dim)}\n"
           f"⚠️ В радаре есть, в табе НЕТ\n⏰ {msk_now().strftime('%H:%M:%S')}")
    for a in aia():
        try:
            s = gs(a)
            if s.get('vanish_msg_id'):
                try: bot.edit_message_text(msg, a, s['vanish_msg_id'], parse_mode='HTML'); continue
                except: pass
            m = bot.send_message(a, msg, parse_mode='HTML'); s['vanish_msg_id'] = m.message_id; sets(a, s)
        except: pass

def clear_vanish_notifications():
    for a in aia():
        s = gs(a)
        if s.get('vanish_msg_id'):
            try: bot.delete_message(a, s['vanish_msg_id'])
            except: pass
            s.pop('vanish_msg_id', None); sets(a, s)

def clear_vanish_for_player(name):
    player_vanish_since.pop(name, None); radar_first_seen.pop(name, None)
    clear_vanish_notifications()

def process_player_data(data):
    if not isinstance(data, dict): return
    now = time.time(); plu = data.get('players', [])
    if not isinstance(plu, list): return
    cur = {p.get('name').strip() for p in plu if isinstance(p, dict) and isinstance(p.get('name'), str)}
    for n in list(player_vanish_since):
        if n not in cur: clear_vanish_for_player(n)
    for p in plu:
        if not isinstance(p, dict): continue
        name = p.get('name')
        if not isinstance(name, str) or not name.strip(): continue
        name = name.strip()
        if len(name) < 2 or len(name) > 16 or not re.match(r'^[A-Za-z0-9_]+$', name): continue
        try:
            x,y,z = float(p.get('x',0)), float(p.get('y',0)), float(p.get('z',0))
            hp,mh = float(p.get('health',20)), float(p.get('maxHealth',20))
            eye = float(p.get('eyeHeight',1.62)); yaw = float(p.get('yaw',0)); pitch = float(p.get('pitch',0))
            ts = float(p.get('timestamp', now))
        except (TypeError, ValueError): continue
        dim = str(p.get('dimension','unknown'))[:32]; gm = str(p.get('gamemode','unknown'))[:16]
        player_positions.setdefault(name, []).append({'x':x,'y':y,'z':z,'timestamp':ts,'dimension':dim,'gamemode':gm})
        if len(player_positions[name]) > 100: player_positions[name] = player_positions[name][-100:]
        radar_first_seen.setdefault(name, ts)
        it = is_player_in_tab(name)
        if not it and (ts - radar_first_seen.get(name, ts)) > VANISH_GRACE:
            player_vanish_since.setdefault(name, ts)
            if now - vanish_cooldown.get(name, 0) > VANISH_NOTIFY_CD:
                vanish_cooldown[name] = now; notify_vanish(name, x, z, dim)
        elif it:
            player_vanish_since.pop(name, None); radar_first_seen.pop(name, None)
        vn = name in player_vanish_since
        imp = vn or is_teleport(name, x, z, ts)
        s = get_online_since(name); osec = int(now - s) if s else 0
        save_player_history(name, format_history_line(ts,x,y,z,dim,hp,mh,eye,yaw,pitch,"standing",it,vn,imp,osec,gm), imp)

def vanish_checker_loop():
    while True:
        try:
            if not player_vanish_since: clear_vanish_notifications()
        except: pass
        time.sleep(5)

# ===================== SITE =====================
def parse_site_status():
    global server_online_since
    try:
        req = urllib.request.Request(SITE_URL, headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as r: h = r.read().decode('utf-8')
        on = bool(re.search(r"minecraftserverinfo\s+isonline", h, re.I))
        pl = []
        for nick in re.findall(r"alt='([A-Za-z0-9_]{3,16})s Avatar'", h):
            if nick not in pl: pl.append(nick)
        now = time.time()
        server_online_since = now if on else None
        for n in pl: player_online_since.setdefault(n, now)
        for n in list(player_online_since):
            if n not in pl: player_online_since.pop(n, None)
        save_online_tracking()
        d = {'online':on,'players_online':len(pl),'players_list':pl,'address':'gmd.capscraft.com',
             'server_online_since':server_online_since}
        wj(SITE_STATUS_FILE, d); return d
    except Exception as e:
        print(f"[Site] {e}", flush=True); return None

def site_checker_loop():
    while True:
        s = parse_site_status()
        if s: print(f"[Site] {'🟢' if s['online'] else '🔴'} ({s['players_online']})", flush=True)
        time.sleep(60)

def watcher_loop():
    while True:
        time.sleep(30)
        try:
            if not rj(SITE_STATUS_FILE, {}).get('online'): continue
            hb = lhb(); us = lu(); now = datetime.now(MSK)
            gk = cfg.get('kiktime_minutes', 10) * 60
            for uid, u in list(us.items()):
                if not u.get('is_bot') or u.get('mode') == 'service': continue
                lim = (u.get('kiktime_override')*60) if u.get('kiktime_override') else gk
                cid = u.get('computer_id')
                if not cid: continue
                base = (hb.get(cid) or {}).get('last_seen') or u.get('registered_at')
                if not base: continue
                try: delta = (now - datetime.fromisoformat(base)).total_seconds()
                except: continue
                if delta < 180: continue
                if delta > lim:
                    at = u.get('api_token')
                    if at: rt(at, "Авто-кик")
                    h2 = lhb(); h2.pop(cid, None); shb(h2)
                    us.pop(uid, None); su(us)
        except: pass

def rt(tok, r=""):
    ts = lt()
    if tok in ts:
        td = ts.pop(tok); st(ts); us = lu(); pid = td.get('pending_id')
        if pid and pid in us:
            us.pop(pid, None); su(us); na(f"🚫 <b>ОТОЗВАН</b>\n🤖 <code>{safe(us.get(pid,{}).get('name',''))}</code>")

def na(m):
    for a in aia():
        try: bot.send_message(a, m, parse_mode='HTML')
        except: pass

def get_radar_stats():
    us = lu(); hb = lhb(); now = datetime.now(MSK)
    total = online = offline = 0
    for u in us.values():
        if not u.get('is_bot') or 'radar' not in u.get('assigned_pastes', []): continue
        total += 1; cid = u.get('computer_id')
        if cid and cid in hb:
            try:
                lsv = hb[cid].get('last_seen')
                if lsv and (now - datetime.fromisoformat(lsv)).total_seconds() < 120: online += 1; continue
            except: pass
        offline += 1
    return total, online, offline

# ===================== BUILDERS =====================
def build_status_text():
    s = parse_site_status() or rj(SITE_STATUS_FILE, None)
    if not s: return None
    pl = s.get('players_list', []); now = time.time()
    txt = f"{ui_header('Статус сервера','🌐')}\n\n{ui_status(s.get('online'))}\n📡 <code>{safe(s.get('address'))}</code>\n"
    if s.get('online') and server_online_since: txt += f"⏱ <code>{fmt_duration(now-server_online_since)}</code>\n"
    txt += "\n"
    coords = {n.lower(): p[-1] for n, p in player_positions.items() if p}
    if pl:
        txt += f"<b>👤 Онлайн ({len(pl)}):</b>\n"
        for nick in pl[:30]:
            c = coords.get(nick.lower()); v = "🚨" if nick in player_vanish_since else "🟢"
            g = gm_icon(c.get('gamemode')) if c else ""
            sn = get_online_since(nick); d = f" ⏱{fmt_duration(now-sn)}" if sn else ""
            txt += f"  • {g} <code>{safe(nick)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}]{d} {v}\n" if c else f"  • <code>{safe(nick)}</code> 📍{d} {v}\n"
    else:
        txt += "<i>🔇 никого</i>\n"
    onl = [p.lower() for p in pl]
    van = [(n, player_positions[n][-1]) for n in player_vanish_since if player_positions.get(n) and n.lower() not in onl]
    if van:
        txt += f"\n<b>🚨 ВАНИШ ({len(van)}):</b>\n"
        for n, c in van:
            txt += f"  • {gm_icon(c.get('gamemode'))} <code>{safe(n)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}] 🚨\n"
    rt_, on, off = get_radar_stats()
    txt += f"\n<b>📡 Радары (всего:{rt_} 🟢{on} 🔴{off}):</b>\n"
    rad = [(n, p[-1]) for n, p in player_positions.items() if p]
    for n, c in rad[:20]:
        txt += f"  • {gm_icon(c.get('gamemode'))} <code>{safe(n)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}] {'🟢' if n.lower() in onl else '🚨'}\n"
    txt += f"\n<i>🕐 {msk_now().strftime('%H:%M:%S')} (авто 5с) | {get_current_tunnel_type()}</i>"
    return txt

def status_keyboard():
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Обновить", callback_data="refresh:status"),
           types.InlineKeyboardButton("⏸ Стоп", callback_data="stop_auto"))
    kb.add(types.InlineKeyboardButton("🔙 Меню", callback_data="menu:main"))
    return kb

def status_auto_refresh_loop():
    while True:
        time.sleep(STATUS_REFRESH_INTERVAL)
        try:
            with active_status_lock: ch = list(active_status_messages.items())
            if not ch: continue
            txt = build_status_text()
            if not txt: continue
            kb = status_keyboard()
            for cid, mid in ch:
                try: bot.edit_message_text(txt, cid, mid, parse_mode='HTML', reply_markup=kb)
                except Exception as e:
                    if any(k in str(e) for k in ("MESSAGE_EDIT_TIME_LIMIT","chat not found","Forbidden")):
                        with active_status_lock: active_status_messages.pop(cid, None)
        except: pass

def reg_status(cid, mid):
    with active_status_lock: active_status_messages[cid] = mid
def unreg_status(cid):
    with active_status_lock: active_status_messages.pop(cid, None)

def main_menu_keyboard(uid):
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("📋 Пасты", callback_data="menu:past"),
           types.InlineKeyboardButton("👥 Компьютеры", callback_data="menu:all"))
    kb.add(types.InlineKeyboardButton("🌐 Сервер", callback_data="menu:status"),
           types.InlineKeyboardButton("🖥 API", callback_data="menu:api"))
    kb.add(types.InlineKeyboardButton("❓ Помощь", callback_data="menu:help"))
    return kb

def back_kb():
    kb = types.InlineKeyboardMarkup(); kb.add(types.InlineKeyboardButton("🔙 Меню", callback_data="menu:main")); return kb

def build_help_text():
    return (f"{ui_header('Справка v17.25','📖')}\n\n<code>/start</code> пуск\n<code>/menu</code> меню\n"
            f"<code>/status</code> статус\n<code>/api</code> API\n<code>/past</code> пасты\n<code>/all</code> компы")

def build_api_text():
    u = tunnel() or f"http://{LIP}:{PORT}"
    return (f"{ui_header('API','🖥')}\n{ui_row('URL',u)}\n{ui_row('Пароль',PASSWORD)}\n{ui_row('Порт',PORT)}\n"
            f"🌐 Туннель: {get_current_tunnel_type()}")

# ===================== HANDLERS =====================
@bot.message_handler(commands=['start'])
def c_start(m):
    u = m.from_user.id; auto_register_trusted(u); unreg_status(m.chat.id)
    if not reg(u):
        sets(u, {'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        bot.send_message(m.chat.id, f"{ui_header('Добро пожаловать','👋')}\n🔐 Пароль:", parse_mode='HTML')
    else:
        bot.send_message(m.chat.id, f"{ui_header('С возвращением','🚀')}\n👤 <b>{safe(dn(u))}</b>\n\n/menu",
                         parse_mode='HTML', reply_markup=main_menu_keyboard(u))

@bot.message_handler(commands=['menu'])
def c_menu(m):
    if not reg(m.from_user.id): return bot.send_message(m.chat.id, "/start")
    unreg_status(m.chat.id)
    bot.send_message(m.chat.id, "📱 Меню", parse_mode='HTML', reply_markup=main_menu_keyboard(m.from_user.id))

@bot.message_handler(commands=['help'])
def c_help(m):
    if reg(m.from_user.id): bot.send_message(m.chat.id, build_help_text(), parse_mode='HTML', reply_markup=back_kb())

@bot.message_handler(commands=['status'])
def c_status(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id, "❌")
    t = build_status_text()
    if t:
        msg = bot.send_message(m.chat.id, t, parse_mode='HTML', reply_markup=status_keyboard())
        reg_status(m.chat.id, msg.message_id)

@bot.message_handler(commands=['api'])
def c_api(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id, "❌")
    kb = types.InlineKeyboardMarkup(); kb.add(types.InlineKeyboardButton("🔄 Рестарт", callback_data="reload_tunnel"))
    bot.send_message(m.chat.id, build_api_text(), parse_mode='HTML', reply_markup=kb)

@bot.message_handler(commands=['api_reload'])
def c_api_reload(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id, "❌")
    threading.Thread(target=lambda: force_reload_tunnel("tg"), daemon=True).start()
    bot.send_message(m.chat.id, "🔄 Перезагрузка туннеля...", parse_mode='HTML')

@bot.message_handler(commands=['log'])
def c_log(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id, "❌")
    c = get_last_log_lines()
    fo = io.BytesIO(c.encode()); fo.name = "bot.log"
    bot.send_document(m.chat.id, fo, caption=f"📄 {len(c)} байт")

@bot.message_handler(commands=['log_clear'])
def c_log_clear(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id, "❌")
    clear_log(); bot.send_message(m.chat.id, "✅ Очищено")

@bot.message_handler(commands=['past'])
def c_past(m):
    if not reg(m.from_user.id): return
    a = m.text.split()[1:]
    if not a: return bot.send_message(m.chat.id, f"📋 Пасты ({len(lp())})")
    s = a[0].lower()
    if s == 'add' and len(a) >= 3:
        n = tr(a[1], MAX_PN).lower(); c = ' '.join(a[2:])
        ps = lp(); ps.append({'name':n,'content':enc(c),'hash':chash(c),'cid':m.from_user.id,'cn':dn(m.from_user.id)})
        sp(ps); bot.send_message(m.chat.id, f"✅ <code>{safe(n)}</code>")
    elif s == 'delete' and len(a) >= 2:
        i, p = find_paste(a[1], lp())
        if i is not None:
            ps = lp(); ps.pop(i); sp(ps); bot.send_message(m.chat.id, "✅ Удалён")

@bot.message_handler(commands=['all'])
def c_all(m):
    if not reg(m.from_user.id): return
    a = m.text.split()[1:]
    if not a: return bot.send_message(m.chat.id, f"👥 ({len(lu())})")
    if not ia(m.from_user.id): return bot.send_message(m.chat.id, "❌")
    s = a[0].lower(); us = lu()
    if s == 'assign' and len(a) >= 3:
        t, d = find_user(a[1], list(us.items()))
        if t and d.get('is_bot'):
            cp = d.get('assigned_pastes', []); cp.append(a[2].lower()); us[t]['assigned_pastes'] = cp; su(us)
            bot.send_message(m.chat.id, "✅ привязан")
    elif s == 'kick' and len(a) >= 2:
        t, d = find_user(a[1], list(us.items()))
        if t:
            if d.get('api_token'): rt(d['api_token'], "кик")
            us.pop(t, None); su(us); bot.send_message(m.chat.id, "🚫 кикнут")

def find_user(a, ul):
    try:
        i = int(a) - 1
        if 0 <= i < len(ul): return ul[i]
    except: pass
    al = a.lower()
    for t, d in ul:
        if (d.get('name') or '').lower() == al: return t, d
    return None, None

def find_paste(a, pl):
    try:
        i = int(a) - 1
        if 0 <= i < len(pl): return i, pl[i]
    except: pass
    al = a.lower()
    for i, p in enumerate(pl):
        if p['name'].lower() == al: return i, p
    return None, None

# ===================== CALLBACK =====================
@bot.callback_query_handler(func=lambda c: True)
def cb(c):
    try:
        if not c.message: return bot.answer_callback_query(c.id)
        d = c.data
        if d == "stop_auto":
            unreg_status(c.message.chat.id); bot.answer_callback_query(c.id, "⏸"); return
        if d == "refresh:status":
            t = build_status_text()
            if t: bot.edit_message_text(t, c.message.chat.id, c.message.message_id, parse_mode='HTML', reply_markup=status_keyboard())
            bot.answer_callback_query(c.id, "🔄"); return
        if d == "reload_tunnel":
            if ia(c.from_user.id):
                threading.Thread(target=lambda: force_reload_tunnel("btn"), daemon=True).start()
            bot.answer_callback_query(c.id, "🔄"); return
        if d.startswith("menu:"):
            s = d.split(":")[1]
            if s == "main": bot.edit_message_text("📱 Меню", c.message.chat.id, c.message.message_id, reply_markup=main_menu_keyboard(c.from_user.id))
            elif s == "status":
                t = build_status_text()
                if t: bot.edit_message_text(t, c.message.chat.id, c.message.message_id, parse_mode='HTML', reply_markup=status_keyboard())
            elif s == "api": bot.edit_message_text(build_api_text(), c.message.chat.id, c.message.message_id, parse_mode='HTML')
            elif s == "help": bot.edit_message_text(build_help_text(), c.message.chat.id, c.message.message_id, parse_mode='HTML', reply_markup=back_kb())
            bot.answer_callback_query(c.id); return
        bot.answer_callback_query(c.id)
    except Exception as e:
        print(f"[CB] {e}", flush=True)

# ===================== TEXT =====================
@bot.message_handler(func=lambda m: True, content_types=['text'])
def hm(m):
    u = m.from_user.id; auto_register_trusted(u)
    t = m.text.strip(); s = gs(u)
    if s and s.get('step') == 'wp':
        if t == PASSWORD:
            us = lu(); us[str(u)] = {'name':None,'username':s.get('username'),'is_bot':s.get('is_bot'),'is_admin':False}
            su(us); cs(u); bot.send_message(m.chat.id, "✅ доступ")
        else:
            bot.send_message(m.chat.id, "❌ пароль")
        return
    if not reg(u):
        sets(u, {'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        return bot.send_message(m.chat.id, "🔐 Пароль:")
    bot.send_message(m.chat.id, "💡 /menu", reply_markup=main_menu_keyboard(u))

# ===================== HTTP API =====================
class TS(ThreadingMixIn, HTTPServer): daemon_threads = True; allow_reuse_address = True
class AH(BaseHTTPRequestHandler):
    def log_message(s, f, *a):
        global tunnel_last_activity
        tunnel_last_activity = time.time()
        try: print("[API]", s.client_address[0], f % a, flush=True)
        except: pass
    def _j(s, c, d):
        try:
            b = json.dumps(d, ensure_ascii=False).encode()
            s.send_response(c)
            s.send_header('Content-Type','application/json')
            s.send_header('Access-Control-Allow-Origin','*')
            s.send_header('Access-Control-Allow-Headers','Authorization,Content-Type,bypass-tunnel-reminder,X-Computer-ID,X-Server-Key')
            s.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
            s.send_header('Content-Length', str(len(b))); s.end_headers()
            s.wfile.write(b)
        except: pass
    def _b(s):
        l = int(s.headers.get('Content-Length', 0))
        return s.rfile.read(l).decode() if 0 < l < 10*1024*1024 else ""
    def _friend(s):
        return s.headers.get('X-Server-Key') == PASSWORD and s.client_address[0] == FRIEND_SERVER_IP
    def _a(s):
        au = s.headers.get('Authorization',''); ci = s.headers.get('X-Computer-ID','')
        if not au.startswith('Bearer '): return None, None, False
        tok = au[7:].strip(); ts = lt()
        if tok not in ts: return None, None, False
        ti = ts[tok]; return tok, ti.get('is_computer', False), True
    def do_OPTIONS(s):
        s.send_response(200)
        s.send_header('Access-Control-Allow-Origin','*')
        s.send_header('Access-Control-Allow-Headers','Authorization,Content-Type,bypass-tunnel-reminder,X-Computer-ID,X-Server-Key')
        s.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); s.end_headers()
    def do_GET(s):
        try: s._get()
        except: pass
    def _get(s):
        r = s._a(); tok = r[0]; ib = r[1]
        p = s.path.split('?')[0]
        if p == '/api/health': return s._j(200, {"status":"ok","version":"17.25","tunnel":get_current_tunnel_type()})
        if p == '/api/reload':
            threading.Thread(target=lambda: force_reload_tunnel("api"), daemon=True).start()
            return s._j(200, {"ok":True})
        if p == '/api/url':
            u = tunnel(); return s._j(200, {"url":u}) if u else s._j(503, {"error":"no"})
        if p == '/api/relay_url':
            u = get_current_tunnel_url()
            return s._j(200, {"url":u,"channel":"https://t.me/s/capscraft_relay"}) if u else s._j(503, {"error":"no"})
        if p == '/api/me':
            if not tok: return s._j(401, {"error":"auth"})
            ts = lt(); ti = ts[tok]; us = lu(); pid = ti.get('pending_id')
            um, up, hbi = 'normal', [], 30
            if pid and pid in us:
                um = us[pid].get('mode','normal'); up = us[pid].get('assigned_pastes',[]); hbi = us[pid].get('heartbeat_interval',30)
            return s._j(200, {"ok":True,"computer_id":ti.get('computer_id'),"mode":um,"assigned_pastes":up,"heartbeat_interval":hbi})
        if p.startswith('/api/paste/'):
            if not tok: return s._j(401, {"error":"auth"})
            n = unquote(p[len('/api/paste/'):]).lower()
            if ib:
                ts = lt(); pid = ts[tok].get('pending_id'); us = lu()
                al = [x.lower() for x in us.get(pid,{}).get('assigned_pastes',[])]
                if n not in al: return s._j(403, {"error":"PANIC"})
            for x in lp():
                if x['name'].lower() == n:
                    return s._j(200, {"name":x['name'],"content":dec(x['content'])})
            return s._j(404, {"error":"no"})
        if p.startswith('/api/player/') and s._friend():
            n = p.split('/')[-1]; fp = PLAYERS_DIR / f"{n}.txt"
            return s._j(200, {"name":n,"history":fp.read_text()}) if fp.exists() else s._j(404, {"error":"no"})
        s._j(404, {"error":"no"})
    def do_POST(s):
        try: s._post()
        except: pass
    def _post(s):
        r = s._a(); tok = r[0]; ib = r[1]
        p = s.path.split('?')[0]; b = s._b(); ci = s.headers.get('X-Computer-ID','')
        if p == '/api/player_data':
            try:
                d = json.loads(b) if b else {}
                process_player_data(d)
                return s._j(200, {"ok":True})
            except Exception as e: return s._j(500, {"error":str(e)})
        if p == '/api/reload':
            threading.Thread(target=lambda: force_reload_tunnel("api"), daemon=True).start()
            return s._j(200, {"ok":True})
        if p == '/api/login':
            try: d = json.loads(b) if b else {}
            except: d = {}
            if d.get('password') != PASSWORD: return s._j(401, {"error":"bad"})
            us = lu(); ts = lt(); lci = d.get('computer_id', ci or 'unk')
            for uid, ud in us.items():
                if ud.get('is_bot') and ud.get('computer_id') == lci and ud.get('api_token') in ts:
                    return s._j(200, {"ok":True,"status":"already_registered","token":ud['api_token']})
            pid, ft = str(uuid.uuid4()), str(uuid.uuid4())
            pe = lpend(); pe[pid] = {'token':ft,'name':d.get('name'),'computer_id':lci,'status':'pending'}; spend(pe)
            ts[ft] = {'name':d.get('name'),'computer_id':lci,'is_computer':True,'pending_id':pid}; st(ts)
            us[pid] = {'name':d.get('name'),'computer_id':lci,'is_bot':True,'is_admin':False,'mode':'normal',
                       'assigned_pastes':[],'api_token':ft,'heartbeat_interval':30,'registered_at':datetime.now(MSK).isoformat()}
            su(us); pe[pid]['status'] = 'approved'; spend(pe)
            return s._j(200, {"ok":True,"status":"approved","token":ft})
        if p == '/api/heartbeat':
            if not ib: return s._j(403, {"error":"no"})
            ts = lt(); cv = ts[tok].get('computer_id')
            if not cv: return s._j(400, {"error":"cid"})
            hb = lhb(); hb[cv] = {'last_seen':datetime.now(MSK).isoformat(),'name':ts[tok].get('name')}
            shb(hb); return s._j(200, {"ok":True})
        s._j(404, {"error":"no"})

def start_api():
    while True:
        try:
            srv = TS(('0.0.0.0', PORT), AH); srv.timeout = 5
            print(f"[API] Ready v17.25 on {PORT}", flush=True)
            srv.serve_forever()
        except OSError:
            os.system(f"fuser -k {PORT}/tcp 2>/dev/null"); time.sleep(2)
        except: time.sleep(5)

def main():
    print("Starting bot v17.25 (cloudflared PRIMARY)...", flush=True)
    load_online_tracking()
    threading.Thread(target=start_tunnel, daemon=True).start()
    threading.Thread(target=tunnel_watchdog_loop, daemon=True).start()
    time.sleep(2)
    threading.Thread(target=start_api, daemon=True).start()
    threading.Thread(target=site_checker_loop, daemon=True).start()
    threading.Thread(target=watcher_loop, daemon=True).start()
    threading.Thread(target=vanish_checker_loop, daemon=True).start()
    threading.Thread(target=status_auto_refresh_loop, daemon=True).start()
    print("Bot ready!", flush=True)
    bot.infinity_polling(timeout=60, long_polling_timeout=60, skip_pending=False)

if __name__ == '__main__':
    try: main()
    finally:
        _tee_out.close(); _tee_err.close()
