/**
 * Pool Color Restorer — best-effort global WebGL remapper
 *
 * Intent: remap TV purple/mauve → orange and pink → purple on live pool video.
 * Applies to the whole frame (no region mask). Tunable via popup / storage.
 *
 * Known limits: spill onto similar hues in the scene; not ball-aware.
 * Next direction (separate effort): ball detection → mask-only remap.
 */
(function() {
  'use strict';

  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('youtube') && !currentHost.includes('matchroom')) {
    return;
  }

  const DEFAULTS = {
    enabled: true,
    orangeHue: 32 / 360,
    orangeSat: 0.60,
    orangeSatBoost: 1.7,
    orangeLift: 0.06,
    orangeSense: 0.75, // higher = more selective
    mauveSatMin: 0.05,
    mauveSatMax: 0.48,
    purpleHue: 258 / 360,
    pinkSat: 0.88,
    pinkSatBoost: 1.15,
    pinkSense: 0.50,
  };

  const config = Object.assign({}, DEFAULTS);

  function mauveRatio() {
    return 0.30 + config.orangeSense * 0.35;
  }

  function pinkSatMin() {
    return 0.12 + config.pinkSense * 0.20;
  }

  function pinkMinBlueRatio() {
    return 0.50 + config.pinkSense * 0.22;
  }

  function pinkBlueBias() {
    return 0.01 + config.pinkSense * 0.05;
  }

  const VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform float u_orangeHue;
    uniform float u_orangeSat;
    uniform float u_orangeSatBoost;
    uniform float u_orangeLift;
    uniform float u_purpleHue;
    uniform float u_pinkSat;
    uniform float u_pinkSatBoost;
    uniform float u_mauveSatMin;
    uniform float u_mauveSatMax;
    uniform float u_mauveRatio;
    uniform float u_pinkSatMin;
    uniform float u_pinkBlueBias;
    uniform float u_pinkMinBlueRatio;

    vec3 rgb2hsl(vec3 c) {
      float maxc = max(max(c.r, c.g), c.b);
      float minc = min(min(c.r, c.g), c.b);
      float l = (maxc + minc) * 0.5;
      if (maxc == minc) return vec3(0.0, 0.0, l);
      float d = maxc - minc;
      float s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);
      float h;
      if (maxc == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
      else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
      else h = (c.r - c.g) / d + 4.0;
      return vec3(h / 6.0, s, l);
    }

    float hue2rgb(float p, float q, float t) {
      if (t < 0.0) t += 1.0;
      if (t > 1.0) t -= 1.0;
      if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
      if (t < 0.5) return q;
      if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
      return p;
    }

    vec3 hsl2rgb(vec3 hsl) {
      float h = hsl.x, s = hsl.y, l = hsl.z;
      if (s == 0.0) return vec3(l);
      float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
      float p = 2.0 * l - q;
      return vec3(hue2rgb(p, q, h + 1.0/3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0/3.0));
    }

    vec3 toOrange(float s, float l) {
      float sat = min(1.0, max(s * u_orangeSatBoost, u_orangeSat));
      float shadow = smoothstep(0.03, 0.45, l);
      sat *= mix(0.22, 1.0, shadow);
      float lite = clamp(l + u_orangeLift + (1.0 - shadow) * 0.10, 0.0, 1.0);
      return hsl2rgb(vec3(u_orangeHue, sat, lite));
    }

    vec3 toPurple(float s, float l) {
      float sat = min(0.82, max(s * u_pinkSatBoost, u_pinkSat));
      float shadow = smoothstep(0.03, 0.40, l);
      sat *= mix(0.35, 1.0, shadow);
      float lite = clamp(l * 0.96 + (1.0 - shadow) * 0.04, 0.0, 1.0);
      return hsl2rgb(vec3(u_purpleHue, sat, lite));
    }

    void main() {
      vec4 tex = texture2D(u_tex, v_uv);
      vec3 c = tex.rgb;
      vec3 hsl = rgb2hsl(c);
      float h = hsl.x;
      float s = hsl.y;
      float l = hsl.z;
      float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);

      if (s < 0.06 || chroma < 0.10 || l > 0.93) {
        gl_FragColor = tex;
        return;
      }
      if (l < 0.16 && (s < 0.22 || chroma < 0.14)) {
        gl_FragColor = tex;
        return;
      }

      bool inViolet = h >= 0.70 && h < 0.83;
      bool inPink = h >= 0.83 && h < 0.97;
      bool inRose = h >= 0.97 || h < 0.12;

      vec3 outc = c;
      float blueBias = c.b - c.g;
      float br = c.b / max(c.r, 0.001);
      bool hasPurpleRed = c.r > 0.10 && c.r > c.b * 0.22;

      if (inViolet && s > 0.10 && hasPurpleRed) {
        outc = toOrange(s, l);
      } else if (inPink && s >= max(u_pinkSatMin, 0.14)
          && blueBias >= u_pinkBlueBias
          && br >= u_pinkMinBlueRatio
          && chroma > 0.12) {
        outc = toPurple(s, l);
      } else if (inRose) {
        bool looksMauve = c.r > 0.10
          && c.g / c.r >= u_mauveRatio * 0.85
          && br >= u_mauveRatio * 0.85
          && abs(c.b - c.g) <= 0.12
          && s >= 0.06
          && s < min(u_mauveSatMax, 0.40)
          && chroma > 0.06
          && l > 0.10 && l < 0.85;
        if (looksMauve && s >= u_mauveSatMin) {
          outc = toOrange(s, l);
        }
      }

      gl_FragColor = vec4(outc, tex.a);
    }
  `;

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

  function detach(video) {
    video.style.opacity = '';
    video.style.removeProperty('filter');
    delete video.dataset.orangePatched;
    video.parentNode?.querySelectorAll('[data-pool-color-canvas]').forEach(el => {
      el._poolStop = true;
      el.remove();
    });
  }

  function attachProcessor(video) {
    if (!config.enabled) return;
    if (video.dataset.orangePatched) return;
    video.dataset.orangePatched = '1';
    video.style.removeProperty('filter');

    const parent = video.parentNode;
    if (!parent) return;
    parent.querySelectorAll('[data-pool-color-canvas]').forEach(el => el.remove());

    const canvas = document.createElement('canvas');
    canvas.dataset.poolColorCanvas = '1';
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:2';

    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(canvas);
    video.style.opacity = '0';

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      console.warn('Pool color restorer: WebGL unavailable');
      video.style.opacity = '';
      delete video.dataset.orangePatched;
      return;
    }

    const prog = createProgram(gl, VERT, FRAG);
    if (!prog) return;

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
      purpleHue: gl.getUniformLocation(prog, 'u_purpleHue'),
      pinkSat: gl.getUniformLocation(prog, 'u_pinkSat'),
      pinkSatBoost: gl.getUniformLocation(prog, 'u_pinkSatBoost'),
      mauveSatMin: gl.getUniformLocation(prog, 'u_mauveSatMin'),
      mauveSatMax: gl.getUniformLocation(prog, 'u_mauveSatMax'),
      mauveRatio: gl.getUniformLocation(prog, 'u_mauveRatio'),
      pinkSatMin: gl.getUniformLocation(prog, 'u_pinkSatMin'),
      pinkBlueBias: gl.getUniformLocation(prog, 'u_pinkBlueBias'),
      pinkMinBlueRatio: gl.getUniformLocation(prog, 'u_pinkMinBlueRatio'),
    };

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let lastW = 0, lastH = 0;

    function draw() {
      if (canvas._poolStop || !video.isConnected || !canvas.isConnected) return;
      if (!config.enabled) {
        requestAnimationFrame(draw);
        return;
      }

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
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
          gl.useProgram(prog);
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
          gl.uniform1i(uTex, 0);
          gl.uniform1f(locs.orangeHue, config.orangeHue);
          gl.uniform1f(locs.orangeSat, config.orangeSat);
          gl.uniform1f(locs.orangeSatBoost, config.orangeSatBoost);
          gl.uniform1f(locs.orangeLift, config.orangeLift);
          gl.uniform1f(locs.purpleHue, config.purpleHue);
          gl.uniform1f(locs.pinkSat, config.pinkSat);
          gl.uniform1f(locs.pinkSatBoost, config.pinkSatBoost);
          gl.uniform1f(locs.mauveSatMin, config.mauveSatMin);
          gl.uniform1f(locs.mauveSatMax, config.mauveSatMax);
          gl.uniform1f(locs.mauveRatio, mauveRatio());
          gl.uniform1f(locs.pinkSatMin, pinkSatMin());
          gl.uniform1f(locs.pinkBlueBias, pinkBlueBias());
          gl.uniform1f(locs.pinkMinBlueRatio, pinkMinBlueRatio());
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        } catch (e) {
          if (!canvas.dataset.corsWarned) {
            canvas.dataset.corsWarned = '1';
            console.warn('Pool color restorer: WebGL texture blocked.', e.message);
          }
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

  function apply() {
    if (!config.enabled) {
      allVideos().forEach(detach);
      return;
    }
    allVideos().forEach(attachProcessor);
  }

  function enable() {
    config.enabled = true;
    apply();
  }

  function disable() {
    config.enabled = false;
    allVideos().forEach(detach);
  }

  function updateConfig(partial) {
    Object.assign(config, partial);
    if ('enabled' in partial) {
      if (config.enabled) {
        allVideos().forEach(v => { delete v.dataset.orangePatched; });
        apply();
      } else {
        disable();
      }
    }
  }

  function loadSettings(cb) {
    try {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        Object.assign(config, stored);
        if (cb) cb();
      });
    } catch (e) {
      if (cb) cb();
    }
  }

  window.__poolColor = { config, DEFAULTS, apply, enable, disable, updateConfig };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const partial = {};
    for (const key of Object.keys(changes)) {
      partial[key] = changes[key].newValue;
    }
    updateConfig(partial);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'pool-color-update' && msg.settings) {
      updateConfig(msg.settings);
    }
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
