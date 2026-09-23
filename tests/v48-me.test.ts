// v48-me.test.ts — В4.8: «Мои репозитории» по образцу SourceCraft (вариант A
// + плитки сводки C). Числа на плитках и порядок строк — поведенческие тесты
// на данных (правило 21.09: число, названное размером выборки, не закрывается
// чтением исходника); вёрстка и тексты — source-assert.
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

  test("«Задания»: кнопка со штриховкой (Т1), панель — Popup с переключателем без заголовка (П3), ссылка в раздел — SPA", () => {
    const bell = src.slice(src.indexOf("export function JobsBell"), src.indexOf("function JobRow"));
    const row = src.slice(src.indexOf("function JobRow"), src.indexOf("interface FavoritesResponse"));
    expect(bell).toContain('className={busy ? "rh-jobs-btn rh-jobs-btn_busy" : "rh-jobs-btn"}');
    expect(bell).toMatch(/<Popup\s+open=\{open\}/);
    expect(bell).not.toContain("<details");
    // П3 с поправками Екатерины: заголовка «Задания» в панели нет, сверху — «Активные N / История»;
    // секций круга 3 («Идут сейчас» / «Недавние») больше нет; снизу — без оценки времени
    expect(bell).toContain("<SegmentedRadioGroup");
    expect(bell).toContain("{`Активные ${active.length}`}");
    expect(bell).toContain(">История<");
    expect(bell).not.toMatch(/Идут сейчас|Недавние|>\s*Ваши задания\s*</);
    expect(bell).toContain("Итог появится в строке репозитория.");
    expect(bell).not.toMatch(/обычно до|минут/);
    // строка: логотип из API и та же серая плашка состояния, что в списке
    expect(row).toContain("logoUrl={job.logoUrl}");
    // круг 5: списки панели прокручиваются внутри нее
    expect((bell.match(/<div className="rh-jobs__list">/g) ?? []).length).toBe(2);
    expect(readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8")).toMatch(/\.rh-jobs__list \{[^}]*overflow-y: auto;/);
    expect(row).toContain('<span className="rh-state rh-busy">');
    // круг 5 (4c): история — лента по дням (`HistoryRow`: время справа, итог иконкой);
    // (2c): пустые состояния — иконка, заголовок, описание; ссылка в раздел — SPA-навигация + закрытие панели
    expect(bell).toContain("groupJobsByDay(recent)");
    expect(src).toContain("function HistoryRow");
    expect(src).toMatch(/<JobsEmpty title="Сейчас ничего не анализируется">\s*Запустить анализ можно в разделе\{" "\}\s*<Link \{\.\.\.navProps\("\/me", close\)\} view="normal">\s*Мои репозитории/);
    expect(src).not.toMatch(/\{\.\.\.linkProps\([^)]*\)\}[^>]*onClick=/);
    expect(src).not.toContain("весь список – в разделе «Мои репозитории»");
    const css = readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8");
    expect(css).toMatch(/\.rh-jobs-btn_busy::before \{[^}]*animation: g-loading-animation/);
    // круг 4 (замечание 4): кнопка видна всегда; счетчик отделен от слова; запуск анализа будит опрос шапки
    expect(bell).not.toContain("return null");
    // ревью закрытия: тревога — только когда упало последнее завершенное; панель — role="dialog"
    expect(bell).toContain('const alarm = !busy && recent[0]?.phase === "failed";');
    expect(bell).toMatch(/offset=\{4\}\s*role="dialog"/);
    expect(bell).toContain('className={alarm ? "rh-jobs-btn__count rh-jobs-btn__count_danger" : "rh-jobs-btn__count"}');
    // пустые состояния — на каждую вкладку панели (П3)
    expect(src).toContain('<JobsEmpty title="Анализов пока не было">');
    expect((src.match(/announceJobsChanged\(\);/g) ?? []).length).toBe(2);
    // ПЕРЕНОС (В4.8.5, К8.5.1): опрос заданий — один на вкладку (session.tsx),
    // событие «задания изменились» будит его там, а не отдельные опросы страниц
    expect(readFileSync(join(import.meta.dir, "..", "src", "web", "session.tsx"), "utf8")).toMatch(/window\.addEventListener\(JOBS_CHANGED, refresh\)/);
    // круг 4 (замечания 2-3): пилюля с полностью скругленными углами; иконки прав без зеленого
    expect(css).toMatch(/\.rh-pill \{[^}]*border-radius: 10px;/);
    expect(css).not.toMatch(/\.rh-access__icon_yes \{[^}]*positive/);
  });

  test("шапка списка: заголовок, счетчик цветом hint, поиск, сортировка, одна action-кнопка", () => {
    expect(src).toMatch(/<Text variant="header-1" as="h1">\s*Мои репозитории\s*<\/Text>/);
    expect(src).toMatch(/<Text variant="header-1" color="hint">\s*\{entries\.length\}/);
    // круг 2 (замечание 6): плейсхолдер — «Поиск», как у рейтинга
    expect(src).toContain('placeholder="Поиск"');
    // круг 2 (5b): описание под заголовком вместо иконки-подсказки
    expect(src).not.toContain("<HelpMark");
    expect(src).not.toContain("Здесь ваше избранное: отметьте");
    // круг 3 (2c): одна короткая фраза вместо двух предложений
    // круг 5 (Екатерина): «что возможно в них улучшить»
    expect(src).toContain("Следите за здоровьем избранных репозиториев и тем, что возможно в них улучшить.");
    expect(src).not.toContain("Репозитории, которые вы отметили звездочкой на их странице или добавили сюда по ссылке.");
    expect(src).toContain('pin="round-brick"');
    expect(src).toContain('pin="brick-round"');
    // JSX-кнопки view="action" в файле: «Добавить» в шапке списка и форма токена
    // (другая страница, /settings); плашка про токен на /me — view="normal"
    expect((src.match(/<Button view="action"/g) ?? []).length).toBe(2);
    expect(src).toMatch(/<Button view="normal" size="m" \{\.\.\.linkProps\("\/settings"\)\}>/);
  });

  test("добавление — диалогом, а не полем над списком", () => {
    expect(src).toContain("function AddRepoDialog");
    expect(src).toContain('caption="Добавить репозиторий"');
    expect(src).not.toContain("Добавить в избранное</Button>");
  });

  test("строка: слой-ссылка на карточку, оценка словом шкалы, действия — кнопка по состоянию и меню", () => {
    const rowSrc = src.slice(src.indexOf("function RepoRow"), src.indexOf("// ========== ПОРТ 5"));
    expect(rowSrc).toContain('className="rh-repo-item__cover"');
    expect(rowSrc).toContain("scoreWord(entry.healthcraftIndex)");
    // круг 2 (8a, 3c): оценка — кольцо; число белое, цвет полосы — на дуге
    expect(rowSrc).toContain("<ScoreRing value={entry.healthcraftIndex!} />");
    expect(rowSrc).not.toContain("scoreColor(");
    // круг 2 (1a): «Сканируется» — штриховка загрузки кнопки Gravity, не Label со спиннером
    // ПЕРЕВОРОТ (В4.8.5, §2-В5): подсказка «обычно до N минут» (etaNote) снята —
    // «идет анализ» без обещания времени; форма плашки прежняя
    expect(rowSrc).toContain('<span className="rh-state rh-busy" title="Идет анализ – итог придет уведомлением">');
    expect(rowSrc).not.toContain("etaNote");
    // круг 3 (замечание 8): остальные состояния — серые `StatePill` с иконкой, цветных `Label` в состоянии строки нет
    const stateSrc = rowSrc.slice(rowSrc.indexOf("const state ="), rowSrc.indexOf("const menuItems"));
    expect((stateSrc.match(/<StatePill icon=\{/g) ?? []).length).toBe(7);
    expect(stateSrc).not.toContain("<Label");
    expect(src).not.toContain("<Spin");
    // круг 2 (2a): метки «ваш» нет; у приватного — серая метка видимости с замком
    expect(src).not.toMatch(/>\s*ваш\s*</);
    // круг 4 (замечание 3): «Приватный» — серая пилюля, не `Label theme="normal"` (в палитре — стальной misc)
    // ПЕРЕНОС С ЗАМЕНОЙ (В4.9 ч.2, В2): плашка видимости — общим `VisibilityPill`
    // (та же серая пилюля с замком у приватного), теперь и у публичных
    expect(src).toContain("<VisibilityPill value={access.visibility} titleSuffix={checked} />");
    expect(readFileSync(join(import.meta.dir, "..", "src", "web", "ui.tsx"), "utf8")).toMatch(/pill\.kind === "internal" \? Persons : Lock[\s\S]{0,120}<span className="rh-pill"/);
    expect(rowSrc).toContain("<DropdownMenu");
    expect(rowSrc).toContain('text: "Убрать из избранного"');
    // ревью закрытия: пункт «Открыть рекомендации» — навигация SPA, не href
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А1): пункт ведет к разделу якорем
    expect(rowSrc).toContain("action: () => navigate(recommendationsHref(href))");
    expect(rowSrc).not.toMatch(/text: "Открыть рекомендации", href:/);
    // плитки сводки — переключатели: роль кнопки и aria-pressed вместо радио
    expect(src).toMatch(/role="button"\s*aria-checked=\{undefined\}\s*aria-pressed=\{band === b\.key\}/);
    expect(rowSrc).not.toContain("Убрать ★");
  });

  test("CSS строки — замер SourceCraft: аватар 40px радиусом 8px, делитель line-generic", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "web", "layout.css"), "utf8");
    expect(css).toMatch(/\.rh-repo-item \.g-avatar \{[^}]*--g-avatar-size: 40px;[^}]*--_--border-radius: 8px;/);
    expect(css).toMatch(/\.rh-repo-item \{[^}]*border-bottom: 1px solid var\(--g-color-line-generic\);/);
    expect(css).toMatch(/\.rh-summary__tile\.g-card \{[^}]*border-radius: 12px;/);
    // круг 3 (замечание 3): полосы распределения под плитками нет
    expect(css).not.toContain(".rh-dist");
    expect(src).not.toContain("rh-dist");
    // круг 4 (замечание 1): иконки плиток крупнее — 20px; «жирность» была от `stroke`, а не от размера
    expect(src).toContain("{icon && <Icon data={icon} size={20} className={`rh-band-icon rh-band-icon_${b.key}`} />}");
    // круг 2: штриховка — keyframes загрузки кнопки Gravity; движение отключается по prefers-reduced-motion
    expect(css).toMatch(/\.rh-busy \{[^}]*animation: g-loading-animation/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rh-busy \{\s*animation: none;/);
    // круг 2 (3c): цвет полос — насыщенными базовыми тонами на графике, не пастельным текстом
    for (const [band, token] of [["success", "positive"], ["warning", "warning"], ["danger", "danger"]]) {
      expect(css).toContain(`.rh-ring_${band} .rh-ring__arc {\n  stroke: var(--g-color-base-${token}-heavy);\n}`);
      // круг 4: у иконки полосы только `color` — общий с дугой `stroke` обводил залитый контур иконки
      expect(css).toContain(`.rh-band-icon_${band} {\n  color: var(--g-color-base-${token}-heavy);\n}`);
    }
  });
});
