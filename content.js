(function() {
  'use strict';

  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('youtube') && !currentHost.includes('matchroom')) {
    return;
  }

  // Tunable: window.__poolColor.config
  const config = {
    orangeHue: 28 / 360,
    orangeSatFloor: 0.55,
    purpleHue: 280 / 360,
    mauveSatMin: 0.06,
    mauveSatMax: 0.42,
    pinkSatMin: 0.22,
    mauveMinChannelRatio: 0.45,
  };

  const VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // Selective remap on GPU: violet/mauve → orange, magenta/pink → purple
  const FRAG = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform float u_orangeHue;
    uniform float u_orangeSatFloor;
    uniform float u_purpleHue;
    uniform float u_mauveSatMin;
    uniform float u_mauveSatMax;
    uniform float u_pinkSatMin;
    uniform float u_mauveRatio;

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

    void main() {
      vec4 tex = texture2D(u_tex, v_uv);
      vec3 c = tex.rgb;
      vec3 hsl = rgb2hsl(c);
      float h = hsl.x;
      float s = hsl.y;
      float l = hsl.z;

      if (s < 0.05 || l < 0.08 || l > 0.92) {
        gl_FragColor = tex;
        return;
      }

      bool inViolet = h >= 0.694 && h < 0.820;   // 250–295°
      bool inMagenta = h >= 0.820 && h < 0.944;  // 295–340°
      bool inRose = h >= 0.917 || h < 0.069;     // 330–25°

      vec3 outc = c;

      if (inViolet && s > 0.1) {
        float sat = max(s * 1.5, u_orangeSatFloor);
        outc = hsl2rgb(vec3(u_orangeHue, min(sat, 1.0), l));
      } else if (inMagenta && s >= u_pinkSatMin && c.b > c.g) {
        outc = hsl2rgb(vec3(u_purpleHue, min(s * 1.1, 1.0), l));
      } else if (inRose && s >= u_mauveSatMin && s < u_mauveSatMax) {
        // Dusty mauve 5 vs pure red 3: require elevated g/r and b/r
        if (c.r > 0.01 && c.g / c.r >= u_mauveRatio && c.b / c.r >= u_mauveRatio && c.b >= c.g * 0.9) {
          float sat = max(s * 1.5, u_orangeSatFloor);
          outc = hsl2rgb(vec3(u_orangeHue, min(sat, 1.0), l));
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

  function attachProcessor(video) {
    if (video.dataset.orangePatched) return;
    video.dataset.orangePatched = '1';
    video.style.removeProperty('filter');

    const parent = video.parentNode;
    if (!parent) return;
    parent.querySelectorAll('[data-pool-color-canvas]').forEach(c => c.remove());

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
      orangeSatFloor: gl.getUniformLocation(prog, 'u_orangeSatFloor'),
      purpleHue: gl.getUniformLocation(prog, 'u_purpleHue'),
      mauveSatMin: gl.getUniformLocation(prog, 'u_mauveSatMin'),
      mauveSatMax: gl.getUniformLocation(prog, 'u_mauveSatMax'),
      pinkSatMin: gl.getUniformLocation(prog, 'u_pinkSatMin'),
      mauveRatio: gl.getUniformLocation(prog, 'u_mauveRatio'),
    };

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    let running = true;
    let lastW = 0, lastH = 0;

    function draw() {
      if (!running || !video.isConnected) return;

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
          gl.uniform1f(locs.orangeSatFloor, config.orangeSatFloor);
          gl.uniform1f(locs.purpleHue, config.purpleHue);
          gl.uniform1f(locs.mauveSatMin, config.mauveSatMin);
          gl.uniform1f(locs.mauveSatMax, config.mauveSatMax);
          gl.uniform1f(locs.pinkSatMin, config.pinkSatMin);
          gl.uniform1f(locs.mauveRatio, config.mauveMinChannelRatio);

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

    console.log('Color Engine Hooked: WebGL selective remap');
    video.addEventListener('emptied', () => { running = false; }, { once: true });
  }

  function apply() {
    document.querySelectorAll('mux-player, mux-video').forEach(host => {
      if (!host.shadowRoot) return;
      findVideosInShadow(host.shadowRoot).forEach(attachProcessor);
    });
    document.querySelectorAll('video').forEach(v => {
      if (!v.closest('mux-player, mux-video')) attachProcessor(v);
    });
  }

  function reset() {
    document.querySelectorAll('mux-player, mux-video').forEach(host => {
      if (!host.shadowRoot) return;
      findVideosInShadow(host.shadowRoot).forEach(v => {
        v.style.opacity = '';
        v.style.removeProperty('filter');
        delete v.dataset.orangePatched;
        v.parentNode?.querySelectorAll('[data-pool-color-canvas]').forEach(c => c.remove());
      });
    });
    console.log('Reset — original colors restored');
  }

  window.__poolColor = { config, apply, reset };

  const observer = new MutationObserver(() => apply());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    apply();
  }
})();
