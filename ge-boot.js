/*
 * ge-boot.js -- GoldenEye 007 PC port (WebAssembly) loader for Khan Academy.
 *
 * The KA page opens an about:blank window and loads this file from jsDelivr.
 * It then:
 *   1. asks the player for THEIR OWN GoldenEye ROM (.z64/.v64/.n64). The ROM
 *      never leaves their computer and is never uploaded anywhere.
 *   2. the first time only: converts it into the PC port's data files with
 *      the port's own converter scripts, run by Pyodide (Python in wasm).
 *   3. keeps the ROM + converted files in this browser (IndexedDB), so next
 *      time it starts straight away.
 *   4. loads the engine (ge007.js + ge007.wasm) and starts the game. In-game
 *      saves and settings are kept in IndexedDB too.
 *
 * Optional settings (set before this script loads):
 *   window.GE_BASE  = folder URL holding this file, ge007.js, ge007.wasm,
 *                     ge-convert.json (default: this script's own folder)
 *   window.GE_TITLE = title shown on the start screen
 */
(function () {
  "use strict";

  var BASE = window.GE_BASE ||
    (document.currentScript ? document.currentScript.src.replace(/[^\/]*$/, "") : "./");
  if (!/\/$/.test(BASE)) BASE += "/";
  var TITLE = window.GE_TITLE || "GoldenEye 007";
  var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
  var US_SHA1 = "abe01e4aeb033b6c0836819f549c791b26cfde83";
  var DATA_KEY = "pcdata-v1";            // bump if the converter output changes
  var SAVE_FILES = ["ge007.eep", "ge007.ini"];

  // ------------------------------------------------------------------ page
  document.title = TITLE;
  var css = [
    "html,body{margin:0;height:100%;background:#000;color:#ddd;font-family:system-ui,sans-serif;overflow:hidden}",
    "#ge-wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}",
    /* SDL reads the canvas's CSS size when the game window is created, so it
       needs a real box (not just max-width/aspect-ratio). */
    "#canvas{display:block;width:min(100vw,133.333vh);height:min(75vw,100vh);background:#000;outline:none}",
    "#ge-menu{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;",
    "  background:radial-gradient(circle at 50% 35%,#1f2722,#070909 70%);text-align:center}",
    "#ge-menu h1{margin:0 0 .3em;font-size:min(9vw,64px);letter-spacing:.08em;color:#e8c15a;text-shadow:0 6px 20px #000}",
    "#ge-menu .box{max-width:560px;padding:0 20px}",
    "#ge-status{min-height:1.4em;margin:.8em 0;color:#9fb0a6;font-size:15px}",
    "#ge-play{font-size:22px;padding:.45em 1.8em;border:0;border-radius:10px;font-weight:700;background:#e8c15a;color:#111;cursor:pointer}",
    "#ge-play:disabled{background:#555;color:#999;cursor:default}",
    "#ge-pick{display:inline-block;margin:.6em 0;padding:.5em 1em;border:1px dashed #e8c15a;border-radius:8px;cursor:pointer;color:#e8c15a;font-size:15px}",
    "#ge-pick input{display:none}",
    "#ge-anyway{display:none;margin-left:.5em;background:#933;color:#fff;border:0;border-radius:6px;padding:.3em .8em;cursor:pointer}",
    "#ge-menu .small{font-size:12px;color:#7d8a83;margin-top:1.2em;line-height:1.6}",
    "#ge-menu kbd{background:#222;border:1px solid #444;border-radius:4px;padding:0 4px;font-size:11px}",
    "#ge-err{display:none;position:absolute;left:0;right:0;bottom:0;max-height:40%;overflow:auto;margin:0;padding:10px;",
    "  background:rgba(60,0,0,.92);color:#fcc;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap}"
  ].join("\n");
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  document.body.innerHTML =
    '<div id="ge-wrap"><canvas id="canvas" tabindex="0"></canvas></div>' +
    '<div id="ge-menu"><div class="box">' +
    '<h1></h1>' +
    '<label id="ge-pick">Choose your GoldenEye ROM (.z64)<input type="file" id="ge-rom" accept=".z64,.v64,.n64,.rom,.bin"></label>' +
    '<button id="ge-anyway">Try it anyway</button>' +
    '<div id="ge-status">Loading…</div>' +
    '<button id="ge-play" disabled>&#9654; Play</button>' +
    '<div class="small">Your ROM stays on this computer &mdash; it is never uploaded. ' +
    'You only pick it once; it is remembered in this browser.<br>' +
    '<kbd>Enter</kbd> start/select &nbsp; <kbd>Esc</kbd> back &nbsp; <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp; ' +
    'mouse aim &nbsp; left click fire &nbsp; click the game to lock the mouse</div>' +
    '</div></div>' +
    '<pre id="ge-err"></pre>';
  document.querySelector("#ge-menu h1").textContent = TITLE;

  function $(id) { return document.getElementById(id); }
  function setStatus(t) { $("ge-status").textContent = t; }
  function showError(t) {
    var e = $("ge-err");
    e.style.display = "block";
    e.textContent += t + "\n";
    console.error(t);
  }
  window.addEventListener("error", function (e) { showError("Error: " + (e.error && e.error.stack || e.message)); });
  window.addEventListener("unhandledrejection", function (e) { showError("Error: " + (e.reason && e.reason.stack || e.reason)); });
  function nextFrame() { return new Promise(function (r) { setTimeout(r, 30); }); }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("could not load " + src)); };
      document.body.appendChild(s);
    });
  }

  // Khan Academy's security policy blocks fetch() to other sites but allows
  // <script src> from cdn.jsdelivr.net, so every binary file arrives inside a
  // .js file as zlib + Base64 (see make_ka_files.py) and is unpacked here.
  function b64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function inflate(bytes) {
    var ds = new DecompressionStream("deflate");
    var w = ds.writable.getWriter();
    w.write(bytes); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  async function unpackGlobal(name) {
    var bytes = await inflate(b64ToBytes(window[name]));
    window[name] = null;
    return bytes;
  }

  // ------------------------------------------------------------- IndexedDB
  // Optional: if the browser blocks storage here, everything still works,
  // the player just has to pick the ROM every time.
  var dbp = new Promise(function (resolve) {
    try {
      var r = indexedDB.open("ge007-web", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { resolve(null); };
    } catch (e) { resolve(null); }
  });
  function idbGet(key) {
    return dbp.then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var q = db.transaction("kv").objectStore("kv").get(key);
          q.onsuccess = function () { resolve(q.result || null); };
          q.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }
  function idbPut(key, value) {
    return dbp.then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction("kv", "readwrite");
          tx.objectStore("kv").put(value, key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  // ---------------------------------------------------------------- engine
  // Start downloading/compiling the engine right away; it waits for Play.
  var engineReady = new Promise(function (resolve, reject) {
    loadScript(BASE + "ge007-wasm.js").then(function () {
      return unpackGlobal("GE_WASM_Z");
    }).then(function (wasm) {
      window.Module = {
        canvas: $("canvas"),
        wasmBinary: wasm,                      // no fetch() needed
        locateFile: function (p) { return BASE + p; },
        print: function (t) { console.log(t); },
        printErr: function (t) { console.warn(t); },
        onRuntimeInitialized: function () { resolve(window.Module); },
        onAbort: function (w) { reject(new Error("engine aborted: " + w)); }
      };
      return loadScript(BASE + "ge007.js");
    }).catch(reject);
  });
  engineReady.catch(function (e) { showError(String(e && e.stack || e)); setStatus("The game engine failed to load."); });

  // ------------------------------------------------------------------- ROM
  function toZ64(u8) {
    var a = u8[0], b = u8[1], c = u8[2], d = u8[3], i, t;
    if (a === 0x80 && b === 0x37) return u8;                       // .z64 (big-endian)
    var out = new Uint8Array(u8.length);
    if (a === 0x37 && b === 0x80) {                                // .v64 (16-bit swapped)
      for (i = 0; i + 1 < u8.length; i += 2) { out[i] = u8[i + 1]; out[i + 1] = u8[i]; }
      return out;
    }
    if (a === 0x40 && b === 0x12 && c === 0x37 && d === 0x80) {    // .n64 (little-endian)
      for (i = 0; i + 3 < u8.length; i += 4) {
        out[i] = u8[i + 3]; out[i + 1] = u8[i + 2]; out[i + 2] = u8[i + 1]; out[i + 3] = u8[i];
      }
      return out;
    }
    return null;
  }
  async function sha1hex(u8) {
    if (!(window.crypto && crypto.subtle)) return null;
    var h = new Uint8Array(await crypto.subtle.digest("SHA-1", u8));
    return Array.prototype.map.call(h, function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
  }

  // ------------------------------------------------------------- converter
  // Runs the PC port's own ROM -> PC-data scripts (tools_pc/d43/d69/d88_emit.py,
  // the same steps as its prepare-assets tool) inside Pyodide.
  async function convert(rom) {
    setStatus("Downloading the converter (first time only)…");
    await Promise.all([loadScript(BASE + "pyodide-wasm.js"), loadScript(BASE + "pyodide-stdlib.js"),
                       loadScript(BASE + "ge-convert.js")]);
    var pyWasm = await unpackGlobal("GE_PY_WASM_Z");
    var pyStdlib = await unpackGlobal("GE_PY_STDLIB_Z");
    var pyLock = JSON.stringify(window.GE_PY_LOCK);
    window.GE_PY_LOCK = null;
    // Pyodide fetch()es these three files; answer from memory instead.
    var realFetch = window.fetch;
    window.fetch = function (input, init) {
      var u = String(input && input.url || input);
      if (/pyodide\.asm\.wasm$/.test(u))
        return Promise.resolve(new Response(pyWasm, { headers: { "Content-Type": "application/wasm" } }));
      if (/python_stdlib\.zip$/.test(u))
        return Promise.resolve(new Response(pyStdlib, { headers: { "Content-Type": "application/zip" } }));
      if (/pyodide-lock\.json$/.test(u))
        return Promise.resolve(new Response(pyLock, { headers: { "Content-Type": "application/json" } }));
      return realFetch.apply(this, arguments);
    };
    setStatus("Starting the converter (first time only)…");
    var py;
    try {
      if (!window.loadPyodide) await loadScript(PYODIDE_URL + "pyodide.js");
      py = await window.loadPyodide({ indexURL: PYODIDE_URL });
    } finally {
      window.fetch = realFetch;
    }
    setStatus("Converting your ROM (first time only)…");
    var files = window.GE_CONVERT;
    window.GE_CONVERT = null;
    var FS = py.FS;
    function mkdirs(p) {
      var cur = "", parts = p.split("/").filter(Boolean);
      for (var i = 0; i < parts.length; i++) { cur += "/" + parts[i]; try { FS.mkdir(cur); } catch (e) {} }
    }
    Object.keys(files).forEach(function (p) {
      var full = "/ge/" + p;
      mkdirs(full.substring(0, full.lastIndexOf("/")));
      FS.writeFile(full, files[p]);
    });
    mkdirs("/ge/work/data");
    FS.writeFile("/ge/work/data/ge007.ntsc-final.z64", rom);
    await nextFrame();
    py.runPython([
      "import os, sys, runpy",
      "def run(script, *args):",
      "    old = sys.argv",
      "    sys.argv = ['/ge/tools/' + script, *args]",
      "    sys.path.insert(0, '/ge/tools')",
      "    os.chdir('/ge/work')",
      "    try:",
      "        runpy.run_path('/ge/tools/' + script, run_name='__main__')",
      "    except SystemExit as e:",
      "        if e.code not in (0, None):",
      "            raise RuntimeError(script + ' exited ' + str(e.code))",
      "    finally:",
      "        sys.argv = old",
      "        sys.path.pop(0)",
      "run('d43_emit.py', 'ntsc-final')",
      "run('d69_emit.py', 'ntsc-final')",
      "run('d88_emit.py', 'ntsc-final', '--regen')"
    ].join("\n"));
    var out = {};
    ["pcmodels-ntsc-final/pcmodels.bin", "pcmodels-ntsc-final/manifest.csv",
     "pccg-ntsc-final/pccg.bin", "pccg-ntsc-final/manifest.csv"].forEach(function (f) {
      out[f] = FS.readFile("/ge/work/data/" + f);
    });
    return out;
  }

  // ------------------------------------------------------------------ flow
  var data = null;   // { rom: Uint8Array, files: { "pcmodels-.../x": Uint8Array, ... } }
  var pendingRom = null;

  function ready() {
    $("ge-play").disabled = false;
    $("ge-pick").firstChild.textContent = "Use a different ROM";
    setStatus("Ready!");
  }

  async function useRom(rom) {
    $("ge-anyway").style.display = "none";
    $("ge-play").disabled = true;
    try {
      var files = await convert(rom);
      data = { rom: rom, files: files };
      setStatus("Saving in this browser…");
      await idbPut(DATA_KEY, data);
      ready();
    } catch (e) {
      showError(String(e && e.stack || e));
      setStatus("Converting failed. Make sure it's the US (NTSC) GoldenEye ROM.");
    }
  }

  $("ge-rom").addEventListener("change", async function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (/\.(zip|7z|rar)$/i.test(f.name)) { setStatus("Unzip the ROM first, then pick the .z64 file."); return; }
    setStatus("Reading " + f.name + "…");
    var rom = toZ64(new Uint8Array(await f.arrayBuffer()));
    if (!rom) { setStatus("That file doesn't look like an N64 ROM."); return; }
    var sum = await sha1hex(rom);
    if (sum && sum !== US_SHA1) {
      pendingRom = rom;
      setStatus("This isn't the standard US GoldenEye ROM. Edited ROMs only work if they keep the same file layout.");
      $("ge-anyway").style.display = "inline-block";
      return;
    }
    useRom(rom);
  });
  $("ge-anyway").addEventListener("click", function () { if (pendingRom) useRom(pendingRom); });

  function mkdirsEngine(FS, p) {
    var cur = "", parts = p.split("/").filter(Boolean);
    for (var i = 0; i < parts.length; i++) { cur += "/" + parts[i]; try { FS.mkdir(cur); } catch (e) {} }
  }

  // Copy saves out of the game's file system into IndexedDB when they change.
  function watchSaves(FS) {
    var last = {};
    async function check() {
      for (var i = 0; i < SAVE_FILES.length; i++) {
        var name = SAVE_FILES[i], path = "/data/" + name, st;
        try { st = FS.stat(path); } catch (e) { continue; }
        var stamp = st.mtime + ":" + st.size;
        if (last[name] === stamp) continue;
        last[name] = stamp;
        await idbPut("save:" + name, FS.readFile(path));
      }
    }
    setInterval(check, 3000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pagehide", check);
  }

  $("ge-play").addEventListener("click", async function () {
    $("ge-play").disabled = true;
    setStatus("Starting the engine…");
    var M;
    try { M = await engineReady; } catch (e) { return; }
    var FS = M.FS;
    mkdirsEngine(FS, "/data");
    FS.writeFile("/data/ge007.ntsc-final.z64", data.rom);
    Object.keys(data.files).forEach(function (f) {
      mkdirsEngine(FS, "/data/" + f.substring(0, f.lastIndexOf("/")));
      FS.writeFile("/data/" + f, data.files[f]);
    });
    for (var i = 0; i < SAVE_FILES.length; i++) {
      var s = await idbGet("save:" + SAVE_FILES[i]);
      if (s) FS.writeFile("/data/" + SAVE_FILES[i], s);
    }
    data = null;                     // the engine has its own copy now
    FS.chdir("/");
    $("ge-menu").style.display = "none";
    $("canvas").focus();
    watchSaves(FS);
    try {
      var rc = await M.ccall("ge_web_start", "number", [], [], { async: true });
      if (rc) showError("The game stopped (code " + rc + "). Press F12 > Console for details.");
    } catch (e) {
      showError("The game crashed:\n" + (e && e.stack || e));
    }
  });

  $("canvas").addEventListener("click", function () {
    if (document.pointerLockElement !== this && this.requestPointerLock) {
      try { this.requestPointerLock(); } catch (e) {}
    }
  });
  $("canvas").addEventListener("contextmenu", function (e) { e.preventDefault(); });

  // Previously converted in this browser? Then skip straight to Play.
  idbGet(DATA_KEY).then(async function (saved) {
    if (saved && saved.rom && saved.files) { data = saved; ready(); return; }
    // Local testing only: window.GE_ROM_URL = a ROM on your own computer's
    // test server (never point this at a public copy of the ROM).
    if (window.GE_ROM_URL) {
      setStatus("Reading the local test ROM…");
      var rom = toZ64(new Uint8Array(await (await fetch(window.GE_ROM_URL)).arrayBuffer()));
      if (rom) { useRom(rom); return; }
    }
    setStatus("Pick your ROM to begin.");
  });
})();
