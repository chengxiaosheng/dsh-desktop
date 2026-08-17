# Agent Notes

One kind of design doc lives here. An **Agent Note** records a decision or proposal that affects this codebase — the *why* and *what we gave up*, the parts code and docs can't carry. This file defines where Agent Notes live, when to write one, and [the in-file format](#the-file-format). It follows the DeepSeek Harness convention so decisions remain portable between the projects.

## Layout and naming

Every Agent Note has two axes, both encoded in its **path** — `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- **Lifecycle** (the top-level folder) is the Agent Note's status, and an Agent Note moves between folders as that status changes:
  - **`proposed/`** — proposals reviewed before implementation; not yet built (or only partly).
  - **`implemented/`** — the decision shipped. The file records what was decided and what was rejected, and is **kept current with what actually shipped**: when the code later moves a file, renames a package, or changes a key/default, the Agent Note is updated in the same change to match (facts only — paths, names, structure — not the decision itself).
  - **`rejected/`** — the proposal was considered and declined. Keep it only while its rationale prevents a tempting, meaningful mistake; otherwise delete it.
- **Class** (the nested folder) is the *kind* of decision — see [Classification](#classification) below.

The date in the filename is when the topic was **first proposed**. Cross-references between Agent Notes use relative markdown links (`[topic](../../implemented/architecture/2026-…-….md)`) — never bare prose or numbers — so they are mechanically checkable and survive moves between folders.

## Classification

Each Agent Note belongs to one path-encoded class:

| Class | What it covers |
|---|---|
| `feature` | A new user- or model-facing capability. |
| `bug-fix` | Corrects a defect or closes a gap a postmortem surfaced. |
| `simplification` | Removes code, behavior, or surface area without adding a capability. |
| `architecture` | A structural decision about the **shipped source** — how packages relate, what the runtime vocabulary is. |
| `process` | Tooling, policy, or workflow **around** the code — gates, the package manager, vendoring — not runtime behavior. |
| `testing` | Test infrastructure and strategy. |

The `architecture` / `process` line: **architecture** is about the source we ship; **process** is the surrounding tooling and workflow.

## Archiving and deletion

Archive an implemented Agent Note when the shipped decision is complete and its rationale is unlikely to guide future work. Keep it active when its alternatives, ownership boundary, negative guarantee, durable or wire semantics, security rule, or reintroduction condition remains useful. Never archive a proposed note: reject an obsolete proposal. Keep a rejected note only while it prevents a plausible mistake.

The archive is path-encoded as `archived/{class}/yyyy-mm-dd-topic-title.md`; only implemented notes can enter it. An archival change moves the note, retains `Status: implemented`, and inserts the same `Archived: YYYY-MM-DD` line immediately below that status. These are the only permitted content changes during archival.

Once sealed, every archived triplet is permanently frozen. Do not edit, translate, reformat, update, move, or delete it, and do not treat it as authority for current behavior.

## When to write one

Every non-trivial change MUST add or update at least one Agent Note in the same change. A change is non-trivial when it alters behavior, architecture, a contract shared across files or packages, process or tooling, testing strategy, an on-disk, wire, or configuration format, or another decision a maintainer may reasonably revisit. A proposal for substantial future work starts in `proposed/`; a decision already made starts in `implemented/`. Pick the class folder that matches the decision (see [Classification](#classification)).

Updating the Agent Note that already owns the decision satisfies the rule; do not create a duplicate. Only a purely mechanical or local edit with no change to behavior, contracts, structure, process, or rationale is exempt. An Agent Note is never edited into a *different decision*: supersede it with a new one, and keep both notes cross-linked.

An implemented Agent Note that is fully superseded may be consolidated into the current owning note and deleted. Before deletion, the owner must preserve every unique rationale, alternative, consequence, required verification, and named coverage gap; repair every inbound link. Partial supersession does not qualify: keep both notes cross-linked and update every fact that remains current.

## The file format

Every active Agent Note follows the one in-file format below.

### The header block

The first three lines of every Agent Note are exactly:

```markdown
# Agent Note: <title>

Status: <status>
```

followed by a blank line. The `Status:` value is one of three forms, and must agree with the lifecycle folder the file sits in:

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <why, in one line>`

The status carries no dates and no parentheticals: the filename holds the first-proposed date, git holds everything else.

### The body skeleton

Every Agent Note opens its body with `## Problem` — the motivation, written to stand without the solution. What follows depends on the lifecycle; recurring sections use these canonical names and nothing else, while genuinely bespoke technical sections (package topology, wire contracts, schemas) remain free-form between the required ones.

#### `proposed/`

```markdown
## Problem
## Proposal
…bespoke sections…
## Alternatives considered
## Acceptance criteria
## Risks
```

`## Proposal` is the intended change and may legitimately speak in the future tense. `## Acceptance criteria` says what observable state means done. `## Risks` covers both what could go wrong and what the change knowingly gives up.

#### `implemented/`

```markdown
## Problem
## Decision
…bespoke sections…
## Alternatives considered
## Consequences
```

`## Decision` describes shipped reality in the present tense, and the whole file is kept current with it. `## Consequences` records what the trade-off cost **and** bought. Proposal-era headings are spec-speak here and are rejected: `## Proposal`, `## Plan`, `## Migration plan`, and `## Acceptance criteria` may not appear in an implemented Agent Note. A `## Testing`, `## Deferred`, or `## Related` section is fine where it states present-tense fact.

#### `rejected/`

A rejected Agent Note is the proposal, frozen: it keeps whatever proposal-time sections it had, and the verdict lives on the `Status:` line.

### Alternatives considered — mandatory

Every Agent Note (in every lifecycle) contains `## Alternatives considered` — the options considered and why each was rejected — so the decision survives the author. A note with no alternatives is an opinion, not a record.
