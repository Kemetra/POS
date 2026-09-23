# Sale Workspace Clean-Room Proof Implementation Plan

**Goal:** Deliver one isolated, static Sale Workspace visual proof for owner review.

**Architecture:** `src/renderer/v5/sale/` owns a new semantic screen and immutable local demo model. A narrow `import.meta.env.DEV` branch in the renderer entry mounts it at `#/dev/sale-proof`; packaged production continues through the existing bootstrap and router. Local CSS consumes existing semantic tokens and no legacy screen selectors.

**Tech stack:** Existing React 19, TypeScript, Vite, Electron, Vitest, and CSS custom properties. No dependencies or package changes.

**Spec:** [spec.md](./spec.md)

## File map

| File | Responsibility |
| --- | --- |
| `src/renderer/v5/sale/demo-sale.ts` | Immutable Egyptian pharmacy display data only |
| `src/renderer/v5/sale/SaleScreen.tsx` | Screen layout, header, product region, cart region, totals, actions |
| `src/renderer/v5/sale/sale-screen.css` | Independent layout and visual rules using existing tokens |
| `src/renderer/main.tsx` | Development-only preview selection before production bootstrap |
| `src/renderer/v5/__tests__/sale-proof.test.tsx` | Render, Arabic/RTL, capability absence, and architectural guard |

## Sequence

1. Write the architectural and render tests; verify they fail for the missing `v5` screen.
2. Build the demo model and new Sale composition. Keep ordinary display affordances static and label the surface as a preview.
3. Add the isolated stylesheet. Test at 1024, 1280, and a wider desktop viewport; revise the actual renderer output.
4. Add the development-only preview branch in the renderer entry. Do not alter the router or production route.
5. Run targeted tests, typecheck, lint, full suite, renderer build, and `git diff --check`.
6. Launch the documented Electron development environment; capture genuine `sale-proof-1024.png` and `sale-proof-1280.png`; compare against `022`'s `03-sale-workspace.png` dimension by dimension.
7. Report the visual result and stop at the owner gate. No engine wiring, cutover, commit, push, PR, or merge.

## Review focus

- Long Arabic names and Latin barcodes must stay legible without forcing horizontal overflow.
- The cart must remain dominant at 1024-class width.
- Quantity and line totals must be easy to associate on each row.
- The tax-pending treatment must not imply a computed tax amount.
- Static controls must not imply that a transaction actually changed.
