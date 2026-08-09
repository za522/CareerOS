import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[]=[];
afterEach(()=>{for(const path of cleanup.splice(0))rmSync(path,{recursive:true,force:true});});

describe("PostgreSQL compatibility import",()=>{
  it("does not create, restore, migrate, or open a local SQLite database",()=>{
    const root=mkdtempSync(join(tmpdir(),"careeros-postgres-inert-"));cleanup.push(root);const data=join(root,"must-not-exist");
    const output=execFileSync(process.execPath,["--import","tsx","--input-type=module","--eval",`const module=await import(${JSON.stringify(new URL("./db.ts",import.meta.url).href)});console.log(JSON.stringify({compatibility:module.sqliteCompatibilityMode,tables:module.sqlite.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count}));module.sqlite.close();`],{cwd:process.cwd(),env:{...process.env,CAREEROS_DATA_PROVIDER:"postgres",CAREEROS_HOSTED:"1",CAREEROS_DATA_DIR:data},encoding:"utf8"});
    expect(JSON.parse(output.trim())).toEqual({compatibility:true,tables:0});expect(existsSync(data)).toBe(false);expect(existsSync(join(data,"careeros.sqlite"))).toBe(false);
  });

  it("tightens an existing local data tree before opening SQLite",()=>{
    const root=mkdtempSync(join(tmpdir(),"careeros-private-data-"));cleanup.push(root);const data=join(root,"data"),documents=join(data,"documents"),file=join(documents,"cv.pdf");
    mkdirSync(documents,{recursive:true,mode:0o755});writeFileSync(file,"private CV",{mode:0o644});chmodSync(data,0o755);chmodSync(documents,0o755);chmodSync(file,0o644);
    const output=execFileSync(process.execPath,["--import","tsx","--input-type=module","--eval",`const module=await import(${JSON.stringify(new URL("./db.ts",import.meta.url).href)});module.sqlite.close();console.log("closed");`],{cwd:process.cwd(),env:{...process.env,CAREEROS_DATA_PROVIDER:"sqlite",CAREEROS_HOSTED:"0",NODE_ENV:"test",CAREEROS_DATA_DIR:data},encoding:"utf8"});
    expect(output.trim()).toContain("closed");expect(statSync(data).mode&0o777).toBe(0o700);expect(statSync(documents).mode&0o777).toBe(0o700);expect(statSync(file).mode&0o777).toBe(0o600);expect(statSync(join(data,"careeros.sqlite")).mode&0o777).toBe(0o600);
  });
});
