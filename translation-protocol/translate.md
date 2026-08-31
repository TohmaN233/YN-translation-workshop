# Translation Workflow Reference

The standalone 1.x translation guide has been retired. This file is a documentation
pointer, not a prompt loaded by the 2.x runtime.

- [Product workflow and artifact overview](../README.en.md)
- [Host workflow boundary audit](../docs/agent-workflow-boundary-audit.md)
- [Active translation child protocol](translation-child.md)

The built-in system prompt, DomainRun contract, Host tools, and validators define
the workflow. The Host owns chunk assignment, staging, accepted review evidence,
shared-asset commits, recovery, and completion; Pi JSONL stores session history.
Do not create a separate model-maintained checkpoint file or manually assemble
the obsolete per-chunk output tree from the former guide.
