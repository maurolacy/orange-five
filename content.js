(function() {
  'use strict';

  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('youtube') && !currentHost.includes('matchroom')) {
    return;
  }

  // Tunable via console: window.__poolColor.config
  const config = {
    orangeHue: 28,
    orangeSat: 0.55,
    orangeSatBoost: 1.5,
    purpleHue: 280,
    mauveSatMax: 0.42,
    mauveSatMin: 0.06,
    pinkSatMin: 0.22,
    // Mauve (5) has elevated G&B vs pure red (3). Pure red g/r ≈ 0.15–0.25.
    mauveMinChannelRatio: 0.45,
    // Process at this max width (display is upscaled) — biggest FPS win
    processMaxWidth: 480,
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
    // Fast reject: not in red/magenta/violet family
    if (r < 40 && b < 40) return [r, g, b];

    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.05 || l < 0.08 || l > 0.92) return [r, g, b];

    const inViolet = h >= 250 && h < 295;
    const inMagenta = h >= 295 && h < 340;
    const inRoseArc = h >= 330 || h < 25;

    // Classic violet → orange
    if (inViolet && s > 0.1) {
      const sat = Math.min(1, Math.max(s * config.orangeSatBoost, config.orangeSat));
      return hslToRgb(config.orangeHue, sat, l);
    }

    // True magenta / hot pink (4) → purple. Do NOT use the near-red rose arc
    // for pink→purple — that was turning the solid red 3-ball purple.
    if (inMagenta && s >= config.pinkSatMin && b > g) {
      return hslToRgb(config.purpleHue, Math.min(1, s * 1.1), l);
    }

    // Dusty mauve / TV purple 5 → orange.
    // #996869 has g/r ≈ b/r ≈ 0.68; pure red has g/r ≈ 0.2.
    if (inRoseArc && s >= config.mauveSatMin && s < config.mauveSatMax) {
      const ratio = config.mauveMinChannelRatio;
      if (r > 0 && g / r >= ratio && b / r >= ratio && b >= g * 0.9) {
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
    video.style.removeProperty('filter');

    const parent = video.parentNode;
    if (!parent) return;

    parent.querySelectorAll('[data-pool-color-canvas]').forEach(c => c.remove());

    const display = document.createElement('canvas');
    display.dataset.poolColorCanvas = '1';
    display.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:2';

    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    parent.appendChild(display);
    video.style.opacity = '0';

    const displayCtx = display.getContext('2d');
    const work = document.createElement('canvas');
    const workCtx = work.getContext('2d', { willReadFrequently: true });

    let running = true;
    let srcW = 0, srcH = 0;

    function tick() {
      if (!running || !video.isConnected) return;

      if (video.readyState >= 2 && video.videoWidth) {
        try {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          if (vw !== srcW || vh !== srcH) {
            srcW = vw;
            srcH = vh;
            display.width = vw;
            display.height = vh;
            const scale = Math.min(1, config.processMaxWidth / vw);
            work.width = Math.max(1, Math.round(vw * scale));
            work.height = Math.max(1, Math.round(vh * scale));
          }

          workCtx.drawImage(video, 0, 0, work.width, work.height);
          const imageData = workCtx.getImageData(0, 0, work.width, work.height);
          processImageData(imageData);
          workCtx.putImageData(imageData, 0, 0);
          displayCtx.imageSmoothingEnabled = true;
          displayCtx.drawImage(work, 0, 0, display.width, display.height);
        } catch (e) {
          if (!display.dataset.corsWarned) {
            display.dataset.corsWarned = '1';
            console.warn('Pool color restorer: canvas blocked (CORS).', e.message);
          }
        }
      }

      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(tick);
      } else {
        requestAnimationFrame(tick);
      }
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(tick);
    } else {
      requestAnimationFrame(tick);
    }

    console.log('Color Engine Hooked: selective remap @ max', config.processMaxWidth + 'px');
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

  window.__poolColor = { config, apply, reset, remapPixel };

  const observer = new MutationObserver(() => apply());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    apply();
  }
})();
