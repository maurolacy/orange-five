// Pool Ball Color Restoration - Content Script
(function() {
  'use strict';

  // 1. Create and inject the SVG filter element into the document body
  const svgNS = "http://w3.org";
  const svgRoot = document.createElementNS(svgNS, "svg");
  svgRoot.setAttribute("style", "position: absolute; width: 0; height: 0; overflow: hidden;");
  svgRoot.setAttribute("aria-hidden", "true");

  const filter = document.createElementNS(svgNS, "filter");
  filter.setAttribute("id", "restore-orange-5ball");

  // 2. The Color Matrix Device: [R, G, B, A, Bias]
  // This layout targets the magenta/violet tones and tilts them heavily into red/orange spectra.
  const colorMatrix = document.createElementNS(svgNS, "feColorMatrix");
  colorMatrix.setAttribute("type", "matrix");
  colorMatrix.setAttribute("values", `
    1.6  -0.2  -0.1   0.0   0.0
    0.4   0.9  -0.3   0.0   0.0
   -0.2  -0.2   0.2   0.0   0.0
    0.0   0.0   0.0   1.0   0.0
  `);

  filter.appendChild(colorMatrix);
  svgRoot.appendChild(filter);
  document.body.appendChild(svgRoot);

  // 3. Inject CSS to target the active HTML5 video stream container
  const style = document.createElement('style');
  style.textContent = `
    video, 
    .html5-main-video, 
    .vjs-tech {
      filter: url(#restore-orange-5ball) !important;
    }
  `;
  document.head.appendChild(style);

  console.log("Pool Ball Restoration Active: The orange 5-ball lives again!");
})();
