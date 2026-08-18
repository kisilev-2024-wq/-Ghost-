#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bot v17.24 — MAX SURVIVABILITY (SSH+cloudflared failover) + all fixes. PART 1/2"""
import sys, os, io, json, base64, socket, threading, time, uuid, hashlib, re, subprocess
import signal, tempfile, html as html_lib, urllib.request
from urllib.parse import unquote
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from datetime import datetime, timezone, timedelta
import telebot
from telebot import types

CHANNEL_ID = -1004388932854
CHANNEL_USERNAME = "capscraft_relay"
BASE = Path.home() / "telegram-bot"
BASE.mkdir(parents=True, exist_ok=True)
CFG = BASE / "config.json"; USERS = BASE / "users.json"; PASTES = BASE / "pastes.json"
STATES = BASE / "user_states.json"; TOKENS = BASE / "api_tokens.json"
PENDING = BASE / "pending_tokens.json"; TUNNEL = BASE / "tunnel_url.txt"
HB = BASE / "heartbeats.json"; SITE_STATUS_FILE = BASE / "site_status.json"
TUNNEL_HEALTH_FILE = BASE / "tunnel_health.json"; TUNNEL_STATE_FILE = BASE / "tunnel_state.json"
ONLINE_TRACK_FILE = BASE / "online_tracking.json"; FALLBACK_URL_FILE = BASE / "pending_url_post.txt"
RUNTIME_LOG = BASE / "runtime.log"; PLAYERS_DIR = BASE / "players"; PLAYERS_DIR.mkdir(exist_ok=True)
LOCATIONS_FILE = BASE / "locations.json"

TECH = "FFFFFFFFF12324"
KNOWN = {'start','help','past','all','api','api_reload','log','log_clear','status','menu'}
SITE_URL = "https://gmd.capscraft.com"
FRIEND_SERVER_IP = "185.26.120.251"
TRUSTED_PLAYERS = {"5183248850":"Gishta1","5602435561":"Rainy42","5370523250":"FFFFFFFFF12324"}
TRUSTED_PLAYERS_INT = {int(k):v for k,v in TRUSTED_PLAYERS.items()}
MAX_CONTENT_LENGTH = 10*1024*1024; MAX_HISTORY = 10000
VANISH_GRACE = 30; VANISH_NOTIFY_CD = 60
MSK = timezone(timedelta(hours=3)); BOT_START = time.time()
RELOAD_RATE_LIMIT = 10  # сек между /api/reload без токена
_last_reload_ts = 0.0

active_status_messages = {}; active_status_lock = threading.Lock(); STATUS_REFRESH_INTERVAL = 5
tunnel_lock = threading.Lock(); players_lock = threading.Lock()
tunnel_health_lock = threading.Lock(); site_cache_lock = threading.Lock()
internet_available = True; internet_down_since = None

try:
    with open(CFG,'r',encoding='utf-8') as f: cfg = json.load(f)
except Exception as e:
    print(f"FATAL: config: {e}", flush=True); sys.exit(106)
BOT_TOKEN = cfg.get("bot_token","")
if not BOT_TOKEN or BOT_TOKEN=="YOUR_BOT_TOKEN_HERE": sys.exit(107)
PASSWORD = cfg.get("password","")
if not PASSWORD or PASSWORD=="admin123": print("FATAL: weak password",flush=True); sys.exit(108)
KEY = cfg.get("encryption_key","").encode()
if not KEY or KEY==b"default": print("FATAL: default key",flush=True); sys.exit(109)
PROTECTED = set(cfg.get("protected_users",[]))
MAX_N = cfg.get("max_name_length",12); MAX_PN = cfg.get("max_paste_name_length",20)
PER = cfg.get("items_per_page",5); PORT = cfg.get("api_port",8080)
API_EN = cfg.get("api_enabled",True); PROXY = cfg.get("proxy_url")
ALLOWED_ORIGINS = cfg.get("allowed_origins",[])

def lip():
    try:
        s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('8.8.8.8',80)); ip=s.getsockname()[0]; s.close(); return ip
    except: return "127.0.0.1"
LIP = lip()
if PROXY: telebot.apihelper.proxy = {"http":PROXY,"https":PROXY}
bot = telebot.TeleBot(BOT_TOKEN)

def signal_handler(sig,frame):
    print("[Shutdown] stopping...",flush=True)
    try: bot.stop_polling()
    except: pass
    sys.exit(0)
signal.signal(signal.SIGINT,signal_handler); signal.signal(signal.SIGTERM,signal_handler)

class TeeLogger:
    def __init__(s,f,o): s.file=open(f,'a',encoding='utf-8',buffering=1); s.original=o; s.lock=threading.Lock()
    def write(s,m):
        with s.lock:
            try: s.file.write(m); s.file.flush()
            except: pass
            try: s.original.write(m)
            except: pass
    def flush(s):
        try: s.file.flush()
        except: pass
        try: s.original.flush()
        except: pass
    def close(s):
        try: s.file.close()
        except: pass
    def isatty(s): return False
_tee_out=TeeLogger(RUNTIME_LOG,sys.__stdout__); _tee_err=TeeLogger(RUNTIME_LOG,sys.__stderr__)
sys.stdout=_tee_out; sys.stderr=_tee_err

def get_last_log_lines(max_lines=5000,max_bytes=900_000):
    try:
        if not RUNTIME_LOG.exists(): return ""
        size=RUNTIME_LOG.stat().st_size
        if size<=max_bytes:
            with open(RUNTIME_LOG,'r',encoding='utf-8',errors='ignore') as f: return f.read()
        with open(RUNTIME_LOG,'rb') as f:
            f.seek(0,2); end=f.tell(); start=max(0,end-max_bytes); f.seek(start)
            if start>0: f.readline()
            chunk=f.read().decode('utf-8',errors='ignore')
        lines=chunk.split('\n')
        if len(lines)>max_lines:
            sk=len(lines)-max_lines; lines=lines[-max_lines:]
            return f"... (пропущено {sk} строк)\n\n"+'\n'.join(lines)
        return '\n'.join(lines)
    except Exception as e: return f"Error reading log: {e}"
def clear_log():
    try:
        if RUNTIME_LOG.exists():
            try: RUNTIME_LOG.replace(BASE/"runtime.log.prev")
            except: pass
            with open(RUNTIME_LOG,'w',encoding='utf-8') as f: f.write(f"[{datetime.now(MSK).isoformat()}] Log cleared by admin\n")
    except: pass

# ============ TUNNEL (v17.24 survivability) ============
tunnel_process=None; cloudflared_process=None; current_tunnel_url=None; tunnel_type=None
tunnel_last_activity=time.time(); tunnel_reconnects=0; tunnel_fail_streak=0; tunnel_history=[]

def load_tunnel_state():
    try:
        if TUNNEL_STATE_FILE.exists():
            with open(TUNNEL_STATE_FILE,'r',encoding='utf-8') as f: return json.load(f)
    except: pass
    return {}
def save_tunnel_state(s):
    try:
        with open(TUNNEL_STATE_FILE,'w',encoding='utf-8') as f: json.dump(s,f,indent=2)
    except: pass

def post_url_to_channel(url,reason="new",ttype="ssh",retries=5):
    now=datetime.now(MSK).strftime('%H:%M:%S')
    emoji="🔵" if ttype=="cloudflared" else "🔴"
    msg=(f"🔄 <b>Туннель {'обновлён' if reason=='new' else 'переподключён'}</b> {emoji}\n\n🌐 <code>{url}</code>\n🔧 Тип: <code>{ttype}</code>\n\n⏰ {now}\n📡 <code>t.me/s/{CHANNEL_USERNAME}</code>")
    for a in range(retries):
        try:
            bot.send_message(CHANNEL_ID,msg,parse_mode='HTML',disable_web_page_preview=True)
            print(f"[Tunnel] ✓ канал: {url} ({ttype})",flush=True); _flush_pending_posts(); return True
        except Exception as e:
            print(f"[Tunnel] post {a+1}/{retries}: {e}",flush=True); time.sleep(3)
    try:
        with open(FALLBACK_URL_FILE,'a',encoding='utf-8') as f: f.write(f"{now}|{url}|{reason}|{ttype}\n")
    except: pass
    return False
def _flush_pending_posts():
    if not FALLBACK_URL_FILE.exists(): return
    try:
        with open(FALLBACK_URL_FILE,'r',encoding='utf-8') as f: lines=f.read().strip().split('\n')
        with open(FALLBACK_URL_FILE,'w',encoding='utf-8') as f: f.write('')
        for line in lines:
            if not line.strip(): continue
            try:
                parts=line.split('|',3)
                if len(parts)>=2:
                    url=parts[1]; reason=parts[2] if len(parts)>2 else 'old'; tt=parts[3] if len(parts)>3 else 'ssh'
                    bot.send_message(CHANNEL_ID,f"📬 <b>Отложенный URL</b>\n\n🌐 <code>{url}</code>\n📋 {reason} ({tt})",parse_mode='HTML',disable_web_page_preview=True)
            except: pass
    except: pass

def check_ssh_available(host="localhost.run",port=22,timeout=5):
    try:
        s=socket.socket(socket.AF_INET,socket.SOCK_STREAM); s.settimeout(timeout); s.connect((host,port)); s.close(); return True
    except: return False
def cloudflared_available():
    p=BASE/"cloudflared"
    return p.exists() and os.access(str(p),os.X_OK)

def start_cloudflared():
    global cloudflared_process,current_tunnel_url,tunnel_type,tunnel_last_activity,tunnel_reconnects,tunnel_history
    if not cloudflared_available():
        print("[Tunnel] cloudflared binary not found",flush=True); return False
    print("[Tunnel] запуск cloudflared...",flush=True)
    try:
        p=subprocess.Popen([str(BASE/"cloudflared"),'tunnel','--url',f'http://localhost:{PORT}','--no-autoupdate'],
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        with tunnel_lock: cloudflared_process=p; tunnel_type='cloudflared'
        url_found=False
        for line in iter(p.stdout.readline,''):
            line=line.strip()
            if not line: continue
            print(f"[Cloudflared] {line}",flush=True); tunnel_last_activity=time.time()
            m=re.search(r'(https://[a-z0-9-]+\.trycloudflare\.com)',line)
            if m:
                nu=m.group(1)
                with tunnel_lock: ou=current_tunnel_url; current_tunnel_url=nu
                if nu!=ou:
                    print(f"[Tunnel] ✓ НОВЫЙ CLOUDFLARED URL: {nu}",flush=True)
                    post_url_to_channel(nu,"reconnect" if ou else "new","cloudflared")
                    tunnel_reconnects+=1; tunnel_history.append({'time':datetime.now(MSK).strftime('%H:%M:%S'),'type':'cloudflared','url':nu})
                    if len(tunnel_history)>20: tunnel_history=tunnel_history[-20:]
                    try:
                        with open(TUNNEL,'w',encoding='utf-8') as f: f.write(nu)
                        save_tunnel_state({'last_url':nu,'type':'cloudflared'})
                    except: pass
                url_found=True; break
            if "failed" in line.lower() or "error" in line.lower():
                return False
        if not url_found: return False
        p.wait(); return True
    except Exception as e:
        print(f"[Tunnel] cloudflared err: {e}",flush=True); return False

def start_ssh_tunnel():
    global tunnel_process,current_tunnel_url,tunnel_type,tunnel_last_activity,tunnel_reconnects,tunnel_fail_streak,tunnel_history
    if subprocess.run("which ssh",shell=True,capture_output=True).returncode!=0:
        os.system("pkg install -y openssh 2>&1 | tail -3")
    if not (Path.home()/".ssh"/"id_rsa").exists():
        os.system('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa >/dev/null 2>&1')
    fails=0
    while True:
        print("[Tunnel] запуск localhost.run...",flush=True); tunnel_last_activity=time.time()
        try:
            p=subprocess.Popen(['ssh','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null',
                '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-o','TCPKeepAlive=yes',
                '-o','IPQoS=throughput','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15',
                '-R',f'80:localhost:{PORT}','nokey@localhost.run'],
                stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
            with tunnel_lock: tunnel_process=p; tunnel_type='ssh'
            for line in iter(p.stdout.readline,''):
                line=line.strip()
                if not line: continue
                tunnel_last_activity=time.time(); print(f"[SSH] {line}",flush=True)
                m=re.search(r'(https://[a-z0-9-]+\.lhr\.life)',line)
                if m:
                    nu=m.group(1)
                    with tunnel_lock: ou=current_tunnel_url; current_tunnel_url=nu
                    if nu!=ou:
                        print(f"[Tunnel] ✓ НОВЫЙ SSH URL: {nu}",flush=True)
                        post_url_to_channel(nu,"reconnect" if ou else "new","ssh")
                        tunnel_reconnects+=1; tunnel_fail_streak=0
                        tunnel_history.append({'time':datetime.now(MSK).strftime('%H:%M:%S'),'type':'ssh','url':nu})
                        if len(tunnel_history)>20: tunnel_history=tunnel_history[-20:]
                        try:
                            with open(TUNNEL,'w',encoding='utf-8') as f: f.write(nu)
                            save_tunnel_state({'last_url':nu,'type':'ssh'})
                        except: pass
                    fails=0
            p.wait(); fails+=1; tunnel_fail_streak+=1
            wait=min(1+fails,5)
            print(f"[Tunnel] SSH упал (fail #{fails}, streak={tunnel_fail_streak}), рестарт через {wait}с...",flush=True)
            if tunnel_fail_streak>=3 and cloudflared_available():
                print("[Tunnel] ⚠️ 3 фейла SSH → переключаюсь на cloudflared",flush=True)
                tunnel_fail_streak=0; return  # выход → вызывающий переключит на cloudflared
            time.sleep(wait)
        except Exception as e:
            print(f"[Tunnel] SSH err: {e}",flush=True); fails+=1; tunnel_fail_streak+=1; time.sleep(2)

def start_tunnel():
    global tunnel_type
    st=load_tunnel_state()
    if st.get('last_url'):
        with tunnel_lock: current_tunnel_url=st['last_url']
    if cfg.get("force_cloudflared",False):
        print("[Tunnel] force_cloudflared=true",flush=True)
        if cloudflared_available():
            while True: start_cloudflared(); time.sleep(5)
        start_ssh_tunnel(); return
    print("[Tunnel] проверка доступности SSH...",flush=True)
    ssh_ok=check_ssh_available(); cf_ok=cloudflared_available()
    if ssh_ok:
        print("[Tunnel] ✓ SSH доступен",flush=True)
        while True:
            start_ssh_tunnel()
            if tunnel_fail_streak>=3 and cf_ok:
                print("[Tunnel] 🔄 SSH нестабилен → cloudflared",flush=True)
                tunnel_fail_streak=0
                while True: start_cloudflared(); time.sleep(5)
            time.sleep(2)
    elif cf_ok:
        print("[Tunnel] ✗ SSH недоступен → cloudflared",flush=True)
        while True: start_cloudflared(); time.sleep(5)
    else:
        print("[Tunnel] ❌ Ни SSH ни cloudflared не доступны!",flush=True)

def force_reload_tunnel(reason="manual"):
    global tunnel_last_activity,tunnel_process,cloudflared_process
    print(f"[Tunnel-RELOAD] force reload: {reason}",flush=True)
    with tunnel_lock:
        if tunnel_process is not None:
            try:
                try: tunnel_process.terminate(); tunnel_process.wait(timeout=3)
                except subprocess.TimeoutExpired: tunnel_process.kill()
                except: pass
            except: pass
        tunnel_process=None
        if cloudflared_process is not None:
            try: cloudflared_process.terminate(); cloudflared_process.wait(timeout=3)
            except: 
                try: cloudflared_process.kill()
                except: pass
        cloudflared_process=None
    tunnel_last_activity=time.time(); return True

def tunnel_watchdog_loop():
    global tunnel_last_activity
    time.sleep(30)
    while True:
        try:
            if get_current_tunnel_url():
                with tunnel_lock: p=tunnel_process; cp=cloudflared_process
                active=p if (p and p.poll() is None) else (cp if (cp and cp.poll() is None) else None)
                if active is None: tunnel_last_activity=time.time()
                else:
                    idle=time.time()-tunnel_last_activity
                    if idle>45:
                        force_reload_tunnel("watchdog_stale"); tunnel_last_activity=time.time()
        except Exception as e: print(f"[Watchdog] err: {e}",flush=True)
        time.sleep(10)

def internet_monitor_loop():
    global internet_available,internet_down_since
    print("[NetMon] запущен (30с)",flush=True)
    while True:
        try:
            time.sleep(30)
            any_ok=False
            for host in ['8.8.8.8','1.1.1.1','77.88.8.8']:
                try:
                    r=subprocess.run(['ping','-c','1','-W','3',host],capture_output=True,timeout=5)
                    if r.returncode==0: any_ok=True; break
                except: pass
            if any_ok:
                if not internet_available:
                    dt=int(time.time()-internet_down_since) if internet_down_since else 0
                    print(f"[NetMon] 🟢 Интернет ВОССТАНОВЛЕН ({dt}с) → рестарт туннеля",flush=True)
                    internet_available=True; internet_down_since=None
                    threading.Thread(target=lambda: force_reload_tunnel("internet_restored"),daemon=True).start()
            else:
                if internet_available:
                    internet_down_since=time.time(); internet_available=False
                    print("[NetMon] 🔴 Интернет ОТСУТСТВУЕТ",flush=True)
        except Exception as e: print(f"[NetMon] err: {e}",flush=True)

def get_current_tunnel_url():
    with tunnel_lock: return current_tunnel_url
def get_current_tunnel_type():
    with tunnel_lock: return tunnel_type or 'unknown'
def tunnel():
    u=get_current_tunnel_url()
    if u: return u
    try:
        if TUNNEL.exists():
            with open(TUNNEL,'r',encoding='utf-8') as f: t=f.read().strip()
            if t.startswith('http'): return t
    except: pass
    return cfg.get('tunnel_url')
def bot_uptime_sec(): return int(time.time()-BOT_START)

def enc(t):
    try:
        b=t.encode(); salt=hashlib.sha256(KEY).digest()
        return base64.b64encode(bytes(x ^ salt[i%len(salt)] ^ KEY[i%len(KEY)] for i,x in enumerate(b))).decode()
    except: return None
def dec(d):
    try:
        b=base64.b64decode(d); salt=hashlib.sha256(KEY).digest()
        return bytes(x ^ salt[i%len(salt)] ^ KEY[i%len(KEY)] for i,x in enumerate(b)).decode()
    except: return None
def chash(t): return hashlib.sha256((str(t)+KEY.decode('utf-8',errors='ignore')).encode()).hexdigest()[:16]
def rj(p,d):
    try:
        with open(p,'r',encoding='utf-8') as f: return json.load(f)
    except: return d
def wj(p,d):
    try:
        fd,tp=tempfile.mkstemp(dir=str(p.parent),suffix='.tmp')
        try:
            with os.fdopen(fd,'w',encoding='utf-8') as f: json.dump(d,f,indent=2,ensure_ascii=False)
            os.replace(tp,p)
        except:
            try: os.unlink(tp)
            except: pass
            raise
    except Exception as e: print(f"[wj] err {p}: {e}",flush=True)
def lu(): return rj(USERS,{}); 
def su(u): wj(USERS,u)
def lp(): return rj(PASTES,[]); 
def sp(p): wj(PASTES,p)
def ls(): return rj(STATES,{}); 
def ss(s): wj(STATES,s)
def lt(): return rj(TOKENS,{}); 
def st(t): wj(TOKENS,t)
def lpend(): return rj(PENDING,{}); 
def spend(p): wj(PENDING,p)
def lhb(): return rj(HB,{}); 
def shb(h): wj(HB,h)
def reg(u): return str(u) in lu()
def dn(u):
    d=lu().get(str(u)); return (d.get('name') or str(u)) if d else str(u)
def ia(u):
    try: uid=int(u)
    except: return False
    if uid in TRUSTED_PLAYERS_INT:
        nm=TRUSTED_PLAYERS_INT[uid]
        if nm==TECH or nm in PROTECTED: return True
    d=lu().get(str(uid))
    if not d: return False
    if d.get('is_admin'): return True
    nm=d.get('name')
    if nm==TECH: return True
    return bool(nm and nm in PROTECTED)
def role(u):
    try: uid=int(u)
    except: return "user"
    if uid in TRUSTED_PLAYERS_INT:
        nm=TRUSTED_PLAYERS_INT[uid]
        if nm==TECH: return "tech"
        if nm in PROTECTED: return "admin"
    d=lu().get(str(uid))
    if not d: return "user"
    if d.get('is_bot'): return "bot"
    nm=d.get('name')
    if nm==TECH: return "tech"
    if nm in PROTECTED or d.get('is_admin'): return "admin"
    return "user"
def aia():
    a=[]
    for s,d in lu().items():
        try:
            if ia(int(s)): a.append(int(s))
        except: pass
    for uid in TRUSTED_PLAYERS_INT:
        if ia(uid) and uid not in a: a.append(uid)
    return a
def gs(u): return ls().get(str(u),{})
def sets(u,d):
    s=ls(); s[str(u)]=d; ss(s)
def cs(u):
    s=ls()
    if str(u) in s: del s[str(u)]
    ss(s)
def tr(t,m): return t if len(t)<=m else t[:m-1]+"…"
def safe(t):
    if t is None: return "—"
    return html_lib.escape(str(t))
def ui_header(t,e="📋"): return f"{e} <b>{t}</b>\n<code>{'━'*28}</code>"
def ui_row(l,v,e="•"): return f"{e} {l}: <code>{safe(v)}</code>"
def ui_status(o): return "🟢 <b>Online</b>" if o else "🔴 <b>Offline</b>"
def ui_mode(m):
    if m=='service': return "🔧 Сервисный"
    if m=='fortress': return "🚨 УСИЛЕННАЯ ЗАЩИТА"
    return "🔓 Обычный"
def ui_divider(): return f"<code>{'─'*20}</code>"
def msk_now(): return datetime.now(MSK)
def fmt_duration(sec):
    sec=int(max(0,sec))
    if sec<60: return f"{sec}с"
    m=sec//60
    if m<60: return f"{m}м"
    h=m//60; m=m%60
    if h<24: return f"{h}ч {m}м"
    d=h//24; h=h%24
    return f"{d}д {h}ч"
def gm_icon(g):
    g=(g or 'unknown').lower()
    if 'surv' in g: return "🗡"
    if 'creat' in g: return "🎨"
    if 'adv' in g: return "🧭"
    if 'spec' in g: return "👁"
    return "❔"
def hb_category(sec):
    try: sec=int(sec)
    except: sec=30
    if sec==5: return "1️⃣ Частое (5с)"
    if sec==30: return "2️⃣ Среднее (30с)"
    if sec==300: return "3️⃣ Долгое (5м)"
    if sec==600: return "4️⃣ Долгое+ (10м)"
    return f"5️⃣ Кастом ({sec}с)"
def validate_hb_interval(sec):
    try: sec=int(sec)
    except: return 30
    if sec<5: return 5
    if sec>3600: return 3600
    return sec

_trusted_cache={}; _trusted_cache_lock=threading.Lock()
def auto_register_trusted(uid):
    try: uid=int(uid)
    except: return False
    with _trusted_cache_lock:
        if uid in _trusted_cache: return _trusted_cache[uid]
    if uid not in TRUSTED_PLAYERS_INT:
        with _trusted_cache_lock: _trusted_cache[uid]=False
        return False
    if reg(uid):
        with _trusted_cache_lock: _trusted_cache[uid]=True
        return True
    name=TRUSTED_PLAYERS_INT[uid]; us=lu()
    us[str(uid)]={'name':name,'username':f"player_{uid}",'is_bot':False,'is_admin':(name==TECH or name in PROTECTED),'registered_at':datetime.now(MSK).isoformat(),'trusted':True}
    su(us)
    print(f"[Auth] auto-registered {name}",flush=True)
    with _trusted_cache_lock: _trusted_cache[uid]=True
    return True

player_online_since={}; server_online_since=None
def load_online_tracking():
    global player_online_since,server_online_since
    try:
        with open(ONLINE_TRACK_FILE,'r',encoding='utf-8') as f: d=json.load(f)
        player_online_since=d.get('players',{}); server_online_since=d.get('server')
    except: pass
def save_online_tracking():
    try:
        with open(ONLINE_TRACK_FILE,'w',encoding='utf-8') as f: json.dump({'players':player_online_since,'server':server_online_since},f)
    except: pass
def get_online_since(n): return player_online_since.get(n) or player_online_since.get(n.lower())

def find_user_by_arg(arg,ul):
    try:
        i=int(arg)-1
        if 0<=i<len(ul): return ul[i]
    except ValueError: pass
    al=arg.lower()
    for tid,td in ul:
        if (td.get('name') or '').lower()==al: return tid,td
    for tid,td in ul:
        if al in (td.get('name') or '').lower(): return tid,td
    return None,None
def find_paste_by_arg(arg,pl):
    try:
        i=int(arg)-1
        if 0<=i<len(pl): return i,pl[i]
    except ValueError: pass
    al=arg.lower()
    for i,p in enumerate(pl):
        if p['name'].lower()==al: return i,p
    for i,p in enumerate(pl):
        if al in p['name'].lower(): return i,p
    return None,None
def edit_or_send(c,t,kb=None,pm='HTML'):
    if hasattr(c,'message') and c.message:
        try: bot.edit_message_text(t,c.message.chat.id,c.message.message_id,parse_mode=pm,reply_markup=kb)
        except Exception as e:
            if "message is not modified" not in str(e):
                try: bot.send_message(c.message.chat.id,t,parse_mode=pm,reply_markup=kb)
                except: pass
    elif hasattr(c,'chat'): bot.send_message(c.chat.id,t,parse_mode=pm,reply_markup=kb)
def send_paste_file(cid,content,name,uid):
    fid=None
    try:
        fo=io.BytesIO(content.encode('utf-8')); fo.name=f"{name}.txt"
        fid=bot.send_document(cid,fo,caption=f"📄 {name}").message_id
    except:
        try:
            with tempfile.NamedTemporaryFile(mode='w',suffix='.txt',delete=False,encoding='utf-8') as f: f.write(content); tp=f.name
            with open(tp,'rb') as f: fid=bot.send_document(cid,f,caption=f"📄 {name}").message_id
            os.unlink(tp)
        except:
            try: fid=bot.send_message(cid,f"📄 <b>{name}</b>\n<pre>{safe(content[:4000])}</pre>",parse_mode='HTML').message_id
            except: pass
    if fid:
        s=gs(uid) or {}; s['last_file_msg_id']=fid; s['last_file_chat_id']=cid; sets(uid,s)
    return fid
def delete_last_file(uid):
    s=gs(uid) or {}; mid=s.get('last_file_msg_id'); cid=s.get('last_file_chat_id')
    if mid and cid:
        try: bot.delete_message(cid,mid)
        except: pass
        s.pop('last_file_msg_id',None); s.pop('last_file_chat_id',None); sets(uid,s)
def vs(tok,cid,ip):
    ts=lt()
    if tok not in ts: return False,"inv",None
    td=ts[tok]; created=td.get('created_at')
    if created:
        try:
            age=(datetime.now(MSK)-datetime.fromisoformat(created)).total_seconds()
            if age>30*24*60*60: rt(tok,"Token expired"); return False,"expired",None
        except: pass
    rc=td.get('computer_id')
    if not rc: td['computer_id']=cid; ts[tok]=td; st(ts); rc=cid
    if rc!=cid: rt(tok,"CID mismatch"); return False,"intr",None
    return True,"ok",td
def rt(tok,r="unknown"):
    ts=lt()
    if tok in ts:
        td=ts.pop(tok); st(ts); us=lu(); pid=td.get('pending_id')
        if pid and pid in us:
            n=us[pid].get('name','?'); del us[pid]; su(us)
            na(f"🚫 <b>ОТОЗВАН</b>\n{ui_divider()}\n🤖 <code>{safe(n)}</code>\n📝 {safe(r)}")
def na(m):
    for a in aia():
        try: bot.send_message(a,m,parse_mode='HTML')
        except: pass

# ============ PLAYER TRACKING ============
player_positions={}; player_zones={}; player_last_seen={}; player_vanish_since={}; player_file_lines={}
radar_first_seen={}; vanish_cooldown={}
def point_in_polygon(x,z,poly):
    n=len(poly); inside=False; j=n-1
    for i in range(n):
        xi,zi=poly[i]['x'],poly[i]['z']; xj,zj=poly[j]['x'],poly[j]['z']
        if ((zi>z)!=(zj>z)) and (x<(xj-xi)*(z-zi)/(zj-zi)+xi): inside=not inside
        j=i
    return inside
def point_to_segment_dist(px,pz,ax,az,bx,bz):
    dx=bx-ax; dz=bz-az; l2=dx*dx+dz*dz
    if l2==0: return ((px-ax)**2+(pz-az)**2)**0.5
    t=max(0,min(1,((px-ax)*dx+(pz-az)*dz)/l2))
    return ((px-(ax+t*dx))**2+(pz-(az+t*dz))**2)**0.5
def load_locations():
    try:
        with open(LOCATIONS_FILE,'r',encoding='utf-8') as f: return json.load(f)
    except: return {}
def save_locations(l):
    with open(LOCATIONS_FILE,'w',encoding='utf-8') as f: json.dump(l,f,indent=2)
def is_teleport(name,x,z,ts):
    if name not in player_positions or len(player_positions[name])<3: return False
    pos=player_positions[name][-8:]; sp=[]
    for i in range(1,len(pos)):
        dt=pos[i]['timestamp']-pos[i-1]['timestamp']
        if dt<=0: continue
        d=((pos[i]['x']-pos[i-1]['x'])**2+(pos[i]['z']-pos[i-1]['z'])**2)**0.5
        sp.append(d/dt)
    if len(sp)<2: return False
    if sp[-1]<50: return False
    if max(sp[:-1])<5: return True
    acc=any(sp[i]>sp[i-1]+3 for i in range(1,len(sp)))
    dec=any(sp[i]<sp[i-1]-3 for i in range(1,len(sp)))
    return not (acc or dec)
def update_zone_status(name,x,z): return "standing"
def is_player_in_tab(name):
    try:
        if SITE_STATUS_FILE.exists():
            with open(SITE_STATUS_FILE,'r',encoding='utf-8') as f: d=json.load(f)
            if not d.get('online'): return False
            return name.lower() in [p.lower() for p in d.get('players_list',[])]
    except: pass
    return False
def format_history_line(ts,x,y,z,dim,health,maxhealth,eye,yaw,pitch,status,in_tab,vanish,imp,online_sec,gamemode):
    t=datetime.fromtimestamp(ts,MSK).strftime('%H:%M:%S')
    return (f"{t}|{x:.1f},{y:.1f},{z:.1f}|{dim}|{health:.1f}|{maxhealth:.1f}|{eye:.2f}|{yaw:.1f}|{pitch:.1f}|{status}|"
            f"{'true' if in_tab else 'false'}|{'true' if vanish else 'false'}|{'true' if imp else 'false'}|{online_sec}|{gamemode}")
def save_player_history(name,line,important):
    fp=PLAYERS_DIR/f"{name}.txt"
    try:
        with open(fp,'a',encoding='utf-8') as f: f.write(line+'\n')
    except Exception as e: print(f"[Tracker] {name}: {e}",flush=True)
    if name not in player_file_lines: player_file_lines[name]=0
    player_file_lines[name]+=1
    if player_file_lines[name]>MAX_HISTORY*1.2:
        try:
            with open(fp,'r',encoding='utf-8') as f: lines=f.readlines()
            if len(lines)>MAX_HISTORY:
                with open(fp,'w',encoding='utf-8') as f: f.writelines(lines[-MAX_HISTORY:])
                player_file_lines[name]=MAX_HISTORY
        except: pass
def get_vanish_tracking_admins(): return aia()
def notify_vanish(name,x,z,dim):
    admins=get_vanish_tracking_admins()
    if not admins: return
    msg=(f"🚨 <b>ВАНИШ ОБНАРУЖЕН!</b>\n\n👤 <code>{safe(name)}</code>\n📍 <code>[{x:.0f}, {z:.0f}]</code> | {safe(dim)}\n⚠️ В радаре есть, в табе НЕТ\n⏰ {msk_now().strftime('%H:%M:%S')}")
    for a in admins:
        try:
            s=gs(a) or {}
            if 'vanish_msg_id' in s:
                try: bot.edit_message_text(msg,a,s['vanish_msg_id'],parse_mode='HTML')
                except:
                    m=bot.send_message(a,msg,parse_mode='HTML'); s['vanish_msg_id']=m.message_id; sets(a,s)
            else:
                m=bot.send_message(a,msg,parse_mode='HTML'); s['vanish_msg_id']=m.message_id; sets(a,s)
        except Exception as e: print(f"[Vanish] {a}: {e}",flush=True)
def clear_vanish_notifications():
    for a in get_vanish_tracking_admins():
        s=gs(a) or {}
        if 'vanish_msg_id' in s:
            try: bot.delete_message(a,s['vanish_msg_id'])
            except: pass
            s.pop('vanish_msg_id',None); sets(a,s)
def clear_vanish_for_player(name):
    player_vanish_since.pop(name,None); radar_first_seen.pop(name,None)
    for a in get_vanish_tracking_admins():
        s=gs(a) or {}
        if 'vanish_msg_id' in s:
            try: bot.delete_message(a,s['vanish_msg_id'])
            except: pass
            s.pop('vanish_msg_id',None); sets(a,s)
def process_player_data(data):
    if not isinstance(data,dict): return
    now=time.time(); players_in_update=data.get('players',[])
    if not isinstance(players_in_update,list): return
    current_names=set()
    for p in players_in_update:
        if not isinstance(p,dict): continue
        nm=p.get('name')
        if isinstance(nm,str) and nm.strip(): current_names.add(nm.strip())
    for nm in list(player_vanish_since.keys()):
        if nm not in current_names: clear_vanish_for_player(nm)
    with players_lock:
        for p in players_in_update:
            if not isinstance(p,dict): continue
            name=p.get('name')
            if not isinstance(name,str) or not name.strip(): continue
            name=name.strip()
            if len(name)<2 or len(name)>16: continue
            if not re.match(r'^[A-Za-z0-9_]+$',name): continue
            try:
                x=float(p.get('x',0)); y=float(p.get('y',0)); z=float(p.get('z',0))
                health=float(p.get('health',20)); maxhealth=float(p.get('maxHealth',20))
                eye=float(p.get('eyeHeight',1.62)); yaw=float(p.get('yaw',0)); pitch=float(p.get('pitch',0)); ts=float(p.get('timestamp',now))
            except (TypeError,ValueError): continue
            dim=str(p.get('dimension','unknown'))[:32]; gamemode=str(p.get('gamemode','unknown'))[:16]
            player_positions.setdefault(name,[]).append({'x':x,'y':y,'z':z,'timestamp':ts,'dimension':dim,'gamemode':gamemode})
            if len(player_positions[name])>100: player_positions[name]=player_positions[name][-100:]
            if name not in radar_first_seen: radar_first_seen[name]=ts
            in_tab=is_player_in_tab(name)
            if not in_tab and (ts-radar_first_seen.get(name,ts))>VANISH_GRACE:
                if name not in player_vanish_since: player_vanish_since[name]=ts
                if now-vanish_cooldown.get(name,0)>VANISH_NOTIFY_CD:
                    vanish_cooldown[name]=now; notify_vanish(name,x,z,dim)
            elif in_tab:
                player_vanish_since.pop(name,None); radar_first_seen.pop(name,None)
            vanish=name in player_vanish_since
            tele=is_teleport(name,x,z,ts); status=update_zone_status(name,x,z); imp=vanish or tele
            since=get_online_since(name); online_sec=int(now-since) if since else 0
            save_player_history(name,format_history_line(ts,x,y,z,dim,health,maxhealth,eye,yaw,pitch,status,in_tab,vanish,imp,online_sec,gamemode),imp)
def vanish_checker_loop():
    while True:
        try:
            if not player_vanish_since: clear_vanish_notifications()
        except Exception as e: print(f"[VanishChecker] err: {e}",flush=True)
        time.sleep(5)

# ============ TUNNEL HEALTH ============
tunnel_health={'status':'unknown','url':None,'type':None,'last_check':None,'last_ok':None,'errors':[],'checks_total':0,'checks_ok':0,'last_error':None}
def sanitize_error(e):
    t=re.sub(r'<[^>]+>','',str(e)); return t.replace('<','').replace('>','')[:200]
def check_tunnel_health():
    global tunnel_health
    try:
        url=tunnel(); ttype=get_current_tunnel_type()
        if not url:
            with tunnel_health_lock: tunnel_health['status']='no_url'; tunnel_health['last_error']='No URL'
            return
        with tunnel_health_lock:
            tunnel_health['url']=url; tunnel_health['type']=ttype
            tunnel_health['last_check']=datetime.now(MSK).isoformat()
            tunnel_health['checks_total']=tunnel_health.get('checks_total',0)+1
        local_ok=False
        try:
            with urllib.request.urlopen(f'http://localhost:{PORT}/api/url',timeout=5) as r: local_ok=r.status==200
        except Exception as e:
            with tunnel_health_lock: tunnel_health['last_error']=f'Localhost: {sanitize_error(e)}'
        try:
            req=urllib.request.Request(f'{url}/api/url',headers={'bypass-tunnel-reminder':'true','User-Agent':'HealthCheck/1.0'})
            with urllib.request.urlopen(req,timeout=10) as r:
                if r.status==200:
                    with tunnel_health_lock:
                        tunnel_health['status']='ok'; tunnel_health['last_ok']=datetime.now(MSK).isoformat()
                        tunnel_health['checks_ok']=tunnel_health.get('checks_ok',0)+1; tunnel_health['last_error']=None
                    with open(TUNNEL_HEALTH_FILE,'w',encoding='utf-8') as f: json.dump(tunnel_health,f,indent=2,default=str)
                    return
        except Exception as e:
            em=sanitize_error(e)
            with tunnel_health_lock:
                tunnel_health['last_error']=f'Public: {em}'
                errs=tunnel_health.get('errors',[]); errs.append({'time':datetime.now(MSK).isoformat(),'error':em})
                tunnel_health['errors']=errs[-10:]
                tunnel_health['status']='tunnel_down' if local_ok else 'bot_down'
        with open(TUNNEL_HEALTH_FILE,'w',encoding='utf-8') as f: json.dump(tunnel_health,f,indent=2,default=str)
    except Exception as e: print(f"[Tunnel] err: {e}",flush=True)
def tunnel_health_loop():
    time.sleep(5)
    while True:
        try: check_tunnel_health()
        except Exception as e: print(f"[Tunnel] err: {e}",flush=True)
        time.sleep(60)
def get_tunnel_status_text():
    try:
        with tunnel_health_lock: h=dict(tunnel_health)
        url=h.get('url') or tunnel() or 'не настроен'; ttype=h.get('type') or get_current_tunnel_type()
        tinfo=f" ({ttype})" if ttype!='unknown' else ""
        local_ok=False
        try:
            with urllib.request.urlopen(f'http://localhost:{PORT}/api/health',timeout=3) as r: local_ok=r.status==200
        except: pass
        if local_ok and url:
            if h.get('last_ok'):
                tot=h.get('checks_total',0); okc=h.get('checks_ok',0); rate=int(okc/tot*100) if tot else 100
                return (f"🟢 <b>Работает</b>{tinfo}\n{ui_row('Успех',f'{rate}%')}\n{ui_row('URL',url)}\n{ui_row('Переподключений',tunnel_reconnects)}")
            return (f"🟡 <b>Локально работает</b>{tinfo}\n{ui_row('URL',url)}\n{ui_row('Статус','Проверяется...')}\n{ui_row('Переподключений',tunnel_reconnects)}")
        elif local_ok and not url:
            return (f"🟡 <b>Туннель запускается</b>{tinfo}\n{ui_row('Статус','Ожидание URL...')}\n{ui_row('Переподключений',tunnel_reconnects)}")
        return f"🔴 <b>Бот недоступен</b>\n{ui_row('Ошибка',h.get('last_error','unknown')[:80])}"
    except Exception as e: return f"⚠️ {str(e)[:50]}"
def update_url_from_log():
    u=get_current_tunnel_url()
    if u:
        try:
            with open(TUNNEL,'w',encoding='utf-8') as f: f.write(u)
            return u
        except: pass
    return None

# ============ SITE ============
def parse_site_status():
    global server_online_since
    try:
        req=urllib.request.Request(SITE_URL,headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req,timeout=15) as r: html_text=r.read().decode('utf-8')
        is_online=bool(re.search(r"minecraftserverinfo\s+isonline",html_text,re.IGNORECASE))
        players_list=[]
        for nick in re.findall(r"<tr class='player'>\s*<td>\s*<img[^>]+alt='([A-Za-z0-9_]{3,16})s Avatar'[^>]*>\s*[A-Za-z0-9_]{3,16}\s*</td>\s*<td>\s*<span class='playeronline'>Online</span>\s*</td>\s*</tr>",html_text,re.IGNORECASE):
            if nick not in players_list: players_list.append(nick)
        for row in re.findall(r"<tr class='player(?:\s+[^']*)?'>\s*(.*?)\s*</tr>",html_text,re.IGNORECASE|re.DOTALL):
            if "playeronline" not in row.lower(): continue
            m=re.search(r"alt='([A-Za-z0-9_]{3,16})s Avatar'",row,re.IGNORECASE)
            if m and m.group(1) not in players_list: players_list.append(m.group(1))
        address="gmd.capscraft.com"
        am=re.search(r"data-address='([\w\.]+)'",html_text)
        if am: address=am.group(1)
        now=time.time()
        if is_online:
            if server_online_since is None: server_online_since=now
        else: server_online_since=None
        on=set(players_list)
        for n in players_list:
            if n not in player_online_since: player_online_since[n]=now
        for n in list(player_online_since):
            if n not in on: del player_online_since[n]
        save_online_tracking()
        result={'online':is_online,'players_online':len(players_list),'address':address,'players_list':players_list,
                'last_check':datetime.now(MSK).isoformat(),'server_online_since':server_online_since,
                'server_uptime_sec':int(now-server_online_since) if (is_online and server_online_since) else 0}
        with open(SITE_STATUS_FILE,'w',encoding='utf-8') as f: json.dump(result,f,indent=2,ensure_ascii=False)
        return result
    except Exception as e: print(f"[Site] err: {e}",flush=True); return None
def site_checker_loop():
    while True:
        try:
            s=parse_site_status()
            if s: print(f"[Site] {'🟢' if s['online'] else '🔴'} ({s['players_online']})",flush=True)
        except Exception as e: print(f"[Site] err: {e}",flush=True)
        time.sleep(60)
def watcher_loop():
    GRACE=180
    print("[Watcher] started (grace=180s)",flush=True)
    while True:
        try:
            time.sleep(30)
            if not SITE_STATUS_FILE.exists(): continue
            try:
                with open(SITE_STATUS_FILE,'r',encoding='utf-8') as f:
                    if not json.load(f).get('online'): continue
            except: continue
            heartbeats=lhb(); users=lu(); now=datetime.now(MSK)
            try:
                with open(CFG,'r',encoding='utf-8') as f: gk=json.load(f).get('kiktime_minutes',10)*60
            except: gk=600
            for uid,user in list(users.items()):
                try:
                    if not user.get('is_bot'): continue
                    svc=(user.get('mode','normal')=='service')
                    kt=user.get('kiktime_override'); limit=(kt*60) if kt else gk
                    if svc: limit=max(limit,600)
                    cid=user.get('computer_id')
                    if not cid: continue
                    if cid not in heartbeats:
                        reg_at=user.get('registered_at')
                        if not reg_at: continue
                        try: delta=(now-datetime.fromisoformat(reg_at)).total_seconds()
                        except: continue
                        if delta<GRACE: continue
                        if delta>limit:
                            name=user.get('name','?'); at=user.get('api_token')
                            print(f"[Watcher] KICK {name} (no heartbeat, {int(delta/60)} мин)",flush=True)
                            if at: rt(at,f"Авто-кик: нет пульса {int(delta/60)} мин")
                            hb2=lhb()
                            if cid in hb2: del hb2[cid]; shb(hb2)
                            if uid in users: del users[uid]; su(users)
                            na(f"🚫 <b>АВТО-КИК</b>\n🤖 <code>{safe(name)}</code>\n⚠️ Нет пульса {int(delta/60)} мин")
                        continue
                    lsv=heartbeats[cid].get('last_seen')
                    if not lsv: continue
                    try: delta=(now-datetime.fromisoformat(lsv)).total_seconds()
                    except: continue
                    if delta<GRACE: continue
                    if delta>limit:
                        name=user.get('name','?'); at=user.get('api_token')
                        print(f"[Watcher] KICK {name} (offline {int(delta/60)} мин)",flush=True)
                        if at: rt(at,f"Авто-кик: offline {int(delta/60)} мин")
                        hb2=lhb()
                        if cid in hb2: del hb2[cid]; shb(hb2)
                        if uid in users: del users[uid]; su(users)
                        na(f"🚫 <b>АВТО-КИК</b>\n🤖 <code>{safe(name)}</code>\n⏱ Offline {int(delta/60)} мин")
                except Exception as e: print(f"[Watcher] err {uid}: {e}",flush=True)
        except Exception as e: print(f"[Watcher] loop err: {e}",flush=True)
def get_radar_stats():
    users=lu(); heartbeats=lhb(); now=datetime.now(MSK)
    total=online=offline=0
    for uid,u in users.items():
        if not u.get('is_bot'): continue
        if 'radar' not in u.get('assigned_pastes',[]): continue
        total+=1; cid=u.get('computer_id')
        if cid and cid in heartbeats:
            try:
                lsv=heartbeats[cid].get('last_seen')
                if lsv and (now-datetime.fromisoformat(lsv)).total_seconds()<120: online+=1; continue
            except: pass
        offline+=1
    return total,online,offline
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
        try: print(f"[API] {self.client_address[0]} - {f%a}", flush=True)
        except: pass
        tunnel_last_activity = time.time()
    def _j(self, c, d):
        try:
            b = json.dumps(d, ensure_ascii=False).encode()
            self.send_response(c)
            self.send_header('Content-Type','application/json; charset=utf-8')
            if ALLOWED_ORIGINS:
                o=self.headers.get('Origin','')
                if o in ALLOWED_ORIGINS: self.send_header('Access-Control-Allow-Origin',o)
            self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type, bypass-tunnel-reminder, X-Computer-ID, X-Server-Key')
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
            self.send_header('Content-Length',str(len(b))); self.send_header('Connection','close')
            self.end_headers()
            try: self.wfile.write(b); self.wfile.flush()
            except (BrokenPipeError,ConnectionResetError): pass
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e: print(f"[API] err: {e}",flush=True)
    def _b(self):
        l=int(self.headers.get('Content-Length',0))
        if l>MAX_CONTENT_LENGTH: return None
        return self.rfile.read(l).decode() if l>0 else ""
    def _check_friend_auth(self):
        k=self.headers.get('X-Server-Key','')
        if not k or k!=PASSWORD: return False
        return self.client_address[0]==FRIEND_SERVER_IP
    def _a(self):
        au=self.headers.get('Authorization',''); ci=self.headers.get('X-Computer-ID','')
        if not au.startswith('Bearer '): return None,None,False,"no",None
        tok=au[7:].strip(); ts=lt()
        if tok not in ts: return None,None,False,"inv",None
        ti=ts[tok]; ib=ti.get('is_computer',False)
        if not ib and ti.get('pending_id'):
            us=lu(); pid=ti.get('pending_id')
            if pid in us and us[pid].get('is_bot'): ib=True
        if ib and ci:
            ok,r,sd=vs(tok,ci,self.client_address[0])
            if not ok: return tok,ib,False,r,sd
        return tok,ib,True,"ok",ti
    def do_OPTIONS(self):
        try:
            self.send_response(200)
            if ALLOWED_ORIGINS:
                o=self.headers.get('Origin','')
                if o in ALLOWED_ORIGINS: self.send_header('Access-Control-Allow-Origin',o)
            self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type, bypass-tunnel-reminder, X-Computer-ID, X-Server-Key')
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
            self.end_headers()
        except: pass
    def do_GET(self):
        try: self._get()
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e: print(f"[API] GET err: {e}",flush=True)
    def _get(self):
        if not API_EN: self._j(503,{"error":"Disabled"}); return
        tok,ib,v,r,ti=self._a(); p=self.path.split('?')[0]
        if p=='/api/health':
            try: check_tunnel_health()
            except: pass
            with tunnel_health_lock: h=dict(tunnel_health)
            h.update(bot_status='running',bot_version='17.25',bot_uptime_sec=bot_uptime_sec(),
                     bot_uptime=fmt_duration(bot_uptime_sec()),
                     server_uptime_sec=int(time.time()-server_online_since) if server_online_since else 0,
                     registered_bots=sum(1 for u in lu().values() if u.get('is_bot')),total_pastes=len(lp()))
            self._j(200,h); return
        if p=='/api/reload':
            if not tok: self._j(401,{"error":"no token"}); return
            if not v: self._j(403,{"error":"invalid token"}); return
            threading.Thread(target=lambda: force_reload_tunnel("api_request"),daemon=True).start()
            self._j(200,{"ok":True,"message":"Tunnel reload requested"}); return
        if p=='/api/url':
            update_url_from_log(); u=tunnel()
            if u: self._j(200,{"url":u,"timestamp":datetime.now(MSK).isoformat()})
            else: self._j(503,{"error":"no"})
            return
        if p=='/api/relay_url':
            u=get_current_tunnel_url()
            if u: self._j(200,{"url":u,"timestamp":datetime.now(MSK).isoformat(),"channel":f"https://t.me/s/{CHANNEL_USERNAME}","relay":"telegram"})
            else: self._j(503,{"error":"no tunnel yet"})
            return
        if p=='/api/check':
            q=self.path.split('?')[1] if '?' in self.path else ''
            pa=dict(x.split('=') for x in q.split('&') if '=' in x); pid=pa.get('id','')
            if not pid: self._j(400,{"error":"no id"}); return
            pe=lpend()
            if pid not in pe: self._j(404,{"error":"no"}); return
            s=pe[pid].get('status','pending'); rs={"status":s,"pending_id":pid}
            if s=='approved': rs.update({"token":pe[pid].get('token')})
            self._j(200,rs); return
        if p.startswith('/api/players') or p.startswith('/api/player/') or p.startswith('/api/locations'):
            if not self._check_friend_auth(): self._j(403,{"error":"Unauthorized"}); return
            if p=='/api/players/list':
                pl=[f.stem for f in PLAYERS_DIR.glob('*.txt')]; self._j(200,{"players":pl,"count":len(pl)}); return
            elif p=='/api/players/all':
                res={}
                for f in PLAYERS_DIR.glob('*.txt'):
                    try:
                        with open(f,'r',encoding='utf-8') as fp: res[f.stem]=fp.read()
                    except: res[f.stem]=""
                self._j(200,res); return
            elif p.startswith('/api/player/'):
                name=p.split('/')[-1]
                if not name or not re.match(r'^[A-Za-z0-9_]{2,16}$',name): self._j(400,{"error":"invalid name"}); return
                fp=PLAYERS_DIR/f"{name}.txt"
                if not fp.exists(): self._j(404,{"error":"Player not found"}); return
                try:
                    parsed=[]
                    with open(fp,'r',encoding='utf-8') as f:
                        for line in f.read().strip().split('\n'):
                            parts=line.split('|')
                            if len(parts)>=13:
                                try:
                                    e={"time":parts[0],"x":float(parts[1].split(',')[0]),"y":float(parts[1].split(',')[1]),"z":float(parts[1].split(',')[2]),
                                       "dimension":parts[2],"health":float(parts[3]),"maxHealth":float(parts[4]),"eyeHeight":float(parts[5]),
                                       "yaw":float(parts[6]),"pitch":float(parts[7]),"status":parts[8],
                                       "in_tab":parts[9]=="true","vanish":parts[10]=="true","important":parts[11]=="true","online_sec":int(parts[12])}
                                    if len(parts)>=14: e["gamemode"]=parts[13]
                                    parsed.append(e)
                                except: continue
                    self._j(200,{"name":name,"history":parsed,"count":len(parsed)}); return
                except Exception as e: self._j(500,{"error":str(e)}); return
            elif p=='/api/locations/list': self._j(200,{"locations":load_locations()}); return
            self._j(404,{"error":"Not found"}); return
        if not v:
            if r=="intr": self._j(403,{"error":"Intrusion","code":"INTRUSION"}); return
            self._j(401,{"error":"Invalid"}); return
        if p=='/api/me':
            ts=lt()
            if tok in ts:
                td=ts[tok]; rs={"ok":True,"computer_id":td.get('computer_id')}
                if ib:
                    us=lu(); pid=ti.get('pending_id'); um='normal'; up=[]; hbi=30
                    if pid and pid in us:
                        um=us[pid].get('mode','normal'); up=us[pid].get('assigned_pastes',[]); hbi=us[pid].get('heartbeat_interval',30)
                    rs.update({"role":"bot","assigned_pastes":up,"mode":um,"heartbeat_interval":hbi})
                else: rs.update({"role":"human"})
                self._j(200,rs)
            else: self._j(401,{"error":"Invalid"})
            return
        if p.startswith('/api/paste/'):
            raw=p[len('/api/paste/'):]
            try: n=unquote(raw).lower()
            except: n=raw.lower()
            n=tr(n,MAX_PN)
            if ib:
                us=lu(); pid=ti.get('pending_id')
                al=[x.lower() for x in us[pid].get('assigned_pastes',[])] if pid and pid in us else []
                if not al or n not in al:
                    rt(tok,"PANIC"); na("🚨 <b>PANIC!</b>")
                    self._j(403,{"error":"PANIC","code":"PANIC"}); return
            for x in lp():
                if x['name'].lower()==n:
                    c=dec(x['content'])
                    if not c: self._j(500,{"error":"decrypt"}); return
                    self._j(200,{"name":x['name'],"content":c,"hash":x.get('hash',chash(c))}); return
            self._j(404,{"error":"no"}); return
        if p=='/api/pastes':
            if ib: self._j(403,{"error":"no"}); return
            ps=lp()
            self._j(200,{"pastes":[{"name":x['name'],"creator":x.get('cn','API'),"hash":x.get('hash')} for x in ps],"count":len(ps)}); return
        self._j(404,{"error":"no"})
    def do_POST(self):
        try: self._post()
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e: print(f"[API] POST err: {e}",flush=True)
    def _post(self):
        if not API_EN: self._j(503,{"error":"Disabled"}); return
        tok,ib,v,r,ti=self._a(); p=self.path.split('?')[0]
        b=self._b()
        if b is None: self._j(413,{"error":"payload too large"}); return
        ci=self.headers.get('X-Computer-ID','')
        if p=='/api/player_data':
            try:
                d=json.loads(b) if b else {}
                process_player_data(d)
                self._j(200,{"ok":True,"processed":len(d.get('players',[]))}); return
            except Exception as e: self._j(500,{"error":str(e)}); return
        if p=='/api/locations/create':
            if not self._check_friend_auth(): self._j(403,{"error":"Unauthorized"}); return
            try:
                d=json.loads(b) if b else {}
                name=d.get('name'); pts=d.get('points',[])
                if not name or len(pts)<3: self._j(400,{"error":"Need name and 3+ points"}); return
                locs=load_locations(); locs[name]=pts; save_locations(locs)
                self._j(201,{"ok":True,"location":name}); return
            except Exception as e: self._j(500,{"error":str(e)}); return
        if p=='/api/locations/delete':
            if not self._check_friend_auth(): self._j(403,{"error":"Unauthorized"}); return
            try:
                d=json.loads(b) if b else {}
                name=d.get('name')
                if not name: self._j(400,{"error":"Need name"}); return
                locs=load_locations()
                if name in locs: del locs[name]; save_locations(locs); self._j(200,{"ok":True}); return
                self._j(404,{"error":"Not found"}); return
            except Exception as e: self._j(500,{"error":str(e)}); return
        if p=='/api/login':
            client_ip=self.client_address[0]
            ok,count=check_rate_limit(f"login:{client_ip}")
            if not ok:
                self._j(429,{"error":"rate limit","retry_after":RATE_LIMIT_WINDOW}); log_failed_login(client_ip,"rate limit"); return
            try: d=json.loads(b) if b else {}
            except: d={}
            pw=d.get('password',''); n=d.get('name','PC_'+uuid.uuid4().hex[:6]); lci=d.get('computer_id',ci or 'unk')
            if pw!=PASSWORD:
                self._j(401,{"error":"Wrong password"}); log_failed_login(client_ip,"wrong password"); return
            us=lu(); ts=lt()
            for uid,ud in us.items():
                if ud.get('is_bot') and ud.get('computer_id')==lci:
                    et=ud.get('api_token')
                    if et and et in ts:
                        self._j(200,{"ok":True,"status":"already_registered","token":et,"name":n,"computer_id":lci}); return
            pid=str(uuid.uuid4()); ft=str(uuid.uuid4())
            pe=lpend()
            pe[pid]={'token':ft,'name':n,'computer_id':lci,'password_ok':True,'status':'pending','created_at':datetime.now(MSK).isoformat(),'msgs':{}}
            spend(pe)
            ts[ft]={'name':n,'computer_id':lci,'created_at':datetime.now(MSK).isoformat(),'is_computer':True,'pending_id':pid}
            st(ts)
            us[pid]={'name':n,'computer_id':lci,'username':"pc_"+pid[:8],'is_bot':True,'is_admin':False,'mode':'normal',
                     'assigned_pastes':[],'registered_at':datetime.now(MSK).isoformat(),'api_token':ft,'heartbeat_interval':30}
            su(us)
            pe[pid]['status']='approved'; spend(pe)
            threading.Thread(target=san,args=(pid,n,lci),daemon=True).start()
            self._j(200,{"ok":True,"status":"approved","token":ft}); return
        if p=='/api/bind':
            if not tok: self._j(401,{"error":"no"}); return
            if not ib: self._j(403,{"error":"no"}); return
            self._j(200,{"ok":True}); return
        if p=='/api/heartbeat':
            if not ib: self._j(403,{"error":"no"}); return
            try: d=json.loads(b) if b else {}
            except: d={}
            cv=ti.get('computer_id')
            if not cv: self._j(400,{"error":"no cid"}); return
            hb=lhb()
            hb[cv]={'last_seen':datetime.now(MSK).isoformat(),'name':ti.get('name'),'mode':d.get('mode'),
                    'scripts_running':d.get('scripts_running',[]),'strikes':d.get('strikes',0)}
            shb(hb); self._j(200,{"ok":True}); return
        if p.startswith('/api/paste/'):
            if not v: self._j(401,{"error":"no"}); return
            if ib: self._j(403,{"error":"no"}); return
            raw=p[len('/api/paste/'):]
            try: n=unquote(raw).lower()
            except: n=raw.lower()
            n=tr(n,MAX_PN)
            try:
                d=json.loads(b) if b else {}; c=d.get('content',b)
            except: c=b
            if not c: self._j(400,{"error":"empty"}); return
            e=enc(c)
            if not e: self._j(500,{"error":"enc"}); return
            ps=lp(); f=None
            for i,x in enumerate(ps):
                if x['name'].lower()==n: f=i; break
            if f is not None:
                ps[f]['content']=e; ps[f]['hash']=chash(c); ps[f]['edited_at']=datetime.now(MSK).isoformat(); sp(ps)
                self._j(200,{"ok":True,"action":"updated","name":n})
            else:
                ps.append({'name':n,'content':e,'hash':chash(c),'cid':0,'cn':'API','created_at':datetime.now(MSK).isoformat()})
                sp(ps); self._j(201,{"ok":True,"action":"created","name":n})
            return
        self._j(404,{"error":"no"})

def start_api():
    if not API_EN: print("API disabled",flush=True); return
    while True:
        srv=None
        try:
            print(f"[API] Starting on {PORT}...",flush=True)
            srv=TS(('0.0.0.0',PORT),AH); srv.timeout=5
            print("[API] Ready v17.25",flush=True)
            srv.serve_forever()
        except OSError as e:
            if e.errno==98: os.system(f"fuser -k {PORT}/tcp 2>/dev/null"); time.sleep(2)
            else: time.sleep(5)
        except Exception as e: print(f"[API] err: {e}",flush=True); time.sleep(5)
        finally:
            if srv:
                try: srv.server_close()
                except: pass

def main():
    print("Starting bot v17.25 (SSH+cloudflared failover + POST /api/reload + all fixes)...",flush=True)
    load_online_tracking()
    update_url_from_log()
    threading.Thread(target=start_tunnel,daemon=True).start()
    threading.Thread(target=tunnel_watchdog_loop,daemon=True).start()
    time.sleep(2)
    threading.Thread(target=start_api,daemon=True).start()
    threading.Thread(target=site_checker_loop,daemon=True).start()
    threading.Thread(target=watcher_loop,daemon=True).start()
    threading.Thread(target=tunnel_health_loop,daemon=True).start()
    threading.Thread(target=vanish_checker_loop,daemon=True).start()
    threading.Thread(target=status_auto_refresh_loop,daemon=True).start()
    threading.Thread(target=lambda:(time.sleep(5),update_command_menus()),daemon=True).start()
    print("Bot ready! Relay: @capscraft_relay",flush=True)
    try:
        bot.infinity_polling(timeout=60,long_polling_timeout=60,skip_pending=False)
    finally:
        _tee_out.close(); _tee_err.close()

if __name__=='__main__':
    main()
