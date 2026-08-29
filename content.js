(function() {
  'use strict';

  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('youtube') && !currentHost.includes('matchroom')) {
    return;
  }

  // Tunable via console: window.__poolColor.config = { ... }
  const config = {
    orangeHue: 28,       // lower = redder orange, higher = yellower
    orangeSat: 0.55,     // floor saturation for remapped orange (raise = punchier)
    orangeSatBoost: 1.5, // multiply original sat before applying floor
    purpleHue: 280,
    // Dusty mauve / TV "purple" 5-ball → orange
    mauveSatMax: 0.42,
    mauveSatMin: 0.06,
    // Hot pink 4-ball → purple
    pinkSatMin: 0.28,
  };

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      default: h = ((r - g) / d + 4); break;
    }
    return [h * 60, s, l];
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let rp, gp, bp;
    if (h < 60) [rp, gp, bp] = [c, x, 0];
    else if (h < 120) [rp, gp, bp] = [x, c, 0];
    else if (h < 180) [rp, gp, bp] = [0, c, x];
    else if (h < 240) [rp, gp, bp] = [0, x, c];
    else if (h < 300) [rp, gp, bp] = [x, 0, c];
    else [rp, gp, bp] = [c, 0, x];
    return [
      Math.round((rp + m) * 255),
      Math.round((gp + m) * 255),
      Math.round((bp + m) * 255),
    ];
  }

  function remapPixel(r, g, b) {
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.05 || l < 0.08 || l > 0.92) return [r, g, b];

    const blueish = b >= g * 0.95;
    const inRoseArc = h >= 320 || h < 30;
    const inViolet = h >= 250 && h < 295;
    const inMagenta = h >= 295 && h < 340;

    // Classic violet/purple → orange
    if (inViolet && s > 0.1) {
      const sat = Math.min(1, Math.max(s * config.orangeSatBoost, config.orangeSat));
      return hslToRgb(config.orangeHue, sat, l);
    }

    // Magenta / hot pink (4-ball) → purple  — check BEFORE mauve
    if (inMagenta && s >= config.pinkSatMin) {
      return hslToRgb(config.purpleHue, Math.min(1, s * 1.1), l);
    }

    // Rose arc: split by saturation.
    // Eyedropper on the 5 was ~#996869 (sat ~0.19). Pink 4 is more saturated.
    if (inRoseArc && blueish && s >= config.mauveSatMin) {
      if (s >= config.pinkSatMin) {
        return hslToRgb(config.purpleHue, Math.min(1, s * 1.1), l);
      }
      if (s < config.mauveSatMax) {
        const sat = Math.min(1, Math.max(s * config.orangeSatBoost, config.orangeSat));
        return hslToRgb(config.orangeHue, sat, l);
      }
    }

    return [r, g, b];
  }

  function processImageData(imageData) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const [nr, ng, nb] = remapPixel(d[i], d[i + 1], d[i + 2]);
      d[i] = nr;
      d[i + 1] = ng;
      d[i + 2] = nb;
    }
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

    // Clear any leftover CSS filter experiments
    video.style.removeProperty('filter');

    const parent = video.parentNode;
    if (!parent) return;

    const canvas = document.createElement('canvas');
    canvas.dataset.poolColorCanvas = '1';
    canvas.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'object-fit:contain',
      'pointer-events:none',
      'z-index:2',
    ].join(';');

    const host = parent;
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    host.appendChild(canvas);

    // Hide the raw video visually; keep it playing for frames
    video.style.opacity = '0';

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let running = true;
    let lastW = 0, lastH = 0;

    function syncSize() {
      const w = video.videoWidth || video.clientWidth;
      const h = video.videoHeight || video.clientHeight;
      if (!w || !h) return false;
      if (w !== lastW || h !== lastH) {
        canvas.width = w;
        canvas.height = h;
        lastW = w;
        lastH = h;
      }
      return true;
    }

    function frame() {
      if (!running || !video.isConnected) return;
      if (video.readyState >= 2 && syncSize()) {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          processImageData(imageData);
          ctx.putImageData(imageData, 0, 0);
        } catch (e) {
          // Cross-origin / tainted canvas — fall back silently
          if (!canvas.dataset.corsWarned) {
            canvas.dataset.corsWarned = '1';
            console.warn('Pool color restorer: canvas blocked (CORS).', e.message);
          }
        }
      }
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
    console.log('Color Engine Hooked: selective purple→orange, pink→purple.');

    video.addEventListener('emptied', () => { running = false; }, { once: true });
  }

  function apply() {
    document.querySelectorAll('mux-player, mux-video').forEach(host => {
      if (!host.shadowRoot) return;
      findVideosInShadow(host.shadowRoot).forEach(attachProcessor);
    });
    document.querySelectorAll('video').forEach(v => {
      // Skip videos already handled via shadow walk
      if (!v.closest('mux-player, mux-video')) attachProcessor(v);
    });
  }

  window.__poolColor = { config, apply, remapPixel };

  const observer = new MutationObserver(() => apply());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    apply();
  }
})();
