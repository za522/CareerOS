# CareerOS Release Test Guide

This guide tests the urgent shared release as a user. It separates local checks from integrations that require production credentials.

## Start Locally

Use Node 22 in macOS Terminal:

```bash
cd "/Users/zainahmad/Developer/CareerOS"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
corepack enable
corepack pnpm install
corepack pnpm dev
```

Open:

- App: `http://127.0.0.1:5173/`
- API health: `http://127.0.0.1:4310/health`
- API capability status: `http://127.0.0.1:4310/api/meta`

The Terminal command remains active while CareerOS is open. Stop it with `Control-C` when finished.

## 1. Rapid Capture

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Open `Capture` and choose pasted text. | The rapid composer is ready immediately. |
| 2 | Paste a complete LinkedIn/job-page capture and press `Command-Enter`. | It enters the queue and the composer clears without waiting. |
| 3 | Repeat with several captures, then paste multiple public links in the links tab. | Every item has independent progress. You can leave the page while processing continues. |
| 4 | Open `Capture inbox`. | Items show queued, extracting, review, duplicate, blocked, failed or saved state. |
| 5 | Retry a failed/blocked test item and review a valid proposal. | One failure does not stop other jobs. Raw source and field evidence remain attached. |
| 6 | Save valid proposals or use the valid-batch action. | New non-duplicates appear in Opportunities; duplicate conflicts remain reviewable. |

## 2. Discover And Monitoring

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Open `Discover`. | A newest-first finance feed shows direct links and distinct posted, detected and checked dates. |
| 2 | Try career track, programme, location, work mode, sponsorship, freshness and deadline filters. | Results and counts update without losing the selected filters during refresh. |
| 3 | Click `Check now`. | Source health and run history update. A partial or failed source is labelled without falsely closing its roles. |
| 4 | Open a posting's direct link. | It goes to the employer/ATS URL with functional query parameters preserved. |
| 5 | Save a discovered role. | CareerOS opens review first, then adds it to the private tracker without duplicating an existing posting. |
| 6 | Create an alert from useful finance criteria. | The rule appears in the alert list and can be edited or removed. |

## 3. Telegram Alerts

Hosted Telegram is configured per workspace by its owner in `Discover > Telegram`. The API host requires `CAREEROS_INTEGRATION_ENCRYPTION_KEY` and a public `CAREEROS_APP_URL`; local single-user mode may still use `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in its private environment. Rotation accepts comma-separated old keys in `CAREEROS_INTEGRATION_ENCRYPTION_KEY_PREVIOUS` until every workspace credential has been re-encrypted.

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Open `Discover > Telegram`, enter the bot token and chat ID, then save. | The interface shows only a masked chat hint; the token is never shown again. |
| 2 | Send a test alert. | One Telegram message arrives with a working direct link, and only then does CareerOS report success. |
| 3 | Temporarily use invalid credentials, send a test, then restore valid credentials and press Retry. | The test returns an error. The failed attempt remains in History and the new attempt is recorded separately. |
| 4 | If a delivery is marked Ambiguous, press Send again. | CareerOS warns that Telegram may already have accepted the first message and requires explicit confirmation. |
| 5 | Run the same unchanged source twice. | The first matching role sends one message; the repeated check sends no duplicate. |
| 6 | Use Load older deliveries. | Older delivery and attempt history loads without replacing the recent page. |
| 7 | Sign in as an editor or viewer and try Telegram settings. | Configuration is denied; only the workspace owner can manage the destination. |

## 4. Tracker And Applications

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Open an Opportunity and edit its role details, dates, links and personal notes. | The saved data survives refresh. |
| 2 | Start an application and add submission, assessment, interview and follow-up events. | The timeline remains immutable and the projected status updates. |
| 3 | Add and complete a task. | The deadline/follow-up state persists. |
| 4 | Add or research a salary estimate. | The table shows the range and confidence while retaining its source separately. |

## 5. Application Studio

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Import a text-based PDF/DOCX CV in Career Studio, then open a saved role in Application Studio. | The reviewed source CV opens as a structured A4 draft. |
| 2 | Edit text and apply selection-level `Command-B` and `Command-I`. | Only selected text changes; formatting survives autosave and reopen. |
| 3 | Use `Command-Z` and redo. | Document content and AI decision history move together. |
| 4 | Request one precise AI change. | Only the resolved target is proposed; unrelated CV content remains unchanged. |
| 5 | Request several named changes plus exclusions. | All intended changes preview together; focusing one proposal isolates its word-level diff. |
| 6 | Manually edit a proposed field before accepting the older proposal. | CareerOS reports a proposal conflict and preserves the newer manual text. |
| 7 | Accept one proposal and reject another. | Only accepted content enters the draft; both decisions persist after reopening. |
| 8 | Open the same draft in two sessions and edit both. | A stale save presents compare, reload-latest and retry-local recovery instead of silently overwriting. |
| 9 | Add/reorder sections and entries using mouse and keyboard controls; adjust global and per-section spacing. | Content repacks between honest A4 pages without covering earlier text. |
| 10 | Name and save a snapshot. | An immutable version appears in Snapshot history and can be reopened read-only. |
| 11 | Click `Export PDF`, resolve any preflight errors and export. | The PDF retains fonts, spacing, emphasis, links, bullets, content and page breaks from the editor. |
| 12 | Mark the PDF as submitted when an application exists. | That exact immutable CV version is linked to the application materials. |

## 6. Sharing And Collaboration

Hosted testing requires the Google/Supabase setup in `HOSTED_RELEASE.md`.

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Sign in as the owner and create an email-bound editor invitation. | The private link expires and only the invited Google email can accept it. |
| 2 | Open a separate browser session as the invited collaborator. | The shared Opportunities and CV workspaces open. |
| 3 | Open another uninvited Google account. | Workspace data is denied. |
| 4 | Edit one tracker record as the collaborator and view it as the owner. | The shared record refreshes and audit history records authorship. |
| 5 | Comment on a role-specific CV. | Both sessions see the comment. |
| 6 | Work in the same view. | Online presence, active context and labelled cursors appear when Realtime is configured. |
| 7 | Try a simultaneous conflicting edit. | Stale data receives visible recovery rather than silently replacing newer work. |
| 8 | Change the collaborator to viewer or revoke access. | Writes are blocked for viewers and removed users lose access. |

## 7. Backup And Restore

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Export a backup from Opportunities. | A dated versioned JSON bundle downloads with data, files and checksums. |
| 2 | Select malformed JSON or a checksum-tampered copy for restore. | Validation fails and current records remain unchanged. |
| 3 | Select the original valid bundle and confirm. | CareerOS stages it non-destructively and explains that restart applies it. |
| 4 | Restart and verify jobs, events, evidence, captures, drafts, snapshots and files. | The restored workspace matches the exported state. |
| 5 | Restore an older encrypted backup, restart, then restore a newer encrypted backup and restart again. | Both backup records remain listed, encrypted objects remain usable, and each restart exposes the selected point-in-time data. |

## Automated Release Checks

```bash
cd "/Users/zainahmad/Developer/CareerOS"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:e2e
corepack pnpm audit --prod
```

The end-to-end suite starts bounded temporary servers and stops them after testing.
