(function() {
  'use strict';

  const currentHost = window.location.hostname;
  if (!currentHost.includes('wnttv') && !currentHost.includes('youtube') && !currentHost.includes('matchroom')) {
    return; 
  }

  const svgNS = "http://w3.org";
  const svgRoot = document.createElementNS(svgNS, "svg");
  svgRoot.setAttribute("style", "position: absolute; width: 0; height: 0; overflow: hidden;");
  svgRoot.setAttribute("aria-hidden", "true");

  const filter = document.createElementNS(svgNS, "filter");
  filter.setAttribute("id", "restore-orange-5ball");

  const colorMatrix = document.createElementNS(svgNS, "feColorMatrix");
  colorMatrix.setAttribute("type", "matrix");
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
    [class*="player"],
    [class*="video"] {
      filter: url(#restore-orange-5ball) !important;
    }
  `;
  document.head.appendChild(style);

  console.log("Color Engine Operational: Orange 5-ball initialized.");
})();
