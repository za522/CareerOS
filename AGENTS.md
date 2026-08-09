# CareerOS Agent Working Agreement

- The owner authorises coding agents to read, create, edit, move, and test files required for CareerOS across this repository and its local data adapters.
- Do not ask the owner to edit project files, run routine repository commands, or approve ordinary reads, writes, builds, tests, migrations, and bounded local browser verification. Perform that work directly.
- Do not request elevated sandbox access when the active environment already grants filesystem and command access.
- Preserve user data before migrations and verify it afterward. Never perform destructive data removal, publish externally, spend money, or change user-owned service accounts without an explicit request.
- Full access is not permission to perform disk cleanup. Never delete or empty caches, temporary directories, package-manager stores, browser profiles, build artifacts outside this repository, or unrelated files to recover space or speed up tests. Stop the affected test and report the constraint instead.
- Critique agents are read-only unless explicitly assigned a bounded source patch. They must not clean `/private/var/folders`, `~/.cache`, `~/Library/Caches`, package-manager caches, or any other user/system location.
- Keep credentials out of source control, logs, browser storage, exports, screenshots, and agent messages.
- Start development servers only for bounded verification and stop them afterward unless the owner explicitly asks for a persistent local session.
- Work within the existing React, Fastify, TypeScript, Drizzle, Zod, SQLite, and `CareerOSClient` architecture. Do not introduce duplicate backends or workaround runtime paths without explicit approval.
