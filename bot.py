#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bot v17.26 — beautiful UI + mobile network (cloudflared) + survivability"""
import sys, os, io, json, base64, socket, threading, time, uuid, hashlib, re, subprocess, shutil
import html as html_lib, urllib.request
from urllib.parse import unquote
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from datetime import datetime, timezone, timedelta
import telebot
from telebot import types

BASE = Path.home() / "telegram-bot"; BASE.mkdir(parents=True, exist_ok=True)
CFG=BASE/"config.json"; USERS=BASE/"users.json"; PASTES=BASE/"pastes.json"
STATES=BASE/"user_states.json"; TOKENS=BASE/"api_tokens.json"; PENDING=BASE/"pending_tokens.json"
TUNNEL=BASE/"tunnel_url.txt"; HB=BASE/"heartbeats.json"; SITE_STATUS_FILE=BASE/"site_status.json"
TUNNEL_HEALTH_FILE=BASE/"tunnel_health.json"; ONLINE_TRACK_FILE=BASE/"online_tracking.json"
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
PROTECTED=set(cfg.get("protected_users",[])); PASSWORD=cfg.get("password","")
KEY=cfg.get("encryption_key","").encode()
MAX_N=cfg.get("max_name_length",12); MAX_PN=cfg.get("max_paste_name_length",20); PER=cfg.get("items_per_page",5)
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
    def close(s):
        try: s.file.close()
        except: pass
    def isatty(s): return False
_tee_out=TeeLogger(RUNTIME_LOG,sys.__stdout__); _tee_err=TeeLogger(RUNTIME_LOG,sys.__stderr__)
sys.stdout=_tee_out; sys.stderr=_tee_err

def get_last_log_lines(max_bytes=900_000):
    try:
        if not RUNTIME_LOG.exists(): return ""
        size=RUNTIME_LOG.stat().st_size
        if size<=max_bytes:
            with open(RUNTIME_LOG,'r',encoding='utf-8',errors='ignore') as f: return f.read()
        with open(RUNTIME_LOG,'rb') as f:
            f.seek(0,2); end=f.tell(); f.seek(max(0,end-max_bytes))
            if max(0,end-max_bytes)>0: f.readline()
            return f.read().decode('utf-8',errors='ignore')
    except Exception as e: return f"Error: {e}"
def clear_log():
    try:
        with open(RUNTIME_LOG,'w',encoding='utf-8') as f: f.write(f"[{datetime.now(MSK).isoformat()}] cleared\n")
    except: pass

# ===================== ТУННЕЛЬ: SSH + cloudflared (мобильная сеть) =====================
tunnel_process=None; current_tunnel_url=None; tunnel_lock=threading.Lock(); tunnel_last_activity=time.time()
def set_url(u):
    global current_tunnel_url
    with tunnel_lock: old=current_tunnel_url; current_tunnel_url=u
    if u!=old:
        post_url_to_channel(u)
        try: TUNNEL.write_text(u)
        except: pass
def post_url_to_channel(url,retries=5):
    now=datetime.now(MSK).strftime('%H:%M:%S')
    msg=f"🔄 <b>Туннель</b>\n🌐 <code>{url}</code>\n⏰ {now}\n📡 <code>t.me/s/capscraft_relay</code>"
    for _ in range(retries):
        try:
            bot.send_message(-1004388932854,msg,parse_mode='HTML',disable_web_page_preview=True); return True
        except: time.sleep(3)
    return False
def run_ssh_once():
    global tunnel_process,tunnel_last_activity
    try:
        p=subprocess.Popen(['ssh','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null',
            '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','ConnectTimeout=12',
            '-R',f'80:localhost:{PORT}','nokey@localhost.run'],
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        with tunnel_lock: tunnel_process=p
        tunnel_last_activity=time.time()
        for line in iter(p.stdout.readline,''):
            line=line.strip()
            if not line: continue
            tunnel_last_activity=time.time()
            m=re.search(r'(https://[a-z0-9-]+\.lhr\.life)',line)
            if m: set_url(m.group(1))
        p.wait(); return False
    except Exception as e:
        log(f"[Tunnel-ssh] {e}"); return False
def run_cf_once():
    global tunnel_process,tunnel_last_activity
    try:
        p=subprocess.Popen([cf_bin(),'tunnel','--url',f'http://localhost:{PORT}','--no-autoupdate'],
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        with tunnel_lock: tunnel_process=p
        tunnel_last_activity=time.time()
        for line in iter(p.stdout.readline,''):
            line=line.strip()
            if not line: continue
            tunnel_last_activity=time.time()
            m=re.search(r'(https://[a-z0-9-]+\.trycloudflare\.com)',line)
            if m: set_url(m.group(1))
        p.wait(); return False
    except Exception as e:
        log(f"[Tunnel-cf] {e}"); return False
def ensure_cloudflared():
    if shutil.which('cloudflared'): return True
    try: subprocess.run(['pkg','install','-y','cloudflared'],capture_output=True,timeout=120)
    except: pass
    return bool(shutil.which('cloudflared'))
def start_tunnel():
    ensure_cloudflared()
    method='ssh'; ssh_fails=0
    while True:
        if method=='ssh':
            if not run_ssh_once():
                ssh_fails+=1
                if ssh_fails>=2 and shutil.which('cloudflared'):
                    log("[Tunnel] SSH unstable (mobile network?) -> cloudflared")
                    method='cf'
            else: ssh_fails=0
        else:
            if not run_cf_once():
                method='ssh'; ssh_fails=0
        time.sleep(2)
def tunnel_watchdog():
    global tunnel_process
    time.sleep(60)
    while True:
        try:
            with tunnel_lock: p=tunnel_process
            if p and p.poll() is None and (time.time()-tunnel_last_activity)>90:
                log("[Watchdog] tunnel stale -> kill")
                try: p.kill()
                except: pass
        except: pass
        time.sleep(15)
def get_url():
    with tunnel_lock: u=current_tunnel_url
    if u: return u
    try:
        t=TUNNEL.read_text().strip()
        if t.startswith('http'): return t
    except: pass
    return cfg.get('tunnel_url')

# ===================== БАЗА =====================
def enc(t):
    try:
        b=t.encode(); s=hashlib.sha256(KEY).digest()
        return base64.b64encode(bytes(x^s[i%len(s)]^KEY[i%len(KEY)] for i,x in enumerate(b))).decode()
    except: return None
def dec(d):
    try:
        b=base64.b64decode(d); s=hashlib.sha256(KEY).digest()
        return bytes(x^s[i%len(s)]^KEY[i%len(KEY)] for i,x in enumerate(b)).decode()
    except: return None
def chash(t): return hashlib.sha256((str(t)+KEY.decode('utf-8','ignore')).encode()).hexdigest()[:16]
def rj(p,d):
    try:
        with open(p,'r',encoding='utf-8') as f: return json.load(f)
    except: return d
def wj(p,d):
    t=p.with_suffix('.tmp')
    try:
        with open(t,'w',encoding='utf-8') as f: json.dump(d,f,indent=2,ensure_ascii=False)
        os.replace(t,p)
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
    if uid in TRUSTED_PLAYERS:
        n=TRUSTED_PLAYERS[uid]
        if n==TECH or n in PROTECTED: return True
    d=lu().get(str(uid))
    if not d: return False
    if d.get('is_admin'): return True
    n=d.get('name'); return n==TECH or bool(n and n in PROTECTED)
def role(u):
    try: uid=int(u)
    except: return "user"
    if uid in TRUSTED_PLAYERS:
        n=TRUSTED_PLAYERS[uid]
        if n==TECH: return "tech"
        if n in PROTECTED: return "admin"
    d=lu().get(str(uid))
    if not d: return "user"
    if d.get('is_bot'): return "bot"
    if d.get('is_admin'): return "admin"
    return "user"
def aia():
    a=[]
    for s,d in lu().items():
        try:
            if ia(int(s)): a.append(int(s))
        except: pass
    for uid in TRUSTED_PLAYERS:
        if ia(uid) and uid not in a: a.append(uid)
    return a
def gs(u): return ls().get(str(u),{})
def sets(u,d):
    s=ls(); s[str(u)]=d; ss(s)
def cs(u):
    s=ls(); s.pop(str(u),None); ss(s)
def tr(t,m): return t if len(t)<=m else t[:m-1]+"…"
def safe(t): return "—" if t is None else html_lib.escape(str(t))
def ui_header(t,e="📋"): return f"{e} <b>{t}</b>\n<code>{'━'*28}</code>"
def ui_row(l,v,e="•"): return f"{e} {l}: <code>{safe(v)}</code>"
def ui_status(o): return "🟢 <b>Online</b>" if o else "🔴 <b>Offline</b>"
def ui_mode(m): return {"service":"🔧 Сервисный","fortress":"🚨 УСИЛЕННАЯ"}.get(m,"🔓 Обычный")
def ui_divider(): return f"<code>{'─'*20}</code>"
def msk_now(): return datetime.now(MSK)
def fmt_duration(sec):
    sec=int(max(0,sec))
    if sec<60: return f"{sec}с"
    m=sec//60
    if m<60: return f"{m}м"
    h=m//60; m%=60
    if h<24: return f"{h}ч {m}м"
    d=h//24; h%=24
    return f"{d}д {h}ч"
def gm_icon(g):
    g=(g or "unknown").lower()
    for k,v in (("surv","🗡"),("creat","🎨"),("adv","🧭"),("spec","👁")):
        if g.startswith(k): return v
    return "❔"
def auto_reg(u):
    try: uid=int(u)
    except: return False
    if uid not in TRUSTED_PLAYERS or reg(uid): return
    us=lu(); us[str(uid)]={'name':TRUSTED_PLAYERS[uid],'username':f"p_{uid}",'is_bot':False,'is_admin':ia(uid),'registered_at':datetime.now(MSK).isoformat(),'trusted':True}; su(us)

# ===================== TRACKING / VANISH =====================
player_online_since={}; server_online_since=None
def load_online_tracking():
    global player_online_since,server_online_since
    d=rj(ONLINE_TRACK_FILE,{}); player_online_since=d.get('players',{}); server_online_since=d.get('server')
def save_online_tracking(): wj(ONLINE_TRACK_FILE,{'players':player_online_since,'server':server_online_since})
def get_online_since(n): return player_online_since.get(n) or player_online_since.get(n.lower())
player_positions={}; player_vanish_since={}; player_file_lines={}; radar_first_seen={}; vanish_cooldown={}
def is_player_in_tab(name):
    try:
        d=rj(SITE_STATUS_FILE,{})
        return bool(d.get('online')) and name.lower() in [p.lower() for p in d.get('players_list',[])]
    except: return False
def is_teleport(name,x,z,ts):
    if name not in player_positions or len(player_positions[name])<3: return False
    pos=player_positions[name][-8:]; sp=[]
    for i in range(1,len(pos)):
        dt=pos[i]['timestamp']-pos[i-1]['timestamp']
        if dt>0: sp.append(((pos[i]['x']-pos[i-1]['x'])**2+(pos[i]['z']-pos[i-1]['z'])**2)**0.5/dt)
    return len(sp)>=2 and sp[-1]>=50
def save_player_history(name,line,imp):
    fp=PLAYERS_DIR/f"{name}.txt"
    try:
        with open(fp,'a',encoding='utf-8') as f: f.write(line+"\n")
    except: pass
    player_file_lines[name]=player_file_lines.get(name,0)+1
    if player_file_lines[name]>MAX_HISTORY:
        try:
            lines=fp.read_text().strip().split('\n'); fp.write_text('\n'.join(lines[-MAX_HISTORY:])); player_file_lines[name]=MAX_HISTORY
        except: pass
def notify_vanish(name,x,z,dim):
    msg=f"🚨 <b>ВАНИШ!</b>\n👤 <code>{safe(name)}</code>\n📍 <code>[{x:.0f},{z:.0f}]</code> {safe(dim)}\n⚠️ В радаре есть, в табе НЕТ\n⏰ {msk_now().strftime('%H:%M:%S')}"
    for a in aia():
        try:
            s=gs(a)
            if s.get('vanish_msg_id'):
                try: bot.edit_message_text(msg,a,s['vanish_msg_id'],parse_mode='HTML'); continue
                except: pass
            m=bot.send_message(a,msg,parse_mode='HTML'); s['vanish_msg_id']=m.message_id; sets(a,s)
        except: pass
def clear_vanish_notifications():
    for a in aia():
        s=gs(a)
        if s.get('vanish_msg_id'):
            try: bot.delete_message(a,s['vanish_msg_id'])
            except: pass
            s.pop('vanish_msg_id',None); sets(a,s)
def clear_vanish_for_player(name):
    player_vanish_since.pop(name,None); radar_first_seen.pop(name,None); clear_vanish_notifications()
def process_player_data(data):
    if not isinstance(data,dict): return
    now=time.time(); plu=data.get('players',[])
    if not isinstance(plu,list): return
    cur={p.get('name').strip() for p in plu if isinstance(p,dict) and isinstance(p.get('name'),str)}
    for n in list(player_vanish_since):
        if n not in cur: clear_vanish_for_player(n)
    for p in plu:
        if not isinstance(p,dict): continue
        name=p.get('name')
        if not isinstance(name,str) or not name.strip(): continue
        name=name.strip()
        if len(name)<2 or len(name)>16 or not re.match(r'^[A-Za-z0-9_]+$',name): continue
        try:
            x,y,z=float(p.get('x',0)),float(p.get('y',0)),float(p.get('z',0))
            hp,mh=float(p.get('health',20)),float(p.get('maxHealth',20)); eye=float(p.get('eyeHeight',1.62))
            yaw,pit=float(p.get('yaw',0)),float(p.get('pitch',0)); ts=float(p.get('timestamp',now))
        except (TypeError,ValueError): continue
        dim=str(p.get('dimension','unknown'))[:32]; gm=str(p.get('gamemode','unknown'))[:16]
        player_positions.setdefault(name,[]).append({'x':x,'y':y,'z':z,'timestamp':ts,'dimension':dim,'gamemode':gm})
        if len(player_positions[name])>100: player_positions[name]=player_positions[name][-100:]
        radar_first_seen.setdefault(name,ts)
        it=is_player_in_tab(name)
        if not it and (ts-radar_first_seen.get(name,ts))>VANISH_GRACE:
            player_vanish_since.setdefault(name,ts)
            if now-vanish_cooldown.get(name,0)>VANISH_NOTIFY_CD:
                vanish_cooldown[name]=now; notify_vanish(name,x,z,dim)
        elif it:
            player_vanish_since.pop(name,None); radar_first_seen.pop(name,None)
        vn=name in player_vanish_since
        imp=vn or is_teleport(name,x,z,ts)
        s=get_online_since(name); osec=int(now-s) if s else 0
        t=datetime.fromtimestamp(ts,MSK).strftime('%H:%M:%S')
        save_player_history(name,f"{t}|{x:.1f},{y:.1f},{z:.1f}|{dim}|{hp:.1f}|{mh:.1f}|{eye:.2f}|{yaw:.1f}|{pit:.1f}|standing|{'true' if it else 'false'}|{'true' if vn else 'false'}|{'true' if imp else 'false'}|{osec}|{gm}",imp)
def vanish_checker_loop():
    while True:
        try:
            if not player_vanish_since: clear_vanish_notifications()
        except: pass
        time.sleep(5)

# ===================== SITE / WATCHER =====================
def parse_site_status():
    global server_online_since
    try:
        req=urllib.request.Request(SITE_URL,headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req,timeout=15) as r: h=r.read().decode('utf-8')
        on=bool(re.search(r"minecraftserverinfo\s+isonline",h,re.I))
        pl=[]
        for nick in re.findall(r"alt='([A-Za-z0-9_]{3,16})s Avatar'",h):
            if nick not in pl: pl.append(nick)
        now=time.time(); server_online_since=now if on else None
        for n in pl: player_online_since.setdefault(n,now)
        for n in list(player_online_since):
            if n not in pl: player_online_since.pop(n,None)
        save_online_tracking()
        d={'online':on,'players_online':len(pl),'players_list':pl,'address':'gmd.capscraft.com','server_online_since':server_online_since}
        wj(SITE_STATUS_FILE,d); return d
    except Exception as e:
        log(f"[Site] {e}"); return None
def site_checker_loop():
    while True:
        s=parse_site_status()
        if s: log(f"[Site] {'🟢' if s['online'] else '🔴'} ({s['players_online']})")
        time.sleep(60)
def watcher_loop():
    while True:
        time.sleep(30)
        try:
            if not rj(SITE_STATUS_FILE,{}).get('online'): continue
            hb=lhb(); us=lu(); now=datetime.now(MSK)
            gk=cfg.get('kiktime_minutes',10)*60
            for uid,u in list(us.items()):
                if not u.get('is_bot') or u.get('mode')=='service': continue
                lim=(u.get('kiktime_override')*60) if u.get('kiktime_override') else gk
                cid=u.get('computer_id')
                if not cid: continue
                base=(hb.get(cid) or {}).get('last_seen') or u.get('registered_at')
                if not base: continue
                try: delta=(now-datetime.fromisoformat(base)).total_seconds()
                except: continue
                if delta<180 or delta<=lim: continue
                at=u.get('api_token'); n=u.get('name','?')
                log(f"[Watcher] KICK {n}")
                if at: rt(at,f"Авто-кик {int(delta/60)} мин")
                h2=lhb(); h2.pop(cid,None); shb(h2)
                us.pop(uid,None); su(us); na(f"🚫 <b>АВТО-КИК</b>\n🤖 <code>{safe(n)}</code>")
        except: pass
def rt(tok,r=""):
    ts=lt()
    if tok in ts:
        td=ts.pop(tok); st(ts); us=lu(); pid=td.get('pending_id')
        if pid and pid in us:
            us.pop(pid,None); su(us)

# ===================== TUNNEL HEALTH =====================
tunnel_health={'status':'unknown'}
def check_tunnel_health():
    global tunnel_health
    try:
        u=get_url()
        if not u: tunnel_health['status']='no_url'; return
        req=urllib.request.Request(f'{u}/api/url',headers={'bypass-tunnel-reminder':'1'})
        with urllib.request.urlopen(req,timeout=10) as r:
            tunnel_health['status']='ok' if r.status==200 else 'down'
    except: tunnel_health['status']='down'
def tunnel_health_loop():
    time.sleep(5)
    while True:
        try: check_tunnel_health()
        except: pass
        time.sleep(60)
def get_tunnel_status_text():
    s=tunnel_health.get('status'); u=get_url() or 'не настроен'
    return {"ok":f"🟢 Работает\n{ui_row('URL',u)}","down":f"🟡 Недоступен\n{ui_row('URL',u)}","no_url":"⚫ URL не настроен"}.get(s,f"❓ {safe(s)}")

# ===================== UI BUILDERS =====================
def build_help_text():
    return (f"{ui_header('Справка v17.26','📖')}\n\n<b>🚀 Команды:</b>\n<code>/start</code> пуск\n<code>/menu</code> меню\n<code>/status</code> статус (авто 5с)\n<code>/api</code> API\n<code>/api_reload</code> рестарт туннеля\n\n<b>📋 Пасты:</b>\n<code>/past</code> список\n<code>/past add name</code> создать\n<code>/past edit N</code> изменить\n<code>/past delete N</code> удалить\n\n<b>👥 Компьютеры:</b>\n<code>/all</code> список\n<code>/all assign COMP paste</code> привязать\n<code>/all kick COMP</code> кик")
def build_status_text():
    s=parse_site_status() or rj(SITE_STATUS_FILE,None)
    if not s: return None
    pl=s.get('players_list',[]); now=time.time()
    txt=f"{ui_header('Статус сервера','🌐')}\n\n{ui_status(s.get('online'))}\n📡 <code>{safe(s.get('address'))}</code>\n"
    if s.get('online') and server_online_since: txt+=f"⏱ <code>{fmt_duration(now-server_online_since)}</code>\n"
    txt+="\n"
    coords={n.lower():p[-1] for n,p in player_positions.items() if p}
    if pl:
        txt+=f"<b>👤 Онлайн ({len(pl)}):</b>\n"
        for nick in pl[:30]:
            c=coords.get(nick.lower()); v="🚨" if nick in player_vanish_since else "🟢"
            g=gm_icon(c.get('gamemode')) if c else ""
            sn=get_online_since(nick); d=f" ⏱{fmt_duration(now-sn)}" if sn else ""
            txt+=f"  • {g} <code>{safe(nick)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}]{d} {v}\n" if c else f"  • <code>{safe(nick)}</code> 📍{d} {v}\n"
    else: txt+="<i>🔇 никого</i>\n" if s.get('online') else "<i>💤 оффлайн</i>\n"
    onl=[p.lower() for p in pl]
    van=[(n,player_positions[n][-1]) for n in player_vanish_since if player_positions.get(n) and n.lower() not in onl]
    if van:
        txt+=f"\n<b>🚨 ВАНИШ ({len(van)}):</b>\n"
        for n,c in van: txt+=f"  • {gm_icon(c.get('gamemode'))} <code>{safe(n)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}] 🚨\n"
    rt_=sum(1 for u in lu().values() if u.get('is_bot') and 'radar' in u.get('assigned_pastes',[]))
    hb=lhb(); on=sum(1 for u in lu().values() if u.get('is_bot') and 'radar' in u.get('assigned_pastes',[]) and u.get('computer_id') in hb and (now-datetime.fromisoformat(hb[u['computer_id']]['last_seen'])).total_seconds()<120)
    txt+=f"\n<b>📡 Радары (всего:{rt_} 🟢{on} 🔴{rt_-on}):</b>\n"
    rad=[(n,p[-1]) for n,p in player_positions.items() if p]
    for n,c in rad[:20]:
        txt+=f"  • {gm_icon(c.get('gamemode'))} <code>{safe(n)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}] {'🟢' if n.lower() in onl else '🚨'}\n"
    if not rad: txt+="  <i>нет данных</i>\n"
    txt+=f"\n<i>🕐 {msk_now().strftime('%H:%M:%S')} (авто 5с)</i>"
    return txt
def status_keyboard():
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Обновить",callback_data="refresh:status"),types.InlineKeyboardButton("⏸ Стоп",callback_data="stop_auto"))
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb
def status_auto_refresh_loop():
    while True:
        time.sleep(STATUS_REFRESH_INTERVAL)
        try:
            with active_status_lock: ch=list(active_status_messages.items())
            if not ch: continue
            txt=build_status_text()
            if not txt: continue
            kb=status_keyboard()
            for cid,mid in ch:
                try: bot.edit_message_text(txt,cid,mid,parse_mode='HTML',reply_markup=kb)
                except Exception as e:
                    if any(k in str(e) for k in ("MESSAGE_EDIT_TIME_LIMIT","chat not found","Forbidden","not modified")):
                        with active_status_lock: active_status_messages.pop(cid,None)
        except: pass
def reg_status(cid,mid):
    with active_status_lock: active_status_messages[cid]=mid
def unreg_status(cid):
    with active_status_lock: active_status_messages.pop(cid,None)
def main_menu_keyboard(uid):
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("📋 Пасты",callback_data="menu:past"),types.InlineKeyboardButton("👥 Компьютеры",callback_data="menu:all"))
    kb.add(types.InlineKeyboardButton("🌐 Сервер",callback_data="menu:status"),types.InlineKeyboardButton("🖥 API",callback_data="menu:api"))
    kb.add(types.InlineKeyboardButton("❓ Помощь",callback_data="menu:help")); return kb
def back_kb():
    kb=types.InlineKeyboardMarkup(); kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb
def bpk(ps,pg):
    tp=max(1,(len(ps)+PER-1)//PER); pg=max(0,min(pg,tp-1)); it=ps[pg*PER:pg*PER+PER]
    kb=types.InlineKeyboardMarkup(row_width=1)
    for i,p in enumerate(it): kb.add(types.InlineKeyboardButton(f"{pg*PER+i+1}. 📄 {safe(tr(p['name'],MAXPN))}",callback_data=f"pv:{pg*PER+i}"))
    nav=[]
    if pg>0: nav.append(types.InlineKeyboardButton("◀️",callback_data=f"pp:{pg-1}"))
    nav.append(types.InlineKeyboardButton(f"{pg+1}/{tp}",callback_data="noop"))
    if pg<tp-1: nav.append(types.InlineKeyboardButton("▶️",callback_data=f"pp:{pg+1}"))
    if nav: kb.row(*nav)
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb,pg,tp
def buk(ud,pg):
    it=list(ud.items()); tp=max(1,(len(it)+PER-1)//PER); pg=max(0,min(pg,tp-1)); ip=it[pg*PER:pg*PER+PER]
    kb=types.InlineKeyboardMarkup(row_width=1)
    for i,(uk,d) in enumerate(ip):
        ic={"tech":"🛠","admin":"👑","bot":"🤖"}.get(role(uk),"👤")
        extra=f" 📋{len(d.get('assigned_pastes',[]))}" if d.get('is_bot') else ""
        kb.add(types.InlineKeyboardButton(f"{pg*PER+i+1}. {ic} {safe(tr(d.get('name') or uk,MAX_N))}{extra}",callback_data=f"av:{uk}"))
    nav=[]
    if pg>0: nav.append(types.InlineKeyboardButton("◀️",callback_data=f"ap:{pg-1}"))
    nav.append(types.InlineKeyboardButton(f"{pg+1}/{tp}",callback_data="noop"))
    if pg<tp-1: nav.append(types.InlineKeyboardButton("▶️",callback_data=f"ap:{pg+1}"))
    if nav: kb.row(*nav)
    kb.add(types.InlineKeyboardButton("🔙 Меню",callback_data="menu:main")); return kb,pg,tp
def bbpk(uk):
    u=lu().get(uk,{}); m=u.get('mode','normal')
    kb=types.InlineKeyboardMarkup(row_width=2)
    if u.get('is_bot'):
        kb.add(types.InlineKeyboardButton("🔧 Режим" if m!='service' else "🔓 Режим",callback_data=f"mode:{uk}"))
        kb.add(types.InlineKeyboardButton("🚫 Кик",callback_data=f"confirm:kick:{uk}:yes"))
    kb.add(types.InlineKeyboardButton("🔙 Назад",callback_data="menu:all")); return kb
def confirm_kb(a):
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("✅ Да",callback_data=f"confirm:{a}:yes"),types.InlineKeyboardButton("❌ Нет",callback_data=f"confirm:{a}:no")); return kb
def build_api_text():
    u=get_url() or f"http://{LIP}:{PORT}"
    return f"{ui_header('API','🖥')}\n⏱ <code>{fmt_duration(time.time()-BOT_START)}</code>\n{ui_row('URL',u)}\n{ui_row('Пароль',PASSWORD)}\n{ui_row('Порт',PORT)}\n📡 @capscraft_relay\n🌐 {get_tunnel_status_text()}"
def show_paste_profile(c,idx):
    ps=lp()
    if idx<0 or idx>=len(ps): return
    p=ps[idx]; c_=dec(p['content'])
    if not c_: return
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🗑 Удалить",callback_data=f"confirm:del:{idx}:yes"),types.InlineKeyboardButton("🔙",callback_data="menu:past"))
    try: bot.edit_message_text(f"{ui_header(p['name'],'📄')}\n{ui_row('Размер',f'{len(c_)} байт')}",c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=kb)
    except: pass
    try:
        fo=io.BytesIO(c_.encode()); fo.name=f"{p['name']}.txt"
        bot.send_document(c.message.chat.id,fo,caption=f"📄 {p['name']}")
    except: pass

# ===================== HANDLERS =====================
@bot.message_handler(commands=['start'])
def c_start(m):
    u=m.from_user.id; auto_reg(u); unreg_status(m.chat.id)
    if not reg(u):
        sets(u,{'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        bot.send_message(m.chat.id,f"{ui_header('Добро пожаловать','👋')}\n🔐 Пароль:",parse_mode='HTML')
    else:
        bot.send_message(m.chat.id,f"{ui_header('С возвращением','🚀')}\n👤 <b>{safe(dn(u))}</b>\n{ui_row('Роль',role(u))}\n\n /menu",parse_mode='HTML',reply_markup=main_menu_keyboard(u))
@bot.message_handler(commands=['menu'])
def c_menu(m):
    if not reg(m.from_user.id): return bot.send_message(m.chat.id,"/start")
    unreg_status(m.chat.id)
    us=lu(); bc=sum(1 for u in us.values() if u.get('is_bot'))
    bot.send_message(m.chat.id,f"{ui_header('Меню','📱')}\n🤖 {bc} | 👤 {len(us)-bc} | 📄 {len(lp())}",parse_mode='HTML',reply_markup=main_menu_keyboard(m.from_user.id))
@bot.message_handler(commands=['help'])
def c_help(m):
    if reg(m.from_user.id): bot.send_message(m.chat.id,build_help_text(),parse_mode='HTML',reply_markup=back_kb())
@bot.message_handler(commands=['status'])
def c_status(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id,"❌")
    t=build_status_text()
    if t:
        msg=bot.send_message(m.chat.id,t,parse_mode='HTML',reply_markup=status_keyboard()); reg_status(m.chat.id,msg.message_id)
@bot.message_handler(commands=['api'])
def c_api(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id,"❌")
    kb=types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("🔄 Рестарт туннеля",callback_data="reload_tunnel"))
    bot.send_message(m.chat.id,build_api_text(),parse_mode='HTML',reply_markup=kb)
@bot.message_handler(commands=['api_reload'])
def c_api_reload(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id,"❌")
    threading.Thread(target=lambda: force_reload(),daemon=True).start()
    bot.send_message(m.chat.id,"🔄 Перезагрузка туннеля...",parse_mode='HTML')
def force_reload():
    global tunnel_process
    with tunnel_lock:
        if tunnel_process:
            try: tunnel_process.kill()
            except: pass
@bot.message_handler(commands=['log'])
def c_log(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id,"❌")
    c=get_last_log_lines()
    fo=io.BytesIO(c.encode()); fo.name="bot.log"
    bot.send_document(m.chat.id,fo,caption=f"📄 {len(c)} байт")
@bot.message_handler(commands=['log_clear'])
def c_log_clear(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id,"❌")
    clear_log(); bot.send_message(m.chat.id,"✅ Очищено")
@bot.message_handler(commands=['past'])
def c_past(m):
    if not reg(m.from_user.id): return
    a=m.text.split()[1:]
    if not a:
        kb,_,_=bpk(lp(),0); return bot.send_message(m.chat.id,"📋 Пасты",reply_markup=kb)
    s=a[0].lower()
    if s=='add' and len(a)>=3:
        n=tr(a[1],MAX_PN).lower(); c=' '.join(a[2:])
        ps=lp(); ps.append({'name':n,'content':enc(c),'hash':chash(c),'cid':m.from_user.id,'cn':dn(m.from_user.id)}); sp(ps)
        bot.send_message(m.chat.id,f"✅ <code>{safe(n)}</code>")
    elif s=='add' and len(a)==2:
        sets(m.from_user.id,{'step':'addw','paste_name':tr(a[1],MAX_PN).lower()})
        bot.send_message(m.chat.id,"📄 текст/файл или /cancel")
    elif s=='edit' and len(a)>=2:
        i,p=find_paste(a[1],lp())
        if i is not None:
            sets(m.from_user.id,{'step':'editw','idx':i}); bot.send_message(m.chat.id,"✏️ текст/файл или /cancel")
    elif s=='delete' and len(a)>=2:
        i,p=find_paste(a[1],lp())
        if i is not None: bot.send_message(m.chat.id,f"⚠️ Удалить <code>{safe(p['name'])}</code>?",reply_markup=confirm_kb(f"del:{i}"))
@bot.message_handler(commands=['all'])
def c_all(m):
    if not reg(m.from_user.id): return
    a=m.text.split()[1:]
    if not a:
        kb,_,_=buk(lu(),0); return bot.send_message(m.chat.id,"👥 Компьютеры",reply_markup=kb)
    if not ia(m.from_user.id): return bot.send_message(m.chat.id,"❌")
    s=a[0].lower(); us=lu()
    if s=='assign' and len(a)>=3:
        t,d=find_user(a[1],list(us.items()))
        if t and d.get('is_bot'):
            cp=d.get('assigned_pastes',[]); cp.append(a[2].lower()); us[t]['assigned_pastes']=cp; su(us)
            bot.send_message(m.chat.id,f"✅ привязан <code>{safe(a[2])}</code>")
    elif s=='kick' and len(a)>=2:
        t,d=find_user(a[1],list(us.items()))
        if t: bot.send_message(m.chat.id,f"⚠️ Кикнуть <code>{safe(d.get('name'))}</code>?",reply_markup=confirm_kb(f"kick:{t}"))
def find_user(a,ul):
    try:
        i=int(a)-1
        if 0<=i<len(ul): return ul[i]
    except: pass
    al=a.lower()
    for t,d in ul:
        if (d.get('name') or '').lower()==al: return t,d
    return None,None
def find_paste(a,pl):
    try:
        i=int(a)-1
        if 0<=i<len(pl): return i,pl[i]
    except: pass
    al=a.lower()
    for i,p in enumerate(pl):
        if p['name'].lower()==al: return i,p
    return None,None

# ===================== CALLBACK =====================
@bot.callback_query_handler(func=lambda c: True)
def cb(c):
    try:
        if not c.message: return bot.answer_callback_query(c.id)
        d=c.data
        if d=="stop_auto": unreg_status(c.message.chat.id); bot.answer_callback_query(c.id,"⏸"); return
        if d=="refresh:status":
            t=build_status_text()
            if t:
                try: bot.edit_message_text(t,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=status_keyboard()); reg_status(c.message.chat.id,c.message.message_id)
                except: pass
            bot.answer_callback_query(c.id,"🔄"); return
        if d=="reload_tunnel":
            if ia(c.from_user.id): threading.Thread(target=force_reload,daemon=True).start()
            bot.answer_callback_query(c.id,"🔄"); return
        if d.startswith("menu:"):
            s=d.split(":")[1]
            if s=="main":
                us=lu(); bot.edit_message_text(f"{ui_header('Меню','📱')}\n🤖 {sum(1 for u in us.values() if u.get('is_bot'))} | 📄 {len(lp())}",c.message.chat.id,c.message.message_id,reply_markup=main_menu_keyboard(c.from_user.id))
            elif s=="past":
                kb,_,_=bpk(lp(),0); bot.edit_message_text("📋 Пасты",c.message.chat.id,c.message.message_id,reply_markup=kb)
            elif s=="all":
                kb,_,_=buk(lu(),0); bot.edit_message_text("👥 Компьютеры",c.message.chat.id,c.message.message_id,reply_markup=kb)
            elif s=="status":
                t=build_status_text()
                if t: bot.edit_message_text(t,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=status_keyboard()); reg_status(c.message.chat.id,c.message.message_id)
            elif s=="api":
                kb=types.InlineKeyboardMarkup(row_width=2); kb.add(types.InlineKeyboardButton("🔄 Рестарт",callback_data="reload_tunnel"))
                bot.edit_message_text(build_api_text(),c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=kb)
            elif s=="help": bot.edit_message_text(build_help_text(),c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=back_kb())
            bot.answer_callback_query(c.id); return
        if d.startswith("pp:"):
            kb,_,_=bpk(lp(),int(d.split(":")[1])); bot.edit_message_reply_markup(c.message.chat.id,c.message.message_id,reply_markup=kb); bot.answer_callback_query(c.id); return
        if d.startswith("ap:"):
            kb,_,_=buk(lu(),int(d.split(":")[1])); bot.edit_message_reply_markup(c.message.chat.id,c.message.message_id,reply_markup=kb); bot.answer_callback_query(c.id); return
        if d.startswith("pv:"): show_paste_profile(c,int(d.split(":")[1])); bot.answer_callback_query(c.id); return
        if d.startswith("av:"):
            uk=d.split(":")[1]; u=lu().get(uk,{})
            kb=bbpk(uk)
            hb=lhb(); ci=u.get('computer_id'); ht="❓"
            if ci and ci in hb:
                try:
                    lm=int((datetime.now(MSK)-datetime.fromisoformat(hb[ci]['last_seen'])).total_seconds()/60)
                    ht="🟢" if lm<2 else f"🔴{lm}м"
                except: pass
            txt=f"{ui_header(u.get('name',''),'🤖')}\n{ui_row('Режим',ui_mode(u.get('mode','normal')))}\n{ui_row('Пульс',ht)}\n📋 {', '.join(u.get('assigned_pastes',[])) or 'нет'}"
            bot.edit_message_text(txt,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=kb)
            bot.answer_callback_query(c.id); return
        if d.startswith("mode:"):
            uk=d.split(":")[1]
            if ia(c.from_user.id):
                us=lu()
                if uk in us and us[uk].get('is_bot'):
                    us[uk]['mode']='service' if us[uk].get('mode')!='service' else 'normal'; su(us)
            bot.answer_callback_query(c.id,"🔧"); return
        if d.startswith("confirm:"):
            p=d.split(":"); a=p[-1]; aid=":".join(p[1:-1])
            if a!="yes": bot.answer_callback_query(c.id,"❌"); return
            if aid.startswith("del:"):
                i=int(aid.split(":")[1]); ps=lp()
                if 0<=i<len(ps): ps.pop(i); sp(ps)
                bot.answer_callback_query(c.id,"✅")
            elif aid.startswith("kick:"):
                t=aid.split(":")[1]; us=lu()
                if t in us:
                    if us[t].get('api_token'): rt(us[t]['api_token'],"кик")
                    us.pop(t,None); su(us)
                bot.answer_callback_query(c.id,"🚫")
            return
        bot.answer_callback_query(c.id)
    except Exception as e:
        log(f"[CB] {e}")
        try: bot.answer_callback_query(c.id)
        except: pass

# ===================== TEXT =====================
@bot.message_handler(func=lambda m: True, content_types=['text'])
def hm(m):
    u=m.from_user.id; auto_reg(u); t=m.text.strip(); s=gs(u)
    if s:
        stp=s.get('step')
        if stp=='wp':
            if t==PASSWORD:
                us=lu(); us[str(u)]={'name':None,'username':s.get('username'),'is_bot':s.get('is_bot'),'is_admin':False}; su(us); cs(u)
                bot.send_message(m.chat.id,"✅ доступ")
            else: bot.send_message(m.chat.id,"❌ пароль")
            return
        if stp=='addw':
            if t.lower()=='/cancel': cs(u); return
            ps=lp(); ps.append({'name':s['paste_name'],'content':enc(t),'hash':chash(t),'cid':u,'cn':dn(u)}); sp(ps); cs(u)
            bot.send_message(m.chat.id,f"✅ <code>{safe(s['paste_name'])}</code>"); return
        if stp=='editw':
            if t.lower()=='/cancel': cs(u); return
            i=s.get('idx'); ps=lp()
            if 0<=i<len(ps): ps[i]['content']=enc(t); sp(ps)
            cs(u); bot.send_message(m.chat.id,"✅"); return
    if t.startswith('/') and t.split()[0][1:].lower().split('@')[0] not in KNOWN:
        return bot.send_message(m.chat.id,"❓ /help")
    if not reg(u):
        sets(u,{'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        return bot.send_message(m.chat.id,"🔐 Пароль:")
    bot.send_message(m.chat.id,"💡 /menu",reply_markup=main_menu_keyboard(u))

# ===================== HTTP API =====================
class TS(ThreadingMixIn,HTTPServer): daemon_threads=True; allow_reuse_address=True
class AH(BaseHTTPRequestHandler):
    def log_message(s,f,*a):
        try: log(f"[API] {s.client_address[0]} {f%a}")
        except: pass
    def _j(s,c,d):
        try:
            b=json.dumps(d,ensure_ascii=False).encode()
            s.send_response(c); s.send_header('Content-Type','application/json')
            s.send_header('Access-Control-Allow-Origin','*')
            s.send_header('Access-Control-Allow-Headers','Authorization,Content-Type,bypass-tunnel-reminder,X-Computer-ID,X-Server-Key')
            s.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
            s.send_header('Content-Length',str(len(b))); s.end_headers(); s.wfile.write(b)
        except: pass
    def _b(s):
        l=int(s.headers.get('Content-Length',0))
        return s.rfile.read(l).decode() if 0<l<10*1024*1024 else ""
    def _friend(s):
        return s.headers.get('X-Server-Key')==PASSWORD and s.client_address[0]==FRIEND_SERVER_IP
    def _a(s):
        au=s.headers.get('Authorization',''); ci=s.headers.get('X-Computer-ID','')
        if not au.startswith('Bearer '): return None,None,False
        tok=au[7:].strip(); ts=lt()
        if tok not in ts: return None,None,False
        ti=ts[tok]; return tok,ti.get('is_computer',False),True
    def do_OPTIONS(s):
        s.send_response(200)
        s.send_header('Access-Control-Allow-Origin','*')
        s.send_header('Access-Control-Allow-Headers','Authorization,Content-Type,bypass-tunnel-reminder,X-Computer-ID,X-Server-Key')
        s.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); s.end_headers()
    def do_GET(s):
        try: s._get()
        except: pass
    def _get(s):
        tok,ib,ok=s._a(); p=s.path.split('?')[0]
        if p=='/api/health': return s._j(200,{"status":tunnel_health.get('status'),"version":"17.26"})
        if p=='/api/reload':
            threading.Thread(target=force_reload,daemon=True).start(); return s._j(200,{"ok":True})
        if p=='/api/url':
            u=get_url(); return s._j(200,{"url":u}) if u else s._j(503,{"error":"no"})
        if p=='/api/check':
            q=dict(x.split('=') for x in (s.path.split('?')[1].split('&') if '?' in s.path else []))
            pe=lpend(); pid=q.get('id','')
            if pid not in pe: return s._j(404,{"error":"no"})
            r={"status":pe[pid].get('status'),"pending_id":pid}
            if r['status']=='approved': r['token']=pe[pid].get('token')
            return s._j(200,r)
        if p.startswith('/api/player/') and s._friend():
            n=p.split('/')[-1]; fp=PLAYERS_DIR/f"{n}.txt"
            return s._j(200,{"name":n,"history":fp.read_text()}) if fp.exists() else s._j(404,{"error":"no"})
        if not ok: return s._j(401,{"error":"auth"})
        if p=='/api/me':
            ts=lt(); ti=ts[tok]; us=lu(); pid=ti.get('pending_id')
            um,up,hbi='normal',[],30
            if pid and pid in us: um=us[pid].get('mode','normal'); up=us[pid].get('assigned_pastes',[]); hbi=us[pid].get('heartbeat_interval',30)
            return s._j(200,{"ok":True,"computer_id":ti.get('computer_id'),"mode":um,"assigned_pastes":up,"heartbeat_interval":hbi})
        if p.startswith('/api/paste/'):
            n=unquote(p[len('/api/paste/'):]).lower()
            if ib:
                us=lu(); pid=ts[tok].get('pending_id')
                al=[x.lower() for x in us.get(pid,{}).get('assigned_pastes',[])] if pid and pid in us else []
                if n not in al: return s._j(403,{"error":"PANIC"})
            for x in lp():
                if x['name'].lower()==n:
                    c=dec(x['content'])
                    return s._j(200,{"name":x['name'],"content":c}) if c else s._j(500,{"error":"decrypt"})
            return s._j(404,{"error":"no"})
        s._j(404,{"error":"no"})
    def do_POST(s):
        try: s._post()
        except: pass
    def _post(s):
        tok,ib,ok=s._a(); p=s.path.split('?')[0]; b=s._b(); ci=s.headers.get('X-Computer-ID','')
        if p=='/api/player_data':
            try:
                process_player_data(json.loads(b) if b else {}); return s._j(200,{"ok":True})
            except Exception as e: return s._j(500,{"error":str(e)})
        if p=='/api/reload':
            threading.Thread(target=force_reload,daemon=True).start(); return s._j(200,{"ok":True})
        if p=='/api/login':
            try: d=json.loads(b) if b else {}
            except: d={}
            if d.get('password')!=PASSWORD: return s._j(401,{"error":"bad"})
            us=lu(); ts=lt(); lci=d.get('computer_id',ci or 'unk')
            for uid,ud in us.items():
                if ud.get('is_bot') and ud.get('computer_id')==lci and ud.get('api_token') in ts:
                    return s._j(200,{"ok":True,"status":"already_registered","token":ud['api_token']})
            pid,ft=str(uuid.uuid4()),str(uuid.uuid4())
            pe=lpend(); pe[pid]={'token':ft,'name':d.get('name'),'computer_id':lci,'status':'pending'}; spend(pe)
            ts[ft]={'name':d.get('name'),'computer_id':lci,'is_computer':True,'pending_id':pid}; st(ts)
            us[pid]={'name':d.get('name'),'computer_id':lci,'is_bot':True,'is_admin':False,'mode':'normal','assigned_pastes':[],'api_token':ft,'heartbeat_interval':30,'registered_at':datetime.now(MSK).isoformat()}; su(us)
            pe[pid]['status']='approved'; spend(pe)
            return s._j(200,{"ok":True,"status":"approved","token":ft})
        if p=='/api/heartbeat':
            if not ib: return s._j(403,{"error":"no"})
            cv=ts[tok].get('computer_id')
            if not cv: return s._j(400,{"error":"cid"})
            try: d=json.loads(b) if b else {}
            except: d={}
            hb=lhb(); hb[cv]={'last_seen':datetime.now(MSK).isoformat(),'name':ts[tok].get('name'),'mode':d.get('mode')}; shb(hb)
            return s._j(200,{"ok":True})
        s._j(404,{"error":"no"})
def start_api():
    while True:
        try:
            srv=TS(('0.0.0.0',PORT),AH); srv.timeout=5
            log(f"[API] Ready v17.26 on {PORT}"); srv.serve_forever()
        except OSError:
            os.system(f"fuser -k {PORT}/tcp 2>/dev/null"); time.sleep(2)
        except: time.sleep(5)

def main():
    log("Starting bot v17.26 (beautiful UI + mobile + survivability)...")
    load_online_tracking()
    threading.Thread(target=start_tunnel,daemon=True).start()
    threading.Thread(target=tunnel_watchdog,daemon=True).start()
    time.sleep(2)
    threading.Thread(target=start_api,daemon=True).start()
    threading.Thread(target=site_checker_loop,daemon=True).start()
    threading.Thread(target=watcher_loop,daemon=True).start()
    threading.Thread(target=tunnel_health_loop,daemon=True).start()
    threading.Thread(target=vanish_checker_loop,daemon=True).start()
    threading.Thread(target=status_auto_refresh_loop,daemon=True).start()
    log("Bot ready! Relay: @capscraft_relay")
    bot.infinity_polling(timeout=60,long_polling_timeout=60,skip_pending=False)

if __name__=='__main__':
    try: main()
    finally:
        _tee_out.close(); _tee_err.close()
