// yamlmini.ts — мини-парсер YAML-подмножества для has_steps
// (cicd.configs, В2/Б1): вложенные отображения, последовательности
// скаляров и отображений, скаляры (строки/числа/булевы), flow-списки
// [a, b], комментарии. Полный YAML НЕ поддерживается — только форма
// .sourcecraft/ci.yaml (образец — наш конфиг). Ошибка парсинга —
// throw; вызывающий ловит и честно пишет steps_note.
export function parseYamlSubset(src: string): unknown {
  const lines: { indent: number; text: string }[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    if (noComment.slice(0, indent).includes("\t")) throw new Error("yamlmini: tabs in indentation");
    lines.push({ indent, text: noComment.trim() });
  }
  if (lines.length === 0) return {};
  const { value, next } = parseBlock(lines, 0, lines[0]!.indent);
  if (next < lines.length) throw new Error(`yamlmini: unexpected content at line ${next + 1}`);
  return value;
}

export function stripComment(line: string): string {
  // строка-комментарий целиком (в том числе с `#` в первой колонке — аудит
  // В5.3, A4: 714 публичных ci.yaml начинались с комментария и читались как
  // «CI без шагов»)
  if (/^\s*#/.test(line)) return "";
  // '#' после пробела (в наших значениях '#' не встречается)
  const m = line.match(/^(\s*)(.*?)\s#.*$/);
  if (m && !m[2].startsWith('"') && !m[2].startsWith("'")) return m[1]! + m[2];
  return line.replace(/\s+$/, "");
}

interface Line {
  indent: number;
  text: string;
}

/** Блок на фиксированном отступе: последовательность «- » или отображение. */
function parseBlock(lines: Line[], i: number, indent: number): { value: unknown; next: number } {
  if (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-") return parseSequence(lines, i, indent);
  return parseMapping(lines, i, indent);
}

const BLOCK_INDICATOR = /^(?:\||>)[+-]?$/;

/**
 * Блочный скаляр (| / |- / > …): все следующие строки с отступом глубже
 * minIndent — тело; значение {__block: text}. Живой кейс: script-кубы
 * ci.yaml платформы (cloudapp-hugo: `- |` + многострочные команды).
 */
function parseBlockScalar(lines: Line[], start: number, minIndent: number): { value: { __block: string }; next: number } {
  if (start >= lines.length || lines[start]!.indent <= minIndent) {
    return { value: { __block: "" }, next: start };
  }
  const contentIndent = lines[start]!.indent;
  const parts: string[] = [];
  let j = start;
  while (j < lines.length && lines[j]!.indent >= contentIndent) {
    parts.push(lines[j]!.text);
    j++;
  }
  return { value: { __block: parts.join("\n") }, next: j };
}

function parseSequence(lines: Line[], i: number, indent: number): { value: unknown[]; next: number } {
  const out: unknown[] = [];
  while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-")) {
    const rest = lines[i]!.text === "-" ? "" : lines[i]!.text.slice(2).trim();
    if (rest === "") {
      // значение элемента — вложенный блок следующих строк (отступ глубже)
      if (i + 1 < lines.length && lines[i + 1]!.indent > indent) {
        const r = parseBlock(lines, i + 1, lines[i + 1]!.indent);
        out.push(r.value);
        i = r.next;
      } else {
        out.push(null);
        i++;
      }
    } else if (BLOCK_INDICATOR.test(rest)) {
      // «- |» — блочный скаляр как элемент последовательности
      const r = parseBlockScalar(lines, i + 1, indent);
      out.push(r.value);
      i = r.next;
    } else if (isInlineMappingStart(rest)) {
      // «- key: value» — первая пара отображения, продолжение глубже
      const sub: Line[] = [{ indent: indent + 2, text: rest }];
      i++;
      while (i < lines.length && lines[i]!.indent > indent) sub.push(lines[i++]!);
      const r = parseMapping(sub, 0, indent + 2);
      out.push(r.value);
    } else {
      out.push(parseScalar(rest));
      i++;
    }
  }
  return { value: out, next: i };
}

function parseMapping(lines: Line[], i: number, indent: number): { value: Record<string, unknown>; next: number } {
  const out: Record<string, unknown> = {};
  while (i < lines.length && lines[i]!.indent === indent && !lines[i]!.text.startsWith("- ")) {
    const { key, inline } = splitKey(lines[i]!.text);
    if (key === null) throw new Error(`yamlmini: bad mapping line "${lines[i]!.text}"`);
    if (inline === "") {
      if (i + 1 < lines.length && lines[i + 1]!.indent > indent) {
        const r = parseBlock(lines, i + 1, lines[i + 1]!.indent);
        out[key] = r.value;
        i = r.next;
      } else if (i + 1 < lines.length && lines[i + 1]!.indent === indent && lines[i + 1]!.text.startsWith("- ")) {
        // последовательность на ТОМ ЖЕ отступе — легальная YAML-форма
        const r = parseSequence(lines, i + 1, indent);
        out[key] = r.value;
        i = r.next;
      } else {
        out[key] = null;
        i++;
      }
    } else if (BLOCK_INDICATOR.test(inline)) {
      // «key: |» — блочный скаляр как значение ключа
      const r = parseBlockScalar(lines, i + 1, indent);
      out[key] = r.value;
      i = r.next;
    } else {
      out[key] = parseScalar(inline);
      i++;
    }
  }
  return { value: out, next: i };
}

function isInlineMappingStart(rest: string): boolean {
  return splitKey(rest).key !== null;
}

/** «key: value» | «key:» → {key, inline}; null если не ключ. */
function splitKey(text: string): { key: string | null; inline: string } {
  const m = text.match(/^("([^"]*)"|'([^']*)'|[^:\s][^:]*?)\s*:(\s+(.*))?$/);
  if (!m) return { key: null, inline: "" };
  const key = m[2] ?? m[3] ?? m[1]!;
  return { key, inline: (m[4] ?? "").trim() };
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return null;
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((p) => parseScalar(p.trim()));
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
