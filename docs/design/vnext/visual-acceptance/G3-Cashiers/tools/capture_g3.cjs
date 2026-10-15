// Capture every G-3 reference (light + forced colours) and run the fit, focus and axe checks.
// Usage: node capture_g3.cjs   (no arguments: the pack folder is this script's parent).
// The checks live in ../../tools/capture-refs.cjs, shared with G-6.
const path = require('path');
const { captureRefs } = require('../../tools/capture-refs.cjs');

captureRefs({
  packDir: path.resolve(__dirname, '..'),
  prefix: 'G3',
  selectors: ['.panel', '.panel-head', '.dialog', '.notice', '.nav', '.operator'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
