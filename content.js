(function() {
  'use strict';

  // Resource protection filter
  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('youtube') && !currentHost.includes('matchroom')) {
    return; 
  }

  // 1. Core function that builds the orange color engine
  function injectOrangeFilter() {
    if (document.getElementById('restore-orange-5ball')) return; // Already running

    const svgNS = "http://www.w3.org/2000/svg";
    const svgRoot = document.createElementNS(svgNS, "svg");
    svgRoot.setAttribute("style", "position: absolute; width: 0; height: 0; overflow: hidden;");
    svgRoot.setAttribute("aria-hidden", "true");

    const filter = document.createElementNS(svgNS, "filter");
    filter.setAttribute("id", "restore-orange-5ball");

    const colorMatrix = document.createElementNS(svgNS, "feColorMatrix");
    colorMatrix.setAttribute("type", "matrix");
    // Matrix: Selectively pulling TV Purple wavelengths over into a warm orange spectrum
    colorMatrix.setAttribute("values", `
      1.7  -0.2  -0.1   0.0   0.0
      0.5   1.0  -0.3   0.0   0.0
     -0.2  -0.2   0.2   0.0   0.0
      0.0   0.0   0.0   1.0   0.0
    `);

    filter.appendChild(colorMatrix);
    svgRoot.appendChild(filter);
    document.body.appendChild(svgRoot);

    const style = document.createElement('style');
    style.textContent = `
      video, 
      .video-js,
      .vjs-tech,
      iframe,
      mux-player,
      mux-video,
      [class*="player"],
      [class*="video"] {
        filter: url(#restore-orange-5ball) !important;
      }
    `;
    document.head.appendChild(style);
    console.log("Color Engine Hooked: Purple 5-ball eradicated.");
  }

  // 2. The Radar: Watches for the streaming video player to build its layers
  const observer = new MutationObserver((mutations, obs) => {
    const videoActive = document.querySelector('video, .video-js, iframe, mux-player, mux-video, [class*="video"]');
    if (videoActive) {
      injectOrangeFilter();
      // Keep observing in case the site reloads the stream window
    }
  });

  // Start watching the page structure instantly
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Run a quick check right away just in case it's already there
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    injectOrangeFilter();
  }
})();
