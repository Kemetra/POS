// Capture every G-6 reference (light + forced colours) and run the fit, focus and axe checks.
// Usage: node capture_g6.cjs   (no arguments: the pack folder is this script's parent).
const path = require('path');
const { captureRefs } = require('../../tools/capture-refs.cjs');

captureRefs({
  packDir: path.resolve(__dirname, '..'),
  prefix: 'G6',
  selectors: ['.panel', '.panel-head', '.dialog', '.notice', '.nav', '.operator', '.tile', '.result'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
