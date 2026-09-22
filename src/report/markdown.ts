// markdown.ts — MD-выгрузка отчёта по карточке (В3; В4.7, контракт П1; В4.9, К9.6).
//
// Модель блоков строит `build.ts` (общая для MD и PDF), здесь — только
// сериализация в Markdown. Правила К9.6: первый экран строкой
// `**70 из 100 · здоров**`, шкала и вклады словами, H2 как навигация, без
// HTML, таблицы основного текста не шире 4 колонок. Документ самодостаточен:
// его можно читать без сервиса (SourceCraft и GitHub рендерят его как есть).
import type { RepoCard } from "../api/repos";
import { SECURITY_PUBLIC_NOTE } from "../web/format";
import { buildReportModel } from "./build";
import type { Block, Inline, InlineLine, ReportModel, TableColumn } from "./model";

export { SECURITY_PUBLIC_NOTE, buildReportModel };

/** MD-отчёт карточки: модель → markdown. */
export function renderRepoReport(card: RepoCard): string {
  return serializeMarkdown(buildReportModel(card));
}

/** Модель → markdown: каждый блок, затем пустая строка; хвост обрезан до одного перевода строки. */
export function serializeMarkdown(model: ReportModel): string {
  const lines: string[] = [];
  for (const block of model.blocks) lines.push(...blockLines(block), "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const tableLines = (columns: TableColumn[], rows: InlineLine[][]): string[] => [
  `| ${columns.map((c) => c.title).join(" | ")} |`,
  `|${columns.map((c) => (c.align === "right" ? "---:" : "---")).join("|")}|`,
  ...rows.map((row) => `| ${row.map((cellLine) => cellMd(lineMd(cellLine))).join(" | ")} |`),
];

function blockLines(block: Block): string[] {
  switch (block.kind) {
    case "heading":
      return [`${"#".repeat(block.level)} ${lineMd(block.content)}`];
    case "paragraph":
      // К9.6: строки абзаца — отдельными абзацами MD (пустая строка между ними):
      // перенос «два пробела в конце» теряется в редакторах и просмотрщиках
      return [block.lines.map(lineMd).join("\n\n")];
    case "list":
      return block.items.map((item) => `- ${lineMd(item)}`);
    case "table":
      return tableLines(block.columns, block.rows);
    case "header": {
      const out = [`# ${mdEscape(block.slug)}`];
      if (block.title) out.push("", lineMd(block.title));
      // п.1 круга 2: в PDF плашка доступа стоит ПОСЛЕ даты, второй строкой —
      // MD держит тот же порядок слов (сверка «текст PDF = текст MD»)
      const chip = block.docChip ? ` (${block.docChip.text.toLowerCase()})` : "";
      out.push("", `[${mdEscape(block.link.text)}](${block.link.url})`, "", `${block.doc}.${block.date ? ` ${block.date}${chip}.` : `${chip}`}`);
      return out;
    }
    case "hero": {
      // В6: второй показатель в PDF стоит справа в том же ряду; в MD ряда нет —
      // он идет следующей строкой тем же шаблоном, с подписью через тире.
      const metric = (label: string, value: number | null, noneText: string, chipText: string | null): string =>
        `${label}: ${value === null ? `**${noneText}**` : `**${value} из 100 · ${chipText}**`}`;
      const out = [metric(block.label, block.value, block.noneText, block.chip?.text.toLowerCase() ?? null)];
      if (block.secondary) {
        const s = block.secondary;
        out.push("", `${metric(s.label, s.value, s.noneText, s.chip?.text.toLowerCase() ?? null)}${s.note ? ` – ${s.note}.` : ""}`);
      }
      if (block.verdict) out.push("", block.verdict);
      for (const note of block.notes) out.push("", lineMd(note.line));
      return out;
    }
    case "contributions": {
      const out = [`## ${block.title}`, ""];
      if (block.note !== null) {
        out.push(block.note);
      } else {
        const parts = block.segments.map((s) => `${s.title} ${s.value}`);
        if (block.rest) parts.push(`${block.rest.title} ${block.rest.value}`);
        out.push(parts.join(" · "));
      }
      // п.5 круга 2: подписи зон под шкалой убраны (в PDF осталась цветная
      // полоска без слов); словесная шкала целиком есть в «Как считается»
      return out;
    }
    case "coverage":
      return [`## ${block.title}`, "", `${block.collected} · ${block.thresholdText}`];
    case "categories":
      return tableLines(
        [
          { title: block.columns[0], align: "left" },
          { title: block.columns[1], align: "right" },
          { title: block.columns[2], align: "left" },
          { title: block.columns[3], align: "left" },
        ],
        block.rows.map((r) => [[{ kind: "text", text: r.name }], [{ kind: "text", text: r.scoreText }], [{ kind: "text", text: r.chip.text.toLowerCase() }], [{ kind: "text", text: r.why }]]),
      );
    case "actions":
      return block.items.map((a) => {
        const title = lineMd(a.title);
        const why = lineMd(a.why);
        const eff = mdEscape(a.effect);
        // В16 гейта: подпись эффекта — перед числом, как в PDF
        const effect = a.effectNote ? `${a.effectNote.charAt(0).toUpperCase()}${a.effectNote.slice(1)}: ${eff}.` : `${eff.charAt(0).toUpperCase()}${eff.slice(1)}.`;
        return `${a.n}. **${title}.** ${why}${/[.!?]$/.test(why) ? "" : "."} ${effect}`;
      });
    case "detail": {
      const out = [`### ${block.title} – ${block.scoreText === "—" ? "нет данных" : `${block.scoreText}, ${block.chip.text.toLowerCase()}`}`];
      if (block.table) out.push("", ...tableLines(block.table.columns, block.table.rows));
      for (const note of block.notes) out.push("", lineMd(note));
      return out;
    }
    case "appendix":
      return [`## ${block.title}`, "", block.intro];
  }
}

function lineMd(line: InlineLine): string {
  return line.map(inlineMd).join("");
}

function inlineMd(fragment: Inline): string {
  switch (fragment.kind) {
    case "text":
      return fragment.text;
    case "escaped":
      return mdEscape(fragment.text);
    case "code":
      return `\`${fragment.text}\``;
    case "em":
      return `_${mdEscape(fragment.text)}_`;
    case "strong":
      return `**${fragment.text}**`;
    case "link":
      return `[${mdEscape(fragment.text)}](${fragment.url})`;
  }
}

/**
 * В4.4 (кластер K/З7): внешние строки (слаг, заголовок, язык, сохраненный
 * текст рекомендации) экранируются — «![](url)» или <img> в них не должны
 * становиться tracking-pixel'ем в выгрузке. Бэкслеш-эскейп MD-спецсимволов
 * разметки ссылок/картинок/выделения + HTML-уголки сущностями.
 *
 * Г1.10 гейта: эскейп ставится только там, где символ действительно создаёт
 * разметку, — сырой MD читают глазами, а «\(сейчас 6 из 100\)» и
 * «completed\_at» читать мешали. Ссылку и картинку убивает экранированная
 * скобка `[`, поэтому круглые скобки остаются как есть; `_` внутри слова
 * выделения не начинает (CommonMark), `!` опасен только перед `[`, `#` —
 * только в начале строки. Набор «убивающих разметку» символов не сужен.
 */
export function mdEscape(value: string): string {
  return value
    .replace(/([\\`*\[\]|])/g, "\\$1")
    .replace(/(^|[^\p{L}\p{N}])_/gu, "$1\\_")
    .replace(/_(?=[^\p{L}\p{N}]|$)/gu, "\\_")
    .replace(/!(?=\\?\[)/g, "\\!")
    .replace(/^#/gm, "\\#")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Ячейка таблицы: переносы строк и неэкранированные вертикальные черты ломают MD-таблицу. */
function cellMd(value: string): string {
  const flat = value.replace(/\s*\n\s*/g, " ").replace(/(?<!\\)\|/g, "\\|");
  return flat === "" ? " " : flat;
}
