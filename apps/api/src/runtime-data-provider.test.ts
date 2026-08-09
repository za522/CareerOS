import { describe, expect, it } from "vitest";
import { configuredDataProvider, postgresRouteConverted, postgresRouteRequiresConversion } from "./runtime-data-provider.js";

describe("runtime data provider contract", () => {
  it("defaults local development to SQLite", () => expect(configuredDataProvider({ NODE_ENV: "development" })).toBe("sqlite"));
  it("defaults hosted and production runtimes to PostgreSQL", () => {
    expect(configuredDataProvider({ CAREEROS_HOSTED: "1" })).toBe("postgres");
    expect(configuredDataProvider({ NODE_ENV: "production" })).toBe("postgres");
  });
  it("fails closed when hosted mode explicitly requests SQLite", () => {
    expect(() => configuredDataProvider({ CAREEROS_HOSTED: "1", CAREEROS_DATA_PROVIDER: "sqlite" })).toThrow(/requires.*postgres/i);
  });
  it("rejects unknown providers", () => expect(() => configuredDataProvider({ CAREEROS_DATA_PROVIDER: "mysql" })).toThrow(/sqlite or postgres/i));

  it("allows SQLite hosted behavior only for the explicit disposable E2E fixture", () => {
    expect(configuredDataProvider({ NODE_ENV: "test", CAREEROS_HOSTED: "1", CAREEROS_E2E_AUTH: "1", CAREEROS_DATA_PROVIDER: "sqlite" })).toBe("sqlite");
    expect(() => configuredDataProvider({ NODE_ENV: "test", CAREEROS_HOSTED: "1", CAREEROS_DATA_PROVIDER: "sqlite" })).toThrow(/requires.*postgres/i);
    expect(() => configuredDataProvider({ NODE_ENV: "production", CAREEROS_E2E_AUTH: "1", CAREEROS_DATA_PROVIDER: "sqlite" })).toThrow(/requires.*postgres/i);
  });
  it("only exposes converted slices in PostgreSQL mode", () => {
    expect(postgresRouteConverted("/api/jobs")).toBe(true);
    expect(postgresRouteConverted("/api/jobs/role-1")).toBe(true);
    expect(postgresRouteConverted("/api/jobs/job-1/tasks")).toBe(true);
    expect(postgresRouteConverted("/api/jobs/job-1/applications")).toBe(true);
    expect(postgresRouteConverted("/api/tasks/task-1")).toBe(true);
    expect(postgresRouteConverted("/api/applications/application-1/events")).toBe(true);
    expect(postgresRouteConverted("/api/auth/session")).toBe(true);
    expect(postgresRouteConverted("/api/meta")).toBe(true);
    expect(postgresRouteConverted("/api/capture-queue?limit=50")).toBe(true);
    expect(postgresRouteConverted("/api/capture-queue/commit-batch")).toBe(true);
    expect(postgresRouteConverted("/api/capture-drafts/draft-1/enqueue")).toBe(true);
    expect(postgresRouteConverted("/api/imports")).toBe(false);
    expect(postgresRouteConverted("/api/discovery")).toBe(true);
    expect(postgresRouteConverted("/api/export")).toBe(true);
    expect(postgresRouteConverted("/api/restore")).toBe(true);
    expect(postgresRouteConverted("/api/jobs/job-1/application-studio")).toBe(true);
    expect(postgresRouteConverted("/api/jobs/job-1/recheck")).toBe(false);
  });

  it("never blocks the hosted React shell or its static assets", () => {
    expect(postgresRouteRequiresConversion("/")).toBe(false);
    expect(postgresRouteRequiresConversion("/opportunities")).toBe(false);
    expect(postgresRouteRequiresConversion("/assets/index.js")).toBe(false);
    expect(postgresRouteRequiresConversion("/api/imports")).toBe(true);
  });
});
