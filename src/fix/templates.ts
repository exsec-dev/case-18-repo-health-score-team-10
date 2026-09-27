// templates.ts — В5.9 (идея №5, К2): детерминированные файлы-заготовки для
// presence-правил документации. Без LLM: шаблон — функция от фактов скана.
//
// Шаблон, который не подтвержден детектором (файл лег бы в репозиторий, а
// следующий анализ его не увидел), — дефект. Поэтому имена файлов и заголовки
// взяты из сборщика (`collectors/git.ts`): файл в корне с не менее чем 16
// непробельными символами (`docHasContent`), разделы README — по словарю
// `readmeSectionFlags` и только с непустым телом (Р4в). Тест
// `tests/v59-a-templates.test.ts` прогоняет шаблоны через настоящий сборщик.
//
// Решения (TASK.md §2 «В5.9 — состав и схема работы»; отчет воркера А):
//  - язык шаблонов — русский (как интерфейс); типографика пользовательских
//    текстов — среднее тире, без «ё» (AGENTS.md «Язык и стиль»);
//  - лицензию выбирает человек: без `license` шаблона нет, по умолчанию ничего
//    не выбирается; год и владелец — подстановка (текущий год, организация);
//  - CODEOWNERS: логин SourceCraft ≠ имя из git — в строках плейсхолдер
//    `@login`, имя главного автора — подсказкой в комментарии; e-mail никогда;
//  - README для `readme-sections-missing` — фрагмент с недостающими разделами
//    под именем `README-sections.md`, а не `README.md`: он дописывается в
//    существующий README и не должен его затирать при сохранении.
import { displayAuthorName, OWNERSHIP_ROOT, OWNERSHIP_WINDOW_DAYS } from "../collectors/ownership";
import { recommendationParams, type ReadmeSection } from "../score/recommend";
import { LICENSE_IDS, LICENSES, type LicenseId } from "./licenses";

export { LICENSE_IDS, type LicenseId };

/** Правила, для которых есть файл-заготовка. */
export const FIX_RULE_IDS = ["contributing-missing", "readme-missing", "readme-sections-missing", "codeowners-missing", "license-missing"] as const;
export type FixRuleId = (typeof FIX_RULE_IDS)[number];

export const isFixRuleId = (ruleId: string): ruleId is FixRuleId => (FIX_RULE_IDS as readonly string[]).includes(ruleId);
export const isLicenseId = (id: string): id is LicenseId => (LICENSE_IDS as readonly string[]).includes(id);

/** Что знает карточка о заготовке правила (без содержимого). */
export interface FixTemplateMeta {
  filename: string;
  /** только `license-missing`: из чего выбирает человек */
  licenses?: LicenseId[];
}

const FILENAMES: Record<FixRuleId, string> = {
  "contributing-missing": "CONTRIBUTING.md",
  "readme-missing": "README.md",
  "readme-sections-missing": "README-sections.md",
  "codeowners-missing": "CODEOWNERS",
  "license-missing": "LICENSE",
};

/**
 * Признак заготовки для рекомендации карточки: есть ⇔ `templateFor` на этих
 * фактах дает файл (лицензия — при любом выборе из `licenses`). null — у
 * правила заготовки нет или добавлять нечего.
 */
export function fixTemplateOf(ruleId: string, facts: Map<string, unknown>): FixTemplateMeta | null {
  if (!isFixRuleId(ruleId)) return null;
  const probe = templateFor(ruleId, facts, { org: "", repo: "" }, { license: LICENSE_IDS[0], now: new Date(0) });
  if (probe === null) return null;
  return ruleId === "license-missing" ? { filename: FILENAMES[ruleId], licenses: [...LICENSE_IDS] } : { filename: FILENAMES[ruleId] };
}

export interface TemplateRepo {
  org: string;
  repo: string;
  title?: string | null;
}

export interface TemplateOptions {
  /** `license-missing`: выбор человека; без него шаблона нет */
  license?: LicenseId;
  /** год в строке Copyright лицензии (по умолчанию — текущий: год, когда файл добавляют) */
  now?: Date;
}

export interface FixFile {
  filename: string;
  content: string;
}

// ---------- README ----------

/**
 * Заголовки разделов — слова словаря сборщика (`SECTION_DICT`, git.ts):
 * «Установка», «Сборка», «Тесты». Тело — строка текста и блок кода с
 * плейсхолдером: пустой заголовок раздела не дает (Р4в).
 */
const README_SECTIONS: Record<ReadmeSection, string> = {
  install: ["## Установка", "", "Что нужно установить заранее и как получить проект:", "", "```", "<команда установки>", "```"].join("\n"),
  build: ["## Сборка", "", "Как собрать проект из исходников:", "", "```", "<команда сборки>", "```"].join("\n"),
  test: ["## Тесты", "", "Как запустить тесты и где они лежат:", "", "```", "<команда запуска тестов>", "```"].join("\n"),
};

const ALL_SECTIONS: ReadmeSection[] = ["install", "build", "test"];

function readmeFull(repo: TemplateRepo): string {
  const title = (repo.title ?? "").trim() || repo.repo;
  return [
    `# ${title}`,
    "",
    "Кратко опишите, что делает проект и кому он полезен.",
    "",
    ...ALL_SECTIONS.flatMap((k) => [README_SECTIONS[k], ""]),
    "## Как участвовать",
    "",
    "Порядок работы описан в CONTRIBUTING.md.",
    "",
  ].join("\n");
}

function readmeSections(missing: ReadmeSection[]): string {
  return [
    "<!-- Недостающие разделы README: перенесите их в README.md. Сервис находит",
    "     разделы по заголовкам «Установка», «Сборка», «Тесты» (или Install, Build,",
    "     Test), если под заголовком есть текст. -->",
    "",
    ...missing.flatMap((k) => [README_SECTIONS[k], ""]),
  ].join("\n");
}

// ---------- CONTRIBUTING ----------

function contributing(repo: TemplateRepo): string {
  const title = (repo.title ?? "").trim() || repo.repo;
  return [
    `# Как участвовать в проекте ${title}`,
    "",
    "Спасибо, что хотите помочь проекту. Ниже – порядок работы.",
    "",
    "## Как сообщить об ошибке",
    "",
    "1. Проверьте, нет ли уже такой задачи в трекере репозитория.",
    "2. Создайте задачу: что вы делали, что ожидали и что получили.",
    "3. Укажите версию проекта и окружение: <ОС, версия языка, версия зависимостей>.",
    "",
    "## Как предложить изменение",
    "",
    "1. Создайте ветку от основной: `<тип>/<кратко-о-чем>`.",
    "2. Внесите изменения и добавьте или обновите тесты.",
    "3. Откройте запрос на слияние и опишите, что меняется и зачем.",
    "4. Дождитесь ревью: <кто проверяет и в какой срок>.",
    "",
    "## Как запустить тесты",
    "",
    "```",
    "<команда запуска тестов>",
    "```",
    "",
    "## Стиль кода",
    "",
    "<правила оформления кода или ссылка на них>",
    "",
  ].join("\n");
}

// ---------- CODEOWNERS ----------

interface OwnershipDir {
  dir?: unknown;
  owner?: unknown;
  owner_share?: unknown;
}

/** Имя в комментарии: маска e-mail (как у карты владельцев) и одна строка. */
function safeName(raw: unknown): string {
  return displayAuthorName(typeof raw === "string" ? raw : "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

/** Каталог → шаблон CODEOWNERS от корня; null — имя нельзя записать строкой шаблона. */
function dirPattern(dir: string): string | null {
  if (dir === OWNERSHIP_ROOT) return "/*";
  if (dir === "" || /[\u0000-\u001f\u007f]/.test(dir) || dir.includes("/")) return null;
  // пробел и символы подстановки шаблона экранируются обратной косой чертой
  return `/${dir.replace(/([\\\s*?[])/g, "\\$1")}/`;
}

function codeowners(ok: Map<string, unknown>, repo: TemplateRepo): string {
  const lines = [
    `# CODEOWNERS – черновик для ${repo.org}/${repo.repo}`,
    "#",
    "# Логин в SourceCraft не совпадает с именем автора из git: замените каждый",
    "# @login на логин ответственного. Имена авторов оставлены подсказкой в комментариях.",
    "# Формат строки: шаблон пути, затем владельцы через пробел. Если к файлу",
    "# подходят несколько строк, действует последняя.",
    "",
    "# Владелец по умолчанию – весь репозиторий",
    "* @login",
  ];
  const ownership = ok.get("code.ownership") as { dirs?: unknown } | undefined;
  const dirs = Array.isArray(ownership?.dirs) ? (ownership.dirs as OwnershipDir[]) : [];
  const rows = dirs
    .map((d) => ({ dir: typeof d.dir === "string" ? d.dir : "", owner: safeName(d.owner), share: typeof d.owner_share === "number" ? d.owner_share : null }))
    .map((d) => ({ ...d, pattern: dirPattern(d.dir) }))
    .filter((d) => d.pattern !== null);
  if (rows.length === 0) {
    lines.push("", `# Карта владельцев за ${OWNERSHIP_WINDOW_DAYS} дней пуста: добавьте строки для каталогов вручную.`);
  } else {
    lines.push("", `# Каталоги и главные авторы – по изменениям кода за ${OWNERSHIP_WINDOW_DAYS} дней.`);
    for (const d of rows) {
      const where = d.dir === OWNERSHIP_ROOT ? "файлы в корне" : d.dir;
      const share = d.share === null ? "" : `, ${Math.round(d.share * 100)}% изменений`;
      lines.push("", `# ${where}: главный автор – ${d.owner}${share}`, `${d.pattern} @login`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------- LICENSE ----------

function license(id: LicenseId, repo: TemplateRepo, now: Date): string {
  return LICENSES[id].text.replace("{{year}}", String(now.getUTCFullYear())).replace("{{owner}}", repo.org);
}

// ---------- вход ----------

/**
 * Файл-заготовка правила по фактам скана (эффективные факты — те же, что у
 * движка рекомендаций). null — у правила нет заготовки, для разделов README
 * нечего добавлять, или у лицензии не выбран вариант.
 */
export function templateFor(ruleId: string, facts: Map<string, unknown>, repo: TemplateRepo, opts: TemplateOptions = {}): FixFile | null {
  if (!isFixRuleId(ruleId)) return null;
  const filename = FILENAMES[ruleId];
  switch (ruleId) {
    case "contributing-missing":
      return { filename, content: contributing(repo) };
    case "readme-missing":
      return { filename, content: readmeFull(repo) };
    case "readme-sections-missing": {
      const missing = recommendationParams(ruleId, facts).missing ?? [];
      return missing.length === 0 ? null : { filename, content: readmeSections(missing) };
    }
    case "codeowners-missing":
      return { filename, content: codeowners(facts, repo) };
    case "license-missing":
      if (opts.license === undefined) return null;
      return { filename, content: license(opts.license, repo, opts.now ?? new Date()) };
  }
}
