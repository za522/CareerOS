# Tonight Release Implementation Checklist

This checklist is subordinate to `URGENT_SHARED_LAUNCH_PLAN.md`. A feature is release-certified only after implementation, regression tests, and an independent critique with no Critical or High findings. "Configuration pending" means the code path is complete but a user-owned external account or credential is absent.

## Data protection and baseline

- [x] Snapshot the existing SQLite database before migrations.
- [x] Verify backup checksums, foreign keys, and SQLite integrity.
- [x] Record baseline entity counts and preserve tracker, application, evidence, document, draft, and discovery data.
- [x] Add versioned checksum-validated backup bundles and staged non-destructive restore.
- [x] Exercise export, tamper rejection, version rejection, and restore staging through the browser.
- [ ] Complete the final post-release backup after every release gate passes.

## Rapid capture

- [x] Durable capture queue with bounded concurrency, progress, cancellation, retry, restart recovery, and review states.
- [x] Repeated LinkedIn pasted-text capture plus public-link and URL-batch capture without waiting.
- [x] Preserve raw source, evidence, source URL, and direct Apply URL through review.
- [x] Atomic batch enqueue and commit, duplicate comparison, blocked recovery, and keyset pagination.
- [x] Browser scenarios for 20 rapid captures, 60-item pagination, focus containment, interrupted composer recovery, late duplicates, and a 100-item capacity run.
- [x] Independent rapid-capture critique has no Critical or High findings.

## Discovery and alerts

- [x] Seven approved finance sources using Greenhouse, Lever, and official employer adapters.
- [x] Distinct posted, detected, checked, deadline, last-seen, changed, and availability data.
- [x] Source leases, bounded checks, partial-feed quarantine, pagination consistency, and three-successful-check closure rules.
- [x] Legacy same-source requisition repair preserves aliases, observations, saved links, and is idempotent.
- [x] Alias-specific hashes prevent false changed alerts; unchanged live Point72 and Schonfeld checks report zero changes.
- [x] Dense Discover feed, structured filters, FTS, keyset pagination, source health, run history, direct links, save/hide/report actions, and responsive layout.
- [x] Alert creation is atomic with discovery persistence; recurring content transitions retain distinct observation-backed identities.
- [x] Durable deduplicated in-app alerts and Telegram deliveries include provider-aware retry/backoff, crash-ambiguity protection, safe escaped links and immutable attempt history.
- [x] Telegram formatting, Unicode limits, credential recovery, concurrency, retry, pagination and safe mocked browser regressions pass.
- [ ] Fresh independent alerts re-critique after the reliability fixes.
- [ ] Send and receive the final real-phone Telegram test alert once `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured.
- [ ] Fresh discovery repair critique must finish with no Critical or High findings.

## Private sharing and collaboration

- [x] Fail-closed Google/Supabase session verification and invitation-only owner/editor/viewer authorization.
- [x] Opaque expiring invitation handoff using a short-lived HttpOnly SameSite cookie; token hashes only.
- [x] Workspace membership, role management, revocation, comments, presence, labelled cursors, record refresh, and audit history.
- [x] Revision-aware writes and visible stale-edit recovery prevent silent overwrites.
- [x] Helmet, CSP, rate limits, non-root container, persistent API deployment config, and secret-safe exports.
- [x] Two-browser real API/SQLite acceptance: owner invite, editor acceptance, shared edit, CV comment, and uninvited denial.
- [x] Independent sharing/security critique has no Critical or High findings.
- [ ] Deploy the private hosted instance and repeat the acceptance test with real Google/Supabase credentials.

## Application Studio

- [x] Structured AI target resolution for exact, multi-target, exception, and document-wide requests.
- [x] All changes remain proposals with grouped preview, word-level diffs, accept/reject, and conflict states.
- [x] Whole-entry and reorder transitions preserve later manual edits instead of silently replacing fields.
- [x] Selection-level bold/italic, editor-scoped undo/redo, structured groups, compact skills rows, spacing controls, and honest A4 pages.
- [x] Atomic content/proposal undo, autosave, reopen, stale-draft compare/reload/retry, comments guard, and immutable snapshot provenance.
- [x] Controlled backend PDF generation, overflow and clipping rejection, text verification, working-link annotation verification, and A4 rendering.
- [x] PDF uses the same per-section gaps, system font stacks, inline emphasis, compact section rules, links, order, and page assignments as the editor.
- [x] Exact immutable PDF versions can be marked submitted and linked to the correct ApplicationMaterial.
- [ ] Fresh independent editor/history critique must finish with no Critical or High findings.
- [ ] Fresh independent PDF-fidelity critique must finish with no Critical or High findings.
- [ ] Repeat representative single-target and multi-target requests against a configured live OpenAI model.

## Release gate

- [ ] Unit, integration, typecheck, build, audit, and complete end-to-end suites are green after the final fixes.
- [ ] Realistic laptop and mobile visual/accessibility critique has no Critical or High findings.
- [x] 100-capture and substantial 50,000-record discovery performance scenarios pass.
- [ ] Data-safety, security, and deployment-readiness critique has no Critical or High findings.
- [ ] Release-level adversarial comparison against every controlling acceptance scenario passes or records an exact credential-only operational boundary.
- [ ] Create the final verified backup and stop all bounded test servers.
- [ ] Publish the release acceptance report with exact run, setup, deployment, and user-test instructions.
