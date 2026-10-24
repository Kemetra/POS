// Capture every RT-853 manual-discount reference (light + forced colours) and run the fit, focus and axe checks.
// Usage: node capture_d1.cjs   (no arguments: the pack folder is this script's parent).
// The checks live in ../../tools/capture-refs.cjs, shared with G-3, G-6, PK-3 and the G-6 addenda.
const path = require('path');
const { captureRefs } = require('../../tools/capture-refs.cjs');

captureRefs({
  packDir: path.resolve(__dirname, '..'),
  prefix: 'D1',
  selectors: ['.cart', '.money-col', '.command', '.nav', '.operator', '.dialog', '.ledger', '.order', '.proofs'],
  // The cart uses the shipped Direction B names: each line and discount row spills-checked, each product name clip-checked.
  parts: { row: '.line, .disc', list: '.lines', name: '.nm' },
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
