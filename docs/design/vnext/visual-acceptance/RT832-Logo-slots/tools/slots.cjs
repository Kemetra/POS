// RT-832 — the single source of truth for the tenant-logo slot boxes (RT-473 OD-7).
// capture_rt832.cjs draws from it and gen_spec.cjs renders the table from it, so the
// frames, the table and the doc cannot drift apart. CSS px; 2x = double.
module.exports = {
  // Same box at 1024 and 1280: the S1 contract has one rendition per (slot, scale),
  // not per width, so a width-dependent box would need a contract change.
  slots: {
    boot:    { label: 'Boot',            w: 240, h: 120, align: 'center', after: 24, kind: 'in-flow above the loading status' },
    pairing: { label: 'Pairing',         w: 200, h: 80,  align: 'start',  after: 16, kind: 'first child of the 440px card' },
    sign_in: { label: 'Sign-in header',  w: 128, h: 32,  align: 'start',  after: 14, kind: 'in the 48/44px context strip' },
    lock:    { label: 'Lock',            w: 200, h: 80,  align: 'start',  after: 12, kind: 'first child of the 440px lock dialog' },
  },
  clearBandPct: 8,           // uniform clear space baked into every rendition by S2 normalization
  chip: { cardPad: 12, stripPadBlock: 2, stripPadInline: 4, border: 1 }, // low_contrast white card, OUTSIDE the box
  poweredBy: { prefix: 'بدعم من', name: 'Retail Tower', sizePx: 12 },
  viewports: [ { w: 1024, h: 768 }, { w: 1280, h: 800 } ],
};
