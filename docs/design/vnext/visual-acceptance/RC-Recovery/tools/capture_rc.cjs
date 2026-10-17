// Capture every RC reference (light + forced colours) and run the fit, focus and axe checks.
// Usage: node capture_rc.cjs   (no arguments: the pack folder is this script's parent).
// The checks live in ../../tools/capture-refs.cjs, shared with G-3, G-6 and PK-3.
const path = require('path');
const { captureRefs } = require('../../tools/capture-refs.cjs');

captureRefs({
  packDir: path.resolve(__dirname, '..'),
  prefix: 'RC',
  selectors: ['.panel', '.panel-head', '.dialog', '.notice', '.nav', '.operator', '.rc-facts', '.rc-actions'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
