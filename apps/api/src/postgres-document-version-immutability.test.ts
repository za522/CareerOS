import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCloudMigrations } from "./postgres/migrations.js";

const databases: PGlite[] = [];

async function seededDatabase() {
  const database = new PGlite();
  databases.push(database);
  for (const migration of await discoverCloudMigrations()) await database.exec(migration.sql);
  await database.exec(`
    INSERT INTO workspaces(id,name) VALUES('11111111-1111-4111-8111-111111111111','CareerOS');
    INSERT INTO documents(id,workspace_id,document_type,title,mime_type)
      VALUES('document-1','11111111-1111-4111-8111-111111111111','cv','Master CV','application/pdf');
    INSERT INTO document_versions(id,workspace_id,document_id,version,plain_text)
      VALUES('version-1','11111111-1111-4111-8111-111111111111','document-1',1,'Immutable CV');
  `);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("document version immutability", () => {
  it("requires PDF path and checksum to be finalised atomically and exactly once", async () => {
    const database = await seededDatabase();

    await expect(database.exec("UPDATE document_versions SET checksum='staged' WHERE id='version-1'"))
      .rejects.toThrow(/finalised atomically/i);
    await expect(database.exec("UPDATE document_versions SET relative_path='documents/version-1.pdf' WHERE id='version-1'"))
      .rejects.toThrow(/finalised atomically/i);

    await expect(database.exec(`UPDATE document_versions SET relative_path='documents/version-1.pdf',checksum='${"a".repeat(64)}' WHERE id='version-1'`))
      .resolves.toBeDefined();
    await expect(database.exec("UPDATE document_versions SET checksum='different' WHERE id='version-1'"))
      .rejects.toThrow(/finalised atomically/i);
    await expect(database.exec("UPDATE document_versions SET relative_path='',checksum='' WHERE id='version-1'"))
      .rejects.toThrow(/finalised atomically/i);
  });

  it("rejects content mutation and deletion while allowing one submission timestamp", async () => {
    const database = await seededDatabase();
    await expect(database.exec("UPDATE document_versions SET plain_text='Changed' WHERE id='version-1'"))
      .rejects.toThrow(/content is immutable/i);
    await expect(database.exec("DELETE FROM document_versions WHERE id='version-1'"))
      .rejects.toThrow(/versions are immutable/i);
    await expect(database.exec("UPDATE document_versions SET submitted_at=now() WHERE id='version-1'"))
      .resolves.toBeDefined();
    await expect(database.exec("UPDATE document_versions SET submitted_at=now()+interval '1 second' WHERE id='version-1'"))
      .rejects.toThrow(/submission is immutable/i);
  });
});
