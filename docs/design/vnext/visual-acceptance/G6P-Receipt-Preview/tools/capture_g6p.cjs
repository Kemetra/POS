// Capture every RT-659 G-6 addendum reference (light + forced colours) and run the fit, focus and axe checks.
// Usage: node capture_g6p.cjs   (no arguments: the pack folder is this script's parent).
const path = require('path');
const { captureRefs } = require('../../tools/capture-refs.cjs');

captureRefs({
  packDir: path.resolve(__dirname, '..'),
  prefix: 'G6P',
  selectors: ['.panel', '.dialog', '.well', '.notice', '.nav', '.operator', '.result'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
