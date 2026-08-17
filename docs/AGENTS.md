# AGENTS.md — The documentation standard

This file defines document structure, Markdown tiers, and writing rules for this repository. It follows the DeepSeek Harness documentation convention so decisions and docs remain portable between the projects.

## Document structure

These rules apply to human-facing documentation; [Agent Notes](../.agents/notes/README.md) remain outside their scope. A document's subject and tree position fix its scope: describe its own subject at appropriate detail and direct children only by purpose, responsibility, and high-level behavior; link to the owning descendant for lower-level detail.

Classify every in-scope document as a tutorial or reference. Tutorials follow an ordered path to an outcome and introduce only what each step needs. References define a lookup scope and current behavior without a teaching sequence. Separate substantial tutorial and reference content.

## The tier taxonomy: one home per fact

Each fact has one home: the tier whose job it is; elsewhere, link there.

| Tier | Job | Does NOT belong there |
|---|---|---|
| Root `AGENTS.md` | Standing orders: rules an agent needs in context in every session, one to three lines each, linking its home | Stories, worked examples, anything restated from a linked home |
| Subtree `AGENTS.md` (`.agents/notes/`, `docs/`) | Orders specific to that subtree | Repo-wide rules the root file already carries |
| [architecture.md](architecture.md) | Ordered map: composition, packages, seams, extension points; read before changing `packages/` | Per-package detail (→ package READMEs), decision rationale (→ Agent Notes) |
| [Agent Notes](../.agents/notes/README.md) | Active decision records: the why, what-was-given-up, and required verification; `implemented/` notes describe shipped reality in present tense | Migration plans, acceptance-task checklists, spec-speak ("should…") once the decision has shipped; archived notes are frozen history, never current authority |
| Package README | The per-package contract: config, semantics, limitations, extension points, and [Model Experience](README.md#model-experience) | JSDoc restatement, other packages' concerns |

Placement: rationale → Agent Notes; package contracts → READMEs; standing orders → root `AGENTS.md` with a rationale link.

## Writing rules

- **Document current state, not change history.** Avoid "previously/now/no longer", PRs, commits, and stack positions in durable prose; name the live mechanism. Put change stories in commits and Agent Notes.
- **Every non-trivial change includes at least one Agent Note in the same change.** Update the owning note or add one; only mechanical/local edits are exempt.
- **One physical line per paragraph**: use editor soft-wrap. Code blocks, tables, and list structure keep their formatting.
- **Comments and JSDoc state complete contracts, not reasoning transcripts.** Preserve behavior, failure, timing, ownership, modality, exceptions, consequences, and non-obvious orientation; delete narration, test walkthroughs, review analysis, and code restatement.
- **Write directly: name actors and facts.** Reserve `seam` for the defined capability. Name the exact check, type, API, operation, or behavior instead of metaphorical "gate", "vocabulary", or "surface".
- **State what a decision costs and buys** in the Agent Note's `## Consequences`; never pretend a trade-off is free.
