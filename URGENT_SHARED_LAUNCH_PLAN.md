# CareerOS Urgent Shared Launch Plan

## Status

This is the active delivery plan for making CareerOS usable during the August 2026 graduate, internship, off-cycle, and early-career application season.

It narrows the broader CareerOS roadmap into one polished workflow that Zain and an invited family collaborator can use immediately:

1. Discover relevant live roles.
2. Save and track selected opportunities.
3. Prepare a factual, job-specific CV.
4. Work together in a secure shared workspace.
5. Preserve exact application history and submitted materials.

`CAREEROS_BUILD_PLAN.md` remains the complete product roadmap. `LIVE_OPPORTUNITY_FEED_PLAN.md` and `JORB_PRODUCT_REFERENCE.md` remain the detailed discovery and workflow references. This file controls urgent delivery order.

## Honest Current Position

The existing written plans already cover:

- A SimplyTK-inspired live opportunity feed.
- A Jorb-inspired dense discovery, tracker, firm-research, and document workflow.
- The opportunity/application record hierarchy.
- Application Studio, CV adaptation, evidence, versioning, and controlled export.
- Career tracks, upskilling, analytics, and a derived career map.

The previous plans did **not** adequately specify:

- Hosted access outside the local Mac.
- Google login.
- Workspace invitations and permissions.
- Live collaborator presence and cursors.
- Simultaneous editing, comments, and collaborator audit history.

Those are now committed launch requirements rather than vague future sync work.

It is not responsible to claim that a production-grade SimplyTK, Jorb, Figma-style editor, career map, and broad multi-sector data network can all be completed and verified in one unattended evening. The urgent plan therefore protects the workflow needed to apply now, while preserving the larger architecture.

## Tonight Release Product Specification

This section is the single product specification for the urgent release. The wider plans provide architecture and later scope, but they do not expand tonight's release unless this section is updated explicitly.

### 1. Rapid Job Capture

- The capture inbox accepts repeated pasted job-page text, individual public URLs, or a batch of URLs.
- Submitting one item immediately clears the composer so the next LinkedIn page can be pasted without waiting.
- Every capture is stored durably and processed independently in the background.
- The queue shows progress and `Queued`, `Extracting`, `Needs review`, `Duplicate`, `Blocked`, `Failed`, and `Saved` states.
- AI extraction produces reviewable field proposals with evidence; it never silently creates or overwrites confirmed tracker data.
- A failed capture does not stop later items, and failed items can be retried.
- Reviewed items save into the existing Company and JobPosting hierarchy without avoidable duplicates.

### 2. Continuous Job Watcher

- CareerOS checks an approved starting list of finance employers and public ATS sources on a schedule and on demand.
- The first reliable adapters cover Greenhouse and Lever, followed by individually tested employer sources.
- The Discover table separates employer-posted date, first detected by CareerOS, last checked, deadline, and current availability.
- Repeated runs update observations without duplicating roles.
- A temporary source failure never marks a posting closed.
- Roles can be filtered, opened at the direct employer page, hidden, or sent through review into the personal tracker.
- Source health, last successful run, duration, new-role count, and errors are visible in CareerOS.

### 3. Phone Notifications

- Saved alert rules match company, buy side or sell side, role family, programme, location, keywords, and freshness.
- Matching new or materially changed postings create deduplicated in-app alerts.
- Telegram delivers immediate phone notifications containing the company, role, location, detected time, reason for matching, and direct link.
- Delivery success or failure is recorded and retryable.
- A test-alert action proves the configured channel works.
- WhatsApp remains a provider adapter immediately after the release and does not block Telegram delivery.

### 4. Private Sharing and Collaboration

- CareerOS is accessible from a hosted URL and no longer depends on Zain's laptop being online.
- Google sign-in identifies users; Zain can invite or revoke his dad's workspace access.
- Uninvited users cannot read workspace records or files.
- Both users see the same tracker, tasks, notes, application events, CV drafts, and accepted versions.
- Tracker changes appear on both computers without refreshing.
- Material edits retain author and time in an audit history.
- Application Studio supports collaborator presence, comments, and safe concurrent changes without silent overwrites.
- Existing local records are migrated only after a verified export, and a failed migration leaves the local copy intact.

### 5. Dependable Application Studio

- A saved role opens with the complete job context and the selected imported CV.
- AI instructions can target one field, one entry, several named entries, or an intentional document-wide change without editing unrelated content.
- Every AI change remains a proposal until accepted; rejection leaves the document untouched.
- All changes from one request appear together by default, while hover or focus isolates one change and shows word-level additions and deletions.
- Editing supports selection-level bold and italic, keyboard undo and redo, structured sections, multiple entries per section, compact skills rows, and honest A4 page flow.
- Accepted work autosaves and reopening the application restores the same draft.
- Snapshot history creates immutable named checkpoints without confusing it with autosave.
- PDF export preserves the preview's text, fonts, sizes, emphasis, spacing, alignment, bullets, links, section order, and page boundaries.
- Preflight warns about overflow, unexpected blank pages, missing links, or unsupported formatting before export.
- The exact exported CV version can be marked as submitted and linked to its Application.

### Cross-Cutting Release Requirements

- Existing tracker and CV data remain intact.
- Backend, AI, discovery, queue, notification, and collaboration health are visible in the system panel.
- Errors are understandable, retained for inspection, and do not collapse unrelated workflows.
- Core controls are keyboard accessible and usable on a laptop-sized viewport.
- Secrets never enter exported workspace data, browser storage, logs, or source control.
- No feature is marked complete without an end-to-end test through the real user interface.

### Release Acceptance Scenarios

The release candidate passes only when these scenarios succeed:

1. Queue at least 20 mixed pasted-text and URL captures rapidly, continue using the app while they process, review results, retry a failure, and save valid non-duplicates.
2. Run the watcher twice against test and approved live sources, find new roles once, update last-checked observations, and survive one source failure without false closures.
3. Trigger a matching test posting and receive one Telegram alert with a working direct link, then confirm no duplicate alert appears on a repeated run.
4. Sign in as Zain and an invited collaborator in separate browser sessions, change a tracker record, comment on a CV, and verify access denial for an uninvited session.
5. Open a real application, issue precise single-target and multi-target AI requests, accept and reject proposals, undo an edit, reopen the draft, export its PDF, and compare every page against the editor preview.
6. Export a complete backup and verify the release can restore it without losing applications, events, evidence, captures, CV drafts, versions, or files.

### Not Required for Tonight's Release

- The visual career landscape and node map.
- A comprehensive feed for every company or every career sector.
- WhatsApp delivery, email digests, or the browser extension.
- Public registration, subscriptions, billing, teams beyond the private invited workspace, or full SaaS administration.
- Desktop packaging and optional synchronisation.

Production hosting, Google authentication, Telegram delivery, and live source checks require the corresponding user-owned service configuration and credentials. The implementation may be completed and tested with local or preview configuration, but production behavior must not be claimed until those real integrations pass the acceptance scenarios above.

## Launch Definition

The polished launch is complete when Zain and one invited collaborator can sign in from separate computers and complete this loop:

1. Rapidly queue the existing backlog of LinkedIn text captures and public job URLs without waiting for each extraction to finish.
2. Open a finance-focused live feed populated by scheduled checks of approved employer and ATS sources.
3. Inspect roles with direct links, employer-posted dates, CareerOS detection times, and last-checked state.
4. Receive a phone alert when a newly detected role matches a saved rule or an important posting changes.
5. Save a selected role into the private tracker without creating duplicates.
6. See the same tracker update on both computers.
7. Open the role and prepare a tailored CV together.
8. See who is online, which page they are viewing, and their live cursor or active field.
9. Review, accept, reject, undo, and comment on changes.
10. Export the approved CV and mark the exact version as submitted.
11. Track application status, events, deadlines, tasks, and outcomes.
12. Restore the workspace from a verified backup.

## Priority Boundary

### P0: Required for the Shared Launch

| Pillar | Required outcome |
| --- | --- |
| Hosted private workspace | CareerOS opens from a secure web URL rather than depending on Zain's Mac and local ports. |
| Google authentication | Zain signs in with Google and explicitly invites his dad. Uninvited accounts have no workspace access. |
| Shared tracker | Both users see saved jobs, application changes, tasks, deadlines, notes, and statuses update online. |
| Collaboration presence | Avatars, online state, current route, active record, and labelled cursors are visible in shared working views. |
| Edit safety | Revisions, optimistic concurrency, audit records, and visible conflict recovery prevent silent overwrites. |
| Rapid capture queue | LinkedIn page text, public URLs, and manual captures can be submitted repeatedly into a background queue with independent progress, review, errors, duplicate handling, and retry. |
| Finance discovery | A dense newest-first feed covers approved finance, quant, trading, banking, asset-management, and related sources. |
| Continuous monitoring | Approved sources run on schedules and retain first-seen, last-seen, changed, removed, restored, and expired observations. |
| Phone alerts | Matching roles and important posting changes generate in-app alerts and Telegram messages. Providers remain replaceable so WhatsApp can follow. |
| Save-to-tracker review | Discovery records remain separate until reviewed and saved to the personal tracker. |
| Application Studio | A saved role opens with job context, structured CV editing, precise evidence-backed AI proposals, review controls, undo/redo, autosave, and honest A4 pagination. It must be dependable enough for a real submission rather than a visual prototype. |
| Shared CV work | Collaborators can see active editing, proposed changes, comments, and accepted document state. |
| Controlled output | Export an accepted CV to a stable PDF whose fonts, spacing, pagination, emphasis, links, and content match the editor, then link that exact immutable version to the application. |
| Portability | Existing local records migrate once, and cloud exports include data, files, versions, evidence, and checksums. |

### P1: Required Immediately After Launch Stability

- Advanced alert rules, digests, quiet hours, and WhatsApp delivery.
- Cover letters and application-answer drafts.
- Contact and recruiter research with public citations.
- Better salary providers and regional comparison.
- Spreadsheet mapping and bulk tracker actions.
- Browser capture for public job pages.
- Broader big-tech, software, startup, consulting, and design-engineering discovery sources.

### P2: Important, but Must Not Block Applications

- Visual career node map.
- Funnel and source-effectiveness analytics.
- Full firm intelligence directory.
- Upskilling planner and preparation timelines.
- Desktop packaging.
- Public multi-tenant SaaS billing and administration.

## Immediate Execution Priorities

All four workstreams below are required for the urgent recruiting launch. Their internal tasks may proceed in parallel, but none is optional:

1. **Rapid capture:** queue the current LinkedIn text captures and public URLs without waiting for one AI extraction at a time.
2. **Discovery and alerts:** repeatedly check target firms, preserve posting freshness, and send relevant Telegram notifications.
3. **Application Studio hardening:** reliably tailor, review, edit, autosave, version, export, and reopen a job-specific CV without formatting or content drift.
4. **Private sharing:** host CareerOS securely so Zain and his dad can access the same tracker and application documents, with comments, visible authorship, and safe live updates.

The career landscape remains later work. Application Studio hardening does not: it is part of the minimum polished application loop.

## Product Surfaces

### 1. Discover

The first new workspace is a dense operational feed, not a landing page.

Required columns:

- Company.
- Role.
- Career track.
- Programme type.
- Location.
- Deadline.
- Employer-posted age.
- CareerOS-detected age.
- Last checked.
- Availability.
- Personal save/application state.
- Direct Apply link.

Required filters:

- Search.
- Buy side or sell side.
- Sector and firm type.
- Role family.
- Programme: graduate, internship, off-cycle, spring week, placement, or entry-level.
- Location and work mode.
- New in 24 hours.
- Deadline soon.
- Sponsorship/work-authorisation evidence.
- Saved, hidden, or already tracked.

Required actions:

- Save to CareerOS.
- Open direct employer application.
- Hide.
- Report incorrect data.
- Create an alert from the current filters.

### 2. Rapid Capture Inbox

LinkedIn and other authenticated pages often cannot be fetched reliably by the server. Copied page text is therefore a first-class capture method rather than an error fallback.

Required behavior:

- Paste one complete job page and press a keyboard shortcut to enqueue it.
- Immediately clear the composer for the next capture without waiting for extraction.
- Accept multiple public URLs pasted together.
- Show `Queued`, `Extracting`, `Needs review`, `Duplicate`, `Blocked`, and `Failed` independently for every item.
- Run a small configurable number of AI jobs concurrently to control cost and rate limits.
- Preserve the source URL when it appears in copied content or is supplied beside it.
- Never let one failed import stop the queue.
- Review items individually or approve a valid batch.
- Keep raw captured text and field evidence attached to each proposal.

A later browser extension will send the current URL, title, and selected or readable text into this same queue rather than introducing a second import system.

### 3. Opportunities

The personal tracker remains separate from discovery. It must support:

- Saved views and configurable columns.
- Inline priority, deadline, status, next action, and ownership.
- Application event history rather than destructive status replacement.
- Tasks and follow-ups.
- Exact source, posting, detected, checked, and CareerOS-updated dates.
- Duplicate comparison.
- Direct entry into Application Studio.
- Real-time collaborator updates and activity indicators.

### 4. Application Studio

The current three-pane workspace remains the application-preparation centre.

Launch hardening includes:

- Stable CV templates.
- Reliable one-page and multi-page A4 boundaries.
- Editor-to-PDF fidelity for fonts, sizes, line spacing, section spacing, alignment, bold, italics, links, bullets, and page breaks.
- A pre-export overflow and pagination check that reports problems before creating the final file.
- Selection-level bold, italic, undo, redo, and structured section controls.
- Compact skills and interests rows.
- Evidence-backed AI proposals with explicit targets and no unrelated edits.
- Correct handling of one request that intentionally targets multiple fields or entries.
- All pending changes visible together and individual hover/focus inspection.
- Per-change accept/reject and visible word-level diffs.
- Accepted AI changes persist through autosave; rejected changes never enter the document.
- Comments and collaborator presence.
- Reopening an application restores the latest accepted draft rather than rebuilding it from imported CV text.
- Immutable snapshots and exact submitted-version linking, including which CV was actually sent.
- Controlled PDF output verified against the on-screen A4 preview.

### 5. Shared Workspace

Required collaboration objects:

- `User`.
- `Workspace`.
- `WorkspaceMembership` with owner, editor, and viewer roles.
- `WorkspaceInvite` with expiry and revocation.
- `PresenceSession` for online state and current context.
- `CommentThread` and `Comment` linked to jobs, applications, tasks, or document targets.
- `AuditEvent` for material edits, invitations, exports, and application changes.

Only the workspace owner can invite or remove members, change permissions, restore backups, or delete records. Editors can research, edit, comment, and track applications. Viewers cannot change application data.

## Finance Career Taxonomy

The feed and tracker need a structured finance landscape before the visual career map exists.

### Sell Side

- Sales and trading: sales, execution, flow trading, electronic trading, derivatives, commodities, FX, rates, credit, and equities.
- Quantitative roles: quant trader, desk quant, strats, quantitative developer, model validation, and electronic-trading research.
- Research: equity research, credit research, macro research, strategy, and economics.
- Investment banking: M&A, industry coverage, ECM, DCM, leveraged finance, restructuring, and financial sponsors.
- Structuring and solutions.
- Prime brokerage and securities financing.

### Buy Side

- Hedge funds: discretionary, systematic, global macro, equity long/short, credit, event-driven, and multi-strategy.
- Proprietary trading and market making.
- Asset management: public equities, fixed income, multi-asset, alternatives, and quantitative investing.
- Private markets: private equity, private credit, venture capital, infrastructure, and real assets.
- Investment research and portfolio analytics.

### Market Infrastructure and Adjacent Finance

- Exchanges, clearing, index providers, market data, and trading technology.
- Fintech, payments, wealth technology, risk technology, and financial-data platforms.
- Treasury, capital, liquidity, and front-office risk roles where genuinely relevant.

### Technology Track

The same taxonomy foundation later supports:

- Software engineering.
- Machine-learning and AI engineering.
- Data engineering and data science.
- Product management.
- Technical programme management.
- Design engineering and product design.
- Startup and founder roles.

The taxonomy is relational data used by discovery, filters, matching, planning, and analytics. The later node map is a derived visual projection, not a second source of truth.

## Technical Architecture

### Keep

- React and Vite frontend.
- Fastify TypeScript API.
- Shared Zod contracts.
- Drizzle repositories.
- `CareerOSClient` as the only frontend data boundary.
- Stable globally unique IDs, revisions, evidence, immutable events, and document versions.

### Add

| Concern | Launch architecture |
| --- | --- |
| Cloud data | PostgreSQL repository adapter using the same domain services as SQLite. |
| Authentication | Supabase Auth with Google sign-in. |
| Authorisation | Workspace membership checks in Fastify plus PostgreSQL row-level security. |
| Files | Cloud object-storage adapter with checksums and workspace-scoped paths. |
| Structured real-time updates | Database change events plus revision-aware API writes. |
| Presence and cursors | Authenticated collaboration rooms with throttled cursor broadcasts and slower-changing presence state. |
| CV collaboration | A managed collaborative rich-text/document room, with accepted CareerOS snapshots written through the Fastify domain service. |
| Scheduled discovery | A deployed scheduler invokes idempotent source checks; source leases and run locks prevent overlaps. |
| Notifications | Provider-neutral service with in-app and Telegram adapters first, followed by WhatsApp. |
| Deployment | Hosted React frontend, hosted Fastify API, managed PostgreSQL, scheduled discovery worker, and separate preview/production environments. |
| Backups | Scheduled encrypted database/file exports plus user-triggered versioned bundles. |

Supabase officially supports Google OAuth, PostgreSQL row-level security, database-change subscriptions, presence, and high-frequency broadcast channels. Presence should represent users and active context; cursor movement belongs on Broadcast rather than Presence. Liveblocks is the preferred managed document-collaboration layer if its editor integration fits the structured CV migration, because it provides cursors, comments, persistence, and multiplayer undo/version behavior without building a CRDT service from scratch.

The cloud repository is added behind the existing interfaces. SQLite remains the local/offline adapter; the UI never imports either database directly.

## Discovery Architecture

Use the entities and pipeline already committed in `LIVE_OPPORTUNITY_FEED_PLAN.md`:

- `DiscoverySource`.
- `DiscoveryRun`.
- `DiscoveredPosting`.
- `DiscoveryObservation`.
- `AlertRule`.
- `AlertEvent`.

Initial source order:

1. Approved Greenhouse boards through documented public endpoints.
2. Approved Lever boards through public postings endpoints.
3. Stable public ATS or employer pages with source-specific fixtures.
4. Curated company career pages where no structured endpoint exists.
5. Manual URL, pasted text, and browser capture for blocked sources.

The first production source list should be deliberately curated around target banks, market makers, hedge funds, asset managers, proprietary firms, exchanges, and relevant financial-technology companies. Breadth comes after source reliability, deduplication, and freshness are proven.

## Delivery Order

### Gate 0: Protect Existing Work

- Freeze and export the current local database and files.
- Add migration fixtures and full round-trip tests.
- Record the current schema and application version.
- Add a staging environment with no production data.

### Gate 1: Shared Cloud Foundation

- Add PostgreSQL repositories.
- Add workspace ownership to persistent entities.
- Add Google sign-in, invitation allowlist, membership roles, and audit events.
- Migrate one copy of the current local workspace.
- Deploy the existing tracker, job detail, Career Studio, and Application Studio.
- Verify two-user access and isolation from uninvited accounts.

### Gate 2: Rapid Capture Queue

- Add a durable import-job queue and per-item progress.
- Add a keyboard-first pasted-text composer for repeated LinkedIn captures.
- Add bulk URL input, bounded AI concurrency, retries, duplicate comparison, and batch review.
- Verify that 100 mixed captures can be submitted without blocking the interface or losing failures.

### Gate 3: Finance Discovery and Phone Alerts

- Add discovery schema and migrations.
- Implement Greenhouse and Lever adapters with fixtures.
- Seed an approved target-company source list.
- Add scheduled checks with run locks, rate limits, backoff, and source health.
- Build the Discover table with direct links, posted date, first detected, last checked, and availability.
- Add deduplication, observation history, alert rules, in-app notifications, and Telegram delivery.

### Gate 4: Real-Time Collaboration

- Add online avatars, route/record presence, and labelled cursors.
- Stream tracker and application changes between two browsers.
- Add revision conflicts and recovery.
- Add shared CV editing, comments, collaborator selections, and multiplayer-safe undo.
- Preserve accepted snapshots in CareerOS document versions.

### Gate 5: Application Output

- Harden stable CV templates, structured sections, editing, autosave, undo/redo, and reopening behavior.
- Make AI targeting reliable for precise single-target and multi-target instructions, with no silent acceptance.
- Generate deterministic PDF files only from accepted document state.
- Add preflight checks for overflow, unexpected extra pages, missing links, and unsupported formatting.
- Verify that page boundaries, fonts, spacing, emphasis, bullets, links, and text match the editor preview.
- Mark and attach one exact immutable submitted version to the application.

### Gate 6: Operational Polish

- Saved feed views.
- Deadline and follow-up reminders.
- Alert digests, quiet hours, delivery history, and retry controls.
- Error/run health in the system panel.
- Accessibility, responsive, keyboard, empty, loading, conflict, and recovery states.

### Gate 7: Career Landscape

- Seed the finance and technology taxonomies.
- Connect tracks to roles, firms, skills, projects, and preparation resources.
- Add the derived node map only after the underlying relationships are useful without it.

## Acceptance and Critique Gauntlet

Every gate must pass the same loop before it is called complete:

1. Implement the smallest end-to-end vertical slice.
2. Run schema, repository, domain, API, migration, and browser workflow tests.
3. Test with two independent authenticated browser sessions.
4. Run an adversarial review for data loss, permissions, duplicate records, stale updates, and AI overreach.
5. Run a product critique for speed, density, clarity, accessibility, and failure recovery.
6. Fix all high-severity findings.
7. Verify backup/restore and redeploy from a clean environment.
8. Update `CURRENT_FUNCTIONALITY.md`, `TESTING_GUIDE.md`, and this plan with evidence of completion.

An unattended agent run may implement and test code, but it must not invent production credentials, silently migrate or delete the only local database, invite users, purchase services, or claim live collaboration works without a genuine two-session test.

## Deferred Until the Shared Launch Is Stable

- Full visual career map.
- Deep upskilling planner.
- Broad recruiter/contact automation.
- Multi-currency compensation analytics.
- Desktop packaging.
- Public signup, billing, teams administration, and enterprise features.
- Automatic application submission.

These remain valid parts of CareerOS. They are deferred because they do not help Zain submit the next application as directly as discovery, tracking, CV output, and collaboration do.
