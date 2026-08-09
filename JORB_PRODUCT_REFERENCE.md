# Jorb Product Reference and CareerOS Adoption Plan

## Purpose

[Jorb](https://www.jorb.ai/) connects five workflows that CareerOS also needs: broad job discovery, firm research, saved-job tracking, alerts, and job-specific document tailoring. This document records the publicly visible product behavior and translates it into the existing local-first CareerOS architecture.

CareerOS should adopt the workflow, density, and continuity between modules. It should not copy Jorb's branding, proprietary data, code, account model, credit system, or exact interface.

## Public Product Shape

Jorb presents three primary promises:

1. **Search:** filter a large live role index down to a specific shortlist.
2. **Track:** save roles and maintain progress from not started through offer or rejection.
3. **Tailor:** edit a job-specific CV or cover letter beside the source job description with AI assistance.

Its public site also exposes live job alerts, mainstream and boutique firm directories, saved firms, spreadsheet upload/download, and direct employer application links. Public job and firm pages state that postings refresh from primary careers pages and retain a last-refreshed or last-verified date.

## Information Architecture

The visible sidebar is grouped by task rather than by database entity:

| Jorb group | Visible destinations | CareerOS adoption |
| --- | --- | --- |
| Mainstream firms | Search Jobs, Firms Tracker, Saved Jobs | Discover, Companies, Opportunities/Applications |
| Boutique firms | Search Firms, Saved Firms | Companies with saved/target status and company-stage/type filters |
| Jorb tools | Live Job Alerts, Writing Toolkit | Alerts and Application Studio |
| Utilities | Help, display, settings, sign out, credit balance | System status, settings, backup, AI provider status; no credits needed locally |

CareerOS navigation should remain quieter and use these product areas:

- **Discover:** live postings, firms, saved searches, alerts.
- **Pipeline:** opportunities, applications, tasks, contacts.
- **Studio:** profile evidence, documents, application-specific editing.
- **Direction:** career tracks, skills, projects, learning, goals, map, analytics.
- **System:** status, sources, backups, settings.

## Search Jobs Table

### Layout

Jorb uses a dense, laptop-first table with a sticky-feeling filter band above it. The visible columns are:

- Save/bookmark and direct-link actions.
- Company.
- Job title.
- Location.
- Industry.
- Category.
- Level.
- Posted date.
- Personal progress.

The filter band uses large filter buttons for location, level, category, posted date, and all/saved jobs. Secondary commands include save all, restore filters, and clear filters. The footer shows result count, current result range, and pagination.

### Interaction

- Company and job-title columns support focused searching.
- Multiple filter selections show their counts directly in the filter buttons.
- Rows expose the direct source link without hiding it behind the detail view.
- A bookmark saves the role.
- Progress is editable inline with semantically coloured states.
- Pagination preserves the current query.

### CareerOS Translation

The Discover table should use configurable columns rather than permanently displaying every field. The recommended default is:

`Save | Company | Role | Location | Track | Programme | Posted | Detected | Match | Apply`

Personal application status should appear only after a discovered role is saved into the tracker. Changing a status must continue to append an immutable `ApplicationEvent`, even when the control is inline.

## Saved Jobs and Application Tracker

### Layout

The saved-job view begins with summary counters for Total, Not Started, Applied, Video Interview, Online Test, Interview, and Offer. It then provides location, stage, and sort controls plus operational commands:

- Edit columns.
- Add manually.
- Upload own tracker.
- Download as Excel.
- Chrome extension entry point.

Its table includes selection checkboxes, company, job title, location, application stage, applied date, saved date, and actions for notes/messages, source link, and removal.

### CareerOS Translation

- Add a compact status summary band above Applications, driven from immutable events.
- Add configurable tracker columns and saved view presets.
- Complete Excel/CSV mapping with preview, validation, duplicate handling, and round-trip testing.
- Add safe multi-select commands for tag, priority, archive, task creation, and export. Never bulk-delete by default.
- Keep manual entry and direct source access close to the table.
- Treat removal as archive/soft-delete with recovery.
- Add browser-extension capture only after the API import contract is stable.

## Job Detail Experience

Jorb's public job pages combine the complete employer description with structured application context. Publicly visible examples include location, deadline, application process, schedule, job number, salary, requirements, direct careers link, last refresh, and a call to tailor the application.

CareerOS should make a selected role's detail workspace the bridge between discovery, tracking, research, and writing:

| Detail section | CareerOS content |
| --- | --- |
| Header | Company, role, location, availability, posted/detected/checked dates, Save/Apply/Start Application. |
| At a glance | Programme, role family, seniority, work mode, employment type, deadline, visa, salary, requisition. |
| Description | Clean readable source text with employer-listed sections preserved. |
| Requirements | Required and preferred requirements separated, each linked to source evidence. |
| Application process | Assessments, interview stages, rolling deadline notes, and tasks. |
| Company | Reusable firm snapshot, stage/type, hiring programmes, open roles, contacts, and research dates. |
| Match | Profile evidence that supports the role plus honest gaps. |
| Materials | Exact CV, cover letter, portfolio, and answers attached to the application. |
| Timeline | Immutable events, communications, follow-ups, and outcomes. |
| Provenance | Source links, captures, last checked date, confidence, and user-confirmed fields. |

## Firm Directory and Intelligence

Jorb separates mainstream firms from boutique firms and lets users search or save both. Public firm pages connect firm context, current roles, related firms, recruiting details, sponsorship/programme information, and last verification.

CareerOS already has `Company`; it should extend that model instead of creating a parallel firm object:

- Company aliases and canonical domain.
- Company type/stage: bank, consultancy, big tech, startup, boutique, fund, design/engineering, other.
- Sectors, divisions, locations, and target priority.
- Careers page and ATS source links.
- Hiring programmes and typical recruiting windows.
- Visa/sponsorship, interview process, salary research, and recruiter/contact evidence.
- Saved/target company state.
- Last researched and last careers-source check timestamps.
- Related firms and comparable employers.
- Current discovered postings and historical applications.

Add `CompanySource`, `CompanyObservation`, and `HiringProgramme` only when the first firm-directory slice is implemented. Continue using field-level evidence and review for researched claims.

## Application Studio

### Observed Layout

Jorb's tailoring workspace is a large three-pane editor:

1. **Left:** the job description and structured application context.
2. **Centre:** the active resume or cover letter, page-like preview, formatting toolbar, change highlighting, and PDF download.
3. **Right:** an AI agent log explaining changes and accepting further instructions.

The header identifies the target job and active material. Resume and cover-letter tabs share the workspace. The document can be locked while the agent edits, individual changes are highlighted, and a control hides or reveals changes.

### CareerOS Translation

Use a dedicated full-screen route, not a modal, so the workspace remains stable on laptops and can collapse predictably on mobile.

| Pane | Responsibility |
| --- | --- |
| Job context | Description, requirements, company context, match evidence, gaps, and source excerpts. |
| Document canvas | Structured one-page CV or cover-letter editor with stable pagination and print preview. |
| Proposal panel | Evidence-backed suggestions, rationale, source evidence, accept/reject controls, and user instructions. |

Required behavior:

- Switch among CV, cover letter, portfolio note, and application answers.
- Select a base document/version before tailoring.
- Keep strict one-page CV constraints and show overflow before export.
- Propose changes as a structured change set, never mutate the accepted document silently.
- Accept or reject each change or a reviewed batch.
- Highlight inserted, removed, reordered, and rewritten content.
- Preserve original text, parent version, model/provider, prompt purpose, evidence IDs, and timestamps.
- Allow ordinary manual editing without invoking AI.
- Lock only the affected document version during an active generation request.
- Save accepted output as a new `DocumentVersion` and link it through `ApplicationMaterial`.
- Export deterministic PDF first and DOCX through a later adapter.

The PDF remains an output, not the source of truth. The centre pane edits structured CareerOS content and renders it into a controlled layout.

## Data and Service Additions

Use the committed entities wherever possible:

- `Company`, `JobPosting`, `Application`, `ApplicationEvent`, `ProfileEvidence`, `Document`, `DocumentVersion`, and `ApplicationMaterial` remain authoritative.
- `DiscoveredPosting` remains separate until saved.
- Add `SavedView` for filters, sorting, visible columns, and page size.
- Add `DocumentChangeProposal` for field/section target, operation, old value, proposed value, rationale, evidence IDs, confidence, and decision.
- Add `AgentRun` or extend the AI run ledger with purpose, target document/version, state, timing, token/cost metadata when available, and error.
- Add `CompanySource`, `CompanyObservation`, and `HiringProgramme` for firm intelligence.
- A future browser extension calls the same authenticated local `CareerOSClient` import endpoint and never writes SQLite directly.

## What CareerOS Should Improve

- Keep discovery records separate from saved opportunities instead of mixing search results with application status.
- Derive status counters from immutable events rather than direct status mutation.
- Keep employer posting time, CareerOS detection time, and local record update time distinct.
- Show provenance and confidence for job, company, salary, contact, and AI-generated fields.
- Use a dedicated editor route instead of a modal for serious document work.
- Preserve local ownership and complete backup/export rather than relying on a hosted account.
- Keep AI optional: search, tracking, editing, versioning, and export must still function without a provider.

## Integrated Delivery Sequence

### Jorb Slice 0: Tracker Ergonomics

- Add saved views and configurable columns.
- Complete spreadsheet upload mapping and useful Excel/CSV export.
- Add application summary counters and safe bulk actions.
- Add richer role details with posted/detected/checked dates and direct application access.

### Jorb Slice 1: Firm Intelligence

- Extend Company with target/saved state, type/stage, aliases, domains, careers sources, and research timestamps.
- Add company directory and company detail views.
- Link discovered postings, applications, contacts, salary evidence, and hiring programmes.
- Add public-research proposals with citations and review.

### Jorb Slice 2: Match Workspace

- Build the job-to-profile match endpoint, evidence map, requirements matrix, and gap list.
- Add a `Prepare application` command from a saved posting/application.
- Establish the dedicated Application Studio route and responsive pane behavior.

### Jorb Slice 3: Document Change Sets

- Add `DocumentChangeProposal` schemas and persistence.
- Generate concise CV and cover-letter proposals against selected profile evidence.
- Add side-by-side/inline diffs, per-change approval, undo, and manual edits.
- Save accepted changes as immutable document versions.

### Jorb Slice 4: Controlled Documents

- Add stable one-page CV templates and overflow checks.
- Add cover-letter and application-answer templates.
- Export PDF, then DOCX.
- Attach exact submitted materials to applications.

### Jorb Slice 5: Alerts and Browser Capture

- Turn saved discovery filters into local alert rules.
- Add in-app alerts, then Tauri desktop notifications.
- Build a small browser extension that captures the current public job page into the existing review pipeline.
- Do not add auto-submit or hidden application automation.

## Acceptance Criteria

- Discovery, saved opportunities, applications, and documents remain distinct but connected.
- Table columns, filters, sorting, and presets survive restart and backup/restore.
- Inline status changes append application events.
- A firm can be saved before it has an open posting.
- Job details show source freshness and field evidence.
- Application Studio keeps job context, document, and proposals visible together.
- Every AI change can be accepted, rejected, explained, and traced to factual evidence.
- Accepted documents are versioned and attached to the exact application.
- PDF output remains stable and one-page constraints are visible before export.
- All core tracking and manual document editing work without AI.
