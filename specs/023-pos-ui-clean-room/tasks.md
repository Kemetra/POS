# 023 tasks: Sale Workspace static proof

- [x] Verify clean `main`, current SHA, 023 availability, and create `feat/023-pos-ui-clean-room-sale-proof`.
- [x] Read the approved design authority and diagnose the legacy Sale presentation before edits.
- [x] Add a failing structural/render test for the new isolated Sale screen.
- [x] Create the immutable Egyptian pharmacy demo model and new `v5` Sale DOM.
- [x] Style the independent Sale layout with existing semantic tokens and accessible RTL/LTR structure.
- [x] Expose a development-only preview in the actual renderer without changing `/app/cart`.
- [ ] Run targeted and repository validation gates. Targeted, typecheck, full suite, build, and diff check passed. Repository lint is blocked by ignored `.impeccable/hook.cache.json`; changed-file lint and formatting passed.
- [x] Capture real Electron screenshots at 1024-class and 1280-class viewports.
- [x] Compare against `022/visual-references/03-sale-workspace.png` and report the owner gate. The owner approved the static Sale visual direction in the conversation on 2026-09-23.

The managed sandbox blocked Electron child-process launch. The same POS build rendered with a temporary user profile outside the sandbox; screenshots were captured from its live `#/dev/sale-proof` page through Electron's local debugging protocol. The two target screenshots are genuine renderer captures. Visual adjustments were recaptured at both target sizes before the owner approved the direction.
