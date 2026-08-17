#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Bot v17.24 — compressed: SSH+cloudflared failover, trusted auto-reg, vanish, radar stats
import sys,os,io,json,base64,socket,threading,time,uuid,hashlib,re,subprocess,shutil,signal,html as H,urllib.request
from urllib.parse import unquote
from http.server import HTTPServer,BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from datetime import datetime,timezone,timedelta
import telebot
from telebot import types

BASE=Path.home()/"telegram-bot"; BASE.mkdir(exist_ok=True)
P=lambda n: BASE/n
CFG=P("config.json")
TECH="FFFFFFFFF12324"
TRUSTED={5183248850:"Gishta1",5602435561:"Rainy42",5370523250:"FFFFFFFFF12324"}
KNOWN={'start','help','past','all','api','api_reload','log','log_clear','status','menu'}
SITE="https://gmd.capscraft.com"; FRIEND_IP="185.26.120.251"
CHAN_ID=-1004388932854; CHAN="capscraft_relay"
MSK=timezone(timedelta(hours=3)); T0=time.time()
VGRACE,VCD,MAXH=30,60,10000

cfg=json.load(open(CFG))
BOT_TOKEN=cfg.get("bot_token","")
if not BOT_TOKEN: sys.exit(107)
PROTECTED=set(cfg.get("protected_users",[])); PASSWORD=cfg.get("password","")
KEY=cfg.get("encryption_key","").encode()
MAXN,MAXPN,PER=12,20,5
PORT=cfg.get("api_port",8080); API_EN=cfg.get("api_enabled",True); PROXY=cfg.get("proxy_url")
CFBIN=P("cloudflared")
if PROXY: telebot.apihelper.proxy={"http":PROXY,"https":PROXY}
bot=telebot.TeleBot(BOT_TOKEN)

# ---------- logger ----------
class Tee:
    def __init__(s,f,o): s.f=open(f,'a',encoding='utf-8',buffering=1); s.o=o; s.l=threading.Lock()
    def write(s,m):
        with s.l:
            try: s.f.write(m); s.f.flush()
            except: pass
            try: s.o.write(m)
            except: pass
    def flush(s):
        try: s.f.flush()
        except: pass
    def close(s):
        try: s.f.close()
        except: pass
    def isatty(s): return False
_out=Tee(P("runtime.log"),sys.__stdout__); _err=Tee(P("runtime.log"),sys.__stderr__)
sys.stdout=_out; sys.stderr=_err
def log(m): print(m,flush=True)

# ---------- json ----------
def rj(p,d):
    try: return json.load(open(p))
    except: return d
def wj(p,d):
    t=p.with_suffix('.tmp')
    json.dump(d,open(t,'w',encoding='utf-8'),indent=2,ensure_ascii=False); os.replace(t,p)
lu=lambda: rj(P("users.json"),{}); su=lambda u: wj(P("users.json"),u)
lp=lambda: rj(P("pastes.json"),[]); sp=lambda p: wj(P("pastes.json"),p)
ls=lambda: rj(P("user_states.json"),{}); ss=lambda s: wj(P("user_states.json"),s)
lt=lambda: rj(P("api_tokens.json"),{}); st=lambda t: wj(P("api_tokens.json"),t)
lpend=lambda: rj(P("pending.json"),{}); spend=lambda p: wj(P("pending.json"),p)
lhb=lambda: rj(P("heartbeats.json"),{}); shb=lambda h: wj(P("heartbeats.json"),h)

# ---------- base ----------
def lip():
    try:
        s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(('8.8.8.8',80)); i=s.getsockname()[0]; s.close(); return i
    except: return "127.0.0.1"
LIP=lip()
def enc(t):
    try:
        b=t.encode(); s=hashlib.sha256(KEY).digest(); return base64.b64encode(bytes(x^s[i%len(s)]^KEY[i%len(KEY)] for i,x in enumerate(b))).decode()
    except: return None
def dec(d):
    try:
        b=base64.b64decode(d); s=hashlib.sha256(KEY).digest(); return bytes(x^s[i%len(s)]^KEY[i%len(KEY)] for i,x in enumerate(b)).decode()
    except: return None
chash=lambda t: hashlib.sha256((str(t)+KEY.decode('utf-8','ignore')).encode()).hexdigest()[:16]
reg=lambda u: str(u) in lu()
dn=lambda u: (lu().get(str(u),{}) or {}).get('name') or str(u)
def ia(u):
    try: uid=int(u)
    except: return False
    if uid in TRUSTED and (TRUSTED[uid]==TECH or TRUSTED[uid] in PROTECTED): return True
    d=lu().get(str(uid))
    if not d: return False
    if d.get('is_admin'): return True
    n=d.get('name'); return n==TECH or (n and n in PROTECTED)
def role(u):
    try: uid=int(u)
    except: return "user"
    if uid in TRUSTED:
        n=TRUSTED[uid]
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
    for uid in TRUSTED:
        if ia(uid) and uid not in a: a.append(uid)
    return a
gs=lambda u: ls().get(str(u),{})
def sets(u,d): s=ls(); s[str(u)]=d; ss(s)
def cs(u): s=ls(); s.pop(str(u),None); ss(s)
tr=lambda t,m: t if len(t)<=m else t[:m-1]+"…"
safe=lambda t: "—" if t is None else H.escape(str(t))
uh=lambda t,e="📋": f"{e} <b>{t}</b>\n<code>{'━'*28}</code>"
ur_=lambda l,v,e="•": f"{e} {l}: <code>{safe(v)}</code>"
ust=lambda o: "🟢 <b>Online</b>" if o else "🔴 <b>Offline</b>"
umode=lambda m: {"service":"🔧 Сервисный","fortress":"🚨 УСИЛЕННАЯ","normal":"🔓 Обычный"}.get(m,"🔓 Обычный")
div=lambda: f"<code>{'─'*20}</code>"
now=lambda: datetime.now(MSK)
def fd(sec):
    sec=int(max(0,sec))
    if sec<60: return f"{sec}с"
    m=sec//60
    if m<60: return f"{m}м"
    h=m//60; m%=60
    if h<24: return f"{h}ч {m}м"
    d=h//24; h%=24; return f"{d}д {h}ч"
gm=lambda g: {"surv":"🗡","creat":"🎨","adv":"🧭","spec":"👁"}.get((g or "")[:4].lower().rstrip('l').rstrip('i').rstrip('v')[:4],"❔") if g else "❔"
def gmicon(g):
    g=(g or "unknown").lower()
    for k,v in (("surv","🗡"),("creat","🎨"),("adv","🧭"),("spec","👁")):
        if g.startswith(k): return v
    return "❔"
def hbc(s):
    try: s=int(s)
    except: s=30
    return {5:"1️⃣ 5с",30:"2️⃣ 30с",300:"3️⃣ 5м",600:"4️⃣ 10м"}.get(s,f"5️⃣ {s}с")

# ---------- trusted auto-reg ----------
def auto_reg(uid):
    try: uid=int(uid)
    except: return False
    if uid not in TRUSTED or reg(uid): return reg(uid)
    us=lu(); us[str(uid)]={'name':TRUSTED[uid],'username':f"p_{uid}",'is_bot':False,'is_admin':ia(uid),'registered_at':now().isoformat(),'trusted':True}; su(us); return True

# ---------- tunnel ----------
tun_proc=None; cf_proc=None; cur_url=None; t_lock=threading.Lock(); t_act=time.time()
ssh_fails=0; ssh_block=0
def tstate_load(): return rj(P("tunnel_state.json"),{})
def tstate_save(s): wj(P("tunnel_state.json"),s)
def post_chan(url,reason="new",tt="ssh"):
    msg=f"🔄 <b>Туннель {('обновлён' if reason=='new' else 'переподключён')}</b> {'☁️' if tt=='cloudflared' else '🔴'}\n🌐 <code>{url}</code>\n⏰ {now().strftime('%H:%M:%S')}\n📡 <code>t.me/s/{CHAN}</code>"
    for _ in range(5):
        try:
            bot.send_message(CHAN_ID,msg,parse_mode='HTML',disable_web_page_preview=True); log(f"[Tunnel] ✓ канал {url}"); return True
        except Exception as e: time.sleep(3)
    return False
def cf_avail(): return shutil.which('cloudflared') or CFBIN.exists()
def cf_bin(): return shutil.which('cloudflared') or str(CFBIN)
def set_url(u,tt):
    global cur_url
    with t_lock:
        ou=cur_url; cur_url=u
    if u!=ou:
        post_chan(u,"new" if not ou else "reconnect",tt)
        try: P("tunnel_url.txt").write_text(u); tstate_save({'last_url':u,'type':tt})
        except: pass
def run_ssh():
    global ssh_fails,ssh_block,t_act,tun_proc
    log("[Tunnel] запуск SSH localhost.run..."); t_act=time.time()
    try:
        p=subprocess.Popen(['ssh','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','-o','TCPKeepAlive=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15','-R',f'80:localhost:{PORT}','nokey@localhost.run'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        with t_lock: tun_proc=p
        for line in iter(p.stdout.readline,''):
            line=line.strip()
            if not line: continue
            t_act=time.time(); m=re.search(r'(https://[a-z0-9-]+\.lhr\.life)',line)
            if m: set_url(m.group(1),'ssh'); ssh_fails=0
        p.wait(); ssh_fails+=1
        if ssh_fails>=3: ssh_block=time.time()+600; log(f"[Tunnel] SSH fail#{ssh_fails} → блок SSH 10м")
        log(f"[Tunnel] SSH упал fail#{ssh_fails}")
    except Exception as e:
        ssh_fails+=1; log(f"[Tunnel] SSH err {e}")
def run_cf():
    global t_act,cf_proc
    log("[Tunnel] запуск cloudflared..."); t_act=time.time()
    try:
        p=subprocess.Popen([cf_bin(),'tunnel','--url',f'http://localhost:{PORT}','--no-autoupdate'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        with t_lock: cf_proc=p
        for line in iter(p.stdout.readline,''):
            line=line.strip()
            if not line: continue
            t_act=time.time(); m=re.search(r'(https://[a-z0-9-]+\.trycloudflare\.com)',line)
            if m: set_url(m.group(1),'cloudflared')
        p.wait(); log("[Tunnel] cloudflared упал")
    except Exception as e: log(f"[Tunnel] cf err {e}")
def start_tunnel():
    global ssh_block
    st=tstate_load()
    if st.get('last_url'):
        with t_lock: global cur_url; cur_url=st['last_url']
    while True:
        if time.time()>=ssh_block and ssh_fails<3: run_ssh()
        elif cf_avail(): run_cf(); ssh_block=time.time()+60
        else: time.sleep(5)
def force_reload(r="manual"):
    global t_act,tun_proc,cf_proc
    log(f"[Tunnel-RELOAD] {r}")
    with t_lock:
        for pr in (tun_proc,cf_proc):
            if pr:
                try: pr.kill()
                except: pass
        tun_proc=cf_proc=None
    t_act=time.time()
def tunnel_watchdog():
    global t_act
    time.sleep(60)
    while True:
        try:
            with t_lock: p=tun_proc or cf_proc
            if p and p.poll() is None and (time.time()-t_act)>60:
                log("[Watchdog] тишина → kill"); force_reload("watchdog")
        except: pass
        time.sleep(15)
def get_url():
    with t_lock: u=cur_url
    if u: return u
    try:
        t=P("tunnel_url.txt").read_text().strip()
        if t.startswith('http'): return t
    except: pass
    return cfg.get('tunnel_url')

# ---------- tracking ----------
pos={}; vanish={}; rfirst={}; vcd={}; flines={}
online_since={}; server_since=None
def load_online():
    global online_since,server_since
    d=rj(P("online_tracking.json"),{}); online_since=d.get('players',{}); server_since=d.get('server')
def save_online(): wj(P("online_tracking.json"),{'players':online_since,'server':server_since})
def gsince(n): return online_since.get(n) or online_since.get(n.lower())
def in_tab(n):
    try:
        d=json.load(open(P("site_status.json")))
        return bool(d.get('online')) and n.lower() in [p.lower() for p in d.get('players_list',[])]
    except: return False
def is_tele(n,x,z,ts):
    if name_not_in(n): return False
    ps=pos[n][-8:]; sp=[]
    for i in range(1,len(ps)):
        dt=ps[i]['timestamp']-ps[i-1]['timestamp']
        if dt>0: sp=sp+[((ps[i]['x']-ps[i-1]['x'])**2+(ps[i]['z']-ps[i-1]['z'])**2)**.5/dt]
    return len(sp)>=2 and sp[-1]>=50
def name_not_in(n): return n not in pos or len(pos[n])<3
def hline(ts,x,y,z,dim,hp,mh,eye,yaw,pitch,stt,it,vn,imp,osec,gm_):
    return f"{datetime.fromtimestamp(ts,MSK).strftime('%H:%M:%S')}|{x:.1f},{y:.1f},{z:.1f}|{dim}|{hp:.1f}|{mh:.1f}|{eye:.2f}|{yaw:.1f}|{pitch:.1f}|{stt}|{'true' if it else 'false'}|{'true' if vn else 'false'}|{'true' if imp else 'false'}|{osec}|{gm_}"
def save_hist(n,line,imp):
    fp=P("players")/f"{n}.txt"
    try: fp.parent.mkdir(exist_ok=True); open(fp,'a').write(line+"\n")
    except: pass
def notify_vanish(n,x,z,dim):
    msg=f"🚨 <b>ВАНИШ!</b>\n👤 <code>{safe(n)}</code>\n📍 <code>[{x:.0f},{z:.0f}]</code> {safe(dim)}\n⏰ {now().strftime('%H:%M:%S')}"
    for a in aia():
        try:
            s=gs(a)
            if s.get('vanish_msg_id'):
                try: bot.edit_message_text(msg,a,s['vanish_msg_id'],parse_mode='HTML'); continue
                except: pass
            m=bot.send_message(a,msg,parse_mode='HTML'); s['vanish_msg_id']=m.message_id; sets(a,s)
        except: pass
def clear_vanish_notif():
    for a in aia():
        s=gs(a)
        if s.get('vanish_msg_id'):
            try: bot.delete_message(a,s['vanish_msg_id'])
            except: pass
            s.pop('vanish_msg_id',None); sets(a,s)
def process_player_data(d):
    if not isinstance(d,dict): return
    nowt=time.time(); cur=set()
    for p in d.get('players',[]):
        if isinstance(p,dict) and isinstance(p.get('name'),str): cur.add(p['name'].strip())
    for n in list(vanish):
        if n not in cur: vanish.pop(n,None); rfirst.pop(n,None)
    for p in d.get('players',[]):
        if not isinstance(p,dict): continue
        n=p.get('name')
        if not isinstance(n,str) or not n.strip(): continue
        n=n.strip()
        if len(n)<2 or len(n)>16 or not re.match(r'^[A-Za-z0-9_]+$',n): continue
        try:
            x,y,z=float(p.get('x',0)),float(p.get('y',0)),float(p.get('z',0))
            hp,mh,eye=float(p.get('health',20)),float(p.get('maxHealth',20)),float(p.get('eyeHeight',1.62))
            yaw,pit,ts=float(p.get('yaw',0)),float(p.get('pitch',0)),float(p.get('timestamp',nowt))
        except: continue
        dim,str(p.get('dimension','unknown'))[:32] if False else str(p.get('dimension','unknown'))[:32]
        gm_=str(p.get('gamemode','unknown'))[:16]
        pos.setdefault(n,[]).append({'x':x,'y':y,'z':z,'timestamp':ts,'dimension':dim,'gamemode':gm_})
        if len(pos[n])>100: pos[n]=pos[n][-100:]
        rfirst.setdefault(n,ts)
        it=in_tab(n)
        if not it and (ts-rfirst.get(n,ts))>VGRACE:
            vanish.setdefault(n,ts)
            if nowt-vcd.get(n,0)>VCD: vcd[n]=nowt; notify_vanish(n,x,z,dim)
        elif it: vanish.pop(n,None); rfirst.pop(n,None)
        vn=n in vanish; tele=is_tele(n,x,z,ts); imp=vn or tele
        s=gsince(n); osec=int(nowt-s) if s else 0
        save_hist(n,hline(ts,x,y,z,dim,hp,mh,eye,yaw,pit,"standing",it,vn,imp,osec,gm_),imp)
def vanish_loop():
    while True:
        try:
            if not vanish: clear_vanish_notif()
        except: pass
        time.sleep(5)

# ---------- site ----------
def parse_site():
    global server_since
    try:
        r=urllib.request.urlopen(urllib.request.Request(SITE,headers={'User-Agent':'Mozilla/5.0'}),timeout=15)
        h=r.read().decode('utf-8')
        on=bool(re.search(r"minecraftserverinfo\s+isonline",h,re.I))
        pl=[]
        for m in re.findall(r"alt='([A-Za-z0-9_]{3,16})s Avatar'",h):
            if m not in pl: pl.append(m)
        nowt=time.time()
        server_since=nowt if on else None
        for n in pl: online_since.setdefault(n,nowt)
        for n in list(online_since):
            if n not in pl: online_since.pop(n,None)
        save_online()
        d={'online':on,'players_online':len(pl),'players_list':pl,'address':'gmd.capscraft.com','server_online_since':server_since}
        wj(P("site_status.json"),d); return d
    except Exception as e: log(f"[Site] {e}"); return None
def site_loop():
    while True:
        s=parse_site()
        if s: log(f"[Site] {'🟢' if s['online'] else '🔴'} ({s['players_online']})")
        time.sleep(60)

# ---------- watcher / health / status ----------
def watcher_loop():
    GR=180
    while True:
        time.sleep(30)
        try:
            if not P("site_status.json").exists() or not json.load(open(P("site_status.json"))).get('online'): continue
        except: continue
        hb=lhb(); us=lu(); nowt=now()
        gk=cfg.get('kiktime_minutes',10)*60
        for uid,u in list(us.items()):
            try:
                if not u.get('is_bot') or u.get('mode')=='service': continue
                lim=(u.get('kiktime_override')*60) if u.get('kiktime_override') else gk
                cid=u.get('computer_id')
                if not cid: continue
                reg_at=u.get('registered_at')
                lsv=hb.get(cid,{}).get('last_seen')
                base=lsv or reg_at
                if not base: continue
                delta=(nowt-datetime.fromisoformat(base)).total_seconds()
                if delta<GR: continue
                if delta>lim:
                    n=u.get('name','?'); at=u.get('api_token')
                    log(f"[Watcher] KICK {n}")
                    if at: rt_(at,"Авто-кик")
                    h2=lhb(); h2.pop(cid,None); shb(h2)
                    us.pop(uid,None); su(us)
            except: pass
        time.sleep(0)
def rt_(tok,r=""):
    ts=lt()
    if tok in ts:
        td=ts.pop(tok); st(ts); us=lu(); pid=td.get('pending_id')
        if pid and pid in us:
            n=us.pop(pid); su(us); na(f"🚫 <b>ОТОЗВАН</b>\n🤖 <code>{safe(n.get('name'))}</code>")
def na(m):
    for a in aia():
        try: bot.send_message(a,m,parse_mode='HTML')
        except: pass
th_={'status':'unknown'}
def health_loop():
    while True:
        try:
            u=get_url()
            if u:
                req=urllib.request.Request(f"{u}/api/url",headers={'bypass-tunnel-reminder':'1'})
                r=urllib.request.urlopen(req,timeout=10); th_['status']='ok' if r.status==200 else 'down'
        except: th_['status']='down'
        time.sleep(60)
def status_loop():
    while True:
        time.sleep(5)
        try:
            with s_lock: chats=list(active_msgs.items())
            if not chats: continue
            txt=build_status(); kb=status_kb()
            if not txt: continue
            for cid,mid in chats:
                try: bot.edit_message_text(txt,cid,mid,parse_mode='HTML',reply_markup=kb)
                except Exception as e:
                    if any(k in str(e) for k in ("MESSAGE_EDIT_TIME_LIMIT","chat not found","Forbidden","can't be edited")):
                        with s_lock: active_msgs.pop(cid,None)
        except: pass
active_msgs={}; s_lock=threading.Lock()
def reg_status(cid,mid):
    with s_lock: active_msgs[cid]=mid
def unreg_status(cid):
    with s_lock: active_msgs.pop(cid,None)

# ---------- keyboards ----------
def IK(*rows):
    kb=types.InlineKeyboardMarkup()
    for r in rows: kb.row(*[types.InlineKeyboardButton(t,callback_data=c) for t,c in r])
    return kb
def menu_kb(uid):
    em="✅" if lu().get(str(uid),{}).get('vanish_tracking') else "❌"
    return IK((("📋 Пасты","menu:past"),("👥 Компьютеры","menu:all")),(("🌐 Сервер","menu:status"),("🖥 API","menu:api")),((f"🕵️ Слежение: {em}","toggle_vanish"),("❓ Помощь","menu:help")))
def back_kb(): return IK((("🔙 Меню","menu:main"),))
def status_kb(): return IK((("🔄 Обновить","refresh:status"),("⏸ Стоп авто","stop_auto")),(("🔙 Меню","menu:main"),))
def confirm_kb(a): return IK((("✅ Да",f"confirm:{a}:yes"),("❌ Нет",f"confirm:{a}:no")))

# ---------- builders ----------
def build_help():
    return f"{uh('Справка v17.24','📖')}\n\n<code>/start</code> пуск\n<code>/menu</code> меню\n<code>/status</code> статус(авто 5с)\n<code>/api</code> API\n<code>/api_reload</code> рестарт туннеля\n<code>/past add|edit|delete</code> пасты\n<code>/all assign|perform|kick|kiktime</code> компы"
def build_status():
    s=parse_site() or rj(P("site_status.json"),None)
    if not s: return None
    pl=s.get('players_list',[]); nowt=time.time()
    txt=f"{uh('Статус сервера','🌐')}\n\n{ust(s.get('online'))}\n📡 <code>{safe(s.get('address'))}</code>\n"
    if s.get('online') and server_since: txt+=f"⏱ сервер: <code>{fd(nowt-server_since)}</code>\n"
    txt+="\n"
    coords={n.lower():p[-1] for n,p in pos.items() if p}
    if pl:
        txt+=f"<b>👤 Онлайн ({len(pl)}):</b>\n"
        for n in pl[:30]:
            c=coords.get(n.lower()); v="🚨" if n in vanish else "🟢"; g=gmicon(c.get('gamemode')) if c else ""
            snc=gsince(n); d=f" ⏱{fd(nowt-snc)}" if snc else ""
            txt+=f"  • {g} <code>{safe(n)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}]{d} {v}\n" if c else f"  • <code>{safe(n)}</code> 📍 нет координат{d} {v}\n"
    else: txt+= "<i>🔇 никого</i>\n" if s.get('online') else "<i>💤 оффлайн</i>\n"
    onl=[p.lower() for p in pl]
    van=[(n,pos[n][-1]) for n in vanish if pos.get(n) and n.lower() not in onl]
    if van:
        txt+=f"\n<b>🚨 ВАНИШ ({len(van)}):</b>\n"
        for n,c in van: txt+=f"  • {gmicon(c.get('gamemode'))} <code>{safe(n)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}] 🚨\n"
    rt_=sum(1 for u in lu().values() if u.get('is_bot') and 'radar' in u.get('assigned_pastes',[]))
    hbl=lhb(); on=0
    for u in lu().values():
        if u.get('is_bot') and 'radar' in u.get('assigned_pastes',[]):
            c=u.get('computer_id')
            if c and c in hbl:
                try:
                    if (now()-datetime.fromisoformat(hbl[c]['last_seen'])).total_seconds()<120: on+=1
                except: pass
    txt+=f"\n<b>📡 Радары (всего:{rt_} 🟢{on} 🔴{rt_-on}):</b>\n"
    rad=[(n,p[-1]) for n,p in pos.items() if p]
    for n,c in rad[:20]:
        txt+=f"  • {gmicon(c.get('gamemode'))} <code>{safe(n)}</code> [{c['x']:.0f},{c['y']:.0f},{c['z']:.0f}] {'🟢' if n.lower() in onl else '🚨'}\n"
    if not rad: txt+="  <i>нет данных</i>\n"
    txt+=f"\n<i>🕐 {now().strftime('%H:%M:%S')} (авто 5с)</i>"
    return txt
def build_api():
    u=get_url() or f"http://{LIP}:{PORT}"
    return f"{uh('API','🖥')}\n⏱ <code>{fd(time.time()-T0)}</code>\n{ur_('URL',u)}\n{ur_('Пароль',PASSWORD)}\n{ur_('Порт',PORT)}\n📡 @{CHAN}\n🌐 {th_.get('status')}"

# ---------- finders ----------
def find_u(a,ul):
    try:
        i=int(a)-1
        if 0<=i<len(ul): return ul[i]
    except: pass
    al=a.lower()
    for t,d in ul:
        if (d.get('name') or '').lower()==al: return t,d
    for t,d in ul:
        if al in (d.get('name') or '').lower(): return t,d
    return None,None
def find_p(a,pl):
    try:
        i=int(a)-1
        if 0<=i<len(pl): return i,pl[i]
    except: pass
    al=a.lower()
    for i,p in enumerate(pl):
        if p['name'].lower()==al: return i,p
    for i,p in enumerate(pl):
        if al in p['name'].lower(): return i,p
    return None,None
def edit_or_send(c,t,kb=None):
    if hasattr(c,'message') and c.message:
        try: bot.edit_message_text(t,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=kb); return
        except: pass
    try: bot.send_message(c.message.chat.id if hasattr(c,'message') else c.chat.id,t,parse_mode='HTML',reply_markup=kb)
    except: pass
def delfile(uid):
    s=gs(uid); mid,cid=s.get('last_file_msg_id'),s.get('last_file_chat_id')
    if mid and cid:
        try: bot.delete_message(cid,mid)
        except: pass
        s.pop('last_file_msg_id',None); s.pop('last_file_chat_id',None); sets(uid,s)
def sendfile(cid,content,name,uid):
    try:
        fo=io.BytesIO(content.encode()); fo.name=f"{name}.txt"
        m=bot.send_document(cid,fo,caption=f"📄 {name}")
        s=gs(uid); s['last_file_msg_id']=m.message_id; s['last_file_chat_id']=cid; sets(uid,s)
    except: pass

# ---------- commands ----------
@bot.message_handler(commands=['api_reload'])
def c_reload(m):
    if not ia(m.from_user.id): return bot.send_message(m.chat.id,"❌")
    threading.Thread(target=lambda: force_reload("tg"),daemon=True).start()
    bot.send_message(m.chat.id,"🔄 Перезагрузка туннеля...",parse_mode='HTML')
@bot.message_handler(commands=['log'])
def c_log(m):
    if not ia(m.from_user.id): return
    try:
        c=open(P("runtime.log"),encoding='utf-8',errors='ignore').read()[-900000:]
        fo=io.BytesIO(c.encode()); fo.name="bot.log"
        bot.send_document(m.chat.id,fo,caption=f"📄 {len(c)} байт")
    except Exception as e: bot.send_message(m.chat.id,f"❌ {safe(e)}")
@bot.message_handler(commands=['log_clear'])
def c_logclear(m):
    if not ia(m.from_user.id): return
    open(P("runtime.log"),'w').write(f"[{now().isoformat()}] cleared\n")
    bot.send_message(m.chat.id,"✅ Лог очищен")
@bot.message_handler(commands=['start'])
def c_start(m):
    u=m.from_user.id; auto_reg(u)
    unreg_status(m.chat.id)
    if not reg(u):
        sets(u,{'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        bot.send_message(m.chat.id,f"{uh('Добро пожаловать','👋')}\n👤 <b>{safe(m.from_user.username or u)}</b>\n🔐 Пароль:")
    else:
        r=role(u); bot.send_message(m.chat.id,f"{uh('С возвращением','🚀')}\n👤 <b>{safe(dn(u))}</b>\n{ur_('Роль',r)}\n\n/menu",reply_markup=menu_kb(u))
@bot.message_handler(commands=['menu'])
def c_menu(m):
    if not reg(m.from_user.id): return
    us=lu(); bc=sum(1 for u in us.values() if u.get('is_bot'))
    bot.send_message(m.chat.id,f"{uh('Меню','📱')}\n🤖 {bc} | 👤 {len(us)-bc} | 📄 {len(lp())}",reply_markup=menu_kb(m.from_user.id))
@bot.message_handler(commands=['help'])
def c_help(m):
    if reg(m.from_user.id): bot.send_message(m.chat.id,build_help(),reply_markup=back_kb())
@bot.message_handler(commands=['api'])
def c_api(m):
    if not ia(m.from_user.id): return
    bot.send_message(m.chat.id,build_api(),reply_markup=IK((("🔄 Рестарт","reload_tunnel"),("🔙 Меню","menu:main"))))
@bot.message_handler(commands=['status'])
def c_status(m):
    if not ia(m.from_user.id): return
    t=build_status()
    if t:
        msg=bot.send_message(m.chat.id,t,parse_mode='HTML',reply_markup=status_kb()); reg_status(m.chat.id,msg.message_id)
@bot.message_handler(commands=['past'])
def c_past(m):
    if not reg(m.from_user.id): return
    a=m.text.split()[1:]
    if not a: return show_pasts(m.chat.id,0)
    s=a[0].lower()
    if s=='add' and len(a)>=2:
        n=tr(a[1],MAXPN).lower()
        if any(p['name'].lower()==n for p in lp()): return bot.send_message(m.chat.id,"⚠️ есть")
        if len(a)>=3:
            c=' '.join(a[2:]); ps=lp(); ps.append({'name':n,'content':enc(c),'hash':chash(c),'cid':m.from_user.id,'cn':dn(m.from_user.id)}); sp(ps)
            return bot.send_message(m.chat.id,f"✅ <code>{safe(n)}</code>")
        sets(m.from_user.id,{'step':'addw','paste_name':n}); return bot.send_message(m.chat.id,f"📄 <code>{safe(n)}</code>: текст/файл или /cancel")
    if s=='edit' and len(a)>=2:
        i,p=find_p(a[1],lp())
        if i is None: return bot.send_message(m.chat.id,"❌")
        sets(m.from_user.id,{'step':'editw','idx':i}); return bot.send_message(m.chat.id,f"✏️ <code>{safe(p['name'])}</code>: текст/файл или /cancel")
    if s=='delete' and len(a)>=2:
        i,p=find_p(a[1],lp())
        if i is None: return bot.send_message(m.chat.id,"❌")
        sets(m.from_user.id,{'step':'dc','idx':i}); bot.send_message(m.chat.id,f"⚠️ Удалить <code>{safe(p['name'])}</code>?",reply_markup=confirm_kb(f"del:{i}"))
def show_pasts(cid,pg,edit=None):
    ps=lp()
    if not ps:
        t=f"{uh('Пасты','📋')}\n<i>📭</i>\n<code>/past add name text</code>"
        return (edit_or_send(edit,t,back_kb()) if edit else bot.send_message(cid,t,reply_markup=back_kb()))
    tp=max(1,(len(ps)+PER-1)//PER); pg=max(0,min(pg,tp-1)); it=ps[pg*PER:pg*PER+PER]
    rows=[[(f"{pg*PER+i+1}. 📄 {safe(tr(p['name'],MAXPN))}",f"pv:{pg*PER+i}") for i,p in enumerate(it)]]
    nav=[]
    if pg>0: nav.append(("◀️",f"pp:{pg-1}"))
    nav.append((f"{pg+1}/{tp}","noop"))
    if pg<tp-1: nav.append(("▶️",f"pp:{pg+1}"))
    rows.append(nav); rows.append([("🔙 Меню","menu:main")])
    t=f"{uh('Пасты','📋')}\nвсего {len(ps)}"
    (edit_or_send(edit,t,IK(*rows)) if edit else bot.send_message(cid,t,reply_markup=IK(*rows)))
@bot.message_handler(commands=['all'])
def c_all(m):
    if not reg(m.from_user.id): return
    us=lu()
    a=m.text.split()[1:]
    if not a: return show_users(m.chat.id,0)
    s=a[0].lower()
    if s=='assign' and len(a)>=3 and ia(m.from_user.id):
        t,d=find_u(a[1],list(us.items()))
        if not t or not d.get('is_bot'): return bot.send_message(m.chat.id,"❌")
        pn=a[2].lower()
        cp=d.get('assigned_pastes',[])
        if pn not in cp: cp.append(pn); us[t]['assigned_pastes']=cp; su(us)
        bot.send_message(m.chat.id,f"✅ привязан <code>{safe(pn)}</code>")
    elif s=='unassign' and len(a)>=2 and ia(m.from_user.id):
        t,d=find_u(a[1],list(us.items()))
        if t: us[t]['assigned_pastes']=[]; su(us); bot.send_message(m.chat.id,"✅ отвязано")
    elif s=='perform' and len(a)>=3 and ia(m.from_user.id):
        t,d=find_u(a[1],list(us.items())); i,p=find_p(a[2],lp())
        if not t or i is None: return bot.send_message(m.chat.id,"❌")
        cp=d.get('assigned_pastes',[])
        if p['name'] not in cp: cp.append(p['name']); us[t]['assigned_pastes']=cp; su(us)
        bot.send_message(m.chat.id,f"✅ запущен <code>{safe(p['name'])}</code>")
    elif s=='kick' and len(a)>=2 and ia(m.from_user.id):
        t,d=find_u(a[1],list(us.items()))
        if t: bot.send_message(m.chat.id,f"⚠️ Кикнуть <code>{safe(d.get('name'))}</code>?",reply_markup=confirm_kb(f"kick:{t}"))
    elif s=='kiktime' and len(a)>=2 and ia(m.from_user.id):
        try: nm=int(a[1])
        except: return bot.send_message(m.chat.id,"❌ число")
        if len(a)>=3:
            t,d=find_u(a[2],list(us.items()))
            if t: us[t]['kiktime_override']=nm; su(us); bot.send_message(m.chat.id,f"✅ {nm}м")
        else:
            cfg['kiktime_minutes']=nm; wj(CFG,cfg); bot.send_message(m.chat.id,f"✅ глобально {nm}м")
def show_users(cid,pg,edit=None):
    us=lu(); it=list(us.items())
    tp=max(1,(len(it)+PER-1)//PER); pg=max(0,min(pg,tp-1)); ip=it[pg*PER:pg*PER+PER]
    rows=[[(f"{pg*PER+i+1}. {{'tech':'🛠','admin':'👑','bot':'🤖'}.get(role(t),'👤')} {safe(tr(d.get('name') or t,MAXN))}",f"av:{t}") for i,(t,d) in enumerate(ip)]]
    rows.append([("🔙 Меню","menu:main")])
    t=f"{uh('Компьютеры','👥')}\n🤖 {sum(1 for d in us.values() if d.get('is_bot'))} | 👤 {sum(1 for d in us.values() if not d.get('is_bot'))}"
    (edit_or_send(edit,t,IK(*rows)) if edit else bot.send_message(cid,t,reply_markup=IK(*rows)))

# ---------- callbacks ----------
@bot.callback_query_handler(func=lambda c: True)
def cb(c):
    try:
        d=c.data
        if d=="stop_auto": unreg_status(c.message.chat.id); bot.answer_callback_query(c.id,"⏸"); return
        if d=="refresh:status":
            t=build_status()
            if t:
                try: bot.edit_message_text(t,c.message.chat.id,c.message.message_id,parse_mode='HTML',reply_markup=status_kb()); reg_status(c.message.chat.id,c.message.message_id)
                except: pass
            bot.answer_callback_query(c.id,"🔄"); return
        if d=="reload_tunnel":
            if ia(c.from_user.id): threading.Thread(target=lambda: force_reload("btn"),daemon=True).start()
            bot.answer_callback_query(c.id,"🔄"); return
        if d=="toggle_vanish":
            if not ia(c.from_user.id): return
            us=lu(); u=us.get(str(c.from_user.id),{})
            u['vanish_tracking']=not u.get('vanish_tracking'); us[str(c.from_user.id)]=u; su(us)
            try: bot.edit_message_reply_markup(c.message.chat.id,c.message.message_id,reply_markup=menu_kb(c.from_user.id))
            except: pass
            bot.answer_callback_query(c.id,"🕵️"); return
        if d.startswith("menu:"):
            s=d.split(":")[1]
            if s=="main":
                us=lu(); edit_or_send(c,f"{uh('Меню','📱')}\n🤖 {sum(1 for x in us.values() if x.get('is_bot'))} | 📄 {len(lp())}",menu_kb(c.from_user.id))
            elif s=="past": show_pasts(c.message.chat.id,0,edit=c)
            elif s=="all": show_users(c.message.chat.id,0,edit=c)
            elif s=="status":
                t=build_status()
                if t: edit_or_send(c,t,status_kb())
            elif s=="api": edit_or_send(c,build_api(),IK((("🔄 Рестарт","reload_tunnel"),("🔙 Меню","menu:main"))))
            elif s=="help": edit_or_send(c,build_help(),back_kb())
            bot.answer_callback_query(c.id); return
        if d.startswith("pp:"): show_pasts(c.message.chat.id,int(d.split(":")[1]),edit=c); bot.answer_callback_query(c.id); return
        if d.startswith("pv:"):
            i=int(d.split(":")[1]); ps=lp()
            if 0<=i<len(ps):
                c_=dec(ps[i]['content'])
                if c_: sendfile(c.message.chat.id,c_,ps[i]['name'],c.from_user.id)
            bot.answer_callback_query(c.id); return
        if d.startswith("av:"):
            t=d.split(":")[1]; us=lu(); u=us.get(t,{})
            if u.get('is_bot'):
                hb=lhb(); ci=u.get('computer_id'); ht="❓"
                if ci and ci in hb:
                    try:
                        lm=int((now()-datetime.fromisoformat(hb[ci]['last_seen'])).total_seconds()/60)
                        ht="🟢" if lm<2 else f"🔴{lm}м"
                    except: pass
                txt=f"{uh(u.get('name',''),'🤖')}\n{ur_('CID',ci)}\n{ur_('Режим',umode(u.get('mode','normal')))}\n{ur_('Пульс',ht)}\n{ur_('Интервал',hbc(u.get('heartbeat_interval',30)))}\n{ur_('Лимит',u.get('kiktime_override') or 'глоб.')}\n📋 {', '.join(u.get('assigned_pastes',[])) or 'нет'}"
                kb=IK((("🔧 Режим",f"mode:{t}"),("💓 Интервал",f"hb:{t}")),(("🚫 Кик",f"kick:{t}"),("🔙","menu:all")))
                edit_or_send(c,txt,kb)
            else:
                edit_or_send(c,f"{uh(u.get('name') or t,'👤')}\n{ur_('Роль',role(t))}",IK((("🔙","menu:all"),)))
            bot.answer_callback_query(c.id); return
        if d.startswith("mode:"):
            t=d.split(":")[1]
            if ia(c.from_user.id):
                us=lu(); us[t]['mode']='service' if us[t].get('mode')!='service' else 'normal'; su(us)
            bot.answer_callback_query(c.id,"🔧"); return
        if d.startswith("hb:"):
            t=d.split(":")[1]
            if ia(c.from_user.id): sets(c.from_user.id,{'step':'hbw','target':t}); bot.answer_callback_query(c.id,"⏱ сек?")
            return
        if d.startswith("kick:"):
            t=d.split(":")[1]
            if ia(c.from_user.id): bot.edit_message_text(f"⚠️ Кикнуть?",c.message.chat.id,c.message.message_id,reply_markup=confirm_kb(f"kick2:{t}"))
            bot.answer_callback_query(c.id); return
        if d.startswith("confirm:"):
            p=d.split(":"); a=p[-1]; aid=":".join(p[1:-1])
            if a=="yes":
                if aid.startswith("del:"):
                    i=int(aid.split(":")[1]); ps=lp()
                    if 0<=i<len(ps): ps.pop(i); sp(ps)
                    bot.answer_callback_query(c.id,"✅")
                elif aid.startswith("kick2:") or aid.startswith("kick:"):
                    t=aid.split(":")[-1]; us=lu()
                    if t in us:
                        if us[t].get('api_token'): rt_(us[t]['api_token'],"кик")
                        us.pop(t); su(us)
                    bot.answer_callback_query(c.id,"🚫")
            else: bot.answer_callback_query(c.id,"❌")
            return
        bot.answer_callback_query(c.id)
    except Exception as e:
        log(f"[CB] {e}")
        try: bot.answer_callback_query(c.id)
        except: pass

# ---------- document ----------
@bot.message_handler(content_types=['document'])
def c_doc(m):
    s=gs(m.from_user.id)
    if not s or s.get('step') not in ('addw','editw'): return
    try:
        content=bot.download_file(bot.get_file(m.document.file_id).file_path).decode('utf-8','ignore')
    except: return
    if s['step']=='addw':
        n=s.get('paste_name'); ps=lp(); ps.append({'name':n,'content':enc(content),'hash':chash(content),'cid':m.from_user.id,'cn':dn(m.from_user.id)}); sp(ps)
        cs(m.from_user.id); bot.send_message(m.chat.id,f"✅ <code>{safe(n)}</code>")
    else:
        i=s.get('idx'); ps=lp()
        if 0<=i<len(ps): ps[i]['content']=enc(content); ps[i]['hash']=chash(content); sp(ps)
        cs(m.from_user.id); bot.send_message(m.chat.id,"✅ обновлён")

# ---------- text ----------
@bot.message_handler(func=lambda m: True, content_types=['text'])
def c_text(m):
    u=m.from_user.id; t=m.text.strip(); s=gs(u); auto_reg(u)
    if s:
        stp=s.get('step')
        if stp=='wp':
            if t==PASSWORD:
                us=lu(); us[str(u)]={'name':None,'username':s.get('username'),'is_bot':s.get('is_bot'),'is_admin':False,'registered_at':now().isoformat()}; su(us); cs(u)
                bot.send_message(m.chat.id,"✅ доступ")
            else: bot.send_message(m.chat.id,"❌ пароль")
            return
        if stp=='addw':
            if t.lower()=='/cancel': cs(u); return
            n=s.get('paste_name'); ps=lp(); ps.append({'name':n,'content':enc(t),'hash':chash(t),'cid':u,'cn':dn(u)}); sp(ps); cs(u)
            bot.send_message(m.chat.id,f"✅ <code>{safe(n)}</code>"); return
        if stp=='editw':
            if t.lower()=='/cancel': cs(u); return
            i=s.get('idx'); ps=lp()
            if 0<=i<len(ps): ps[i]['content']=enc(t); ps[i]['hash']=chash(t); sp(ps)
            cs(u); bot.send_message(m.chat.id,"✅"); return
        if stp=='dc':
            i=s.get('idx')
            if t.lower() in ('да','yes','y'):
                ps=lp()
                if 0<=i<len(ps): ps.pop(i); sp(ps)
                cs(u); bot.send_message(m.chat.id,"✅")
            else: cs(u); bot.send_message(m.chat.id,"❌")
            return
        if stp=='hbw':
            try: v=int(t)
            except: return
            tgt=s.get('target'); us=lu()
            if tgt in us: us[tgt]['heartbeat_interval']=max(5,min(3600,v)); su(us)
            cs(u); bot.send_message(m.chat.id,f"✅ {hbc(v)}"); return
        return
    if t.startswith('/') and t.split()[0][1:].lower().split('@')[0] not in KNOWN:
        return bot.send_message(m.chat.id,"❓ /help")
    if not reg(u):
        sets(u,{'step':'wp','username':m.from_user.username or str(u),'is_bot':m.from_user.is_bot})
        return bot.send_message(m.chat.id,"🔐 Пароль:")
    bot.send_message(m.chat.id,"💡 /menu",reply_markup=menu_kb(u))

# ---------- HTTP ----------
class TS(ThreadingMixIn,HTTPServer): daemon_threads=True; allow_reuse_address=True
class AH(BaseHTTPRequestHandler):
    def log_message(s,f,*a):
        global t_act
        t_act=time.time()
        try: print("[API]",s.client_address[0],f%a,flush=True)
        except: pass
    def _j(s,c,d):
        try:
            b=json.dumps(d,ensure_ascii=False).encode()
            s.send_response(c); s.send_header('Content-Type','application/json'); s.send_header('Access-Control-Allow-Origin','*')
            s.send_header('Access-Control-Allow-Headers','Authorization,Content-Type,bypass-tunnel-reminder,X-Computer-ID,X-Server-Key')
            s.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); s.send_header('Content-Length',str(len(b))); s.end_headers()
            s.wfile.write(b)
        except: pass
    def _b(s):
        l=int(s.headers.get('Content-Length',0))
        return s.rfile.read(l).decode() if l else ""
    def _friend(s):
        return s.headers.get('X-Server-Key')==PASSWORD and s.client_address[0]==FRIEND_IP
    def _a(s):
        au=s.headers.get('Authorization',''); ci=s.headers.get('X-Computer-ID','')
        if not au.startswith('Bearer '): return None,False
        tok=au[7:].strip(); ts=lt()
        if tok not in ts: return None,False
        ti=ts[tok]; return tok,ti.get('is_computer',False)
    def do_OPTIONS(s):
        s.send_response(200); s.send_header('Access-Control-Allow-Origin','*')
        s.send_header('Access-Control-Allow-Headers','Authorization,Content-Type,bypass-tunnel-reminder,X-Computer-ID,X-Server-Key')
        s.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); s.end_headers()
    def do_GET(s):
        try: s._get()
        except: pass
    def _get(s):
        if not API_EN: return s._j(503,{"error":"off"})
        tok,ib=s._a(); p=s.path.split('?')[0]
        if p=='/api/health': return s._j(200,{"status":th_.get('status'),"version":"17.24","uptime":fd(time.time()-T0),"url":get_url()})
        if p=='/api/reload':
            threading.Thread(target=lambda: force_reload("api"),daemon=True).start(); return s._j(200,{"ok":True})
        if p=='/api/url':
            u=get_url(); return s._j(200,{"url":u}) if u else s._j(503,{"error":"no"})
        if p=='/api/relay_url':
            u=get_url(); return s._j(200,{"url":u,"channel":f"https://t.me/s/{CHAN}"}) if u else s._j(503,{"error":"no"})
        if p=='/api/check':
            q=dict(x.split('=') for x in s.path.split('?')[1].split('&') if '=' in x) if '?' in s.path else {}
            pe=lpend(); pid=q.get('id','')
            if pid not in pe: return s._j(404,{"error":"no"})
            r={"status":pe[pid].get('status'),"pending_id":pid}
            if r['status']=='approved': r['token']=pe[pid].get('token')
            return s._j(200,r)
        if p=='/api/players/list' and s._friend(): return s._j(200,{"players":[f.stem for f in P("players").glob('*.txt')]})
        if p.startswith('/api/player/') and s._friend():
            n=p.split('/')[-1]; fp=P("players")/f"{n}.txt"
            return s._j(200,{"name":n,"history":fp.read_text()}) if fp.exists() else s._j(404,{"error":"no"})
        if p=='/api/locations/list' and s._friend(): return s._j(200,{"locations":rj(P("locations.json"),{})})
        if not tok: return s._j(401,{"error":"auth"})
        if p=='/api/me':
            ts=lt(); ti=ts[tok]; us=lu(); pid=ti.get('pending_id')
            um,up,hbi='normal',[],30
            if pid and pid in us: um=us[pid].get('mode','normal'); up=us[pid].get('assigned_pastes',[]); hbi=us[pid].get('heartbeat_interval',30)
            return s._j(200,{"ok":True,"computer_id":ti.get('computer_id'),"mode":um,"assigned_pastes":up,"heartbeat_interval":hbi})
        if p.startswith('/api/paste/'):
            n=unquote(p[len('/api/paste/'):]).lower()
            if ib:
                ts=lt(); pid=ts[tok].get('pending_id'); us=lu()
                al=[x.lower() for x in us.get(pid,{}).get('assigned_pastes',[])]
                if n not in al: return s._j(403,{"error":"PANIC"})
            for x in lp():
                if x['name'].lower()==n: return s._j(200,{"name":x['name'],"content":dec(x['content']),"hash":x.get('hash')})
            return s._j(404,{"error":"no"})
        if p=='/api/pastes' and not ib: return s._j(200,{"pastes":[{"name":x['name'],"hash":x.get('hash')} for x in lp()]})
        s._j(404,{"error":"no"})
    def do_POST(s):
        try: s._post()
        except: pass
    def _post(s):
        if not API_EN: return s._j(503,{"error":"off"})
        tok,ib=s._a(); p=s.path.split('?')[0]; b=s._b(); ci=s.headers.get('X-Computer-ID','')
        if p=='/api/player_data':
            try:
                d=json.loads(b) if b else {}; process_player_data(d); return s._j(200,{"ok":True})
            except Exception as e: return s._j(500,{"error":str(e)})
        if p=='/api/reload':
            threading.Thread(target=lambda: force_reload("api"),daemon=True).start(); return s._j(200,{"ok":True})
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
            ts[ft]={'name':d.get('name'),'computer_id':lci,'is_computer':True,'pending_id':pid,'created_at':now().isoformat()}; st(ts)
            us[pid]={'name':d.get('name'),'computer_id':lci,'is_bot':True,'is_admin':False,'mode':'normal','assigned_pastes':[],'api_token':ft,'heartbeat_interval':30,'registered_at':now().isoformat()}; su(us)
            pe[pid]['status']='approved'; spend(pe)
            return s._j(200,{"ok":True,"status":"approved","token":ft})
        if p=='/api/heartbeat':
            if not ib: return s._j(403,{"error":"no"})
            ts=lt(); cv=ts[tok].get('computer_id')
            if not cv: return s._j(400,{"error":"cid"})
            try: d=json.loads(b) if b else {}
            except: d={}
            hb=lhb(); hb[cv]={'last_seen':now().isoformat(),'name':ts[tok].get('name'),'mode':d.get('mode'),'scripts_running':d.get('scripts_running',[])}; shb(hb)
            return s._j(200,{"ok":True})
        if p.startswith('/api/paste/') and not ib:
            n=unquote(p[len('/api/paste/'):]).lower()
            try: d=json.loads(b) if b else {}; c=d.get('content',b)
            except: c=b
            if not c: return s._j(400,{"error":"empty"})
            ps=lp(); f=None
            for i,x in enumerate(ps):
                if x['name'].lower()==n: f=i; break
            if f is not None: ps[f]['content']=enc(c); ps[f]['hash']=chash(c)
            else: ps.append({'name':n,'content':enc(c),'hash':chash(c),'cid':0,'cn':'API'})
            sp(ps); return s._j(200,{"ok":True})
        s._j(404,{"error":"no"})

def start_api():
    while True:
        try:
            srv=TS(('0.0.0.0',PORT),AH); log(f"[API] Ready v17.24 on {PORT}"); srv.serve_forever()
        except OSError as e:
            if e.errno==98: os.system(f"fuser -k {PORT}/tcp 2>/dev/null"); time.sleep(2)
            else: time.sleep(5)
        except Exception as e: time.sleep(5)

def main():
    log("Starting bot v17.24 (compressed)...")
    load_online()
    threading.Thread(target=start_tunnel,daemon=True).start()
    threading.Thread(target=tunnel_watchdog,daemon=True).start()
    time.sleep(2)
    threading.Thread(target=start_api,daemon=True).start()
    threading.Thread(target=site_loop,daemon=True).start()
    threading.Thread(target=watcher_loop,daemon=True).start()
    threading.Thread(target=health_loop,daemon=True).start()
    threading.Thread(target=vanish_loop,daemon=True).start()
    threading.Thread(target=status_loop,daemon=True).start()
    threading.Thread(target=lambda:(time.sleep(5),update_menus()),daemon=True).start()
    log("Bot ready!")
    bot.infinity_polling(timeout=60,long_polling_timeout=60,skip_pending=False)
def update_menus():
    try: bot.set_my_commands([types.BotCommand(c,d) for c,d in [("start","🚀"),("menu","📱"),("help","❓"),("status","🌐"),("api","🖥"),("api_reload","🔄"),("past","📋"),("all","👥")]])
    except: pass
    for uid in aia():
        try: bot.set_my_commands([types.BotCommand(c,d) for c,d in [("start","🚀"),("menu","📱"),("help","❓"),("status","🌐"),("api","🖥"),("api_reload","🔄"),("past","📋"),("all","👥"),("log","📄"),("log_clear","🗑")]],scope=types.BotCommandScopeChat(uid))
        except: pass

if __name__=='__main__':
    try: main()
    finally:
        _out.close(); _err.close()
