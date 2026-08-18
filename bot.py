#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bot v17.27 — FULL cool UI + correct capscraft parse + 5G (SSH+cloudflared) + survivability"""
import sys, os, io, json, base64, socket, threading, time, uuid, hashlib, re, subprocess
import html as html_lib, urllib.request
from urllib.parse import unquote
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from datetime import datetime, timezone, timedelta
import telebot
from telebot import types

CHANNEL_ID=-1004388932854; CHANNEL_USERNAME="capscraft_relay"
BASE=Path.home()/"telegram-bot"; BASE.mkdir(parents=True,exist_ok=True)
CFG=BASE/"config.json"; USERS=BASE/"users.json"; PASTES=BASE/"pastes.json"
STATES=BASE/"user_states.json"; TOKENS=BASE/"api_tokens.json"; PENDING=BASE/"pending_tokens.json"
TUNNEL=BASE/"tunnel_url.txt"; HB=BASE/"heartbeats.json"; SITE_STATUS_FILE=BASE/"site_status.json"
TUNNEL_HEALTH_FILE=BASE/"tunnel_health.json"; TUNNEL_STATE_FILE=BASE/"tunnel_state.json"
ONLINE_TRACK_FILE=BASE/"online_tracking.json"; FALLBACK_URL_FILE=BASE/"pending_url_post.txt"
RUNTIME_LOG=BASE/"runtime.log"; PLAYERS_DIR=BASE/"players"; PLAYERS_DIR.mkdir(exist_ok=True)
LOCATIONS_FILE=BASE/"locations.json"; CLOUDFLARED_BIN=BASE/"cloudflared"
KNOWN={'start','help','past','all','api','api_reload','log','log_clear','status','menu'}
SITE_URL="https://gmd.capscraft.com"; FRIEND_SERVER_IP="185.26.120.251"
TRUSTED_PLAYERS={"5183248850":"Gishta1","5602435561":"Rainy42","5370523250":"FFFFFFFFF12324"}
TRUSTED_PLAYERS_INT={int(k):v for k,v in TRUSTED_PLAYERS.items()}
MAX_CONTENT_LENGTH=10*1024*1024; MAX_HISTORY=10000; VANISH_GRACE=30; VANISH_NOTIFY_CD=60
MSK=timezone(timedelta(hours=3)); BOT_START=time.time()
active_status_messages={}; active_status_lock=threading.Lock(); STATUS_REFRESH_INTERVAL=5
dead_chats=set()

try: cfg=json.load(open(CFG))
except Exception as e: print(f"FATAL: config: {e}",flush=True); sys.exit(106)
BOT_TOKEN=cfg.get("bot_token","")
if not BOT_TOKEN or BOT_TOKEN=="YOUR_BOT_TOKEN_HERE": sys.exit(107)
PASSWORD=cfg.get("password","")
KEY=cfg.get("encryption_key","default").encode()
PROTECTED=set(cfg.get("protected_users",[]))
MAX_N=cfg.get("max_name_length",12); MAX_PN=cfg.get("max_paste_name_length",20)
PER=cfg.get("items_per_page",5); PORT=cfg.get("api_port",8080)
API_EN=cfg.get("api_enabled",True); PROXY=cfg.get("proxy_url")

def lip():
    try:
        s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('8.8.8.8',80)); ip=s.getsockname()[0]; s.close(); return ip
    except: return "127.0.0.1"
LIP=lip()
if PROXY: telebot.apihelper.proxy={"http":PROXY,"https":PROXY}
bot=telebot.TeleBot(BOT_TOKEN)

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
            with open(RUNTIME_LOG,'w',encoding='utf-8') as f: f.write(f"[{datetime.now().isoformat()}] Log cleared by admin\n")
    except: pass

# ================= ТУННЕЛЬ: SSH + CLOUDFLARED (5G) + ЖИВУЧЕСТЬ =================
tunnel_process=None; cloudflared_process=None; current_tunnel_url=None
tunnel_lock=threading.Lock(); tunnel_last_activity=time.time(); tunnel_type=None

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
def post_url_to_channel(url,reason="new",retries=5):
    now=datetime.now(MSK).strftime('%H:%M:%S')
    msg=(f"🔄 <b>Туннель {'обновлён' if reason=='new' else 'переподключён'}</b>\n\n🌐 <code>{url}</code>\n\n⏰ {now}\n📡 <code>t.me/s/{CHANNEL_USERNAME}</code>")
    for a in range(retries):
        try:
            bot.send_message(CHANNEL_ID,msg,parse_mode='HTML',disable_web_page_preview=True)
            print(f"[Tunnel] ✓ канал: {url}",flush=True); _flush_pending_posts(); return True
        except Exception as e:
            print(f"[Tunnel] пост attempt {a+1}/{retries}: {e}",flush=True); time.sleep(3)
    try:
        with open(FALLBACK_URL_FILE,'a',encoding='utf-8') as f: f.write(f"{now}|{url}|{reason}\n")
    except: pass
    return False
def _flush_pending_posts():
    if not FALLBACK_URL_FILE.exists(): return
    try:
        lines=FALLBACK_URL_FILE.read_text().strip().split('\n'); FALLBACK_URL_FILE.write_text('')
        for line in lines:
            if not line.strip(): continue
            parts=line.split('|',2)
            if len(parts)>=2:
                bot.send_message(CHANNEL_ID,f"📬 <b>Отложенный URL</b>\n\n🌐 <code>{parts[1]}</code>",parse_mode='HTML',disable_web_page_preview=True)
    except: pass

def ensure_cloudflared():
    try:
        if CLOUDFLARED_BIN.exists() and os.access(str(CLOUDFLARED_BIN),os.X_OK): return True
        m=subprocess.run("uname -m",shell=True,capture_output=True,text=True).stdout.strip()
        arch={'aarch64':'arm64','arm64':'arm64','armv7l':'arm','x86_64':'amd64'}.get(m,'arm64')
        url=f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}"
        print(f"[Tunnel] скачиваю cloudflared ({arch})...",flush=True)
        if os.system(f'curl -sL --max-time 180 -o {CLOUDFLARED_BIN} {url}')==0 and CLOUDFLARED_BIN.exists():
            os.chmod(str(CLOUDFLARED_BIN),0o755); print("[Tunnel] ✓ cloudflared установлен",flush=True); return True
    except Exception as e: print(f"[Tunnel] cloudflared install err: {e}",flush=True)
    return False

def ssh_session_once():
    global tunnel_process,current_tunnel_url,tunnel_type,tunnel_last_activity
    started=time.time(); p=None
    try:
        p=subprocess.Popen(['ssh','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null',
            '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-o','TCPKeepAlive=yes',
            '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15','-R',f'80:localhost:{PORT}','nokey@localhost.run'],
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
                    post_url_to_channel(nu,"reconnect" if ou else "new")
                    try:
                        with open(TUNNEL,'w',encoding='utf-8') as f: f.write(nu)
                        save_tunnel_state({'last_url':nu,'type':'ssh'})
                    except: pass
        p.wait()
    except Exception as e: print(f"[SSH] err: {e}",flush=True)
    try:
        if p: p.kill()
    except: pass
    return (time.time()-started)>60

def cloudflared_session_once():
    global cloudflared_process,current_tunnel_url,tunnel_type,tunnel_last_activity
    started=time.time(); p=None
    try:
        p=subprocess.Popen([str(CLOUDFLARED_BIN),'tunnel','--url',f'http://localhost:{PORT}','--no-autoupdate'],
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        with tunnel_lock: cloudflared_process=p; tunnel_type='cloudflared'
        for line in iter(p.stdout.readline,''):
            line=line.strip()
            if not line: continue
            tunnel_last_activity=time.time(); print(f"[Cloudflared] {line}",flush=True)
            m=re.search(r'(https://[a-z0-9-]+\.trycloudflare\.com)',line)
            if m:
                nu=m.group(1)
                with tunnel_lock: ou=current_tunnel_url; current_tunnel_url=nu
                if nu!=ou:
                    post_url_to_channel(nu,"reconnect" if ou else "new")
                    try:
                        with open(TUNNEL,'w',encoding='utf-8') as f: f.write(nu)
                        save_tunnel_state({'last_url':nu,'type':'cloudflared'})
                    except: pass
        p.wait()
    except Exception as e: print(f"[Cloudflared] err: {e}",flush=True)
    try:
        if p: p.kill()
    except: pass
    return (time.time()-started)>60

def ssh_port_open():
    try:
        s=socket.socket(); s.settimeout(5); s.connect(("localhost.run",22)); s.close(); return True
    except: return False

def start_tunnel():
    """Супервайзер: SSH основной, cloudflared (443) как 5G-фолбэк, авто-переключение."""
    global tunnel_type
    st=load_tunnel_state()
    if st.get('last_url'):
        with tunnel_lock: current_tunnel_url=st['last_url']
    if subprocess.run("which ssh",shell=True,capture_output=True).returncode!=0:
        os.system("pkg install -y openssh 2>&1 | tail -3")
    if not (Path.home()/".ssh"/"id_rsa").exists():
        os.system('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa >/dev/null 2>&1')
    have_cf=ensure_cloudflared()
    backend='ssh' if ssh_port_open() else ('cloudflared' if have_cf else 'ssh')
    print(f"[Tunnel] супервайзер запущен (backend={backend})",flush=True)
    ssh_streak=0; cf_streak=0
    while True:
        if backend=='ssh':
            healthy=ssh_session_once(); ssh_streak=0 if healthy else ssh_streak+1
            if not healthy and ssh_streak>=3 and have_cf:
                print("[Tunnel] SSH нестабилен → cloudflared (443)",flush=True); backend='cloudflared'; ssh_streak=0
            elif not healthy: time.sleep(min(1+ssh_streak,8))
        else:
            healthy=cloudflared_session_once(); cf_streak=0 if healthy else cf_streak+1
            if not healthy and cf_streak>=3:
                print("[Tunnel] cloudflared нестабилен → SSH",flush=True); backend='ssh'; cf_streak=0
            elif not healthy: time.sleep(min(1+cf_streak,8))

def force_reload_tunnel(reason="manual"):
    global tunnel_last_activity,tunnel_process,cloudflared_process
    print(f"[Tunnel-RELOAD] {reason}",flush=True)
    with tunnel_lock:
        for pr in (tunnel_process,cloudflared_process):
            if pr is not None:
                try: pr.terminate(); pr.wait(timeout=3)
                except: 
                    try: pr.kill()
                    except: pass
        tunnel_process=None; cloudflared_process=None
    tunnel_last_activity=time.time(); return True

def tunnel_watchdog_loop():
    global tunnel_last_activity
    time.sleep(60)
    while True:
        try:
            if get_current_tunnel_url():
                with tunnel_lock: p=tunnel_process; cp=cloudflared_process
                act=p if (p and p.poll() is None) else (cp if (cp and cp.poll() is None) else None)
                if act is None: tunnel_last_activity=time.time()
                else:
                    idle=time.time()-tunnel_last_activity
                    if idle>120: force_reload_tunnel("watchdog_stale"); tunnel_last_activity=time.time()
        except: pass
        time.sleep(15)
def get_current_tunnel_url():
    with tunnel_lock: return current_tunnel_url
def get_current_tunnel_type():
    with tunnel_lock: return tunnel_type or 'unknown'
def tunnel():
    u=get_current_tunnel_url()
    if u: return u
    try:
        if TUNNEL.exists():
            t=TUNNEL.read_text().strip()
            if t.startswith('http'): return t
    except: pass
    return cfg.get('tunnel_url')
def bot_uptime_sec(): return int(time.time()-BOT_START)

# ================= БАЗА =================
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
        import tempfile as tf
        fd,tp=tf.mkstemp(dir=str(p.parent),suffix='.tmp')
        with os.fdopen(fd,'w',encoding='utf-8') as f: json.dump(d,f,indent=2,ensure_ascii=False)
        os.replace(tp,p)
    except: pass
def lu(): return rj(USERS,{})
def su(u): wj(USERS,u)
def lp(): return rj(PASTES,[])
def sp(p): wj(PASTES,p)
def ls(): return rj(STATES,{})
def ss(s): wj(STATES,s)
def lt(): return rj(TOKENS,{})
def st(t): wj(TOKENS,t)
def lpend(): return rj(PENDING,{})
def spend(p): wj(PENDING,p)
def lhb(): return rj(HB,{})
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
    n=d.get('name')
    if n==TECH: return True
    return bool(n and n in PROTECTED)
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
    n=d.get('name')
    if n==TECH: return "tech"
    if n in PROTECTED or d.get('is_admin'): return "admin"
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
def sets(u,d): s=ls(); s[str(u)]=d; ss(s)
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

def auto_register_trusted(uid):
    try: uid=int(uid)
    except: return False
    if uid not in TRUSTED_PLAYERS_INT: return False
    if reg(uid): return True
    name=TRUSTED_PLAYERS_INT[uid]; us=lu()
    us[str(uid)]={'name':name,'username':f"player_{uid}",'is_bot':False,'is_admin':(name==TECH or name in PROTECTED),'registered_at':datetime.now(MSK).isoformat(),'trusted':True}
    su(us); print(f"[Auth] auto-registered {name}",flush=True); return True

player_online_since={}; server_online_since=None
def load_online_tracking():
    global player_online_since,server_online_since
    try:
        d=json.load(open(ONLINE_TRACK_FILE)); player_online_since=d.get('players',{}); server_online_since=d.get('server')
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
    td=ts[tok]; rc=td.get('computer_id')
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

# ================= PLAYER TRACKING + ВАНИШ =================
player_positions={}; player_zones={}; player_vanish_since={}; player_file_lines={}
radar_first_seen={}; vanish_cooldown={}
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
    return not (any(sp[i]>sp[i-1]+3 for i in range(1,len(sp))) or any(sp[i]<sp[i-1]-3 for i in range(1,len(sp))))
def update_zone_status(name,x,z): return "standing"
def is_player_in_tab(name):
    try:
        if SITE_STATUS_FILE.exists():
            d=json.load(open(SITE_STATUS_FILE))
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
    except: pass
    player_file_lines.setdefault(name,0); player_file_lines[name]+=1
    if player_file_lines[name]>MAX_HISTORY*1.2:
        try:
            lines=fp.read_text().strip().split('\n')
            if len(lines)>MAX_HISTORY: fp.write_text('\n'.join(lines[-MAX_HISTORY:]))
            player_file_lines[name]=MAX_HISTORY
        except: pass
def notify_vanish(name,x,z,dim):
    admins=aia()
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
        except: pass
def clear_vanish_notifications():
    for a in aia():
        s=gs(a) or {}
        if 'vanish_msg_id' in s:
            try: bot.delete_message(a,s['vanish_msg_id'])
            except: pass
            s.pop('vanish_msg_id',None); sets(a,s)
def clear_vanish_for_player(name):
    player_vanish_since.pop(name,None); radar_first_seen.pop(name,None); clear_vanish_notifications()
def process_player_data(data):
    now=time.time()
    players_in_update=data.get('players',[])
    if not isinstance(players_in_update,list): return
    current_names={p.get('name') for p in players_in_update if isinstance(p,dict) and p.get('name')}
    for name in list(player_vanish_since.keys()):
        if name not in current_names: clear_vanish_for_player(name)
    for p in players_in_update:
        if not isinstance(p,dict): continue
        name=p.get('name')
        if not isinstance(name,str) or not name.strip(): continue
        name=name.strip()
        if len(name)<2 or len(name)>16 or not re.match(r'^[A-Za-z0-9_]+$',name): continue
        try:
            x=float(p.get('x',0)); y=float(p.get('y',0)); z=float(p.get('z',0))
            health=float(p.get('health',20)); maxhealth=float(p.get('maxHealth',20)); eye=float(p.get('eyeHeight',1.62))
            yaw=float(p.get('yaw',0)); pitch=float(p.get('pitch',0)); ts=float(p.get('timestamp',now))
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
        except: pass
        time.sleep(5)

# ================= TUNNEL HEALTH =================
tunnel_health={'status':'unknown','url':None,'checks_total':0,'checks_ok':0,'last_error':None}
def check_tunnel_health():
    try:
        url=tunnel()
        if not url: tunnel_health['status']='no_url'; return
        tunnel_health['url']=url; tunnel_health['checks_total']+=1
        local_ok=False
        try:
            with urllib.request.urlopen(f'http://localhost:{PORT}/api/url',timeout=5) as r: local_ok=r.status==200
        except: pass
        try:
            req=urllib.request.Request(f'{url}/api/url',headers={'bypass-tunnel-reminder':'true','User-Agent':'HealthCheck/1.0'})
            with urllib.request.urlopen(req,timeout=10) as r:
                if r.status==200:
                    tunnel_health.update(status='ok',checks_ok=tunnel_health['checks_ok']+1,last_error=None)
                    return
        except Exception as e: tunnel_health['last_error']=str(e)[:100]
        tunnel_health['status']='tunnel_down' if local_ok else 'bot_down'
    except: pass
def tunnel_health_loop():
    time.sleep(5)
    while True:
        try: check_tunnel_health()
        except: pass
        time.sleep(60)
def get_tunnel_status_text():
    s=tunnel_health.get('status','unknown'); url=tunnel_health.get('url') or tunnel() or 'не настроен'
    tt=get_current_tunnel_type()
    if s=='ok':
        tot=tunnel_health.get('checks_total',0); okc=tunnel_health.get('checks_ok',0)
        rate=int(okc/tot*100) if tot else 100
        return f"🟢 <b>Работает</b> ({tt})\n{ui_row('Успех',f'{rate}%')}\n{ui_row('URL',url)}"
    if s=='tunnel_down': return f"🟡 <b>Туннель недоступен</b> ({tt})\n{ui_row('URL',url)}"
    if s=='bot_down': return "🔴 <b>Бот недоступен</b>"
    return f"❓ <b>Статус:</b> {safe(s)}"
def update_url_from_log():
    u=get_current_tunnel_url()
    if u:
        try: TUNNEL.write_text(u); return u
        except: pass
    return None

# ================= ПАРСИНГ CAPSCRAFT (ИСПРАВЛЕНО, несколько фолбэков) =================
def parse_site_status():
    global server_online_since
    try:
        req=urllib.request.Request(SITE_URL,headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req,timeout=15) as r: html_text=r.read().decode('utf-8')
        is_online=bool(re.search(r"minecraftserverinfo\s+isonline",html_text,re.IGNORECASE)) or ('"online"' in html_text and '"online":true' in html_text)
        players_list=[]
        # Фолбэк 1: строки игроков виджета
        for nick in re.findall(r"<tr class='player'>\s*<td>\s*<img[^>]+alt='([A-Za-z0-9_]{3,16})s Avatar'[^>]*>.*?playeronline",html_text,re.IGNORECASE|re.DOTALL):
            if nick not in players_list: players_list.append(nick)
        # Фолбэк 2: любые аватарки с Online рядом
        if not players_list:
            for row in re.findall(r"<tr[^>]*class='player[^>]*>(.*?)</tr>",html_text,re.IGNORECASE|re.DOTALL):
                if 'online' in row.lower():
                    m=re.search(r"alt='([A-Za-z0-9_]{3,16})s Avatar'",row,re.IGNORECASE)
                    if m and m.group(1) not in players_list: players_list.append(m.group(1))
        # Фолбэк 3: JSON-виджет
        if not players_list:
            for nick in re.findall(r'"name"\s*:\s*"([A-Za-z0-9_]{3,16})"',html_text):
                if nick not in players_list: players_list.append(nick)
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
            'server_online_since':server_online_since}
        with open(SITE_STATUS_FILE,'w',encoding='utf-8') as f: json.dump(result,f,indent=2,ensure_ascii=False)
        return result
    except Exception as e:
        print(f"[Site] err: {e}",flush=True); return None
def site_checker_loop():
    while True:
        try:
            s=parse_site_status()
            if s: print(f"[Site] {'🟢' if s['online'] else '🔴'} ({s['players_online']})",flush=True)
        except: pass
        time.sleep(60)
def watcher_loop():
    GRACE=180
    while True:
        try:
            time.sleep(30)
            if not SITE_STATUS_FILE.exists(): continue
            if not json.load(open(SITE_STATUS_FILE)).get('online'): continue
            heartbeats=lhb(); users=lu(); now=datetime.now()
            try: gk=json.load(open(CFG)).get('kiktime_minutes',10)*60
            except: gk=600
            for uid,user in list(users.items()):
                try:
                    if not user.get('is_bot') or user.get('mode')=='service': continue
                    kt=user.get('kiktime_override'); ks=(kt*60) if kt else gk
                    cid=user.get('computer_id')
                    if not cid or cid not in heartbeats: continue
                    lsv=heartbeats[cid].get('last_seen')
                    if not lsv: continue
                    delta=(now-datetime.fromisoformat(lsv)).total_seconds()
                    if delta>ks:
                        at=user.get('api_token')
                        if at: rt(at,f"Авто-кик: offline {int(delta/60)} мин")
                        hb2=lhb()
                        if cid in hb2: del hb2[cid]; shb(hb2)
                        if uid in users: del users[uid]; su(users)
                except: pass
        except: pass

# ================= СТАТУС (ПОЛНЫЙ "КРУТОЙ" ИНТЕРФЕЙС) =================
def build_help_text():
    return (f"{ui_header('Справка v17.27','📖')}\n\n<b>🚀 Основные команды:</b>\n<code>/start</code> — Запуск\n<code>/menu</code> — Меню\n<code>/help</code> — Справка\n<code>/status</code> — Статус (авто 5с)\n<code>/api</code> — API\n<code>/api_reload</code> — Перезагрузить туннель\n\n<b>📋 Пасты:</b>\n<code>/past</code> — Список\n<code>/past add name</code> — Создать\n<code>/past edit N</code> — Изменить\n<code>/past delete N</code> — Удалить\n\n<b>👥 Компьютеры:</b>\n<code>/all</code> — Список\n<code>/all assign COMP paste</code> — Привязать\n<code>/all perform COMP PASTE</code> — Запустить\n<code>/all kick COMP</code> — Кикнуть")
def build_status_text():
    try: status=parse_site_status()
    except: status=None
    if not status:
        try:
            if SITE_STATUS_FILE.exists(): status=json.load(open(SITE_STATUS_FILE))
        except: pass
    if not status: return None
    state=ui_status(status.get('online')); players_list=status.get('players_list',[]); now=time.time()
    txt=(f"{ui_header('Статус сервера','🌐')}\n\n{state}\n\n📡 <b>Адрес:</b> <code>{safe(status.get('address','gmd.capscraft.com'))}</code>\n")
    if status.get('online') and server_online_since: txt+=f"⏱ <b>Сервер онлайн:</b> <code>{fmt_duration(now-server_online_since)}</code>\n"
    txt+="\n"
    coords={}
    for name,pos in player_positions.items():
        if pos: coords[name.lower()]=pos[-1]
    if players_list:
        txt+=f"<b>👤 Онлайн ({len(players_list)}):</b>\n"
        for nick in players_list[:30]:
            c=coords.get(nick.lower()); v="🚨" if nick in player_vanish_since else "🟢"
            g=gm_icon(c.get('gamemode')) if c else ""
            since=get_online_since(nick); dur=f" ⏱{fmt_duration(now-since)}" if since else ""
            if c: txt+=f"  • {g} <code>{safe(nick)}</code> [{c['x']:.0f}, {c['y']:.0f}, {c['z']:.0f}]{dur} {v}\n"
            else: txt+=f"  • <code>{safe(nick)}</code> 📍 нет координат{dur} {v}\n"
        if len(players_list)>30: txt+=f"  <i>... ещё {len(players_list)-30}</i>\n"
    else: txt+="<i>🔇 Никого нет онлайн</i>\n" if status.get('online') else "<i>💤 Сервер оффлайн</i>\n"
    onl_low=[p.lower() for p in players_list]
    vanished=[(n,player_positions[n][-1]) for n in player_vanish_since if n in player_positions and player_positions[n] and n.lower() not in onl_low]
    if vanished:
        txt+=f"\n<b>🚨 ВАНИШ ({len(vanished)}):</b>\n"
        for name,c in vanished:
            g=gm_icon(c.get('gamemode'))
            txt+=f"  • {g} <code>{safe(name)}</code> [{c['x']:.0f}, {c['y']:.0f}, {c['z']:.0f}] 🚨\n"
    r_total,r_on,r_off=get_radar_stats()
    radar=[(n,p[-1]) for n,p in player_positions.items() if p]
    txt+=f"\n<b>📡 Радары (всего: {r_total} | 🟢 {r_on} | 🔴 {r_off}):</b>\n"
    if radar:
        onl=[p.lower() for p in players_list]
        for name,c in radar[:20]:
            mark="🟢" if name.lower() in onl else "🚨"
            g=gm_icon(c.get('gamemode'))
            txt+=f"  • {g} <code>{safe(name)}</code> [{c['x']:.0f}, {c['y']:.0f}, {c['z']:.0f}] {mark}\n"
        if len(radar)>20: txt+=f"  <i>... ещё {len(radar)-20}</i>\n"
    else: txt+="  <i>нет данных</i>\n"
    txt+=f"\n<i>🕐 Обновлено: {msk_now().strftime('%H:%M:%S')} (авто 5с)</i>"
    return txt
def get_radar_stats():
    users=lu(); heartbeats=lhb(); now=datetime.now()
    total=on=off=0
    for uid,u in users.items():
        if not u.get('is_bot') or 'radar' not in u.get('assigned_pastes',[]): continue
        total+=1; cid=u.get('computer_id')
        if cid and cid in heartbeats:
            try:
                lsv=heartbeats[cid].get('last_seen')
                if lsv and (now-datetime.fromisoformat(lsv)).total_seconds()<120: on+=1; continue
            except: pass
        off+=1
    return total,on,off
def status_keyboard():
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Обновить",callback_data="refresh:status"),types.InlineKeyboardButton("⏸ Стоп авто",callback_data="stop_auto_refresh"))
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb
def status_auto_refresh_loop():
    while True:
        try:
            time.sleep(STATUS_REFRESH_INTERVAL)
            with active_status_lock: active_chats=list(active_status_messages.items())
            if not active_chats: continue
            txt=build_status_text()
            if not txt: continue
            kb=status_keyboard()
            for chat_id,message_id in active_chats:
                try: bot.edit_message_text(txt,chat_id,message_id,parse_mode='HTML',reply_markup=kb)
                except Exception as e:
                    err=str(e)
                    if any(k in err for k in ("MESSAGE_EDIT_TIME_LIMIT","can't be edited","chat not found","deactivated","Forbidden")):
                        with active_status_lock: active_status_messages.pop(chat_id,None)
        except: pass
def register_status_message(chat_id,message_id):
    with active_status_lock: active_status_messages[chat_id]=message_id
def unregister_status_messages(chat_id):
    with active_status_lock: active_status_messages.pop(chat_id,None)

# ================= КЛАВИАТУРЫ =================
def main_menu_keyboard(uid):
    u=lu().get(str(uid),{}); em="✅" if u.get('vanish_tracking') else "❌"
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("📋 Пасты",callback_data="menu:past"),types.InlineKeyboardButton("👥 Компьютеры",callback_data="menu:all"))
    kb.add(types.InlineKeyboardButton("🌐 Сервер",callback_data="menu:status"),types.InlineKeyboardButton("🖥 API",callback_data="menu:api"))
    kb.add(types.InlineKeyboardButton(f"🕵️ Слежение: {em}",callback_data="toggle_vanish"))
    kb.add(types.InlineKeyboardButton("❓ Помощь",callback_data="menu:help")); return kb
def back_to_menu_keyboard():
    kb=types.InlineKeyboardMarkup(); kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb
def bpk(ps,pg):
    t=len(ps); tp=max(1,(t+PER-1)//PER); pg=max(0,min(pg,tp-1)); st_=pg*PER; it=ps[st_:st_+PER]
    kb=types.InlineKeyboardMarkup(row_width=1)
    for i,p in enumerate(it):
        idx=st_+i; n=tr(p['name'],MAX_PN); c=tr(p.get('cn',''),MAX_N)
        bc=sum(1 for u in lu().values() if u.get('is_bot') and n.lower() in [x.lower() for x in u.get('assigned_pastes',[])])
        kb.add(types.InlineKeyboardButton(f"{idx+1:>2}. 📄 {safe(n)} • 👤 {safe(c)} • 🤖{bc}",callback_data="pv:"+str(idx)))
    nav=[]
    if pg>0: nav.append(types.InlineKeyboardButton("◀️",callback_data="pp:"+str(pg-1)))
    nav.append(types.InlineKeyboardButton(f"{pg+1}/{tp}",callback_data="noop"))
    if pg<tp-1: nav.append(types.InlineKeyboardButton("▶️",callback_data="pp:"+str(pg+1)))
    if nav: kb.row(*nav)
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb,pg,tp
def buk(ud,pg):
    it=list(ud.items()); t=len(it); tp=max(1,(t+PER-1)//PER); pg=max(0,min(pg,tp-1)); st_=pg*PER; ip=it[st_:st_+PER]
    kb=types.InlineKeyboardMarkup(row_width=1)
    for i,(uk,d) in enumerate(ip):
        n=tr(d.get('name') or uk,MAX_N); ic={"tech":"🛠","admin":"👑","bot":"🤖"}.get(role(uk),"👤")
        extra=""
        if d.get('is_bot'):
            m=d.get('mode','normal'); mi="🔧" if m=='service' else ("🚨" if m=='fortress' else "🔓")
            kt=f" ⏱{d.get('kiktime_override')}м" if d.get('kiktime_override') else ""
            extra=f" {mi} 📋{len(d.get('assigned_pastes',[]))}{kt}"
        kb.add(types.InlineKeyboardButton(f"{i+1:>2}. {ic} {safe(n)}{extra}",callback_data=f"av:{i}:{uk}"))
    nav=[]
    if pg>0: nav.append(types.InlineKeyboardButton("◀️",callback_data="ap:"+str(pg-1)))
    nav.append(types.InlineKeyboardButton(f"{pg+1}/{tp}",callback_data="noop"))
    if pg<tp-1: nav.append(types.InlineKeyboardButton("▶️",callback_data="ap:"+str(pg+1)))
    if nav: kb.row(*nav)
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb,pg,tp
def bbpk(uk):
    u=lu().get(uk,{}); m=u.get('mode','normal')
    kb=types.InlineKeyboardMarkup(row_width=2)
    if u.get('is_bot'):
        kb.add(types.InlineKeyboardButton("🔧 → Обычный" if m=='service' else "🔓 → Сервисный",callback_data="mode_toggle:"+uk))
        kb.add(types.InlineKeyboardButton(f"💓 {hb_category(u.get('heartbeat_interval',30))}",callback_data="hb_menu:"+uk))
        kb.add(types.InlineKeyboardButton("🚫 Кикнуть",callback_data="kick_bot:"+uk))
    kb.add(types.InlineKeyboardButton("🔙 Назад",callback_data="menu:all")); return kb
def confirm_keyboard(aid):
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("✅ Да",callback_data=f"confirm:{aid}:yes"),types.InlineKeyboardButton("❌ Нет",callback_data=f"confirm:{aid}:no")); return kb
def hb_category(sec):
    try: sec=int(sec)
    except: sec=30
    return {5:"1️⃣ Частое (5с)",30:"2️⃣ Среднее (30с)",300:"3️⃣ Долгое (5м)",600:"4️⃣ Долгое+ (10м)"}.get(sec,f"5️⃣ Кастом ({sec}с)")
def build_api_text():
    tu=tunnel(); su_=tu or ("http://"+LIP+":"+str(PORT))
    return (f"{ui_header('API Информация','🖥')}\n\n<b>⏱ Бот работает:</b> <code>{fmt_duration(bot_uptime_sec())}</code>\n\n<b>🔌 Подключение:</b>\n{ui_row('Тип','🌐 localhost.run' if get_current_tunnel_type()=='ssh' else '☁️ cloudflared (443)')}\n{ui_row('URL',su_)}\n{ui_row('Пароль',PASSWORD)}\n{ui_row('Порт',PORT)}\n\n<b>🌐 Туннель:</b>\n{get_tunnel_status_text()}")
def show_paste_profile(c,idx):
    ps=lp()
    if idx<0 or idx>=len(ps): bot.answer_callback_query(c.id,"❌"); return
    delete_last_file(c.from_user.id); p=ps[idx]; c_=dec(p['content'])
    if not c_: bot.answer_callback_query(c.id,"❌"); return
    b=[u.get('name','?') for u in lu().values() if u.get('is_bot') and p['name'].lower() in [x.lower() for x in u.get('assigned_pastes',[])]]
    txt=(f"{ui_header(p['name'],'📄')}\n\n{ui_row('👤 Автор',p.get('cn','?'))}\n{ui_row('📊 Размер',f'{len(c_)} байт')}\n{ui_row('🔐 Хеш',p.get('hash','?'))}\n")
    if b:
        txt+="\n<b>🤖 Привязан к:</b>\n"
        for n in b[:10]: txt+=f"  • <code>{safe(n)}</code>\n"
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🗑 Удалить",callback_data=f"paste_del:{idx}"),types.InlineKeyboardButton("🔙 К пастам",callback_data="menu:past"))
    try: bot.edit_message_text(txt,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=kb)
    except: pass
    send_paste_file(c.message.chat.id,c_,p['name'],c.from_user.id)

# ================= КОМАНДЫ =================
@bot.message_handler(commands=['api_reload'])
def cmd_api_reload(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌ Только администраторы"); return
    delete_last_file(m.from_user.id); unregister_status_messages(m.chat.id)
    threading.Thread(target=lambda: force_reload_tunnel("manual"),daemon=True).start()
    bot.send_message(m.chat.id,"🔄 <b>Перезагрузка туннеля...</b>",parse_mode='HTML')
@bot.message_handler(commands=['log'])
def cmd_log(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    content=get_last_log_lines()
    if not content: bot.send_message(m.chat.id,"❌ Лог пуст"); return
    fo=io.BytesIO(content.encode('utf-8')); fo.name="bot_log.log"
    bot.send_document(m.chat.id,fo,caption=f"📄 {len(content)} байт")
@bot.message_handler(commands=['log_clear'])
def cmd_log_clear(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    clear_log(); bot.send_message(m.chat.id,"✅ Лог очищен",parse_mode='HTML')
@bot.message_handler(commands=['start'])
def cmd_start(m):
    u=m.from_user.id; auto_register_trusted(u); unregister_status_messages(m.chat.id)
    if not reg(u):
        un=m.from_user.username or ("id_"+str(u)); sets(u,{'step':'wp','username':un,'is_bot':m.from_user.is_bot})
        bot.send_message(m.chat.id,f"{ui_header('Добро пожаловать','👋')}\n\n👤 <b>{safe(un)}</b>\n\n🔐 Введите пароль:",parse_mode='HTML')
    else:
        r=role(u); rt_={"tech":"🛠 Тех.админ","admin":"👑 Админ","bot":"🤖 Компьютер"}.get(r,"👤 Пользователь")
        bot.send_message(m.chat.id,f"{ui_header('С возвращением','🚀')}\n\n👤 <b>{safe(dn(u))}</b>\n{ui_row('Роль',rt_)}\n\n📱 /menu",parse_mode='HTML',reply_markup=main_menu_keyboard(u))
@bot.message_handler(commands=['menu'])
def cmd_menu(m):
    if not reg(m.from_user.id): bot.send_message(m.chat.id,"/start first"); return
    delete_last_file(m.from_user.id); unregister_status_messages(m.chat.id)
    us=lu(); bc=sum(1 for u in us.values() if u.get('is_bot'))
    bot.send_message(m.chat.id,f"{ui_header('Главное меню','📱')}\n\n<b>📊 Статистика:</b>\n{ui_row('🤖 Компьютеры',bc)}\n{ui_row('👤 Пользователи',len(us)-bc)}\n{ui_row('📄 Пасты',len(lp()))}\n\nВыберите раздел:",parse_mode='HTML',reply_markup=main_menu_keyboard(m.from_user.id))
@bot.message_handler(commands=['help'])
def cmd_help(m):
    if not reg(m.from_user.id): bot.send_message(m.chat.id,"/start first"); return
    bot.send_message(m.chat.id,build_help_text(),parse_mode='HTML',reply_markup=back_to_menu_keyboard())
@bot.message_handler(commands=['api'])
def cmd_api(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    update_url_from_log(); check_tunnel_health()
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Проверить",callback_data="check_tunnel"),types.InlineKeyboardButton("🔄 Рестарт туннеля",callback_data="reload_tunnel"))
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main"))
    bot.send_message(m.chat.id,build_api_text(),parse_mode='HTML',reply_markup=kb)
@bot.message_handler(commands=['status'])
def cmd_status(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    txt=build_status_text()
    if not txt: bot.send_message(m.chat.id,"❌ Не удалось получить статус"); return
    msg=bot.send_message(m.chat.id,txt,parse_mode='HTML',reply_markup=status_keyboard())
    register_status_message(m.chat.id,msg.message_id)
@bot.message_handler(commands=['past'])
def cmd_past(m):
    if not reg(m.from_user.id): bot.send_message(m.chat.id,"/start"); return
    pa=m.text.split()[1:]
    if not pa: spm(m.chat.id,0); return
    s=pa[0].lower()
    if s=='add':
        if len(pa)==2:
            n=tr(pa[1],MAX_PN).lower()
            if any(p['name'].lower()==n for p in lp()): bot.send_message(m.chat.id,"⚠️ Уже существует"); return
            sets(m.from_user.id,{'step':'add_file_wait','paste_name':n})
            bot.send_message(m.chat.id,f"📄 <b>Создание:</b> <code>{safe(n)}</code>\n\nОтправьте текст/файл\n/cancel",parse_mode='HTML')
        elif len(pa)>=3:
            n=tr(pa[1],MAX_PN).lower(); c=' '.join(pa[2:])
            e=enc(c)
            ps=lp(); ps.append({'name':n,'content':e,'hash':chash(c),'cid':m.from_user.id,'cn':dn(m.from_user.id)}); sp(ps)
            bot.send_message(m.chat.id,f"{ui_header('Паст создан','✅')}\n{ui_row('Имя',n)}",parse_mode='HTML')
    elif s=='edit' and len(pa)>=2:
        idx,paste=find_paste_by_arg(pa[1],lp())
        if idx is None: bot.send_message(m.chat.id,"❌"); return
        c=dec(paste['content'])
        sets(m.from_user.id,{'step':'edit_file_wait','idx':idx})
        bot.send_message(m.chat.id,f"{ui_header('Редактирование','📝')}\n<b>📄 {safe(paste['name'])}</b>\n<pre>{safe((c or '')[:500])}</pre>\n\nОтправьте текст/файл\n/cancel",parse_mode='HTML')
    elif s=='delete' and len(pa)>=2:
        idx,paste=find_paste_by_arg(pa[1],lp())
        if idx is None: bot.send_message(m.chat.id,"❌"); return
        sets(m.from_user.id,{'step':'dc','idx':idx})
        bot.send_message(m.chat.id,f"⚠️ <b>Удалить?</b>\n📄 <code>{safe(paste['name'])}</code>",parse_mode='HTML',reply_markup=confirm_keyboard(f"del_paste:{idx}"))
def spm(cid,pg,msg_to_edit=None):
    ps=lp()
    if not ps:
        txt=f"{ui_header('Пасты','📋')}\n\n<i>📭 Пусто</i>\n\n<code>/past add name text</code>"
        if msg_to_edit: edit_or_send(msg_to_edit,txt,back_to_menu_keyboard())
        else: bot.send_message(cid,txt,parse_mode='HTML',reply_markup=back_to_menu_keyboard())
        return
    kb,pg,tp=bpk(ps,pg)
    txt=f"{ui_header('Пасты','📋')}\n{ui_row('Всего',len(ps))}\n{ui_row('Страница',f'{pg+1}/{tp}')}\n\n<i>Нажмите для просмотра</i>"
    if msg_to_edit: edit_or_send(msg_to_edit,txt,kb)
    else: bot.send_message(cid,txt,parse_mode='HTML',reply_markup=kb)
@bot.message_handler(commands=['all'])
def cmd_all(m):
    if not reg(m.from_user.id): bot.send_message(m.chat.id,"/start"); return
    us=lu(); my=us.get(str(m.from_user.id))
    if not my or my.get('is_bot') or not my.get('name'): bot.send_message(m.chat.id,"⚠️ Только пользователи"); return
    pa=m.text.split()[1:]
    if not pa: sam(m.chat.id,0); return
    s=pa[0].lower()
    if s=='assign' and len(pa)>=3 and ia(m.from_user.id):
        tid,td=find_user_by_arg(pa[1],list(us.items()))
        if not tid or not td.get('is_bot'): bot.send_message(m.chat.id,"❌"); return
        pn=pa[2].lower()
        cp=td.get('assigned_pastes',[])
        if pn not in cp: cp.append(pn); us[tid]['assigned_pastes']=cp; su(us)
        bot.send_message(m.chat.id,f"{ui_header('Привязан','✅')}\n{ui_row('🤖',td.get('name',''))}\n{ui_row('📄',pn)}",parse_mode='HTML')
    elif s=='unassign' and len(pa)>=2 and ia(m.from_user.id):
        tid,td=find_user_by_arg(pa[1],list(us.items()))
        if tid: us[tid]['assigned_pastes']=[]; su(us); bot.send_message(m.chat.id,"✅ Отвязано")
    elif s=='perform' and len(pa)>=3 and ia(m.from_user.id):
        tid,td=find_user_by_arg(pa[1],list(us.items()))
        pi,paste=find_paste_by_arg(pa[2],lp()) if len(pa)>=3 else (None,None)
        if tid and paste:
            cp=td.get('assigned_pastes',[])
            if paste['name'] not in cp: cp.append(paste['name']); us[tid]['assigned_pastes']=cp; su(us)
            bot.send_message(m.chat.id,f"{ui_header('Выполнено','✅')}\n{ui_row('🤖',td.get('name',''))}\n{ui_row('📄',paste['name'])}",parse_mode='HTML')
    elif s=='kick' and len(pa)>=2 and ia(m.from_user.id):
        tid,td=find_user_by_arg(pa[1],list(us.items()))
        if tid: bot.send_message(m.chat.id,f"⚠️ <b>Кикнуть?</b>\n🤖 <code>{safe(td.get('name'))}</code>",parse_mode='HTML',reply_markup=confirm_keyboard(f"kick:{tid}"))
def sam(cid,pg,msg_to_edit=None):
    us=lu()
    if not us:
        txt=f"{ui_header('Компьютеры','👥')}\n\n<i>📭 Пусто</i>"
        if msg_to_edit: edit_or_send(msg_to_edit,txt,back_to_menu_keyboard())
        else: bot.send_message(cid,txt,parse_mode='HTML',reply_markup=back_to_menu_keyboard())
        return
    kb,pg,tp=buk(us,pg)
    txt=f"{ui_header('Компьютеры','👥')}\n{ui_row('🤖',sum(1 for u in us.values() if u.get('is_bot')))}\n{ui_row('📄 Страница',f'{pg+1}/{tp}')}\n\n<i>Нажмите для деталей</i>"
    if msg_to_edit: edit_or_send(msg_to_edit,txt,kb)
    else: bot.send_message(cid,txt,parse_mode='HTML',reply_markup=kb)
def san(pid,n,cid):
    pe=lpend()
    if pid not in pe: return
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("✅ Принять",callback_data="aa:"+pid),types.InlineKeyboardButton("❌ Отклонить",callback_data="ad:"+pid))
    for a in aia():
        try: bot.send_message(a,f"{ui_header('Запрос авторизации','🔐')}\n{ui_row('🖥',n)}\n{ui_row('🆔',cid)}",parse_mode='HTML',reply_markup=kb)
        except: pass

# ================= ФАЙЛЫ =================
@bot.message_handler(content_types=['document'])
def handle_document(m):
    state=gs(m.from_user.id)
    if not state or state.get('step') not in ('add_file_wait','edit_file_wait'): return
    if m.document.file_size>MAX_CONTENT_LENGTH: bot.send_message(m.chat.id,"❌ Слишком большой"); return
    try:
        fi=bot.get_file(m.document.file_id); content=bot.download_file(fi.file_path).decode('utf-8',errors='ignore')
    except: return
    if state['step']=='add_file_wait':
        name=state.get('paste_name'); e=enc(content)
        ps=lp(); ps.append({'name':name,'content':e,'hash':chash(content),'cid':m.from_user.id,'cn':dn(m.from_user.id)}); sp(ps)
        cs(m.from_user.id); bot.send_message(m.chat.id,f"{ui_header('Паст создан','✅')}\n{ui_row('Имя',name)}",parse_mode='HTML')
    else:
        idx=state.get('idx'); ps=lp()
        if idx is not None and 0<=idx<len(ps):
            ps[idx]['content']=enc(content); ps[idx]['hash']=chash(content); sp(ps)
        cs(m.from_user.id); bot.send_message(m.chat.id,"✅ Обновлён")

# ================= CALLBACK =================
@bot.callback_query_handler(func=lambda c: True)
def cb(c):
    try:
        if not c.message: bot.answer_callback_query(c.id); return
        d=c.data
        if d=="stop_auto_refresh":
            unregister_status_messages(c.message.chat.id); bot.answer_callback_query(c.id,"⏸"); return
        if d=="refresh:status":
            txt=build_status_text()
            if txt:
                try: bot.edit_message_text(txt,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=status_keyboard()); register_status_message(c.message.chat.id,c.message.message_id)
                except: pass
            bot.answer_callback_query(c.id); return
        if d=="check_tunnel":
            check_tunnel_health(); bot.answer_callback_query(c.id,"🔄"); return
        if d=="reload_tunnel":
            if not ia(c.from_user.id): bot.answer_callback_query(c.id,"❌"); return
            threading.Thread(target=lambda: force_reload_tunnel("btn"),daemon=True).start(); bot.answer_callback_query(c.id,"🔄"); return
        if d=="toggle_vanish":
            if not ia(c.from_user.id): bot.answer_callback_query(c.id,"❌"); return
            us=lu(); uid=str(c.from_user.id)
            us[uid]['vanish_tracking']=not us[uid].get('vanish_tracking',False); su(us)
            bot.answer_callback_query(c.id,"🕵️ переключено"); return
        if d.startswith("menu:"):
            sec=d.split(":")[1]
            unregister_status_messages(c.message.chat.id)
            if sec=="main":
                us=lu(); bc=sum(1 for u in us.values() if u.get('is_bot'))
                edit_or_send(c,f"{ui_header('Главное меню','📱')}\n{ui_row('🤖',bc)}\n{ui_row('📄',len(lp()))}",main_menu_keyboard(c.from_user.id))
            elif sec=="past": spm(c.message.chat.id,0,msg_to_edit=c)
            elif sec=="all": sam(c.message.chat.id,0,msg_to_edit=c)
            elif sec=="status":
                txt=build_status_text()
                if txt:
                    try: bot.edit_message_text(txt,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=status_keyboard()); register_status_message(c.message.chat.id,c.message.message_id)
                    except: pass
            elif sec=="api":
                kb=types.InlineKeyboardMarkup(row_width=2); kb.add(types.InlineKeyboardButton("🔄 Рестарт",callback_data="reload_tunnel"))
                edit_or_send(c,build_api_text(),kb)
            elif sec=="help": edit_or_send(c,build_help_text(),back_to_menu_keyboard())
            bot.answer_callback_query(c.id); return
        if d.startswith("hb_menu:"):
            uk=d.split(":")[1]
            kb=hb_keyboard(uk); bot.edit_message_reply_markup(c.message.chat.id,c.message.message_id,reply_markup=kb); bot.answer_callback_query(c.id); return
        if d.startswith("hb_set:"):
            parts=d.split(":"); uk=parts[1]; sec=int(parts[2])
            us=lu()
            if uk in us: us[uk]['heartbeat_interval']=sec; su(us)
            bot.answer_callback_query(c.id,f"💓 {hb_category(sec)}"); return
        if d.startswith("mode_toggle:"):
            uk=d.split(":")[1]; us=lu()
            if uk in us and us[uk].get('is_bot'):
                us[uk]['mode']='normal' if us[uk].get('mode')=='service' else 'service'; su(us)
            bot.answer_callback_query(c.id,"🔄"); return
        if d.startswith("kick_bot:"):
            uk=d.split(":")[1]
            bot.edit_message_text("⚠️ Кикнуть?",c.message.chat.id,c.message.message_id,reply_markup=confirm_keyboard(f"kick:{uk}")); bot.answer_callback_query(c.id); return
        if d.startswith("pv:"): show_paste_profile(c,int(d.split(":")[1])); bot.answer_callback_query(c.id); return
        if d.startswith("pp:"): spm(c.message.chat.id,int(d.split(":")[1]),msg_to_edit=c); bot.answer_callback_query(c.id); return
        if d.startswith("ap:"): sam(c.message.chat.id,int(d.split(":")[1]),msg_to_edit=c); bot.answer_callback_query(c.id); return
        if d.startswith("confirm:"):
            parts=d.split(":"); ans=parts[-1]; aid=":".join(parts[1:-1])
            if ans=="yes":
                if aid.startswith("del_paste:"):
                    idx=int(aid.split(":")[1]); ps=lp()
                    if 0<=idx<len(ps): ps.pop(idx); sp(ps)
                elif aid.startswith("kick:"):
                    tid=aid.split(":")[1]; us=lu()
                    if tid in us:
                        if us[tid].get('api_token'): rt(us[tid]['api_token'],"Kicked")
                        del us[tid]; su(us)
            cs(c.from_user.id); bot.answer_callback_query(c.id,"✅"); return
        bot.answer_callback_query(c.id)
    except Exception as e:
        print(f"[CB] err: {e}",flush=True)
        try: bot.answer_callback_query(c.id)
        except: pass
def sbp(cid,mid,uk):
    us=lu()
    if uk not in us: return
    u=us[uk]
    at=u.get('api_token','?'); hb=lhb(); ci=u.get('computer_id'); ht="❓"
    if ci in hb:
        try:
            lm=int((datetime.now()-datetime.fromisoformat(hb[ci]['last_seen'])).total_seconds()/60)
            ht="🟢" if lm<2 else f"🔴 {lm}м"
        except: pass
    txt=(f"{ui_header(u.get('name',''),'🤖')}\n{ui_row('🆔 CID',ci)}\n{ui_row('🎯 Режим',ui_mode(u.get('mode','normal')))}\n{ui_row('💓 Пульс',ht)}\n{ui_row('💓 Интервал',hb_category(u.get('heartbeat_interval',30)))}\n")
    ap=u.get('assigned_pastes',[])
    if ap: txt+="<b>📋 Скрипты:</b>\n"+"".join(f"  • <code>{safe(p)}</code>\n" for p in ap[:10])
    try: bot.edit_message_text(txt,cid,mid,parse_mode='HTML',reply_markup=bbpk(uk))
    except: pass

# ================= TEXT =================
@bot.message_handler(func=lambda m: True, content_types=['text'])
def hm(m):
    u=m.from_user.id; auto_register_trusted(u)
    t=m.text.strip(); s=gs(u)
    if s:
        stp=s.get('step')
        if stp=='wp':
            if t==PASSWORD:
                ns=dict(s); ns['step']='wn'; sets(u,ns)
                bot.send_message(m.chat.id,"✅ Пароль верный\n👤 Введите имя:",parse_mode='HTML')
            else: bot.send_message(m.chat.id,"❌ Неверный пароль",parse_mode='HTML')
            return
        if stp=='wn':
            n=tr(t,MAX_N); us=lu()
            us[str(u)]={'name':n,'username':s.get('username'),'is_bot':False,'is_admin':(n==TECH or n in PROTECTED)}
            su(us); cs(u)
            bot.send_message(m.chat.id,f"{ui_header('Добро пожаловать','🎉')}\n👤 <b>{safe(n)}</b>\n📱 /menu",parse_mode='HTML',reply_markup=main_menu_keyboard(u))
            return
        if stp in ('add_file_wait','edit_file_wait'):
            if t.lower() in ('/cancel','cancel'): cs(u); bot.send_message(m.chat.id,"❌"); return
        return
    if t.startswith('/') and t.split()[0][1:].lower() not in KNOWN:
        bot.send_message(m.chat.id,"❓ /help"); return
    if not reg(u):
        sets(u,{'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        bot.send_message(m.chat.id,"🔐 Пароль:",parse_mode='HTML'); return
    bot.send_message(m.chat.id,"💡 /menu",reply_markup=main_menu_keyboard(u))

# ================= HTTP API =================
class TS(ThreadingMixIn,HTTPServer): daemon_threads=True; allow_reuse_address=True
class AH(BaseHTTPRequestHandler):
    def log_message(self,f,*a):
        global tunnel_last_activity
        try: print(f"[API] {self.client_address[0]} - {f%a}",flush=True)
        except: pass
        tunnel_last_activity=time.time()
    def _j(self,c,d):
        try:
            b=json.dumps(d,ensure_ascii=False).encode()
            self.send_response(c); self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type, bypass-tunnel-reminder, X-Computer-ID, X-Server-Key')
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
            self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
        except: pass
    def _b(self):
        l=int(self.headers.get('Content-Length',0))
        if l>MAX_CONTENT_LENGTH: return None
        return self.rfile.read(l).decode() if l>0 else ""
    def _friend(self):
        return self.headers.get('X-Server-Key','')==PASSWORD and self.client_address[0]==FRIEND_SERVER_IP
    def _a(self):
        au=self.headers.get('Authorization',''); ci=self.headers.get('X-Computer-ID','')
        if not au.startswith('Bearer '): return None,None,False,"no",None
        tok=au[7:].strip(); ts=lt()
        if tok not in ts: return None,None,False,"inv",None
        ti=ts[tok]; ib=ti.get('is_computer',False)
        if ib and ci:
            ok,r,sd=vs(tok,ci,self.client_address[0])
            if not ok: return tok,ib,False,r,sd
        return tok,ib,True,"ok",ti
    def do_OPTIONS(self):
        self.send_response(200); self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS'); self.end_headers()
    def do_GET(self):
        try: self._get()
        except: pass
    def _get(self):
        tok,ib,v,r,ti=self._a(); p=self.path.split('?')[0]
        if p=='/api/health':
            check_tunnel_health()
            self._j(200,{"bot":"running","version":"17.27","tunnel":tunnel_health.get('status')}); return
        if p=='/api/url':
            u=tunnel()
            self._j(200,{"url":u}) if u else self._j(503,{"error":"no"}); return
        if p=='/api/me':
            if not tok: self._j(401,{"error":"Invalid"}); return
            td=lt().get(tok,{}); us=lu(); pid=td.get('pending_id')
            um='normal'; up=[]; hbi=30
            if pid and pid in us: um=us[pid].get('mode','normal'); up=us[pid].get('assigned_pastes',[]); hbi=us[pid].get('heartbeat_interval',30)
            self._j(200,{"ok":True,"computer_id":td.get('computer_id'),"mode":um,"assigned_pastes":up,"heartbeat_interval":hbi}); return
        if p.startswith('/api/paste/'):
            if not tok: self._j(401,{"error":"no"}); return
            n=unquote(p[len('/api/paste/'):]).lower()
            if ib:
                us=lu(); pid=ti.get('pending_id')
                al=[x.lower() for x in us[pid].get('assigned_pastes',[])] if pid and pid in us else []
                if not al or n not in al: self._j(403,{"error":"PANIC"}); return
            for x in lp():
                if x['name'].lower()==n:
                    c=dec(x['content'])
                    self._j(200,{"name":x['name'],"content":c}) if c else self._j(500,{"error":"decrypt"})
                    return
            self._j(404,{"error":"no"}); return
        if p.startswith('/api/player/') or p=='/api/players/list':
            if not self._friend(): self._j(403,{"error":"Unauthorized"}); return
            if p=='/api/players/list':
                self._j(200,{"players":[f.stem for f in PLAYERS_DIR.glob('*.txt')]}); return
            name=p.split('/')[-1]
            fp=PLAYERS_DIR/f"{name}.txt"
            if not fp.exists(): self._j(404,{"error":"Not found"}); return
            self._j(200,{"name":name,"history":fp.read_text()}); return
        self._j(404,{"error":"no"})
    def do_POST(self):
        try: self._post()
        except: pass
    def _post(self):
        tok,ib,v,r,ti=self._a(); p=self.path.split('?')[0]
        b=self._b()
        if b is None: self._j(413,{"error":"too large"}); return
        if p=='/api/reload':
            if not tok or not v: self._j(401,{"error":"no token"}); return
            threading.Thread(target=lambda: force_reload_tunnel("api"),daemon=True).start()
            self._j(200,{"ok":True}); return
        if p=='/api/player_data':
            try:
                process_player_data(json.loads(b) if b else {})
                self._j(200,{"ok":True}); return
            except Exception as e: self._j(500,{"error":str(e)}); return
        if p=='/api/login':
            try: d=json.loads(b)
            except: d={}
            if d.get('password')!=PASSWORD: self._j(401,{"error":"Wrong password"}); return
            us=lu(); ts=lt(); lci=d.get('computer_id','unk')
            for uid,ud in us.items():
                if ud.get('is_bot') and ud.get('computer_id')==lci and ud.get('api_token') in ts:
                    self._j(200,{"ok":True,"status":"already_registered","token":ud['api_token']}); return
            pid=str(uuid.uuid4()); ft=str(uuid.uuid4())
            pe=lpend(); pe[pid]={'token':ft,'name':d.get('name'),'computer_id':lci,'status':'approved'}; spend(pe)
            ts[ft]={'name':d.get('name'),'computer_id':lci,'is_computer':True,'pending_id':pid}; st(ts)
            us[pid]={'name':d.get('name'),'computer_id':lci,'is_bot':True,'is_admin':False,'mode':'normal','assigned_pastes':[],'api_token':ft,'heartbeat_interval':30}; su(us)
            self._j(200,{"ok":True,"status":"approved","token":ft}); return
        if p=='/api/heartbeat':
            if not ib: self._j(403,{"error":"no"}); return
            cv=ti.get('computer_id')
            if not cv: self._j(400,{"error":"no cid"}); return
            hb=lhb(); hb[cv]={'last_seen':datetime.now().isoformat(),'name':ti.get('name'),'mode':(json.loads(b) if b else {}).get('mode')}; shb(hb)
            self._j(200,{"ok":True}); return
        self._j(404,{"error":"no"})

def start_api():
    while True:
        try:
            srv=TS(('0.0.0.0',PORT),AH); srv.timeout=5
            print(f"[API] Ready v17.27 on {PORT}",flush=True)
            srv.serve_forever()
        except OSError:
            os.system(f"fuser -k {PORT}/tcp 2>/dev/null"); time.sleep(2)
        except: time.sleep(5)

def main():
    print("Starting bot v17.27 (full UI + 5G + survivability)...",flush=True)
    load_online_tracking(); update_url_from_log()
    threading.Thread(target=start_tunnel,daemon=True).start()
    threading.Thread(target=tunnel_watchdog_loop,daemon=True).start()
    time.sleep(2)
    threading.Thread(target=start_api,daemon=True).start()
    threading.Thread(target=site_checker_loop,daemon=True).start()
    threading.Thread(target=watcher_loop,daemon=True).start()
    threading.Thread(target=tunnel_health_loop,daemon=True).start()
    threading.Thread(target=vanish_checker_loop,daemon=True).start()
    threading.Thread(target=status_auto_refresh_loop,daemon=True).start()
    print("Bot ready! Relay: @capscraft_relay",flush=True)
    bot.infinity_polling(timeout=60,long_polling_timeout=60,skip_pending=False)

if __name__=='__main__':
    main()
