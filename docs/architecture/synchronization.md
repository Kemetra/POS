# Synchronization — POS-Pulse in Retail Tower OS

> How the terminal stays in sync with the platform — and why it never talks to ERPNext directly.

<p align="center">
  <img src="../assets/architecture/pos-pulse-architecture.svg" alt="Animated POS-Pulse synchronization diagram" width="100%"/>
</p>

POS-Pulse is the **edge** of the Retail Tower OS pipeline. It speaks **only** to
`Data-Pulse-2`'s contracts — never to ERPNext.

```text
POS-Pulse ──▶ Data-Pulse-2 ──▶ ERPNext Connector ──▶ ERPNext / Frappe
```

## Two directions

| Direction | What moves | For the terminal |
|---|---|---|
| 🔵 **Read-DOWN** | Resolved sellable catalogue snapshot + deltas | A scanned barcode resolves to a real product **offline**, from the local SQLite read model |
| 🟠 **Capture-UP** | Finalized sales (via the local outbox) | A completed sale durably queues locally, then rises to the backend |

```mermaid
flowchart LR
    classDef edge fill:#1e3a8a,stroke:#60a5fa,color:#fff;
    classDef hub  fill:#7c3aed,stroke:#c4b5fd,color:#fff;
    classDef conn fill:#b45309,stroke:#fbbf24,color:#fff;
    classDef erp  fill:#0f766e,stroke:#5eead4,color:#fff;

    POS["🖥️ POS-Pulse<br/><small>offline-first · SQLite read model · sale outbox</small>"]:::edge
    DP2["🛡️ Data-Pulse-2<br/><small>contract boundary</small>"]:::hub
    CONN["🔌 ERPNext Connector"]:::conn
    ERP["🏛️ ERPNext / Frappe"]:::erp

    DP2 -- "read-DOWN: catalogue snapshot + deltas" --> POS
    POS -- "capture-UP: finalized sales" --> DP2
    DP2 <--> CONN <--> ERP
```

The cross-repo control plane and full program view live in the
[Retail-Tower-Orchestrator](https://github.com/ahmed-shaaban-94/Retail-Tower-Orchestrator).

> Architecture is stable; this document does not assert feature/merge status.
>
> This file owns the **cross-repo synchronization boundary** only. For POS-Pulse's current internal
> architecture, see [`current.md`](./current.md) — the canonical reference. For whether a given spec
> still describes current behaviour, see [`../../specs/README.md`](../../specs/README.md).
> `specs/**` are historical design records, not the authority for current implementation state.
