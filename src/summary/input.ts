// Вход специалиста: факты + недоверенный контент в рамке с nonce-разделителем.
// Защита от инъекций в два слоя: рамка (контент, содержащий сам разделитель, режется
// до первого вхождения) и санитизация (контрольные символы вон, кап объема).
// Числа во входе — только из фактов.
import { randomBytes } from "node:crypto";
import { sanitizeUntrusted } from "./tools";

/** Кап одного недоверенного блока (README/выдача grep/коммиты), байт. */
export const CONTENT_CAP_BYTES = 16 * 1024;

/** Контрольные символы вон, объём под капом; true = обрезано по капу. */
export function sanitizeContent(text: string, capBytes = CONTENT_CAP_BYTES): { text: string; truncated: boolean } {
  const clean = sanitizeUntrusted(text);
  if (Buffer.byteLength(clean, "utf8") <= capBytes) return { text: clean, truncated: false };
  let cut = clean;
  while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > capBytes) {
    cut = cut.slice(0, Math.floor(cut.length * 0.95));
  }
  return { text: cut, truncated: true };
}

/** Случайный на каждую генерацию: контент не может заранее подделать разделитель. */
export function makeNonce(): string {
  return randomBytes(8).toString("hex");
}

function frameStart(label: string, nonce: string): string {
  return `=== НАЧАЛО НЕДОВЕРЕННЫХ ДАННЫХ: ${label} (nonce ${nonce}) ===`;
}

function frameEnd(nonce: string): string {
  return `=== КОНЕЦ НЕДОВЕРЕННЫХ ДАННЫХ (nonce ${nonce}) ===`;
}

/**
 * Недоверенные данные помечены с обеих сторон nonce-меткой. Если в контенте
 * встретился сам nonce (или маркер рамки), контент режется ДО первого вхождения:
 * инъекция не должна выглядеть частью рамки. Пустой контент → null (блок не включается).
 */
export function frameUntrusted(label: string, content: string, nonce: string, capBytes = CONTENT_CAP_BYTES): string | null {
  if (typeof content !== "string") return null;
  const { text } = sanitizeContent(content, capBytes);
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const poisonAt = [trimmed.indexOf(nonce), trimmed.indexOf("=== КОНЕЦ НЕДОВЕРЕННЫХ"), trimmed.indexOf("=== НАЧАЛО НЕДОВЕРЕННЫХ")]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  const safe = poisonAt === undefined ? trimmed : trimmed.slice(0, poisonAt).trim();
  if (safe.length === 0) return null;
  return `${frameStart(label, nonce)}\n${safe}\n${frameEnd(nonce)}`;
}
