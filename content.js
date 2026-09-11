/**
 * Orange Five — best-effort global WebGL colour remapper
 *
 * Intent: remap TV purple/mauve → orange, pink → purple, and optionally
 * cyan → blue on live pool video. Whole-frame; tunable via popup / storage.
 *
 * Known limits: spill onto similar hues in the scene; not ball-aware.
 * Next direction (separate effort): ball detection → mask-only remap.
 */
(function() {
  'use strict';

  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('matchroom')) {
    return;
  }

  // Single source of truth (shared.js — loaded before content.js, see
  // manifest.json): config defaults, detection thresholds, shader source.
  const SH = window.__orangeFiveShared;
  const DEFAULTS = SH.DEFAULTS;

  const config = Object.assign({}, DEFAULTS);

  // Detection thresholds as fixed constants (former "Selectivity" slider
  // defaults — see shared.js DETECT).
  const MAUVE_RATIO = SH.DETECT.MAUVE_RATIO;
  const PINK_SAT_MIN = SH.DETECT.PINK_SAT_MIN;
  const PINK_MIN_BLUE_RATIO = SH.DETECT.PINK_MIN_BLUE_RATIO;
  const PINK_BLUE_BIAS = SH.DETECT.PINK_BLUE_BIAS;
  const CYAN_SAT_MIN = SH.DETECT.CYAN_SAT_MIN;

  // Shader source lives in shared.js (single source of truth — also
  // used by harness/ext-test.html directly and harness/preview.js CPU replica).
  const VERT = SH.VERT;
  const FRAG = SH.FRAG;

  function createProgram(gl, vsSrc, fsSrc) {
    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  function findVideosInShadow(root) {
    const videos = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'VIDEO') videos.push(el);
      if (el.shadowRoot) videos.push(...findVideosInShadow(el.shadowRoot));
    }
    return videos;
  }

  function allVideos() {
    const list = [];
    document.querySelectorAll('mux-player, mux-video').forEach(host => {
      if (host.shadowRoot) list.push(...findVideosInShadow(host.shadowRoot));
    });
    document.querySelectorAll('video').forEach(v => {
      if (!v.closest('mux-player, mux-video')) list.push(v);
    });
    return list;
  }

  // Pick the main stream video (ignore tiny ad / preview players).
  function primaryVideo() {
    return allVideos()
      .filter(v => v.isConnected && (v.videoWidth >= 320 || v.clientWidth >= 240))
      .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0] || null;
  }

  /** One WebGL context per page — Chrome drops old ones after ~8–16. */
  let active = null; // { video, canvas, gl, stop }

  function disposeActive() {
    if (!active) return;
    active.stop = true;
    if (active.gl) {
      const ext = active.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    active.canvas?.remove();
    if (active.video) {
      active.video.style.opacity = '';
      delete active.video.dataset.orangePatched;
    }
    active = null;
    setMaskTarget(null, null); // uploads stop until a new processor attaches
  }

  function disposeStrayCanvases() {
    document.querySelectorAll('[data-pool-color-canvas]').forEach(el => {
      if (active && el === active.canvas) return;
      el._poolStop = true;
      const gl = el.getContext('webgl') || el.getContext('experimental-webgl');
      const ext = gl?.getExtension?.('WEBGL_lose_context');
      if (ext) ext.loseContext();
      el.remove();
    });
  }

  function attachProcessor(video) {
    if (!config.enabled || !video) return;
    // Already driving this video — keep the existing context.
    if (active && active.video === video && active.canvas?.isConnected) return;

    disposeActive();
    disposeStrayCanvases();

    const parent = video.parentNode;
    if (!parent) return;

    const canvas = document.createElement('canvas');
    canvas.dataset.poolColorCanvas = '1';
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:2';

    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(canvas);
    video.style.opacity = '0';
    video.dataset.orangePatched = '1';

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    });
    if (!gl) {
      console.warn('Orange Five: WebGL unavailable');
      video.style.opacity = '';
      delete video.dataset.orangePatched;
      canvas.remove();
      return;
    }

    const prog = createProgram(gl, VERT, FRAG);
    if (!prog) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      canvas.remove();
      video.style.opacity = '';
      delete video.dataset.orangePatched;
      return;
    }

    const proc = { video, canvas, gl, stop: false };
    active = proc;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    const uTex = gl.getUniformLocation(prog, 'u_tex');
    const locs = {
      orangeHue: gl.getUniformLocation(prog, 'u_orangeHue'),
      orangeSat: gl.getUniformLocation(prog, 'u_orangeSat'),
      orangeSatBoost: gl.getUniformLocation(prog, 'u_orangeSatBoost'),
      orangeLift: gl.getUniformLocation(prog, 'u_orangeLift'),
      orangeL: gl.getUniformLocation(prog, 'u_orangeL'),
      purpleHue: gl.getUniformLocation(prog, 'u_purpleHue'),
      pinkSat: gl.getUniformLocation(prog, 'u_pinkSat'),
      pinkSatBoost: gl.getUniformLocation(prog, 'u_pinkSatBoost'),
      pinkL: gl.getUniformLocation(prog, 'u_pinkL'),
      mauveSatMin: gl.getUniformLocation(prog, 'u_mauveSatMin'),
      mauveSatMax: gl.getUniformLocation(prog, 'u_mauveSatMax'),
      mauveRatio: gl.getUniformLocation(prog, 'u_mauveRatio'),
      pinkSatMin: gl.getUniformLocation(prog, 'u_pinkSatMin'),
      pinkBlueBias: gl.getUniformLocation(prog, 'u_pinkBlueBias'),
      pinkMinBlueRatio: gl.getUniformLocation(prog, 'u_pinkMinBlueRatio'),
      orangeEnabled: gl.getUniformLocation(prog, 'u_orangeEnabled'),
      pinkEnabled: gl.getUniformLocation(prog, 'u_pinkEnabled'),
      cyanEnabled: gl.getUniformLocation(prog, 'u_cyanEnabled'),
      blueHue: gl.getUniformLocation(prog, 'u_blueHue'),
      cyanSat: gl.getUniformLocation(prog, 'u_cyanSat'),
      cyanSatBoost: gl.getUniformLocation(prog, 'u_cyanSatBoost'),
      blueL: gl.getUniformLocation(prog, 'u_blueL'),
      cyanSatMin: gl.getUniformLocation(prog, 'u_cyanSatMin'),
      hasMask: gl.getUniformLocation(prog, 'u_hasMask'),
      maskOk: gl.getUniformLocation(prog, 'u_maskOk'),
      debugMask: gl.getUniformLocation(prog, 'u_debugMask'),
      uMask: gl.getUniformLocation(prog, 'u_mask'),
      aspect: gl.getUniformLocation(prog, 'u_aspect'),
      five: gl.getUniformLocation(prog, 'u_five'),
      four: gl.getUniformLocation(prog, 'u_four'),
      two: gl.getUniformLocation(prog, 'u_two'),
      maskH: gl.getUniformLocation(prog, 'u_maskH'),
    };

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Table-region mask (R8-ish luminance texture, LINEAR upsampled by the GPU).
    const maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE,
      new Uint8Array([255])); // before first analysis: everything "inside"
    setMaskTarget(gl, maskTex);

    let lastW = 0, lastH = 0;

    function draw() {
      if (proc.stop || active !== proc || !video.isConnected || !canvas.isConnected) return;
      if (!config.enabled) return;

      if (video.readyState >= 2 && video.videoWidth) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w !== lastW || h !== lastH) {
          canvas.width = w;
          canvas.height = h;
          gl.viewport(0, 0, w, h);
          lastW = w;
          lastH = h;
        }

        try {
          if (gl.isContextLost()) return;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        } catch (e) {
          console.warn('Orange Five: WebGL texture blocked (cross-origin video). Restoring original.', e.message);
          disposeActive();
          return;
        }

        maybeRunTableDetector(video);

        try {
          gl.useProgram(prog);
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(uTex, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, tableState.maskTex);
          gl.uniform1i(locs.uMask, 1);
          gl.activeTexture(gl.TEXTURE0);
          gl.uniform1f(locs.hasMask,
            ((config.tableEnabled || config.tableDebug) && tableState.available !== null) ? 1.0 : 0.0);
          gl.uniform1f(locs.maskOk, tableState.available ? 1.0 : 0.0);
          gl.uniform1f(locs.orangeHue, config.orangeHue);
          gl.uniform1f(locs.orangeSat, config.orangeSat);
          gl.uniform1f(locs.orangeSatBoost, config.orangeSatBoost);
          gl.uniform1f(locs.orangeLift, config.orangeLift);
          gl.uniform1f(locs.orangeL, config.orangeL);
          gl.uniform1f(locs.purpleHue, config.purpleHue);
          gl.uniform1f(locs.pinkSat, config.pinkSat);
          gl.uniform1f(locs.pinkSatBoost, config.pinkSatBoost);
          gl.uniform1f(locs.pinkL, config.pinkL);
          gl.uniform1f(locs.mauveSatMin, config.mauveSatMin);
          gl.uniform1f(locs.mauveSatMax, config.mauveSatMax);
          gl.uniform1f(locs.mauveRatio, MAUVE_RATIO);
          gl.uniform1f(locs.pinkSatMin, PINK_SAT_MIN);
          gl.uniform1f(locs.pinkBlueBias, PINK_BLUE_BIAS);
          gl.uniform1f(locs.pinkMinBlueRatio, PINK_MIN_BLUE_RATIO);
          gl.uniform1f(locs.orangeEnabled, config.orangeEnabled ? 1.0 : 0.0);
          gl.uniform1f(locs.pinkEnabled, config.pinkEnabled ? 1.0 : 0.0);
          gl.uniform1f(locs.cyanEnabled, config.cyanEnabled ? 1.0 : 0.0);
          gl.uniform1f(locs.blueHue, config.blueHue);
          gl.uniform1f(locs.cyanSat, config.cyanSat);
          gl.uniform1f(locs.cyanSatBoost, config.cyanSatBoost);
          gl.uniform1f(locs.blueL, config.blueL);
          gl.uniform1f(locs.cyanSatMin, CYAN_SAT_MIN);
          gl.uniform1f(locs.debugMask, config.tableDebug ? 1.0 : 0.0);
          gl.uniform1f(locs.aspect,
            (video.videoWidth / Math.max(1, video.videoHeight)) || 1.0);
          gl.uniform1f(locs.maskH, tableState.maskH || 312);
          setBallUniforms(gl, locs);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        } catch (e) {
          console.error('Orange Five: draw error.', e.message);
        }
      }

      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(draw);
      } else {
        requestAnimationFrame(draw);
      }
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(draw);
    } else {
      requestAnimationFrame(draw);
    }
  }

  // --- Table detector driving (table.js) ------------------------------------
  // Time-based cadence with adaptive backoff: aim to re-analyse every
  // ~TABLE_MIN_PERIOD_MS, but never spend more than ~⅓ of wall time on the
  // detector — if a run costs C ms, the next one waits max(period, 3×C).
  // The mask texture is reused between runs; uploads are skipped when the
  // mask is unchanged (static camera = identical mask most frames).
  // gl/maskTex come from attachProcessor's closure via setMaskTarget().
  const TABLE_MIN_PERIOD_MS = 100;
  // available: null = never ran · false = last cycle found nothing · true = table found.
  const tableState = {
    frame: 0, available: null, busy: false, gl: null, maskTex: null,
    lastRun: 0, lastCostMs: 0, lastUpload: null, // lastUpload: last maskU8 ref
    balls: null, // last ball-classifier result (height-normalised disks)
  };

  function setMaskTarget(gl, maskTex) {
    tableState.gl = gl;
    tableState.maskTex = maskTex;
    // Fresh processor: force a clean detector cycle instead of trusting a
    // mask found by a previous (possibly disposed) context.
    tableState.available = null;
    tableState.frame = 0;
    tableState.lastRun = 0;
    tableState.lastUpload = null;
  }

  function maybeRunTableDetector(video) {
    if (!window.__orangeFiveTable) return;
    if (!config.tableEnabled && !config.tableDebug) return;
    const gl = tableState.gl;
    if (!gl) return;
    tableState.frame++;
    if (tableState.busy) return;
    const now = performance.now();
    const period = Math.max(TABLE_MIN_PERIOD_MS, 3 * tableState.lastCostMs);
    if (now - tableState.lastRun < period) return;
    tableState.lastRun = now;
    tableState.busy = true;
    let res = null;
    const t0 = performance.now();
    try {
      res = window.__orangeFiveTable.analyse(video);
    } catch (e) {
      console.warn('Orange Five: table detector failed.', e.message);
    } finally {
      tableState.busy = false;
      tableState.lastCostMs = performance.now() - t0;
    }
    if (res) {
      tableState.available = true;
      const now = performance.now();
      // Throttled diagnostics: classifier output every ~2.5 s, for DevTools.
      if (res.balls && now - (tableState.lastLog || 0) > 2500) {
        tableState.lastLog = now;
        const f = (x) => x ? `${x.cls || ''}(${x.cx.toFixed(0)},${x.cy.toFixed(0)}) r${x.r.toFixed(1)}${x.br ? ` b${x.br.toFixed(0)}` : ''} rgb[${x.rgb}] p${(x.purity ?? 0).toFixed(2)}` : 'none';
        console.debug(`Orange Five balls [cycle ${tableState.frame}]: five=${f(res.balls.five)} four=${f(res.balls.four)} two=${f(res.balls.two)}`);
      }
      // Per-ball classification result → height-normalised disks for the
      // shader (p-space is (u·aspect, v) = (px/h, py/h)). Temporal hold: a
      // class that goes missing is kept for ~700 ms before being dropped —
      // the classifier flickers on shadowed/moving balls, and blinking disks
      // would blink the remaps themselves.
      const k = 1 / res.h;
      // Radius: prefer the stage-2 tight ball radius (`br`, native px) over
      // the area-derived mask r — br hugs the ball's own classified pixels
      // (plus ~2 px), so the whole-ball remap disk excludes the felt margin
      // that the mask-res blob overshoots into. Units stay px/h: native px
      // over video height.
      const disk = (b) => b ? [b.cx * k, b.cy * k,
        b.br ? b.br / video.videoHeight : b.r * k] : null;
      const fresh = res.balls ? {
        five: disk(res.balls.five),
        four: disk(res.balls.four),
        two: disk(res.balls.two),
      } : null;
      const merged = { five: null, four: null, two: null };
      const prev = tableState.balls || {};
      for (const cls of ['five', 'four', 'two']) {
        if (fresh && fresh[cls]) {
          merged[cls] = fresh[cls];
          tableState.ballsSeenAt = tableState.ballsSeenAt || {};
          tableState.ballsSeenAt[cls] = now;
        } else if (prev[cls] && now - (tableState.ballsSeenAt?.[cls] || 0) < 700) {
          merged[cls] = prev[cls]; // hold
        }
      }
      tableState.balls = merged;
      tableState.ballsAt = now;
      // Upload only if the mask actually changed (compare against the buffer
      // we uploaded last time — ~150 KB memcmp is far cheaper than a texture
      // upload every cycle). res.maskU8 is a fresh buffer per analyse() call.
      if (res.maskU8 !== tableState.lastUpload &&
          tableMasksEqual(res.maskU8, tableState.lastUpload)) {
        // same mask: keep the texture as-is
      } else {
        tableState.lastUpload = res.maskU8;
        // Upload on texture unit 1 — unit 0 holds the video texture during the
        // draw loop; clobbering its binding flickers the mask onto the video.
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tableState.maskTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // mask widths are not %4
        // maskU8: felt=255, enclosed hole=128, outside=0. The shader's gate
        // (m >= 0.5) and the debug view's splits (0.66/0.33) both read this.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, res.w, res.h, 0,
          gl.LUMINANCE, gl.UNSIGNED_BYTE, res.maskU8);
        tableState.maskH = res.h;
        gl.activeTexture(gl.TEXTURE0); // restore for the next video upload
      }
    } else {
      tableState.available = false; // "nowhere" — no remap + black debug until next cycle
      tableState.balls = null;
    }
  }

  /** Byte-equality for same-length mask buffers (also handles null). */
  function tableMasksEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Per-ball uniforms from the last classifier cycle (tableState.balls holds
   * height-normalised [cx, cy, r] per class, or null when not found /
   * disabled). r ≤ 0 in the shader means "class not found" → colour-only
   * remap fallback for that class.
   */
  function setBallUniforms(gl, locs) {
    const b = (config.tableEnabled && config.ballsEnabled) ? tableState.balls : null;
    const zero = [0, 0, 0];
    gl.uniform3fv(locs.five, (b && b.five) || zero);
    gl.uniform3fv(locs.four, (b && b.four) || zero);
    gl.uniform3fv(locs.two, (b && b.two) || zero);
  }

  function apply() {
    if (!config.enabled) {
      disposeActive();
      disposeStrayCanvases();
      return;
    }
    // Drop context if the stream video was replaced / navigated away.
    if (active && (!active.video.isConnected || !active.canvas.isConnected)) {
      disposeActive();
    }
    attachProcessor(primaryVideo());
  }

  function enable() {
    config.enabled = true;
    apply();
  }

  function disable() {
    config.enabled = false;
    disposeActive();
    disposeStrayCanvases();
  }

  function updateConfig(partial) {
    Object.assign(config, partial);
    if ('tableEnabled' in partial || 'tableDebug' in partial) {
      // Fresh cycle on toggle: don't reuse a mask from before the switch.
      tableState.frame = 0;
      tableState.available = null;
    }
    if ('enabled' in partial) {
      if (config.enabled) apply();
      else disable();
    }
  }

  function loadSettings(cb) {
    try {
      // Remove keys left behind by the retired "Selectivity" sliders.
      chrome.storage.sync.remove(['orangeSense', 'pinkSense', 'cyanSense']);
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        Object.assign(config, stored);
        if (cb) cb();
      });
    } catch (e) {
      if (cb) cb();
    }
  }

  window.__poolColor = { config, DEFAULTS, apply, enable, disable, updateConfig };

  // Popup writes chrome.storage.sync; we pick up changes here (no extra messaging).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const partial = {};
    for (const key of Object.keys(changes)) {
      partial[key] = changes[key].newValue;
    }
    updateConfig(partial);
  });

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(apply, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  loadSettings(() => {
    apply();
    console.log('Pool Color: WebGL global remapper');
  });
})();
