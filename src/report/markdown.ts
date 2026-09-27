// MD-выгрузка отчета по карточке. Модель блоков строит `build.ts` (общая для MD
// и PDF), здесь — только сериализация. Первый экран — строкой
// `**70 из 100 · здоров**`, шкала и вклады словами, H2 как навигация, без HTML,
// таблицы основного текста не шире 4 колонок. Документ самодостаточен: его можно
// читать без сервиса, SourceCraft и GitHub рендерят его как есть.
import type { RepoCard } from "../api/repos";
import { SECURITY_PUBLIC_NOTE } from "../web/format";
import { buildReportModel } from "./build";
import type { Block, Inline, InlineLine, ReportModel, TableColumn } from "./model";

export { SECURITY_PUBLIC_NOTE, buildReportModel };

/** MD-отчет карточки. */
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
      // строки абзаца — отдельными абзацами MD: перенос «два пробела в конце»
      // теряется в редакторах и просмотрщиках
      return [block.lines.map(lineMd).join("\n\n")];
    case "list":
      return block.items.map((item) => `- ${lineMd(item)}`);
    case "table":
      return tableLines(block.columns, block.rows);
    case "header": {
      const out = [`# ${mdEscape(block.slug)}`];
      if (block.title) out.push("", lineMd(block.title));
      // в PDF плашка доступа стоит после даты — MD держит тот же порядок слов,
      // чтобы текст PDF совпадал с текстом MD
      const chip = block.docChip ? ` (${block.docChip.text.toLowerCase()})` : "";
      out.push("", `[${mdEscape(block.link.text)}](${block.link.url})`, "", `${block.doc}.${block.date ? ` ${block.date}${chip}.` : `${chip}`}`);
      return out;
    }
    case "hero": {
      // второй показатель в PDF стоит справа в том же ряду; в MD ряда нет —
      // он идет следующей строкой тем же шаблоном, с подписью через тире
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
      // подписей зон под шкалой нет (в PDF — цветная полоска без слов);
      // словесная шкала целиком есть в разделе «Как считается»
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
        // метка строки — первыми словами «Основания», как плашка над ним в PDF
        block.rows.map((r) => [
          [{ kind: "text", text: r.name }],
          [{ kind: "text", text: r.scoreText }],
          [{ kind: "text", text: r.chip.text.toLowerCase() }],
          r.mark ? [{ kind: "strong", text: `${r.mark.text}.` }, { kind: "text", text: ` ${r.why}` }] : [{ kind: "text", text: r.why }],
        ]),
      );
    case "actions":
      return block.items.map((a) => {
        const title = lineMd(a.title);
        const why = lineMd(a.why);
        const eff = mdEscape(a.effect);
        // подпись эффекта — перед числом, как в PDF
        const effect = a.effectNote ? `${a.effectNote.charAt(0).toUpperCase()}${a.effectNote.slice(1)}: ${eff}.` : `${eff.charAt(0).toUpperCase()}${eff.slice(1)}.`;
        return `${a.n}. **${title}.** ${why}${/[.!?]$/.test(why) ? "" : "."} ${effect}`;
      });
    case "detail": {
      // без балла — словом плашки («нет данных» или «недоступно»), как в PDF
      const out = [`### ${block.title} – ${block.scoreText === "—" ? block.chip.text.toLowerCase() : `${block.scoreText}, ${block.chip.text.toLowerCase()}`}`];
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
 * Экранирование внешних строк (слаг, заголовок, язык, сохраненный текст
 * рекомендации): «![](url)» или <img> в них не должны стать tracking-pixel'ем
 * в выгрузке. Спецсимволы ссылок, картинок и выделения — бэкслешем, угловые
 * скобки — HTML-сущностями.
 *
 * Эскейп ставится только там, где символ действительно создает разметку: сырой
 * MD читают глазами. Ссылку и картинку обезвреживает экранированная `[`, поэтому
 * круглые скобки остаются как есть; `_` внутри слова выделения не начинает
 * (CommonMark), `!` опасен только перед `[`, `#` — только в начале строки.
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
