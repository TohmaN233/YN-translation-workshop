# Large Pi sessions

YN keeps native Pi v4 JSONL transactions, entry IDs, branches, messages,
compaction entries and usage records. Its disk-backed `Storage` implements Pi's
native query and mutation APIs. Historical entry payloads are read by byte offset
on demand; the decoded cache is limited to 8 MiB and 32 transactions. A single
record still has to fit in memory, but the complete file does not.

## Automatic upgrade

Opening an old v4 session before a new runtime owns it automatically upgrades
its storage. The background worker replaces repeated Host checkpoints with
hash-bound deltas, including positional array append/splice operations. Every
transaction and represented Host state is verified before publication. Message
text, entry identity, timestamps, branches and token/cost records are retained.
Native Pi model-context compaction remains independent of this disk operation.

Before replacing the JSONL, YN writes and fsyncs a gzip backup of the original
bytes, then verifies its decompressed SHA256. The backup is beside the session:

`<session>.jsonl.storage-v1.<original-hash-prefix>.backup.jsonl.gz`

`<session>.jsonl.storage-upgrade.json` records the original and compacted hashes,
sizes, backup and publication status. A failed publication reports an error.
If the JSONL was published but receipt publication failed, a `*.prepared.tmp`
receipt remains with verified recovery hashes. It does not claim publication.
An incomplete, uncommitted final transaction is retained in the backup and
excluded from the repaired live JSONL, with its byte count in the receipt.
Malformed complete transactions and incompatible Host evidence stop the upgrade.

The header's `ynSessionStorageVersion` prevents repeated upgrades. New sessions
start with this marker and write efficient schema 3 deltas. Schema 2 history
remains readable. v3 sessions keep the existing Pi migration and `.v3.backup`
contract; storage compression applies after conversion to v4.

For manual restoration, close YN first, decompress the backup to a separate
file, verify its SHA256 against `originalHash`, and replace the session JSONL.
Keep the backup. The derived index is rebuilt when the source changes.

## Loading, cancellation and concurrency

Large-file indexing, migration and cold Host replay run in worker threads. The
interface reports their stage and progress and allows Stop. A first upgrade or
cold replay of a very large session can take minutes; subsequent active turns
reuse the current owner. Cold replay still
verifies every owner, runtime version, baseline and reconstructed state hash.
It retains a bounded history window, not every historical full state. Warm
runtime owners continue to reuse their current Host state and persistence cursor.

The `.yn-index.json` sidecar stores only derived metadata and offsets. Its
checksum and the complete source SHA256 are checked before reuse; a stale or
corrupt index is rebuilt with an observable reason. Source identity is checked
around reads and writes. Appends are serialized and fsynced before the in-memory
index advances. An append failure disables writes until explicit reopen.

Inspecting a live child conversation uses the current native Session owner.
It does not create a competing writer or close the running Session. Changed
files outside the owner are reported as errors rather than silently accepted.

## Verification

Storage conformance is checked against Pi's native Storage and Session behavior.
Regression fixtures cover files larger than V8's single-string limit, legacy
Host deltas, branch history, cancellation, concurrent source edits, torn tails,
append/fsync failures and backup/receipt publication failures. Real-project
acceptance uses a copy of the affected session; no provider request is needed.
