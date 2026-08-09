import pg from "pg";
import postgres from "postgres";

const harnessPid = Number(process.env.CAREEROS_E2E_PARENT_PID || 0);
if (Number.isInteger(harnessPid) && harnessPid > 1) {
  const parentWatch = setInterval(() => {
    try {
      process.kill(harnessPid, 0);
    } catch {
      process.kill(process.pid, "SIGTERM");
    }
  }, 500);
  parentWatch.unref();
}

const nativeFetch = globalThis.fetch.bind(globalThis);
const discoveryControlUrl = process.env.CAREEROS_HOSTED_E2E_DISCOVERY_CONTROL_URL;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (discoveryControlUrl && url.hostname === "boards-api.greenhouse.io" && /^\/v1\/boards\/careeros-e2e\/jobs\/?$/.test(url.pathname)) {
    const fixtureUrl = new URL(discoveryControlUrl);
    fixtureUrl.searchParams.set("fixture", url.searchParams.get("e2e") || "default");
    return nativeFetch(fixtureUrl, init);
  }
  return nativeFetch(input, init);
};

class HostedE2EClient {
  constructor(sql, releaseLease) {
    this.sql = sql;
    this.releaseLease = releaseLease;
    this.released = false;
  }

  async query(text, values = []) {
    const rows = await this.sql.unsafe(text, values);
    return {
      rows: Array.from(rows),
      rowCount: rows.count ?? rows.length,
      command: rows.command,
    };
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.releaseLease();
  }
}

class HostedE2ESingleConnectionPool {
  constructor(options = {}) {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Hosted E2E PostgreSQL URL is missing.");
    this.sql = postgres(connectionString, { max: 1, prepare: false });
    this.leaseTail = Promise.resolve();
  }

  async connect() {
    const previousLease = this.leaseTail;
    let releaseLease;
    this.leaseTail = new Promise((resolve) => { releaseLease = resolve; });
    await previousLease;
    return new HostedE2EClient(this.sql, releaseLease);
  }

  async end() {
    await this.sql.end({ timeout: 1 });
  }
}

// The shim is preloaded only by scripts/hosted-e2e-stack.ts. Production keeps
// using node-postgres through the unchanged PostgresCloudDataProvider.
pg.Pool = HostedE2ESingleConnectionPool;
