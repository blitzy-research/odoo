# Change Archaeology & Segmented PR Review

> ⚠️ **Provenance**: this record covers the **agent-authored change set on branch `19.0`** of `Blitzy-Sandbox/blitzy-odoo`, reconstructed by commit authorship rather than by filename. The reconstructed range is the fixed interval `7bd7718bcd4c..c789a23602c24606458ee86783a318f7224d1dd8` — **13 commits, 6 files, 2,025 insertions, 0 deletions**. Both endpoints are named explicitly rather than left as `HEAD`, because the remediation commits that follow `c789a23602c2` change every figure below: this is an archaeology record of a fixed historical range, not a census of the branch as it now stands.
>
> ⚠️ **This document is the assessment half of "assess and remediate".** It records what was found and what each repair must achieve. It is not itself a specification of working software, and it makes no claim about accounting capability on this branch — see [the landing page](index.md) for what branch `19.0` actually contains.

## 1. Scope and Method

### 1.1 How the boundary was derived

No commit range and no file list were supplied, so scope was derived from authorship. Filtering `git log` by author isolates a contiguous block of Blitzy-authored commits at the tip of branch `19.0`, bounded below by the last upstream commit.

| Boundary | Commit | Author | Date | Subject |
|----------|--------|--------|------|---------|
| Last upstream commit (exclusive lower bound) | `7bd7718bcd4c5d232779e8eab0340169461af14e` | Gauthier Wala (gawa) &lt;gawa@odoo.com&gt; | 2025-11-18 | `[FIX] account: fix cash basis tax calculation for full payments` |
| Last commit of the reconstructed set (inclusive upper bound) | `c789a23602c24606458ee86783a318f7224d1dd8` | ajay-blitzy &lt;awadhwani@blitzy.com&gt; | 2026-05-15 | `chore: extend catalog tags (security, audit)` |

At `c789a23602c2` the repository carries **197,413 commits** and **45,666 tracked files**. Thirteen commits is therefore the entire authored surface — roughly one commit in fifteen thousand. Authorship-based discovery was essential: a path-based guess would have missed `catalog-info.yaml` and `mkdocs.yml` at the repository root while wrongly capturing upstream files under `doc/`.

Discovery was completed in full — the commit inventory, the per-commit replay, and the non-regression proof — **before** any finding was raised.

### 1.2 Segmentation

The change set is partitioned along the axis of **artifact family and consuming contract**, so that each segment is judged against exactly one authoritative specification, with a final segment for the seams between them.

| Segment | Artifacts | Authoritative contract |
|---------|-----------|------------------------|
| **SEG-1** Service-catalog metadata | `catalog-info.yaml` | Backstage Component descriptor schema, well-known field vocabularies, entity relations |
| **SEG-2** Docs toolchain configuration | `mkdocs.yml` | MkDocs configuration schema, Backstage TechDocs publishing requirements, plugin availability |
| **SEG-3** Documentation entry points | `doc/index.md`, `docs/index.md` | Navigation reachability; a single canonical landing page |
| **SEG-4** Generated documentation content | `project-guide.md`, `technical-specifications.md` | Factual accuracy against the repository; internal consistency |
| **SEG-5** Cross-segment integration | The seams between the above | Agreement between the TechDocs reference, the documentation root, navigation targets, on-disk files, and outbound catalog links |
| **SEG-6** Blast radius and hygiene | Packaging, lint reach, CI absence, build output | Positive proof of upstream non-regression |

### 1.3 Defect taxonomy and severity scale

Each segment is evaluated against a uniform eight-class taxonomy so that the review's completeness is independently checkable.

| Class | Meaning |
|-------|---------|
| **D1** | Contract violation — the artifact breaks its consuming tool's documented schema or semantics |
| **D2** | Broken reference — a path, URL, navigation target, or anchor does not resolve |
| **D3** | Factual inaccuracy — a statement is contradicted by the repository itself |
| **D4** | Internal inconsistency — two in-scope artifacts assert conflicting facts |
| **D5** | Dead or orphaned artifact — present in the tree but unreachable by any consumer |
| **D6** | Missing required or strongly recommended element — its omission degrades the consuming tool's output |
| **D7** | Unsubstantiated claim — a capability or attribute asserted with no supporting evidence |
| **D8** | Hygiene or convention deviation |

| Severity | Meaning |
|----------|---------|
| **Blocker** | The consuming tool fails, or produces a wrong or unresolvable result |
| **Major** | User-visible incorrectness, or a broken link |
| **Minor** | A missing recommended element, or an inconsistency between artifacts |
| **Nit** | Style and wording alone |

Every segment was worked through the same six steps: state the authoritative contract and its source; mechanically validate whatever is machine-checkable; walk every diff line against the taxonomy; assign severity; specify the remediation as a concrete minimal edit; and define the acceptance check that proves the defect is gone.

### 1.4 Methodological disclosure

The review was requested "using the Segmented PR Review rule definition". No such rule text was retrievable — the project's rules document is empty. The named artifact was therefore treated as a **named methodology** rather than as retrievable text, and the canonical interpretation is stated in full in subsections 1.2 and 1.3 so that the review can be checked against the standard it claims to follow. No rule was invented and presented as the requester's own. Because each finding is a property of the artifact it describes rather than of the grouping applied to it, supplying a different segmentation would reorganise this report without changing its conclusions.

## 2. Change Inventory

### 2.1 The six files

Every entry is an addition. There are no deletions and no modifications to any pre-existing file anywhere in the range.

| File | Status | Insertions | Deletions | Artifact family |
|------|--------|-----------:|----------:|-----------------|
| `catalog-info.yaml` | Added | 32 | 0 | Service-catalog metadata |
| `mkdocs.yml` | Added | 9 | 0 | Docs toolchain configuration |
| `doc/index.md` | Added | 5 | 0 | Documentation entry point |
| `docs/index.md` | Added | 3 | 0 | Documentation entry point |
| `doc/project-guide.md` | Added | 502 | 0 | Generated documentation content |
| `doc/technical-specifications.md` | Added | 1,474 | 0 | Generated documentation content |
| **Total** | **6 files, all adds** | **2,025** | **0** | **4 families** |

### 2.2 The thirteen commits

Twelve are authored by Michael Montanaro &lt;michael@blitzy.com&gt; on 2026-04-06; the thirteenth by ajay-blitzy &lt;awadhwani@blitzy.com&gt; on 2026-05-15.

| # | Commit | Subject | Effect |
|---|--------|---------|--------|
| 1 | `3322c9fb56fc` | Add Backstage catalog-info.yaml for developer portal integration | Adds the descriptor with tags `python`/`web-app`/`in-progress`, an `in-progress` status label, no TechDocs annotation, and system `blitzy-sandbox-projects` |
| 2 | `89bf914d81fe` | chore: update catalog tags — remove status, add work type | Removes both the `in-progress` tag and the status label; adds tag `refactor`. Net effect: the only in-progress signal is deleted while the declared lifecycle stays `production` |
| 3 | `4519ac913f3c` | chore: add techdocs-ref annotation for TechDocs support | Adds `backstage.io/techdocs-ref: dir:.`; also strips the trailing newline |
| 4 | `fd9479eeb937` | chore: add mkdocs.yml for TechDocs | Adds the site config with no `docs_dir`, so MkDocs defaults to `docs/` — which did not yet exist. **The build is broken at this commit.** |
| 5 | `d9f5402fba36` | chore: add docs/index.md for TechDocs | Creates `docs/index.md`. The build is fixed |
| 6 | `c42e4df275b6` | chore: set docs_dir to doc/ for TechDocs compatibility | Repoints the documentation root to `doc/`. **Breaks the build again** and strands `docs/index.md`; also strips the trailing newline |
| 7 | `f3679676519f` | chore: assign component to blitzy-python system for catalog graph | Changes `spec.system` to `blitzy-python` |
| 8 | `3be4d5ce4ae8` | docs: add index.md for TechDocs | Creates `doc/index.md` with text differing from `docs/index.md`. The build is fixed and `docs/index.md` is now permanently orphaned |
| 9 | `4e0e6df0811f` | docs: add mermaid2 plugin for diagram support | Adds the `mermaid2` plugin but no fence configuration, so the stated purpose is not achieved |
| 10 | `ce5781adcadf` | docs: add Project Guide from Blitzy | Adds the 502-line project guide |
| 11 | `e684fbe46c33` | docs: add Technical Specifications from Blitzy | Adds the 1,474-line specification |
| 12 | `b58d620c4fb2` | docs: add Blitzy documentation to nav | Adds two navigation entries; leaves the file without a trailing newline |
| 13 | `c789a23602c2` | chore: extend catalog tags (security, audit) | Adds two tags, but the diff is sixteen insertions against thirteen deletions because the whole file was round-tripped through a YAML serialiser — the description was folded, sequence indentation changed from four spaces to two, quoting style changed, and the trailing newline was restored |

Reviewing the net diff alone would have concealed commits 4 through 8 entirely, because their effects cancel in the aggregate while leaving permanent residue. Each commit was therefore replayed individually.

## 3. Chronological Narrative

### 3.1 The documentation-root flip-flop

Commits 4 through 8 form a flip-flop whose net result is two landing pages with different text, only one of which is reachable.

| Step | Commit | Configured root | On-disk index | Build state |
|------|--------|-----------------|---------------|-------------|
| 1 | `fd9479eeb937` | `docs/` (MkDocs default; `docs_dir` absent) | none | **Broken** — no documentation directory exists |
| 2 | `d9f5402fba36` | `docs/` | `docs/index.md` | Fixed |
| 3 | `c42e4df275b6` | `doc/` (explicit `docs_dir: doc`) | `docs/index.md` only | **Broken again** — and `docs/index.md` is now stranded |
| 4 | `3be4d5ce4ae8` | `doc/` | `doc/index.md` **and** `docs/index.md` | Fixed, with permanent residue |

Two consequences outlived the sequence. First, `docs/index.md` was left orphaned outside the build — present in the tree, reachable by no consumer, and carrying text that diverged from the page that replaced it. Second, and far more consequential, the configured site root was pointed at `doc/`, a directory that at the boundary commit contained **nothing but Odoo's contributor-agreement archive**.

### 3.2 Why pointing the root at `doc/` was a capture, not a preference

Ownership of the two similarly named directories was established with hard counts rather than by inspection.

- Pre-boundary history contains **3,623** commits touching `doc/`, reaching back to a 2006 trunk import. At the boundary commit that directory contained **only** the `cla` subtree.
- Pre-boundary history contains **zero** commits touching `docs/`, confirming it as greenfield created by this change set.
- Upstream was still adding to `doc/` after the boundary, so every future contributor-agreement signature would silently join the published developer portal.
- Historical Sphinx tooling under `doc/` is still referenced by the `_build/` ignore rule in `.gitignore` and by extension copyright attributions in `debian/copyright`.

The `doc/cla/` tree holds **994** tracked files — **715** individual agreements, **275** corporate agreements, and a small number of policy documents plus one Python helper.

### 3.3 The status-signal deletion

Commit 1 declared the component with an `in-progress` tag **and** an `in-progress` status label, alongside `spec.lifecycle: production`. Commit 2 removed both in-progress signals and left the `production` lifecycle in place. The descriptor thereafter asserted an established, maintained component while the repository's own project guide reported the work as substantially incomplete — an internal contradiction created by a commit whose subject describes it as a tag tidy-up.

### 3.4 The newline regressions and their accidental repair

Trailing newlines were stripped twice, by commits 3 and 6, and `mkdocs.yml` was left without one by commit 12. The descriptor's newline was restored by commit 13 — not deliberately, but as a side effect of round-tripping the whole file through a YAML serialiser. That round trip is also why commit 13 reports sixteen insertions against thirteen deletions for what its subject describes as adding two tags: it reformatted the description folding, the sequence indentation, and the quoting style at the same time.

### 3.5 The scoping error behind the factual inaccuracies

The project guide asserts delivery statistics — 47 commits, 81 files created, 27,707 lines added, a 43-file documentation set, and a 36-file financial-reports module — that bear no relation to a branch containing 13 commits and 6 files. Querying the repository's published metadata resolved the discrepancy rather than leaving it as apparent fabrication: the pull request the documents describe was merged into a branch named **`pdlc`**, not `19.0`, and carries **81 changed files and 27,905 additions**. The `tickets/` tree and the `addons/account_financial_report_ce/` module both exist there and are absent here, as are `account_reports`, `account_accountant`, `account_asset`, `account_budget`, and `account_followup`.

The two generated documents are therefore substantially **accurate about `pdlc` and wrong about the branch they are published on**. That single insight converts a cluster of apparently invented claims into one fixable scoping error, and it is why the remediation re-attributes the statistics rather than deleting them.

## 4. Non-Regression Proof

Because the checkout carries tens of thousands of tracked files, the absence of source-code change was **proven, not assumed**. Every check below is re-runnable.

| Check | Command shape | Result |
|-------|---------------|--------|
| Source-extension files in the agent-authored range | `git diff --name-only 7bd7718bcd4c..HEAD` filtered for `.py`, `.js`, `.xml`, `.csv`, `.scss`, `.po`, `.pot` | **0** |
| Upstream-path files in the same range | same list filtered for `addons/`, `odoo/`, `setup/`, `debian/`, `.github/` | **0** |
| Working tree state | `git status --porcelain` | clean |
| Contributor-agreement archive | `git ls-files doc/cla/` | **994**, none modified |
| Repository-wide sweep for the marker string | case-insensitive search for `blitzy` | matches only the in-scope files |
| Sweep for `techdocs` / `catalog-info` | case-insensitive search | the two configuration files, plus **one** upstream false positive: a `techdocs.broadcom.com` URL inside a pre-existing comment in `addons/base_vat/models/res_partner.py` |

The upstream surface is provably untouched: **43,419** tracked files under `addons/`, **1,195** under `odoo/`, **605** addon modules, and the packaging and Debian trees. Odoo runtime behaviour is unaffected, and no in-scope file enters the source distribution or the Debian package — `MANIFEST.in` ships only `requirements.txt`, `LICENSE`, and `README.md` plus a graft of `odoo`, and `debian/odoo.docs` lists `README.md` alone.

Lint reach over this change set is nil: `setup.cfg` excludes `doc` from flake8, no Python was added, `ruff.toml` declares itself generated and not to be modified, and the repository ships no Markdown or YAML linter configuration. No continuous-integration workflow exists — `.github/` holds only issue and pull-request templates — which is the direct reason none of the defects below was caught before merge.

## 5. Findings

Twenty-nine findings were raised: **4 Blocker, 8 Major, 12 Minor, 5 Nit**. None is in Odoo runtime code.

| Segment | Blocker | Major | Minor | Nit | Headline finding |
|---------|--------:|------:|------:|----:|------------------|
| SEG-1 catalog metadata | 0 | 2 | 3 | 2 | A documentation link returning 404, and a `production` lifecycle contradicted by the repository's own completion status |
| SEG-2 toolchain configuration | 2 | 1 | 2 | 1 | The site root captures 993 upstream legal documents, and diagram support does not function |
| SEG-3 entry points | 0 | 2 | 1 | 0 | An orphaned landing page and a divergent duplicate |
| SEG-4 generated content | 2 | 3 | 4 | 1 | Delivery statistics and file inventories describing a different branch |
| SEG-5 integration | 0 | 0 | 2 | 1 | Four competing descriptions of the same repository |
| SEG-6 blast radius | 0 | 0 | 0 | 0 | Clean — non-regression proven; packaging and lint reach unaffected |

### 5.1 SEG-1 — Service-catalog metadata

| ID | Sev. | Class | Finding | Remediation | Acceptance check |
|----|------|-------|---------|-------------|------------------|
| S1-01 | Major | D2 | The third link targets a `blitzy/documentation` tree path that exists neither locally nor on the published branch; an HTTP request returns **404**. The repository is public, so this is a genuine missing path, not an access restriction | Repoint the link at the real documentation root | Every outbound link in the descriptor returns HTTP 200 |
| S1-02 | Major | D7/D1 | `spec.lifecycle: production` asserts an established, maintained component, contradicted by the repository's own reported completion status; the in-progress signal that commit 1 supplied was deleted by commit 2 | Set lifecycle to the well-known value `experimental`; restore the in-progress status label | Lifecycle is a documented well-known value and agrees with the stated project status |
| S1-03 | Minor | D1 | `spec.type: website` misclassifies a deployable application server | Change to `service` | Type is a documented well-known value. **Flagged for owner confirmation** — a taxonomy judgement, reversible in one line |
| S1-04 | Minor | D7 | Tags are documented as classification with no special semantics, yet `refactor` encodes a work type and `security`/`audit` assert attributes no evidence in the repository supports | Retain genuine classification tags; move the work-type claim to a label; drop the unevidenced attribute tags | Every remaining tag is a classification term and satisfies the documented tag format. **Flagged for owner confirmation** |
| S1-05 | Minor | D1 | `spec.owner` and `spec.system` generate ownership and parent relations that resolve against portal entities this repository cannot create; registering as-is risks dangling relations | None possible in-repository | Recorded as a portal-side prerequisite in section 7 |
| S1-06 | Nit | D8 | Link icons are internally inconsistent — two links carry an icon, the first does not | Add the missing icon | All links carry an icon |
| S1-07 | Nit | D8 | Advisory YAML style: missing document-start marker, several over-length lines | None mandated | Advisory only — the repository ships no YAML linter configuration |

### 5.2 SEG-2 — Docs toolchain configuration

| ID | Sev. | Class | Finding | Remediation | Acceptance check |
|----|------|-------|---------|-------------|------------------|
| S2-01 | **Blocker** | D1 | `docs_dir: doc` points the site root at a directory that, when the setting was introduced, held only the contributor-agreement archive. A strict build publishes **997** HTML pages totalling **17 MB**, of which **993** are contributor-agreement documents reported as absent from the navigation configuration. **99.7% of the published developer portal is unrelated legal paperwork.** Critically, `mkdocs build --strict` **succeeds** here, because omitted-navigation files are reported at informational level — which is exactly why the capture went unnoticed | Repoint the documentation root to the Blitzy-owned `docs/` folder and relocate the three Markdown documents into it | Strict build succeeds **and** publishes exactly the intended pages **and** reports zero omitted-navigation notices |
| S2-02 | **Blocker** | D1 | The `mermaid2` plugin is declared but provably inert: the TechDocs bundle appends an extension pack that already claims the diagram fence and renders it as highlighted plain text, and relocates the fence configuration to a different key than the plugin inspects, so the plugin's custom loader never activates. All **7** diagram fences — **2** in the project guide, **5** in the specification — render as syntax-highlighted plain text with line numbers, emitting no diagram markup and no diagram runtime. Plugin ordering is irrelevant; both orderings produce identical output | Remove the inert plugin declaration and declare a superfences custom fence mapping the diagram fence name to a passthrough code format | Exact count of correctly emitted diagram blocks rises to 2 and 5 respectively, accounting for all seven fences |
| S2-03 | Major | D6 | No `site_description`, so the published site metadata contains the literal string `"None"` where the component's documentation description belongs | Supply the site description | Published metadata carries real text, not `"None"` |
| S2-04 | Minor | D6 | No `repo_url` and no `edit_uri`, so the theme's per-page edit action is enabled but dead; the publisher additionally warns that it is deriving these itself | Add both, with the edit reference matching the final documentation root | Per-page edit action resolves; the publisher's derivation warning is gone |
| S2-05 | Nit | D8 | File left without a trailing newline by commit 12 | Restore it | File ends with a newline |
| S2-06 | Minor | D6 | Introducing MkDocs without ignoring its default output directory leaves that directory reported as untracked; the existing ignore rules cover only the superseded Sphinx `_build/` path | Add a root-anchored ignore entry, matching the file's own convention for build output | `git status` is clean after a documentation build |

### 5.3 SEG-3 — Documentation entry points

| ID | Sev. | Class | Finding | Remediation | Acceptance check |
|----|------|-------|---------|-------------|------------------|
| S3-01 | Major | D5 | `docs/index.md` is orphaned — present in the tree, outside the configured root, reachable by no consumer | Promote it to the canonical landing page rather than delete it | The page is reachable and is the site's entry point |
| S3-02 | Major | D4 | Two landing pages assert different descriptions of the same repository | Reconcile into one page and delete the duplicate | Exactly one index page exists under the documentation root |
| S3-03 | Minor | D8 | The layout deviates from the vendor's documented canonical arrangement, which places the index page in a root-level `docs` folder beside the descriptor and site configuration | Converge on the documented layout | Layout matches the vendor default, so future tooling changes need no repository-specific compensation |

### 5.4 SEG-4 — Generated documentation content

| ID | Sev. | Class | Finding | Remediation | Acceptance check |
|----|------|-------|---------|-------------|------------------|
| S4-01 | **Blocker** | D3 | Delivery statistics describe a different branch entirely | Re-attribute the table to the pull request and branch it describes; correct the line-count figure against the authoritative record; add a row stating what this branch actually contains | Every statistic names the branch it applies to |
| S4-02 | **Blocker** | D3 | A completion claim and a described directory tree refer to a `tickets/` documentation set absent from this branch | Re-scope both to the branch that contains them | Each claim is scoped; absence on this branch is stated plainly |
| S4-03 | **Blocker** | D3 | A module file inventory and validation verdicts describe an addon absent from this branch | Re-scope the inventory and the validation claims | Scoped, with absence stated |
| S4-04 | Major | D3 | The concluding assessment draws a hand-off conclusion the branch cannot support | Withdraw or qualify it | No unsupported conclusion remains |
| S4-05 | Minor | D8 | Calendar-week scheduling appears in platform-authored planning content, which describes dependency ordering and never calendar time | Replace the calendar bands with dependency-ordered phases | No calendar scheduling remains |
| S4-06 | Minor | D3 | A source line citation points at the wrong line | Correct the citation | The citation resolves to the claimed content |
| S4-07 | Minor | D8 | Two top-level headings produce an ambiguous page title | Delete the redundant heading rather than demote the other — demotion would cascade a re-levelling of the entire numbered hierarchy across ~1,474 lines, disproportionate on a stable branch | Exactly one top-level heading |
| S4-08 | Minor | D4 | A version constraint is stated without the qualification that four other places in the same document already disclose | Qualify it consistently | The constraint agrees with its siblings |
| S4-09 | Major | D3 | A planning artifact is published under the label "Technical Specifications", so a portal visitor reads it as a description of what exists | Add a provenance and status banner marking it an unexecuted plan | A banner names the source branch and pull request and identifies absent artifacts |
| S4-10 | Nit | D8 | File not terminated with a newline | Terminate it | File ends with a newline |

### 5.5 SEG-5 — Cross-segment integration

| ID | Sev. | Class | Finding | Remediation | Acceptance check |
|----|------|-------|---------|-------------|------------------|
| S5-01 | Minor | D4 | The documentation root, the outbound catalog documentation link, and the edit reference are mutually constrained; fixing any one alone reintroduces a broken reference | Change all three as one atomic unit | All three agree, and the portal never observes an intermediate state with a broken link |
| S5-02 | Minor | D4 | **Four** different descriptions of the same repository are in circulation — the two landing pages, the published repository description, and the descriptor | Establish the descriptor description as the single source of truth and derive the landing page text and site description from it | One authoritative description; the other two are derived |
| S5-03 | Nit | D7 | A design-system claim asserts a capability with no supporting code | Reword as planned direction | The claim reads as direction, not delivered capability |

### 5.6 SEG-6 — Blast radius and hygiene

Five verification checks (S6-01 … S6-05) produced **no defects**. They are recorded as positive evidence rather than findings: source-extension count zero, upstream-path count zero, packaging unaffected, lint reach nil, and no CI pipeline to update. Their outputs are in section 4.

### 5.7 Findings deliberately not remediated

- **Commit messages.** The thirteen subjects use conventional-commit prefixes where upstream follows a bracketed-tag convention. Commit messages are immutable published history; the deviation is recorded, not rewritten.
- **`ruff.toml`.** Declares itself generated by nightly checks and marked do-not-modify. Excluded, and the principle generalised to any file bearing such a marker.
- **Advisory style output.** YAML and Markdown linter findings are reported for in-scope files only. No repository-wide style pass is performed and no linter configuration is introduced, because the repository deliberately ships none.
- **The `pdlc` branch.** Referenced as the factual source that explains the content errors. Nothing on it is imported, ported, or modified; the remediation corrects the *claims*, it does not build the capability.

## 6. Remediation Summary

Repair is **forward-fixing only**. The reconstructed commits are merged and published on a stable series, so there is no rebase, no amend, no revert-by-rewrite, and no force-push anywhere in the remediation. Every fix is an additive follow-up edit, and every fix is the minimal edit that closes its finding — stable-series discipline, as `CONTRIBUTING.md` requires.

| Target | Action | Findings closed |
|--------|--------|-----------------|
| `docs/project-guide.md` | Relocated from `doc/` and factually corrected | S4-01 … S4-05, S4-09, S4-10, S3-03 |
| `docs/technical-specifications.md` | Relocated from `doc/` and factually corrected | S4-06 … S4-09, S3-03 |
| `docs/index.md` | Promoted to the single canonical landing page | S3-01, S3-02, S5-02, S5-03 |
| `docs/change-archaeology-and-review.md` | Created — this document | The assessment deliverable itself |
| `mkdocs.yml` | Documentation root, site metadata, diagram fence, navigation | S2-01 … S2-05, S5-01 |
| `catalog-info.yaml` | Link, lifecycle, type, tags, labels, description, icon | S1-01 … S1-04, S1-06, S5-01 … S5-03 |
| `.gitignore` | Root-anchored output-directory entry | S2-06 |
| `doc/index.md`, `doc/project-guide.md`, `doc/technical-specifications.md` | Deleted — relocation completed | S2-01, S3-02, S3-03 |

The three deletions paired with three creations are a **relocation**, performed with move semantics so that authorship history follows the content. Returning `doc/` to a pure contributor-agreement archive also makes one pre-existing statement in the specification — that `doc/` holds CLA files only — accurate again, having been slightly wrong while the three Blitzy documents lived there.

### 6.1 Why the toolchain was repaired in configuration rather than in content

Two alternatives were considered and rejected on design merit, not on capability.

- **Excluding the `cla` subtree instead of relocating.** Rejected: `doc/` is live upstream territory with 3,623 pre-boundary commits and new agreements still arriving, so an exclusion list is a perpetual-maintenance trap requiring re-audit every time upstream adds a subdirectory, whereas a relocation cannot regress. Exclusion also masks a mis-designation of ownership, diverges from the vendor default, and would leave the orphaned landing page orphaned. Relocation closes three further findings at no extra cost.
- **Rewriting all seven diagrams into a natively-rendered notation.** Rejected and retained as the documented fallback: the configuration fix touches one file where the rewrite touches two content files, it *removes* a dependency rather than adding one, and it preserves the authors' chosen notation instead of discarding it.

### 6.2 Verification approach

Correctness is judged against the consuming tools' published contracts, never against syntactic validity alone. **Both blocking toolchain defects are in files that parse cleanly** and neither is visible in the diff — which is the entire reason every artifact is validated by *running* its consuming tool. Two properties of the build make exit status insufficient evidence on its own:

- Omitted-navigation files are reported at **informational** level, so a strict build exits successfully while publishing the wrong site. Acceptance therefore asserts an explicit published-page count and an explicit omitted-navigation count of zero.
- The publisher parses, sanitises, patches, and rewrites the site configuration before building, maintaining an **allowlist** of supported keys and deleting anything outside it with a warning. Every key introduced by the remediation was confirmed to sit inside that allowlist.

## 7. Open Risks and Portal-Side Prerequisites

Two prerequisites cannot be discharged by any file edit in this repository, and are recorded here rather than silently assumed.

| Prerequisite | Why it cannot be closed here | Consequence if unmet |
|--------------|------------------------------|----------------------|
| The `Group` referenced as owner and the `System` referenced as parent must exist in the portal | Portal entities are not defined by this repository | The catalog entry registers with unresolved relations (finding S1-05) |
| Client-side diagram rendering requires a portal addon | TechDocs renders content inside a shadow DOM, and the documented contributed addon set — expandable navigation, issue reporting, text sizing — contains **no** diagram addon | Diagram markup is emitted correctly but not rendered. Documented fallback: convert the seven diagrams to a notation the TechDocs bundle renders natively, which needs no client prerequisite |

Two remediation decisions are **flagged for owner confirmation** rather than asserted as settled: the component type change (S1-03), a reversible one-line taxonomy judgement; and the removal of two unevidenced attribute tags (S1-04), which may remove signal the owner intended even though nothing in the repository supports it.

One tolerated consequence is recorded for downstream tooling: the custom diagram fence requires a Python-style YAML tag that a plain safe-loader rejects while the generator's own loader accepts. Any tooling that reads the site configuration must therefore use the generator's loader rather than a generic one. That serialised form was tested against the generator and survives the portal's parse-and-rewrite cycle intact.

Finally, the structural risk that produced all twenty-nine findings remains open by design: **there is no CI pipeline.** `.github/` holds only issue and pull-request templates, so nothing mechanically gates a documentation build, a link check, or a descriptor schema check. Creating one was outside the scope of this work, but its absence is the single best explanation for how a developer portal came to publish 993 contributor-agreement documents without anyone noticing.
