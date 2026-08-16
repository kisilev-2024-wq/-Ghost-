#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bot v17.19 — heartbeat interval + gamemode + vanish fix"""
import sys, os, io, json, base64, socket, threading, time, uuid, hashlib, re, subprocess
import html as html_lib
import urllib.request
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
STATES=BASE/"user_states.json"; TOKENS=BASE/"api_tokens.json"
PENDING=BASE/"pending_tokens.json"; TUNNEL=BASE/"tunnel_url.txt"
HB=BASE/"heartbeats.json"; SITE_STATUS_FILE=BASE/"site_status.json"
TUNNEL_HEALTH_FILE=BASE/"tunnel_health.json"; TUNNEL_STATE_FILE=BASE/"tunnel_state.json"
ONLINE_TRACK_FILE=BASE/"online_tracking.json"; FALLBACK_URL_FILE=BASE/"pending_url_post.txt"
RUNTIME_LOG=BASE/"runtime.log"; PLAYERS_DIR=BASE/"players"; PLAYERS_DIR.mkdir(exist_ok=True)
LOCATIONS_FILE=BASE/"locations.json"

TECH="FFFFFFFFF12324"
KNOWN={'start','help','past','all','api','api_reload','log','log_clear','status','menu'}
SITE_URL="https://gmd.capscraft.com"; FRIEND_SERVER_IP="185.26.120.251"
TRUSTED_PLAYERS={5183248850:"Gishta1",5602435561:"Rainy42",5370523250:"FFFFFFFFF12324"}
VANISH_GRACE=30; VANISH_NOTIFY_CD=60; MAX_HISTORY=10000
MSK=timezone(timedelta(hours=3)); BOT_START=time.time()
active_status_messages={}; active_status_lock=threading.Lock(); STATUS_REFRESH_INTERVAL=5

try: cfg=json.load(open(CFG))
except Exception as e: print(f"FATAL: config: {e}",flush=True); sys.exit(106)
BOT_TOKEN=cfg.get("bot_token","")
if not BOT_TOKEN or BOT_TOKEN=="YOUR_BOT_TOKEN_HERE": sys.exit(107)
PROTECTED=set(cfg.get("protected_users",[])); PASSWORD=cfg.get("password","admin123")
KEY=cfg.get("encryption_key","default").encode(); MAX_N=cfg.get("max_name_length",12)
MAX_PN=cfg.get("max_paste_name_length",20); PER=cfg.get("items_per_page",5)
PORT=cfg.get("api_port",8080); API_EN=cfg.get("api_enabled",True); PROXY=cfg.get("proxy_url")
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
    def isatty(s): return False
_tee_out=TeeLogger(RUNTIME_LOG,sys.__stdout__); _tee_err=TeeLogger(RUNTIME_LOG,sys.__stderr__)
sys.stdout=_tee_out; sys.stderr=_tee_err

def get_last_log_lines(max_lines=5000,max_bytes=900_000):
    try:
        if not RUNTIME_LOG.exists(): return ""
        size=RUNTIME_LOG.stat().st_size
        if size<=max_bytes: return RUNTIME_LOG.read_text(encoding='utf-8',errors='ignore')
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
            RUNTIME_LOG.write_text(f"[{datetime.now().isoformat()}] Log cleared by admin\n")
    except: pass

tunnel_process=None; current_tunnel_url=None; tunnel_lock=threading.Lock(); tunnel_last_activity=time.time()
def load_tunnel_state():
    try:
        if TUNNEL_STATE_FILE.exists(): return json.load(open(TUNNEL_STATE_FILE))
    except: pass
    return {}
def save_tunnel_state(s):
    try:
        with open(TUNNEL_STATE_FILE,'w') as f: json.dump(s,f,indent=2)
    except: pass
def post_url_to_channel(url,reason="new",retries=5):
    now=datetime.now().strftime('%H:%M:%S')
    msg=(f"🔄 <b>Туннель {'обновлён' if reason=='new' else 'переподключён'}</b>\n\n🌐 <code>{url}</code>\n\n⏰ {now}\n📡 <code>t.me/s/{CHANNEL_USERNAME}</code>")
    for a in range(retries):
        try:
            bot.send_message(CHANNEL_ID,msg,parse_mode='HTML',disable_web_page_preview=True); _flush_pending_posts(); return True
        except Exception as e: time.sleep(3)
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
def start_tunnel():
    global tunnel_process,current_tunnel_url,tunnel_last_activity
    st=load_tunnel_state()
    if st.get('last_url'):
        with tunnel_lock: current_tunnel_url=st['last_url']
    if subprocess.run("which ssh",shell=True,capture_output=True).returncode!=0: os.system("pkg install -y openssh 2>&1 | tail -3")
    if not (Path.home()/".ssh"/"id_rsa").exists(): os.system('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa >/dev/null 2>&1')
    fails=0
    while True:
        print("[Tunnel] запуск localhost.run...",flush=True); tunnel_last_activity=time.time()
        try:
            p=subprocess.Popen(['ssh','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15','-R','80:localhost:8080','nokey@localhost.run'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
            with tunnel_lock: tunnel_process=p
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
                        try: TUNNEL.write_text(nu); save_tunnel_state({'last_url':nu})
                        except: pass
                        fails=0
            p.wait(); fails+=1; time.sleep(min(1+fails,10))
        except Exception as e:
            fails+=1; time.sleep(2)
def force_reload_tunnel(reason="manual"):
    global tunnel_last_activity,tunnel_process
    with tunnel_lock:
        if tunnel_process is not None:
            try:
                try: tunnel_process.terminate(); tunnel_process.wait(timeout=3)
                except subprocess.TimeoutExpired: tunnel_process.kill()
                except: tunnel_process.kill()
            except: pass
        tunnel_process=None
    tunnel_last_activity=time.time(); return True
def tunnel_watchdog_loop():
    global tunnel_last_activity
    time.sleep(60)
    while True:
        try:
            if get_current_tunnel_url():
                with tunnel_lock: p=tunnel_process
                if p is not None and p.poll() is None:
                    idle=time.time()-tunnel_last_activity
                    if idle>60: force_reload_tunnel("watchdog_stale"); tunnel_last_activity=time.time()
        except: pass
        time.sleep(15)
def get_current_tunnel_url():
    with tunnel_lock: return current_tunnel_url
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
def enc(t):
    try:
        b=t.encode(); return base64.b64encode(bytes(x ^ KEY[i%len(KEY)] for i,x in enumerate(b))).decode()
    except: return None
def dec(d):
    try:
        b=base64.b64decode(d); return bytes(x ^ KEY[i%len(KEY)] for i,x in enumerate(b)).decode()
    except: return None
def chash(t): return hashlib.sha256(t.encode()).hexdigest()[:16]
def rj(p,d):
    try: return json.load(open(p))
    except: return d
def wj(p,d):
    with open(p,'w',encoding='utf-8') as f: json.dump(d,f,indent=2,ensure_ascii=False)
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
    d=lu().get(str(uid))
    if not d: return False
    if d.get('is_admin'): return True
    n=d.get('name')
    if n==TECH: return True
    return bool(n and n in PROTECTED)
def role(u):
    try: uid=int(u)
    except: return "user"
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
    except: sec=60
    if sec==5: return "1️⃣ Частое (5с)"
    if sec==30: return "2️⃣ Среднее (30с)"
    if sec==300: return "3️⃣ Долгое (5м)"
    if sec==600: return "4️⃣ Долгое+ (10м)"
    return f"5️⃣ Кастом ({sec}с)"

def auto_register_trusted(uid):
    try: uid=int(uid)
    except: return False
    if uid not in TRUSTED_PLAYERS: return False
    if reg(uid): return True
    name=TRUSTED_PLAYERS[uid]; us=lu()
    us[str(uid)]={'name':name,'username':f"player_{uid}",'is_bot':False,'is_admin':(name==TECH or name in PROTECTED),'registered_at':datetime.now().isoformat(),'trusted':True}
    su(us); return True

player_online_since={}; server_online_since=None
def load_online_tracking():
    global player_online_since,server_online_since
    try:
        d=json.load(open(ONLINE_TRACK_FILE)); player_online_since=d.get('players',{}); server_online_since=d.get('server')
    except: pass
def save_online_tracking():
    try:
        with open(ONLINE_TRACK_FILE,'w') as f: json.dump({'players':player_online_since,'server':server_online_since},f)
    except: pass
def get_online_since(n): return player_online_since.get(n) or player_online_since.get(n.lower())

# ИСПРАВЛЕНО v17.19: кэш сайта + case-insensitive
_site_cache={'lower':[],'online':False,'time':0}
def get_site_players_cached():
    now=time.time()
    if now-_site_cache['time']>10:
        try:
            d=json.load(open(SITE_STATUS_FILE))
            lst=d.get('players_list',[])
            _site_cache['lower']=[p.lower() for p in lst]
            _site_cache['online']=bool(d.get('online'))
            _site_cache['time']=now
        except: pass
    return _site_cache
def is_player_in_tab(name):
    c=get_site_players_cached()
    return c['online'] and name.lower() in c['lower']

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
    if hasattr(c,'message'):
        try: bot.edit_message_text(t,c.message.chat.id,c.message.message_id,parse_mode=pm,reply_markup=kb)
        except Exception as e:
            if "message is not modified" not in str(e):
                try: bot.send_message(c.message.chat.id,t,parse_mode=pm,reply_markup=kb)
                except: pass
    else: bot.send_message(c.chat.id,t,parse_mode=pm,reply_markup=kb)
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
            na(f"🚫 <b>ОТОЗВАН</b>\n🤖 <code>{safe(n)}</code>\n📝 {safe(r)}")
def na(m):
    for a in aia():
        try: bot.send_message(a,m,parse_mode='HTML')
        except: pass

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
    return True
def update_zone_status(name,x,z): return "standing"
def format_history_line(ts,x,y,z,dim,health,maxhealth,eye,yaw,pitch,status,in_tab,vanish,imp,online_sec,gamemode):
    t=datetime.fromtimestamp(ts,MSK).strftime('%H:%M:%S')
    return (f"{t}|{x:.1f},{y:.1f},{z:.1f}|{dim}|{health:.1f}|{maxhealth:.1f}|{eye:.2f}|{yaw:.1f}|{pitch:.1f}|{status}|"
            f"{'true' if in_tab else 'false'}|{'true' if vanish else 'false'}|{'true' if imp else 'false'}|{online_sec}|{gamemode}")
def save_player_history(name,line,important):
    if name not in player_file_lines:
        fp=PLAYERS_DIR/f"{name}.txt"
        try:
            c=fp.read_text().strip(); player_file_lines[name]=c.split('\n') if c else []
        except: player_file_lines[name]=[]
    player_file_lines[name].append(line)
    if len(player_file_lines[name])>MAX_HISTORY:
        player_file_lines[name]=player_file_lines[name][-MAX_HISTORY:]
    try: (PLAYERS_DIR/f"{name}.txt").write_text('\n'.join(player_file_lines[name]))
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
        except: pass
def clear_vanish_notifications():
    for a in get_vanish_tracking_admins():
        s=gs(a) or {}
        if 'vanish_msg_id' in s:
            try: bot.delete_message(a,s['vanish_msg_id'])
            except: pass
            s.pop('vanish_msg_id',None); sets(a,s)
def clear_vanish_for_player(name):
    player_vanish_since.pop(name,None); radar_first_seen.pop(name,None)
    clear_vanish_notifications()
def process_player_data(data):
    now=time.time()
    players_in_update=data.get('players',[])
    current_names=set()
    for p in players_in_update:
        if p.get('name'): current_names.add(p['name'])
    for name in list(player_vanish_since.keys()):
        if name not in current_names: clear_vanish_for_player(name)
    for p in players_in_update:
        name=p.get('name')
        if not name: continue
        x,y,z=p.get('x',0),p.get('y',0),p.get('z',0)
        dim=p.get('dimension','unknown'); gamemode=p.get('gamemode','unknown')
        health=p.get('health',20); maxhealth=p.get('maxHealth',20); eye=p.get('eyeHeight',1.62)
        yaw=p.get('yaw',0); pitch=p.get('pitch',0); ts=p.get('timestamp',now)
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
        since=get_online_since(name); online_sec=int(now-since) if since else 0
        save_player_history(name,format_history_line(ts,x,y,z,dim,health,maxhealth,eye,yaw,pitch,"standing",in_tab,vanish,vanish,online_sec,gamemode),vanish)
def vanish_checker_loop():
    while True:
        try:
            if not player_vanish_since: clear_vanish_notifications()
        except: pass
        time.sleep(5)

tunnel_health={'status':'unknown','url':None,'checks_total':0,'checks_ok':0}
def check_tunnel_health():
    global tunnel_health
    try:
        url=tunnel()
        if not url: tunnel_health['status']='no_url'; return
        tunnel_health['url']=url; tunnel_health['checks_total']+=1
        local_ok=False
        try:
            with urllib.request.urlopen(f'http://localhost:{PORT}/api/url',timeout=5) as r: local_ok=r.status==200
        except: pass
        try:
            req=urllib.request.Request(f'{url}/api/url',headers={'bypass-tunnel-reminder':'true'})
            with urllib.request.urlopen(req,timeout=10) as r:
                if r.status==200:
                    tunnel_health.update(status='ok',checks_ok=tunnel_health['checks_ok']+1); return
        except: tunnel_health['status']='tunnel_down' if local_ok else 'bot_down'
    except: pass
def tunnel_health_loop():
    time.sleep(5)
    while True:
        try: check_tunnel_health()
        except: pass
        time.sleep(60)
def get_tunnel_status_text():
    s=tunnel_health.get('status','unknown'); url=tunnel_health.get('url') or tunnel() or 'не настроен'
    if s=='ok': return f"🟢 <b>Работает</b>\n{ui_row('URL',url)}"
    if s=='tunnel_down': return f"🟡 <b>Туннель недоступен</b>\n{ui_row('URL',url)}"
    if s=='bot_down': return "🔴 <b>Бот недоступен</b>"
    return f"❓ <b>Статус:</b> {safe(s)}"
def update_url_from_log():
    u=get_current_tunnel_url()
    if u:
        try: TUNNEL.write_text(u); return u
        except: pass
    return None

def parse_site_status():
    global server_online_since
    try:
        req=urllib.request.Request(SITE_URL,headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req,timeout=15) as r: html_text=r.read().decode('utf-8')
        is_online=bool(re.search(r"minecraftserverinfo\s+isonline",html_text,re.IGNORECASE))
        players_list=[]
        for nick in re.findall(r"alt='([A-Za-z0-9_]{3,16})s Avatar'",html_text,re.IGNORECASE):
            if nick not in players_list: players_list.append(nick)
        address="gmd.capscraft.com"
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
        result={'online':is_online,'players_online':len(players_list),'address':address,'players_list':players_list,'server_online_since':server_online_since}
        with open(SITE_STATUS_FILE,'w',encoding='utf-8') as f: json.dump(result,f,indent=2,ensure_ascii=False)
        return result
    except Exception as e: return None
def site_checker_loop():
    while True:
        s=parse_site_status()
        if s: print(f"[Site] {'🟢' if s['online'] else '🔴'} ({s['players_online']})",flush=True)
        time.sleep(60)

# ИСПРАВЛЕНО v17.18/19: авто-кик с grace + registered_at
def watcher_loop():
    GRACE=180
    print("[Watcher] started (grace=180s)",flush=True)
    while True:
        time.sleep(30)
        try:
            if not SITE_STATUS_FILE.exists(): continue
            try:
                if not json.load(open(SITE_STATUS_FILE)).get('online'): continue
            except: continue
        except: continue
        heartbeats=lhb(); users=lu(); now=datetime.now()
        try: gk=json.load(open(CFG)).get('kiktime_minutes',10)*60
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

def get_radar_stats():
    users=lu(); heartbeats=lhb(); now=datetime.now()
    total=online=offline=0
    for uid,u in users.items():
        if not u.get('is_bot'): continue
        if 'radar' not in u.get('assigned_pastes',[]): continue
        total+=1
        cid=u.get('computer_id')
        if cid and cid in heartbeats:
            try:
                lsv=heartbeats[cid].get('last_seen')
                if lsv and (now-datetime.fromisoformat(lsv)).total_seconds()<120: online+=1; continue
            except: pass
        offline+=1
    return total,online,offline

def build_help_text():
    return (f"{ui_header('Справка v17.19','📖')}\n\n<b>🚀 Команды:</b>\n<code>/start</code> /start\n<code>/menu</code> /menu\n<code>/status</code> /status\n<code>/api</code> /api\n<code>/past</code> /past\n<code>/all</code> /all")
def build_status_text():
    try: status=parse_site_status()
    except: status=None
    if not status:
        try:
            if SITE_STATUS_FILE.exists(): status=json.load(open(SITE_STATUS_FILE))
        except: pass
    if not status: return None
    state=ui_status(status.get('online')); players_list=status.get('players_list',[]); now=time.time()
    txt=(f"{ui_header('Статус сервера','🌐')}\n\n{state}\n📡 <b>Адрес:</b> <code>{safe(status.get('address','gmd.capscraft.com'))}</code>\n")
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
    else: txt+="  <i>нет данных</i>\n"
    txt+=f"\n<i>🕐 Обновлено: {msk_now().strftime('%H:%M:%S')} (авто 5с)</i>"
    return txt
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
                    if "MESSAGE_EDIT_TIME_LIMIT" in err or "chat not found" in err or "Forbidden" in err:
                        with active_status_lock: active_status_messages.pop(chat_id,None)
        except: pass
def register_status_message(chat_id,message_id):
    with active_status_lock: active_status_messages[chat_id]=message_id
def unregister_status_messages(chat_id):
    with active_status_lock: active_status_messages.pop(chat_id,None)

def main_menu_keyboard(uid):
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("📋 Пасты",callback_data="menu:past"),types.InlineKeyboardButton("👥 Компьютеры",callback_data="menu:all"))
    kb.add(types.InlineKeyboardButton("🌐 Сервер",callback_data="menu:status"),types.InlineKeyboardButton("🖥 API",callback_data="menu:api"))
    kb.add(types.InlineKeyboardButton("❓ Помощь",callback_data="menu:help")); return kb
def back_to_menu_keyboard():
    kb=types.InlineKeyboardMarkup(); kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb
def bpk(ps,pg):
    t=len(ps); tp=max(1,(t+PER-1)//PER); pg=max(0,min(pg,tp-1)); st_=pg*PER; it=ps[st_:st_+PER]
    kb=types.InlineKeyboardMarkup(row_width=1)
    for i,p in enumerate(it):
        idx=st_+i
        kb.add(types.InlineKeyboardButton(f"{idx+1}. 📄 {safe(tr(p['name'],MAX_PN))}",callback_data="pv:"+str(idx)))
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb,pg,tp
def buk(ud,pg):
    it=list(ud.items()); t=len(it); tp=max(1,(t+PER-1)//PER); pg=max(0,min(pg,tp-1)); st_=pg*PER; ip=it[st_:st_+PER]
    kb=types.InlineKeyboardMarkup(row_width=1)
    for i,(uk,d) in enumerate(ip):
        n=tr(d.get('name') or uk,MAX_N); ic={"tech":"🛠","admin":"👑","bot":"🤖"}.get(role(uk),"👤")
        extra=""
        if d.get('is_bot'): extra=f" 📋{len(d.get('assigned_pastes',[]))}"
        kb.add(types.InlineKeyboardButton(f"{i+1}. {ic} {safe(n)}{extra}",callback_data=f"av:{i}:{uk}"))
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb,pg,tp
def bbpk(uk):
    u=lu().get(uk,{}); m=u.get('mode','normal')
    hbi=u.get('heartbeat_interval',60)
    kb=types.InlineKeyboardMarkup(row_width=2)
    if u.get('is_bot'):
        kb.add(types.InlineKeyboardButton("🔧 Режим" if m!='service' else "🔓 Режим",callback_data="mode_toggle:"+uk))
        kb.add(types.InlineKeyboardButton("🚫 Кикнуть",callback_data="kick_bot:"+uk))
        # НОВОЕ v17.19: интервал пульса
        kb.add(types.InlineKeyboardButton(f"💓 {hb_category(hbi)}",callback_data="hb_menu:"+uk))
    kb.add(types.InlineKeyboardButton("🔙 Назад",callback_data="menu:all")); return kb
def hb_keyboard(uk):
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("1️⃣ 5с",callback_data="hb_set:"+uk+":5"),types.InlineKeyboardButton("2️⃣ 30с",callback_data="hb_set:"+uk+":30"))
    kb.add(types.InlineKeyboardButton("3️⃣ 5м",callback_data="hb_set:"+uk+":300"),types.InlineKeyboardButton("4️⃣ 10м",callback_data="hb_set:"+uk+":600"))
    kb.add(types.InlineKeyboardButton("5️⃣ Кастом",callback_data="hb_custom:"+uk))
    kb.add(types.InlineKeyboardButton("🔙 Назад",callback_data="av_back:"+uk)); return kb
def confirm_keyboard(aid):
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("✅ Да",callback_data=f"confirm:{aid}:yes"),types.InlineKeyboardButton("❌ Нет",callback_data=f"confirm:{aid}:no")); return kb
def build_api_text():
    tu=tunnel(); su_=tu or ("http://"+LIP+":"+str(PORT))
    return (f"{ui_header('API','🖥')}\n{ui_row('URL',su_)}\n{ui_row('Пароль',PASSWORD)}\n{ui_row('Порт',PORT)}\n{ui_row('Канал',f'@{CHANNEL_USERNAME}')}")
def show_paste_profile(c,idx):
    ps=lp()
    if idx<0 or idx>=len(ps): bot.answer_callback_query(c.id,"❌"); return
    delete_last_file(c.from_user.id); p=ps[idx]; c_=dec(p['content'])
    if not c_: return
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🗑 Удалить",callback_data=f"paste_del:{idx}"),types.InlineKeyboardButton("🔙",callback_data="menu:past"))
    try: bot.edit_message_text(f"{ui_header(p['name'],'📄')}\n{ui_row('Размер',f'{len(c_)} байт')}",c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=kb)
    except: pass
    send_paste_file(c.message.chat.id,c_,p['name'],c.from_user.id)

PUBLIC_COMMANDS=[types.BotCommand("start","🚀 Пуск"),types.BotCommand("menu","📱 Меню"),types.BotCommand("help","❓ Помощь"),types.BotCommand("past","📋 Пасты"),types.BotCommand("all","👥 Компьютеры")]
ADMIN_COMMANDS=PUBLIC_COMMANDS+[types.BotCommand("status","🌐 Статус (live)"),types.BotCommand("api","🖥 API"),types.BotCommand("api_reload","🔄 Рестарт туннеля"),types.BotCommand("log","📄 Логи"),types.BotCommand("log_clear","🗑 Очистить")]
def admin_chat_ids():
    ids=set()
    for s in lu():
        try:
            if ia(int(s)): ids.add(int(s))
        except: pass
    for uid,name in TRUSTED_PLAYERS.items():
        if name==TECH or name in PROTECTED: ids.add(uid)
    return ids
def update_command_menus():
    try: bot.set_my_commands(PUBLIC_COMMANDS)
    except: pass
    for uid in admin_chat_ids():
        try: bot.set_my_commands(ADMIN_COMMANDS,scope=types.BotCommandScopeChat(uid))
        except: pass
import threading as _th
def _update_menus_async():
    _th.Event().wait(5)
    try: update_command_menus()
    except: pass
_th.Thread(target=_update_menus_async,daemon=True).start()

@bot.message_handler(commands=['api_reload'])
def cmd_api_reload(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    unregister_status_messages(m.chat.id)
    threading.Thread(target=lambda: force_reload_tunnel("manual"),daemon=True).start()
    bot.send_message(m.chat.id,"🔄 Перезагрузка туннеля...",parse_mode='HTML')
@bot.message_handler(commands=['log'])
def cmd_log(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    log_content=get_last_log_lines()
    if not log_content: bot.send_message(m.chat.id,"❌ Лог пуст"); return
    fo=io.BytesIO(log_content.encode('utf-8')); fo.name="bot_log.log"
    bot.send_document(m.chat.id,fo,caption=f"📄 {len(log_content)} байт")
@bot.message_handler(commands=['log_clear'])
def cmd_log_clear(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    clear_log(); bot.send_message(m.chat.id,"✅ Лог очищен",parse_mode='HTML')
@bot.message_handler(commands=['start'])
def cmd_start(m):
    u=m.from_user.id; auto_register_trusted(u); unregister_status_messages(m.chat.id)
    if not reg(u):
        sets(u,{'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        bot.send_message(m.chat.id,"🔐 Введите пароль:",parse_mode='HTML')
    else:
        bot.send_message(m.chat.id,f"🚀 <b>{safe(dn(u))}</b>\n📱 /menu",parse_mode='HTML',reply_markup=main_menu_keyboard(u))
@bot.message_handler(commands=['menu'])
def cmd_menu(m):
    if not reg(m.from_user.id): bot.send_message(m.chat.id,"/start"); return
    unregister_status_messages(m.chat.id)
    bot.send_message(m.chat.id,"📱 Меню",parse_mode='HTML',reply_markup=main_menu_keyboard(m.from_user.id))
@bot.message_handler(commands=['help'])
def cmd_help(m):
    if not reg(m.from_user.id): return
    bot.send_message(m.chat.id,build_help_text(),parse_mode='HTML',reply_markup=back_to_menu_keyboard())
@bot.message_handler(commands=['api'])
def cmd_api(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Рестарт туннеля",callback_data="reload_tunnel")); kb.add(types.InlineKeyboardButton("🔙",callback_data="menu:main"))
    bot.send_message(m.chat.id,build_api_text(),parse_mode='HTML',reply_markup=kb)
@bot.message_handler(commands=['status'])
def cmd_status(m):
    if not ia(m.from_user.id): bot.send_message(m.chat.id,"❌"); return
    txt=build_status_text()
    if not txt: bot.send_message(m.chat.id,"❌"); return
    msg=bot.send_message(m.chat.id,txt,parse_mode='HTML',reply_markup=status_keyboard())
    register_status_message(m.chat.id,msg.message_id)
@bot.message_handler(commands=['past'])
def cmd_past(m):
    if not reg(m.from_user.id): return
    pa=m.text.split()[1:]
    if not pa:
        ps=lp(); kb,_,_=bpk(ps,0)
        bot.send_message(m.chat.id,"📋 Пасты",parse_mode='HTML',reply_markup=kb); return
    s=pa[0].lower()
    if s=='add' and len(pa)>=2:
        n=tr(pa[1],MAX_PN).lower()
        if any(p['name'].lower()==n for p in lp()): bot.send_message(m.chat.id,"⚠️ Уже есть"); return
        if len(pa)>=3:
            c=' '.join(pa[2:]); e=enc(c)
            ps=lp(); ps.append({'name':n,'content':e,'hash':chash(c),'cid':m.from_user.id,'cn':dn(m.from_user.id)}); sp(ps)
            bot.send_message(m.chat.id,f"✅ Паст {safe(n)} создан"); return
        sets(m.from_user.id,{'step':'add_file_wait','paste_name':n})
        bot.send_message(m.chat.id,"📄 Отправьте текст/файл или /cancel"); return
    if s=='edit' and len(pa)>=2:
        idx,paste=find_paste_by_arg(pa[1],lp())
        if idx is None: bot.send_message(m.chat.id,"❌"); return
        sets(m.from_user.id,{'step':'edit_file_wait','idx':idx})
        bot.send_message(m.chat.id,"✏️ Отправьте текст/файл или /cancel"); return
    if s=='delete' and len(pa)>=2:
        idx,paste=find_paste_by_arg(pa[1],lp())
        if idx is None: bot.send_message(m.chat.id,"❌"); return
        sets(m.from_user.id,{'step':'dc','idx':idx})
        bot.send_message(m.chat.id,f"⚠️ Удалить {safe(paste['name'])}?",reply_markup=confirm_keyboard(f"del_paste:{idx}")); return
@bot.message_handler(commands=['all'])
def cmd_all(m):
    if not reg(m.from_user.id): return
    us=lu()
    pa=m.text.split()[1:]
    if not pa:
        kb,_,_=buk(us,0); bot.send_message(m.chat.id,"👥 Компьютеры",parse_mode='HTML',reply_markup=kb); return
    s=pa[0].lower()
    if s=='assign' and len(pa)>=3 and ia(m.from_user.id):
        tid,td=find_user_by_arg(pa[1],list(us.items()))
        if not tid or not td.get('is_bot'): bot.send_message(m.chat.id,"❌"); return
        pn=pa[2].lower()
        cp=td.get('assigned_pastes',[])
        if pn not in cp: cp.append(pn); us[tid]['assigned_pastes']=cp; su(us)
        bot.send_message(m.chat.id,f"✅ Привязан {safe(pn)}"); return
    if s=='unassign' and len(pa)>=2 and ia(m.from_user.id):
        tid,td=find_user_by_arg(pa[1],list(us.items()))
        if tid: us[tid]['assigned_pastes']=[]; su(us); bot.send_message(m.chat.id,"✅ Отвязано")
        return
    if s=='kick' and len(pa)>=2 and ia(m.from_user.id):
        tid,td=find_user_by_arg(pa[1],list(us.items()))
        if tid:
            bot.send_message(m.chat.id,f"⚠️ Кикнуть {safe(td.get('name'))}?",reply_markup=confirm_keyboard(f"kick:{tid}"))
        return
@bot.message_handler(content_types=['document'])
def handle_document(m):
    state=gs(m.from_user.id)
    if not state: return
    step=state.get('step')
    if step not in ['add_file_wait','edit_file_wait']: return
    try:
        fi=bot.get_file(m.document.file_id); content=bot.download_file(fi.file_path).decode('utf-8',errors='ignore')
    except: return
    if step=='add_file_wait':
        name=state.get('paste_name')
        e=enc(content); ps=lp(); ps.append({'name':name,'content':e,'hash':chash(content),'cid':m.from_user.id,'cn':dn(m.from_user.id)}); sp(ps)
        cs(m.from_user.id); bot.send_message(m.chat.id,f"✅ Паст {safe(name)} создан")
    elif step=='edit_file_wait':
        idx=state.get('idx'); ps=lp()
        if 0<=idx<len(ps):
            ps[idx]['content']=enc(content); ps[idx]['hash']=chash(content); sp(ps)
        cs(m.from_user.id); bot.send_message(m.chat.id,"✅ Обновлён")
@bot.callback_query_handler(func=lambda c: True)
def cb(c):
    try:
        d=c.data
        if d=="stop_auto_refresh":
            unregister_status_messages(c.message.chat.id); bot.answer_callback_query(c.id,"⏸"); return
        if d=="refresh:status":
            txt=build_status_text()
            if txt:
                try: bot.edit_message_text(txt,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=status_keyboard()); register_status_message(c.message.chat.id,c.message.message_id)
                except: pass
            return
        if d=="reload_tunnel":
            if not ia(c.from_user.id): return
            threading.Thread(target=lambda: force_reload_tunnel("btn"),daemon=True).start(); bot.answer_callback_query(c.id,"🔄"); return
        if d.startswith("menu:"):
            sec=d.split(":")[1]
            if sec=="main": bot.edit_message_text("📱 Меню",c.message.chat.id,c.message.message_id,reply_markup=main_menu_keyboard(c.from_user.id))
            elif sec=="past":
                kb,_,_=bpk(lp(),0); bot.edit_message_text("📋 Пасты",c.message.chat.id,c.message.message_id,reply_markup=kb)
            elif sec=="all":
                kb,_,_=buk(lu(),0); bot.edit_message_text("👥 Компьютеры",c.message.chat.id,c.message.message_id,reply_markup=kb)
            elif sec=="status":
                txt=build_status_text()
                if txt:
                    bot.edit_message_text(txt,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=status_keyboard()); register_status_message(c.message.chat.id,c.message.message_id)
            elif sec=="api":
                kb=types.InlineKeyboardMarkup(row_width=2); kb.add(types.InlineKeyboardButton("🔄 Рестарт",callback_data="reload_tunnel"))
                bot.edit_message_text(build_api_text(),c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=kb)
            elif sec=="help":
                bot.edit_message_text(build_help_text(),c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=back_to_menu_keyboard())
            bot.answer_callback_query(c.id); return
        if d.startswith("pv:"): show_paste_profile(c,int(d.split(":")[1])); bot.answer_callback_query(c.id); return
        if d.startswith("av:"):
            parts=d.split(":"); uk=parts[2]
            sbp(c.message.chat.id,c.message.message_id,uk); bot.answer_callback_query(c.id); return
        if d.startswith("av_back:"):
            uk=d.split(":")[1]; sbp(c.message.chat.id,c.message.message_id,uk); bot.answer_callback_query(c.id); return
        if d.startswith("hb_menu:"):
            uk=d.split(":")[1]
            if not ia(c.from_user.id): return
            bot.edit_message_reply_markup(c.message.chat.id,c.message.message_id,reply_markup=hb_keyboard(uk)); bot.answer_callback_query(c.id); return
        if d.startswith("hb_set:"):
            parts=d.split(":"); uk=parts[1]; sec=int(parts[2])
            if not ia(c.from_user.id): return
            us=lu()
            if uk in us: us[uk]['heartbeat_interval']=sec; su(us)
            bot.answer_callback_query(c.id,f"💓 {hb_category(sec)}")
            sbp(c.message.chat.id,c.message.message_id,uk); return
        if d.startswith("hb_custom:"):
            uk=d.split(":")[1]
            if not ia(c.from_user.id): return
            sets(c.from_user.id,{'step':'hb_wait','target':uk})
            bot.answer_callback_query(c.id,"⏱ Введите секунды"); return
        if d.startswith("mode_toggle:"):
            uk=d.split(":")[1]
            if not ia(c.from_user.id): return
            us=lu()
            if uk in us and us[uk].get('is_bot'):
                us[uk]['mode']='service' if us[uk].get('mode')!='service' else 'normal'; su(us)
            sbp(c.message.chat.id,c.message.message_id,uk); bot.answer_callback_query(c.id); return
        if d.startswith("kick_bot:"):
            uk=d.split(":")[1]
            if not ia(c.from_user.id): return
            bot.edit_message_text("⚠️ Кикнуть?",c.message.chat.id,c.message.message_id,reply_markup=confirm_keyboard(f"kick:{uk}")); bot.answer_callback_query(c.id); return
        if d.startswith("confirm:"):
            parts=d.split(":"); ans=parts[-1]; aid=":".join(parts[1:-1])
            if ans=="no":
                cs(c.from_user.id); bot.answer_callback_query(c.id,"❌"); return
            if aid.startswith("del_paste:"):
                idx=int(aid.split(":")[1]); ps=lp()
                if 0<=idx<len(ps): ps.pop(idx); sp(ps)
                cs(c.from_user.id); bot.answer_callback_query(c.id,"✅"); return
            if aid.startswith("kick:"):
                tid=aid.split(":")[1]; us=lu()
                if tid in us:
                    td=us[tid]
                    if td.get('api_token'): rt(td['api_token'],"Kicked")
                    del us[tid]; su(us)
                cs(c.from_user.id); bot.answer_callback_query(c.id,"🚫"); return
        bot.answer_callback_query(c.id)
    except Exception as e: print("CB err:",e,flush=True)
def sbp(cid,mid,uk):
    us=lu()
    if uk not in us: return
    u=us[uk]
    hbi=u.get('heartbeat_interval',60)
    hb=lhb(); ci=u.get('computer_id'); ht="❓"
    if ci in hb:
        try:
            lm=int((datetime.now()-datetime.fromisoformat(hb[ci]['last_seen'])).total_seconds()/60)
            ht="🟢" if lm<2 else f"🔴 {lm}м"
        except: pass
    txt=(f"{ui_header(u.get('name',''),'🤖')}\n{ui_row('Режим',ui_mode(u.get('mode','normal')))}\n{ui_row('Пульс',ht)}\n{ui_row('💓 Интервал',hb_category(hbi))}\n{ui_row('Скрипты',len(u.get('assigned_pastes',[])))}")
    try: bot.edit_message_text(txt,cid,mid,parse_mode='HTML',reply_markup=bbpk(uk))
    except: pass
@bot.message_handler(func=lambda m: True, content_types=['text'])
def hm(m):
    u=m.from_user.id; auto_register_trusted(u)
    t=m.text.strip(); s=gs(u)
    if s:
        stp=s.get('step')
        if stp=='wp':
            if t==PASSWORD:
                us=lu(); us[str(u)]={'name':None,'username':s.get('username'),'is_bot':s.get('is_bot'),'is_admin':False}
                su(us); cs(u); bot.send_message(m.chat.id,"✅ Доступ разрешён")
            else: bot.send_message(m.chat.id,"❌ Неверный пароль")
            return
        if stp=='hb_wait':
            try: sec=int(t)
            except: bot.send_message(m.chat.id,"❌ Число"); return
            tgt=s.get('target'); us=lu()
            if tgt in us: us[tgt]['heartbeat_interval']=sec; su(us)
            cs(u); bot.send_message(m.chat.id,f"💓 {hb_category(sec)}"); return
        if stp=='add_file_wait':
            if t.lower() in ['/cancel']: cs(u); return
            name=s.get('paste_name'); e=enc(t); ps=lp(); ps.append({'name':name,'content':e,'hash':chash(t),'cid':u,'cn':dn(u)}); sp(ps)
            cs(u); bot.send_message(m.chat.id,f"✅ {safe(name)} создан"); return
        if stp=='edit_file_wait':
            if t.lower() in ['/cancel']: cs(u); return
            idx=s.get('idx'); ps=lp()
            if 0<=idx<len(ps): ps[idx]['content']=enc(t); sp(ps)
            cs(u); bot.send_message(m.chat.id,"✅ Обновлён"); return
        if stp=='dc':
            idx=s.get('idx')
            if t.lower() in ['да','yes']:
                ps=lp()
                if 0<=idx<len(ps): ps.pop(idx); sp(ps)
                cs(u); bot.send_message(m.chat.id,"✅ Удалён")
            else: cs(u); bot.send_message(m.chat.id,"❌")
            return
        return
    if t.startswith('/'):
        cn=t.split()[0][1:].lower().split('@')[0]
        if cn not in KNOWN: bot.send_message(m.chat.id,"❓ /help"); return
    if not reg(u):
        sets(u,{'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        bot.send_message(m.chat.id,"🔐 Пароль:"); return
    bot.send_message(m.chat.id,"💡 /menu",reply_markup=main_menu_keyboard(u))

class TS(ThreadingMixIn,HTTPServer): daemon_threads=True; allow_reuse_address=True
class AH(BaseHTTPRequestHandler):
    def log_message(self,f,*a):
        global tunnel_last_activity
        try: print("[API]",self.client_address[0],"-",f%a,flush=True)
        except: pass
        tunnel_last_activity=time.time()
    def _j(self,c,d):
        try:
            b=json.dumps(d,ensure_ascii=False).encode()
            self.send_response(c)
            self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin','*')
            self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type, bypass-tunnel-reminder, X-Computer-ID, X-Server-Key')
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
            self.send_header('Content-Length',str(len(b))); self.end_headers()
            self.wfile.write(b)
        except: pass
    def _b(self):
        l=int(self.headers.get('Content-Length',0)); return self.rfile.read(l).decode() if l>0 else ""
    def _check_friend_auth(self):
        k=self.headers.get('X-Server-Key','')
        if not k or k!=PASSWORD: return False
        cip=self.client_address[0]; fwd=self.headers.get('X-Forwarded-For','').split(',')[0].strip()
        return (fwd or cip)==FRIEND_SERVER_IP
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
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type, bypass-tunnel-reminder, X-Computer-ID, X-Server-Key')
        self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
        self.end_headers()
    def do_GET(self):
        try: self._get()
        except: pass
    def _get(self):
        tok,ib,v,r,ti=self._a(); p=self.path.split('?')[0]
        if p=='/api/health':
            check_tunnel_health()
            self._j(200,dict(tunnel_health,bot_version='17.19')); return
        if p=='/api/reload':
            threading.Thread(target=lambda: force_reload_tunnel("api"),daemon=True).start()
            self._j(200,{"ok":True}); return
        if p=='/api/url':
            u=tunnel()
            if u: self._j(200,{"url":u})
            else: self._j(503,{"error":"no"})
            return
        if p=='/api/check':
            q=self.path.split('?')[1] if '?' in self.path else ''
            pa=dict(x.split('=') for x in q.split('&') if '=' in x); pid=pa.get('id','')
            pe=lpend()
            if pid not in pe: self._j(404,{"error":"no"}); return
            s=pe[pid].get('status','pending'); rs={"status":s,"pending_id":pid}
            if s=='approved': rs.update({"token":pe[pid].get('token')})
            self._j(200,rs); return
        if p.startswith('/api/player/'):
            if not self._check_friend_auth(): self._j(403,{"error":"Unauthorized"}); return
            name=p.split('/')[-1]; fp=PLAYERS_DIR/f"{name}.txt"
            if not fp.exists(): self._j(404,{"error":"Not found"}); return
            self._j(200,{"name":name,"history":fp.read_text()}); return
        if p=='/api/me':
            if not tok: self._j(401,{"error":"no"}); return
            td=lt().get(tok,{}); us=lu(); pid=td.get('pending_id')
            um='normal'; up=[]; hbi=60
            if pid and pid in us:
                um=us[pid].get('mode','normal'); up=us[pid].get('assigned_pastes',[]); hbi=us[pid].get('heartbeat_interval',60)
            self._j(200,{"ok":True,"computer_id":td.get('computer_id'),"role":"bot" if ib else "human","assigned_pastes":up,"mode":um,"heartbeat_interval":hbi}); return
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
                    self._j(200,{"name":x['name'],"content":c}); return
            self._j(404,{"error":"no"}); return
        self._j(404,{"error":"no"})
    def do_POST(self):
        try: self._post()
        except: pass
    def _post(self):
        tok,ib,v,r,ti=self._a(); p=self.path.split('?')[0]
        b=self._b(); ci=self.headers.get('X-Computer-ID','')
        if p=='/api/player_data':
            try:
                d=json.loads(b) if b else {}
                process_player_data(d)
                self._j(200,{"ok":True,"processed":len(d.get('players',[]))}); return
            except Exception as e: self._j(500,{"error":str(e)}); return
        if p=='/api/login':
            try: d=json.loads(b)
            except: d={}
            if d.get('password')!=PASSWORD: self._j(401,{"error":"Wrong password"}); return
            us=lu(); ts=lt()
            lci=d.get('computer_id',ci or 'unk')
            for uid,ud in us.items():
                if ud.get('is_bot') and ud.get('computer_id')==lci:
                    et=ud.get('api_token')
                    if et and et in ts: self._j(200,{"ok":True,"status":"already_registered","token":et}); return
            pid=str(uuid.uuid4()); ft=str(uuid.uuid4())
            pe=lpend(); pe[pid]={'token':ft,'name':d.get('name'),'computer_id':lci,'status':'pending'}; spend(pe)
            # авто-одобрение для упрощения (можно убрать)
            ts[ft]={'name':d.get('name'),'computer_id':lci,'is_computer':True,'pending_id':pid}; st(ts)
            us[pid]={'name':d.get('name'),'computer_id':lci,'is_bot':True,'is_admin':False,'mode':'normal','assigned_pastes':[],'api_token':ft,'heartbeat_interval':60,'registered_at':datetime.now().isoformat()}
            su(us); pe[pid]['status']='approved'; spend(pe)
            self._j(200,{"ok":True,"status":"approved","token":ft}); return
        if p=='/api/heartbeat':
            if not ib: self._j(403,{"error":"no"}); return
            cv=ti.get('computer_id')
            if not cv: self._j(400,{"error":"no cid"}); return
            try: d=json.loads(b)
            except: d={}
            hb=lhb(); hb[cv]={'last_seen':datetime.now().isoformat(),'name':ti.get('name'),'mode':d.get('mode')}
            shb(hb); self._j(200,{"ok":True}); return
        self._j(404,{"error":"no"})

def start_api():
    while True:
        try:
            srv=TS(('0.0.0.0',PORT),AH); srv.timeout=5
            print("[API] Ready v17.19",flush=True)
            srv.serve_forever()
        except OSError:
            os.system(f"fuser -k {PORT}/tcp 2>/dev/null"); time.sleep(2)
        except: time.sleep(5)

def main():
    print("Starting bot v17.19...",flush=True)
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
    print("Bot ready!",flush=True)
    bot.infinity_polling(timeout=60,long_polling_timeout=60,skip_pending=True)

if __name__=='__main__':
    main()
