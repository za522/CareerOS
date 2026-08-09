# CareerOS Current Functionality

This is the user-facing feature map for the urgent shared release. `Working` means the feature has automated coverage in the local or preview stack. `Setup required` means the implementation exists but a user-owned external account or credential must be connected before live production use can be claimed.

| Area | What you can do | State |
| --- | --- | --- |
| Opportunities | Search and filter a dense tracker of saved roles, dates, salary estimates, application state and direct links. | Working |
| Job workspace | Edit role and company details, requirements, work authorisation, notes, deadlines, tasks, salary evidence and source information. | Working |
| Applications | Start an application and retain immutable lifecycle events for submissions, assessments, interviews, offers, rejections, withdrawals and follow-ups. | Working |
| Rapid capture | Repeatedly queue pasted LinkedIn/job-page text, public links or manual captures without waiting for earlier extraction. | Working |
| Capture inbox | See independent queued, extracting, review, duplicate, blocked, failed and saved states; retry failures and save valid items individually or in a batch. | Working |
| Capture durability | Recover queued and unsent captures after navigation, refresh or API restart; preserve raw source text and evidence. | Working |
| AI job extraction | Convert job text into a reviewable structured proposal with evidence and timing before anything is saved. | Setup required: OpenAI key |
| Deterministic import | Use the core tracker and deterministic extraction without configuring AI. | Working |
| Discover | Browse a newest-first finance feed with company, role, career track, programme, location, posted/detected/checked dates, deadline, availability and direct application link. | Working |
| Discovery filters | Filter by search, buy/sell side, sector, firm type, role family, career track, programme, location, work mode, sponsorship, freshness, deadline and saved state. | Working |
| Source monitoring | Recheck approved Greenhouse and Lever sources on schedules with durable leases, source health and safe owner-requested checks that never steal an active worker's run. | Working |
| Freshness safety | Preserve first seen, last seen, last checked, changed, removed, restored and expired observations; provider pagination signals and abrupt inventory-drop quarantine prevent truncated feeds from closing jobs. | Working |
| Discovery review | Save a discovered role through the same review/evidence path as manual capture, while preventing duplicates. | Working |
| In-app alerts | Create matching rules and retain deduplicated new-role, changed-posting and deadline alerts with delivery history. | Working |
| Telegram alerts | Owners configure an encrypted destination per hosted workspace, send verified tests, and retain direct links, retries, crash-ambiguity handling and immutable delivery history without exposing the token. | Setup required: Telegram bot token and chat ID |
| System status | See backend, AI and collaboration readiness plus recent safe errors and AI-run timings. | Working |
| Secure local AI setup | Store an OpenAI key in macOS Keychain from the system panel without placing it in SQLite, source control or browser storage. | Working on macOS |
| Career Studio | Organise imported source CVs, role-specific drafts, immutable snapshots and untouched opportunities. | Working |
| CV import | Import text-based PDF, DOCX, RTF, TXT, Markdown or pasted text into reviewable profile evidence; preview the original source. | Working; scanned PDFs still need OCR or pasted text |
| Application Studio | Edit a structured A4 CV beside job context and review precise AI proposals in one role-specific workspace. | Working |
| AI targeting | Handle exact single-target, multi-target, exception and document-wide requests using resolved structured targets and evidence constraints. | Setup required: OpenAI key |
| Proposal review | Preview all pending changes, inspect word-level additions/deletions and explicitly accept, reject or undo proposals. | Working |
| CV editing | Edit sections and entries, use selection-level bold/italic, keyboard undo/redo, compact skills rows, spacing controls and one/multiple A4 pages. | Working |
| Draft safety | Autosave role-specific drafts to SQLite and reopen the latest accepted/manual state rather than rebuilding from the source CV. | Working |
| CV snapshots | Create immutable named versions with proposal decisions, parent history and exact application-material links. | Working |
| Controlled PDF | Generate a server-rendered PDF after preflight and compare rendered output with the A4 editor preview. | Working |
| Backup export | Export versioned structured data, the SQLite snapshot and associated files with sizes and checksums. | Working |
| Safe restore | Validate schema, versions, paths and checksums, drain writers, stage behind a minimal durable marker and retain encrypted backup objects outside the swapped data directory. | Working; genuine multi-restart recovery is regression-tested |
| Private sharing | Use Google sign-in, email-bound expiring invitations and owner/editor/viewer permissions for one private workspace. | Setup required: hosted Supabase/Google configuration |
| Shared editing | Use revision-aware writes, audit history, comments and realtime refresh; stale writes cannot silently overwrite newer data. | Working in preview; live Realtime setup required |
| Presence and cursors | Show online collaborators, current route/field and labelled cursors in the shared workspace. | Setup required: Supabase Realtime |
| Hosting | Deploy the Vite frontend separately from the long-running Fastify API and persistent storage. | Configuration ready; live deployment not claimed |

## Deferred After Launch Stability

| Module | Planned outcome |
| --- | --- |
| Wider discovery | Add broader big-tech, startup, consulting and design-engineering sources. |
| Browser capture | Send readable public-page content into the existing queue without creating a second import path. |
| More notifications | Add WhatsApp, email digests, quiet hours and advanced schedules. |
| Application materials | Add cover letters, portfolio notes, application answers and controlled DOCX export. |
| Public research | Add cited recruiter/contact and richer regional salary research. |
| Career landscape | Map firms, finance segments, role families, skills and outcomes as a derived graph. |
| Planning and analytics | Add preparation plans, application funnels, source effectiveness and response-time analysis. |
| Broader SaaS | Add PostgreSQL/object-storage adapters, multi-workspace administration, billing and public registration. |
| Desktop | Package the validated browser/API architecture as a Tauri application. |
