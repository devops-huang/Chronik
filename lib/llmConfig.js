/**
 * lib/llmConfig.js — 管理员 LLM 配置（加密持久化）
 *
 * 设计要点：
 * - apiKey 以 AES-256-GCM 加密后落盘到 data/llm-config.json，明文不写入磁盘/前端。
 * - 加密密钥：优先使用 env LLM_CFG_SECRET；否则使用自动持久化的 data/.cfgsecret（首次运行生成，权限 600）。
 * - 前端 GET 接口只返回脱敏后的 key（maskKey），普通用户无任何配置入口。
 */
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CFG_FILE = join(DATA_DIR, 'llm-config.json');
const SECRET_FILE = join(DATA_DIR, '.cfgsecret');
const ALGO = 'aes-256-gcm';

function getKey() {
  let secret = process.env.LLM_CFG_SECRET;
  if (!secret) {
    if (existsSync(SECRET_FILE)) {
      secret = readFileSync(SECRET_FILE, 'utf8').trim();
    } else {
      secret = randomBytes(24).toString('hex');
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    }
  }
  return createHash('sha256').update(secret).digest();
}

function encryptText(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

function decryptText(o) {
  if (!o || !o.iv || !o.tag || !o.ct) return '';
  try {
    const c = createDecipheriv(ALGO, getKey(), Buffer.from(o.iv, 'base64'));
    c.setAuthTag(Buffer.from(o.tag, 'base64'));
    const pt = Buffer.concat([c.update(Buffer.from(o.ct, 'base64')), c.final()]);
    return pt.toString('utf8');
  } catch {
    return '';
  }
}

/** 返回 { baseUrl, apiKey, model, updatedAt } 或 null（未配置/损坏） */
export function loadLlmConfig() {
  if (!existsSync(CFG_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(CFG_FILE, 'utf8'));
    if (!j.baseUrl || !j.apiKeyEnc || !j.model) return null;
    return {
      baseUrl: j.baseUrl,
      apiKey: decryptText(j.apiKeyEnc),
      model: j.model,
      updatedAt: j.updatedAt || null,
    };
  } catch {
    return null;
  }
}

/** 保存（加密）管理员配置 */
export function saveLlmConfig({ baseUrl, apiKey, model }) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const payload = {
    baseUrl: (baseUrl || '').trim(),
    apiKeyEnc: encryptText(apiKey || ''),
    model: (model || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(CFG_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/** 脱敏展示：sk-****1234 */
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}
