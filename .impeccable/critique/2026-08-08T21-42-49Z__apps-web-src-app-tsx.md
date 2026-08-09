---
target: Application Studio AI, CV editing/recovery, and PDF fidelity
total_score: 24
p0_count: 0
p1_count: 3
timestamp: 2026-08-08T21-42-49Z
slug: apps-web-src-app-tsx
---
# Application Studio Adversarial Critique

## Scope

Audited Application Studio AI targeting, proposal review, editing, autosave, stale-tab recovery, snapshot history, pagination, and PDF rendering against `URGENT_SHARED_LAUNCH_PLAN.md` and `CV_FORMATTING_RULES.md`.

## Findings

### High: Whole-document AI requests can silently degrade to a partial edit

For a broad request, the application delegates target selection back to the model and then validates changes only against the model's own selected target set. A direct adversarial run asked to tailor the whole CV; a model response selecting one of two entries was accepted as one valid change, leaving the second entry untouched.

References: `packages/ai/src/index.ts:1594`, `packages/ai/src/index.ts:1595`, `packages/ai/src/index.ts:1600`, `packages/ai/src/index.ts:1601`.

### High: Starting a new AI request strands unresolved changes in older history

The composer allows another request while previous changes are undecided. Only the newest turn is editable; opening an older turn shows history but removes Accept/Reject controls. This breaks the promise that every proposal remains reviewable and can leave unresolved proposals in persisted history.

References: `apps/web/src/App.tsx:1553`, `apps/web/src/App.tsx:1555`, `apps/web/src/App.tsx:1594`, `apps/web/src/App.tsx:1606`, `apps/web/src/App.tsx:2081`, `apps/web/src/App.tsx:2082`.

### High: The PDF visual-diff release gate can pass materially wrong pages

Both browser fidelity tests accept any page with less than 12% total changed pixels. A synthetic 700x990 page with an entirely wrong 700x100 band produced a 10.10% mismatch and passed the current gate. Because the metric is whole-page and whitespace-dominated, missing headers or a substantial local formatting defect can pass.

References: `apps/web/e2e/application-studio.spec.ts:619`, `apps/web/e2e/application-studio.spec.ts:621`, `apps/web/e2e/application-studio.spec.ts:689`, `apps/web/e2e/application-studio.spec.ts:691`.

### Medium: Page-two headings are always labelled continued

The PDF renderer labels the first group heading on every later page as continued, even when that group starts for the first time on that page.

References: `apps/api/src/cv-pdf.ts:108`, `apps/api/src/cv-pdf.ts:112`, `apps/api/src/cv-pdf.ts:119`.

### Medium: Snapshot history is read-only and cannot restore a checkpoint

Named immutable snapshots can be previewed or downloaded, but no restore-as-draft path exists. This limits history as a recovery mechanism.

References: `apps/web/src/App.tsx:1983`, `apps/web/src/App.tsx:2084`.

### Medium: Keyboard emphasis lacks a selection-level browser regression

The implementation records inline marks and Command+B worked in the live browser for a whole selected field. The automated browser suite does not select a word, apply Command+B/Command+I, reopen, export, and verify the exact marked range in the PDF. The PDF unit test verifies emphasis in generated HTML, not the rendered PDF's glyph styling.

References: `apps/web/src/App.tsx:1138`, `apps/web/src/App.tsx:1142`, `apps/api/src/cv-pdf.test.ts:22`, `apps/api/src/cv-pdf.test.ts:30`.

## Passing Evidence

- 51 AI package tests passed.
- 52 focused API/AI/PDF tests passed.
- 10 focused real-browser Application Studio tests passed, including rejection preservation, undo/redo, stale recovery, reopening, one-page visual comparison, two-page export, preflight, and submitted-version linking.
- Direct target, multi-target repair, exclusions, and unrelated-change rejection have explicit regression coverage.
- No Critical issue was confirmed.

## Release Position

Application Studio is not ready to be called fully dependable while the three High findings remain. The strongest current areas are narrow targeting, optimistic-concurrency conflict detection, immutable export records, link verification, and bounded A4 rendering.
