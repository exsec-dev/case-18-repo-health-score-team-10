// Страница избранного по образцу SourceCraft: список с плитками сводки и
// панель «Задания». Числа на плитках и порядок строк проверяются на данных
// (число, названное размером выборки, не проверить чтением исходника);
// верстка и тексты — source-assert.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_TIME_GROUP, bandOf, countBands, filterEntries, groupJobsByDay, sortEntries } from "../src/web/myRepos";

const row = (org: string, repo: string, healthcraftIndex: number | null, lastScanAt: string | null = null, title: string | null = null) => ({
  org,
  repo,
  title,
  healthcraftIndex,
  lastScanAt,
});

const sample = [
  row("a", "healthy", 83, "2026-09-20T10:00:00Z"),
  row("b", "edge-up", 69.6, "2026-09-18T10:00:00Z"), // показано как 70 → «здоров», как у рейтинга
  row("c", "attention", 53, "2026-09-21T03:17:00Z", "Хакатон ЛЦТ"),
  row("d", "risk", 12, "2026-09-10T10:00:00Z"),
  row("e", "never", null, null),
  row("f", "no-data", null, "2026-09-19T10:00:00Z"),
];

describe("В4.8: плитки сводки считают строки списка", () => {
  test("полоса — по показанному числу, те же пороги, что у рейтинга; null — «без оценки», а не риск", () => {
    expect(sample.map(bandOf)).toEqual(["success", "success", "warning", "danger", "none", "none"]);
  });

  test("сумма плиток равна длине списка; пустой список — нули", () => {
    const c = countBands(sample);
    expect(c).toEqual({ success: 2, warning: 1, danger: 1, none: 2 });
    expect(c.success + c.warning + c.danger + c.none).toBe(sample.length);
    expect(countBands([])).toEqual({ success: 0, warning: 0, danger: 0, none: 0 });
  });

  test("плитка фильтрует ровно свою полосу: длина выдачи = число на плитке", () => {
    const c = countBands(sample);
    for (const band of ["success", "warning", "danger", "none"] as const) {
      expect(filterEntries(sample, "", band).length).toBe(c[band]);
    }
  });

  test("поиск — подстрокой без регистра по org, repo и названию, в сочетании с плиткой", () => {
    expect(filterEntries(sample, "ATTEN", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "c / att", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "c/att", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "лцт", null).map((e) => e.repo)).toEqual(["attention"]);
    expect(filterEntries(sample, "  ", null).length).toBe(sample.length);
    expect(filterEntries(sample, "attention", "success")).toEqual([]);
  });
});

describe("В4.8: сортировка списка", () => {
  const repos = (key: "index" | "name" | "scan", desc: boolean) => sortEntries(sample, key, desc).map((e) => e.repo);

  test("индекс: без оценки — в конце в обе стороны (tri-state)", () => {
    expect(repos("index", true)).toEqual(["healthy", "edge-up", "attention", "risk", "never", "no-data"]);
    expect(repos("index", false)).toEqual(["risk", "attention", "edge-up", "healthy", "never", "no-data"]);
  });

  test("дата анализа: не анализированный — в конце в обе стороны; битая дата — как отсутствующая", () => {
    expect(repos("scan", true)).toEqual(["attention", "healthy", "no-data", "edge-up", "risk", "never"]);
    expect(repos("scan", false)).toEqual(["risk", "edge-up", "no-data", "healthy", "attention", "never"]);
    const broken = sortEntries([row("x", "bad-date", 50, "not a date"), row("y", "ok", 50, "2026-09-01T00:00:00Z")], "scan", false);
    expect(broken.map((e) => e.repo)).toEqual(["ok", "bad-date"]);
  });

  test("название: по слагу, не мутирует вход", () => {
    const before = sample.map((e) => e.repo);
    expect(repos("name", false)).toEqual(["healthy", "edge-up", "attention", "risk", "never", "no-data"]);
    expect(repos("name", true)).toEqual(["no-data", "never", "risk", "attention", "edge-up", "healthy"]);
    expect(sample.map((e) => e.repo)).toEqual(before);
  });
});

describe("В4.8: история «Заданий» лентой по дням (круг 5, 4c)", () => {
  const now = new Date(2026, 8, 21, 22, 0); // 21 сент. 2026, 22:00 по локальному времени
  const at = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m).toISOString();
  const job = (id: number, claimedAt: string | null) => ({ id, claimedAt });

  test("группы «Сегодня», «Вчера», дата; время HH:mm; два запуска одного репозитория — разные строки со своим временем", () => {
    // 1 и 2 — один и тот же репозиторий, запущенный дважды за день
    const groups = groupJobsByDay([job(1, at(21, 20, 50)), job(2, at(21, 9, 5)), job(3, at(20, 23, 59)), job(4, at(15, 12, 0))], now);
    expect(groups.map((g) => ({ label: g.label, rows: g.rows.map((r) => [r.job.id, r.time]) }))).toEqual([
      { label: "Сегодня", rows: [[1, "20:50"], [2, "09:05"]] },
      { label: "Вчера", rows: [[3, "23:59"]] },
      { label: "15 сент. 2026", rows: [[4, "12:00"]] },
    ]);
  });

  test("без времени и с нечитаемой датой — последней группой, не «Сегодня»", () => {
    const groups = groupJobsByDay([job(1, null), job(2, at(21, 10, 0)), job(3, "not a date")], now);
    expect(groups.map((g) => [g.label, g.rows.map((r) => [r.job.id, r.time])])).toEqual([
      ["Сегодня", [[2, "10:00"]]],
      [NO_TIME_GROUP, [[1, null], [3, null]]],
    ]);
    expect(groupJobsByDay([], now)).toEqual([]);
  });

  test("ревью закрытия: порядок — по времени, а не по приходу (id и claimed_at могут расходиться после повторного захвата)", () => {
    const groups = groupJobsByDay([job(1, at(20, 10, 0)), job(2, at(21, 8, 0)), job(3, at(21, 19, 30))], now);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.job.id)])).toEqual([
      ["Сегодня", [3, 2]],
      ["Вчера", [1]],
    ]);
  });
});

describe("В4.8: вёрстка раздела (source-assert)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "web", "MePage.tsx"), "utf8");
  const reposPage = src.slice(src.indexOf("export function MePage"), src.indexOf("export function SettingsPage"));

  test("журнал «Мои задания» из тела страницы убран; правой панели на /me нет", () => {
    expect(src).not.toContain("function JobsPanel");
    expect(src).not.toContain("<JobsPanel");
    expect(reposPage).not.toContain("aside=");
    // история заданий осталась в шапке
    expect(src).toContain("export function JobsBell");
  });

  // UX 17.10: «Задания» → «Очередь», вкладка «Активные N» → «Сейчас N»
  test("«Очередь»: кнопка со штриховкой (Т1), панель — Popup с переключателем без заголовка (П3), ссылка в раздел — SPA", () => {
    const bell = src.slice(src.indexOf("export function JobsBell"), src.indexOf("function JobRow"));
    const row = src.slice(src.indexOf("function JobRow"), src.indexOf("interface FavoritesResponse"));
    expect(bell).toContain('className={busy ? "rh-jobs-btn rh-jobs-btn_busy" : "rh-jobs-btn"}');
    expect(bell).toMatch(/<Popup\s+open=\{open\}/);
    expect(bell).not.toContain("<details");
    // заголовка «Очередь» в панели нет, сверху — «Текущие N / История»;
    // секций «Идут сейчас» / «Недавние» нет; снизу — без оценки времени
    expect(bell).toContain("<SegmentedRadioGroup");
    expect(bell).toContain("{`Текущие ${active.length}`}");
    expect(bell).toContain(">История<");
    expect(bell).not.toMatch(/Идут сейчас|Недавние|>\s*Ваши задания\s*</);
    expect(bell).toContain("Итог появится в строке репозитория.");
    expect(bell).not.toMatch(/обычно до|минут/);
    // строка: логотип из API и та же серая плашка состояния, что в списке
    expect(row).toContain("logoUrl={job.logoUrl}");
    // списки панели прокручиваются внутри нее
    expect((bell.match(/<div className="rh-jobs__list">/g) ?? []).length).toBe(2);
    expect(readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8")).toMatch(/\.rh-jobs__list \{[^}]*overflow-y: auto;/);
    expect(row).toContain('<Label theme="unknown" size="s" className="rh-busy">');
    // история — лента по дням (`HistoryRow`: время справа, итог иконкой);
    // пустые состояния — иконка, заголовок, описание; ссылка в раздел — SPA-навигация + закрытие панели
    expect(bell).toContain("groupJobsByDay(recent)");
    expect(src).toContain("function HistoryRow");
    // UX 17.10: анализ запускают в «Моих репозиториях»
    expect(src).toMatch(/<JobsEmpty title="Сейчас ничего не анализируется">\s*Запустить анализ можно в разделе\{" "\}\s*<Link \{\.\.\.navProps\("\/repos", close\)\} view="normal" className="rh-nowrap">\s*Мои репозитории/);
    // ссылка не рвется переносом
    expect(readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8")).toMatch(/\.rh-nowrap \{[^}]*white-space: nowrap;/);
    expect(src).not.toMatch(/\{\.\.\.linkProps\([^)]*\)\}[^>]*onClick=/);
    expect(src).not.toContain("весь список – в разделе «Мои репозитории»");
    const css = readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8");
    expect(css).toMatch(/\.rh-jobs-btn_busy::before \{[^}]*animation: g-loading-animation/);
    // кнопка видна всегда; счетчик отделен от слова; запуск анализа будит опрос шапки
    expect(bell).not.toContain("return null");
    // тревога — только когда упало последнее завершенное; панель — role="dialog"
    expect(bell).toContain('const alarm = !busy && recent[0]?.phase === "failed";');
    expect(bell).toMatch(/offset=\{4\}\s*role="dialog"/);
    expect(bell).toContain('className={alarm ? "rh-jobs-btn__count rh-jobs-btn__count_danger" : "rh-jobs-btn__count"}');
    // пустые состояния — на каждую вкладку панели
    // UX 17.10: пустая история — «Вы еще ничего не запускали»
    expect(src).toContain('<JobsEmpty title="Вы еще ничего не запускали">Здесь появятся завершенные анализы, AI-обзоры и проверки и их итог.</JobsEmpty>');
    // UX 17.10: +2 у «Моих репозиториев» (запуск анализа, добавление в избранное)
    expect((src.match(/announceJobsChanged\(\);/g) ?? []).length).toBe(4);
    // опрос заданий — один на вкладку (session.tsx), событие «задания
    // изменились» будит его там, а не отдельные опросы страниц
    expect(readFileSync(join(import.meta.dir, "..", "src", "web", "session.tsx"), "utf8")).toMatch(/window\.addEventListener\(JOBS_CHANGED, refresh\)/);
    // SC-9: своей «пилюли» нет — видимость и состояния на Label; иконки прав без зеленого
    expect(css).not.toContain(".rh-pill {");
    expect(css).not.toMatch(/\.rh-access__icon_yes \{[^}]*positive/);
  });

  // аудит 16.10: заголовок header-2 как у SourceCraft, счетчик secondary (hint — 2,1–2,6:1)
  test("шапка списка: заголовок, счетчик вторичным цветом, поиск, сортировка, одна action-кнопка", () => {
    expect(src).toMatch(/<Text variant="header-2" as="h1" className="rh-page-title">\s*Избранное\s*<\/Text>/);
    expect(src).toMatch(/<Text variant="header-2" color="secondary" className="rh-page-title">\s*\{entries\.length\}/);
    // плейсхолдер — «Поиск», как у рейтинга
    expect(src).toContain('placeholder="Поиск"');
    // описание под заголовком вместо иконки-подсказки
    expect(src).not.toContain("<HelpMark");
    expect(src).not.toContain("Здесь ваше избранное: отметьте");
    // одна короткая фраза вместо двух предложений
    // UX 17.10: «Избранное» — наблюдение: что изменилось и что улучшить
    expect(src).toContain("Репозитории, за которыми вы следите: изменения оценки и рекомендации.");
    expect(src).not.toContain("Репозитории, которые вы отметили звездочкой на их странице или добавили сюда по ссылке.");
    expect(src).toContain('pin="round-brick"');
    expect(src).toContain('pin="brick-round"');
    // JSX-кнопки view="action" в файле: «Добавить» в шапке списка, форма токена и
    // пароль доступа к AI — обе на другой странице, /settings; плашка про
    // токен на /me — view="normal"
    // +1: «Готово» в панели фильтров «Моих репозиториев» на телефоне (как в рейтинге)
    expect((src.match(/<Button view="action"/g) ?? []).length).toBe(4);
    expect(src).toMatch(/<Button view="normal" size="m" \{\.\.\.linkProps\("\/settings"\)\}>/);
  });

  test("добавление — диалогом, а не полем над списком", () => {
    expect(src).toContain("function AddRepoDialog");
    expect(src).toContain('caption="Добавить в избранное"');
    expect(src).not.toContain("Добавить в избранное</Button>");
  });

  test("строка: слой-ссылка на карточку, оценка словом шкалы, действия — кнопка по состоянию и меню", () => {
    const rowSrc = src.slice(src.indexOf("function RepoRow"), src.indexOf("// ========== ПОРТ 5"));
    expect(rowSrc).toContain('className="rh-repo-item__cover"');
    expect(rowSrc).toContain("scoreWord(entry.healthcraftIndex)");
    // аудит 16.10: оценка — та же полоса, что в рейтинге и на карточке (ScoreBar);
    // UX 17.10: плашки уровня нет — уровень несет цвет полосы, слово — в подсказке
    expect(rowSrc).toContain("<ScoreBar value={entry.healthcraftIndex!} width={64} />");
    expect(rowSrc).not.toContain("scoreLabelTheme(entry.healthcraftIndex)");
    expect(src).not.toContain("function ScoreRing");
    expect(rowSrc).not.toContain("scoreColor(");
    // «Сканируется» — штриховка загрузки кнопки Gravity, не Label со спиннером;
    // «идет анализ» без обещания времени
    expect(rowSrc).toContain('<Label theme="unknown" size="s" className="rh-busy" title="Идет анализ – итог придет уведомлением">');
    expect(rowSrc).not.toContain("etaNote");
    // остальные состояния — серые `StatePill` с иконкой, цветных `Label` в состоянии строки нет
    const stateSrc = rowSrc.slice(rowSrc.indexOf("const state ="), rowSrc.indexOf("const menuItems"));
    // UX 17.10: +2 для «Моих репозиториев» — «Пустой» и «Еще не анализировали» вне каталога
    expect((stateSrc.match(/<StatePill\s+icon=\{/g) ?? []).length).toBe(9);
    // цветных Label в состоянии нет: уровень — полосой, состояния — серые (unknown)
    expect(stateSrc).not.toMatch(/<Label theme="(success|warning|danger|info|normal)"/);
    expect(src).toMatch(/function StatePill[\s\S]{0,300}<Label theme="unknown" size="s"/);
    expect(src).not.toContain("<Spin");
    // метки «ваш» нет
    expect(src).not.toMatch(/>\s*ваш\s*</);
    // плашка видимости — общая `VisibilityPill` у всех строк: Label clear,
    // как «Public» у SourceCraft (у приватного — с замком)
    expect(src).toContain("<VisibilityPill value={access.visibility} titleSuffix={checked} />");
    expect(readFileSync(join(import.meta.dir, "..", "src", "web", "ui.tsx"), "utf8")).toMatch(/pill\.kind === "internal" \? Persons : Lock[\s\S]{0,160}<Label theme="clear" size="s"/);
    // UX 17.10: все действия строки — в меню «…» (анализ у своих и «Убрать из избранного»):
    // одна кнопка у всех строк, колонка ровная
    expect(rowSrc).toContain("<DropdownMenu");
    expect(rowSrc).toContain('{ text: "Убрать из избранного", iconStart: <Icon data={TrashBin} size={16} />, action: onRemove, disabled: busy, theme: "danger" as const }');
    // UX 17.10 (A11Y-16): имя кнопки меню называет репозиторий — строки различимы
    expect(rowSrc).toContain("aria-label={`Действия с ${entry.org}/${entry.repo}`}");
    expect(rowSrc).not.toContain("Открыть рекомендации");
    // плитки сводки — переключатели: роль кнопки и aria-pressed вместо радио
    expect(src).toMatch(/role="button"\s*aria-checked=\{undefined\}\s*aria-pressed=\{band === b\.key\}/);
    expect(rowSrc).not.toContain("Убрать ★");
  });

  test("CSS строки — замер SourceCraft: аватар 40px радиусом 8px, делитель line-generic", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8");
    // радиус 8px — от shape="square" size="l", без внутренних переменных uikit
    expect(css).toMatch(/\.rh-repo-item \.g-avatar \{\n  --g-avatar-size: 40px;\n\}/);
    expect(css).not.toContain("--_--border-radius");
    expect(css).toMatch(/\.rh-repo-item \{[^}]*border-bottom: 1px solid var\(--g-color-line-generic\);/);
    expect(css).toMatch(/\.rh-summary__tile\.g-card \{[^}]*border-radius: var\(--rh-radius-card\);/);
    // полосы распределения под плитками нет
    expect(css).not.toContain(".rh-dist");
    expect(src).not.toContain("rh-dist");
    // иконки плиток — 20px
    expect(src).toContain("{icon && <Icon data={icon} size={20} className={`rh-band-icon rh-band-icon_${b.key}`} />}");
    // штриховка — keyframes загрузки кнопки Gravity; движение отключается по prefers-reduced-motion
    expect(css).toMatch(/\.rh-busy \{[^}]*animation: g-loading-animation/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rh-busy \{\s*animation: none;/);
    // иконки плиток — насыщенными базовыми тонами графики, не пастельным текстом;
    // кольца больше нет — его заменила общая полоса
    for (const [band, token] of [["success", "positive"], ["warning", "warning"], ["danger", "danger"]]) {
      expect(css).toContain(`.rh-band-icon_${band} {\n  color: var(--g-color-base-${token}-heavy);\n}`);
    }
    expect(css).not.toContain(".rh-ring");
  });
});
