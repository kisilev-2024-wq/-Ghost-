#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bot v17.23 — SSH + cloudflared failover + all fixes"""
import sys
import os
import io
import json
import base64
import socket
import threading
import time
import uuid
import hashlib
import re
import subprocess
import signal
import tempfile
import html as html_lib
import urllib.request
from urllib.parse import unquote
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from datetime import datetime, timezone, timedelta
import telebot
from telebot import types

# ============================================
# КОНСТАНТЫ
# ============================================
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
LOGIN_ATTEMPTS_FILE = BASE / "login_attempts.json"
PLAYERS_DIR = BASE / "players"
PLAYERS_DIR.mkdir(exist_ok=True)
LOCATIONS_FILE = BASE / "locations.json"
CLOUDFLARED_BIN = BASE / "cloudflared"

KNOWN = {'start', 'help', 'past', 'all', 'api', 'api_reload', 'log', 'log_clear', 'status', 'menu'}
SITE_URL = "https://gmd.capscraft.com"
MAX_CONTENT_LENGTH = 10 * 1024 * 1024
MAX_HISTORY = 10000
VANISH_GRACE = 30
VANISH_NOTIFY_CD = 60
MSK = timezone(timedelta(hours=3))
BOT_START = time.time()
TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
RATE_LIMIT_WINDOW = 60
MAX_LOGIN_ATTEMPTS = 5

active_status_messages = {}
active_status_lock = threading.Lock()
STATUS_REFRESH_INTERVAL = 5
tunnel_lock = threading.Lock()
players_lock = threading.Lock()
tunnel_health_lock = threading.Lock()
site_cache_lock = threading.Lock()

try:
    with open(CFG, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
except Exception as e:
    print(f"FATAL: config: {e}", flush=True)
    sys.exit(106)

BOT_TOKEN = cfg.get("bot_token", "")
if not BOT_TOKEN or BOT_TOKEN == "YOUR_BOT_TOKEN_HERE":
    sys.exit(107)

PASSWORD = cfg.get("password", "")
if not PASSWORD or PASSWORD == "admin123":
    print("FATAL: weak or default password", flush=True)
    sys.exit(108)

KEY = cfg.get("encryption_key", "").encode()
if not KEY or KEY == b"default":
    print("FATAL: default encryption key", flush=True)
    sys.exit(109)

PROTECTED = set(cfg.get("protected_users", []))
TECH = cfg.get("tech_name", "FFFFFFFFF12324")
CHANNEL_ID = cfg.get("channel_id", -1004388932854)
CHANNEL_USERNAME = cfg.get("channel_username", "capscraft_relay")
FRIEND_SERVER_IP = cfg.get("friend_server_ip", "185.26.120.251")
TRUSTED_PLAYERS = cfg.get("trusted_players", {
    "5183248850": "Gishta1",
    "5602435561": "Rainy42",
    "5370523250": "FFFFFFFFF12324",
})
TRUSTED_PLAYERS_INT = {int(k): v for k, v in TRUSTED_PLAYERS.items()}

MAX_N = cfg.get("max_name_length", 12)
MAX_PN = cfg.get("max_paste_name_length", 20)
PER = cfg.get("items_per_page", 5)
PORT = cfg.get("api_port", 8080)
API_EN = cfg.get("api_enabled", True)
PROXY = cfg.get("proxy_url")
ALLOWED_ORIGINS = cfg.get("allowed_origins", [])
FORCE_CLOUDFLARED = cfg.get("force_cloudflared", False)

def lip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

LIP = lip()
if PROXY:
    telebot.apihelper.proxy = {"http": PROXY, "https": PROXY}
bot = telebot.TeleBot(BOT_TOKEN)

def signal_handler(sig, frame):
    print("[Shutdown] stopping...", flush=True)
    try:
        bot.stop_polling()
    except:
        pass
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# ============================================
# LOGGING
# ============================================
class TeeLogger:
    def __init__(self, filename, original_stream):
        self.file = open(filename, 'a', encoding='utf-8', buffering=1)
        self.original = original_stream
        self.lock = threading.Lock()
    def write(self, msg):
        with self.lock:
            try: self.file.write(msg); self.file.flush()
            except: pass
            try: self.original.write(msg)
            except: pass
    def flush(self):
        try: self.file.flush()
        except: pass
        try: self.original.flush()
        except: pass
    def close(self):
        try: self.file.close()
        except: pass
    def isatty(self):
        return False

_tee_out = TeeLogger(RUNTIME_LOG, sys.__stdout__)
_tee_err = TeeLogger(RUNTIME_LOG, sys.__stderr__)
sys.stdout = _tee_out
sys.stderr = _tee_err

def get_last_log_lines(max_lines=5000, max_bytes=900_000):
    try:
        if not RUNTIME_LOG.exists():
            return ""
        size = RUNTIME_LOG.stat().st_size
        if size <= max_bytes:
            with open(RUNTIME_LOG, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read()
        with open(RUNNEL_LOG, 'rb') if False else open(RUNTIME_LOG, 'rb') as f:
            f.seek(0, 2)
            end = f.tell()
            start = max(0, end - max_bytes)
            f.seek(start)
            if start > 0:
                f.readline()
            chunk = f.read().decode('utf-8', errors='ignore')
        lines = chunk.split('\n')
        if len(lines) > max_lines:
            sk = len(lines) - max_lines
            lines = lines[-max_lines:]
            return f"... (пропущено {sk} строк)\n\n" + '\n'.join(lines)
        return '\n'.join(lines)
    except Exception as e:
        return f"Error reading log: {e}"

def clear_log():
    try:
        if RUNTIME_LOG.exists():
            try:
                RUNTIME_LOG.replace(BASE / "runtime.log.prev")
            except:
                pass
            with open(RUNTIME_LOG, 'w', encoding='utf-8') as f:
                f.write(f"[{datetime.now(MSK).isoformat()}] Log cleared by admin\n")
    except:
        pass

# ============================================
# ATOMIC JSON
# ============================================
def rj(p, d):
    try:
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return d

def wj(p, d):
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(dir=str(p.parent), suffix='.tmp')
        try:
            with os.fdopen(tmp_fd, 'w', encoding='utf-8') as f:
                json.dump(d, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, p)
        except:
            try:
                os.unlink(tmp_path)
            except:
                pass
            raise
    except Exception as e:
        print(f"[wj] err {p}: {e}", flush=True)

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

# ============================================
# RATE LIMITING
# ============================================
login_attempts_lock = threading.Lock()
login_attempts = {}

def check_rate_limit(key, max_attempts=MAX_LOGIN_ATTEMPTS, window=RATE_LIMIT_WINDOW):
    now = time.time()
    with login_attempts_lock:
        if key not in login_attempts:
            login_attempts[key] = []
        login_attempts[key] = [t for t in login_attempts[key] if now - t < window]
        if len(login_attempts[key]) >= max_attempts:
            return False, len(login_attempts[key])
        login_attempts[key].append(now)
        return True, len(login_attempts[key])

def log_failed_login(key, reason):
    try:
        attempts = rj(LOGIN_ATTEMPTS_FILE, [])
        attempts.append({'time': datetime.now(MSK).isoformat(), 'key': key, 'reason': reason})
        if len(attempts) > 1000:
            attempts = attempts[-1000:]
        wj(LOGIN_ATTEMPTS_FILE, attempts)
    except:
        pass

# ============================================
# TUNNEL (SSH + CLOUDFLARED FAILOVER)
# ============================================
tunnel_process = None
cloudflared_process = None
current_tunnel_url = None
tunnel_type = None  # 'ssh' or 'cloudflared'
tunnel_last_activity = time.time()

def load_tunnel_state():
    try:
        if TUNNEL_STATE_FILE.exists():
            with open(TUNNEL_STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except:
        pass
    return {}

def save_tunnel_state(s):
    try:
        with open(TUNNEL_STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(s, f, indent=2)
    except:
        pass

def post_url_to_channel(url, reason="new", ttype="ssh", retries=5):
    now = datetime.now(MSK).strftime('%H:%M:%S')
    emoji = "🔵" if ttype == "cloudflared" else "🔴"
    msg = (f"🔄 <b>Туннель {'обновлён' if reason == 'new' else 'переподключён'}</b> {emoji}\n\n"
           f"🌐 <code>{url}</code>\n"
           f"🔧 Тип: <code>{ttype}</code>\n\n"
           f"⏰ {now}\n📡 <code>t.me/s/{CHANNEL_USERNAME}</code>")
    for attempt in range(retries):
        try:
            bot.send_message(CHANNEL_ID, msg, parse_mode='HTML', disable_web_page_preview=True)
            print(f"[Tunnel] ✓ канал: {url} ({ttype})", flush=True)
            _flush_pending_posts()
            return True
        except Exception as e:
            print(f"[Tunnel] post attempt {attempt+1}/{retries}: {e}", flush=True)
            time.sleep(3)
    try:
        with open(FALLBACK_URL_FILE, 'a', encoding='utf-8') as f:
            f.write(f"{now}|{url}|{reason}|{ttype}\n")
    except:
        pass
    return False

def _flush_pending_posts():
    if not FALLBACK_URL_FILE.exists():
        return
    try:
        with open(FALLBACK_URL_FILE, 'r', encoding='utf-8') as f:
            lines = f.read().strip().split('\n')
        with open(FALLBACK_URL_FILE, 'w', encoding='utf-8') as f:
            f.write('')
        for line in lines:
            if not line.strip():
                continue
            try:
                parts = line.split('|', 3)
                if len(parts) >= 2:
                    url = parts[1]
                    reason = parts[2] if len(parts) > 2 else 'old'
                    ttype = parts[3] if len(parts) > 3 else 'ssh'
                    msg = f"📬 <b>Отложенный URL</b>\n\n🌐 <code>{url}</code>\n📋 {reason} ({ttype})"
                    bot.send_message(CHANNEL_ID, msg, parse_mode='HTML', disable_web_page_preview=True)
            except:
                pass
    except:
        pass

def check_ssh_available(host="localhost.run", port=22, timeout=5):
    """Проверяет доступен ли SSH порт"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((host, port))
        s.close()
        return True
    except:
        return False

def cloudflared_available():
    """Проверяет установлен ли cloudflared"""
    return CLOUDFLARED_BIN.exists() and os.access(str(CLOUDFLARED_BIN), os.X_OK)

def start_cloudflared():
    """Запускает cloudflared туннель"""
    global cloudflared_process, current_tunnel_url, tunnel_type, tunnel_last_activity
    if not cloudflared_available():
        print("[Tunnel] cloudflared binary not found at " + str(CLOUDFLARED_BIN), flush=True)
        return False
    print("[Tunnel] запуск cloudflared...", flush=True)
    try:
        p = subprocess.Popen(
            [str(CLOUDFLARED_BIN), 'tunnel', '--url', f'http://localhost:{PORT}',
             '--no-autoupdate', '--no-chunked-encoding'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        with tunnel_lock:
            cloudflared_process = p
            tunnel_type = 'cloudflared'
        # читаем вывод и ищем URL
        url_found = False
        for line in iter(p.stdout.readline, ''):
            line = line.strip()
            if not line:
                continue
            print(f"[Cloudflared] {line}", flush=True)
            tunnel_last_activity = time.time()
            # ищем URL типа https://xxx.trycloudflare.com
            m = re.search(r'(https://[a-z0-9-]+\.trycloudflare\.com)', line)
            if m:
                nu = m.group(1)
                with tunnel_lock:
                    ou = current_tunnel_url
                    current_tunnel_url = nu
                if nu != ou:
                    print(f"[Tunnel] ✓ НОВЫЙ CLOUDFLARED URL: {nu}", flush=True)
                    post_url_to_channel(nu, "reconnect" if ou else "new", "cloudflared")
                    try:
                        with open(TUNNEL, 'w', encoding='utf-8') as f:
                            f.write(nu)
                        save_tunnel_state({'last_url': nu, 'type': 'cloudflared',
                                           'updated_at': datetime.now(MSK).isoformat()})
                    except:
                        pass
                url_found = True
                break
            if "failed" in line.lower() or "error" in line.lower():
                print(f"[Tunnel] cloudflared error: {line}", flush=True)
                return False
        if not url_found:
            print("[Tunnel] cloudflared: URL не найден в выводе", flush=True)
            return False
        # держим процесс живым
        p.wait()
        return True
    except Exception as e:
        print(f"[Tunnel] cloudflared err: {e}", flush=True)
        return False

def start_ssh_tunnel():
    """Запускает SSH туннель (localhost.run)"""
    global tunnel_process, current_tunnel_url, tunnel_type, tunnel_last_activity
    if subprocess.run("which ssh", shell=True, capture_output=True).returncode != 0:
        os.system("pkg install -y openssh 2>&1 | tail -3")
    if not (Path.home() / ".ssh" / "id_rsa").exists():
        os.system('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa >/dev/null 2>&1')
    fails = 0
    while True:
        print("[Tunnel] запуск localhost.run...", flush=True)
        tunnel_last_activity = time.time()
        try:
            p = subprocess.Popen(
                ['ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
                 '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
                 '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15',
                 '-R', f'80:localhost:{PORT}', 'nokey@localhost.run'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            with tunnel_lock:
                tunnel_process = p
                tunnel_type = 'ssh'
            for line in iter(p.stdout.readline, ''):
                line = line.strip()
                if not line:
                    continue
                tunnel_last_activity = time.time()
                print(f"[SSH] {line}", flush=True)
                m = re.search(r'(https://[a-z0-9-]+\.lhr\.life)', line)
                if m:
                    nu = m.group(1)
                    with tunnel_lock:
                        ou = current_tunnel_url
                        current_tunnel_url = nu
                    if nu != ou:
                        print(f"[Tunnel] ✓ НОВЫЙ SSH URL: {nu}", flush=True)
                        post_url_to_channel(nu, "reconnect" if ou else "new", "ssh")
                        try:
                            with open(TUNNEL, 'w', encoding='utf-8') as f:
                                f.write(nu)
                            save_tunnel_state({'last_url': nu, 'type': 'ssh',
                                               'updated_at': datetime.now(MSK).isoformat()})
                        except:
                            pass
                        fails = 0
            p.wait()
            fails += 1
            wait = min(1 + fails, 10)
            print(f"[Tunnel] SSH упал (fail #{fails}), рестарт через {wait}с...", flush=True)
            time.sleep(wait)
        except Exception as e:
            print(f"[Tunnel] SSH err: {e}", flush=True)
            fails += 1
            time.sleep(2)

def start_tunnel():
    """Главная функция туннеля: пробует SSH, если не работает — cloudflared"""
    global tunnel_type
    st_state = load_tunnel_state()
    if st_state.get('last_url'):
        with tunnel_lock:
            current_tunnel_url = st_state['last_url']

    # Если принудительно включён cloudflared
    if FORCE_CLOUDFLARED:
        print("[Tunnel] force_cloudflared=true в config, использую только cloudflared", flush=True)
        if cloudflared_available():
            while True:
                start_cloudflared()
                time.sleep(5)
        else:
            print("[Tunnel] cloudflared не установлен, падаем на SSH", flush=True)
        start_ssh_tunnel()
        return

    # Проверяем доступность SSH
    print("[Tunnel] проверка доступности SSH порта...", flush=True)
    ssh_ok = check_ssh_available()
    cf_ok = cloudflared_available()

    if ssh_ok:
        print("[Tunnel] ✓ SSH доступен, использую localhost.run", flush=True)
        start_ssh_tunnel()
    elif cf_ok:
        print("[Tunnel] ✗ SSH недоступен, переключаюсь на cloudflared", flush=True)
        while True:
            start_cloudflared()
            time.sleep(5)
    else:
        print("[Tunnel] ❌ Ни SSH ни cloudflared не доступны!", flush=True)
        print("[Tunnel] Запусти: cd ~/telegram-bot && ./cloudflared --version", flush=True)

def force_reload_tunnel(reason="manual"):
    global tunnel_last_activity, tunnel_process, cloudflared_process
    print(f"[Tunnel-RELOAD] force reload: {reason}", flush=True)
    with tunnel_lock:
        if tunnel_process is not None:
            try:
                tunnel_process.terminate()
                tunnel_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                tunnel_process.kill()
            except:
                pass
        tunnel_process = None
        if cloudflared_process is not None:
            try:
                cloudflared_process.terminate()
                cloudflared_process.wait(timeout=3)
            except:
                try: cloudflared_process.kill()
                except: pass
        cloudflared_process = None
    tunnel_last_activity = time.time()
    return True

def tunnel_watchdog_loop():
    global tunnel_last_activity
    time.sleep(60)
    while True:
        try:
            if get_current_tunnel_url():
                with tunnel_lock:
                    p = tunnel_process
                    cp = cloudflared_process
                active_proc = p if (p and p.poll() is None) else (cp if (cp and cp.poll() is None) else None)
                if active_proc is None:
                    tunnel_last_activity = time.time()
                else:
                    idle = time.time() - tunnel_last_activity
                    if idle > 120:
                        force_reload_tunnel("watchdog_stale")
                        tunnel_last_activity = time.time()
        except Exception as e:
            print(f"[Watchdog] err: {e}", flush=True)
        time.sleep(15)

def get_current_tunnel_url():
    with tunnel_lock:
        return current_tunnel_url

def get_current_tunnel_type():
    with tunnel_lock:
        return tunnel_type or 'unknown'

def tunnel():
    u = get_current_tunnel_url()
    if u:
        return u
    try:
        if TUNNEL.exists():
            with open(TUNNEL, 'r', encoding='utf-8') as f:
                t = f.read().strip()
            if t.startswith('http'):
                return t
    except:
        pass
    return cfg.get('tunnel_url')

def bot_uptime_sec():
    return int(time.time() - BOT_START)

def enc(t):
    try:
        b = t.encode()
        salt = hashlib.sha256(KEY).digest()
        return base64.b64encode(bytes(x ^ salt[i % len(salt)] ^ KEY[i % len(KEY)] for i, x in enumerate(b))).decode()
    except:
        return None

def dec(d):
    try:
        b = base64.b64decode(d)
        salt = hashlib.sha256(KEY).digest()
        return bytes(x ^ salt[i % len(salt)] ^ KEY[i % len(KEY)] for i, x in enumerate(b)).decode()
    except:
        return None

def chash(t):
    return hashlib.sha256((str(t) + KEY.decode('utf-8', errors='ignore')).encode()).hexdigest()[:16]

def reg(u):
    return str(u) in lu()

def dn(u):
    d = lu().get(str(u))
    return (d.get('name') or str(u)) if d else str(u)

def ia(u):
    try:
        uid = int(u)
    except:
        return False
    if uid in TRUSTED_PLAYERS_INT:
        name = TRUSTED_PLAYERS_INT[uid]
        if name == TECH or name in PROTECTED:
            return True
    d = lu().get(str(uid))
    if not d:
        return False
    if d.get('is_admin'):
        return True
    n = d.get('name')
    if n == TECH:
        return True
    return bool(n and n in PROTECTED)

def role(u):
    try:
        uid = int(u)
    except:
        return "user"
    if uid in TRUSTED_PLAYERS_INT:
        name = TRUSTED_PLAYERS_INT[uid]
        if name == TECH:
            return "tech"
        if name in PROTECTED:
            return "admin"
    d = lu().get(str(uid))
    if not d:
        return "user"
    if d.get('is_bot'):
        return "bot"
    n = d.get('name')
    if n == TECH:
        return "tech"
    if n in PROTECTED or d.get('is_admin'):
        return "admin"
    return "user"

def aia():
    a = []
    for s, d in lu().items():
        try:
            if ia(int(s)):
                a.append(int(s))
        except:
            pass
    for uid in TRUSTED_PLAYERS_INT.keys():
        if ia(uid) and uid not in a:
            a.append(uid)
    return a

def gs(u):
    return ls().get(str(u), {})

def sets(u, d):
    s = ls()
    s[str(u)] = d
    ss(s)

def cs(u):
    s = ls()
    if str(u) in s:
        del s[str(u)]
    ss(s)

def tr(t, m):
    return t if len(t) <= m else t[:m-1] + "…"

def safe(t):
    if t is None:
        return "—"
    return html_lib.escape(str(t))

def ui_header(t, e="📋"):
    return f"{e} <b>{t}</b>\n<code>{'━'*28}</code>"

def ui_row(l, v, e="•"):
    return f"{e} {l}: <code>{safe(v)}</code>"

def ui_status(o):
    return "🟢 <b>Online</b>" if o else "🔴 <b>Offline</b>"

def ui_mode(m):
    if m == 'service':
        return "🔧 Сервисный"
    if m == 'fortress':
        return "🚨 УСИЛЕННАЯ ЗАЩИТА"
    return "🔓 Обычный"

def ui_divider():
    return f"<code>{'─'*20}</code>"

def msk_now():
    return datetime.now(MSK)

def fmt_duration(sec):
    sec = int(max(0, sec))
    if sec < 60:
        return f"{sec}с"
    m = sec // 60
    if m < 60:
        return f"{m}м"
    h = m // 60
    m = m % 60
    if h < 24:
        return f"{h}ч {m}м"
    d = h // 24
    h = h % 24
    return f"{d}д {h}ч"

def gm_icon(g):
    g = (g or 'unknown').lower()
    if 'surv' in g:
        return "🗡"
    if 'creat' in g:
        return "🎨"
    if 'adv' in g:
        return "🧭"
    if 'spec' in g:
        return "👁"
    return "❔"

def hb_category(sec):
    try:
        sec = int(sec)
    except:
        sec = 30
    if sec == 5:
        return "1️⃣ Частое (5с)"
    if sec == 30:
        return "2️⃣ Среднее (30с)"
    if sec == 300:
        return "3️⃣ Долгое (5м)"
    if sec == 600:
        return "4️⃣ Долгое+ (10м)"
    return f"5️⃣ Кастом ({sec}с)"

def validate_hb_interval(sec):
    try:
        sec = int(sec)
    except:
        return 30
    if sec < 5:
        return 5
    if sec > 3600:
        return 3600
    return sec

# ============================================
# TRUSTED PLAYERS
# ============================================
_trusted_cache = {}
_trusted_cache_lock = threading.Lock()

def auto_register_trusted(uid):
    try:
        uid = int(uid)
    except:
        return False
    with _trusted_cache_lock:
        if uid in _trusted_cache:
            return _trusted_cache[uid]
    if uid not in TRUSTED_PLAYERS_INT:
        with _trusted_cache_lock:
            _trusted_cache[uid] = False
        return False
    if reg(uid):
        with _trusted_cache_lock:
            _trusted_cache[uid] = True
        return True
    name = TRUSTED_PLAYERS_INT[uid]
    us = lu()
    us[str(uid)] = {
        'name': name,
        'username': f"player_{uid}",
        'is_bot': False,
        'is_admin': (name == TECH or name in PROTECTED),
        'registered_at': datetime.now(MSK).isoformat(),
        'trusted': True,
    }
    su(us)
    print(f"[Auth] auto-registered trusted {name} (uid={uid})", flush=True)
    with _trusted_cache_lock:
        _trusted_cache[uid] = True
    return True

# ============================================
# ONLINE TRACKING
# ============================================
player_online_since = {}
server_online_since = None

def load_online_tracking():
    global player_online_since, server_online_since
    try:
        with open(ONLINE_TRACK_FILE, 'r', encoding='utf-8') as f:
            d = json.load(f)
        player_online_since = d.get('players', {})
        server_online_since = d.get('server')
    except:
        pass

def save_online_tracking():
    try:
        with open(ONLINE_TRACK_FILE, 'w', encoding='utf-8') as f:
            json.dump({'players': player_online_since, 'server': server_online_since}, f)
    except:
        pass

def get_online_since(n):
    return player_online_since.get(n) or player_online_since.get(n.lower())

# ============================================
# FINDERS
# ============================================
def find_user_by_arg(arg, ul):
    try:
        i = int(arg) - 1
        if 0 <= i < len(ul):
            return ul[i]
    except ValueError:
        pass
    al = arg.lower()
    for tid, td in ul:
        if (td.get('name') or '').lower() == al:
            return tid, td
    for tid, td in ul:
        if al in (td.get('name') or '').lower():
            return tid, td
    return None, None

def find_paste_by_arg(arg, pl):
    try:
        i = int(arg) - 1
        if 0 <= i < len(pl):
            return i, pl[i]
    except ValueError:
        pass
    al = arg.lower()
    for i, p in enumerate(pl):
        if p['name'].lower() == al:
            return i, p
    for i, p in enumerate(pl):
        if al in p['name'].lower():
            return i, p
    return None, None

# ============================================
# UI HELPERS
# ============================================
def edit_or_send(c, t, kb=None, pm='HTML'):
    if hasattr(c, 'message') and c.message:
        try:
            bot.edit_message_text(t, c.message.chat.id, c.message.message_id, parse_mode=pm, reply_markup=kb)
        except Exception as e:
            if "message is not modified" not in str(e):
                try:
                    bot.send_message(c.message.chat.id, t, parse_mode=pm, reply_markup=kb)
                except:
                    pass
    elif hasattr(c, 'chat'):
        bot.send_message(c.chat.id, t, parse_mode=pm, reply_markup=kb)

def send_paste_file(cid, content, name, uid):
    fid = None
    try:
        fo = io.BytesIO(content.encode('utf-8'))
        fo.name = f"{name}.txt"
        fid = bot.send_document(cid, fo, caption=f"📄 {name}").message_id
    except:
        try:
            import tempfile as tf
            with tf.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as f:
                f.write(content)
                tp = f.name
            with open(tp, 'rb') as f:
                fid = bot.send_document(cid, f, caption=f"📄 {name}").message_id
            os.unlink(tp)
        except:
            try:
                fid = bot.send_message(cid, f"📄 <b>{name}</b>\n<pre>{safe(content[:4000])}</pre>", parse_mode='HTML').message_id
            except:
                pass
    if fid:
        s = gs(uid) or {}
        s['last_file_msg_id'] = fid
        s['last_file_chat_id'] = cid
        sets(uid, s)
    return fid

def delete_last_file(uid):
    s = gs(uid) or {}
    mid = s.get('last_file_msg_id')
    cid = s.get('last_file_chat_id')
    if mid and cid:
        try:
            bot.delete_message(cid, mid)
        except:
            pass
        s.pop('last_file_msg_id', None)
        s.pop('last_file_chat_id', None)
        sets(uid, s)

def vs(tok, cid, ip):
    ts = lt()
    if tok not in ts:
        return False, "inv", None
    td = ts[tok]
    created = td.get('created_at')
    if created:
        try:
            age = (datetime.now(MSK) - datetime.fromisoformat(created)).total_seconds()
            if age > TOKEN_TTL_SECONDS:
                rt(tok, "Token expired (30d)")
                return False, "expired", None
        except:
            pass
    rc = td.get('computer_id')
    if not rc:
        td['computer_id'] = cid
        ts[tok] = td
        st(ts)
        rc = cid
    if rc != cid:
        rt(tok, "CID mismatch")
        return False, "intr", None
    return True, "ok", td

def rt(tok, r="unknown"):
    ts = lt()
    if tok in ts:
        td = ts.pop(tok)
        st(ts)
        us = lu()
        pid = td.get('pending_id')
        if pid and pid in us:
            n = us[pid].get('name', '?')
            del us[pid]
            su(us)
            na(f"🚫 <b>ОТОЗВАН</b>\n{ui_divider()}\n🤖 <code>{safe(n)}</code>\n📝 {safe(r)}")

def na(m):
    for a in aia():
        try:
            bot.send_message(a, m, parse_mode='HTML')
        except:
            pass

# ============================================
# PLAYER TRACKING
# ============================================
player_positions = {}
player_zones = {}
player_last_seen = {}
player_vanish_since = {}
player_file_lines = {}
radar_first_seen = {}
vanish_cooldown = {}

def point_in_polygon(x, z, poly):
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, zi = poly[i]['x'], poly[i]['z']
        xj, zj = poly[j]['x'], poly[j]['z']
        if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / (zj - zi) + xi):
            inside = not inside
        j = i
    return inside

def point_to_segment_dist(px, pz, ax, az, bx, bz):
    dx = bx - ax
    dz = bz - az
    l2 = dx * dx + dz * dz
    if l2 == 0:
        return ((px - ax)**2 + (pz - az)**2)**0.5
    t = max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / l2))
    return ((px - (ax + t * dx))**2 + (pz - (az + t * dz))**2)**0.5

def load_locations():
    try:
        with open(LOCATIONS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return {}

def save_locations(l):
    with open(LOCATIONS_FILE, 'w', encoding='utf-8') as f:
        json.dump(l, f, indent=2)

def is_teleport(name, x, z, ts):
    if name not in player_positions or len(player_positions[name]) < 3:
        return False
    pos = player_positions[name][-8:]
    sp = []
    for i in range(1, len(pos)):
        dt = pos[i]['timestamp'] - pos[i-1]['timestamp']
        if dt <= 0:
            continue
        d = ((pos[i]['x'] - pos[i-1]['x'])**2 + (pos[i]['z'] - pos[i-1]['z'])**2)**0.5
        sp.append(d / dt)
    if len(sp) < 2:
        return False
    if sp[-1] < 50:
        return False
    if max(sp[:-1]) < 5:
        return True
    acc = any(sp[i] > sp[i-1] + 3 for i in range(1, len(sp)))
    dec = any(sp[i] < sp[i-1] - 3 for i in range(1, len(sp)))
    return not (acc or dec)

def update_zone_status(name, x, z):
    return "standing"

def is_player_in_tab(name):
    try:
        if SITE_STATUS_FILE.exists():
            with open(SITE_STATUS_FILE, 'r', encoding='utf-8') as f:
                d = json.load(f)
            if not d.get('online'):
                return False
            return name.lower() in [p.lower() for p in d.get('players_list', [])]
    except:
        pass
    return False

def format_history_line(ts, x, y, z, dim, health, maxhealth, eye, yaw, pitch, status, in_tab, vanish, imp, online_sec, gamemode):
    t = datetime.fromtimestamp(ts, MSK).strftime('%H:%M:%S')
    return (f"{t}|{x:.1f},{y:.1f},{z:.1f}|{dim}|{health:.1f}|{maxhealth:.1f}|{eye:.2f}|{yaw:.1f}|{pitch:.1f}|{status}|"
            f"{'true' if in_tab else 'false'}|{'true' if vanish else 'false'}|{'true' if imp else 'false'}|{online_sec}|{gamemode}")

def save_player_history(name, line, important):
    fp = PLAYERS_DIR / f"{name}.txt"
    try:
        with open(fp, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception as e:
        print(f"[Tracker] {name}: {e}", flush=True)
    if name not in player_file_lines:
        player_file_lines[name] = 0
    player_file_lines[name] += 1
    if player_file_lines[name] > MAX_HISTORY * 1.2:
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            if len(lines) > MAX_HISTORY:
                with open(fp, 'w', encoding='utf-8') as f:
                    f.writelines(lines[-MAX_HISTORY:])
                player_file_lines[name] = MAX_HISTORY
        except:
            pass

def get_vanish_tracking_admins():
    return aia()

def notify_vanish(name, x, z, dim):
    admins = get_vanish_tracking_admins()
    if not admins:
        return
    msg = (f"🚨 <b>ВАНИШ ОБНАРУЖЕН!</b>\n\n👤 <code>{safe(name)}</code>\n"
           f"📍 <code>[{x:.0f}, {z:.0f}]</code> | {safe(dim)}\n"
           f"⚠️ В радаре есть, в табе НЕТ\n⏰ {msk_now().strftime('%H:%M:%S')}")
    for a in admins:
        try:
            s = gs(a) or {}
            if 'vanish_msg_id' in s:
                try:
                    bot.edit_message_text(msg, a, s['vanish_msg_id'], parse_mode='HTML')
                except:
                    m = bot.send_message(a, msg, parse_mode='HTML')
                    s['vanish_msg_id'] = m.message_id
                    sets(a, s)
            else:
                m = bot.send_message(a, msg, parse_mode='HTML')
                s['vanish_msg_id'] = m.message_id
                sets(a, s)
        except Exception as e:
            print(f"[Vanish] {a}: {e}", flush=True)

def clear_vanish_notifications():
    for a in get_vanish_tracking_admins():
        s = gs(a) or {}
        if 'vanish_msg_id' in s:
            try:
                bot.delete_message(a, s['vanish_msg_id'])
            except:
                pass
            s.pop('vanish_msg_id', None)
            sets(a, s)

def clear_vanish_for_player(name):
    player_vanish_since.pop(name, None)
    radar_first_seen.pop(name, None)
    for a in get_vanish_tracking_admins():
        s = gs(a) or {}
        if 'vanish_msg_id' in s:
            try:
                bot.delete_message(a, s['vanish_msg_id'])
            except:
                pass
            s.pop('vanish_msg_id', None)
            sets(a, s)

def process_player_data(data):
    if not isinstance(data, dict):
        return
    now = time.time()
    players_in_update = data.get('players', [])
    if not isinstance(players_in_update, list):
        return
    current_names = set()
    for p in players_in_update:
        if not isinstance(p, dict):
            continue
        name = p.get('name')
        if isinstance(name, str) and name.strip():
            current_names.add(name.strip())
    for name in list(player_vanish_since.keys()):
        if name not in current_names:
            clear_vanish_for_player(name)
    with players_lock:
        for p in players_in_update:
            if not isinstance(p, dict):
                continue
            name = p.get('name')
            if not isinstance(name, str) or not name.strip():
                continue
            name = name.strip()
            if len(name) < 2 or len(name) > 16:
                continue
            if not re.match(r'^[A-Za-z0-9_]+$', name):
                continue
            try:
                x = float(p.get('x', 0))
                y = float(p.get('y', 0))
                z = float(p.get('z', 0))
                health = float(p.get('health', 20))
                maxhealth = float(p.get('maxHealth', 20))
                eye = float(p.get('eyeHeight', 1.62))
                yaw = float(p.get('yaw', 0))
                pitch = float(p.get('pitch', 0))
                ts = float(p.get('timestamp', now))
            except (TypeError, ValueError):
                continue
            dim = str(p.get('dimension', 'unknown'))[:32]
            gamemode = str(p.get('gamemode', 'unknown'))[:16]
            player_positions.setdefault(name, []).append({
                'x': x, 'y': y, 'z': z, 'timestamp': ts,
                'dimension': dim, 'gamemode': gamemode
            })
            if len(player_positions[name]) > 100:
                player_positions[name] = player_positions[name][-100:]
            if name not in radar_first_seen:
                radar_first_seen[name] = ts
            in_tab = is_player_in_tab(name)
            if not in_tab and (ts - radar_first_seen.get(name, ts)) > VANISH_GRACE:
                if name not in player_vanish_since:
                    player_vanish_since[name] = ts
                if now - vanish_cooldown.get(name, 0) > VANISH_NOTIFY_CD:
                    vanish_cooldown[name] = now
                    notify_vanish(name, x, z, dim)
            elif in_tab:
                player_vanish_since.pop(name, None)
                radar_first_seen.pop(name, None)
            vanish = name in player_vanish_since
            tele = is_teleport(name, x, z, ts)
            status = update_zone_status(name, x, z)
            imp = vanish or tele
            since = get_online_since(name)
            online_sec = int(now - since) if since else 0
            save_player_history(name, format_history_line(
                ts, x, y, z, dim, health, maxhealth, eye, yaw, pitch,
                status, in_tab, vanish, imp, online_sec, gamemode), imp)

def vanish_checker_loop():
    while True:
        try:
            if not player_vanish_since:
                clear_vanish_notifications()
        except Exception as e:
            print(f"[VanishChecker] err: {e}", flush=True)
        time.sleep(5)

# ============================================
# TUNNEL HEALTH
# ============================================
tunnel_health = {
    'status': 'unknown', 'url': None, 'type': None, 'last_check': None,
    'last_ok': None, 'errors': [], 'checks_total': 0,
    'checks_ok': 0, 'last_error': None
}

def sanitize_error(e):
    t = re.sub(r'<[^>]+>', '', str(e))
    return t.replace('<', '').replace('>', '')[:200]

def check_tunnel_health():
    global tunnel_health
    try:
        url = tunnel()
        ttype = get_current_tunnel_type()
        if not url:
            with tunnel_health_lock:
                tunnel_health['status'] = 'no_url'
                tunnel_health['last_error'] = 'No URL'
            return
        with tunnel_health_lock:
            tunnel_health['url'] = url
            tunnel_health['type'] = ttype
            tunnel_health['last_check'] = datetime.now(MSK).isoformat()
            tunnel_health['checks_total'] = tunnel_health.get('checks_total', 0) + 1
        local_ok = False
        try:
            with urllib.request.urlopen(f'http://localhost:{PORT}/api/url', timeout=5) as r:
                local_ok = r.status == 200
        except Exception as e:
            with tunnel_health_lock:
                tunnel_health['last_error'] = f'Localhost: {sanitize_error(e)}'
        try:
            headers = {'bypass-tunnel-reminder': 'true', 'User-Agent': 'HealthCheck/1.0'}
            req = urllib.request.Request(f'{url}/api/url', headers=headers)
            with urllib.request.urlopen(req, timeout=10) as r:
                if r.status == 200:
                    with tunnel_health_lock:
                        tunnel_health['status'] = 'ok'
                        tunnel_health['last_ok'] = datetime.now(MSK).isoformat()
                        tunnel_health['checks_ok'] = tunnel_health.get('checks_ok', 0) + 1
                        tunnel_health['last_error'] = None
                    try:
                        with open(TUNNEL_HEALTH_FILE, 'w', encoding='utf-8') as f:
                            json.dump(tunnel_health, f, indent=2, default=str)
                    except:
                        pass
                    return
        except Exception as e:
            em = sanitize_error(e)
            with tunnel_health_lock:
                tunnel_health['last_error'] = f'Public: {em}'
                errors = tunnel_health.get('errors', [])
                errors.append({'time': datetime.now(MSK).isoformat(), 'error': em})
                tunnel_health['errors'] = errors[-10:]
                tunnel_health['status'] = 'tunnel_down' if local_ok else 'bot_down'
        try:
            with open(TUNNEL_HEALTH_FILE, 'w', encoding='utf-8') as f:
                json.dump(tunnel_health, f, indent=2, default=str)
        except:
            pass
    except Exception as e:
        print(f"[Tunnel] err: {e}", flush=True)

def tunnel_health_loop():
    time.sleep(5)
    while True:
        try:
            check_tunnel_health()
        except Exception as e:
            print(f"[Tunnel] err: {e}", flush=True)
        time.sleep(60)

def get_tunnel_status_text():
    try:
        with tunnel_health_lock:
            h = dict(tunnel_health)
        if not h.get('last_check'):
            return "❓ Ещё не проверялся"
        s = h.get('status', 'unknown')
        url = h.get('url') or tunnel() or 'не настроен'
        ttype = h.get('type') or get_current_tunnel_type()
        tinfo = f" ({ttype})" if ttype != 'unknown' else ""
        if s == 'ok':
            tot = h.get('checks_total', 0)
            okc = h.get('checks_ok', 0)
            rate = int(okc / tot * 100) if tot else 100
            return f"🟢 <b>Работает</b>{tinfo}\n{ui_row('Успех', f'{rate}%')}\n{ui_row('URL', url)}"
        elif s == 'tunnel_down':
            return f"🟡 <b>Туннель недоступен</b>{tinfo}\n{ui_row('URL', url)}"
        elif s == 'bot_down':
            return "🔴 <b>Бот недоступен</b>"
        elif s == 'no_url':
            return "⚫ <b>URL не настроен</b>"
        return f"❓ <b>Статус:</b> {safe(s)}"
    except Exception as e:
        return f"⚠️ {str(e)[:50]}"

def update_url_from_log():
    u = get_current_tunnel_url()
    if u:
        try:
            with open(TUNNEL, 'w', encoding='utf-8') as f:
                f.write(u)
            return u
        except:
            pass
    return None

# ============================================
# SITE
# ============================================
def parse_site_status():
    global server_online_since
    try:
        req = urllib.request.Request(SITE_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as r:
            html_text = r.read().decode('utf-8')
        is_online = bool(re.search(r"minecraftserverinfo\s+isonline", html_text, re.IGNORECASE))
        players_list = []
        for nick in re.findall(r"<tr class='player'>\s*<td>\s*<img[^>]+alt='([A-Za-z0-9_]{3,16})'s Avatar'[^>]*>\s*[A-Za-z0-9_]{3,16}\s*</td>\s*<td>\s*<span class='playeronline'>Online</span>\s*</td>\s*</tr>", html_text, re.IGNORECASE):
            if nick not in players_list:
                players_list.append(nick)
        for row in re.findall(r"<tr class='player(?:\s+[^']*)?'>\s*(.*?)\s*</tr>", html_text, re.IGNORECASE | re.DOTALL):
            if "playeronline" not in row.lower():
                continue
            m = re.search(r"alt='([A-Za-z0-9_]{3,16})'s Avatar'", row, re.IGNORECASE)
            if m and m.group(1) not in players_list:
                players_list.append(m.group(1))
        address = "gmd.capscraft.com"
        am = re.search(r"data-address='([\w\.]+)'", html_text)
        if am:
            address = am.group(1)
        now = time.time()
        if is_online:
            if server_online_since is None:
                server_online_since = now
        else:
            server_online_since = None
        on = set(players_list)
        for n in players_list:
            if n not in player_online_since:
                player_online_since[n] = now
        for n in list(player_online_since):
            if n not in on:
                del player_online_since[n]
        save_online_tracking()
        result = {
            'online': is_online,
            'players_online': len(players_list),
            'address': address,
            'players_list': players_list,
            'last_check': datetime.now(MSK).isoformat(),
            'server_online_since': server_online_since,
            'server_uptime_sec': int(now - server_online_since) if (is_online and server_online_since) else 0
        }
        with open(SITE_STATUS_FILE, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        return result
    except Exception as e:
        print(f"[Site] err: {e}", flush=True)
        return None

def site_checker_loop():
    while True:
        try:
            s = parse_site_status()
            if s:
                print(f"[Site] {'🟢' if s['online'] else '🔴'} ({s['players_online']})", flush=True)
        except Exception as e:
            print(f"[Site] err: {e}", flush=True)
        time.sleep(60)

def watcher_loop():
    GRACE = 180
    print("[Watcher] started (grace=180s)", flush=True)
    while True:
        try:
            time.sleep(30)
            if not SITE_STATUS_FILE.exists():
                continue
            try:
                with open(SITE_STATUS_FILE, 'r', encoding='utf-8') as f:
                    if not json.load(f).get('online'):
                        continue
            except:
                continue
            heartbeats = lhb()
            users = lu()
            now = datetime.now(MSK)
            try:
                with open(CFG, 'r', encoding='utf-8') as f:
                    gk = json.load(f).get('kiktime_minutes', 10) * 60
            except:
                gk = 600
            for uid, user in list(users.items()):
                try:
                    if not user.get('is_bot'):
                        continue
                    svc = (user.get('mode', 'normal') == 'service')
                    kt = user.get('kiktime_override')
                    limit = (kt * 60) if kt else gk
                    if svc:
                        limit = max(limit, 600)
                    cid = user.get('computer_id')
                    if not cid:
                        continue
                    if cid not in heartbeats:
                        reg_at = user.get('registered_at')
                        if not reg_at:
                            continue
                        try:
                            delta = (now - datetime.fromisoformat(reg_at)).total_seconds()
                        except:
                            continue
                        if delta < GRACE:
                            continue
                        if delta > limit:
                            name = user.get('name', '?')
                            at = user.get('api_token')
                            print(f"[Watcher] KICK {name} (no heartbeat, {int(delta/60)} мин)", flush=True)
                            if at:
                                rt(at, f"Авто-кик: нет пульса {int(delta/60)} мин")
                            hb2 = lhb()
                            if cid in hb2:
                                del hb2[cid]
                                shb(hb2)
                            if uid in users:
                                del users[uid]
                                su(users)
                            na(f"🚫 <b>АВТО-КИК</b>\n🤖 <code>{safe(name)}</code>\n⚠️ Нет пульса {int(delta/60)} мин")
                        continue
                    lsv = heartbeats[cid].get('last_seen')
                    if not lsv:
                        continue
                    try:
                        delta = (now - datetime.fromisoformat(lsv)).total_seconds()
                    except:
                        continue
                    if delta < GRACE:
                        continue
                    if delta > limit:
                        name = user.get('name', '?')
                        at = user.get('api_token')
                        print(f"[Watcher] KICK {name} (offline {int(delta/60)} мин)", flush=True)
                        if at:
                            rt(at, f"Авто-кик: offline {int(delta/60)} мин")
                        hb2 = lhb()
                        if cid in hb2:
                            del hb2[cid]
                            shb(hb2)
                        if uid in users:
                            del users[uid]
                            su(users)
                        na(f"🚫 <b>АВТО-КИК</b>\n🤖 <code>{safe(name)}</code>\n⏱ Offline {int(delta/60)} мин")
                except Exception as e:
                    print(f"[Watcher] err {uid}: {e}", flush=True)
        except Exception as e:
            print(f"[Watcher] loop err: {e}", flush=True)

def get_radar_stats():
    users = lu()
    heartbeats = lhb()
    now = datetime.now(MSK)
    total = online = offline = 0
    for uid, u in users.items():
        if not u.get('is_bot'):
            continue
        if 'radar' not in u.get('assigned_pastes', []):
            continue
        total += 1
        cid = u.get('computer_id')
        if cid and cid in heartbeats:
            try:
                lsv = heartbeats[cid].get('last_seen')
                if lsv and (now - datetime.fromisoformat(lsv)).total_seconds() < 120:
                    online += 1
                    continue
            except:
                pass
        offline += 1
    return total, online, offline

# ============================================
# UI BUILDERS
# ============================================
def build_help_text():
    return (f"{ui_header('Справка v17.23', '📖')}\n\n"
            f"<b>🚀 Основные команды:</b>\n"
            f"<code>/start</code> — Запуск\n"
            f"<code>/menu</code> — Меню\n"
            f"<code>/help</code> — Справка\n"
            f"<code>/status</code> — Статус (авто-обновление 5с)\n"
            f"<code>/api</code> — API\n"
            f"<code>/api_reload</code> — Перезагрузить туннель\n\n"
            f"<b>📋 Пасты:</b>\n"
            f"<code>/past</code> — Список\n"
            f"<code>/past add name</code> — Создать\n"
            f"<code>/past edit N</code> — Изменить\n"
            f"<code>/past delete N</code> — Удалить\n\n"
            f"<b>👥 Компьютеры:</b>\n"
            f"<code>/all</code> — Список\n"
            f"<code>/all assign COMP paste</code> — Привязать\n"
            f"<code>/all perform COMP PASTE</code> — Запустить\n"
            f"<code>/all kick COMP</code> — Кикнуть")

def build_status_text():
    try:
        status = parse_site_status()
    except:
        status = None
    if not status:
        try:
            if SITE_STATUS_FILE.exists():
                with open(SITE_STATUS_FILE, 'r', encoding='utf-8') as f:
                    status = json.load(f)
        except:
            pass
    if not status:
        return None
    state = ui_status(status.get('online'))
    players_list = status.get('players_list', [])
    address = status.get('address', 'gmd.capscraft.com')
    now = time.time()
    txt = (f"{ui_header('Статус сервера', '🌐')}\n\n{state}\n\n"
           f"📡 <b>Адрес:</b> <code>{safe(address)}</code>\n")
    if status.get('online') and server_online_since:
        txt += f"⏱ <b>Сервер онлайн:</b> <code>{fmt_duration(now-server_online_since)}</code>\n"
    txt += "\n"
    coords = {}
    for name, pos in player_positions.items():
        if pos:
            coords[name.lower()] = pos[-1]
    if players_list:
        txt += f"<b>👤 Онлайн ({len(players_list)}):</b>\n"
        for nick in players_list[:30]:
            c = coords.get(nick.lower())
            v = "🚨" if nick in player_vanish_since else "🟢"
            g = gm_icon(c.get('gamemode')) if c else ""
            since = get_online_since(nick)
            dur = f" ⏱{fmt_duration(now-since)}" if since else ""
            if c:
                txt += f"  • {g} <code>{safe(nick)}</code> [{c['x']:.0f}, {c['y']:.0f}, {c['z']:.0f}]{dur} {v}\n"
            else:
                txt += f"  • <code>{safe(nick)}</code> 📍 нет координат{dur} {v}\n"
        if len(players_list) > 30:
            txt += f"  <i>... ещё {len(players_list)-30}</i>\n"
    else:
        txt += "<i>🔇 Никого нет онлайн</i>\n" if status.get('online') else "<i>💤 Сервер оффлайн</i>\n"
    onl_low = [p.lower() for p in players_list]
    vanished = [(n, player_positions[n][-1]) for n in player_vanish_since
                if n in player_positions and player_positions[n] and n.lower() not in onl_low]
    if vanished:
        txt += f"\n<b>🚨 ВАНИШ ({len(vanished)}):</b>\n"
        for name, c in vanished:
            g = gm_icon(c.get('gamemode'))
            since = get_online_since(name)
            dur = f" ⏱{fmt_duration(now-since)}" if since else ""
            txt += f"  • {g} <code>{safe(name)}</code> [{c['x']:.0f}, {c['y']:.0f}, {c['z']:.0f}]{dur} 🚨\n"
    r_total, r_on, r_off = get_radar_stats()
    radar = [(n, p[-1]) for n, p in player_positions.items() if p]
    if radar:
        txt += f"\n<b>📡 Радары (всего: {r_total} | 🟢 {r_on} | 🔴 {r_off}):</b>\n"
        onl = [p.lower() for p in players_list]
        for name, c in radar[:20]:
            mark = "🟢" if name.lower() in onl else "🚨"
            g = gm_icon(c.get('gamemode'))
            since = get_online_since(name)
            dur = f" ⏱{fmt_duration(now-since)}" if since else ""
            txt += f"  • {g} <code>{safe(name)}</code> [{c['x']:.0f}, {c['y']:.0f}, {c['z']:.0f}]{dur} {mark}\n"
        if len(radar) > 20:
            txt += f"  <i>... ещё {len(radar)-20}</i>\n"
    else:
        txt += f"\n<b>📡 Радары (всего: {r_total} | 🟢 {r_on} | 🔴 {r_off}):</b> <i>нет данных</i>\n"
    txt += f"\n<i>🕐 Обновлено: {msk_now().strftime('%H:%M:%S')} (авто каждые 5с)</i>"
    return txt

def status_keyboard():
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Обновить сейчас", callback_data="refresh:status"),
           types.InlineKeyboardButton("⏸ Стоп авто-обновление", callback_data="stop_auto_refresh"))
    kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
    return kb

def status_auto_refresh_loop():
    print("[Status] auto-refresh loop started (every 5s)", flush=True)
    while True:
        try:
            time.sleep(STATUS_REFRESH_INTERVAL)
            with active_status_lock:
                active_chats = list(active_status_messages.items())
            if not active_chats:
                continue
            txt = build_status_text()
            if not txt:
                continue
            kb = status_keyboard()
            for chat_id, message_id in active_chats:
                try:
                    bot.edit_message_text(txt, chat_id, message_id, parse_mode='HTML', reply_markup=kb)
                except Exception as e:
                    err = str(e)
                    if "message is not modified" in err:
                        pass
                    elif "MESSAGE_EDIT_TIME_LIMIT" in err or "message can't be edited" in err:
                        with active_status_lock:
                            active_status_messages.pop(chat_id, None)
                    elif "chat not found" in err or "user is deactivated" in err or "Forbidden" in err:
                        with active_status_lock:
                            active_status_messages.pop(chat_id, None)
        except Exception as e:
            print(f"[Status] auto-refresh error: {e}", flush=True)

def register_status_message(chat_id, message_id):
    with active_status_lock:
        active_status_messages[chat_id] = message_id

def unregister_status_messages(chat_id):
    with active_status_lock:
        active_status_messages.pop(chat_id, None)

# ============================================
# KEYBOARDS
# ============================================
def main_menu_keyboard(uid):
    u = lu().get(str(uid), {})
    em = "✅" if u.get('vanish_tracking') else "❌"
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("📋 Пасты", callback_data="menu:past"),
           types.InlineKeyboardButton("👥 Компьютеры", callback_data="menu:all"))
    kb.add(types.InlineKeyboardButton("🌐 Сервер", callback_data="menu:status"),
           types.InlineKeyboardButton("🖥 API", callback_data="menu:api"))
    kb.add(types.InlineKeyboardButton(f"🕵️ Слежение: {em}", callback_data="toggle_vanish"))
    kb.add(types.InlineKeyboardButton("❓ Помощь", callback_data="menu:help"))
    return kb

def back_to_menu_keyboard():
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
    return kb

def bpk(ps, pg):
    t = len(ps)
    tp = max(1, (t + PER - 1) // PER)
    pg = max(0, min(pg, tp - 1))
    st_ = pg * PER
    it = ps[st_:st_ + PER]
    kb = types.InlineKeyboardMarkup(row_width=1)
    for i, p in enumerate(it):
        idx = st_ + i
        n = tr(p['name'], MAX_PN)
        c = tr(p.get('cn', ''), MAX_N)
        bc = sum(1 for u in lu().values() if u.get('is_bot') and n.lower() in [x.lower() for x in u.get('assigned_pastes', [])])
        kb.add(types.InlineKeyboardButton(f"{idx+1:>2}. 📄 {safe(n)} • 👤 {safe(c)} • 🤖{bc}",
                                          callback_data="pv:" + str(idx)))
    nav = []
    if pg > 0:
        nav.append(types.InlineKeyboardButton("◀️", callback_data="pp:" + str(pg - 1)))
    nav.append(types.InlineKeyboardButton(f"{pg+1}/{tp}", callback_data="noop"))
    if pg < tp - 1:
        nav.append(types.InlineKeyboardButton("▶️", callback_data="pp:" + str(pg + 1)))
    if nav:
        kb.row(*nav)
    kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
    return kb, pg, tp

def buk(ud, pg):
    it = list(ud.items())
    t = len(it)
    tp = max(1, (t + PER - 1) // PER)
    pg = max(0, min(pg, tp - 1))
    st_ = pg * PER
    ip = it[st_:st_ + PER]
    kb = types.InlineKeyboardMarkup(row_width=1)
    for i, (uk, d) in enumerate(ip):
        n = tr(d.get('name') or uk, MAX_N)
        ic = {"tech": "🛠", "admin": "👑", "bot": "🤖"}.get(role(uk), "👤")
        if d.get('is_bot'):
            m = d.get('mode', 'normal')
            mi = "🔧" if m == 'service' else ("🚨" if m == 'fortress' else "🔓")
            kt = f" ⏱{d.get('kiktime_override')}м" if d.get('kiktime_override') else ""
            extra = f" {mi} 📋{len(d.get('assigned_pastes', []))}{kt}"
        else:
            extra = ""
        kb.add(types.InlineKeyboardButton(f"{i+1:>2}. {ic} {safe(n)}{extra}",
                                          callback_data=f"av:{i}:{uk}"))
    nav = []
    if pg > 0:
        nav.append(types.InlineKeyboardButton("◀️", callback_data="ap:" + str(pg - 1)))
    nav.append(types.InlineKeyboardButton(f"{pg+1}/{tp}", callback_data="noop"))
    if pg < tp - 1:
        nav.append(types.InlineKeyboardButton("▶️", callback_data="ap:" + str(pg + 1)))
    if nav:
        kb.row(*nav)
    kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
    return kb, pg, tp

def bbpk(uk):
    u = lu().get(uk, {})
    m = u.get('mode', 'normal')
    kb = types.InlineKeyboardMarkup(row_width=2)
    if u.get('is_bot'):
        kb.add(types.InlineKeyboardButton("🔧 → Обычный" if m == 'service' else "🔓 → Сервисный",
                                          callback_data="mode_toggle:" + uk))
        if u.get('kiktime_override'):
            kb.add(types.InlineKeyboardButton(f"⏱ Сбросить ({u['kiktime_override']}м)",
                                              callback_data="kt_reset:" + uk))
        else:
            kb.add(types.InlineKeyboardButton("⏱ Лимит", callback_data="kt_set:" + uk))
        kb.add(types.InlineKeyboardButton(f"💓 {hb_category(u.get('heartbeat_interval', 30))}",
                                          callback_data="hb_menu:" + uk))
        kb.add(types.InlineKeyboardButton("🚫 Кикнуть", callback_data="kick_bot:" + uk))
    kb.add(types.InlineKeyboardButton("🔙 Назад", callback_data="menu:all"))
    return kb

def hb_keyboard(uk):
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("1️⃣ 5с", callback_data="hb_set:" + uk + ":5"),
           types.InlineKeyboardButton("2️⃣ 30с", callback_data="hb_set:" + uk + ":30"))
    kb.add(types.InlineKeyboardButton("3️⃣ 5м", callback_data="hb_set:" + uk + ":300"),
           types.InlineKeyboardButton("4️⃣ 10м", callback_data="hb_set:" + uk + ":600"))
    kb.add(types.InlineKeyboardButton("5️⃣ Кастом", callback_data="hb_custom:" + uk))
    kb.add(types.InlineKeyboardButton("🔙 Назад", callback_data="av_back:" + uk))
    return kb

def confirm_keyboard(aid):
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("✅ Да", callback_data=f"confirm:{aid}:yes"),
           types.InlineKeyboardButton("❌ Нет", callback_data=f"confirm:{aid}:no"))
    return kb

def build_api_text():
    tu = tunnel()
    su_ = tu or ("http://" + LIP + ":" + str(PORT))
    ttype = get_current_tunnel_type()
    return (f"{ui_header('API Информация', '🖥')}\n\n"
            f"<b>⏱ Бот работает:</b> <code>{fmt_duration(bot_uptime_sec())}</code>\n\n"
            f"<b>🔌 Подключение:</b>\n"
            f"{ui_row('Тип', '🌐 localhost.run (SSH)' if ttype == 'ssh' else ('☁️ cloudflared' if ttype == 'cloudflared' else '🏠 Локальная сеть'))}\n"
            f"{ui_row('URL', su_)}\n"
            f"{ui_row('Пароль', PASSWORD)}\n"
            f"{ui_row('Порт', PORT)}\n\n"
            f"<b>📡 Relay:</b>\n"
            f"{ui_row('Канал', f'@{CHANNEL_USERNAME}')}\n"
            f"{ui_row('Веб', f't.me/s/{CHANNEL_USERNAME}')}\n\n"
            f"<b>🌐 Туннель:</b>\n{get_tunnel_status_text()}\n\n"
            f"<b>🔧 Диагностика:</b>\n"
            f"<code>{safe(su_)}/api/health</code>\n"
            f"<code>{safe(su_)}/api/url</code>")

def show_paste_profile(c, idx):
    ps = lp()
    if idx < 0 or idx >= len(ps):
        bot.answer_callback_query(c.id, "❌ Паст не найден")
        return
    delete_last_file(c.from_user.id)
    p = ps[idx]
    c_ = dec(p['content'])
    if not c_:
        bot.answer_callback_query(c.id, "❌ Ошибка дешифрования")
        return
    b = [u.get('name', '?') for u in lu().values() if u.get('is_bot') and p['name'].lower() in [x.lower() for x in u.get('assigned_pastes', [])]]
    txt = (f"{ui_header(p['name'], '📄')}\n\n"
           f"{ui_row('👤 Автор', p.get('cn', '?'))}\n"
           f"{ui_row('📊 Размер', f'{len(c_)} байт')}\n"
           f"{ui_row('🔐 Хеш', p.get('hash', '?'))}\n")
    if b:
        txt += "\n<b>🤖 Привязан к:</b>\n"
        for n in b[:10]:
            txt += f"  • <code>{safe(n)}</code>\n"
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🗑 Удалить", callback_data=f"paste_del:{idx}"),
           types.InlineKeyboardButton("🔙 К пастам", callback_data="menu:past"))
    try:
        if c.message:
            bot.edit_message_text(txt, c.message.chat.id, c.message.message_id,
                                  parse_mode='HTML', reply_markup=kb)
    except:
        if hasattr(c, 'chat'):
            bot.send_message(c.chat.id, txt, parse_mode='HTML', reply_markup=kb)
    send_paste_file(c.message.chat.id if c.message else c.chat.id, c_, p['name'], c.from_user.id)

# ============================================
# COMMANDS SETUP
# ============================================
PUBLIC_COMMANDS = [
    types.BotCommand("start", "🚀 Пуск"),
    types.BotCommand("menu", "📱 Меню"),
    types.BotCommand("help", "❓ Помощь"),
    types.BotCommand("past", "📋 Пасты"),
    types.BotCommand("all", "👥 Компьютеры"),
]
ADMIN_COMMANDS = PUBLIC_COMMANDS + [
    types.BotCommand("status", "🌐 Статус сервера (live)"),
    types.BotCommand("api", "🖥 API и туннель"),
    types.BotCommand("api_reload", "🔄 Перезагрузить туннель"),
    types.BotCommand("log", "📄 Скачать логи"),
    types.BotCommand("log_clear", "🗑 Очистить логи"),
]

def admin_chat_ids():
    ids = set()
    for s in lu():
        try:
            if ia(int(s)):
                ids.add(int(s))
        except:
            pass
    for uid, name in TRUSTED_PLAYERS_INT.items():
        if name == TECH or name in PROTECTED:
            ids.add(uid)
    return ids

def update_command_menus():
    try:
        bot.set_my_commands(PUBLIC_COMMANDS)
    except Exception as e:
        print(f"[Menu] public: {e}", flush=True)
    for uid in admin_chat_ids():
        try:
            bot.set_my_commands(ADMIN_COMMANDS, scope=types.BotCommandScopeChat(uid))
        except Exception as e:
            print(f"[Menu] admin {uid}: {e}", flush=True)
    print(f"[Menu] подсказки обновлены: public + {len(admin_chat_ids())} админов", flush=True)

try:
    bot.delete_my_commands()
    bot.set_my_commands([
        types.BotCommand("start", "🚀 Пуск"),
        types.BotCommand("menu", "📱 Меню"),
        types.BotCommand("help", "❓ Помощь"),
        types.BotCommand("status", "🌐 Сервер"),
        types.BotCommand("api", "🖥 API"),
        types.BotCommand("api_reload", "🔄 Перезагрузить туннель"),
        types.BotCommand("past", "📋 Пасты"),
        types.BotCommand("all", "👥 Компьютеры")
    ])
except:
    pass

@bot.message_handler(commands=['api_reload'])
def cmd_api_reload(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start")
        return
    if not ia(m.from_user.id):
        bot.send_message(m.chat.id, "❌ Только администраторы")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    threading.Thread(target=lambda: force_reload_tunnel("manual_telegram"), daemon=True).start()
    bot.send_message(m.chat.id, "🔄 <b>Перезагрузка туннеля...</b>\n\nСтарый убит. Новый URL появится в канале через <b>2-5 секунд</b>.", parse_mode='HTML')

@bot.message_handler(commands=['log'])
def cmd_log(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start")
        return
    if not ia(m.from_user.id):
        bot.send_message(m.chat.id, "❌ Только администраторы")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    status_msg = bot.send_message(m.chat.id, "📄 <b>Собираю логи...</b>", parse_mode='HTML')
    try:
        log_content = get_last_log_lines(max_lines=5000, max_bytes=900_000)
        if not log_content:
            bot.edit_message_text("❌ Лог пустой", m.chat.id, status_msg.message_id)
            return
        log_bytes = log_content.encode('utf-8')
        log_file = io.BytesIO(log_bytes)
        timestamp = datetime.now(MSK).strftime('%Y%m%d_%H%M%S')
        log_file.name = f"bot_log_{timestamp}.log"
        try:
            bot.delete_message(m.chat.id, status_msg.message_id)
        except:
            pass
        caption = (f"📄 <b>Логи бота</b>\n\n"
                   f"📊 <code>{len(log_bytes):,}</code> байт\n"
                   f"⏰ <code>{datetime.now(MSK).strftime('%H:%M:%S')}</code>\n"
                   f"📋 ~<code>{log_content.count(chr(10)):,}</code> строк")
        msg = bot.send_document(m.chat.id, log_file, caption=caption, parse_mode='HTML')
        state = gs(m.from_user.id) or {}
        state['last_file_msg_id'] = msg.message_id
        state['last_file_chat_id'] = m.chat.id
        sets(m.from_user.id, state)
    except Exception as e:
        try:
            bot.edit_message_text(f"❌ Ошибка:\n<code>{safe(str(e)[:200])}</code>",
                                  m.chat.id, status_msg.message_id, parse_mode='HTML')
        except:
            bot.send_message(m.chat.id, f"❌ Ошибка:\n<code>{safe(str(e)[:200])}</code>", parse_mode='HTML')

@bot.message_handler(commands=['log_clear'])
def cmd_log_clear(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start")
        return
    if not ia(m.from_user.id):
        bot.send_message(m.chat.id, "❌ Только администраторы")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    try:
        size_before = RUNTIME_LOG.stat().st_size if RUNTIME_LOG.exists() else 0
        clear_log()
        size_after = RUNTIME_LOG.stat().st_size if RUNTIME_LOG.exists() else 0
        bot.send_message(m.chat.id,
                         f"✅ <b>Лог очищен</b>\n\nБыло: <code>{size_before:,}</code> байт\nСтало: <code>{size_after:,}</code> байт",
                         parse_mode='HTML')
    except Exception as e:
        bot.send_message(m.chat.id, f"❌ Ошибка:\n<code>{safe(str(e)[:200])}</code>", parse_mode='HTML')

@bot.message_handler(commands=['start'])
def cmd_start(m):
    u = m.from_user.id
    auto_register_trusted(u)
    unregister_status_messages(m.chat.id)
    if not reg(u):
        un = m.from_user.username or ("id_" + str(u))
        sets(u, {'step': 'wp', 'username': un, 'is_bot': m.from_user.is_bot})
        bot.send_message(m.chat.id,
                         f"{ui_header('Добро пожаловать', '👋')}\n\n"
                         f"👤 <b>{safe(un)}</b>\n\n🔐 Введите пароль:",
                         parse_mode='HTML')
    else:
        r = role(u)
        rt_ = {"tech": "🛠 Тех.админ", "admin": "👑 Админ", "bot": "🤖 Компьютер"}.get(r, "👤 Пользователь")
        bot.send_message(m.chat.id,
                         f"{ui_header('С возвращением', '🚀')}\n\n"
                         f"👤 <b>{safe(dn(u))}</b>\n{ui_row('Роль', rt_)}\n\n📱 /menu",
                         parse_mode='HTML', reply_markup=main_menu_keyboard(u))

@bot.message_handler(commands=['menu'])
def cmd_menu(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start first")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    us = lu()
    bc = sum(1 for u in us.values() if u.get('is_bot'))
    bot.send_message(m.chat.id,
                     f"{ui_header('Главное меню', '📱')}\n\n"
                     f"<b>📊 Статистика:</b>\n"
                     f"{ui_row('🤖 Компьютеры', bc)}\n"
                     f"{ui_row('👤 Пользователи', len(us) - bc)}\n"
                     f"{ui_row('📄 Пасты', len(lp()))}\n\nВыберите раздел:",
                     parse_mode='HTML', reply_markup=main_menu_keyboard(m.from_user.id))

@bot.message_handler(commands=['help'])
def cmd_help(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start first")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
    bot.send_message(m.chat.id, build_help_text(), parse_mode='HTML', reply_markup=kb)

@bot.message_handler(commands=['api'])
def cmd_api(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start")
        return
    if not ia(m.from_user.id):
        bot.send_message(m.chat.id, "❌ Только администраторы")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    update_url_from_log()
    try:
        check_tunnel_health()
    except:
        pass
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Проверить", callback_data="check_tunnel"))
    kb.add(types.InlineKeyboardButton("🔄 Перезагрузить туннель", callback_data="reload_tunnel"))
    kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
    bot.send_message(m.chat.id, build_api_text(), parse_mode='HTML', reply_markup=kb)

@bot.message_handler(commands=['status'])
def cmd_status(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start")
        return
    if not ia(m.from_user.id):
        bot.send_message(m.chat.id, "❌ Только администраторы")
        return
    delete_last_file(m.from_user.id)
    txt = build_status_text()
    if not txt:
        bot.send_message(m.chat.id, "❌ Не удалось получить статус")
        return
    msg = bot.send_message(m.chat.id, txt, parse_mode='HTML', reply_markup=status_keyboard())
    register_status_message(m.chat.id, msg.message_id)

@bot.message_handler(commands=['past'])
def cmd_past(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    pa = m.text.split()[1:]
    if not pa:
        spm(m.chat.id, 0)
        return
    s = pa[0].lower()
    if s == 'add':
        if len(pa) == 2:
            n = tr(pa[1], MAX_PN).lower()
            if any(p['name'].lower() == n for p in lp()):
                bot.send_message(m.chat.id, f"⚠️ Паст <code>{safe(n)}</code> уже существует", parse_mode='HTML')
                return
            sets(m.from_user.id, {'step': 'add_file_wait', 'paste_name': n, 'past_menu': True})
            bot.send_message(m.chat.id,
                             f"📄 <b>Создание паста:</b> <code>{safe(n)}</code>\n\n"
                             f"Отправьте <b>текст</b> или <b>файл</b>\nИли /cancel",
                             parse_mode='HTML')
        elif len(pa) >= 3:
            n = tr(pa[1], MAX_PN).lower()
            c = ' '.join(pa[2:])
            if not c:
                bot.send_message(m.chat.id, "❌ Пустой текст")
                return
            if any(p['name'].lower() == n for p in lp()):
                bot.send_message(m.chat.id, f"⚠️ <code>{safe(n)}</code> уже есть", parse_mode='HTML')
                return
            e = enc(c)
            if not e:
                bot.send_message(m.chat.id, "❌ Ошибка шифрования")
                return
            ps = lp()
            ps.append({
                'name': n, 'content': e, 'hash': chash(c),
                'cid': m.from_user.id, 'cn': dn(m.from_user.id),
                'created_at': datetime.now(MSK).isoformat()
            })
            sp(ps)
            bot.send_message(m.chat.id,
                             f"{ui_header('Паст создан', '✅')}\n\n"
                             f"{ui_row('Имя', n)}\n{ui_row('Размер', f'{len(c)} байт')}",
                             parse_mode='HTML')
        else:
            bot.send_message(m.chat.id, "❓ <code>/past add name [text]</code>", parse_mode='HTML')
    elif s == 'edit':
        if len(pa) < 2:
            bot.send_message(m.chat.id, "❓ /past edit N_or_name")
            return
        idx, paste = find_paste_by_arg(pa[1], lp())
        if idx is None:
            bot.send_message(m.chat.id, f"❌ Паст не найден: {safe(pa[1])}")
            return
        if paste.get('cid') != m.from_user.id and not ia(m.from_user.id):
            bot.send_message(m.chat.id, "❌ Нет прав")
            return
        c = dec(paste['content'])
        if not c:
            bot.send_message(m.chat.id, "❌ Ошибка дешифрования")
            return
        sets(m.from_user.id, {'step': 'edit_file_wait', 'idx': idx, 'past_menu': True})
        bot.send_message(m.chat.id,
                         f"{ui_header('Редактирование', '📝')}\n\n"
                         f"<b>📄 {safe(paste['name'])}</b>\n{ui_divider()}\n"
                         f"<pre>{safe(c[:500])}</pre>\n\n"
                         f"✏️ Отправьте <b>текст</b> или <b>файл</b>\nИли /cancel",
                         parse_mode='HTML')
    elif s == 'delete':
        if len(pa) < 2:
            bot.send_message(m.chat.id, "❓ /past delete N_or_name")
            return
        idx, paste = find_paste_by_arg(pa[1], lp())
        if idx is None:
            bot.send_message(m.chat.id, f"❌ Паст не найден: {safe(pa[1])}")
            return
        if paste.get('cid') != m.from_user.id and not ia(m.from_user.id):
            bot.send_message(m.chat.id, "❌ Нет прав")
            return
        sets(m.from_user.id, {'step': 'dc', 'idx': idx})
        bot.send_message(m.chat.id,
                         f"⚠️ <b>Удалить?</b>\n{ui_divider()}\n📄 <code>{safe(paste['name'])}</code>",
                         parse_mode='HTML', reply_markup=confirm_keyboard(f"del_paste:{idx}"))

def spm(cid, pg, msg_to_edit=None):
    ps = lp()
    if not ps:
        txt = f"{ui_header('Пасты', '📋')}\n\n<i>📭 Пусто</i>\n\n<code>/past add name text</code>"
        if msg_to_edit:
            edit_or_send(msg_to_edit, txt, back_to_menu_keyboard())
        else:
            bot.send_message(cid, txt, parse_mode='HTML', reply_markup=back_to_menu_keyboard())
        return
    kb, pg, tp = bpk(ps, pg)
    txt = (f"{ui_header('Пасты', '📋')}\n\n"
           f"{ui_row('Всего', len(ps))}\n"
           f"{ui_row('Страница', f'{pg+1}/{tp}')}\n\n"
           f"<i>Нажмите для просмотра</i>")
    if msg_to_edit:
        edit_or_send(msg_to_edit, txt, kb)
    else:
        bot.send_message(cid, txt, parse_mode='HTML', reply_markup=kb)

@bot.message_handler(commands=['all'])
def cmd_all(m):
    if not reg(m.from_user.id):
        bot.send_message(m.chat.id, "/start")
        return
    delete_last_file(m.from_user.id)
    unregister_status_messages(m.chat.id)
    us = lu()
    my = us.get(str(m.from_user.id))
    if not my or my.get('is_bot') or not my.get('name'):
        bot.send_message(m.chat.id, "⚠️ Только для пользователей")
        return
    pa = m.text.split()[1:]
    if not pa:
        sam(m.chat.id, 0)
        return
    s = pa[0].lower()
    if s == 'assign':
        if not ia(m.from_user.id):
            bot.send_message(m.chat.id, "❌ Только администраторы")
            return
        if len(pa) < 3:
            bot.send_message(m.chat.id, "❓ <code>/all assign COMP paste</code>", parse_mode='HTML')
            return
        tid, td = find_user_by_arg(pa[1], list(us.items()))
        if tid is None:
            bot.send_message(m.chat.id, f"❌ Не найден: {safe(pa[1])}")
            return
        if not td.get('is_bot'):
            bot.send_message(m.chat.id, "❌ Не компьютер")
            return
        pn = pa[2].lower()
        if not any(p['name'].lower() == pn for p in lp()):
            bot.send_message(m.chat.id, f"❌ Паст <code>{safe(pn)}</code> не найден", parse_mode='HTML')
            return
        cp_ = td.get('assigned_pastes', [])
        if pn in cp_:
            bot.send_message(m.chat.id, f"⚠️ {safe(pn)} уже привязан")
            return
        cp_.append(pn)
        us[tid]['assigned_pastes'] = cp_
        su(us)
        bot.send_message(m.chat.id,
                         f"{ui_header('Привязан', '✅')}\n\n"
                         f"{ui_row('🤖 Компьютер', td.get('name', ''))}\n"
                         f"{ui_row('📄 Паст', pn)}",
                         parse_mode='HTML')
    elif s == 'unassign':
        if not ia(m.from_user.id):
            bot.send_message(m.chat.id, "❌ Только администраторы")
            return
        if len(pa) < 2:
            bot.send_message(m.chat.id, "❓ /all unassign COMP")
            return
        tid, td = find_user_by_arg(pa[1], list(us.items()))
        if tid is None:
            bot.send_message(m.chat.id, f"❌ Не найден: {safe(pa[1])}")
            return
        if not td.get('is_bot'):
            bot.send_message(m.chat.id, "❌ Не компьютер")
            return
        rc = len(td.get('assigned_pastes', []))
        us[tid]['assigned_pastes'] = []
        su(us)
        bot.send_message(m.chat.id,
                         f"{ui_header('Отвязано', '✅')}\n\n{ui_row('🗑 Удалено', rc)}",
                         parse_mode='HTML')
    elif s == 'perform':
        if not ia(m.from_user.id):
            bot.send_message(m.chat.id, "❌ Только администраторы")
            return
        if len(pa) < 3:
            bot.send_message(m.chat.id, "❓ <code>/all perform COMP PASTE</code>", parse_mode='HTML')
            return
        tid, td = find_user_by_arg(pa[1], list(us.items()))
        if tid is None:
            bot.send_message(m.chat.id, f"❌ Комп не найден: {safe(pa[1])}")
            return
        if not td.get('is_bot'):
            bot.send_message(m.chat.id, "❌ Не компьютер")
            return
        pi, paste = find_paste_by_arg(pa[2], lp())
        if pi is None:
            bot.send_message(m.chat.id, f"❌ Паст не найден: {safe(pa[2])}")
            return
        cp_ = td.get('assigned_pastes', [])
        act = "Уже привязан" if paste['name'] in cp_ else "Добавлен и запущен"
        if paste['name'] not in cp_:
            cp_.append(paste['name'])
            us[tid]['assigned_pastes'] = cp_
            su(us)
        bot.send_message(m.chat.id,
                         f"{ui_header('Выполнено', '✅')}\n\n"
                         f"{ui_row('🤖 Компьютер', td.get('name', ''))}\n"
                         f"{ui_row('📄 Паст', paste['name'])}\n"
                         f"{ui_row('📊 Действие', act)}",
                         parse_mode='HTML')
    elif s == 'kick':
        if not ia(m.from_user.id):
            bot.send_message(m.chat.id, "❌ Только администраторы")
            return
        if len(pa) < 2:
            bot.send_message(m.chat.id, "❓ /all kick COMP")
            return
        tid, td = find_user_by_arg(pa[1], list(us.items()))
        if tid is None:
            bot.send_message(m.chat.id, f"❌ Не найдено: {safe(pa[1])}")
            return
        tn = td.get('name') or tid
        if not td.get('is_bot') and (tn in PROTECTED or tn == TECH):
            bot.send_message(m.chat.id, "🛡 Защищённый")
            return
        if str(m.from_user.id) == tid:
            bot.send_message(m.chat.id, "❌ Нельзя себя")
            return
        bot.send_message(m.chat.id,
                         f"⚠️ <b>Кикнуть?</b>\n{ui_divider()}\n🤖 <code>{safe(tn)}</code>",
                         parse_mode='HTML', reply_markup=confirm_keyboard(f"kick:{tid}"))
    elif s == 'kiktime':
        if not ia(m.from_user.id):
            bot.send_message(m.chat.id, "❌ Только администраторы")
            return
        if len(pa) < 2:
            try:
                with open(CFG, 'r', encoding='utf-8') as f:
                    gm = json.load(f).get('kiktime_minutes', 10)
            except:
                gm = 10
            bot.send_message(m.chat.id,
                             f"🌍 Глобальный лимит: {gm} мин\n\n/all kiktime N — изменить",
                             parse_mode='HTML')
            return
        try:
            nm = int(pa[1])
        except:
            bot.send_message(m.chat.id, "❌ N должно быть числом")
            return
        if nm < 1 or nm > 1440:
            bot.send_message(m.chat.id, "❌ N: 1-1440 минут")
            return
        if len(pa) >= 3:
            tid, td = find_user_by_arg(pa[2], list(us.items()))
            if tid is None:
                bot.send_message(m.chat.id, f"❌ Компьютер не найден: {safe(pa[2])}")
                return
            if not td.get('is_bot'):
                bot.send_message(m.chat.id, "❌ Не компьютер")
                return
            us[tid]['kiktime_override'] = nm
            su(us)
            bot.send_message(m.chat.id,
                             f"{ui_header('Индивидуальный лимит', '✅')}\n\n"
                             f"{ui_row('⏱ Лимит', f'{nm} мин')}",
                             parse_mode='HTML')
        else:
            try:
                with open(CFG, 'r', encoding='utf-8') as f:
                    c = json.load(f)
                c['kiktime_minutes'] = nm
                with open(CFG, 'w', encoding='utf-8') as f:
                    json.dump(c, f, indent=2, ensure_ascii=False)
                bot.send_message(m.chat.id,
                                 f"{ui_header('Глобальный лимит', '✅')}\n\n"
                                 f"{ui_row('Новое значение', f'{nm} мин')}",
                                 parse_mode='HTML')
            except Exception as e:
                bot.send_message(m.chat.id, f"❌ Ошибка: {safe(e)}")

def sam(cid, pg, msg_to_edit=None):
    us = lu()
    if not us:
        txt = f"{ui_header('Компьютеры', '👥')}\n\n<i>📭 Пусто</i>"
        if msg_to_edit:
            edit_or_send(msg_to_edit, txt, back_to_menu_keyboard())
        else:
            bot.send_message(cid, txt, parse_mode='HTML', reply_markup=back_to_menu_keyboard())
        return
    kb, pg, tp = buk(us, pg)
    bc = sum(1 for u in us.values() if u.get('is_bot'))
    txt = (f"{ui_header('Компьютеры', '👥')}\n\n"
           f"{ui_row('🤖 Компьютеры', bc)}\n"
           f"{ui_row('👤 Пользователи', len(us) - bc)}\n"
           f"{ui_row('📄 Страница', f'{pg+1}/{tp}')}\n\n"
           f"<i>Нажмите для деталей</i>")
    if msg_to_edit:
        edit_or_send(msg_to_edit, txt, kb)
    else:
        bot.send_message(cid, txt, parse_mode='HTML', reply_markup=kb)

def san(pid, n, cid):
    pe = lpend()
    if pid not in pe:
        return
    pe[pid]['msgs'] = {}
    pe[pid]['cid'] = cid
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("✅ Принять", callback_data="aa:" + pid),
           types.InlineKeyboardButton("❌ Отклонить", callback_data="ad:" + pid))
    txt = (f"{ui_header('Запрос авторизации', '🔐')}\n\n"
           f"{ui_row('🖥 Имя', n)}\n{ui_row('🆔 ID', cid)}\n\n<b>Принять?</b>")
    for a in aia():
        try:
            msg = bot.send_message(a, txt, parse_mode='HTML', reply_markup=kb)
            pe[pid]['msgs'][str(a)] = msg.message_id
        except:
            pass
    spend(pe)

def uan(pid, by, act):
    pe = lpend()
    if pid not in pe:
        return
    ic = "✅" if act == 'approved' else "❌"
    txt = (f"{ic} <b>{'ПРИНЯТ' if act == 'approved' else 'ОТКЛОНЁН'}</b>\n"
           f"{ui_divider()}\n🖥 <b>{safe(pe[pid].get('name', '?'))}</b>\n👤 {safe(by)}")
    for a, mid in pe[pid].get('msgs', {}).items():
        try:
            bot.edit_message_text(txt, int(a), mid, parse_mode='HTML')
        except:
            pass

# ============================================
# FILES
# ============================================
@bot.message_handler(content_types=['document'])
def handle_document(m):
    if not reg(m.from_user.id):
        return
    state = gs(m.from_user.id)
    if not state:
        return
    step = state.get('step')
    if step not in ['add_file_wait', 'edit_file_wait']:
        return
    doc = m.document
    if doc.file_size > MAX_CONTENT_LENGTH:
        bot.send_message(m.chat.id, f"❌ Файл слишком большой (макс {MAX_CONTENT_LENGTH//1024//1024}MB)")
        return
    try:
        fi = bot.get_file(doc.file_id)
        content = bot.download_file(fi.file_path).decode('utf-8', errors='ignore')
    except Exception as e:
        bot.send_message(m.chat.id, f"❌ Ошибка чтения: {safe(e)}")
        return
    if not content.strip():
        bot.send_message(m.chat.id, "❌ Файл пустой")
        return
    if step == 'add_file_wait':
        name = state.get('paste_name')
        if not name:
            cs(m.from_user.id)
            return
        if any(p['name'].lower() == name for p in lp()):
            cs(m.from_user.id)
            bot.send_message(m.chat.id, f"⚠️ Паст <code>{safe(name)}</code> уже существует")
            return
        e = enc(content)
        if not e:
            bot.send_message(m.chat.id, "❌ Ошибка шифрования")
            return
        ps = lp()
        ps.append({
            'name': name, 'content': e, 'hash': chash(content),
            'cid': m.from_user.id, 'cn': dn(m.from_user.id),
            'created_at': datetime.now(MSK).isoformat()
        })
        sp(ps)
        cs(m.from_user.id)
        bot.send_message(m.chat.id,
                         f"{ui_header('Паст создан из файла', '✅')}\n\n"
                         f"{ui_row('Имя', name)}\n"
                         f"{ui_row('Размер', f'{len(content)} байт')}",
                         parse_mode='HTML')
    elif step == 'edit_file_wait':
        idx = state.get('idx')
        ps = lp()
        if idx is None or idx < 0 or idx >= len(ps):
            cs(m.from_user.id)
            bot.send_message(m.chat.id, "❌ Паст не найден")
            return
        if ps[idx].get('cid') != m.from_user.id and not ia(m.from_user.id):
            cs(m.from_user.id)
            bot.send_message(m.chat.id, "❌ Нет прав")
            return
        e = enc(content)
        if not e:
            bot.send_message(m.chat.id, "❌ Ошибка шифрования")
            return
        ps[idx]['content'] = e
        ps[idx]['hash'] = chash(content)
        ps[idx]['edited_at'] = datetime.now(MSK).isoformat()
        sp(ps)
        cs(m.from_user.id)
        bot.send_message(m.chat.id,
                         f"{ui_header('Паст обновлён из файла', '✅')}\n\n"
                         f"{ui_row('Имя', ps[idx]['name'])}",
                         parse_mode='HTML')

# ============================================
# CALLBACK
# ============================================
@bot.callback_query_handler(func=lambda c: True)
def cb(c):
    try:
        if not c.message:
            bot.answer_callback_query(c.id)
            return
        d = c.data
        if d == "stop_auto_refresh":
            unregister_status_messages(c.message.chat.id)
            bot.answer_callback_query(c.id, "⏸ Авто-обновление остановлено")
            try:
                kb = types.InlineKeyboardMarkup()
                kb.add(types.InlineKeyboardButton("🔄 Обновить вручную", callback_data="refresh:status"))
                kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
                bot.edit_message_reply_markup(c.message.chat.id, c.message.message_id, reply_markup=kb)
            except:
                pass
            return
        if d == "check_tunnel":
            bot.answer_callback_query(c.id, "🔄 Проверяю...")
            update_url_from_log()
            try:
                check_tunnel_health()
            except:
                pass
            kb = types.InlineKeyboardMarkup(row_width=2)
            kb.add(types.InlineKeyboardButton("🔄 Проверить", callback_data="check_tunnel"))
            kb.add(types.InlineKeyboardButton("🔄 Перезагрузить туннель", callback_data="reload_tunnel"))
            kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
            edit_or_send(c, build_api_text(), kb)
            return
        if d == "reload_tunnel":
            if not ia(c.from_user.id):
                bot.answer_callback_query(c.id, "❌ Только администраторы")
                return
            bot.answer_callback_query(c.id, "🔄 Перезагрузка туннеля...")
            threading.Thread(target=lambda: force_reload_tunnel("manual_button"), daemon=True).start()
            try:
                bot.send_message(c.message.chat.id,
                                 "🔄 <b>Перезагрузка туннеля...</b>\n\n"
                                 "Старый убит. Новый URL появится в канале через <b>2-5 секунд</b>.",
                                 parse_mode='HTML')
            except:
                pass
            return
        if d == "toggle_vanish":
            if not ia(c.from_user.id):
                bot.answer_callback_query(c.id, "❌ Только администраторы")
                return
            users = lu()
            uid = str(c.from_user.id)
            if uid not in users:
                bot.answer_callback_query(c.id, "❌ Не найден")
                return
            cur = users[uid].get('vanish_tracking', False)
            users[uid]['vanish_tracking'] = not cur
            su(users)
            bot.answer_callback_query(c.id, f"🕵️ Слежение: {'ВКЛ' if not cur else 'ВЫКЛ'}")
            us = lu()
            bc = sum(1 for u in us.values() if u.get('is_bot'))
            txt = (f"{ui_header('Главное меню', '📱')}\n\n"
                   f"<b>📊 Статистика:</b>\n"
                   f"{ui_row('🤖 Компьютеры', bc)}\n"
                   f"{ui_row('👤 Пользователи', len(us) - bc)}\n"
                   f"{ui_row('📄 Пасты', len(lp()))}\n\nВыберите раздел:")
            try:
                bot.edit_message_text(txt, c.message.chat.id, c.message.message_id,
                                      parse_mode='HTML', reply_markup=main_menu_keyboard(c.from_user.id))
            except:
                pass
            return
        if d.startswith("menu:"):
            sec = d.split(":")[1]
            if sec in ["main", "all", "api", "help", "past"]:
                delete_last_file(c.from_user.id)
                unregister_status_messages(c.message.chat.id)
            if sec == "main":
                us = lu()
                bc = sum(1 for u in us.values() if u.get('is_bot'))
                edit_or_send(c,
                             f"{ui_header('Главное меню', '📱')}\n\n"
                             f"<b>📊 Статистика:</b>\n"
                             f"{ui_row('🤖 Компьютеры', bc)}\n"
                             f"{ui_row('👤 Пользователи', len(us) - bc)}\n"
                             f"{ui_row('📄 Пасты', len(lp()))}\n\nВыберите раздел:",
                             main_menu_keyboard(c.from_user.id))
            elif sec == "past":
                spm(c.message.chat.id, 0, msg_to_edit=c)
            elif sec == "all":
                sam(c.message.chat.id, 0, msg_to_edit=c)
            elif sec == "status":
                txt = build_status_text()
                if txt:
                    try:
                        bot.edit_message_text(txt, c.message.chat.id, c.message.message_id,
                                              parse_mode='HTML', reply_markup=status_keyboard())
                        register_status_message(c.message.chat.id, c.message.message_id)
                    except:
                        pass
                else:
                    bot.answer_callback_query(c.id, "❌ Ошибка")
            elif sec == "api":
                update_url_from_log()
                try:
                    check_tunnel_health()
                except:
                    pass
                kb = types.InlineKeyboardMarkup(row_width=2)
                kb.add(types.InlineKeyboardButton("🔄 Проверить", callback_data="check_tunnel"))
                kb.add(types.InlineKeyboardButton("🔄 Перезагрузить туннель", callback_data="reload_tunnel"))
                kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
                edit_or_send(c, build_api_text(), kb)
            elif sec == "help":
                kb = types.InlineKeyboardMarkup()
                kb.add(types.InlineKeyboardButton("🔙 Главное меню", callback_data="menu:main"))
                edit_or_send(c, build_help_text(), kb)
            bot.answer_callback_query(c.id)
            return
        if d == "refresh:status":
            bot.answer_callback_query(c.id, "🔄 Обновление...")
            txt = build_status_text()
            if txt:
                try:
                    bot.edit_message_text(txt, c.message.chat.id, c.message.message_id,
                                          parse_mode='HTML', reply_markup=status_keyboard())
                    register_status_message(c.message.chat.id, c.message.message_id)
                except:
                    pass
            return
        if d == "noop":
            bot.answer_callback_query(c.id)
            return
        if d.startswith("confirm:"):
            parts = d.split(":")
            ans = parts[-1]
            aid = ":".join(parts[1:-1])
            if ans == "no":
                cs(c.from_user.id)
                if aid.startswith("del_paste:"):
                    delete_last_file(c.from_user.id)
                    show_paste_profile(c, int(aid.split(":")[1]))
                else:
                    try:
                        bot.edit_message_text("❌ Отменено", c.message.chat.id, c.message.message_id)
                    except:
                        pass
                bot.answer_callback_query(c.id, "❌ Отменено")
                return
            if aid.startswith("del_paste:"):
                idx = int(aid.split(":")[1])
                ps = lp()
                if 0 <= idx < len(ps):
                    rm = ps.pop(idx)
                    sp(ps)
                    cs(c.from_user.id)
                    delete_last_file(c.from_user.id)
                    try:
                        bot.edit_message_text(f"✅ <b>Удалён:</b> <code>{safe(rm['name'])}</code>",
                                              c.message.chat.id, c.message.message_id, parse_mode='HTML')
                    except:
                        pass
                bot.answer_callback_query(c.id, "✅ Удалён")
                return
            elif aid.startswith("kick:"):
                tid = aid.split(":")[1]
                us = lu()
                if tid in us:
                    td = us[tid]
                    tn = td.get('name') or tid
                    if td.get('is_bot') and td.get('api_token'):
                        rt(td['api_token'], "Kicked by " + dn(c.from_user.id))
                    del us[tid]
                    su(us)
                    cs(c.from_user.id)
                    try:
                        bot.edit_message_text(f"🚫 <b>Кикнут:</b> {safe(tn)}",
                                              c.message.chat.id, c.message.message_id, parse_mode='HTML')
                    except:
                        pass
                bot.answer_callback_query(c.id, "🚫 Кикнут")
                return
        if d.startswith("aa:"):
            pid = d.split(":")[1]
            p = lpend()
            if pid not in p or p[pid].get('status') != 'pending':
                bot.answer_callback_query(c.id, "⚠️")
                return
            by = dn(c.from_user.id)
            tok = p[pid]['token']
            nm = p[pid]['name']
            cid = p[pid].get('cid', '?')
            ts = lt()
            ts[tok] = {
                'name': nm, 'computer_id': cid,
                'created_at': datetime.now(MSK).isoformat(),
                'approved_by': c.from_user.id,
                'is_computer': True, 'pending_id': pid
            }
            st(ts)
            us = lu()
            us[pid] = {
                'name': nm, 'computer_id': cid, 'username': "pc_" + pid[:8],
                'is_bot': True, 'is_admin': False, 'mode': 'normal',
                'assigned_pastes': [], 'registered_at': datetime.now(MSK).isoformat(),
                'api_token': tok, 'heartbeat_interval': 30
            }
            su(us)
            p[pid]['status'] = 'approved'
            p[pid]['decided_by'] = c.from_user.id
            p[pid]['decided_at'] = datetime.now(MSK).isoformat()
            spend(p)
            uan(pid, by, 'approved')
            bot.answer_callback_query(c.id, "✅ Принят: " + nm)
            return
        if d.startswith("ad:"):
            pid = d.split(":")[1]
            p = lpend()
            if pid not in p or p[pid].get('status') != 'pending':
                bot.answer_callback_query(c.id, "⚠️")
                return
            p[pid]['status'] = 'denied'
            p[pid]['decided_by'] = c.from_user.id
            spend(p)
            uan(pid, dn(c.from_user.id), 'denied')
            bot.answer_callback_query(c.id, "❌ Отклонён")
            return
        if d.startswith("mode_toggle:"):
            uk = d.split(":")[1]
            if not ia(c.from_user.id):
                bot.answer_callback_query(c.id, "❌ Только администраторы")
                return
            us = lu()
            if uk not in us or not us[uk].get('is_bot'):
                bot.answer_callback_query(c.id, "❌ Не компьютер")
                return
            cm = us[uk].get('mode', 'normal')
            nm = 'normal' if cm == 'service' else 'service'
            us[uk]['mode'] = nm
            su(us)
            bot.answer_callback_query(c.id, f"🔄 Режим: {'Обычный' if nm == 'normal' else 'Сервисный'}")
            sbp(c.message.chat.id, c.message.message_id, uk)
            return
        if d.startswith("kt_set:"):
            uk = d.split(":")[1]
            if not ia(c.from_user.id):
                bot.answer_callback_query(c.id, "❌ Только администраторы")
                return
            sets(c.from_user.id, {'step': 'kt_set_wait', 'target': uk})
            u = lu().get(uk, {})
            try:
                bot.edit_message_text(
                    f"⏱ <b>Установить лимит</b>\n{ui_divider()}\n"
                    f"🤖 <code>{safe(u.get('name', '?'))}</code>\n\nВведите минуты (1-1440):",
                    c.message.chat.id, c.message.message_id, parse_mode='HTML')
            except:
                pass
            bot.answer_callback_query(c.id, "⏱ Введите минуты")
            return
        if d.startswith("kt_reset:"):
            uk = d.split(":")[1]
            if not ia(c.from_user.id):
                bot.answer_callback_query(c.id, "❌ Только администраторы")
                return
            us = lu()
            if uk in us and 'kiktime_override' in us[uk]:
                del us[uk]['kiktime_override']
                su(us)
                bot.answer_callback_query(c.id, "✅ Лимит сброшен")
                sbp(c.message.chat.id, c.message.message_id, uk)
            else:
                bot.answer_callback_query(c.id, "⚠️ Не установлен")
            return
        if d.startswith("hb_menu:"):
            uk = d.split(":")[1]
            if not ia(c.from_user.id):
                return
            bot.edit_message_reply_markup(c.message.chat.id, c.message.message_id, reply_markup=hb_keyboard(uk))
            bot.answer_callback_query(c.id)
            return
        if d.startswith("hb_set:"):
            parts = d.split(":")
            uk = parts[1]
            sec = validate_hb_interval(parts[2])
            if not ia(c.from_user.id):
                return
            us = lu()
            if uk in us:
                us[uk]['heartbeat_interval'] = sec
                su(us)
            bot.answer_callback_query(c.id, f"💓 {hb_category(sec)}")
            sbp(c.message.chat.id, c.message.message_id, uk)
            return
        if d.startswith("hb_custom:"):
            uk = d.split(":")[1]
            if not ia(c.from_user.id):
                return
            sets(c.from_user.id, {'step': 'hb_wait', 'target': uk})
            bot.answer_callback_query(c.id, "⏱ Введите секунды")
            return
        if d.startswith("pp:"):
            delete_last_file(c.from_user.id)
            spm(c.message.chat.id, int(d.split(":")[1]), msg_to_edit=c)
            bot.answer_callback_query(c.id)
            return
        if d.startswith("ap:"):
            sam(c.message.chat.id, int(d.split(":")[1]), msg_to_edit=c)
            bot.answer_callback_query(c.id)
            return
        if d.startswith("pv:"):
            show_paste_profile(c, int(d.split(":")[1]))
            bot.answer_callback_query(c.id)
            return
        if d.startswith("paste_del:"):
            idx = int(d.split(":")[1])
            ps = lp()
            if idx < 0 or idx >= len(ps):
                bot.answer_callback_query(c.id, "❌ Не найден")
                return
            try:
                bot.edit_message_text(
                    f"⚠️ <b>Удалить паст?</b>\n{ui_divider()}\n📄 <code>{safe(ps[idx]['name'])}</code>",
                    c.message.chat.id, c.message.message_id, parse_mode='HTML',
                    reply_markup=confirm_keyboard(f"del_paste:{idx}"))
            except:
                pass
            bot.answer_callback_query(c.id, "⚠️ Подтвердите")
            return
        if d.startswith("av:"):
            sbp(c.message.chat.id, c.message.message_id, d.split(":")[2])
            bot.answer_callback_query(c.id)
            return
        if d.startswith("av_back:"):
            uk = d.split(":")[1]
            sbp(c.message.chat.id, c.message.message_id, uk)
            bot.answer_callback_query(c.id)
            return
        if d.startswith("kick_bot:"):
            uk = d.split(":")[1]
            if not ia(c.from_user.id):
                bot.answer_callback_query(c.id, "❌ Только администраторы")
                return
            u = lu().get(uk)
            if not u:
                bot.answer_callback_query(c.id, "❌ Не найден")
                return
            try:
                bot.edit_message_text(
                    f"⚠️ <b>Кикнуть?</b>\n{ui_divider()}\n🤖 <code>{safe(u.get('name', '?'))}</code>",
                    c.message.chat.id, c.message.message_id, parse_mode='HTML',
                    reply_markup=confirm_keyboard(f"kick:{uk}"))
            except:
                pass
            bot.answer_callback_query(c.id, "⚠️ Подтвердите")
            return
        bot.answer_callback_query(c.id)
    except Exception as e:
        print(f"[CB] err: {e}", flush=True)
        try:
            bot.answer_callback_query(c.id)
        except:
            pass

def sbp(cid, mid, uk):
    us = lu()
    if uk not in us:
        bot.send_message(cid, "❌ Не найден")
        return
    u = us[uk]
    if not u.get('is_bot'):
        txt = (f"{ui_header(u.get('name') or uk, '👑' if u.get('is_admin') else '👤')}\n\n"
               f"{ui_row('🆔 UID', uk)}\n{ui_row('👤 Роль', role(uk))}")
        kb = types.InlineKeyboardMarkup()
        kb.add(types.InlineKeyboardButton("🔙 Назад", callback_data="menu:all"))
        try:
            bot.edit_message_text(txt, cid, mid, parse_mode='HTML', reply_markup=kb)
        except:
            bot.send_message(cid, txt, parse_mode='HTML', reply_markup=kb)
        return
    at = u.get('api_token', '?')
    hb_data = lhb()
    ci = u.get('computer_id')
    ht = "❓ Никогда"
    if ci in hb_data:
        try:
            lm = int((datetime.now(MSK) - datetime.fromisoformat(hb_data[ci]['last_seen'])).total_seconds() / 60)
            ht = "🟢 Только что" if lm < 1 else (f"🟢 {lm} мин" if lm < 10 else f"🔴 {lm} мин")
        except:
            pass
    kt = f"{u['kiktime_override']} мин (перс.)" if u.get('kiktime_override') else "Глобальный"
    ap = u.get('assigned_pastes', [])
    hbi = u.get('heartbeat_interval', 30)
    txt = (f"{ui_header(u.get('name', ''), '🤖')}\n\n"
           f"{ui_row('🆔 CID', ci)}\n"
           f"{ui_row('🆔 UID', uk)}\n"
           f"{ui_row('🔑 Токен', (at[:12] + '...') if len(at) > 12 else at)}\n\n"
           f"{ui_row('🎯 Режим', ui_mode(u.get('mode', 'normal')))}\n"
           f"{ui_row('💓 Пульс', ht)}\n"
           f"{ui_row('💓 Интервал', hb_category(hbi))}\n"
           f"{ui_row('⏱ Лимит', kt)}\n\n")
    if ap:
        txt += f"<b>📋 Скрипты ({len(ap)}):</b>\n"
        for p in ap[:10]:
            txt += f"  • <code>{safe(p)}</code>\n"
    else:
        txt += "<b>📋 Скрипты:</b> <i>не привязаны</i>\n"
    try:
        bot.edit_message_text(txt, cid, mid, parse_mode='HTML', reply_markup=bbpk(uk))
    except:
        bot.send_message(cid, txt, parse_mode='HTML', reply_markup=bbpk(uk))

# ============================================
# TEXT
# ============================================
@bot.message_handler(func=lambda m: True, content_types=['text'])
def hm(m):
    u = m.from_user.id
    auto_register_trusted(u)
    t = m.text.strip()
    s = gs(u)
    if s:
        stp = s.get('step')
        if stp == 'wp':
            ok, count = check_rate_limit(f"pw:{u}")
            if not ok:
                bot.send_message(m.chat.id, f"⏳ Слишком много попыток. Ждите {RATE_LIMIT_WINDOW}с")
                log_failed_login(f"pw:{u}", "rate limit")
                return
            if t == PASSWORD:
                if s.get('is_bot'):
                    us = lu()
                    us[str(u)] = {
                        'name': None, 'username': s.get('username'),
                        'is_bot': True, 'is_admin': False,
                        'registered_at': datetime.now(MSK).isoformat()
                    }
                    su(us)
                    cs(u)
                    bot.send_message(m.chat.id, "✅ <b>Доступ разрешён</b>", parse_mode='HTML')
                else:
                    ns = dict(s)
                    ns['step'] = 'wn'
                    sets(u, ns)
                    bot.send_message(m.chat.id, "✅ <b>Пароль верный</b>\n\n👤 Введите имя:", parse_mode='HTML')
            else:
                bot.send_message(m.chat.id, "❌ <b>Неверный пароль</b>", parse_mode='HTML')
                log_failed_login(f"pw:{u}", "bad password")
            return
        if stp == 'wn':
            n = tr(t, MAX_N)
            us = lu()
            # ИСПРАВЛЕНО v17.22: правильный доступ к .lower()
            if n.lower() in [x.get('name','').lower() for x in us.values() if x.get('name')]:
                bot.send_message(m.chat.id, "⚠️ Имя занято")
                return
            f = len(us) == 0
            aa = f or (n.lower() in [p.lower() for p in PROTECTED])
            us[str(u)] = {
                'name': n, 'username': s.get('username'),
                'is_bot': False, 'is_admin': aa,
                'registered_at': datetime.now(MSK).isoformat()
            }
            su(us)
            cs(u)
            bot.send_message(m.chat.id,
                             f"{ui_header('Добро пожаловать', '🎉')}\n\n"
                             f"👤 <b>{safe(n)}</b>\n"
                             f"{'👑 <b>Администратор</b>\n' if (f or aa) else ''}"
                             f"📱 /menu",
                             parse_mode='HTML', reply_markup=main_menu_keyboard(u))
            return
        if stp == 'hb_wait':
            sec = validate_hb_interval(t)
            tgt = s.get('target')
            us = lu()
            if tgt in us:
                us[tgt]['heartbeat_interval'] = sec
                su(us)
            cs(u)
            bot.send_message(m.chat.id, f"💓 {hb_category(sec)}")
            return
        if stp == 'add_file_wait':
            if t.lower() in ['/cancel', 'cancel']:
                cs(u)
                bot.send_message(m.chat.id, "❌ Отменено")
                return
            name = s.get('paste_name')
            if not name:
                cs(u)
                return
            if any(p['name'].lower() == name for p in lp()):
                cs(u)
                bot.send_message(m.chat.id, f"⚠️ Паст <code>{safe(name)}</code> уже существует")
                return
            e = enc(t)
            if not e:
                bot.send_message(m.chat.id, "❌ Ошибка шифрования")
                return
            ps = lp()
            ps.append({
                'name': name, 'content': e, 'hash': chash(t),
                'cid': u, 'cn': dn(u), 'created_at': datetime.now(MSK).isoformat()
            })
            sp(ps)
            cs(u)
            bot.send_message(m.chat.id,
                             f"{ui_header('Паст создан', '✅')}\n\n{ui_row('Имя', name)}",
                             parse_mode='HTML')
            return
        if stp == 'edit_file_wait':
            if t.lower() in ['/cancel', 'cancel']:
                cs(u)
                bot.send_message(m.chat.id, "❌ Отменено")
                return
            idx = s.get('idx')
            ps = lp()
            if idx is None or idx < 0 or idx >= len(ps):
                cs(u)
                bot.send_message(m.chat.id, "❌ Паст не найден")
                return
            if ps[idx].get('cid') != u and not ia(u):
                cs(u)
                bot.send_message(m.chat.id, "❌ Нет прав")
                return
            e = enc(t)
            if not e:
                bot.send_message(m.chat.id, "❌ Ошибка шифрования")
                return
            ps[idx]['content'] = e
            ps[idx]['hash'] = chash(t)
            ps[idx]['edited_at'] = datetime.now(MSK).isoformat()
            sp(ps)
            cs(u)
            bot.send_message(m.chat.id,
                             f"{ui_header('Паст обновлён', '✅')}\n\n{ui_row('Имя', ps[idx]['name'])}",
                             parse_mode='HTML')
            return
        if stp == 'dc':
            idx = s.get('idx')
            if t.lower() in ['да', 'yes', 'y']:
                ps = lp()
                if 0 <= idx < len(ps):
                    rm = ps.pop(idx)
                    sp(ps)
                    cs(u)
                    delete_last_file(u)
                    bot.send_message(m.chat.id, f"✅ Удалён: <code>{safe(rm['name'])}</code>", parse_mode='HTML')
            elif t.lower() in ['нет', 'no', 'n', '/cancel', 'cancel']:
                cs(u)
                bot.send_message(m.chat.id, "❌ Отменено")
            return
        if stp == 'kt_set_wait':
            tgt = s.get('target')
            if t.lower() in ['/cancel', 'cancel']:
                cs(u)
                bot.send_message(m.chat.id, "❌ Отменено")
                return
            try:
                nm = int(t)
            except:
                bot.send_message(m.chat.id, "❌ Введите число")
                return
            if nm < 1 or nm > 1440:
                bot.send_message(m.chat.id, "❌ 1-1440 минут")
                return
            us = lu()
            if tgt in us:
                us[tgt]['kiktime_override'] = nm
                su(us)
                cs(u)
                bot.send_message(m.chat.id,
                                 f"{ui_header('Лимит установлен', '✅')}\n\n"
                                 f"{ui_row('⏱ Лимит', f'{nm} мин')}",
                                 parse_mode='HTML')
            else:
                cs(u)
                bot.send_message(m.chat.id, "❌ Не найден")
            return
        return
    if t.startswith('/'):
        cn = t.split()[0][1:].lower().split('@')[0]
        if cn not in KNOWN:
            bot.send_message(m.chat.id, "❓ <b>Неизвестная команда</b>\n\n/help", parse_mode='HTML')
            return
    if not reg(u):
        un = m.from_user.username or ("id_" + str(u))
        sets(u, {'step': 'wp', 'username': un, 'is_bot': m.from_user.is_bot})
        bot.send_message(m.chat.id,
                         f"{ui_header('Авторизация', '👤')}\n\n"
                         f"👋 Привет, <b>{safe(un)}</b>\n\n🔐 Пароль:",
                         parse_mode='HTML')
        return
    bot.send_message(m.chat.id, "💡 <b>Меню</b>\n\n/menu", parse_mode='HTML', reply_markup=main_menu_keyboard(u))

# ============================================
# HTTP API
# ============================================
class TS(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128

class AH(BaseHTTPRequestHandler):
    def log_message(self, f, *a):
        global tunnel_last_activity
        try:
            print(f"[API] {self.client_address[0]} - {f % a}", flush=True)
        except:
            pass
        tunnel_last_activity = time.time()

    def _j(self, c, d):
        try:
            b = json.dumps(d, ensure_ascii=False).encode()
            self.send_response(c)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            if ALLOWED_ORIGINS:
                origin = self.headers.get('Origin', '')
                if origin in ALLOWED_ORIGINS:
                    self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Headers',
                             'Authorization, Content-Type, bypass-tunnel-reminder, X-Computer-ID, X-Server-Key')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Content-Length', str(len(b)))
            self.send_header('Connection', 'close')
            self.end_headers()
            try:
                self.wfile.write(b)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            print(f"[API] err: {e}", flush=True)

    def _b(self):
        l = int(self.headers.get('Content-Length', 0))
        if l > MAX_CONTENT_LENGTH:
            return None
        return self.rfile.read(l).decode() if l > 0 else ""

    def _check_friend_auth(self):
        k = self.headers.get('X-Server-Key', '')
        if not k or k != PASSWORD:
            return False
        cip = self.client_address[0]
        return cip == FRIEND_SERVER_IP

    def _a(self):
        au = self.headers.get('Authorization', '')
        ci = self.headers.get('X-Computer-ID', '')
        if not au.startswith('Bearer '):
            return None, None, False, "no", None
        tok = au[7:].strip()
        ts = lt()
        if tok not in ts:
            return None, None, False, "inv", None
        ti = ts[tok]
        ib = ti.get('is_computer', False)
        if not ib and ti.get('pending_id'):
            us = lu()
            pid = ti.get('pending_id')
            if pid in us and us[pid].get('is_bot'):
                ib = True
        if ib and ci:
            ok, r, sd = vs(tok, ci, self.client_address[0])
            if not ok:
                return tok, ib, False, r, sd
        return tok, ib, True, "ok", ti

    def do_OPTIONS(self):
        try:
            self.send_response(200)
            if ALLOWED_ORIGINS:
                origin = self.headers.get('Origin', '')
                if origin in ALLOWED_ORIGINS:
                    self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Headers',
                             'Authorization, Content-Type, bypass-tunnel-reminder, X-Computer-ID, X-Server-Key')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.end_headers()
        except:
            pass

    def do_GET(self):
        try:
            self._get()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            print(f"[API] GET err: {e}", flush=True)

    def _get(self):
        if not API_EN:
            self._j(503, {"error": "Disabled"})
            return
        tok, ib, v, r, ti = self._a()
        p = self.path.split('?')[0]
        if p == '/api/health':
            try:
                check_tunnel_health()
            except:
                pass
            with tunnel_health_lock:
                h = dict(tunnel_health)
            h.update(bot_status='running', bot_version='17.23',
                     bot_uptime_sec=bot_uptime_sec(),
                     bot_uptime=fmt_duration(bot_uptime_sec()),
                     server_uptime_sec=int(time.time() - server_online_since) if server_online_since else 0,
                     registered_bots=sum(1 for u in lu().values() if u.get('is_bot')),
                     total_pastes=len(lp()))
            self._j(200, h)
            return
        if p == '/api/reload':
            if not tok:
                self._j(401, {"error": "no token"})
                return
            if not v:
                self._j(403, {"error": "invalid token"})
                return
            threading.Thread(target=lambda: force_reload_tunnel("api_request"), daemon=True).start()
            self._j(200, {"ok": True, "message": "Tunnel reload requested"})
            return
        if p == '/api/url':
            update_url_from_log()
            u = tunnel()
            if u:
                self._j(200, {"url": u, "timestamp": datetime.now(MSK).isoformat()})
            else:
                self._j(503, {"error": "no"})
            return
        if p == '/api/relay_url':
            u = get_current_tunnel_url()
            if u:
                self._j(200, {"url": u, "timestamp": datetime.now(MSK).isoformat(),
                              "channel": f"https://t.me/s/{CHANNEL_USERNAME}", "relay": "telegram"})
            else:
                self._j(503, {"error": "no tunnel yet"})
            return
        if p == '/api/check':
            q = self.path.split('?')[1] if '?' in self.path else ''
            pa = dict(x.split('=') for x in q.split('&') if '=' in x)
            pid = pa.get('id', '')
            if not pid:
                self._j(400, {"error": "no id"})
                return
            pe = lpend()
            if pid not in pe:
                self._j(404, {"error": "no"})
                return
            s = pe[pid].get('status', 'pending')
            rs = {"status": s, "pending_id": pid}
            if s == 'approved':
                rs.update({"token": pe[pid].get('token')})
            self._j(200, rs)
            return
        if p.startswith('/api/players') or p.startswith('/api/player/') or p.startswith('/api/locations'):
            if not self._check_friend_auth():
                self._j(403, {"error": "Unauthorized"})
                return
            if p == '/api/players/list':
                pl = [f.stem for f in PLAYERS_DIR.glob('*.txt')]
                self._j(200, {"players": pl, "count": len(pl)})
                return
            elif p == '/api/players/all':
                res = {}
                for f in PLAYERS_DIR.glob('*.txt'):
                    try:
                        with open(f, 'r', encoding='utf-8') as fp:
                            res[f.stem] = fp.read()
                    except:
                        res[f.stem] = ""
                self._j(200, res)
                return
            elif p.startswith('/api/player/'):
                name = p.split('/')[-1]
                if not name or not re.match(r'^[A-Za-z0-9_]{2,16}$', name):
                    self._j(400, {"error": "invalid name"})
                    return
                fp = PLAYERS_DIR / f"{name}.txt"
                if not fp.exists():
                    self._j(404, {"error": "Player not found"})
                    return
                try:
                    parsed = []
                    with open(fp, 'r', encoding='utf-8') as f:
                        for line in f.read().strip().split('\n'):
                            parts = line.split('|')
                            if len(parts) >= 13:
                                try:
                                    entry = {
                                        "time": parts[0],
                                        "x": float(parts[1].split(',')[0]),
                                        "y": float(parts[1].split(',')[1]),
                                        "z": float(parts[1].split(',')[2]),
                                        "dimension": parts[2],
                                        "health": float(parts[3]),
                                        "maxHealth": float(parts[4]),
                                        "eyeHeight": float(parts[5]),
                                        "yaw": float(parts[6]),
                                        "pitch": float(parts[7]),
                                        "status": parts[8],
                                        "in_tab": parts[9] == "true",
                                        "vanish": parts[10] == "true",
                                        "important": parts[11] == "true",
                                        "online_sec": int(parts[12])
                                    }
                                    if len(parts) >= 14:
                                        entry["gamemode"] = parts[13]
                                    parsed.append(entry)
                                except:
                                    continue
                    self._j(200, {"name": name, "history": parsed, "count": len(parsed)})
                    return
                except Exception as e:
                    self._j(500, {"error": str(e)})
                    return
            elif p == '/api/locations/list':
                self._j(200, {"locations": load_locations()})
                return
            self._j(404, {"error": "Not found"})
            return
        if not v:
            if r == "intr":
                self._j(403, {"error": "Intrusion", "code": "INTRUSION"})
                return
            self._j(401, {"error": "Invalid"})
            return
        if p == '/api/me':
            ts = lt()
            if tok in ts:
                td = ts[tok]
                rs = {"ok": True, "computer_id": td.get('computer_id')}
                if ib:
                    us = lu()
                    pid = ti.get('pending_id')
                    um = 'normal'
                    up = []
                    hbi = 30
                    if pid and pid in us:
                        um = us[pid].get('mode', 'normal')
                        up = us[pid].get('assigned_pastes', [])
                        hbi = us[pid].get('heartbeat_interval', 30)
                    rs.update({"role": "bot", "assigned_pastes": up, "mode": um, "heartbeat_interval": hbi})
                else:
                    rs.update({"role": "human"})
                self._j(200, rs)
            else:
                self._j(401, {"error": "Invalid"})
            return
        if p.startswith('/api/paste/'):
            raw = p[len('/api/paste/'):]
            try:
                n = unquote(raw).lower()
            except:
                n = raw.lower()
            n = tr(n, MAX_PN)
            if ib:
                us = lu()
                pid = ti.get('pending_id')
                al = [x.lower() for x in us[pid].get('assigned_pastes', [])] if pid and pid in us else []
                if not al or n not in al:
                    rt(tok, "PANIC")
                    na("🚨 <b>PANIC!</b>")
                    self._j(403, {"error": "PANIC", "code": "PANIC"})
                    return
            for x in lp():
                if x['name'].lower() == n:
                    c = dec(x['content'])
                    if not c:
                        self._j(500, {"error": "decrypt"})
                        return
                    self._j(200, {"name": x['name'], "content": c, "hash": x.get('hash', chash(c))})
                    return
            self._j(404, {"error": "no"})
            return
        if p == '/api/pastes':
            if ib:
                self._j(403, {"error": "no"})
                return
            ps = lp()
            self._j(200, {
                "pastes": [{"name": x['name'], "creator": x.get('cn', 'API'), "hash": x.get('hash')} for x in ps],
                "count": len(ps)
            })
            return
        self._j(404, {"error": "no"})

    def do_POST(self):
        try:
            self._post()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            print(f"[API] POST err: {e}", flush=True)

    def _post(self):
        if not API_EN:
            self._j(503, {"error": "Disabled"})
            return
        tok, ib, v, r, ti = self._a()
        p = self.path.split('?')[0]
        b = self._b()
        if b is None:
            self._j(413, {"error": "payload too large"})
            return
        ci = self.headers.get('X-Computer-ID', '')
        if p == '/api/player_data':
            try:
                d = json.loads(b) if b else {}
                process_player_data(d)
                self._j(200, {"ok": True, "processed": len(d.get('players', []))})
                return
            except Exception as e:
                self._j(500, {"error": str(e)})
                return
        if p == '/api/locations/create':
            if not self._check_friend_auth():
                self._j(403, {"error": "Unauthorized"})
                return
            try:
                d = json.loads(b) if b else {}
                name = d.get('name')
                pts = d.get('points', [])
                if not name or len(pts) < 3:
                    self._j(400, {"error": "Need name and 3+ points"})
                    return
                locs = load_locations()
                locs[name] = pts
                save_locations(locs)
                self._j(201, {"ok": True, "location": name})
                return
            except Exception as e:
                self._j(500, {"error": str(e)})
                return
        if p == '/api/locations/delete':
            if not self._check_friend_auth():
                self._j(403, {"error": "Unauthorized"})
                return
            try:
                d = json.loads(b) if b else {}
                name = d.get('name')
                if not name:
                    self._j(400, {"error": "Need name"})
                    return
                locs = load_locations()
                if name in locs:
                    del locs[name]
                    save_locations(locs)
                    self._j(200, {"ok": True})
                    return
                self._j(404, {"error": "Not found"})
                return
            except Exception as e:
                self._j(500, {"error": str(e)})
                return
        if p == '/api/login':
            client_ip = self.client_address[0]
            ok, count = check_rate_limit(f"login:{client_ip}")
            if not ok:
                self._j(429, {"error": "rate limit", "retry_after": RATE_LIMIT_WINDOW})
                log_failed_login(client_ip, "rate limit")
                return
            try:
                d = json.loads(b) if b else {}
            except:
                d = {}
            pw = d.get('password', '')
            n = d.get('name', 'PC_' + uuid.uuid4().hex[:6])
            lci = d.get('computer_id', ci or 'unk')
            if pw != PASSWORD:
                self._j(401, {"error": "Wrong password"})
                log_failed_login(client_ip, "wrong password")
                return
            us = lu()
            ts = lt()
            for uid, ud in us.items():
                if ud.get('is_bot') and ud.get('computer_id') == lci:
                    et = ud.get('api_token')
                    if et and et in ts:
                        self._j(200, {"ok": True, "status": "already_registered", "token": et, "name": n, "computer_id": lci})
                        return
            pid = str(uuid.uuid4())
            ft = str(uuid.uuid4())
            pe = lpend()
            pe[pid] = {
                'token': ft, 'name': n, 'computer_id': lci,
                'password_ok': True, 'status': 'pending',
                'created_at': datetime.now(MSK).isoformat(), 'msgs': {}
            }
            spend(pe)
            ts[ft] = {
                'name': n, 'computer_id': lci,
                'created_at': datetime.now(MSK).isoformat(),
                'is_computer': True, 'pending_id': pid
            }
            st(ts)
            us[pid] = {
                'name': n, 'computer_id': lci, 'username': "pc_" + pid[:8],
                'is_bot': True, 'is_admin': False, 'mode': 'normal',
                'assigned_pastes': [], 'registered_at': datetime.now(MSK).isoformat(),
                'api_token': ft, 'heartbeat_interval': 30
            }
            su(us)
            pe[pid]['status'] = 'approved'
            spend(pe)
            threading.Thread(target=san, args=(pid, n, lci), daemon=True).start()
            self._j(200, {"ok": True, "status": "approved", "token": ft})
            return
        if p == '/api/bind':
            if not tok:
                self._j(401, {"error": "no"})
                return
            if not ib:
                self._j(403, {"error": "no"})
                return
            self._j(200, {"ok": True})
            return
        if p == '/api/heartbeat':
            if not ib:
                self._j(403, {"error": "no"})
                return
            try:
                d = json.loads(b) if b else {}
            except:
                d = {}
            cv = ti.get('computer_id')
            if not cv:
                self._j(400, {"error": "no cid"})
                return
            hb_data = lhb()
            hb_data[cv] = {
                'last_seen': datetime.now(MSK).isoformat(),
                'name': ti.get('name'), 'mode': d.get('mode'),
                'scripts_running': d.get('scripts_running', []),
                'strikes': d.get('strikes', 0)
            }
            shb(hb_data)
            self._j(200, {"ok": True})
            return
        if p.startswith('/api/paste/'):
            if not v:
                self._j(401, {"error": "no"})
                return
            if ib:
                self._j(403, {"error": "no"})
                return
            raw = p[len('/api/paste/'):]
            try:
                n = unquote(raw).lower()
            except:
                n = raw.lower()
            n = tr(n, MAX_PN)
            try:
                d = json.loads(b) if b else {}
                c = d.get('content', b)
            except:
                c = b
            if not c:
                self._j(400, {"error": "empty"})
                return
            e = enc(c)
            if not e:
                self._j(500, {"error": "enc"})
                return
            ps = lp()
            f = None
            for i, x in enumerate(ps):
                if x['name'].lower() == n:
                    f = i
                    break
            if f is not None:
                ps[f]['content'] = e
                ps[f]['hash'] = chash(c)
                ps[f]['edited_at'] = datetime.now(MSK).isoformat()
                sp(ps)
                self._j(200, {"ok": True, "action": "updated", "name": n})
            else:
                ps.append({
                    'name': n, 'content': e, 'hash': chash(c),
                    'cid': 0, 'cn': 'API', 'created_at': datetime.now(MSK).isoformat()
                })
                sp(ps)
                self._j(201, {"ok": True, "action": "created", "name": n})
            return
        self._j(404, {"error": "no"})

def start_api():
    if not API_EN:
        print("API disabled", flush=True)
        return
    while True:
        srv = None
        try:
            print(f"[API] Starting on {PORT}...", flush=True)
            srv = TS(('0.0.0.0', PORT), AH)
            srv.timeout = 5
            print("[API] Ready v17.23", flush=True)
            srv.serve_forever()
        except OSError as e:
            if e.errno == 98:
                os.system(f"fuser -k {PORT}/tcp 2>/dev/null")
                time.sleep(2)
            else:
                time.sleep(5)
        except Exception as e:
            print(f"[API] err: {e}", flush=True)
            time.sleep(5)
        finally:
            if srv:
                try:
                    srv.server_close()
                except:
                    pass

def main():
    print("Starting bot v17.23 (SSH + cloudflared failover + all fixes)...", flush=True)
    load_online_tracking()
    update_url_from_log()
    threading.Thread(target=start_tunnel, daemon=True).start()
    threading.Thread(target=tunnel_watchdog_loop, daemon=True).start()
    time.sleep(2)
    threading.Thread(target=start_api, daemon=True).start()
    threading.Thread(target=site_checker_loop, daemon=True).start()
    threading.Thread(target=watcher_loop, daemon=True).start()
    threading.Thread(target=tunnel_health_loop, daemon=True).start()
    threading.Thread(target=vanish_checker_loop, daemon=True).start()
    threading.Thread(target=status_auto_refresh_loop, daemon=True).start()
    threading.Thread(target=lambda: (time.sleep(5), update_command_menus()), daemon=True).start()
    print("Bot ready! Relay: @capscraft_relay", flush=True)
    try:
        bot.infinity_polling(timeout=60, long_polling_timeout=60, skip_pending=False)
    finally:
        _tee_out.close()
        _tee_err.close()

if __name__ == '__main__':
    main()
