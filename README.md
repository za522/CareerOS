# CareerOS

CareerOS is a private career operating system for rapidly capturing opportunities, monitoring finance roles, tracking applications, and preparing evidence-backed job-specific CVs. It runs locally with SQLite and can be deployed as one invitation-only shared workspace for Zain and a collaborator.

## Run locally

Use your normal macOS Terminal for the long-running servers. Codex can edit and inspect the project, but the dev servers are more reliable when they are owned by your normal shell session.

CareerOS expects Node 22 and pnpm via Corepack.

Keep the working copy outside iCloud-managed folders. macOS may mark files inside `Documents` as `dataless`, which makes Node appear to hang while package files are downloaded. The recommended local path is `/Users/zainahmad/Developer/CareerOS`.

Copy the current project into that local path without carrying over the offloaded dependencies:

```bash
mkdir -p "/Users/zainahmad/Developer/CareerOS"
rsync -a --exclude node_modules --exclude .DS_Store \
  "/Users/zainahmad/Documents/Codex/2026-07-22/i-w/" \
  "/Users/zainahmad/Developer/CareerOS/"
cd "/Users/zainahmad/Developer/CareerOS"
```

Check your runtime:

```bash
node --version
corepack --version
```

Expected Node version:

```text
v22.x.x
```

If your default `node` is not Node 22 and you installed Node 22 with Homebrew, run:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node --version
```

Install dependencies:

```bash
cd "/Users/zainahmad/Developer/CareerOS"
corepack enable
corepack pnpm install
```

Start the API in Terminal window 1:

```bash
cd "/Users/zainahmad/Developer/CareerOS"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
corepack pnpm --filter @careeros/api dev
```

Leave this Terminal window open. A healthy API process stays running and should not return to the shell prompt. This command runs the Fastify TypeScript source in watch mode.

Expected API startup output includes:

```text
[CareerOS API] Starting Fastify on http://127.0.0.1:4310
[CareerOS API] Ready on http://127.0.0.1:4310
```

Start the web app in Terminal window 2:

```bash
cd "/Users/zainahmad/Developer/CareerOS"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
corepack pnpm --filter @careeros/web dev
```

Leave this Terminal window open too. If either dev command returns to `(base) ... %`, the server stopped; copy the last error printed in that same Terminal window.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The Fastify API runs on `http://127.0.0.1:4310` and stores its SQLite database in `data/careeros.sqlite`.

Verify both servers:

```bash
curl http://127.0.0.1:4310/health
lsof -nP -iTCP:4310 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Expected health response:

```json
{"ok":true,"service":"careeros-api","time":"..."}
```

You can also start both processes from one Terminal window:

```bash
cd "/Users/zainahmad/Developer/CareerOS"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
corepack pnpm dev
```

The two-window setup is easier to debug because the API and frontend logs stay separate.

CareerOS shows live backend, AI, capture queue, job watcher, Telegram, and collaboration health in its system control. Open it to recheck services, inspect recent errors and AI timing, or copy a diagnostic report.

## Optional AI extraction

CareerOS works without an AI provider. When OpenAI is configured, imports use deterministic cleanup followed by evidence-backed structured extraction. The Job Detail Workspace can research public compensation and open Application Studio to tailor an imported CV for the selected role. CV changes must cite stored profile evidence, appear for review, and are only saved as a new immutable version after approval.

Set the key only in the Terminal session that starts CareerOS:

```bash
export OPENAI_API_KEY="your-key-here"
export CAREEROS_AI_MODEL="gpt-5.6-terra"
corepack pnpm dev
```

For a safer Terminal prompt that does not echo or save the key, stop any currently running CareerOS command and run:

```bash
cd "/Users/zainahmad/Developer/CareerOS"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
corepack pnpm dev:ai
```

Paste the key when prompted and press Enter. On macOS, you can instead open the CareerOS system control, paste the key once, and choose `Save to Keychain`. The API stores it in macOS Keychain, immediately enables AI, and never returns the secret to the browser. Hosted deployments must keep the key in the API host's encrypted environment settings.

Hosted Telegram is connected per workspace from `Discover > Telegram`. Set a separate server-only `CAREEROS_INTEGRATION_ENCRYPTION_KEY` (`openssl rand -base64 32`) and a public `CAREEROS_APP_URL` before setup. To rotate the encryption key without interrupting alerts, move the old value to `CAREEROS_INTEGRATION_ENCRYPTION_KEY_PREVIOUS`, set a new current key, deploy, and let CareerOS re-encrypt each workspace on first use. Remove the previous key only after every workspace has been read successfully. Local single-user mode may continue to use `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in its private environment.

Optional provider settings:

```bash
export OPENAI_BASE_URL="https://api.openai.com/v1"
export CAREEROS_AI_TIMEOUT_MS="20000"
```

Do not put an API key in committed source files. If the provider is unavailable, times out, returns malformed data, or provides fields without matching source evidence, CareerOS reports the failure without saving a proposal. Salary research uses OpenAI web search, retains only retrieved public numerical evidence, and stores the evidence links with an accepted estimate.

Useful checks:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

The urgent shared release includes a durable rapid-capture queue, finance discovery and freshness monitoring, in-app and optional Telegram alerts, the Opportunities tracker, Application Studio with controlled PDF output, checksum-validated backup/restore, and invitation-only collaboration. See `CURRENT_FUNCTIONALITY.md` for the exact user-facing status, `TESTING_GUIDE.md` for release workflows, and `HOSTED_RELEASE.md` for production configuration.
