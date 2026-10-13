# Agent terminology

[中文](terminology.md) · [Workflows](workflows.en.md)

## Agent

An execution unit that receives messages, invokes a model, selects tools, and keeps a task moving.

Both Parent and Child are Agents running on the Pi runtime.

It is not the model itself; the model is one capability used during an Agent turn.

## Host

The trusted program layer outside the model that executes tools, reads and writes files, persists state, and rejects invalid operations.

The YN Host is the translation-domain part of the broader Agent host. It owns manifests, queues, scopes, validation, evidence, and commits.

It is not a remote server, the Parent Agent, or another model.

## Harness

The surrounding system that connects models, message loops, tools, state, error handling, and completion checks into a working agent.

Here it includes the Pi Agent loop, YN Host, tools, Supervisor, persistence, and UI protocol.

It is not a single prompt or one workflow.

## Runtime

The code environment and lifecycle implementation in which an Agent actually runs.

The Pi runtime handles messages, model calls, tool calls, continue, queued messages, retries, and compaction.

It is not the selected model; one runtime can use different providers and models.

## Pi

The base Agent runtime used by this project.

Parent and Child share Pi Agent, AgentMessage, Session, and JSONL semantics.

It is not a separate chat protocol invented by YN.

## Parent Agent

The primary Agent that talks to the user, plans the work, and consolidates results.

It advances stages, calls Host tools, resolves conflicts and remaining debt, and reports the outcome.

It cannot bypass Host scope and validation rules.

## Child Agent / Subagent

An Agent started by the Parent or Host for a bounded task.

A Child has its own Pi session and sees only the tools and context required by its current assignment.

It is not merely a background thread and cannot spawn another subagent layer.

## Worker

A persistent Child role that repeatedly claims assignments from a shared queue.

Translation Workers write staging, review Workers submit only failed verdicts, and proofread Workers write findings.

Worker count is a concurrency limit, not the number of task chunks.

## Supervisor

The Host component that manages Child lifecycles, task claims, retries, settlement, and replacement workers.

It connects the Host queue to Pi Child runtimes and prevents a failed Worker from silently claiming more work.

It does not generate translation content.

## Provider / Model

A Provider supplies model access; a Model is the specific model invoked through that service.

They are user-level settings, and Children inherit the Parent selection by default.

Changing the model does not replace the Host, workflow contract, or project assets.

## Prompt / System Prompt

A Prompt is the instruction for a turn; a System Prompt is higher-priority runtime guidance about behavior and tools.

The page prompt selects translation or proofreading, while the built-in System Prompt explains the active typed workflow and tools.

Prompt wording cannot grant write authority that the Host did not provide.

## Tool / Function

A structured call interface exposed by the Host to an Agent. This manual uses Function for these tool surfaces.

Each surface has a schema, read boundary, state transition, result, and rejection conditions.

It is not an arbitrary internal JavaScript function available to the model.

## Tool Call

A structured message in which an Agent asks the Host to execute a Tool.

The Host validates arguments and current state, executes the operation, and returns a toolResult to the same Pi turn.

A successful call does not mean the whole workflow is complete.

## Workflow

A complete work contract from entry point through staged execution to completion conditions.

The product exposes only initial_translation and proofread as full workflows; terminology, character handling, reuse, and QA are internal stages.

It is not merely a button that prefills a prompt.

## Typed Contract

A machine-structured, enforceable constraint rather than a promise written only in natural language.

Document identity, scope, worker limit, workflow intent, and completion debt are stored as typed state.

A model saying it will edit only certain lines is not typed authorization.

## DomainRun

The domain-state instance for one YN translation or proofreading workflow.

It records workflow kind, owner, inspection, batches, discoveries, debt, and completion progress.

It is not a model process or a UI task card.

## Scope / Ownership

Scope defines what may be operated on; Ownership identifies who currently holds legal authority over that scope.

Documents, contiguous ranges, and exact lines are Host-authorized, and reading context never expands write ownership.

Being able to read a file does not imply permission to modify it.

## Assignment

One bounded unit of work assigned by the Host to a Worker.

It binds a document, range or exact lines, input hash, worker role, and attempt state.

It is not necessarily a whole file or always equal to splitSize.

## Batch

A set of assignments managed and settled by one Host scheduling operation.

The Host atomically reserves the batch before creating Children and records taskCount separately from workerCount.

It is not one Child or one file.

## Manifest

The authoritative document list and identities for the current run.

File order, source and candidate paths, line counts, and stage barriers come from this manifest.

It is not a temporary directory listing reconstructed by the model every turn.

## Artifact

A durable file or record produced by a workflow and subject to machine validation.

Typical artifacts include aligned translation candidates, findings JSON, HTML sidecars, and project assets.

An Agent saying 'done' in chat is not an artifact.

## Candidate

Content still awaiting inspection, selection, or confirmation; its exact meaning depends on the object.

A translation candidate is output awaiting final write-back, while a glossary candidate is a term not yet in the approved glossary.

The two candidate types do not share the same approval or storage rules.

## Canonical

The version or location currently treated as authoritative for settlement.

It may describe the approved glossary, canonical translation path, canonical Pi messages, or the single findings JSON.

It does not mean immutable forever; it means the current source of truth is unambiguous.

## Staging

A recoverable, inspectable copy that has not yet been promoted to the official result.

Translation Workers write their lines to staging first; the Host promotes them only after mechanical validation and independent review.

It is not Git staging, an in-memory cache, or already committed translation output.

## Promote

To write an accepted staging range into the canonical artifact.

Promotion is range-scoped and candidate-locked, so unrelated unreviewed staging lines are not included.

It is not simply renaming an entire temporary file.

## Validator / Validation

Code and process that use deterministic rules to decide whether input or output satisfies a contract.

It checks line counts, placeholders, tags, preserve rules, scope, schema, terminology, and completion debt.

It is not a model saying the result looks good.

## Mechanical Validation

Deterministic checks that can be repeated without asking a model to understand meaning.

Examples include alignment, protected payloads, blank lines, obvious placeholder text, formatting, and some terminology consistency.

It cannot replace semantic review of meaning, tone, and context.

## Semantic Review / Reviewer

Review that uses source, translation, and context to judge meaning; a Reviewer is the read-only Worker performing it.

Translation Reviewers report only failed lines, while proofread Workers write structured findings.

A Reviewer does not directly edit translation staging.

## Finding / Verdict

A Finding is a deliverable proofreading issue; a Verdict is a structured decision for a check.

Findings enter the single JSON and review HTML, while review verdicts usually record only failures or reuse/retranslate.

They are not free-form chat commentary.

## Evidence

Structured support for a conclusion that can be checked again after recovery.

Evidence is bound to document, line, code, reference asset, and source/candidate hashes.

A vague reason that cannot be traced to source and translation is insufficient.

## Debt

A concrete item that must be settled before the workflow may complete.

It may be untranslated lines, terminology repair, true-positive warnings, uncovered scopes, or pending assets.

Here it is not a vague synonym for technical debt; it is computable unfinished work.

## Hash / Hash-bound / Hash-current

A hash is a content fingerprint; hash-bound means a conclusion is tied to specific input, and hash-current means it still matches the current files.

When input changes, only the relevant evidence and authority are invalidated instead of applying stale conclusions to new text.

A matching hash proves identity, not translation quality.

## Completion Gate

The programmatic gate that decides whether a workflow has actually satisfied its completion contract.

It checks assignment settlement, coverage, validation, terminology, and asset debt instead of trusting a model's completion claim.

An Agent final response does not mean the gate has passed.

## Session / JSONL

A Session is a continuable Agent conversation; JSONL stores its events as append-only JSON lines.

The Parent and every Child have separate Pi JSONL files for recovery, audit, and on-demand expansion.

The Parent card does not embed the full Child transcript.

## Persistence / Durable State

Writing critical state to disk so it survives process shutdown; durable means it is not memory-only.

Pi messages, Host state, staging, review evidence, and reuse audits all have persistence boundaries.

Console logs are not the sole durable evidence.

## Atomic / Transaction / Rollback

Atomic means related changes all succeed or leave no partial result; a Transaction is that commit boundary, and Rollback restores prior state after failure.

Terminology state, staging promotion, canonical files, and Host evidence use explicit transaction boundaries.

It is not partial writing followed by a later run guessing how to repair it.

## Queue

The set of assignments waiting to be claimed by Workers.

The shared queue opens by file stage, and ordinary work cannot pass an unsettled terminology priority wave.

It is not a private whole-file list assigned to each Worker in advance.

## Steer / Follow-up

A Steer is an update for the same Agent to consume soon after the current tool returns; a Follow-up waits until the current work finishes.

Both remain original AgentMessage objects and are consumed by the same Pi harness.

They do not create a separate YN message queue or waiting state machine.

## Context / Context Window

The messages and references visible to a model call; the Context Window is the model's token capacity.

The Host injects owned lines, short boundaries, direct asset matches, and current debt while keeping full state on disk.

A file existing in the project does not mean it was loaded into model context.

## Compaction

Compressing older conversation content into a usable summary when a long session approaches context limits.

YN uses Pi 0.99.1 native compaction entries, retainedTail and branch context projection rather than a separate summary file.

It does not delete the full JSONL history.

## Token / Cache

A Token is a unit of model text processing; Cache reuses repeated input at the provider or runtime layer.

YN saves tokens through bounded context, direct asset matches, persistent Workers, and failure-only review output.

A magic token cap must not block legitimate investigation.

## IPC / Bridge

IPC is inter-process communication; a Bridge exposes a controlled capability surface to a page.

The Renderer asks the Electron main process to save projects, read assets, start Agents, or write files through the bridge.

This does not give page scripts unrestricted disk access.

## Main Process / Renderer

The Electron Main Process owns system capabilities; a Renderer displays the React or HTML interface.

Agent runtime, files, and Host state live in main, while pages collect input and render structured output.

Renderer state cannot replace durable truth in main.

## Telemetry / Observability

Telemetry is runtime metrics and events; Observability is the ability to infer internal behavior from that evidence.

Key evidence includes provider error chains, assignments, staging, review debt, queue state, and completion reasons.

It does not mean flooding the UI with internal IDs and raw protocol text.
