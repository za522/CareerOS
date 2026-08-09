# CareerOS Build Plan

This is the active product plan for turning CareerOS from a job tracker into an application operating system.

## Urgent Launch Priority

`URGENT_SHARED_LAUNCH_PLAN.md` is the controlling delivery plan for the August 2026 recruiting launch. It promotes hosted access, Google authentication, invited collaboration, finance-focused discovery, shared tracking, and collaborative CV preparation to immediate requirements. When its order differs from the broader roadmap below, the urgent launch plan takes priority.

## Product Direction

CareerOS should help with two linked jobs:

| Layer | Purpose | Current priority |
| --- | --- | --- |
| Opportunity tracker | Capture roles, clean them into structured rows, track applications, deadlines, and outcomes. | Keep polishing |
| Posting freshness | Separate employer posting age from CareerOS record activity, then periodically verify whether saved public postings remain live. | Manual public-source check working; scheduled checks planned |
| Live opportunity discovery | Monitor approved public employer and ATS sources, surface newly detected roles, and save selected results into the personal tracker. | Planned; see `LIVE_OPPORTUNITY_FEED_PLAN.md` |
| Firm intelligence | Search mainstream and boutique firms, retain hiring-programme research, and connect firms to live roles, contacts, salaries, and applications. | Planned; see `JORB_PRODUCT_REFERENCE.md` |
| Reliability controls | Show backend/AI state and retain useful in-app error details. | Working foundation |
| AI run analytics | Persist provider, model, timing, outcome, and evidence counts for each import without duplicating source content. | Working foundation |
| Profile and CV studio | Store the user's factual profile, projects, skills, CV bullets, and reusable evidence. | Working foundation |
| Job detail workspace | Bring role metadata, criteria, process, tasks, compensation, source freshness, evidence, and application activity into one working view. | Working |
| Application adaptation | Select a job and base CV, then generate a concise job-specific CV with factual, reviewable changes. Matching is an internal grounding step, not a separate user-facing destination. | Working first release |
| Application studio | Keep the job description, editable job-specific document, evidence-backed AI proposals, and change history visible in one focused three-pane workspace. | Working first release |
| Research assistants | Find likely recruiter/contact leads, salary ranges, company context, hiring process, visa notes, and similar roles. | Salary research working; contact and company research remain |
| Planning system | Turn gaps into LeetCode, NeetCode, Quant Green Book, Quant Red Book, project, and founder milestones. | Later |
| Career map and analytics | Visualise tracks, roles, skills, projects, applications, outcomes, deadlines, response times, and source effectiveness. | Later |

## Immediate Build Order

| Step | Feature | User-facing outcome |
| --- | --- | --- |
| 1 | Career Studio foundation | Working role-first workspace for job-specific drafts and versions, with imported source CVs and factual profile evidence as supporting libraries. |
| 2 | CV section editor | Edit reusable CV evidence in short sections with a one-page preview. |
| 3 | Job detail workspace | Complete: structured role details, company context, requirements, process, salary, freshness, source evidence, notes, tasks, and application actions are together. |
| 4 | Job-specific CV adaptation | Working for imported CVs: choose a saved job and base CV, then generate a tailored draft grounded in profile evidence. Portfolio-wide grounding can be deepened next. |
| 5 | Application Studio | Working first release: job context, active editable CV, evidence matches and gaps, and AI change review share one three-pane workspace. |
| 6 | Change review | Working first release: review rewrites, additions, removals, and reordering; accept, reject, undo, edit manually, and monitor one-page length. |
| 7 | Application materials and versions | CV versions are immutable, job-specific, and linked to an existing application with their accepted/rejected proposal history. Cover letters, portfolio notes, and answers remain. |
| 8 | PDF/DOCX export | Browser print-to-PDF is available. Controlled templates and generated PDF/DOCX files remain the next document milestone. |
| 9 | Contact Research Assistant | Find likely recruiters, employees, referrals, alumni, and interviewers from public or user-provided sources, with citations and confidence. |
| 10 | Salary Research Assistant | Initial slice complete: public web research produces a reviewable base and total-compensation proposal with confidence, timing, warnings, and persisted source evidence. Dedicated direct-data providers and cross-currency normalisation can be added later. |

## Delivery Roadmap

This is the committed order after the current tracker and Career Studio foundations. It is the tangible source of truth for the sequence previously discussed in chat.

| Phase | Work | Completion signal |
| --- | --- | --- |
| A. Tracker reliability | Employer-posted age, CareerOS updates, `lastCheckedAt`, and manual public-source recheck are working. Posting-availability history and scheduled checks remain. | Stale or removed postings are visible without overwriting saved job evidence. |
| A2. Live opportunity discovery | Add source adapters, scheduled discovery runs, a filtered live feed, direct employer links, save-to-tracker review, and alert rules. | CareerOS finds relevant new public roles without filling the personal tracker with unreviewed records. |
| A3. Firm directory and intelligence | Add mainstream/boutique firm views, saved firms, hiring programmes, sector/category research, open roles, and last-verified evidence. | Companies become reusable research objects rather than repeated text attached to jobs. |
| A4. Tracker ergonomics and migration | Add configurable columns, saved filter presets, bulk actions, reliable Excel/CSV upload mapping, and useful spreadsheet export. | The tracker is faster than the original spreadsheet without losing portability. |
| B. Profile matching | First release working inside Application Studio: each assessed requirement can show supporting evidence and honest gaps. Deepen cross-document portfolio and project matching next. | Each requirement shows matching evidence and honest gaps. |
| C. Application Studio and concise adaptation | First release working for CVs, including the three-pane workspace, evidence-backed proposals, manual editing, review controls, and length warning. | Every proposed change is understandable, reversible, and grounded in profile evidence. |
| D. Drafts and versioning | Working for CVs: immutable versions retain parent, source model, final structured content, proposal changes, evidence IDs, and accepted/rejected decisions. Extend the same contract to cover letters, portfolio notes, and application answers. | Every version has a source, timestamp, visible diff, and parent version. |
| E. Application materials | Working for CVs when an application exists: the saved version is linked as the exact application material. Extend to the other material types and submitted-state controls. | CareerOS can show precisely what was submitted for every role. |
| F. Controlled export | Render approved structured content into stable templates and export PDF first, then DOCX. | The one-page CV remains predictable after export. |
| G. Contact and salary research | Salary research is working. Add reviewable, cited public research for likely recruiters, then deepen salary providers and regional normalisation. | Suggestions retain source, date, confidence, and user approval. |
| H. Upskilling planning | Connect role gaps to skills, LeetCode, NeetCode, Quant Green/Red Books, projects, dependencies, effort, and goals. | Career tracks produce realistic, stretch, and exploratory plans. |
| I. Career map and analytics | Add the derived node map, application funnel, source effectiveness, response times, deadlines, and preparation views. | Tracker data produces useful visual decisions without becoming a second source of truth. |
| J. Desktop packaging | Package the shared React app and Fastify API through the validated Tauri sidecar route, with local files, notifications, credentials, and backups. The web MVP already uses macOS Keychain for the OpenAI key. | CareerOS installs and restarts as a desktop app without data loss. |

### Posting Freshness Rules

- `postingDate` is employer evidence and answers when the role was originally posted.
- `updatedAt` is CareerOS metadata and answers when the local record last changed.
- `lastCheckedAt` records when CareerOS last successfully verified the source URL.
- A future posting check records `active`, `removed`, `expired`, `blocked`, or `unknown` without deleting the saved posting.
- Automated checks use safe public requests, respect blocked/authenticated sources, and present uncertain changes for review.

## Related Plans

- `URGENT_SHARED_LAUNCH_PLAN.md`: controlling plan for the immediate shared, hosted application workflow.
- `LIVE_OPPORTUNITY_FEED_PLAN.md`: architecture and delivery plan for a personal live postings feed inspired by the useful behavior of public internship trackers.
- `JORB_PRODUCT_REFERENCE.md`: detailed product reference and CareerOS adoption plan for Jorb-style search, tracking, firm intelligence, alerts, and application-document editing.

## CV System Principles

The PDF should not be the source of truth. CareerOS should store structured CV content first, then render a one-page CV from that content.

| Decision | Reason |
| --- | --- |
| Store CV as structured sections | Easier to tailor, version, diff, search, and reuse. |
| Render to PDF after editing | Keeps formatting controlled rather than fighting direct PDF text editing. |
| Keep bullet suggestions short | Prevents verbose generated text from breaking one-page formatting. |
| Consolidate duplicate records | One degree, job, project, award, or achievement appears once even when several imported sections describe it. |
| Use fixed A4 sheets | The editor shows honest page boundaries and creates page two instead of stretching one fictional page. |
| Compact skills and interests | These render as concise bold label-and-colon rows at the bottom rather than oversized sections. |
| Require evidence for generated claims | The app must not invent skills, employers, education, projects, or achievements. |
| Link versions to applications | You can always see exactly what was submitted for each job. |

## Research Assistant Boundaries

CareerOS can automate research, but each suggestion should be reviewable before saving.

| Assistant | Allowed inputs | Output |
| --- | --- | --- |
| Contact research | Public web results, public profile snippets, company pages, job-page text, pasted LinkedIn snippets, future browser capture, official connectors where available. | Candidate contacts with role, source, evidence, confidence, and suggested outreach task. |
| Salary research | Employer posting, public salary pages, comparable job adverts, regional benchmarks, region and seniority assumptions. | Reviewable base and total-compensation estimates with source links, evidence excerpts, date, confidence, and warnings. |
| Company research | Company site, public summaries, pasted notes, job-page text. | Short company snapshot, detailed notes, sector, stage, and application-relevant context. |

The app should not silently log into services, bypass access controls, mass scrape private pages, or automatically message people. It should speed up research and drafting while keeping the user in approval control.

## What This Slice Adds

This implementation adds the first end-to-end CV adaptation workflow on top of Career Studio and Job Detail:

| Added | Details |
| --- | --- |
| Start from a saved job | `Tailor CV` opens Application Studio from the job detail workspace. |
| Choose any imported CV | The studio uses the reviewed evidence associated with the selected imported CV as its factual base. |
| Evidence-backed tailoring | The configured LLM proposes concise changes and must cite stored evidence IDs; unsupported claims are discarded. |
| Three-pane review | Job requirements and gaps, the editable CV, and proposed changes remain visible together. |
| Change control | Accept, reject, undo, accept all, reject all, or manually edit before saving. |
| A4 page guard | Live word and page counts keep the draft disciplined; fixed A4 sheets reveal when the CV genuinely needs another page. |
| Immutable versions | Save job-specific CV versions with parent, final content, AI model, proposal history, and decisions. |
| Durable working drafts | Autosave unfinished job-specific edits to SQLite and restore them when the role is reopened without polluting immutable version history. |
| Application materials | When the job already has an application, the exact saved CV version is attached to it automatically. |
| Initial PDF output | Use the print view to save the current structured A4 pages as a PDF. Additional PDF templates and DOCX remain next. |

## Next Coding Slice

The next document slice hardens output and expands Application Studio beyond CVs. The current adaptation workflow remains the foundation.

| Component | Requirement |
| --- | --- |
| Controlled templates | Add a small set of stable one-page CV templates with predictable typography and spacing. |
| File export | Generate downloadable PDF files, then DOCX, from the saved structured version rather than relying only on browser print. |
| Wider evidence | Let one CV adaptation draw from reviewed portfolio, project, skill, education, achievement, and experience evidence across imported documents. |
| More materials | Reuse the same review and version contracts for cover letters, portfolio notes, and application answers. |
| Submission state | Let the user mark one exact version as submitted and show it clearly in application history. |
| Contact research | Add cited, reviewable public recruiter and referral research after document output is dependable. |
