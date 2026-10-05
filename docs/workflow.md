# Workflow

The 1.x copy-prompt workflow has been retired. Use the built-in Initial translation
and Proofread workflows in the Agent panel.

- [Current workflow and artifact overview](../README.en.md)
- [User guide](https://tohman233.github.io/YN-translation-workshop/guides.html)
- [Runtime topology and implementation map](agent-runtime-codegraph.md)

The Host owns assignments, validation, persistence, and completion. Inspection
does not resume parked work. A bounded repair owns only its assigned document
and exact line range; full translation and proofreading use their respective
Host-managed plans. Resume reactivates a parked typed workflow. Configured child
counts are concurrency ceilings; only a number stated in the current user
instruction is an exact count.

Proofreading produces Findings JSON; review HTML is generated from that result,
not from a separately required Markdown report.
