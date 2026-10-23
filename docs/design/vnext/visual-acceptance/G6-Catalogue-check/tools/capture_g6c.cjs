// Capture every RT-859 catalogue-check reference (light + forced colours) and run the fit, focus and axe checks.
// Usage: node capture_g6c.cjs   (no arguments: the pack folder is this script's parent).
// The checks live in ../../tools/capture-refs.cjs, shared with G-3, G-6, G-6 Returns and PK-3.
const path = require('path');
const { captureRefs } = require('../../tools/capture-refs.cjs');

captureRefs({
  packDir: path.resolve(__dirname, '..'),
  prefix: 'G6C',
  selectors: ['.panel', '.panel-head', '.nav', '.operator', '.rows', '.limited'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
