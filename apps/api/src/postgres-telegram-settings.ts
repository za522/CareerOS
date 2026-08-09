import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { TelegramSettingsStatus } from "@careeros/contracts";
import type { TransactionManager, WorkspaceContext } from "./postgres/contracts.js";

type Row = Record<string, unknown>;
export type ResolvedTelegramSettings = { botToken: string; chatId: string };

function encryptionKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("CAREEROS_INTEGRATION_ENCRYPTION_KEY is required for hosted Telegram setup.");
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("CAREEROS_INTEGRATION_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hexadecimal key.");
}

function fingerprint(key: Buffer) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function keyRing(current: string, previous: string | readonly string[] = []) {
  const values: readonly string[] = typeof previous === "string" ? previous.split(",") : previous;
  const keys = [encryptionKey(current), ...values.map((value) => value.trim()).filter(Boolean).map(encryptionKey)];
  return [...new Map(keys.map((key) => [fingerprint(key), key])).values()];
}

function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(ciphertext: string, iv: string, tag: string, key: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

const text = (row: Row, key: string) => String(row[key] ?? "");
const timestamp = (value: unknown) => value == null ? null : value instanceof Date ? value.toISOString() : String(value);
const hint = (chatId: string) => chatId.length <= 4 ? "••••" : `••••${chatId.slice(-4)}`;

export class PostgresTelegramSettingsRepository {
  private readonly key: Buffer;
  private readonly keys: Buffer[];

  constructor(private readonly transactions: TransactionManager, integrationKey: string, previousKeys: string | readonly string[] = []) {
    this.keys = keyRing(integrationKey, previousKeys);
    this.key = this.keys[0]!;
  }

  async status(context: WorkspaceContext): Promise<TelegramSettingsStatus> {
    return this.transactions.transaction(context, async (tx) => {
      const row = (await tx.query<Row>("SELECT chat_id_hint,last_tested_at,last_successful_test_at,last_error,updated_at FROM telegram_integrations WHERE workspace_id=$1", [context.workspaceId])).rows[0];
      return {
        hosted: true,
        configured: Boolean(row),
        chatIdHint: row ? text(row, "chat_id_hint") : "",
        lastTestedAt: timestamp(row?.last_tested_at),
        lastSuccessfulTestAt: timestamp(row?.last_successful_test_at),
        lastError: row ? text(row, "last_error") : "",
        updatedAt: timestamp(row?.updated_at),
      };
    }, { readOnly: true });
  }

  async save(context: WorkspaceContext, input: ResolvedTelegramSettings): Promise<TelegramSettingsStatus> {
    const token = encrypt(input.botToken, this.key);
    const chat = encrypt(input.chatId, this.key);
    await this.transactions.transaction(context, async (tx) => {
      await tx.query(`INSERT INTO telegram_integrations
        (workspace_id,bot_token_ciphertext,bot_token_iv,bot_token_tag,chat_id_ciphertext,chat_id_iv,chat_id_tag,chat_id_hint,key_fingerprint,configured_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(workspace_id) DO UPDATE SET bot_token_ciphertext=excluded.bot_token_ciphertext,bot_token_iv=excluded.bot_token_iv,
          bot_token_tag=excluded.bot_token_tag,chat_id_ciphertext=excluded.chat_id_ciphertext,chat_id_iv=excluded.chat_id_iv,
          chat_id_tag=excluded.chat_id_tag,chat_id_hint=excluded.chat_id_hint,key_fingerprint=excluded.key_fingerprint,
          configured_by_user_id=excluded.configured_by_user_id,last_tested_at=NULL,last_error='',updated_at=now()`, [
        context.workspaceId, token.ciphertext, token.iv, token.tag, chat.ciphertext, chat.iv, chat.tag, hint(input.chatId),
        fingerprint(this.key), context.userId,
      ]);
      await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
        VALUES($1,$2,$3,'integration.telegram.updated','TelegramIntegration',$2,'Updated encrypted Telegram settings','{}'::jsonb)`,
      [randomUUID(), context.workspaceId, context.userId]);
    });
    return this.status(context);
  }

  async resolve(context: WorkspaceContext): Promise<ResolvedTelegramSettings | null> {
    return this.transactions.transaction(context, async (tx) => {
      const row = (await tx.query<Row>("SELECT * FROM telegram_integrations WHERE workspace_id=$1", [context.workspaceId])).rows[0];
      if (!row) return null;
      const storedFingerprint = text(row, "key_fingerprint");
      const orderedKeys = [...this.keys].sort((left, right) => Number(fingerprint(right) === storedFingerprint) - Number(fingerprint(left) === storedFingerprint));
      for (const candidate of orderedKeys) {
        let resolved: ResolvedTelegramSettings;
        try {
          resolved = {
            botToken: decrypt(text(row, "bot_token_ciphertext"), text(row, "bot_token_iv"), text(row, "bot_token_tag"), candidate),
            chatId: decrypt(text(row, "chat_id_ciphertext"), text(row, "chat_id_iv"), text(row, "chat_id_tag"), candidate),
          };
        } catch {
          continue;
        }
        if (fingerprint(candidate) !== fingerprint(this.key)) {
          const token = encrypt(resolved.botToken, this.key);
          const chat = encrypt(resolved.chatId, this.key);
          await tx.query(`UPDATE telegram_integrations SET
            bot_token_ciphertext=$2,bot_token_iv=$3,bot_token_tag=$4,
            chat_id_ciphertext=$5,chat_id_iv=$6,chat_id_tag=$7,key_fingerprint=$8,updated_at=now()
            WHERE workspace_id=$1`, [context.workspaceId, token.ciphertext, token.iv, token.tag, chat.ciphertext, chat.iv, chat.tag, fingerprint(this.key)]);
        }
        return resolved;
      }
      throw new Error("Telegram credentials could not be decrypted. Add the previous integration key or re-save the workspace settings.");
    });
  }

  async recordTest(context: WorkspaceContext, error = "") {
    await this.transactions.transaction(context, async (tx) => {
      await tx.query(`UPDATE telegram_integrations SET last_tested_at=now(),
        last_successful_test_at=CASE WHEN $2='' THEN now() ELSE last_successful_test_at END,
        last_error=$2,updated_at=now() WHERE workspace_id=$1`, [context.workspaceId, error.slice(0, 2_000)]);
    });
  }

  async remove(context: WorkspaceContext): Promise<TelegramSettingsStatus> {
    await this.transactions.transaction(context, async (tx) => {
      await tx.query("DELETE FROM telegram_integrations WHERE workspace_id=$1", [context.workspaceId]);
      await tx.query(`INSERT INTO audit_events(id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json)
        VALUES($1,$2,$3,'integration.telegram.removed','TelegramIntegration',$2,'Removed Telegram settings','{}'::jsonb)`,
      [randomUUID(), context.workspaceId, context.userId]);
    });
    return this.status(context);
  }
}
