# blitzy-odoo

Odoo 19.0 fork pursuing enterprise accounting parity — financial reporting engine and bank reconciliation — with an IBM Carbon Design System UI redesign as planned direction.

Blitzy fork of Odoo. Open Source Apps To Grow Your Business. This is the documentation home for **blitzy-odoo**.

## What this branch actually contains

> ⚠️ **The accounting capabilities described in the Project Guide and the Technical Specifications are not implemented on this branch.** Both documents are planning artifacts that record intended work; read them as creation targets, never as an inventory of working software.

**Present**: the upstream Odoo codebase at branch `19.0`, a released stable series carrying 605 addons, including the base `account` module inherited from upstream. Line 15 of `odoo/release.py` declares the version tuple:

```
version_info = (19, 0, 0, FINAL, 0, '')
```

No source file in that tree was modified by the change set this documentation belongs to.

**Absent**, each verified by direct filesystem check of this checkout: the `tickets/` documentation tree, the `addons/account_financial_report_ce/` module, and the accounting addons `account_reports`, `account_accountant`, `account_asset`, `account_budget`, and `account_followup`. The financial reporting engine, the bank reconciliation feature, and the IBM Carbon Design System UI redesign are therefore planned direction here, not delivered capability.

## Documentation

- **[Project Guide](project-guide.md)** — scope, deliverables and validation results for the enterprise accounting epic, each claim scoped to the branch it actually describes.
- **[Technical Specifications](technical-specifications.md)** — the full requirement, epic and user-story specification, published as an unexecuted plan.
- **[Change Archaeology & Review](change-archaeology-and-review.md)** — provenance of the agent-authored commits on this branch and the segmented review findings raised against them.
