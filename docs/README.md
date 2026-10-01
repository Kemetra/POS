# POS Pulse documentation

Documentation index for POS Pulse, the Windows desktop point-of-sale terminal for the SmartDataPulse pharmacy platform. The [root README](../README.md) is the canonical entry point; this page is the deep-dive map.

## Start here

| Audience | First reads |
| --- | --- |
| Product &amp; operations | [Root README](../README.md) · [Product brief](product.md) · [Hardware matrix](hardware-matrix.md) · [POS shell spec](../specs/003-pos-ui-shell/spec.md) |
| Engineering | [Foundation plan](../specs/001-foundation/plan.md) · [Terminal pairing plan](../specs/002-terminal-pairing/plan.md) · [Operator session plan](../specs/004-operator-session/plan.md) · [Live terminal map](architecture/pos-pulse-live-map.html) |
| Design | [Design system](DESIGN.md) · [Visual system spec](../specs/007-pos-visual-system/spec.md) · [Asset guide](assets/README.md) |
| Security | [Constitution](../.specify/memory/constitution.md) · [Operator security review](../specs/004-operator-session/security-review/s1-review.md) · [Redaction evidence](../specs/004-operator-session/security-review/s1-redaction-evidence.md) |
| Integration | [Pairing HTTP contract](../specs/002-terminal-pairing/contracts/pairing-http.md) · [Operator backend endpoints](../specs/004-operator-session/contracts/backend-endpoints.md) · [API snapshot](../scripts/openapi-snapshot.json) |

## Documentation map

| Document | Purpose |
| --- | --- |
| [Product brief](product.md) | Users, product purpose, brand personality, design principles, accessibility. |
| [Live terminal map](architecture/pos-pulse-live-map.html) | Interactive Three.js terminal topology backed by local JSON. |
| [Topology JSON](architecture/pos-pulse-live-map.json) | Reviewable node and edge source for the live map. |
| [Design system](DESIGN.md) | Color tokens, typography, spacing, motion, and component foundations. Stitch-format DESIGN.md consumed by the `/impeccable` skill. |
| [Hardware matrix](hardware-matrix.md) | MVP hardware scope, tested-model registry, and update rules. |
| [Asset guide](assets/README.md) | Visual asset naming and style guidance for README and docs diagrams. |
| [Foundation quickstart](../specs/001-foundation/quickstart.md) | Clone-to-window developer onboarding for the secure Electron substrate. |
| [Terminal pairing quickstart](../specs/002-terminal-pairing/quickstart.md) | Pairing flow setup and verification guidance. |
| [POS UI shell plan](../specs/003-pos-ui-shell/plan.md) | Renderer shell, navigation, routes, and UI region strategy. |
| [Operator session spec](../specs/004-operator-session/spec.md) | Operator identity, role visibility, and session lifecycle. |
| [Sales cart workflow](onboarding/cart-workflow.md) · [Sales cart runbook](runbook/sales-cart.md) | Operational guidance for the sales-cart slice. |
| [Electron 44 upgrade plan](runtime/electron-44-upgrade-plan.md) | RT-65: Electron 41 → 44 path, breaking-change audit, native-module evidence, regression matrix and rollback. |
| [Maestro workflow](maestro/README.md) | Multi-agent orchestration playbook for active features. |

## Visual system

The README uses GitHub-renderable SVG and Mermaid:

- SVG assets provide a polished product-grade first impression. The architecture and system-flow diagrams animate inline on GitHub via SMIL.
- The live terminal map uses a standalone HTML page so GitHub README rendering remains static and safe.
- Mermaid keeps technical flow diagrams editable in Markdown.
- Icons live under [`assets/icons/`](assets/icons/) and use a consistent terminal-oriented enterprise style with depth gradients, soft shadows, and subtle motion.

## Documentation rules

- Keep wording truthful to the POS terminal scope.
- Do not imply this repository owns the SaaS backend or dashboard.
- Preserve the secure Electron process boundary in any architecture docs.
- Treat the hardware matrix and constitution as higher authority than marketing language.
