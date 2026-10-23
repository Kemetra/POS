import { chromium } from 'file:///C:/Users/Shaaban/Documents/GitHub/POS/.claude/worktrees/rt-204-receipt-wrap-91a12d/node_modules/@playwright/test/index.mjs';
const out = process.argv[2]; const tag=process.argv[3];
const b = await chromium.launch();
const res = [];
for (const mode of ['click','enter']) for (const [w,h] of [[1280,800],[1024,768]]) for (const fc of ['none','active']) {
  const ctx = await b.newContext({ viewport:{width:w,height:h}, forcedColors: fc, colorScheme:'light' });
  const p = await ctx.newPage();
  await p.goto('http://localhost:5173/#/dev/checkout-proof?preset=exact');
  const cb=p.getByRole('button',{name:'تأكيد الدفع'});
  if (mode==='click') await cb.click(); else { await p.waitForTimeout(800); await cb.focus(); await p.keyboard.press('Enter'); }
  const nb = p.getByRole('button',{name:'بيع جديد'}); await nb.waitFor();
  await p.waitForTimeout(700);
  const r = await nb.evaluate(e=>({focused:document.activeElement===e, fv:e.matches(':focus-visible'), outline:getComputedStyle(e).outline}));
  await p.screenshot({path:`${out}/completion-${tag}-${mode}-${w}-${fc==='active'?'forced-colors':'light'}.png`});
  res.push({mode,w,fc,...r}); await ctx.close();
}
console.log(JSON.stringify(res,null,1)); await b.close();
