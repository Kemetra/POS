// Capture every G-2 reference (light + forced colours) and run the fit, focus and axe checks.
// Usage: node capture_g2.cjs   (no arguments: the pack folder is this script's parent).
// The checks live in ../../tools/capture-refs.cjs, shared with G-3, G-6 and PK-3.
const path = require('path');
const { captureRefs } = require('../../tools/capture-refs.cjs');

captureRefs({
  packDir: path.resolve(__dirname, '..'),
  prefix: 'G2',
  selectors: ['.panel', '.panel-head', '.dialog', '.notice', '.nav', '.operator', '.groups', '.figures'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
