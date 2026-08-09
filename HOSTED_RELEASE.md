# CareerOS Hosted Release

The private launch is deployed as one same-origin Render service. Fastify serves the built React application and the API from the same HTTPS origin. This is required for the secure invitation handoff and encrypted `HttpOnly` Google-session cookie, and it keeps the scheduler on a long-lived process with durable storage.

`render.yaml` deliberately uses a paid Starter web service and a persistent Basic PostgreSQL database. A free web service sleeps, cannot attach a persistent disk, and cannot provide dependable continuous monitoring. A free Render PostgreSQL database expires after 30 days and has no managed backups. Creating the Blueprint therefore starts billable Render resources; review current Render pricing before confirming deployment. Preview tests remain local and do not create cloud resources.

The included Vercel configuration is suitable only for unauthenticated interface previews. Do not use a separately hosted Vercel frontend for the private shared release unless it proxies every `/api` and `/health` request through the same public origin.

## Required configuration

1. Create a Supabase project and enable Google authentication.
2. Run `supabase/realtime-policies.sql` in the Supabase SQL editor. It creates the private membership mirror and Realtime topic policies.
3. Add the Render service URL to the Google and Supabase redirect allowlists.
4. Deploy the repository using `render.yaml`; its Docker image builds both React and Fastify, and Render attaches the persistent disk.
5. Generate separate 32-byte values for `CAREEROS_SESSION_ENCRYPTION_KEY`, `CAREEROS_BACKUP_ENCRYPTION_KEY` and `CAREEROS_INTEGRATION_ENCRYPTION_KEY` and store them only in Render's encrypted environment settings.
6. Set every hosted variable shown in `.env.example`. Set `SUPABASE_SERVICE_ROLE_KEY` only on Render, then set `CAREEROS_REALTIME_ENABLED=1`. Realtime refuses to enable without this server-only key.
7. Leave `VITE_API_URL` unset for the hosted build so the browser uses same-origin `/api` requests.

API keys belong only in Render's encrypted environment settings. A workspace owner connects Telegram inside Discover; CareerOS encrypts that workspace's bot token and chat ID with `CAREEROS_INTEGRATION_ENCRYPTION_KEY`. A valid public `CAREEROS_APP_URL` is required before a test can claim its direct link works. For key rotation, set the new current key and temporarily set the old value in `CAREEROS_INTEGRATION_ENCRYPTION_KEY_PREVIOUS`; credentials are re-encrypted with the current key on first use. The token is never returned to the browser and Telegram integrations are excluded from exports and backups. Do not add integration credentials to frontend variables, source control, browser storage or invitation links. Supabase refresh credentials are rotated by Fastify and sealed into an authenticated `HttpOnly`, `SameSite=Strict` cookie; the React application keeps only the current in-memory access session.

Hosted documents use the Supabase `career-files` bucket. Encrypted scheduled backups use `/var/lib/careeros/backups`, which is inside the Render persistent disk mounted at `/var/lib/careeros`, and are configured through the separate `CAREEROS_BACKUP_STORAGE_*` settings. This keeps primary files and automatic backups out of the same storage-provider failure domain. For a second off-provider copy, download a verified encrypted bundle from CareerOS and retain it separately.

The service-role key is used only by Fastify to mirror accepted, changed, and removed workspace memberships into `public.careeros_workspace_members`. The API never returns it. Authenticated browsers can read only their own membership row and cannot write membership rows. Private Realtime topics use `careeros:<workspace-id>` and are authorised by those rows.

## Verification

- `/health` responds from the hosted API.
- An uninvited Google account receives `403` for workspace data.
- The owner can create an expiring invitation; only its exact verified Google email can accept it.
- Viewers cannot write. Editors cannot restore backups, manage secrets, or invite members.
- Two browser sessions see the same durable records and stale writes receive `409` instead of silently overwriting.
- `/api/auth/config` reports `realtimeEnabled: true` only after server-side membership synchronisation is configured.
- An owner can connect and test a workspace-specific Telegram destination; editors and viewers cannot read or replace it.
- A Telegram test reports success only after Telegram confirms delivery and the delivery history records it.

After a restore is accepted, the process becomes read-only and the interface must be restarted before further use. This prevents work created after the verified restore point from being silently lost.

PostgreSQL discovery claims, notification claims and workspace writes use database-backed leases or revision checks. Scale beyond one instance only after running the hosted lifecycle suite against the production PostgreSQL provider and object store.
