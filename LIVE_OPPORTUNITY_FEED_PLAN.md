# CareerOS Live Opportunity Feed Plan

## Goal

Add a discovery workspace that continuously finds relevant public internships, graduate roles, spring weeks, and early-career jobs across finance, quant, consulting, big tech, software, startups, and design engineering.

The feed is separate from the personal opportunity tracker. A discovered posting only becomes a `Company` and `JobPosting` after the user chooses **Save to CareerOS** and approves the existing import review.

The public trackers at [SimplyTK](https://simplytk.com/internship-tracker) and [Jorb](https://www.jorb.ai/) are useful product references. SimplyTK demonstrates freshness and detection timing; Jorb demonstrates high-density search, saved jobs, firm directories, inline progress, alerts, spreadsheet migration, and a document-tailoring workspace. CareerOS will reproduce the useful workflow with its own data and architecture, not copy either site's code, private data, or visual identity.

## Useful Product Pattern

The inspected public page demonstrates these useful behaviors:

| Behavior | CareerOS interpretation |
| --- | --- |
| Live, newest-first feed | Sort by CareerOS `firstSeenAt`, with a visible last successful check time. |
| Direct employer links | Preserve the canonical employer or ATS application URL. |
| Posted and detected times | Store employer `sourcePostedAt`, CareerOS `firstSeenAt`, `lastSeenAt`, and detection lag separately. |
| Search and structured filters | Filter by sector, role family, programme, degree level, location, work mode, new in 24 hours, and deadline soon. |
| Star or save | Send a selected discovery through duplicate comparison and the existing review-before-commit pipeline. |
| Freshness tracking | Mark postings open, removed, expired, blocked, or unknown without deleting history. |
| Alerts | Match new postings against local alert rules and notify only after a discovery run commits. |
| Error reporting | Let the user mark a classification, deadline, link, or posting state as incorrect. |
| Dense search table | Support configurable columns for company, role, location, industry, category, level, posted date, and personal progress. |
| Saved filter presets | Preserve useful searches and turn any preset into a future alert rule. |
| Firm discovery | Browse mainstream and boutique target firms even when they have no currently open role. |

## Architecture

### New Entities

| Entity | Responsibility |
| --- | --- |
| `DiscoverySource` | An approved company career page, ATS board, public feed, or provider configuration. |
| `DiscoveryRun` | One immutable fetch cycle with start/end time, result counts, state, warnings, and duration. |
| `DiscoveredPosting` | A normalized feed record that is not yet part of the personal tracker. |
| `DiscoveryObservation` | Evidence that a posting was seen, changed, missing, blocked, or restored during a run. |
| `AlertRule` | Local matching criteria such as track, company, role, location, programme, degree level, or keywords. |
| `AlertEvent` | A deduplicated notification created for a matching posting, with provider delivery attempts and outcomes recorded separately. |

`DiscoveredPosting` will include source and external IDs, canonical URL, direct apply URL, company, title, normalized title, location, programme, sector, role family, degree level, deadline, source posting date, first seen, last seen, closed date, availability, content checksum, classification method, confidence, and provenance.

### Provider-Neutral Discovery Pipeline

1. Select enabled sources that are due for checking.
2. Fetch with per-host rate limits, timeouts, safe redirects, conditional requests, and response-size limits.
3. Prefer documented public structured endpoints over HTML extraction.
4. Parse with a source adapter and validate through shared Zod schemas.
5. Normalize company names, titles, locations, programmes, sectors, and URLs.
6. Deduplicate using provider IDs first, canonical URLs second, and normalized company/title/location keys last.
7. Insert or update the discovery record and append an immutable observation.
8. Mark a posting missing only after source-specific confirmation or repeated absence, never from one transient failure.
9. Evaluate alert rules against newly committed or materially changed postings.
10. Show run health, check time, counts, duration, and errors in the existing system-status UI.

### Initial Source Strategy

1. **Greenhouse adapter:** use its documented public Job Board GET endpoints for approved board tokens.
2. **Lever adapter:** use its public Postings API for approved company site names.
3. **Public ATS pages:** add adapters only when a source has a stable public interface and fixtures can be tested.
4. **Company career pages:** use safe HTML capture for a curated target-company list when no structured feed exists.
5. **Manual and browser capture:** retain the current URL and pasted-text paths for blocked or authenticated sources.
6. **Future source-discovery agent:** search for likely official careers or ATS board URLs, then propose sources for user approval before monitoring begins.

The LLM should classify ambiguous roles and enrich incomplete metadata only after deterministic extraction. It should not be responsible for deciding whether a posting exists or silently creating personal tracker records.

## User Experience

Add a **Discover** workspace beside Opportunities.

| Surface | Behavior |
| --- | --- |
| Feed header | Live-source count, last successful check, current run state, and manual refresh. |
| Filters | Search, sector, role family, programme, degree level, location, work mode, new in 24 hours, and deadline soon. |
| View controls | Save/restore filter presets, clear filters, edit visible columns, sort, paginate, and perform safe bulk save/hide actions. |
| Feed row | Company, role, programme, location, deadline, posted age, detected age, confidence, and direct Apply link. |
| Row actions | Save to CareerOS, hide, open source, report incorrect data, and create an alert from this role. |
| Save flow | Duplicate comparison, evidence review, then commit to the existing Company and JobPosting hierarchy. |
| Posting state | Open, removed, expired, blocked, or unknown, with last checked time and observation history. |
| Empty/error states | Distinguish no matches, no configured sources, all sources blocked, partial run failure, and backend offline. |

## Delivery Sequence

### Feed Milestone 0: One Reliable Vertical Slice

- Add the six discovery entities, migrations, repositories, contracts, and API routes.
- Configure one Greenhouse source and one Lever source from the user's target-company list.
- Run discovery manually and persist first/last seen timestamps without creating JobPostings.
- Test deduplication, source failure, restart persistence, and non-destructive missing-post behavior.

### Feed Milestone 1: Discover Workspace

- Add the feed table, search, filters, newest-first sorting, pagination, and source-health states.
- Add direct employer links and `Save to CareerOS` through the existing import review.
- Add hide and incorrect-data controls.
- Add responsive mobile rows and keyboard-accessible controls.

### Feed Milestone 2: Freshness and Scheduling

- Add per-source schedules, conditional requests, backoff, run locking, and observation history.
- Add manual recheck for one posting or source.
- Mark closed postings conservatively after confirmed removal or repeated absence.
- Show detection lag and last successful check.

### Feed Milestone 3: Matching and Alerts

- Add alert rules and in-app notifications.
- Add Telegram delivery for immediate phone notifications through the provider-neutral notification interface.
- Support immediate alerts, optional digests, quiet hours, deduplication, delivery history, and retry state.
- Rank new postings against CareerTracks, preferences, and later Profile evidence.
- Add WhatsApp, email, and desktop notifications as later adapters without changing discovery or alert-rule logic.

### Feed Milestone 4: Wider Coverage

- Add more tested ATS adapters and curated company sources.
- Add the reviewable source-discovery agent.
- Add source effectiveness analytics: discovered, saved, applied, interviewed, and offered.
- Add import/export coverage for source configuration, observations, and alert rules.

## Guardrails

- Use public employer or ATS information and respect access controls, source terms, rate limits, and robots directives where applicable.
- Do not monitor private LinkedIn pages, bypass authentication, submit applications, or message recruiters automatically.
- Do not treat a temporary timeout as a closed role.
- Keep source evidence and classification confidence visible.
- Keep discovered records separate from the personal tracker until explicit approval.
- Never overwrite user-confirmed JobPosting fields during later discovery runs.

## Acceptance Criteria

- CareerOS can check at least one Greenhouse and one Lever source on demand.
- New roles appear once with direct employer links and accurate first-seen timestamps.
- Repeated runs update `lastSeenAt` without creating duplicates.
- A failed source does not close or delete its postings.
- Saving a feed result opens the normal review flow and preserves provenance.
- Filters combine correctly and `New in 24 hours` uses CareerOS detection time.
- The system panel shows discovery-run health and timing.
- All structured tracking remains usable without an AI provider.
