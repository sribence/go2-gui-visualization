/* Colourised view of a greyscale depth feed.
 *
 * The RealSense driver can publish a colourised depth topic, but it is not
 * enabled on this dock and turning it on would mean touching the running
 * bridge. Colourising in the browser costs the robot nothing and lets the
 * operator switch palette without a redeploy.
 */

const PALETTES = {
  // Sampled control points, linearly interpolated at build time.
  turbo: [[48,18,59],[70,107,227],[42,176,203],[93,222,116],[199,227,52],[251,150,44],[221,61,18],[122,4,3]],
  inferno: [[0,0,4],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[250,193,39],[252,255,164]],
  jet: [[0,0,131],[0,60,170],[5,255,255],[255,255,0],[250,0,0],[128,0,0]],
};

function lut(name) {
  const stops = PALETTES[name];
  if (!stops) return null;
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const a = stops[Math.floor(t)], b = stops[Math.min(stops.length - 1, Math.ceil(t))];
    const f = t - Math.floor(t);
    out[i * 3] = a[0] + (b[0] - a[0]) * f;
    out[i * 3 + 1] = a[1] + (b[1] - a[1]) * f;
    out[i * 3 + 2] = a[2] + (b[2] - a[2]) * f;
  }
  return out;
}

const CACHE = {};
function getLut(name) {
  if (!(name in CACHE)) CACHE[name] = lut(name);
  return CACHE[name];
}

/** Returns {node, setPalette, stop} -- node is a <canvas> to place in the DOM. */
export function depthView(streamUrl, palette = "turbo", fps = 10) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.objectFit = "contain";
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let table = getLut(palette);
  let timer = null;
  let stopped = false;

  img.src = streamUrl;

  function draw() {
    if (stopped || !img.naturalWidth) return;
    if (canvas.width !== img.naturalWidth) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    ctx.drawImage(img, 0, 0);
    if (!table) return;                       // "nincs": leave it greyscale
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = d.data;

    // The driver already scales depth into 8 bits, and indoors most of the
    // frame lands near one end -- straight mapping gives a flat wall of
    // colour. Stretch each frame between its own 2nd and 98th percentile so
    // the palette actually spends its range on the scene.
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i];
      if (v) { hist[v]++; n++; }
    }
    let lo = 1, hi = 255;
    if (n > 0) {
      const loCut = n * 0.02, hiCut = n * 0.98;
      let acc = 0;
      for (let v = 1; v < 256; v++) {
        acc += hist[v];
        if (acc >= loCut) { lo = v; break; }
      }
      acc = 0;
      for (let v = 1; v < 256; v++) {
        acc += hist[v];
        if (acc >= hiCut) { hi = v; break; }
      }
    }
    const span = Math.max(1, hi - lo);

    for (let i = 0; i < px.length; i += 4) {
      // 0 means "no return" -- keep it dark instead of colouring it.
      const raw = px[i];
      if (raw === 0) { px[i] = px[i + 1] = px[i + 2] = 8; continue; }
      const v = Math.max(0, Math.min(255, Math.round(((raw - lo) / span) * 255)));
      px[i] = table[v * 3];
      px[i + 1] = table[v * 3 + 1];
      px[i + 2] = table[v * 3 + 2];
    }
    ctx.putImageData(d, 0, 0);
  }

  timer = setInterval(draw, Math.round(1000 / fps));

  return {
    node: canvas,
    setPalette(name) { table = getLut(name); },
    stop() { stopped = true; clearInterval(timer); img.removeAttribute("src"); },
  };
}
