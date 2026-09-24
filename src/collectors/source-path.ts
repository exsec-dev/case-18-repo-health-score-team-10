// source-path.ts — что считается кодом (М2.3 аудита методики В5.3, модель
// 4.2.0-hci). Чистый модуль без зависимостей: его берут и сборщик (LOC и
// пометки TODO только по коду), и расчет (признак «кода нет» у фактов до
// правки сборщика — по корню репозитория).
//
// Файл кода — всё, кроме документов, лицензий, служебных файлов git,
// lock-файлов и картинок. Репозиторий из одного README и лицензии — «кода нет»
// (Q&A №13: репо без кода = 0), а плотность TODO считается по строкам кода, а
// не по тексту README.

const NON_SOURCE_NAME = /^(readme|licen[cs]es?|copying|unlicense|notice|authors|contributors|changelog|changes|history|contributing|codeowners|code_of_conduct|security|maintainers)([._-].*)?$/i;
const NON_SOURCE_EXT = new Set([
  "md", "markdown", "rst", "txt", "adoc", "asciidoc", "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "pdf",
  // приемка HQ (H1): архивы, офисные документы, медиа и собранные бинарники — не код
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "apk", "aab", "ipa", "exe", "msi", "dll", "so", "dylib", "jar", "war", "class",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "mp3", "mp4", "wav", "avi", "mov", "mkv", "ttf", "otf", "woff", "woff2",
  "psd", "iso", "dmg", "bin",
]);
const NON_SOURCE_FILES = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".mailmap",
  ".editorconfig",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "pipfile.lock",
]);

export function isSourcePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  if (NON_SOURCE_FILES.has(lower)) return false;
  if (NON_SOURCE_NAME.test(base)) return false;
  const dot = lower.lastIndexOf(".");
  if (dot > 0 && NON_SOURCE_EXT.has(lower.slice(dot + 1))) return false;
  return true;
}

/**
 * В5.3-М (Р1, модель 4.3.0-hci): файл тестов среди файлов кода — путь содержит
 * каталог `test/`, `tests/`, `__tests__/`, `spec/`, `specs/` или имя файла
 * `test_*`, `*_test.*`, `*.test.*`, `*.spec.*` (регистр не важен). Считается
 * только среди `isSourcePath`: документ в `tests/` тестом не становится.
 */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const TEST_NAME = /^test_|_test\.|\.test\.|\.spec\./i;
/**
 * Круг 2 (К2, E5): данные тестов — не тесты. Файл внутри `fixtures/`,
 * `testdata/`, `__snapshots__/`, `mocks/`, `data/` (на любой глубине) тестом
 * не считается: `tests/fixtures/big.json` не поднимает долю тестов.
 */
const TEST_DATA_DIRS = new Set(["fixtures", "testdata", "__snapshots__", "mocks", "data"]);

export function isTestPath(path: string): boolean {
  if (!isSourcePath(path)) return false;
  const parts = path.split("/");
  const base = parts.pop() ?? "";
  // приемка HQ (E17): каталоги данных — не тесты только ВНУТРИ каталога тестов
  // (`tests/fixtures/x.json`), а не где угодно (`src/data/test_loader.py` — тест)
  const testDir = parts.findIndex((dir) => TEST_DIRS.has(dir.toLowerCase()));
  if (testDir >= 0 && parts.slice(testDir + 1).some((dir) => TEST_DATA_DIRS.has(dir.toLowerCase()))) return false;
  if (testDir >= 0) return true;
  return TEST_NAME.test(base);
}

/**
 * Признак «кода нет» по корню (`tree.stats.top_level`) для фактов без
 * `source_files`: в корне только файлы (каталогов нет — значит, других файлов
 * в репозитории нет), и ни один из них не код. Корень пуст — решает
 * `file_count`, не эта функция.
 */
export function rootHasNoSource(topLevel: unknown): boolean {
  if (!Array.isArray(topLevel) || topLevel.length === 0) return false;
  return topLevel.every((e) => {
    const entry = e as { name?: unknown; type?: unknown } | null;
    return entry !== null && typeof entry.name === "string" && entry.type === "blob" && !isSourcePath(entry.name);
  });
}
