const fs = require('fs');
const { PNG } = require('pngjs');

// crop.js <frame.png> <zoom> <radius> <out> <cx> <cy> [cx2 cy2 ...]
const [file, zoomStr, radStr, out, ...pts] = process.argv.slice(2);
const zoom = Number(zoomStr), rad = Number(radStr);
const src = PNG.sync.read(fs.readFileSync(file));
const jobs = [];
for (let i = 0; i < pts.length; i += 2) jobs.push({ cx: +pts[i], cy: +pts[i + 1] });
const size = rad * 2 + 1;
const dst = new PNG({ width: size * zoom * jobs.length, height: size * zoom });
jobs.forEach((j, k) => {
  const x0 = Math.max(0, Math.min(src.width - size, Math.round(j.cx) - rad));
  const y0 = Math.max(0, Math.min(src.height - size, Math.round(j.cy) - rad));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((y0 + y) * src.width + (x0 + x)) * 4;
      for (let zy = 0; zy < zoom; zy++) {
        for (let zz = 0; zz < zoom; zz++) {
          const d = ((y * zoom + zy) * dst.width + (k * size * zoom + x * zoom + zz)) * 4;
          dst.data[d] = src.data[s];
          dst.data[d + 1] = src.data[s + 1];
          dst.data[d + 2] = src.data[s + 2];
          dst.data[d + 3] = 255;
        }
      }
    }
  }
});
fs.writeFileSync(out, PNG.sync.write(dst));
console.log(`wrote ${out} (${jobs.length} crops @${zoom}x, r=${rad})`);
